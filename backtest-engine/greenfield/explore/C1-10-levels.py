#!/usr/bin/env python3
"""C1-10: build the price-structure levels registry.

One row per (level, trading day it is active). Columns:
  level_id, family, td, price, act_from, act_to, born_td, born_tmin,
  born_gidx, src, dynamic
Dynamic families (session VWAP, running POC) get one row per day with
price=NaN; the census computes their series causally.

Level definitions (all ET, tmin = minutes since 18:00 prior evening):
  PDH/PDL/PDC/PDM  prior td RTH high/low/close/mid; active whole td.
  PDVWAP           prior td final RTH VWAP (sum v*tp / sum v, tp=(h+l+c)/3).
  PDPOC/PDHVN      prior full-td volume-at-price POC + up to 2 HVN peaks
                   (5pt bins, peaks >= 25pts apart); active whole td.
  PWH/PWL          prior ISO-week high/low (full sessions); active whole td.
  ONH/ONL          current td overnight (18:00-09:30) high/low; RTH only.
  OPEN             RTH open price (09:30 bar open); active 09:32-16:00.
  OR5/15/30 H/L    opening range extremes; active after range completes +60s.
  SW{5,15,60}{H,L} fractal swings on 5m/15m/60m aggregated bars,
                   N=3/3/2 bars each side; confirmed N bars after the swing
                   bar CLOSES (+60s) — the fractal lookahead trap is handled
                   here; dies on 1m close >15pts beyond or after 3 tds or at
                   any symbol change.
  MT               multi-touch: 2pt price bin visited twice intraday with a
                   >=25pt excursion between visits; born at 2nd visit +60s;
                   dies at td end.
  VWAP (dynamic)   RTH session VWAP, 2-bar lag; active 09:40-16:00.
  RPOC (dynamic)   running full-td POC, 2-bar lag; active from tmin 120.

Cross-day levels require the same contract symbol on both sides; roll days
are excluded entirely.
"""
import sys, time
import numpy as np
import pandas as pd
import C1_common as C

P = C.P


def rth_vwap_final(d):
    m = (d["tmin"] >= C.RTH_O) & (d["tmin"] < C.RTH_C)
    if m.sum() < 300:
        return np.nan
    tp = (d["h"][m] + d["l"][m] + d["c"][m]) / 3.0
    v = d["v"][m]
    return float(np.sum(tp * v) / max(np.sum(v), 1.0))


def mt_levels(d):
    """Multi-touch birth events for one day: [(tmin_birth, price)]."""
    lo_all, hi_all = d["l"].min(), d["h"].max()
    binw = P["mt_bin"]
    centers = np.arange(np.floor((lo_all - 4) / binw), np.ceil((hi_all + 4) / binw) + 1) * binw
    nb = len(centers)
    armed = np.ones(nb, dtype=bool)
    count = np.zeros(nb, dtype=np.int32)
    born = []
    tol = P["mt_tol"]
    arm = P["arm"]
    H, L, T = d["h"], d["l"], d["tmin"]
    for i in range(len(H)):
        lo, hi = L[i], H[i]
        vis = (centers >= lo - tol) & (centers <= hi + tol)
        newv = vis & armed
        if newv.any():
            count[newv] += 1
            hit2 = newv & (count == 2)
            if hit2.any():
                for cprice in centers[hit2]:
                    if all(abs(cprice - bp) > 6.0 for _, bp in born):
                        born.append((int(T[i]), float(cprice)))
        far = (lo > centers + arm) | (hi < centers - arm)
        armed = (armed & ~vis) | far
    return born


