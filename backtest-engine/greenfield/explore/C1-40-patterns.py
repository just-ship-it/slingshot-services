#!/usr/bin/env python3
"""C1-40: higher-timeframe pattern primitives (bounded, quantifiable only).

(a) Compression boxes: 8-bar (2h) range on 15m bars below the causal 15th
    percentile of a trailing 30-day range distribution -> box frozen; breakout
    = first 15m close beyond box +/-2pts within 16 bars. Follow-through =
    signed move (breakout direction) over next 4/12 15m bars. Control: same
    machinery triggered on mid-range (40-70pct) windows.
(b) Spring (failed break) at C1 level touches:
    shallow: pierced <=5pts within 15m, never broke >5 -> ret60 vs no-pierce
             vs broke; identical categories on random-offset placebos.
    deep:    broke >5 (t_brk<=30) then re-entered >=2pts on origin side
             within 10m -> traverse from re-entry over next 60m, vs
             non-re-entering breaks; identical on placebos (path recompute).
(c) Double test: 2nd touch of a level whose 1st touch had NOT broken by the
    time of the 2nd touch -> hold/bounce rates vs 1st touches, vs placebos.
"""
import sys, time
import numpy as np
import pandas as pd
import C1_common as C

P = C.P
pd.set_option("display.width", 220)


# ------------------------------------------------------- (a) compression ---

def compression(dm, days, use):
    hist = []  # trailing 8-bar range history (list of (td_idx, range))
    HIST_DAYS = 30
    W, MAXWATCH = 8, 16
    events = []
    for k, td in enumerate(use):
        d = dm[td]
        bt, bo, bh, bl, bc, bv = C.agg_bars(d["tmin"], d["o"], d["h"], d["l"],
                                            d["c"], d["v"], 15)
        n = len(bt)
        if n < W + 13:
            continue
        rng = np.array([bh[max(0, j - W + 1): j + 1].max() - bl[max(0, j - W + 1): j + 1].min()
                        for j in range(n)])
        prior = [x for kk, x in hist if kk >= k - HIST_DAYS]
        atrd = float(days.loc[td, "atr14_prior"])
        j = W
        while j < n - 13:
            trig = None
            if len(prior) >= 200:
                p15, p40, p70 = np.percentile(prior, [15, 40, 70])
                if rng[j] <= p15:
                    trig = "comp"
                elif p40 <= rng[j] <= p70 and (j % 3 == 0):  # subsample controls
                    trig = "ctrl"
            if trig:
                bhi = bh[j - W + 1: j + 1].max()
                blo = bl[j - W + 1: j + 1].min()
                brk = None
                for m in range(j + 1, min(j + 1 + MAXWATCH, n)):
                    if bc[m] > bhi + 2:
                        brk = (m, 1, bc[m])
                        break
                    if bc[m] < blo - 2:
                        brk = (m, -1, bc[m])
                        break
                if brk:
                    m, dirn, cb = brk
                    ft4 = dirn * (bc[m + 4] - cb) if m + 4 < n else np.nan
                    ft12 = dirn * (bc[m + 12] - cb) if m + 12 < n else np.nan
                    events.append(dict(td=td, year=td[:4], kind=trig, tmin=int(bt[m]),
                                       rng=rng[j], rng_atr=rng[j] / atrd, dirn=dirn,
                                       ft4=ft4, ft12=ft12, ft4_atr=ft4 / atrd,
                                       ft12_atr=ft12 / atrd,
                                       watch=m - j))
                    j = (m if brk else j) + 2
                else:
                    j += W  # no breakout within watch window
            else:
                j += 1
        for jj in range(W, n):
            hist.append((k, rng[jj]))
        hist = [x for x in hist if x[0] >= k - HIST_DAYS]
    ev = pd.DataFrame(events)
    print(f"\n===== (a) COMPRESSION BOXES: {len(ev)} breakout events =====")
    if not len(ev):
        return

    def s(g):
        return pd.Series(dict(n=len(g), ft4_med=g.ft4.median(), ft4_pos=(g.ft4 > 0).mean(),
                              ft12_med=g.ft12.median(), ft12_pos=(g.ft12 > 0).mean(),
                              ft12_atr=g.ft12_atr.median(),
                              up_share=(g.dirn > 0).mean()))
    print(ev.groupby("kind").apply(s).round(3).to_string())
    print("\nby year (comp - ctrl, ft12_med):")
    for yr, g in ev.groupby("year"):
        a = g[g.kind == "comp"]
        b = g[g.kind == "ctrl"]
        if len(a) >= 15 and len(b) >= 15:
            print(f"  {yr}: comp n={len(a)} ft12_med={a.ft12.median():+7.2f} "
                  f"pos={(a.ft12>0).mean():.3f} | ctrl n={len(b)} "
                  f"ft12_med={b.ft12.median():+7.2f} pos={(b.ft12>0).mean():.3f}")
    print("\ncomp by direction:")
    print(ev[ev.kind == "comp"].groupby("dirn").apply(s).round(3).to_string())


