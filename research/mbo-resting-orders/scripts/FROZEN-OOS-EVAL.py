#!/usr/bin/env python3
"""
FROZEN out-of-sample evaluation — pre-registered 2026-08-22, BEFORE any OOS data existed.

    DO NOT CHANGE ANY CONSTANT BELOW.

The in-sample result (PF 1.19, +$43,357 / 27 days) rests on a POST-HOC band selection with
3 of 27 days carrying 66% of the profit. The single largest risk to this finding is
re-tuning after seeing a soft OOS number. That is why these parameters are frozen in the
repo ahead of time. If the verdict is FAIL, the honest response is to drop the strategy,
not to widen the band, shift the bracket, or re-pick the latency.

Usage:
    python3 FROZEN-OOS-EVAL.py <dir-of-new-mbo-csvs> [front_month_symbol]

Streams one day at a time: parse -> extract -> discard. Peak disk ~one raw file.
"""
import sys, os, glob, collections, datetime as dt
import numpy as np

# ======================= FROZEN PARAMETERS — DO NOT EDIT =======================
MIN_SIZE      = 10      # resting order size threshold
NEAR_MAX      = 5.0     # detection window: order within 5pt of last trade
BAND_LO       = 3.0     # the edge lives 3-5pt BEHIND the touch
BAND_HI       = 5.0
BRACKET       = 30.0    # symmetric +/-30 points
LATENCY_S     = 1.0     # conservative, non-colocated
SLIPPAGE_PT   = 0.25    # 1 tick, entry and stop
POINT_VALUE   = 20.0    # full NQ
COMMISSION    = 4.0     # round turn
MAX_HOLD_S    = 3600.0
# ---------------- VERDICT BANDS (revised 2026-08-22, BEFORE any OOS data existed) -------
# Original bar was binary PASS at PF>=1.10. A day-level bootstrap of the in-sample trades
# (20k synthetic 21-session months) showed that bar is miscalibrated:
#     P(PF < 1.10 | edge LIVE) = 17%   -> it discards a real edge 1 month in 6
#     P(net < 0   | edge LIVE) =  1%   -> a live edge almost never loses over a month
#     P(net < 0   | edge DEAD) = 84%   -> negative PnL is the MOST diagnostic outcome (84:1)
#     P(PF >= 1.10| edge DEAD) =  2%   -> clearing 1.10 is strong confirmation  (41:1)
# So: three bands, not two. Changed on a POWER CALCULATION, not on a result. No strategy
# constant above was touched. Do NOT loosen these again once the number is known.
CONFIRM_PF    = 1.10    # >= this AND net>0            -> CONFIRM   (41:1 for a live edge)
KILL_NET      = 0.0     # net < this                   -> KILL      (84:1 for a dead edge)
                        # net>0 but PF<1.10            -> AMBIGUOUS (buy the 2nd month)
PASS_BOTHSIDE = True    # long AND short both profitable — reported, informational
PASS_FLIPNEG  = True    # flipped direction must LOSE  — reported, informational
PASS_MAXDAY   = 0.40    # single-day concentration     — reported, informational
# ==============================================================================

_DC = {}
def _abs(t):
    """Absolute seconds. Never use a seconds-of-day wrap heuristic: mbp-1/mbo files
    can start ~22:55 UTC the PRIOR day, which silently shifts one series by 86400s."""
    d = t[:10]
    o = _DC.get(d)
    if o is None:
        o = dt.date.fromisoformat(d).toordinal(); _DC[d] = o
    return o * 86400.0 + int(t[11:13])*3600 + int(t[14:16])*60 + float(t[17:26])

def _cols(path):
    """Resolve column indices FROM THE HEADER. Never hardcode positions: a column-order
    change would otherwise parse silently and produce garbage."""
    with open(path) as f:
        h = f.readline().strip().split(',')
    need = ['ts_event','action','side','price','size','symbol']
    missing = [c for c in need if c not in h]
    if missing:
        raise SystemExit(f"{path}: missing column(s) {missing}. Header={h}\n"
                         f"Request MBO as CSV with pretty_px=True, pretty_ts=True, map_symbols=True.")
    return {c: h.index(c) for c in need}

def extract(path, front=None):
    """One MBO day -> (prices, times, detections). Front-month filtered (mandatory:
    deferred months trade hundreds of points away and destroy any barrier test)."""
    C = _cols(path); iS, iA, iD, iP, iZ, iY = (C['ts_event'], C['action'], C['side'],
                                               C['price'], C['size'], C['symbol'])
    w = max(C.values()) + 1
    sym = collections.Counter()
    with open(path) as f:
        f.readline()
        for i, line in enumerate(f):
            if i > 2_000_000: break
            p = line.split(',')
            if len(p) >= w: sym[p[iY].rstrip('\n')] += 1
    fm = front or sym.most_common(1)[0][0]
    tp, ts, det, last = [], [], [], None
    with open(path) as f:
        f.readline()
        for line in f:
            p = line.split(',')
            if len(p) < w or p[iY].rstrip('\n') != fm: continue
            act = p[iA]
            if act == 'T':
                try: pr = float(p[iP])
                except: continue
                tp.append(pr); ts.append(_abs(p[iS])); last = pr
            elif act == 'A' and last is not None:
                try: sz = int(p[iZ]); pr = float(p[iP])
                except: continue
                if sz >= MIN_SIZE and abs(pr - last) <= NEAR_MAX:
                    det.append((_abs(p[iS]), last, pr, 1 if p[iD]=='B' else -1, len(tp)-1))
    return np.array(tp), np.array(ts), det, fm

