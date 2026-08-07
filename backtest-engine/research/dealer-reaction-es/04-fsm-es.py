#!/usr/bin/env python3
"""ES dealer-reaction STATE MACHINE — reversal-confirmed deep-penetration fade (2026-07-23).

Drew's original spec, price-triggered (no LS dependency):
  IDLE -> price crosses a causal GEX level and the swing extreme reaches >= PEN_MIN past it
       -> PENETRATED: track swing extreme
       -> TRIGGER: first 1m candle that CLOSES BACK on the origin side of the level (turn underway),
          within WATCH_WIN of the cross
       -> ENTER fade at trigger close; STOP = swing-extreme +/- BUFFER (structural);
          TARGET = 1.5R continuation; resolve on 1s HONESTLY (walk starts at trigger-bar CLOSE —
          the resolve-side-lookahead lesson from the NQ FSM is baked in, not optional).

ES scale (0.208x NQ, tick-rounded): PEN_MIN 20->4.25, BUFFER 4->1.0, RISK in [0.75, 8.5],
STOP_SLIP 1.5->0.5. WATCH_WIN 60m, MAXHOLD 60m, EOD 15:45 ET. RR_TARGET 1.5 (ratio, unscaled).

Modes: full | placebo_rand | placebo_round   (levels via 01-harness-es loaders)
Env: TRIGGER=reversal (default) | immediate  — 'immediate' enters at the bar the penetration
     threshold is reached (no turn confirmation): the control for what the reversal-wait adds.
Output: fsm_<mode>[_immediate].csv
"""
import bisect
import csv
import importlib.util
import os
import sys
from pathlib import Path

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
spec = importlib.util.spec_from_file_location('h1', BASE / 'research/dealer-reaction-es/01-harness-es.py')
h1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h1)

PEN_MIN = 4.25
BUFFER = 1.0
RISK_MIN, RISK_CAP = 0.75, 8.5
RR_TARGET = 1.5
WATCH_WIN_MS = 60 * 60000
MAXHOLD_S = 60 * 60
EOD_ET = 15 * 60 + 45
STOP_SLIP = 0.5
TRIGGER = os.environ.get('TRIGGER', 'reversal')


