#!/usr/bin/env python3
"""C1-50: ES generalization pass for the C1 level census.

Reduced family set (PDH/PDL/PDC/PDM, ONH/ONL, OPEN, OR15H/L, same-day SW15,
session VWAP) with all point thresholds rescaled by the ES/NQ daily-ATR ratio.
Same machinery: arm >= 25*s away, touch within 5*s, race = retrace 15*s vs
break 5*s within 60m. Real vs random-offset placebo (x3 seeds) + round-50 grid.
"""
import time
import numpy as np
import pandas as pd
import C1_common as C

pd.set_option("display.width", 200)


def es_days(dm, tds):
    rows = []
    prev_close = np.nan
    atr_hist = []
    for td in tds:
        d = dm[td]
        T = d["tmin"]
        on = T < C.RTH_O
        rth = (T >= C.RTH_O) & (T < C.RTH_C)
        hi, lo, cl = d["h"].max(), d["l"].min(), d["c"][-1]
        tr = hi - lo if not np.isfinite(prev_close) else max(hi, prev_close) - min(lo, prev_close)
        atr14 = np.mean(atr_hist[-14:]) if len(atr_hist) >= 14 else np.nan
        rows.append(dict(td=td, sym=d["sym"], n_on=on.sum(), n_rth=rth.sum(),
                         on_high=d["h"][on].max() if on.any() else np.nan,
                         on_low=d["l"][on].min() if on.any() else np.nan,
                         rth_open=d["o"][rth][0] if rth.any() else np.nan,
                         rth_high=d["h"][rth].max() if rth.any() else np.nan,
                         rth_low=d["l"][rth].min() if rth.any() else np.nan,
                         rth_close=d["c"][rth][-1] if rth.any() else np.nan,
                         atr14_prior=atr14))
        atr_hist.append(tr)
        prev_close = cl
    return pd.DataFrame(rows).set_index("td", drop=False)