def main():
    t0 = time.time()
    days = C.load_days()
    bars = C.load_bars(C.NQ_1M)
    dm = C.day_arrays(bars)
    all_tds = list(days.index)
    td_pos = {td: k for k, td in enumerate(all_tds)}
    use = C.usable_tds(days, dm)
    use_set = set(use)
    print(f"loaded {len(bars)} bars, {len(all_tds)} cache days, {len(use)} usable tds "
          f"({time.time()-t0:.0f}s)", flush=True)

    rows = []

    def add(level_id, fam, td, price, a0, a1, born_td, born_tmin, src, dyn=0):
        rows.append((level_id, fam, td, price, int(a0), int(a1), born_td,
                     int(born_tmin), td_pos[born_td] * C.TD_END + int(born_tmin), src, dyn))

    # per-week high/low (full session), symbol per day
    days["week"] = pd.to_datetime(days["td"]).dt.strftime("%G-W%V")
    wk = {}
    for w, g in days.groupby("week"):
        syms = set(g["sym_rth_last"].dropna())
        wk[w] = dict(hi=np.nanmax(np.maximum(g["on_high"], g["rth_high"])),
                     lo=np.nanmin(np.minimum(g["on_low"], g["rth_low"])),
                     syms=syms, last_td=g["td"].max())
    weeks_sorted = sorted(wk.keys())
    wk_prev = {w: weeks_sorted[i - 1] if i > 0 else None for i, w in enumerate(weeks_sorted)}

    alive_swings = []  # dicts: id, kind(H/L), price, born_td, born_tmin, sym, tf, days_alive

    prior_td = None
    for td in use:
        row = days.loc[td]
        d = dm[td]
        sym = d["sym"]
        prev = all_tds[td_pos[td] - 1] if td_pos[td] > 0 else None
        prev_ok = (prev is not None and prev in use_set and dm[prev]["sym"] == sym)

        # ---- prior-day family ----
        if prev_ok and bool(row.get("same_sym_prev_rth", False)):
            pr = days.loc[prev]
            pdh, pdl, pdc = pr["rth_high"], pr["rth_low"], pr["rth_close"]
            for fam, price in (("PDH", pdh), ("PDL", pdl), ("PDC", pdc),
                               ("PDM", (pdh + pdl) / 2.0)):
                if np.isfinite(price):
                    add(f"{fam}:{td}", fam, td, float(price), 0, C.TD_END, prev, 1320, "daycache")
            vw = rth_vwap_final(dm[prev])
            if np.isfinite(vw):
                add(f"PDVWAP:{td}", "PDVWAP", td, vw, 0, C.TD_END, prev, 1320, "calc")
            tp = (dm[prev]["h"] + dm[prev]["l"] + dm[prev]["c"]) / 3.0
            prof = C.vap_profile(tp, dm[prev]["v"], P["vap_bin"])
            for k, (fam, price) in enumerate(C.vap_nodes(prof, P["vap_sep"])):
                add(f"{fam}{k}:{td}", fam, td, price, 0, C.TD_END, prev, C.TD_END - 1, "vap")

        # ---- prior-week family ----
        w = row["week"]
        pw = wk_prev.get(w)
        if pw and wk[pw]["syms"] == {sym}:
            add(f"PWH:{td}", "PWH", td, float(wk[pw]["hi"]), 0, C.TD_END, wk[pw]["last_td"], 1320, "week")
            add(f"PWL:{td}", "PWL", td, float(wk[pw]["lo"]), 0, C.TD_END, wk[pw]["last_td"], 1320, "week")

        # ---- overnight + open + opening ranges (same td) ----
        if np.isfinite(row["on_high"]):
            add(f"ONH:{td}", "ONH", td, float(row["on_high"]), C.RTH_O + 2, C.RTH_C, td, C.RTH_O, "daycache")
            add(f"ONL:{td}", "ONL", td, float(row["on_low"]), C.RTH_O + 2, C.RTH_C, td, C.RTH_O, "daycache")
        if np.isfinite(row["rth_open"]):
            add(f"OPEN:{td}", "OPEN", td, float(row["rth_open"]), C.RTH_O + 2, C.RTH_C, td, C.RTH_O, "daycache")
        T, Hh, Ll = d["tmin"], d["h"], d["l"]
        for orlen in (5, 15, 30):
            m = (T >= C.RTH_O) & (T < C.RTH_O + orlen)
            if m.sum() >= max(3, orlen // 2):
                a0 = C.RTH_O + orlen + 1
                add(f"OR{orlen}H:{td}", f"OR{orlen}H", td, float(Hh[m].max()), a0, C.RTH_C,
                    td, C.RTH_O + orlen - 1, "or")
                add(f"OR{orlen}L:{td}", f"OR{orlen}L", td, float(Ll[m].min()), a0, C.RTH_C,
                    td, C.RTH_O + orlen - 1, "or")

        # ---- swings: age/kill existing, then register alive-for-today ----
        still = []
        for s in alive_swings:
            if s["sym"] != sym or s["days_alive"] >= P["swing_life_td"]:
                continue
            # kill scan on today's 1m closes
            if s["kind"] == "H":
                beyond = d["c"] > s["price"] + P["swing_kill"]
            else:
                beyond = d["c"] < s["price"] - P["swing_kill"]
            a1 = int(T[np.argmax(beyond)]) if beyond.any() else C.TD_END
            add(s["id"], s["fam"], td, s["price"], 0, a1, s["born_td"], s["born_tmin"], s["src"])
            if not beyond.any():
                s["days_alive"] += 1
                still.append(s)
        alive_swings = still

        # ---- new swings born today ----
        for tf, N in ((5, 3), (15, 3), (60, 2)):
            bt, bo, bh, bl, bc, bv = C.agg_bars(T, d["o"], Hh, Ll, d["c"], d["v"], tf)
            for j, kind, price, jc in C.fractal_swings(bh, bl, N):
                conf_t = int(bt[jc]) + tf + 1
                if conf_t >= C.TD_END:
                    continue
                fam = f"SW{tf}{kind}"
                sid = f"{fam}:{td}:{int(bt[j])}:{price:.2f}"
                # today's row: active from confirmation; kill scan from conf on
                if kind == "H":
                    beyond = (d["c"] > price + P["swing_kill"]) & (T >= conf_t)
                else:
                    beyond = (d["c"] < price - P["swing_kill"]) & (T >= conf_t)
                a1 = int(T[np.argmax(beyond)]) if beyond.any() else C.TD_END
                add(sid, fam, td, float(price), conf_t, a1, td, conf_t - 1, str(tf))
                if not beyond.any():
                    alive_swings.append(dict(id=sid, fam=fam, kind=kind, price=float(price),
                                             born_td=td, born_tmin=conf_t - 1, sym=sym,
                                             days_alive=1, src=str(tf)))

        # ---- multi-touch (same day only) ----
        for btm, price in mt_levels(d):
            if btm + 2 >= C.TD_END - 10:
                continue
            add(f"MT:{td}:{btm}:{price:.1f}", "MT", td, price, btm + 2, C.TD_END, td, btm, "mt")

        # ---- dynamic rows ----
        add(f"VWAP:{td}", "VWAP", td, np.nan, C.RTH_O + 10, C.RTH_C, td, C.RTH_O, "dyn", dyn=1)
        add(f"RPOC:{td}", "RPOC", td, np.nan, 120, C.TD_END, td, 0, "dyn", dyn=1)

        prior_td = td

    reg = pd.DataFrame(rows, columns=["level_id", "family", "td", "price", "act_from",
                                      "act_to", "born_td", "born_tmin", "born_gidx",
                                      "src", "dynamic"])
    out = f"{C.HERE}/C1-levels-registry.csv"
    reg.to_csv(out, index=False)
    print(f"registry: {len(reg)} rows -> {out} ({time.time()-t0:.0f}s)")
    print(reg.groupby("family").size().sort_values(ascending=False))


if __name__ == "__main__":
    main()
