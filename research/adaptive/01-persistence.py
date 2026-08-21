#!/usr/bin/env python3
"""
A1 — Does setup performance PERSIST from one window to the next?

The gate for the whole adaptive-system idea. If a candidate's edge in window t
tells us nothing about window t+1, an adaptive selector is a noise-chasing
machine and no engineering fixes it.

Substrate: firstbreak/{P}_{tf}_fb.csv — for every completed candle, which of its
own extremes is touched first, walked on 1s bars from the close (ambiguous
seconds resolved ADVERSELY). Features are everything knowable at that close, so
the dataset is causal by construction. Payoff is fixed by the candle's geometry:
    long : win = high-close (winLongTicks), lose = close-low (loseLongTicks)
    short: win = close-low,                 lose = high-close

Candidates are PRE-REGISTERED, not searched: (feature, direction, time-bucket,
side). Thresholds are frozen on the first calendar year so every candidate is a
STABLE OBJECT whose performance can be tracked across windows — that is what
persistence requires.

Three things are measured, and the third is the one that matters:
  1. Spearman rank correlation of candidate EV between consecutive windows.
  2. Top-decile carryover vs the 0.10 baseline.
  3. ADAPTIVE vs STATIC: does picking the top-K from window t beat the best
     fixed rule chosen on all history before t, when both are scored on t+1?
     Persistence alone can just mean a stable edge exists; only (3) shows that
     ADAPTING adds anything over picking one rule and leaving it alone.

Placebo: the identical machinery on labels permuted within each trading day.
Feature values and marginals are untouched, so any apparent persistence there is
estimator bias, not market structure.

usage: 01-persistence.py [--product NQ] [--tf 5m] [--placebo]
"""
import sys, os, argparse
import numpy as np, pandas as pd
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
FB = os.path.join(HERE, "..", "tick-engine", "firstbreak")

# cost bar at 1 NQ (ticks): winners pay ~2, losers ~4 (stop slips)
COST_WIN, COST_LOSS = 2.0, 4.0
WINDOWS = [5, 10, 21, 63]      # trading days per non-overlapping window
MIN_N = 30                     # min events for a candidate to be rankable in a window
TOP_K = 10

def et_bucket(ts):
    et = pd.to_datetime(ts, unit="s", utc=True).dt.tz_convert("America/New_York")
    hhmm = et.dt.hour * 100 + et.dt.minute
    b = pd.Series("overnight", index=et.index)
    b[(hhmm >= 930) & (hhmm < 1030)] = "open"
    b[(hhmm >= 1030) & (hhmm < 1200)] = "morning"
    b[(hhmm >= 1200) & (hhmm < 1400)] = "midday"
    b[(hhmm >= 1400) & (hhmm < 1600)] = "close"
    return b

def load(product, tf):
    p = os.path.join(FB, f"{product}_{tf}_fb.csv")
    d = pd.read_csv(p)
    d = d[d.firstBreak.isin([1, -1])].copy()          # drop unresolved (no break in horizon)
    d["bucket"] = et_bucket(d.ts)
    rng = d.rangeTicks.replace(0, np.nan)
    # asymmetry features: >0 means the UP side dominated that dimension
    d["f_vol"]      = d.upVolPct - d.dnVolPct
    d["f_time"]     = d.upTimePct - d.dnTimePct
    d["f_touch"]    = d.upTouches - d.dnTouches
    d["f_int"]      = d.upInt - d.dnInt
    d["f_centroid"] = d.upCentroidV - d.dnCentroidV
    d["f_extreme"]  = d.upExtremePct - d.dnExtremePct
    d["f_wick"]     = (d.upWickTicks - d.dnWickTicks) / rng
    d["f_clv"]      = d.clv
    d["f_body"]     = d.bodyTicks / rng
    d["f_volz"]     = d.volZ
    d["f_atr"]      = d.atrTicks
    d["f_secs"]     = d.n1s
    return d.dropna(subset=["f_wick", "f_body"])

FEATURES = ["f_vol","f_time","f_touch","f_int","f_centroid","f_extreme",
            "f_wick","f_clv","f_body","f_volz","f_atr","f_secs"]
BUCKETS  = ["open","morning","midday","close","overnight","all"]

