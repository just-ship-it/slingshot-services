#!/usr/bin/env python3
"""
A2c — fast signal, big target.

A2b showed the local-analogue edge concentrates near round numbers (+1.0pp) and
in 10:00-12:00 (+0.6pp), reaching ~2pp combined — but the 3m candle's own extremes
are only ~35 ticks combined, needing 7.3pp to clear costs. The signal is not too
weak; the TARGET is too small.

So: keep the 3m signature (look-alikes recur every ~50-80 min, Drew's timescale)
and take the PREVIOUS 15m CANDLE's extremes as the bracket — 97 ticks combined at
the median, which needs only ~3.0pp, and ~1.8pp in the top quartile.

Two things this must get right that the earlier scripts did not have to:
  - OVERLAP: many LTF rows watch the SAME 15m candle and share its levels. Those
    are not independent trades and cannot all be taken. Restricted to ONE row per
    HTF candle (the first that qualifies), which is also what is tradeable.
  - GEOMETRY STRATA: breakeven excess depends on the bracket width, so EV is
    reported per stratum rather than pooled over incomparable trades.

usage: 06-mtf-local.py [--m 5] [--maxage 120] [--seeds 3]
"""
import os, argparse
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
MTF = os.path.join(HERE, "..", "tick-engine", "mtf")
COST_WIN, COST_LOSS = 2.0, 4.0

def load(placebo=False, seed=7):
    d = pd.read_csv(os.path.join(MTF, "NQ_15m_3m_mtf.csv"))
    d = d[d.firstBreak.isin([1, -1])].copy().sort_values("ltfTs").reset_index(drop=True)
    if placebo:
        rng = np.random.default_rng(seed)
        cols = ["firstBreak", "winTicks", "loseTicks"]
        parts = []
        for _, g in d.groupby("tradeDate", sort=False):
            g = g.copy(); g[cols] = g[cols].values[rng.permutation(len(g))]; parts.append(g)
        d = pd.concat(parts).sort_values("ltfTs").reset_index(drop=True)
    tot = (d.winTicks + d.loseTicks).astype(float).replace(0, np.nan)
    d["X"] = tot
    d["p_imp"] = d.loseTicks / tot
    d["r"] = (d.firstBreak == 1).astype(float) - d.p_imp
    lr = d.lRangeTicks.replace(0, np.nan)
    d["sig"] = ((d.lClv > 0).astype(int).astype(str) + "_" +
                pd.qcut(d.lBodyTicks / lr, 3, labels=False, duplicates="drop").astype(str) + "_" +
                (d.lUpVolPct > d.lDnVolPct).astype(int).astype(str))
    et = pd.to_datetime(d.ltfTs, unit="s", utc=True).dt.tz_convert("America/New_York")
    d["hhmm"] = et.dt.hour * 100 + et.dt.minute
    for step in (50, 100):
        d[f"d{step}"] = (d.px - (d.px / step).round() * step).abs()
    return d.dropna(subset=["r", "sig", "X"])

def build(d, m, maxage):
    g = d.groupby("sig", sort=False)
    d["pred"] = g["r"].transform(lambda s: s.shift(1).rolling(m, min_periods=m).mean())
    d["age"] = (d.ltfTs - g["ltfTs"].transform(lambda s: s.shift(m))) / 60.0
    return d[d.pred.notna() & (d.age <= maxage)]

def one_per_htf(d):
    """Overlapping rows share a bracket and cannot all be traded: keep the first."""
    return d.sort_values("ltfTs").drop_duplicates("htfTs", keep="first")

def stats(d):
    if len(d) < 300:
        return None
    side = np.where(d.pred.values > 0, 1, -1)
    r_signed = np.where(side == 1, d.r.values, -d.r.values)
    hit = (d.firstBreak.values == side)
    win = np.where(side == 1, d.winTicks.values, d.loseTicks.values)
    los = np.where(side == 1, d.loseTicks.values, d.winTicks.values)
    pnl = np.where(hit, win - COST_WIN, -(los + COST_LOSS))
    Xm = d.X.median() / 2
    need = 100 * ((Xm + 4) / (2 * Xm + 2) - 0.5)
    return dict(n=len(d), skill=100 * r_signed.mean(),
                se=100 * r_signed.std(ddof=1) / np.sqrt(len(d)),
                need=need, ev=pnl.mean(), Xmed=d.X.median())

def run_cells(real, nulls, label_filter):
    out = []
    for label, f in label_filter:
        R = stats(f(real))
        if not R: continue
        ns = [stats(f(n)) for n in nulls]
        ns = [x for x in ns if x]
        if not ns: continue
        npp = np.mean([x["skill"] for x in ns])
        exc = R["skill"] - npp
        z = exc / R["se"] if R["se"] else np.nan
        out.append(dict(cell=label, n=R["n"], Xmed=R["Xmed"], skill=R["skill"],
                        null=npp, excess=exc, z=z, need=R["need"], ev=R["ev"]))
    return pd.DataFrame(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--m", type=int, default=5)
    ap.add_argument("--maxage", type=float, default=120)
    ap.add_argument("--seeds", type=int, default=3)
    a = ap.parse_args()
    real = one_per_htf(build(load(), a.m, a.maxage))
    nulls = [one_per_htf(build(load(True, 600 + i), a.m, a.maxage)) for i in range(a.seeds)]
    print(f"A2c — 3m signature -> 15m bracket, m={a.m}, age<={a.maxage:.0f}min, "
          f"one trade per 15m candle")
    print(f"{len(real):,} tradeable rows\n")
    cells = [
        ("ALL", lambda d: d),
        ("1000-1200", lambda d: d[(d.hhmm >= 1000) & (d.hhmm < 1200)]),
        ("<=2pt of 50", lambda d: d[d.d50 <= 2]),
        ("<=5pt of 50", lambda d: d[d.d50 <= 5]),
        ("<=2pt of 100", lambda d: d[d.d100 <= 2]),
        ("1000-1200 AND <=5pt of 50", lambda d: d[(d.hhmm >= 1000) & (d.hhmm < 1200) & (d.d50 <= 5)]),
        ("wide bracket (X>=q75)", lambda d: d[d.X >= d.X.quantile(0.75)]),
        ("<=5pt of 50 AND X>=q75", lambda d: d[(d.d50 <= 5) & (d.X >= d.X.quantile(0.75))]),
    ]
    df = run_cells(real, nulls, cells)
    print(f"{'cell':>28} {'n':>7} {'Xmed':>6} {'skillPP':>8} {'null':>7} {'EXC':>7} "
          f"{'z':>6} {'needPP':>7} {'ev':>7}")
    for _, r in df.iterrows():
        flag = "  <-- clears" if r.excess >= r.need else ""
        print(f"{r.cell:>28} {int(r.n):>7,} {r.Xmed:>6.0f} {r.skill:>8.3f} {r.null:>7.3f} "
              f"{r.excess:>7.3f} {r.z:>6.2f} {r.need:>7.2f} {r.ev:>7.2f}{flag}")
    print("\nneedPP = excess required to break even at that cell's median bracket width")
    print("ev     = net ticks/trade after costs")
    df.to_csv(os.path.join(HERE, "a2c_mtf_local.csv"), index=False)