def main():
    t0 = time.time()
    nqd = C.load_days()
    s = None
    bars = C.load_bars(C.ES_1M)
    dm = C.day_arrays(bars)
    tds_all = sorted(dm.keys())
    ed = es_days(dm, tds_all)
    es_atr = ed["atr14_prior"].median()
    nq_atr = nqd["atr14_prior"].median()
    s = es_atr / nq_atr
    print(f"ES median ATR14 {es_atr:.1f} vs NQ {nq_atr:.1f} -> scale {s:.3f}")
    P = C.P
    P.update(arm=25 * s, tols=(5 * s,), tol_main=5 * s, brk=5 * s,
             race_r=(15 * s, 35 * s), swing_kill=15 * s,
             rand_lo=30 * s, rand_hi=120 * s, round_grid=50.0, reenter=2 * s)

    use = [td for td in tds_all
           if dm[td]["nsym"] == 1 and ed.loc[td, "n_rth"] >= 370 and ed.loc[td, "n_on"] >= 700
           and np.isfinite(ed.loc[td, "atr14_prior"])]
    print(f"{len(use)} usable ES tds")

    rows = []
    all_pos = {td: k for k, td in enumerate(tds_all)}
    counters = {}
    for td in use:
        d = dm[td]
        T, h, l, c = d["tmin"], d["h"], d["l"], d["c"]
        n = len(T)
        atr1 = C.atr1m_series(h, l, c)
        atr14d = float(ed.loc[td, "atr14_prior"])
        k = all_pos[td]
        prev = tds_all[k - 1] if k > 0 else None
        prev_ok = prev in dm and dm[prev]["nsym"] == 1 and dm[prev]["sym"] == d["sym"] \
            and np.isfinite(ed.loc[prev, "rth_high"]) if prev else False
        chans = []
        real_static = []

        def addch(key, fam, price, a0, a1):
            chans.append((key, fam, "real", 0, float(price), a0, a1))
            real_static.append((float(price), a0, a1, fam, key))
            for sd in range(1, 4):
                chans.append((key, fam, "rand", sd, float(price) + C.rand_offset(key, sd),
                              a0, a1))

        if prev_ok:
            pr = ed.loc[prev]
            pdh, pdl = pr["rth_high"], pr["rth_low"]
            for fam, price in (("PDH", pdh), ("PDL", pdl), ("PDC", pr["rth_close"]),
                               ("PDM", (pdh + pdl) / 2)):
                addch(f"{fam}:{td}", fam, price, 0, C.TD_END)
        row = ed.loc[td]
        if np.isfinite(row["on_high"]):
            addch(f"ONH:{td}", "ONH", row["on_high"], C.RTH_O + 2, C.RTH_C)
            addch(f"ONL:{td}", "ONL", row["on_low"], C.RTH_O + 2, C.RTH_C)
        addch(f"OPEN:{td}", "OPEN", row["rth_open"], C.RTH_O + 2, C.RTH_C)
        m15 = (T >= C.RTH_O) & (T < C.RTH_O + 15)
        if m15.sum() >= 8:
            addch(f"OR15H:{td}", "OR15H", h[m15].max(), C.RTH_O + 16, C.RTH_C)
            addch(f"OR15L:{td}", "OR15L", l[m15].min(), C.RTH_O + 16, C.RTH_C)
        bt, bo, bh, bl, bc, bv = C.agg_bars(T, d["o"], h, l, c, d["v"], 15)
        for j, kind, price, jc in C.fractal_swings(bh, bl, 3):
            conf_t = int(bt[jc]) + 16
            if conf_t >= C.TD_END - 30:
                continue
            addch(f"SW15{kind}:{td}:{int(bt[j])}", f"SW15{kind}", price, conf_t, C.TD_END)
        # VWAP dynamic
        tp = (h + l + c) / 3.0
        mR = (T >= C.RTH_O) & (T < C.RTH_C)
        cv = np.cumsum(np.where(mR, d["v"], 0.0))
        cpv = np.cumsum(np.where(mR, tp * d["v"], 0.0))
        S = np.full(n, np.nan)
        ok = (T >= C.RTH_O + 8) & (np.concatenate(([0, 0], cv[:-2])) > 0)
        idx = np.flatnonzero(ok)
        S[idx] = cpv[idx - 2] / cv[idx - 2]
        i0v, i1v = int(np.searchsorted(T, C.RTH_O + 10)), int(np.searchsorted(T, C.RTH_C))
        chans.append((f"VWAP:{td}", "VWAP", "real", 0, S, i0v, i1v))
        for sd in range(1, 4):
            chans.append((f"VWAP:{td}", "VWAP", "rand", sd, S + C.rand_offset(f"VWAP:{td}", sd),
                          i0v, i1v))
        gw = P["round_grid"]
        for gp in np.arange(np.floor((l.min() - 30 * s) / gw) * gw,
                            np.ceil((h.max() + 30 * s) / gw) * gw + 1, gw):
            chans.append((f"RN:{td}:{gp}", "ROUND", "round", 0, float(gp), 0, n))

        cf_p = np.array([x[0] for x in real_static])
        cf_a0 = np.array([x[1] for x in real_static])
        cf_a1 = np.array([x[2] for x in real_static])
        cf_id = np.array([x[4] for x in real_static])
        for key, fam, kind, seed, L, a0, a1 in chans:
            i0 = int(np.searchsorted(T, a0)) if not isinstance(L, np.ndarray) or True else a0
            i1 = int(np.searchsorted(T, a1))
            if isinstance(L, np.ndarray) and fam == "VWAP":
                i0, i1 = a0, a1  # already bar indices
            for tol in P["tols"]:
                for (i, side) in C.touch_events(h, l, L, i0, i1, tol, P["arm"]):
                    ck = (key, seed, tol)
                    counters[ck] = counters.get(ck, 0) + 1
                    Lv = float(L[i]) if isinstance(L, np.ndarray) else L
                    o = C.outcomes(h, l, c, i, n, Lv, side)
                    tmin_i = int(T[i])
                    arr5 = np.nan
                    if i >= 5 and np.isfinite(atr1[i]) and atr1[i] > 0.05 * s:
                        raw5 = (h[i] - c[i - 5]) if side == "b" else (c[i - 5] - l[i])
                        arr5 = raw5 / atr1[i]
                    near = np.nan
                    if len(cf_p):
                        act = (cf_a0 <= tmin_i) & (tmin_i < cf_a1) & (cf_id != key)
                        if act.any():
                            near = float(np.min(np.abs(cf_p[act] - Lv)))
                    rows.append(dict(td=td, year=td[:4], kind=kind, seed=seed, family=fam,
                                     tmin=tmin_i, side=side, touch_idx=counters[ck],
                                     arr5=arr5, near_real=near, t_brk=o["t_brk"],
                                     t_r15=o["t_r15"], t_r35=o["t_r35"],
                                     pen60=o["pen60"], ret60=o["ret60"],
                                     valid_min=o["valid_min"]))
    t = pd.DataFrame(rows)
    t.to_csv(f"{C.HERE}/C1-es-touches.csv.gz", index=False)
    print(f"{len(t)} ES touches ({time.time()-t0:.0f}s)")

    # ---- analysis ----
    CLASS = dict(PDH="PriorDay", PDL="PriorDay", PDC="PriorDay", PDM="PriorDay",
                 ONH="Overnight", ONL="Overnight", OPEN="Opening", OR15H="Opening",
                 OR15L="Opening", SW15H="Swing", SW15L="Swing", VWAP="DynVWAP",
                 ROUND="ROUND")
    t["cls"] = t["family"].map(CLASS)
    tb = t["t_brk"].where(t["t_brk"] > 0, 10 ** 9)
    tr = t["t_r15"].where(t["t_r15"] > 0, 10 ** 9)
    t["bounce1st"] = (tr <= 60) & (tr < tb)
    t["break1st"] = (tb <= 60) & (tb < tr)
    t["resolved"] = t["bounce1st"] | t["break1st"]
    t["clean"] = np.where(t["kind"] == "real", True, ~(t["near_real"] <= 5 * s))
    t = t[t["valid_min"] >= 60]

    def race(g):
        r = g[g["resolved"]]
        return (r["bounce1st"].mean() if len(r) else np.nan), len(r)

    print("\nES: class real vs rand (race15-equiv):")
    for cls, g in t.groupby("cls"):
        rr, nr = race(g[g["kind"] == "real"])
        rp, npp = race(g[(g["kind"] == "rand") & g["clean"]])
        if nr < 60 or npp < 60:
            continue
        print(f"  {cls:10s} real {rr:.3f} (n={nr})  rand {rp:.3f} (n={npp})  d={rr-rp:+.3f}")
    print("\nES yearly delta (all real families pooled vs rand):")
    for yr, g in t.groupby("year"):
        rr, nr = race(g[(g["kind"] == "real") & (g["family"] != "ROUND")])
        rp, npp = race(g[(g["kind"] == "rand") & g["clean"]])
        if nr < 100 or npp < 100:
            continue
        print(f"  {yr}: real {rr:.3f} (n={nr})  rand {rp:.3f} (n={npp})  d={rr-rp:+.3f}")
    mm = t[t["arr5"].notna()]
    qs = mm["arr5"].quantile([0.2, 0.4, 0.6, 0.8]).values
    print(f"\nES arr5 quintiles (edges {np.round(qs,2)}):")
    q = np.searchsorted(qs, mm["arr5"].values) + 1
    for qq in range(1, 6):
        g = mm[q == qq]
        rr, nr = race(g[(g["kind"] == "real") & (g["family"] != "ROUND")])
        rp, npp = race(g[(g["kind"] == "rand") & g["clean"]])
        if nr < 60 or npp < 60:
            continue
        print(f"  Q{qq}: real {rr:.3f} (n={nr})  rand {rp:.3f} (n={npp})  d={rr-rp:+.3f}")


if __name__ == "__main__":
    main()
