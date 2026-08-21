#!/usr/bin/env python3
"""
A1c — the same persistence gate, on the MTF dataset Drew actually asked about:
does LOWER-timeframe structure predict which side of the PREVIOUS HIGHER-timeframe
candle breaks first?

A1 used single-feature thresholds on a candle's own extremes. This is both a
RICHER family (adds the cumulative path since the HTF close, the LTF sequence
position, and the HTF candle's own shape) and closer to the original question,
so it is the fairer test of the adaptive premise.

Substrate: tick-engine/mtf/NQ_15m_3m_mtf.csv — features knowable at each LTF
close while both HTF extremes are unbroken; label walked on 1s bars from that
instant; ambiguous seconds never counted as a win.

Reuses A1's machinery unchanged, including the martingale skill baseline and the
matched null (outcome triple permuted within day). See FINDINGS.md for why any
metric not normalised by geometry is dominated by it.

usage: 03-mtf-persistence.py [--htf 15m --ltf 3m] [--seeds 3]
"""
import os, sys, argparse, importlib.util, io, contextlib
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("a1", os.path.join(HERE, "01-persistence.py"))
a1 = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(a1)

MTF = os.path.join(HERE, "..", "tick-engine", "mtf")

MTF_FEATURES = [
    # LTF candle anatomy (the "does this bar lean up or down" family)
    "f_vol", "f_time", "f_int", "f_touch", "f_centroid", "f_clv", "f_body",
    # path since the HTF close — the part A1's family could not express
    "f_cummove", "f_cumvolz", "f_maxup", "f_maxdn", "f_k",
    # HTF context
    "f_pos", "f_htfclv", "f_htfwick", "f_atr", "f_ltfvolz",
]

def load_mtf(htf, ltf):
    p = os.path.join(MTF, f"NQ_{htf}_{ltf}_mtf.csv")
    d = pd.read_csv(p)
    d = d[d.firstBreak.isin([1, -1])].copy()
    d["bucket"] = a1.et_bucket(d.ltfTs)
    d["ts"] = d.ltfTs
    # standardise the payoff column names A1 expects
    d["winLongTicks"] = d.winTicks
    d["loseLongTicks"] = d.loseTicks
    lr = d.lRangeTicks.replace(0, np.nan)
    hr = d.htfRangeTicks.replace(0, np.nan)
    d["f_vol"]      = d.lUpVolPct - d.lDnVolPct
    d["f_time"]     = d.lUpTimePct - d.lDnTimePct
    d["f_int"]      = d.lUpInt - d.lDnInt
    d["f_touch"]    = d.lUpTouches - d.lDnTouches
    d["f_centroid"] = d.lUpCentroidV - d.lDnCentroidV
    d["f_clv"]      = d.lClv
    d["f_body"]     = d.lBodyTicks / lr
    d["f_cummove"]  = d.cumMoveTicks / d.atrTicks.replace(0, np.nan)
    d["f_cumvolz"]  = d.cumVolZ
    d["f_maxup"]    = d.maxUpTicks / d.atrTicks.replace(0, np.nan)
    d["f_maxdn"]    = d.maxDnTicks / d.atrTicks.replace(0, np.nan)
    d["f_k"]        = d.k
    d["f_pos"]      = d.posInRange
    d["f_htfclv"]   = d.htfClv
    d["f_htfwick"]  = (d.htfUpWick - d.htfDnWick) / hr
    d["f_atr"]      = d.atrTicks
    d["f_ltfvolz"]  = d.lVolZ
    return d.dropna(subset=["f_body", "f_cummove"])

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--htf", default="15m")
    ap.add_argument("--ltf", default="3m")
    ap.add_argument("--seeds", type=int, default=3)
    a = ap.parse_args()
    a1.FEATURES = MTF_FEATURES
    a1.load = lambda product, tf: load_mtf(a.htf, a.ltf)
    real = a1.run("NQ", f"{a.htf}<-{a.ltf}", False)
    nulls = [a1.run("NQ", f"{a.htf}<-{a.ltf}", True, seed=300 + i) for i in range(a.seeds)]
    null = pd.concat(nulls).groupby("window").mean().reset_index()
    m = real.merge(null, on="window", suffixes=("", "_null"))
    print("\n" + "=" * 78)
    print(f"A1c MTF — does {a.ltf} structure predict the {a.htf} break?  ({a.seeds} null seeds)")
    print("=" * 78)
    print(f"{'win':>4} {'rhoEV':>7} {'rhoSkill':>9} {'carry':>7} | "
          f"{'liftPP':>7} {'null':>7} {'EXCESS':>8} | {'ev':>7} {'base':>7}")
    for _, r in m.iterrows():
        print(f"{int(r.window):>4} {r.spearman - r.spearman_null:>7.3f} "
              f"{r.skill_rho - r.skill_rho_null:>9.3f} {r.carry - r.carry_null:>6.1%} | "
              f"{r.adapt_skill_pp:>7.2f} {r.adapt_skill_pp_null:>7.2f} "
              f"{r.adapt_skill_pp - r.adapt_skill_pp_null:>8.2f} | "
              f"{r.skill_pick_ev:>7.2f} {r.allmean:>7.2f}")
    m.to_csv(os.path.join(HERE, f"a1c_NQ_{a.htf}_{a.ltf}.csv"), index=False)
    print(f"\nsaved -> a1c_NQ_{a.htf}_{a.ltf}.csv")
