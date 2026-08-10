#!/usr/bin/env python3
"""
I8 — Monday-strength MFE/MAE anatomy + profit-protection overlay sims.

Drew (2026-08-10): small account — "I can't have a 100 point trade going
negative." Question 1: how often does that actually happen (give-back
anatomy)? Question 2: which protection overlay (breakeven / trailing /
fixed target / MFE ratchet) costs the least edge per unit of give-back
removed?

Method (house rules): 1s-honest from the fill instant. Paths from the
primary-contract RTH 1s cache (cache_nq_rth_1s.npz, 2021-01→2026-06).
Entry = first 1s bar at/after 09:30:01 ET Monday, fill = bar open + 0.5pt
slip. Hold to 15:45:00 ET (exit = last 1s close − 1.0pt slip) unless an
overlay exits earlier (stop-style exits pay 1.5pt slip; limit targets fill
at the limit, no slip). Commission $5/trade. Trade dates = the book's 249
Mondays. Overlays evaluated dev (≤2024) vs locked (2025+) to keep the
recommendation honest. All $ = 1 NQ contract ($20/pt); divide by 10 for MNQ.
"""
import csv
import os
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ET = ZoneInfo('America/New_York')
PV = 20.0
COMM = 5.0
ENTRY_SLIP = 0.5
MKT_SLIP = 1.0
STOP_SLIP = 1.5

z = np.load(os.path.join(HERE, 'cache_nq_rth_1s.npz'))
TS, H, L, C, O = z['ts'], z['h'], z['l'], z['c'], z['o']

dates = []
with open(os.path.join(HERE, 'book-monday-daily.csv')) as f:
    for r in csv.DictReader(f):
        dates.append((r['date'], float(r['pnl'])))

def epoch(date, hh, mm, ss=0):
    return int(datetime.fromisoformat(f'{date}T{hh:02d}:{mm:02d}:{ss:02d}').replace(tzinfo=ET).timestamp())

# ---- build per-trade paths ----
trades = []
for date, book_pnl in dates:
    t0 = epoch(date, 9, 30, 1)
    t1 = epoch(date, 15, 45, 0)
    i0 = np.searchsorted(TS, t0, 'left')
    i1 = np.searchsorted(TS, t1, 'left')
    if i1 - i0 < 1000:
        continue
    entry = O[i0] + ENTRY_SLIP
    h, l, c = H[i0:i1], L[i0:i1], C[i0:i1]
    cmax = np.maximum.accumulate(h)
    mfe_t = cmax - entry
    mfe = float(mfe_t[-1])
    mae = float(entry - l.min())
    final = float(c[-1] - MKT_SLIP - entry)
    t_mfe = int(np.argmax(h == cmax[-1]))
    trades.append(dict(date=date, entry=entry, mfe=mfe, mae=mae, final=final,
                       t_mfe_min=t_mfe / 60.0, book=book_pnl,
                       i0=i0, i1=i1))

print(f'=== I8: Monday MFE/MAE — {len(trades)} trades with 1s paths ===')
fin = np.array([t['final'] for t in trades])
book = np.array([t['book'] for t in trades])
sim_pnl = fin * PV - COMM
print(f'baseline sanity: sim net ${sim_pnl.sum():,.0f} vs book ${book.sum():,.0f} '
      f'(corr {np.corrcoef(sim_pnl, book)[0,1]:.3f})\n')

mfe = np.array([t['mfe'] for t in trades])
mae = np.array([t['mae'] for t in trades])
tm = np.array([t['t_mfe_min'] for t in trades])

q = lambda a, p: np.percentile(a, p)
print('---- excursion distributions (points, 1 NQ; MNQ $ = pts x $2) ----')
print(f'MFE : p25 {q(mfe,25):5.1f}  med {q(mfe,50):5.1f}  p75 {q(mfe,75):5.1f}  p90 {q(mfe,90):6.1f}')
print(f'MAE : p25 {q(mae,25):5.1f}  med {q(mae,50):5.1f}  p75 {q(mae,75):5.1f}  p90 {q(mae,90):6.1f}')
print(f'time of day-high: med {q(tm,50)/60+9.5:.1f}h ET, p25 {q(tm,25)/60+9.5:.1f}h, p75 {q(tm,75)/60+9.5:.1f}h')
gb = mfe - fin
print(f'give-back (MFE - final): med {q(gb,50):.1f}pt  p75 {q(gb,75):.1f}  p90 {q(gb,90):.1f}\n')

print('---- Drew\'s question: P(final <= 0 | MFE >= X) ----')
for X in [20, 40, 60, 80, 100, 150]:
    sel = mfe >= X
    if sel.sum() == 0:
        continue
    neg = (fin[sel] <= 0).mean()
    print(f'  MFE >= {X:>3}pt: n={sel.sum():>3}  went red by 15:45: {100*neg:4.1f}%'
          f'   (avg final on those days {fin[sel].mean():+6.1f}pt)')
