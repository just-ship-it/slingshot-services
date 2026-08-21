#!/usr/bin/env python3
"""
A2 — LOCAL analogue repetition, at Drew's actual timescale.

A1 tested the wrong thing: it selected among candidates on 5-63 TRADING-DAY
windows. The real question is far faster — do 1m/3m candle signatures from the
last hour or two predict how a similarly-shaped candle resolves in the next hour?

So the predictor here is not "which rule has been good lately" but "how did the
last few candles THAT LOOK LIKE THIS ONE just resolve".

  signature -> discretise each candle (close location, body share, volume lean)
  predictor -> mean martingale-residual of the previous m candles in the SAME
               signature bucket, strictly before t, capped by age
  target    -> this candle's own martingale residual

Residual r = 1{high first} - P_martingale(high first), with
P = (close-low)/((high-close)+(close-low)). E[r] = 0 on a driftless walk, so any
predictable structure in r is genuine directional information, not geometry.
(See FINDINGS.md: every metric here that is not geometry-normalised gets
dominated by geometry.)

Null: outcome triple permuted within day, which destroys the local link while
preserving the label-geometry coupling and the daily marginals.

usage: 04-local-analogue.py [--tf 3m] [--maxage 120] [--seeds 3]
"""
import os, sys, argparse
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
FB = os.path.join(HERE, "..", "tick-engine", "firstbreak")
COST_WIN, COST_LOSS = 2.0, 4.0
MS = [3, 5, 10, 20]          # how many recent look-alikes to average

def load(tf, placebo, seed=7):
    d = pd.read_csv(os.path.join(FB, f"NQ_{tf}_fb.csv"))
    d = d[d.firstBreak.isin([1, -1])].copy().sort_values("ts").reset_index(drop=True)
    if placebo:
        rng = np.random.default_rng(seed)
        cols = ["firstBreak", "winLongTicks", "loseLongTicks"]
        parts = []
        for _, g in d.groupby("tradeDate", sort=False):
            g = g.copy(); g[cols] = g[cols].values[rng.permutation(len(g))]; parts.append(g)
        d = pd.concat(parts).sort_values("ts").reset_index(drop=True)
    tot = (d.winLongTicks + d.loseLongTicks).astype(float).replace(0, np.nan)
    d["p_imp"] = d.loseLongTicks / tot
    d["r"] = (d.firstBreak == 1).astype(float) - d.p_imp
    rng_t = d.rangeTicks.replace(0, np.nan)
    # candle SIGNATURE — deliberately coarse so look-alikes recur within an hour or two
    d["sig_clv"]  = (d.clv > 0).astype(int)
    d["sig_body"] = pd.qcut(d.bodyTicks / rng_t, 3, labels=False, duplicates="drop")
    d["sig_vol"]  = (d.upVolPct > d.dnVolPct).astype(int)
    d["sig"] = d.sig_clv.astype(str) + "_" + d.sig_body.astype(str) + "_" + d.sig_vol.astype(str)
    return d.dropna(subset=["r", "sig_body"])

def build(d, m, maxage_min):
    g = d.groupby("sig", sort=False)
    # strictly-prior mean residual of the last m look-alikes
    d["pred"] = g["r"].transform(lambda s: s.shift(1).rolling(m, min_periods=m).mean())
    # age of the OLDEST of those m, so we can report the real timescale
    d["age"] = (d.ts - g["ts"].transform(lambda s: s.shift(m))) / 60.0
    return d[d.pred.notna() & (d.age <= maxage_min)]

def net_ticks(d, side):
    hit = (d.firstBreak.values == side)
    win = np.where(side == 1, d.winLongTicks.values, d.loseLongTicks.values)
    los = np.where(side == 1, d.loseLongTicks.values, d.winLongTicks.values)
    return np.where(hit, win - COST_WIN, -(los + COST_LOSS))

def evaluate(d):
    """Bet the sign of the recent look-alike bias; report skill and economics."""
    side = np.where(d.pred.values > 0, 1, -1)
    r_signed = np.where(side == 1, d.r.values, -d.r.values)     # skill in the bet direction
    pnl = np.where(side == 1, net_ticks(d, 1), net_ticks(d, -1))
    return dict(n=len(d), age_med=d.age.median(),
                skill_pp=100 * r_signed.mean(),
                skill_se=100 * r_signed.std(ddof=1) / np.sqrt(len(d)),
                ev=pnl.mean(),
                corr=np.corrcoef(d.pred.values, d.r.values)[0, 1])

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--tf", default="3m")
    ap.add_argument("--maxage", type=float, default=120)
    ap.add_argument("--seeds", type=int, default=3)
    a = ap.parse_args()
    real_raw = load(a.tf, False)
    print(f"A2 local analogue — NQ {a.tf}, look-alikes capped at {a.maxage:.0f} min old")
    print(f"{len(real_raw):,} candles, {real_raw.sig.nunique()} signature buckets\n")
    print(f"{'m':>3} {'n':>8} {'ageMed':>7} | {'corr':>7} {'skillPP':>8} {'+-se':>6} "
          f"{'nullPP':>7} {'EXCESS':>7} {'z':>6} | {'ev':>7}")
    for m in MS:
        R = evaluate(build(real_raw.copy(), m, a.maxage))
        nulls = []
        for i in range(a.seeds):
            nd = build(load(a.tf, True, seed=400 + i), m, a.maxage)
            nulls.append(evaluate(nd))
        npp = np.mean([x["skill_pp"] for x in nulls])
        nsd = np.std([x["skill_pp"] for x in nulls], ddof=1) if len(nulls) > 1 else np.nan
        exc = R["skill_pp"] - npp
        z = exc / R["skill_se"] if R["skill_se"] else np.nan
        print(f"{m:>3} {R['n']:>8,} {R['age_med']:>7.0f} | {R['corr']:>7.4f} "
              f"{R['skill_pp']:>8.3f} {R['skill_se']:>6.3f} {npp:>7.3f} {exc:>7.3f} "
              f"{z:>6.2f} | {R['ev']:>7.2f}")
    print("\nskillPP = mean martingale-excess in the bet direction (0 = no edge)")
    print("z       = excess over null, in standard errors of the real estimate")
    print("ev      = net ticks/trade after costs; needs ~0.00 to be worth anything")
