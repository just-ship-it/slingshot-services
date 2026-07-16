#!/usr/bin/env python3
"""PILOTFISH E1 — SWEEP_HUNT (see PLAN.md Phase 2 pre-registration).

Event: first RTH break (09:30-15:30 ET) of the overnight extreme or the prior
RTH day's extreme (same contract). Snapback = event-minute close back inside;
acceptance = close beyond. Conditioning: event-minute volume surprise vs
trailing 60d median for that minute-of-day.
Pre-registered: snapback+LOW surprise -> fade (drift away from ref) 30m;
acceptance+HIGH surprise -> continuation. Baseline: all breaks unconditioned.
Discovery 2023-24, holdout 2025-26. Screening on minute closes.
"""
import sys
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, causal_baseline, stat_line, split_years

rows = load_minutes()
vbase = causal_baseline(rows, 'v')
print(f'{len(rows)} minutes loaded, {len(vbase)} baselined')

events = []  # (date, reftype, side, snapback, vsurp, fwd15, fwd30, fwd60)
on_hi = on_lo = None
on_sym = None
pd_hi = pd_lo = None          # prior RTH day's extremes (frozen)
pd_sym = None
cur_hi = cur_lo = None        # accumulating today's RTH extremes
swept = set()                 # (reftype, side) already fired today
cur_date = None

for i, r in enumerate(rows):
    hh = r['hhmm']
    if hh == '18:00':
        on_hi, on_lo, on_sym = r['h'], r['l'], r['sym']
    elif on_hi is not None and (hh > '18:00' or hh < '09:30'):
        if r['sym'] == on_sym:
            on_hi = max(on_hi, r['h'])
            on_lo = min(on_lo, r['l'])
        else:
            on_hi = None
    if r['date'] != cur_date:
        cur_date = r['date']
        swept = set()
    if hh == '09:30':
        cur_hi, cur_lo = r['h'], r['l']
    elif cur_hi is not None and '09:30' < hh <= '16:00' and r['sym']:
        cur_hi = max(cur_hi, r['h'])
        cur_lo = min(cur_lo, r['l'])
    if hh == '16:00':
        pd_hi, pd_lo, pd_sym = cur_hi, cur_lo, r['sym']
        cur_hi = None

    if not ('09:30' <= hh <= '15:30'):
        continue
    refs = []
    if on_hi is not None and r['sym'] == on_sym:
        refs.append(('ON', on_hi, on_lo))
    if pd_hi is not None and r['sym'] == pd_sym:
        refs.append(('PD', pd_hi, pd_lo))
    for reftype, rhi, rlo in refs:
        for side, broke, ref in ((+1, r['h'] > rhi, rhi), (-1, r['l'] < rlo, rlo)):
            if not broke or (reftype, side) in swept:
                continue
            swept.add((reftype, side))
            snap = (r['c'] < ref) if side > 0 else (r['c'] > ref)
            vb = vbase.get((r['date'], hh))
            if not vb:
                continue
            vs = r['v'] / vb
            fwd = {}
            ok = True
            for horizon in (15, 30, 60):
                j = i
                tgt = None
                while j + 1 < len(rows) and j - i < horizon + 10:
                    j += 1
                    if rows[j]['sym'] != r['sym']:
                        ok = False
                        break
                    # minutes are near-contiguous; count traded minutes
                    if j - i >= horizon:
                        tgt = rows[j]['c']
                        break
                if not ok or tgt is None:
                    ok = False
                    break
                fwd[horizon] = tgt - r['c']
            if ok:
                events.append((r['date'], reftype, side, snap, vs,
                               fwd[15], fwd[30], fwd[60]))

print(f'{len(events)} sweep events\n')


def cell(evs, reftype, want_snap, vs_lo, vs_hi, mode, h=6):
    """mode 'fade' = away from ref; 'cont' = with break direction. h: 5=15m,6=30m,7=60m"""
    picks = []
    for e in evs:
        if e[1] != reftype or e[3] != want_snap or not (vs_lo <= e[4] < vs_hi):
            continue
        drift = e[h]
        picks.append(-e[2] * drift if mode == 'fade' else e[2] * drift)
    return picks


for label, evs in zip(('DISCOVERY 2023-24', 'HOLDOUT 2025-26'), split_years(events)):
    print(f'========== {label} ({len(evs)} events) ==========')
    for reftype in ('ON', 'PD'):
        sub = [e for e in evs if e[1] == reftype]
        print(f'--- ref={reftype} ---')
        stat_line('  baseline: ALL breaks, continuation 30m',
                  [e[2] * e[6] for e in sub])
        stat_line('  PRE-REG: snapback + vsurp<1 -> FADE 30m',
                  cell(evs, reftype, True, 0, 1.0, 'fade'))
        stat_line('  PRE-REG: acceptance + vsurp>2 -> CONT 30m',
                  cell(evs, reftype, False, 2.0, 99, 'cont'))
        # full grid for honesty
        for snap in (True, False):
            for vlo, vhi, vl in ((0, 1.0, '<1x'), (1.0, 2.0, '1-2x'), (2.0, 99, '>2x')):
                for mode in ('fade',):
                    p = cell(evs, reftype, snap, vlo, vhi, mode)
                    tag = 'snapback' if snap else 'accept  '
                    stat_line(f'    grid {tag} vs={vl:4s} fade30', p)
    print()
