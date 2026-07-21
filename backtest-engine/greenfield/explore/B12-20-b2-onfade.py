#!/usr/bin/env python3
"""
B2 — compressed-overnight fade-the-first-break, 1s-honest.

Universe: days whose ON range (18:00 prev -> 09:29 ET, single symbol, matching RTH
symbol) is <= the 33.3rd percentile of the PRIOR 250 days' ON ranges (trailing-only,
knowable at 09:30). Full RTH, no roll, atr14_prior known.

Signal: FIRST breach after 09:30:00 of an ON extreme by B pts (B in {3,8,15}),
observed at breach-bar close (ts+1). One trade max per day. Fade it.
Entries: lim   = limit AT the ON extreme (short at on_high after up-break / buy at
                 on_low after down-break), placed at breach+1s; conservative fill at
                 the limit exactly (worse than market when marketable). Cancel 60m
                 after breach.
         cls1m = first ET 1m bar (>= breach bar's minute) whose CLOSE is back inside
                 the ON range; market entry at the next 1s bar open +/-0.25 adverse.
                 Cancel if no such close within 60m of breach. No entries after 15:15.
Stop: adverse post-breach extreme (breach bar .. entry bar inclusive) + buffer;
      buffer b5 = 5pt fixed, bv = 0.05*atr14_prior (vol-scaled).
Targets (limit, exact): opp = opposite ON extreme, mid = ON midpoint,
      r1/r2 = entry +/- {1,2} x (entry-to-stop risk).
Max hold H minutes from entry (main grid H=120; {60,180} swept on the best configs),
hard flat 15:45 ET. Same-1s-bar stop+target = STOP; target ineligible on entry bar.

Overlay (tested LAST, on best config only): fade only when the breach occurs at/after
10:30 ET and the first-hour direction (09:30 open -> 10:30-close of the 10:29 bar)
points WITH the break (so the fade is against the first-hour direction). Knowable at
entry. Reported with/without.

DEV PERIOD ONLY: 2021-01-01..2024-12-31 unless --validate.
"""
import sys
import numpy as np
import pandas as pd
from B12_sim import (load_1s, load_days, et_epoch, first_idx, fill_limit,
                     walk_exit, metrics, fmt_row, SLIP_MKT, POINT, COMM_RT)

VALIDATE = "--validate" in sys.argv
HOLD_SWEEP = "--holdsweep" in sys.argv
OVERLAY = "--overlay" in sys.argv

(ts, o, h, l, c), dayidx = load_1s()
days = load_days()
P0, P1 = ("2025-01-01", "2026-06-30") if VALIDATE else ("2021-01-01", "2024-12-31")
days = days[(days.trade_date >= P0) & (days.trade_date <= P1)].copy()
uni = days[days.on_compressed & days.full_rth & ~days.roll_in_day
           & days.rth_same_sym & days.atr14_prior.notna()].copy()
period_days = days[days.full_rth].trade_date
print(f"universe days: {len(uni)}", flush=True)

BS = [3, 8, 15]
ENTRIES = ["lim", "cls1m"]
STOPS = ["b5", "bv"]
TARGETS = ["opp", "mid", "r1", "r2"]
HOLDS = [120]
if HOLD_SWEEP:
    # hold sweep on the dev-best config families only (declared in findings doc)
    BS, ENTRIES, STOPS, TARGETS, HOLDS = [8], ["cls1m"], ["b5", "bv"], ["mid"], [60, 180]
if VALIDATE:
    # B2 DIED IN DEV (all 48 grid configs PF<=0.81, overlay/hold sweeps no help).
    # This locked run is a FORMALITY on the least-bad dev config (B3|cls1m|bv|r2,
    # PF 0.809); the dev verdict (DEAD) stands regardless of its outcome.
    BS, ENTRIES, STOPS, TARGETS, HOLDS = [3], ["cls1m"], ["bv"], ["r2"], [120]

