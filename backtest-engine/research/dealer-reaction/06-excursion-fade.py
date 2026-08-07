#!/usr/bin/env python3
"""LEVEL-FREE excursion fade (Drew, 2026-07-23): no GEX, no levels at all.

Question: NQ mean-reverts a lot — is a 1m LS flip alone predictive enough to time the fade of any
fast excursion? Event = the excursion itself (directional move within the last 60m), trigger = 1m LS
flip against it, stop = structural (behind the excursion extreme + buffer), target = 1.5R.

Honesty fix vs 04-state-machine.py: resolve walks 1s from the trigger bar CLOSE (entry instant), not
the bar open — 04 could credit phantom target hits from the trigger bar's own pre-entry ticks (stop
side was safe by construction; target side was not). So numbers here are slightly conservative vs 04.

Modes:
  flips  = every RTH 1m LS flip (+60s lag): direction = flip direction; excursion measured AGAINST
           that direction over the prior 60m; resolve if exc>=5 and structural risk in [3,40].
           Bucketed by exc in analysis (incl. small-exc bucket = near-unconditional flip fade).
  random = seeded random RTH bars at ~matched rate; direction = fade the DOMINANT prior-60m excursion;
           same gates/machinery. Answers: does the LS flip time entries better than random times?
Usage: python3 06-excursion-fade.py flips|random
"""
import bisect
import csv
import importlib.util
import random
import sys
from pathlib import Path

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
spec = importlib.util.spec_from_file_location('fsm', BASE / 'research/dealer-reaction/04-state-machine.py')
fsm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fsm)

LAG_MS = 60000
WIN_MS = 60 * 60000
EXC_MIN = 5.0          # below this the structural stop is degenerate anyway
BUFFER = 4.0
RISK_MIN, RISK_CAP = 3.0, 40.0
RR_TARGET = 1.5
RAND_P = 0.02          # ~random trigger rate per RTH bar (~7-8/day, near flip-survivor rate)
RNG = random.Random(20260723)


def excursion(bars, j0, i, direction):
    """Max directional move within bars[j0..i]. direction=+1: up-move (h - running min low),
    -1: down-move (running max high - l). Returns (size, extreme_price)."""
    if direction > 0:
        run = float('inf'); best = 0.0; ext = bars[i][2]
        for j in range(j0, i + 1):
            run = min(run, bars[j][3])
            m = bars[j][2] - run
            if m > best:
                best = m; ext = bars[j][2]
    else:
        run = float('-inf'); best = 0.0; ext = bars[i][3]
        for j in range(j0, i + 1):
            run = max(run, bars[j][2])
            m = run - bars[j][3]
            if m > best:
                best = m; ext = bars[j][3]
    return best, ext


def run(mode):
    bars = fsm.load_1m()
    ms_a = [b[0] for b in bars]
    print(f'{len(bars)} bars', flush=True)
    reader = fsm.S1Reader()

    triggers = []   # (bar_idx, fade_dir)  fade_dir=+1 long / -1 short
    if mode == 'flips':
        for fts, state in fsm.load_ls1m_flips():
            i = bisect.bisect_left(ms_a, fts + LAG_MS)
            if i >= len(ms_a) or ms_a[i] - (fts + LAG_MS) > 3 * 60000:
                continue
            triggers.append((i, -1 if state == 'BEARISH' else +1))
    else:
        for i in range(len(bars)):
            if RNG.random() < RAND_P:
                triggers.append((i, 0))   # direction decided from dominant excursion below

    trades = []
    seen = set()
    for i, fd in triggers:
        em, date = fsm.et_min(ms_a[i])
        if not (570 <= em < fsm.EOD_ET):
            continue
        j0 = bisect.bisect_left(ms_a, ms_a[i] - WIN_MS)
        if fd == 0:   # random mode: fade the dominant excursion
            up, uext = excursion(bars, j0, i, +1)
            dn, dext = excursion(bars, j0, i, -1)
            fd, exc, ext = (-1, up, uext) if up >= dn else (+1, dn, dext)
        else:         # flip mode: excursion against the flip direction
            exc, ext = excursion(bars, j0, i, +1 if fd < 0 else -1)
        if exc < EXC_MIN:
            continue
        entry = bars[i][4]
        stop = (ext + BUFFER) if fd < 0 else (ext - BUFFER)
        risk = abs(entry - stop)
        if risk < RISK_MIN or risk > RISK_CAP:
            continue
        key = (ms_a[i], fd)
        if key in seen:
            continue
        seen.add(key)
        target = entry + fd * RR_TARGET * risk
        res = fsm.resolve(reader, ms_a[i] + 60000, entry, fd, stop, target, bars[i][5])
        if not res:
            continue
        q = f'{date[:4]}Q{(int(date[5:7]) - 1) // 3 + 1}'
        trades.append(dict(date=date, quarter=q, tod=em, dir=fd, exc=round(exc, 1),
                           entry=round(entry, 2), stop=round(stop, 2), target=round(target, 2), **res))

    out = BASE / f'research/dealer-reaction/exc_{mode}.csv'
    if trades:
        with open(out, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(trades[0].keys()))
            w.writeheader(); w.writerows(trades)
    print(f'{mode}: {len(trades)} trades -> {out}', flush=True)


if __name__ == '__main__':
    run(sys.argv[1] if len(sys.argv) > 1 else 'flips')