print()

# ---- overlay sims (vectorized per trade) ----
def sim(overlay):
    """overlay(h, l, c, entry, cmax) -> (exit_price, exited_early) or None for hold"""
    out = []
    for t in trades:
        h, l, c = H[t['i0']:t['i1']], L[t['i0']:t['i1']], C[t['i0']:t['i1']]
        entry = t['entry']
        cmax = np.maximum.accumulate(h)
        r = overlay(h, l, c, entry, cmax)
        if r is None:
            px = c[-1] - MKT_SLIP
        else:
            px = r
        out.append(dict(date=t['date'], pnl=(px - entry) * PV - COMM))
    return out

def first_true(mask):
    idx = np.argmax(mask)
    return idx if mask[idx] else None

def ov_be(arm, off):
    def f(h, l, c, entry, cmax):
        ia = first_true(cmax - entry >= arm)
        if ia is None:
            return None
        stop = entry + off
        ih = first_true(l[ia:] <= stop)
        return None if ih is None else stop - STOP_SLIP
    return f

def ov_trail(arm, trail):
    def f(h, l, c, entry, cmax):
        armed = cmax - entry >= arm
        hit = armed & (l <= cmax - trail)
        ih = first_true(hit)
        return None if ih is None else (cmax[ih] - trail) - STOP_SLIP
    return f

def ov_tp(tp):
    def f(h, l, c, entry, cmax):
        ih = first_true(h >= entry + tp)
        return None if ih is None else entry + tp   # limit: no slip
    return f

def ov_ratchet(arm, k):
    def f(h, l, c, entry, cmax):
        stop = np.where(cmax - entry >= arm, entry + k * (cmax - entry), -np.inf)
        ih = first_true(l <= stop)
        return None if ih is None else stop[ih] - STOP_SLIP
    return f

def ov_tp_plus_be(tp, arm, off):
    def f(h, l, c, entry, cmax):
        it = first_true(h >= entry + tp)
        ia = first_true(cmax - entry >= arm)
        ib = None
        if ia is not None:
            ihit = first_true(l[ia:] <= entry + off)
            if ihit is not None:
                ib = ia + ihit
        if it is not None and (ib is None or it <= ib):
            return entry + tp
        if ib is not None:
            return entry + off - STOP_SLIP
        return None
    return f

CONFIGS = [('HOLD (base)', None)]
for arm, off in [(30, 0), (50, 0), (70, 5), (100, 5)]:
    CONFIGS.append((f'BE arm{arm}/+{off}', ov_be(arm, off)))
for arm, tr in [(50, 25), (80, 30), (100, 40)]:
    CONFIGS.append((f'TRAIL arm{arm}/t{tr}', ov_trail(arm, tr)))
for tp in [40, 60, 80, 100, 150]:
    CONFIGS.append((f'TP {tp}', ov_tp(tp)))
for arm, k in [(60, 0.5), (100, 0.5)]:
    CONFIGS.append((f'RATCHET arm{arm}/k{k}', ov_ratchet(arm, k)))
for tp, arm, off in [(100, 50, 0), (150, 70, 5)]:
    CONFIGS.append((f'TP{tp}+BE{arm}/+{off}', ov_tp_plus_be(tp, arm, off)))

def stats(rows):
    p = np.array([r['pnl'] for r in rows])
    w = p[p > 0].sum(); lo = -p[p <= 0].sum()
    eq = np.cumsum(p); dd = float((np.maximum.accumulate(eq) - eq).max())
    return dict(n=len(p), pnl=p.sum(), pf=(w/lo if lo > 0 else np.inf),
                wr=100*(p > 0).mean(), dd=dd, worst=p.min())

print('---- overlay sims ($ = 1 NQ; divide by 10 for MNQ) ----')
print(f'{"config":<20}{"PnL":>9}{"PF":>6}{"WR%":>6}{"maxDD":>9}{"worst":>8} | {"dev PnL":>9}{"dev PF":>7} | {"lock PnL":>9}{"lock PF":>8}')
for name, ov in CONFIGS:
    rows = sim(ov) if ov else [dict(date=t['date'], pnl=(t['final']) * PV - COMM) for t in trades]
    s = stats(rows)
    dev = stats([r for r in rows if r['date'] <= '2024-12-31'])
    lock = stats([r for r in rows if r['date'] > '2024-12-31'])
    print(f'{name:<20}{s["pnl"]:>9,.0f}{s["pf"]:>6.2f}{s["wr"]:>6.1f}{s["dd"]:>9,.0f}{s["worst"]:>8,.0f} | '
          f'{dev["pnl"]:>9,.0f}{dev["pf"]:>7.2f} | {lock["pnl"]:>9,.0f}{lock["pf"]:>8.2f}')

print('\nNOTE: overlays chosen from a small pre-registered family; dev/locked split')
print('is the arbiter. Stop-style exits pay 1.5pt slip; targets are limits (no slip).')