def resolve(reader, t0, entry, d, stop, target, sym):
    """First-passage target-before-stop on 1s, walk starts at t0 (= trigger-bar CLOSE time)."""
    risk = abs(entry - stop)
    if risk < 0.25:
        return None
    mfe = mae = 0.0
    outcome = None
    exitpx = None
    cl = entry
    end = t0 + MAXHOLD_S * 1000
    j = bisect.bisect_left(reader.keys, (t0 // 60000) * 60000)
    while j < len(reader.keys) and reader.keys[j] <= end:
        for ts, hi, lo, cl in reader.read_minute(reader.keys[j], sym):
            from datetime import datetime, timezone
            tms = int(datetime.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).timestamp() * 1000)
            if tms < t0 or tms > end:
                continue
            em, _ = h1.et_min_of(tms)
            fav = (hi - entry) if d > 0 else (entry - lo)
            adv = (entry - lo) if d > 0 else (hi - entry)
            mfe = max(mfe, fav); mae = max(mae, adv)
            hit_stop = (lo <= stop) if d > 0 else (hi >= stop)
            hit_tgt = (hi >= target) if d > 0 else (lo <= target)
            if hit_stop:
                outcome = 'stop'; exitpx = stop - d * STOP_SLIP; break
            if hit_tgt:
                outcome = 'target'; exitpx = target; break
            if em >= EOD_ET:
                outcome = 'eod'; exitpx = cl; break
        if outcome:
            break
        j += 1
    if outcome is None:
        outcome = 'timeout'; exitpx = cl
    pnl = (exitpx - entry) * d
    return dict(outcome=outcome, pnl=round(pnl, 2), R=round(pnl / risk, 3), risk=round(risk, 2),
                mfe=round(mfe, 2), mae=round(mae, 2))


def run(mode):
    bars = h1.load_1m()
    print(f'{len(bars)} bars', flush=True)
    if mode == 'full':
        levels = h1.load_gex_levels()
    elif mode == 'placebo_rand':
        levels = h1.make_placebo(bars, 'rand')
    elif mode == 'placebo_round':
        levels = h1.make_placebo(bars, 'round')
    else:
        raise SystemExit(f'unknown mode {mode}')
    reader = h1.S1Reader()

    trades = []
    state = {}
    for i, (ms, o, h, l, c, sym) in enumerate(bars):
        em, date = h1.et_min_of(ms)
        if not (570 <= em < EOD_ET):
            continue
        snaps = levels.get(date)
        if not snaps:
            continue
        lv = h1.snapshot_at(snaps, ms)
        if not lv:
            continue
        for kind, L in lv.items():
            gk = f'{date}:{kind}'
            st = state.get(gk)
            cur_side = 'above' if c >= L else 'below'
            if st is None:
                state[gk] = dict(phase='watch', side=cur_side)
                continue
            if st['phase'] == 'watch':
                if cur_side != st['side']:
                    st.update(phase='crossed', origin=st['side'], cross_ts=ms,
                              dir=(+1 if cur_side == 'above' else -1),
                              extreme=(h if cur_side == 'above' else l))
                st['side'] = cur_side
                continue
            st['extreme'] = max(st['extreme'], h) if st['dir'] > 0 else min(st['extreme'], l)
            if ms - st['cross_ts'] > WATCH_WIN_MS:
                state[gk] = dict(phase='watch', side=cur_side)
                continue
            past = (st['extreme'] - L) if st['dir'] > 0 else (L - st['extreme'])
            if st['phase'] == 'crossed':
                if past >= PEN_MIN:
                    st['phase'] = 'penetrated'; st['pen_ts'] = ms
                else:
                    continue
            # PENETRATED: trigger
            if TRIGGER == 'immediate':
                trig = (ms == st['pen_ts'])
            else:
                closed_back = (c < L) if st['dir'] > 0 else (c > L)
                trig = closed_back
            if not trig:
                continue
            fd = -st['dir']
            entry = c
            stop = (st['extreme'] + BUFFER) if fd < 0 else (st['extreme'] - BUFFER)
            risk = abs(entry - stop)
            state[gk] = dict(phase='watch', side=cur_side)
            if risk < RISK_MIN or risk > RISK_CAP:
                continue
            target = entry + fd * RR_TARGET * risk
            res = resolve(reader, ms + 60000, entry, fd, stop, target, sym)
            if not res:
                continue
            q = f'{date[:4]}Q{(int(date[5:7])-1)//3+1}'
            dist_lvl = (entry - L) if fd < 0 else (L - entry)
            trades.append(dict(date=date, quarter=q, kind=kind, dir=fd, entry=round(entry, 2),
                               pen=round((st["extreme"] - L) if st["dir"] > 0 else (L - st["extreme"]), 2),
                               dist_lvl=round(dist_lvl, 2), level=round(L, 2),
                               stop=round(stop, 2), target=round(target, 2), **res))
    seen = set()
    deduped = []
    for t in sorted(trades, key=lambda x: (x['date'], x['entry'])):
        key = (t['date'], round(t['entry']), round(t['level'] / 2), t['dir'])
        if key in seen:
            continue
        seen.add(key); deduped.append(t)
    print(f'  {len(trades)} raw -> {len(deduped)} after dedup', flush=True)
    trades = deduped
    suffix = '_immediate' if TRIGGER == 'immediate' else ''
    out = BASE / f'research/dealer-reaction-es/fsm_{mode}{suffix}.csv'
    if trades:
        with open(out, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(trades[0].keys()))
            w.writeheader(); w.writerows(trades)
    print(f'{mode}[{TRIGGER}]: {len(trades)} trades -> {out}', flush=True)


if __name__ == '__main__':
    run(sys.argv[1] if len(sys.argv) > 1 else 'full')