def build_candidates(d, freeze_year):
    """Freeze thresholds on the first calendar year so candidates are stable objects."""
    fz = d[d.tradeDate < freeze_year]
    if len(fz) < 5000:
        fz = d.iloc[: len(d) // 5]
    th = {f: (fz[f].quantile(0.30), fz[f].quantile(0.70)) for f in FEATURES}
    cands = []
    for f in FEATURES:
        lo, hi = th[f]
        if not np.isfinite(lo) or not np.isfinite(hi) or lo == hi:
            continue
        for direction in ("hi", "lo"):
            for b in BUCKETS:
                for side in (1, -1):
                    cands.append((f, direction, b, side))
    return cands, th

def candidate_mask(d, cand, th):
    f, direction, b, _ = cand
    lo, hi = th[f]
    m = (d[f] >= hi) if direction == "hi" else (d[f] <= lo)
    if b != "all":
        m &= (d.bucket == b)
    return m.values

def net_ticks(d, side):
    """Per-row net ticks for taking `side` on every row, costs applied."""
    hit = (d.firstBreak.values == side)
    win = np.where(side == 1, d.winLongTicks.values, d.loseLongTicks.values)
    los = np.where(side == 1, d.loseLongTicks.values, d.winLongTicks.values)
    return np.where(hit, win - COST_WIN, -(los + COST_LOSS))

def run(product, tf, placebo, seed=7):
    d = load(product, tf).reset_index(drop=True)
    if placebo:
        rng = np.random.default_rng(seed)
        # Permute the OUTCOME TRIPLE as a unit within each trading day.
        #
        # 🚨 An earlier version permuted firstBreak alone and left winLongTicks /
        # loseLongTicks on their original rows. That is NOT a null: label and
        # geometry are mechanically coupled (a close near the high makes the high
        # likely to break first), so severing them manufactures rows with a large
        # win and a small loss. It "proved" +72 ticks/trade and spearman 0.93 out
        # of pure noise. Moving the triple together keeps the label-geometry joint
        # distribution intact and destroys ONLY the feature->outcome link, which is
        # the thing under test.
        cols = ["firstBreak", "winLongTicks", "loseLongTicks"]
        parts = []
        for _, g in d.groupby("tradeDate", sort=False):
            g = g.copy()
            g[cols] = g[cols].values[rng.permutation(len(g))]
            parts.append(g)
        d = pd.concat(parts).sort_index()
    freeze_year = str(int(d.tradeDate.min()[:4]) + 1) + "-01-01"
    cands, th = build_candidates(d, freeze_year)
    # only score windows AFTER the frozen-threshold period
    d = d[d.tradeDate >= freeze_year].reset_index(drop=True)
    days = np.sort(d.tradeDate.unique())
    day_idx = pd.Series(np.arange(len(days)), index=days)
    d["dnum"] = d.tradeDate.map(day_idx).values

    masks = {c: candidate_mask(d, c, th) for c in cands}
    pnl = {s: net_ticks(d, s) for s in (1, -1)}
    # 🚨 Skill MUST be measured against the geometry, not against a flat base rate.
    # For a driftless random walk the first-passage probability is exact and
    # parameter-free:  P(high first) = (close-low) / ((high-close)+(close-low)).
    # A candle closing one tick above its low yields P(low first) ~ 0.95 with no
    # predictive content at all -- you win constantly and win nothing. Measuring
    # "lift over base rate" reported +36pp for candidates that LOSE money. Excess
    # over the martingale is the only skill number that maps to EV, and the fact
    # that the all-candidate baseline lands on exactly -3.00 ticks (= the cost bar)
    # confirms the market sits on this fair line.
    tot = (d.winLongTicks.values + d.loseLongTicks.values).astype(float)
    tot[tot == 0] = np.nan
    p_long = d.loseLongTicks.values / tot
    p_imp = {1: p_long, -1: 1.0 - p_long}
    hit_side = {s: ((d.firstBreak.values == s).astype(float) - p_imp[s]) for s in (1, -1)}

    print(f"\n{'PLACEBO ' if placebo else ''}{product} {tf} — {len(d):,} rows, "
          f"{len(days)} days, {len(cands)} candidates, thresholds frozen pre-{freeze_year}")
    print(f"cost bar: -{COST_WIN} ticks on a win, -{COST_LOSS} on a loss | min n per window {MIN_N}\n")
    print(f"{'win':>4} {'pairs':>6} {'cands':>6} {'spearman':>9} {'p':>8} "
          f"{'top10%carry':>12} {'adaptive':>9} {'static':>8} {'allmean':>8}")

    out = []
    for W in WINDOWS:
        d["win"] = d.dnum // W
        wins = np.sort(d.win.unique())
        # EV table: rows = windows, cols = candidates
        ev = pd.DataFrame(index=wins, columns=range(len(cands)), dtype=float)
        nn = pd.DataFrame(index=wins, columns=range(len(cands)), dtype=float)
        sk = pd.DataFrame(index=wins, columns=range(len(cands)), dtype=float)
        wmask = {w: (d.win.values == w) for w in wins}
        for ci, c in enumerate(cands):
            m_all = masks[c]; side = c[3]; p = pnl[side]
            for w in wins:
                m = m_all & wmask[w]
                k = int(m.sum())
                if k >= MIN_N:
                    ev.at[w, ci] = p[m].mean()
                    nn.at[w, ci] = k
                    # skill = hit rate above the window's own base rate for this side.
                    # Strips drift and cost, isolating directional accuracy: EV alone
                    # cannot separate "no skill" from "skill smaller than the cost bar".
                    sk.at[w, ci] = np.nanmean(hit_side[side][m])
        rhos, ps, carry, adapt, static, allm, skill_rho = [], [], [], [], [], [], []
        adapt_skill, top_ev = [], []
        for i in range(len(wins) - 1):
            a, b = ev.loc[wins[i]], ev.loc[wins[i + 1]]
            both = a.notna() & b.notna()
            if both.sum() < 20:
                continue
            r, pv = spearmanr(a[both], b[both])
            rhos.append(r); ps.append(pv)
            sa, sb = sk.loc[wins[i]], sk.loc[wins[i + 1]]
            sboth = sa.notna() & sb.notna()
            if sboth.sum() >= 20:
                skill_rho.append(spearmanr(sa[sboth], sb[sboth])[0])
            # top-decile carryover
            k = max(1, int(both.sum() * 0.10))
            top_a = a[both].nlargest(k).index
            top_b = set(b[both].nlargest(k).index)
            carry.append(np.mean([ix in top_b for ix in top_a]))
            # adaptive: top-K from window i, realised in i+1
            picks = a[both].nlargest(TOP_K).index
            adapt.append(b[picks].mean())
            # The number that decides economics: pick the top-K by SKILL (lift over
            # base rate) in t, and measure the lift they actually deliver in t+1.
            # Rank persistence says nothing about magnitude -- a stable +0.5pp lift
            # ranks perfectly and is still worthless against the cost bar.
            if sboth.sum() >= 20:
                sp = sa[sboth].nlargest(TOP_K).index
                adapt_skill.append(sb[sp].mean())
                top_ev.append(b[sp].mean())
            # static: best candidate on ALL windows up to and including i, realised in i+1
            hist = ev.loc[wins[: i + 1]].mean(axis=0)
            hv = hist[both]
            if hv.notna().any():
                static.append(b[hv.idxmax()])
            allm.append(b[both].mean())
        if not rhos:
            continue
        print(f"{W:>4} {len(rhos):>6} {int(ev.notna().sum(axis=1).mean()):>6} "
              f"{np.mean(rhos):>9.3f} {np.median(ps):>8.3f} "
              f"{np.mean(carry):>11.1%} {np.mean(adapt):>9.2f} "
              f"{np.mean(static) if static else float('nan'):>8.2f} {np.mean(allm):>8.2f}")
        out.append(dict(window=W, pairs=len(rhos), spearman=np.mean(rhos),
                        skill_rho=np.mean(skill_rho) if skill_rho else np.nan,
                        adapt_skill_pp=100 * np.mean(adapt_skill) if adapt_skill else np.nan,
                        skill_pick_ev=np.mean(top_ev) if top_ev else np.nan,
                        carry=np.mean(carry), adaptive=np.mean(adapt),
                        static=np.mean(static) if static else np.nan,
                        allmean=np.mean(allm)))
    print("\nspearman  = mean rank corr of candidate EV, window t vs t+1 (0 => no persistence)")
    print("carry     = P(top decile in t+1 | top decile in t); 10% is chance")
    print("adaptive  = mean net ticks/trade of the top-10 picked in t, REALISED in t+1")
    print("static    = same, but the single best rule on all history before t+1")
    print("allmean   = mean net ticks/trade across all candidates in t+1 (the do-nothing baseline)")
    return pd.DataFrame(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--product", default="NQ")
    ap.add_argument("--tf", default="5m")
    ap.add_argument("--placebo", action="store_true")
    ap.add_argument("--seeds", type=int, default=3)
    a = ap.parse_args()
    real = run(a.product, a.tf, False)
    # Average several placebo seeds: one draw of the null is itself noisy, and the
    # null is NOT at chance level (variance across candidate sample sizes inflates
    # top-decile carryover), so it must be measured rather than assumed.
    nulls = [run(a.product, a.tf, True, seed=100 + i) for i in range(a.seeds)]
    null = pd.concat(nulls).groupby("window").mean().reset_index()
    m = real.merge(null, on="window", suffixes=("", "_null"))
    print("\n" + "=" * 78)
    print(f"EXCESS OVER NULL — {a.product} {a.tf}  ({a.seeds} placebo seeds)")
    print("=" * 78)
    print(f"{'win':>4} {'rhoEV':>7} {'rhoSkill':>9} {'carry':>7} | "
          f"{'liftPP':>7} {'liftPP_null':>12} {'liftEXCESS':>11} | {'ev':>7} {'base':>7}")
    for _, r in m.iterrows():
        print(f"{int(r.window):>4} {r.spearman - r.spearman_null:>7.3f} "
              f"{r.skill_rho - r.skill_rho_null:>9.3f} {r.carry - r.carry_null:>6.1%} | "
              f"{r.adapt_skill_pp:>7.2f} {r.adapt_skill_pp_null:>12.2f} "
              f"{r.adapt_skill_pp - r.adapt_skill_pp_null:>11.2f} | "
              f"{r.skill_pick_ev:>7.2f} {r.allmean:>7.2f}")
    print("\nAll columns except adaptive/baseline are EXCESS over the permuted null.")
    print("adaptive/baseline are net ticks per trade; 0.00 is breakeven after costs.")
    m.to_csv(os.path.join(HERE, f"a1_{a.product}_{a.tf}.csv"), index=False)
    print(f"saved -> a1_{a.product}_{a.tf}.csv")
