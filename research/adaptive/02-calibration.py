#!/usr/bin/env python3
"""
A1b — Does in-window skill PREDICT next-window skill, at any level?

A1 reported a ~0.2pp mean edge and called the gate RED. A mean can hide a
concentrated edge, and the whole "keep winners, kill underperformers" premise
depends on the relationship holding AT THE TOP END, not on average. So: bin
candidates by their skill in window t and plot the skill they actually deliver
in t+1. That is a calibration curve.

  flat        -> selection has no predictive value at ANY threshold; RED confirmed
  upward      -> selection works, and the slope tells us where to set the cut

Skill is excess over the martingale first-passage probability
    P(high first) = (close-low) / ((high-close)+(close-low))
because anything else is dominated by geometry (see FINDINGS.md).

Same matched null as A1: outcome triple permuted within day.

usage: 02-calibration.py [--product NQ] [--tf 5m] [--window 21]
"""
import os, sys, argparse
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import importlib.util
spec = importlib.util.spec_from_file_location("a1", os.path.join(HERE, "01-persistence.py"))
a1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(a1)

MIN_N = 30

def collect(product, tf, W, placebo, seed=7):
    d = a1.load(product, tf).reset_index(drop=True)
    if placebo:
        rng = np.random.default_rng(seed)
        cols = ["firstBreak", "winLongTicks", "loseLongTicks"]
        parts = []
        for _, g in d.groupby("tradeDate", sort=False):
            g = g.copy(); g[cols] = g[cols].values[rng.permutation(len(g))]; parts.append(g)
        d = pd.concat(parts).sort_index()
    freeze = str(int(d.tradeDate.min()[:4]) + 1) + "-01-01"
    cands, th = a1.build_candidates(d, freeze)
    d = d[d.tradeDate >= freeze].reset_index(drop=True)
    days = np.sort(d.tradeDate.unique())
    d["dnum"] = d.tradeDate.map(pd.Series(np.arange(len(days)), index=days)).values
    d["win"] = d.dnum // W

    tot = (d.winLongTicks.values + d.loseLongTicks.values).astype(float)
    tot[tot == 0] = np.nan
    p_long = d.loseLongTicks.values / tot
    p_imp = {1: p_long, -1: 1.0 - p_long}
    skill_row = {s: ((d.firstBreak.values == s).astype(float) - p_imp[s]) for s in (1, -1)}
    pnl = {s: a1.net_ticks(d, s) for s in (1, -1)}

    wins = np.sort(d.win.unique())
    wmask = {w: (d.win.values == w) for w in wins}
    rows = []
    for c in cands:
        m_all = a1.candidate_mask(d, c, th); side = c[3]
        prev = None
        for w in wins:
            m = m_all & wmask[w]
            k = int(m.sum())
            cur = (np.nanmean(skill_row[side][m]), np.nanmean(pnl[side][m]), k) if k >= MIN_N else None
            if prev and cur:
                rows.append((prev[0], cur[0], cur[1], prev[2], cur[2]))
            prev = cur
    return pd.DataFrame(rows, columns=["skill_t", "skill_t1", "ev_t1", "n_t", "n_t1"])

def report(df, label, bins=10):
    df = df.dropna()
    df["dec"] = pd.qcut(df.skill_t, bins, labels=False, duplicates="drop")
    g = df.groupby("dec").agg(n_pairs=("skill_t", "size"),
                              skill_t=("skill_t", "mean"),
                              skill_t1=("skill_t1", "mean"),
                              ev_t1=("ev_t1", "mean"))
    g["skill_t_pp"] = 100 * g.skill_t
    g["skill_t1_pp"] = 100 * g.skill_t1
    # standard error on the realised bucket, for judging whether a slope is real
    se = df.groupby("dec").skill_t1.sem() * 100
    g["se_pp"] = se
    print(f"\n--- {label} ---")
    print(f"{'decile':>6} {'pairs':>7} {'skill_t(pp)':>12} {'skill_t+1(pp)':>14} {'+-se':>7} {'ev_t+1':>8}")
    for i, r in g.iterrows():
        print(f"{int(i):>6} {int(r.n_pairs):>7} {r.skill_t_pp:>12.2f} "
              f"{r.skill_t1_pp:>14.2f} {r.se_pp:>7.2f} {r.ev_t1:>8.2f}")
    lo, hi = g.skill_t1_pp.iloc[0], g.skill_t1_pp.iloc[-1]
    print(f"  top-minus-bottom decile spread: {hi - lo:+.2f}pp")
    return g

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--product", default="NQ")
    ap.add_argument("--tf", default="5m")
    ap.add_argument("--window", type=int, default=21)
    a = ap.parse_args()
    print(f"A1b calibration — {a.product} {a.tf}, {a.window}-day windows, min n {MIN_N}")
    real = collect(a.product, a.tf, a.window, False)
    gr = report(real, "REAL")
    null = collect(a.product, a.tf, a.window, True, seed=101)
    gn = report(null, "NULL (outcome triple permuted within day)")
    print("\nIf the REAL curve is as flat as the NULL curve, past skill carries no")
    print("information about future skill at any threshold, and no 'keep winners'")
    print("rule can work regardless of how it is tuned.")