# ------------------------------------------------- (b) springs, (c) double ---

def load_touches(path):
    t = pd.read_csv(path)
    t = t[t["tol"] == P["tol_main"]].copy()
    tb = t["t_brk"].where(t["t_brk"] > 0, 10 ** 9)
    tr = t["t_r15"].where(t["t_r15"] > 0, 10 ** 9)
    t["bounce1st"] = (tr <= 60) & (tr < tb)
    t["break1st"] = (tb <= 60) & (tb < tr)
    t["resolved"] = t["bounce1st"] | t["break1st"]
    t["clean"] = np.where(t["kind"] == "real", True, ~(t["near_real"] <= 10))
    return t


def springs_shallow(t):
    print("\n===== (b1) SHALLOW SPRING (pierce<=5 in 15m, no break) =====")
    e = t[(t["valid_min"] >= 75)].copy()
    e["cat"] = np.where((e["pen15"] > 0.5) & (e["pen15"] <= 5) & ~((e["t_brk"] > 0) & (e["t_brk"] <= 15)),
                        "spring",
                        np.where((e["t_brk"] > 0) & (e["t_brk"] <= 15), "broke15",
                                 np.where(e["pen15"] <= 0.5, "nopierce", "other")))
    for kind in ("real", "rand"):
        g = e[(e["kind"] == kind) & e["clean"]]
        rows = []
        for cat, gg in g.groupby("cat"):
            r = gg[gg["resolved"]]
            rows.append(dict(cat=cat, n=len(gg), ret60_med=gg.ret60.median(),
                             race15=r.bounce1st.mean() if len(r) else np.nan,
                             ret60_ge15=(gg.ret60 >= 15).mean(),
                             ret60_ge35=(gg.ret60 >= 35).mean()))
        print(f"  [{kind}]")
        print(pd.DataFrame(rows).round(3).to_string(index=False))
    # yearly: spring ret60>=35 rate delta real - rand
    print("  yearly P(ret60>=35 | spring): real vs rand")
    for yr, g in e.groupby("year"):
        a = g[(g["kind"] == "real") & (g["cat"] == "spring")]
        b = g[(g["kind"] == "rand") & g["clean"] & (g["cat"] == "spring")]
        if len(a) >= 50 and len(b) >= 50:
            print(f"    {yr}: real {(a.ret60>=35).mean():.3f} (n={len(a)}) "
                  f"rand {(b.ret60>=35).mean():.3f} (n={len(b)}) "
                  f"d={ (a.ret60>=35).mean()-(b.ret60>=35).mean():+.3f}")