def run(days, flip=False):
    trades = []
    for px, ts, det, day in days:
        free = -1.0
        for dts, spot, opx, dirn, idx in det:
            dd = abs(opx - spot)
            if dts < free or dd < BAND_LO or dd > BAND_HI: continue
            d = -dirn if flip else dirn
            i = np.searchsorted(ts, dts + LATENCY_S)
            if i >= len(px) or i == 0: continue
            ep  = px[i] + d*SLIPPAGE_PT
            tgt = ep + d*BRACKET
            stp = ep - d*BRACKET
            e = np.searchsorted(ts, ts[i] + MAX_HOLD_S)
            seg = px[i+1:e]
            if len(seg) == 0: continue
            if d > 0: ht = np.flatnonzero(seg >= tgt); hs = np.flatnonzero(seg <= stp)
            else:     ht = np.flatnonzero(seg <= tgt); hs = np.flatnonzero(seg >= stp)
            it  = ht[0] if len(ht) else 10**9
            isx = hs[0] if len(hs) else 10**9
            if   it < isx:  xp = tgt;                    xi = it     # limit: exact fill
            elif isx < it:  xp = seg[isx] - d*SLIPPAGE_PT; xi = isx  # stop: slips, gap-honest
            else:           xp = seg[-1]  - d*SLIPPAGE_PT; xi = len(seg)-1
            trades.append((d*(xp-ep)*POINT_VALUE - COMMISSION, d, day))
            free = ts[i+1+xi]
    return trades

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    files = sorted(glob.glob(os.path.join(sys.argv[1], '*.mbo.csv')))
    front = sys.argv[2] if len(sys.argv) > 2 else None
    if not files:
        print(f"no *.mbo.csv in {sys.argv[1]}"); sys.exit(1)
    print(f"FROZEN OOS EVAL — {len(files)} days\n"
          f"size>={MIN_SIZE}, band {BAND_LO}-{BAND_HI}pt, +/-{BRACKET:.0f} bracket, "
          f"lat={LATENCY_S}s, slip={SLIPPAGE_PT}pt\n")
    days = []
    for f in files:
        px, ts, det, fm = extract(f, front)
        d = os.path.basename(f)[10:18]
        days.append((px, ts, det, d))
        print(f"  {d} front={fm} trades={len(px):,} detections={len(det):,}")
    tr = run(days); fl = run(days, flip=True)
    if len(tr) < 50:
        print(f"\nINSUFFICIENT DATA: {len(tr)} trades. Need >=50. Pull more days."); sys.exit(2)
    a  = np.array([t[0] for t in tr]); dd_ = np.array([t[1] for t in tr])
    af = np.array([t[0] for t in fl])
    w, l = a[a > 0], a[a <= 0]
    pf   = w.sum()/abs(l.sum()) if len(l) and l.sum() != 0 else 9.99
    eq   = np.cumsum(a); mdd = (np.maximum.accumulate(eq) - eq).max()
    byday = collections.defaultdict(float)
    for t in tr: byday[t[2]] += t[0]
    v = np.array(list(byday.values()))
    topshare = v.max()/a.sum() if a.sum() > 0 else float('nan')
    lnet, snet = a[dd_ > 0].sum(), a[dd_ < 0].sum()
    print(f"\n{'='*62}\nRESULTS\n{'='*62}")
    print(f"  trades      {len(a)}   WR {100*len(w)/len(a):.1f}%")
    print(f"  PF          {pf:.2f}        (CONFIRM >= {CONFIRM_PF})")
    print(f"  net         ${a.sum():+,.0f}      maxDD ${mdd:,.0f}   (KILL if net < ${KILL_NET:,.0f})")
    print(f"  long/short  ${lnet:+,.0f} / ${snet:+,.0f}   ({(dd_>0).sum()}L/{(dd_<0).sum()}S)")
    print(f"  flipped     ${af.sum():+,.0f}     (must be negative)")
    print(f"  best day    {("n/a (net<=0)" if topshare!=topshare else f"{100*topshare:.0f}% of net")}   (flag if >{100*PASS_MAXDAY:.0f}%)")
    print(f"  days +ve    {(v>0).sum()}/{len(v)}")
    for n, ok in [("both sides +ve", lnet > 0 and snet > 0),
                  ("flip loses",     af.sum() < 0),
                  ("not 1-day",      (topshare <= PASS_MAXDAY) if topshare==topshare else True)]:
        print(f"  [{'ok ' if ok else 'no '}] {n}   (informational)")
    net = a.sum()
    if net < KILL_NET:
        band, code = "KILL", 1
        msg = ("Negative over a full month. A live edge does this 1% of the time, a dead one 84%.\n"
               "  That is 84:1 against. Drop it — do NOT buy another month hoping for a better draw.")
    elif pf >= CONFIRM_PF:
        band, code = "CONFIRM", 0
        msg = ("Clears 1.10 with positive net. A dead edge does this 2% of the time — 41:1 for real.\n"
               "  Worth costing out live MBO (Rithmic ~$165/mo, month-to-month).")
    else:
        band, code = "AMBIGUOUS", 2
        msg = ("Profitable but under 1.10. Consistent with a live edge having an off month\n"
               "  (17% of live months land here) AND with a marginal one. One month cannot separate\n"
               "  these — buy the 2nd month (Oct 2021 NQZ1, ~$19.70) before deciding either way.")
    print(f"\n{'='*62}\n  VERDICT: {band}\n  {msg}\n{'='*62}")
    sys.exit(code)

if __name__ == '__main__':
    main()
