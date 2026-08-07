#!/usr/bin/env python3
"""Reverse-engineer the fade-vs-continue read: which formation features separate winning fades from run-overs?

Label = hit20_s10 (MFE>=20 before a 10pt stop) on the FADE arm. Population = penetration fades (pen>=THRESH).
For each formation feature, a-priori hypothesized direction for FADE-WINS:
  wick_beyond  (+)  bigger poke-then-reject = stall
  close_loc_sig(+)  closed back toward origin = stall     [== wick_frac by construction]
  range_vs_atr (-)  small candle vs ATR = deceleration/stall ; big = momentum
  range_ratio  (-)  shrinking vs prior candle = stall
  body_frac    (-)  small indecisive body = stall
  approach_vel (?)  control (not a Drew tell)
CRITICAL: run the SAME on placebo levels. A feature that separates fades on placebo too is a generic
candle-shape effect, not GEX-specific. GEX edge = separation BEYOND placebo. Combined a-priori stall score
tested with per-quarter + a 2025-train / 2026-test held-out split. No feature selection on the outcome.
"""
import glob
import numpy as np
import pandas as pd

BASE = "/home/drew/projects/slingshot-services/backtest-engine/research/dealer-reaction"
FEATS = [("wick_beyond", +1), ("close_loc_sig", +1), ("range_vs_atr", -1),
         ("range_ratio", -1), ("body_frac", -1), ("approach_vel", 0)]


def load(fam):
    d = pd.read_csv(f"{BASE}/events_{fam}.csv")
    d = d[d.arm == "fade"].copy()
    for c in ["range_ratio"]:
        d[c] = pd.to_numeric(d[c], errors="coerce")
    d["win"] = d["hit20_s10"]
    return d


def pf(x):
    x = x[np.isfinite(x)]
    w, l = x[x > 0].sum(), -x[x < 0].sum()
    return w / l if l > 0 else np.inf


def tercile_table(d, feat, sign, label="win"):
    s = d.dropna(subset=[feat])
    try:
        s = s.assign(t=pd.qcut(s[feat], 3, labels=["lo", "mid", "hi"], duplicates="drop"))
    except ValueError:
        return None
    g = s.groupby("t", observed=True).agg(n=(label, "size"), hit=(label, "mean"),
                                          real=("realized", "mean"))
    fav = "hi" if sign > 0 else "lo"   # stall-favorable tercile
    return g, fav


def main():
    fams = {f: load(f) for f in ["gex", "placebo_round", "placebo_rand"]}
    for THRESH in (10, 20):
        print(f"\n{'#'*100}\n# PENETRATION-FADE population: pen >= {THRESH}\n{'#'*100}")
        sub = {f: d[d.pen >= THRESH] for f, d in fams.items()}
        for f, d in sub.items():
            print(f"  {f}: n={len(d)} base hit20={d.win.mean()*100:.1f}% realPF={pf(d.realized.values):.2f}")

        print(f"\n  --- per-feature tercile hit20% (stall-favorable tercile in [brackets]); GEX vs placebo_round ---")
        for feat, sign in FEATS:
            if sign == 0:
                continue
            rg = tercile_table(sub["gex"], feat, sign)
            rp = tercile_table(sub["placebo_round"], feat, sign)
            if rg is None or rp is None:
                continue
            gg, fav = rg; gp, _ = rp
            def fmt(g):
                return " ".join(f"{t}={g.loc[t,'hit']*100:4.1f}%" for t in ["lo", "mid", "hi"] if t in g.index)
            # separation = favorable tercile hit - unfavorable tercile hit
            unf = "lo" if fav == "hi" else "hi"
            gsep = (gg.loc[fav, "hit"] - gg.loc[unf, "hit"]) * 100 if fav in gg.index and unf in gg.index else np.nan
            psep = (gp.loc[fav, "hit"] - gp.loc[unf, "hit"]) * 100 if fav in gp.index and unf in gp.index else np.nan
            print(f"    {feat:13s} fav={fav} | GEX {fmt(gg)} (sep {gsep:+.1f}) | PLAC {fmt(gp)} (sep {psep:+.1f}) "
                  f"| GEX-edge-over-plac {gsep-psep:+.1f}pp")

        # ---- combined a-priori stall score (percentile-ranked, GEX pool) ----
        print(f"\n  --- combined stall score = pct(wick_beyond)+pct(close_loc_sig)-pct(range_vs_atr)-pct(body_frac) ---")
        for f, d in sub.items():
            dd = d.dropna(subset=["wick_beyond", "close_loc_sig", "range_vs_atr", "body_frac"]).copy()
            score = (dd.wick_beyond.rank(pct=True) + dd.close_loc_sig.rank(pct=True)
                     - dd.range_vs_atr.rank(pct=True) - dd.body_frac.rank(pct=True))
            dd["stall"] = score
            hi = dd[dd.stall >= dd.stall.quantile(0.66)]
            lo = dd[dd.stall <= dd.stall.quantile(0.34)]
            print(f"    {f:14s} stall-HI n={len(hi)} hit20={hi.win.mean()*100:4.1f}% realPF={pf(hi.realized.values):.2f} real={hi.realized.mean():+.2f}"
                  f" | stall-LO hit20={lo.win.mean()*100:4.1f}% realPF={pf(lo.realized.values):.2f}")
            fams[f + "_scored"] = dd  # stash

    # ---- held-out: define stall-HI threshold on 2025 GEX (pen>=20), test 2026 ----
    print(f"\n{'#'*100}\n# HELD-OUT: GEX fade, pen>=20, stall-HI (score>=2025 66th pct). Train 2025 -> test 2026\n{'#'*100}")
    d = fams["gex"]; d = d[d.pen >= 20].dropna(subset=["wick_beyond", "close_loc_sig", "range_vs_atr", "body_frac"]).copy()
    d["stall"] = (d.wick_beyond.rank(pct=True) + d.close_loc_sig.rank(pct=True)
                  - d.range_vs_atr.rank(pct=True) - d.body_frac.rank(pct=True))
    tr = d[d.date < "2026-01-01"]; te = d[d.date >= "2026-01-01"]
    thr = tr.stall.quantile(0.66)
    for tag, s in [("TRAIN 2025", tr), ("TEST 2026", te)]:
        hi = s[s.stall >= thr]; allf = s
        print(f"  {tag}: ALL fade n={len(allf)} hit20={allf.win.mean()*100:.1f}% realPF={pf(allf.realized.values):.2f}"
              f" || stall-HI n={len(hi)} hit20={hi.win.mean()*100:.1f}% realPF={pf(hi.realized.values):.2f} real={hi.realized.mean():+.2f}")
    print("\n  per-quarter stall-HI (GEX pen>=20):")
    hi = d[d.stall >= thr]
    for q in sorted(hi.quarter.unique()):
        s = hi[hi.quarter == q]
        print(f"    {q}: n={len(s):2d} hit20={s.win.mean()*100:4.1f}% real={s.realized.mean():+6.2f} realPF={pf(s.realized.values):.2f}")


if __name__ == "__main__":
    main()