def springs_deep(t, dm, days_index):
    print("\n===== (b2) DEEP SPRING (break>5 then re-enter within 10m) =====")
    e = t[(t["t_brk"] > 0) & (t["t_brk"] <= 30) & (t["valid_min"] >= 110)].copy()
    e["reent"] = (e["t_reenter"] > 0) & ((e["t_reenter"] - e["t_brk"]) <= 10)
    rows = []
    for r in e.itertuples(index=False):
        d = dm.get(r.td)
        if d is None:
            continue
        i = r.bi
        t0 = i + (r.t_reenter if r.reent else r.t_brk + 10)
        n = len(d["c"])
        if t0 + 1 >= n:
            continue
        j1 = min(t0 + 1 + 60, n)
        c0 = d["c"][t0]
        sgn = 1.0 if r.side == "b" else -1.0  # origin side: below level for 'b'
        # traverse toward origin side (bounce direction) = -sgn * (price - c0)
        seg = d["c"][t0 + 1: j1]
        trav = -sgn * (seg[-1] - c0)
        mfe = np.max(-sgn * (seg - c0))
        mae = np.max(sgn * (seg - c0))
        rows.append(dict(kind=r.kind, clean=r.clean, year=r.year, reent=r.reent,
                         trav=trav, mfe=mfe, mae=mae))
    f = pd.DataFrame(rows)
    if not len(f):
        print("(none)")
        return
    def s(g):
        return pd.Series(dict(n=len(g), trav_med=g.trav.median(), trav_pos=(g.trav > 0).mean(),
                              mfe_med=g.mfe.median(), mae_med=g.mae.median()))
    for kind in ("real", "rand"):
        g = f[(f["kind"] == kind) & f["clean"]]
        print(f"  [{kind}] traverse toward origin side after re-entry (ctrl=no re-entry):")
        print(g.groupby("reent").apply(s).round(3).to_string())
    print("  yearly trav_pos (real spring vs rand spring):")
    for yr, g in f.groupby("year"):
        a = g[(g["kind"] == "real") & g["reent"]]
        b = g[(g["kind"] == "rand") & g["clean"] & g["reent"]]
        if len(a) >= 40 and len(b) >= 40:
            print(f"    {yr}: real {(a.trav>0).mean():.3f} (n={len(a)}) "
                  f"rand {(b.trav>0).mean():.3f} (n={len(b)})")


def double_test(t):
    print("\n===== (c) DOUBLE TEST (2nd touch, 1st touch had not broken) =====")
    t = t.sort_values(["level_id", "seed", "td", "tmin"])
    grp = t.groupby(["level_id", "seed"], sort=False)
    t["prev_tbrk"] = grp["t_brk"].shift(1)
    t["prev_td"] = grp["td"].shift(1)
    t["prev_tmin"] = grp["tmin"].shift(1)
    sec = t[t["touch_idx"] == 2].copy()
    sameday = sec["prev_td"] == sec["td"]
    gap = sec["tmin"] - sec["prev_tmin"]
    firstheld = (sec["prev_tbrk"] <= 0) | (~sameday) | (sec["prev_tbrk"] > gap)
    sec = sec[sameday & firstheld]
    first = t[t["touch_idx"] == 1]
    for kind in ("real", "rand"):
        a = sec[(sec["kind"] == kind) & sec["clean"] & sec["resolved"]]
        b = first[(first["kind"] == kind) & first["clean"] & first["resolved"]]
        print(f"  [{kind}] 2nd-after-held: n={len(a)} race15={a.bounce1st.mean():.3f} | "
              f"1st touches: n={len(b)} race15={b.bounce1st.mean():.3f}")
    print("  yearly 2nd-after-held race15 (real vs rand):")
    sec_r = sec[sec["resolved"]]
    for yr, g in sec_r.groupby("year"):
        a = g[g["kind"] == "real"]
        b = g[(g["kind"] == "rand") & g["clean"]]
        if len(a) >= 40 and len(b) >= 40:
            print(f"    {yr}: real {a.bounce1st.mean():.3f} (n={len(a)}) "
                  f"rand {b.bounce1st.mean():.3f} (n={len(b)})")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else f"{C.HERE}/C1-touches.csv.gz"
    days = C.load_days()
    bars = C.load_bars(C.NQ_1M)
    dm = C.day_arrays(bars)
    use = C.usable_tds(days, dm)
    compression(dm, days, use)
    t = load_touches(path)
    struct = t[t["family"].isin(["PDH", "PDL", "ONH", "ONL", "OR15H", "OR15L",
                                 "OR30H", "OR30L", "PWH", "PWL", "SW15H", "SW15L",
                                 "SW60H", "SW60L", "PDC", "OPEN"])]
    springs_shallow(struct)
    springs_deep(struct, dm, days.index)
    double_test(t)


if __name__ == "__main__":
    main()