def run(sel_overlay=False):
    rows = []
    for B in BS:
        # ---- per-day break detection for this B (config-independent otherwise) ----
        prep = []
        for _, d in uni.iterrows():
            key = d.trade_date.strftime("%Y-%m-%d")
            if key not in dayidx:
                continue
            a, b = dayidx[key]
            tsd, od, hd, ld, cd = ts[a:b], o[a:b], h[a:b], l[a:b], c[a:b]
            t930 = et_epoch(d.trade_date, 9, 30)
            j0 = first_idx(tsd >= t930)
            if j0 < 0:
                continue
            up = hd[j0:] >= d.on_high + B
            dn = ld[j0:] <= d.on_low - B
            iu = j0 + int(np.argmax(up)) if up.any() else -1
            idn = j0 + int(np.argmax(dn)) if dn.any() else -1
            if iu < 0 and idn < 0:
                continue
            if iu >= 0 and idn >= 0 and iu == idn:
                continue  # both extremes breached in same 1s bar: ambiguous, skip
            if idn < 0 or (0 <= iu < idn):
                brk, side, ext = iu, -1, d.on_high
            else:
                brk, side, ext = idn, 1, d.on_low
            prep.append(dict(d=d, tsd=tsd, od=od, hd=hd, ld=ld, cd=cd, t930=t930,
                             brk=brk, side=side, ext=ext, j0=j0))
        for ent in ENTRIES:
            for stp in STOPS:
                for tgt_kind in TARGETS:
                    for H in HOLDS:
                        label = f"B{B}|{ent}|{stp}|{tgt_kind}|H{H}" + \
                                ("|OVL" if sel_overlay else "")
                        recs = []
                        for p in prep:
                            d, side, ext = p["d"], p["side"], p["ext"]
                            tsd, od, hd, ld, cd = (p[k] for k in
                                                   ("tsd", "od", "hd", "ld", "cd"))
                            brk = p["brk"]
                            brk_ts = tsd[brk]
                            td = d.trade_date
                            t1030 = et_epoch(td, 10, 30)
                            if sel_overlay:
                                if brk_ts < t1030:
                                    continue
                                # first-hour direction: 09:30 open -> last close < 10:30
                                fh = first_idx(tsd >= t1030) - 1
                                if fh < p["j0"]:
                                    continue
                                fh_dir = np.sign(cd[fh] - od[p["j0"]])
                                # fade must be AGAINST first-hour direction:
                                # up-break (side=-1) needs fh_dir>0; down needs <0
                                if fh_dir == 0 or (fh_dir > 0) != (side < 0):
                                    continue
                            p_idx = first_idx(tsd >= brk_ts + 1, brk)
                            if p_idx < 0:
                                continue
                            cancel_ts = min(brk_ts + 3600, et_epoch(td, 15, 15))
                            cend = first_idx(tsd >= cancel_ts, p_idx)
                            cend = cend if cend >= 0 else len(tsd)
                            e_idx = -1
                            e_slip = 0.0
                            if ent == "lim":
                                e_idx = fill_limit(tsd, hd, ld, side, ext, p_idx, cend)
                                entry_px = ext
                            else:
                                # first ET minute close back inside the ON range
                                m0 = (brk_ts // 60) * 60
                                e_idx = -1
                                m = m0
                                while m < cancel_ts:
                                    sel = (tsd >= m) & (tsd < m + 60)
                                    if sel.any():
                                        mclose = cd[np.nonzero(sel)[0][-1]]
                                        inside = mclose < ext if side < 0 else mclose > ext
                                        if inside and m + 60 > brk_ts:
                                            e_idx = first_idx(tsd >= m + 60)
                                            break
                                    m += 60
                                if e_idx >= 0 and tsd[e_idx] >= cancel_ts:
                                    e_idx = -1
                                if e_idx >= 0:
                                    entry_px = od[e_idx] + side * SLIP_MKT
                                    e_slip = SLIP_MKT
                            if e_idx < 0:
                                continue
                            pbx = hd[brk:e_idx + 1].max() if side < 0 \
                                else ld[brk:e_idx + 1].min()
                            buf = 5.0 if stp == "b5" else 0.05 * d.atr14_prior
                            stop = pbx + buf if side < 0 else pbx - buf
                            risk = abs(stop - entry_px)
                            if risk < 1:
                                continue
                            if tgt_kind == "opp":
                                target = d.on_low if side < 0 else d.on_high
                            elif tgt_kind == "mid":
                                target = (d.on_high + d.on_low) / 2
                            elif tgt_kind == "r1":
                                target = entry_px + side * risk
                            else:
                                target = entry_px + side * 2 * risk
                            # target must be on the profitable side of entry
                            if side * (target - entry_px) <= 0:
                                continue
                            flat_ts = min(tsd[e_idx] + H * 60, et_epoch(td, 15, 45))
                            x_idx, x_px, reason = walk_exit(tsd, od, hd, ld, side,
                                                            e_idx, entry_px, stop,
                                                            target, flat_ts)
                            x_slip = 0.5 if reason == "stop" else \
                                (0.25 if reason in ("time", "eod") else 0.0)
                            pnl = side * (x_px - entry_px) * POINT - COMM_RT
                            recs.append(dict(trade_date=td, pnl=pnl,
                                             hold_s=tsd[x_idx] - tsd[e_idx],
                                             reason=reason,
                                             slip_pts=e_slip + x_slip))
                        tr = pd.DataFrame(recs)
                        m = metrics(tr, period_days, label)
                        if len(tr):
                            m["pnl_2xslip"] = round((tr.pnl - tr.slip_pts * POINT).sum())
                            w2 = tr.pnl - tr.slip_pts * POINT
                            m["pf_2xslip"] = round(
                                w2[w2 > 0].sum() / max(1e-9, -w2[w2 <= 0].sum()), 3)
                            m["stop%"] = round((tr.reason == "stop").mean() * 100, 1)
                            m["tgt%"] = round((tr.reason == "target").mean() * 100, 1)
                        rows.append(m)
                        print(fmt_row(m), flush=True)
    return rows

rows = run(sel_overlay=OVERLAY)
suffix = "validate" if VALIDATE else ("holdsweep" if HOLD_SWEEP else
                                      ("overlay" if OVERLAY else "dev"))
pd.DataFrame(rows).to_csv(f"B12-20-b2-configs-{suffix}.csv", index=False)
print(f"\nwrote B12-20-b2-configs-{suffix}.csv ({len(rows)} configs)")
