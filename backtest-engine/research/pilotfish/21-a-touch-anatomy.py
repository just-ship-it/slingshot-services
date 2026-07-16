#!/usr/bin/env python3
"""PILOTFISH Phase 5A — touch anatomy (PLAN.md).

Level TFs {15m,1h,4h} × candle TFs {1m,5m,15m} × events {A1 wick-reject,
A2 close-through, A3 wick-hold}. Zone ±0.05%. Outcomes 60/120m in points,
prediction-signed. Placebo: levels +37pt. Eras 2021-22 / 2023-24 / 2025-26.
Survival: same sign 3 eras, |gross|>2.2pt all eras, beats placebo.
"""
import csv
import statistics
import sys
from datetime import datetime
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import load_minutes, TF_MS

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
rows = load_minutes(include_2021=True)
N = len(rows)
row_ms = [int(datetime.fromisoformat(r['ts'] + ':00+00:00').timestamp() * 1000) for r in rows]
print(f'{N} minutes {rows[0]["date"]} -> {rows[-1]["date"]}')


def build_candles(width):
    """Aggregate 1m rows into width-minute candles. Returns list of
    (start_idx, end_idx, o, h, l, c, sym, date) with end_idx = last 1m row."""
    if width == 1:
        return [(i, i, r['o'], r['h'], r['l'], r['c'], r['sym'], r['date'])
                for i, r in enumerate(rows)]
    out = []
    cur = None
    for i, r in enumerate(rows):
        bucket = row_ms[i] // (width * 60000)
        if cur is None or bucket != cur[0] or r['sym'] != cur[7]:
            if cur is not None:
                out.append(tuple(cur[1:8]) + (cur[8],))
            cur = [bucket, i, i, r['o'], r['h'], r['l'], r['c'], r['sym'], r['date']]
        else:
            cur[2] = i
            cur[4] = max(cur[4], r['h'])
            cur[5] = min(cur[5], r['l'])
            cur[6] = r['c']
    if cur is not None:
        out.append(tuple(cur[1:8]) + (cur[8],))
    # fields: (i0, i1, o, h, l, c, sym, date)
    return out


def load_lt(tf):
    fn = (f'{BASE}/research/lt-extraction/output/nq_lt_15m_full_2021-2026.csv'
          if tf == '15m' else f'{BASE}/research/lt-extraction/output/nq_lt_{tf}_raw.csv')
    ts, lvsets = [], []
    for r in csv.DictReader(open(fn)):
        try:
            lv = [float(r[f'level_{i}']) for i in range(1, 6)]
        except ValueError:
            continue
        if any(x != x for x in lv):
            continue
        ts.append(int(r['unix_ms']) + TF_MS[tf])
        lvsets.append(lv)
    return ts, lvsets


CANDLES = {w: build_candles(w) for w in (1, 5, 15)}
ERAS = (('21-22', lambda d: d < '2023-01-01'),
        ('23-24', lambda d: '2023-01-01' <= d < '2025-01-01'),
        ('25-26', lambda d: d >= '2025-01-01'))


def scan(level_tf, candle_w, shift):
    lts, lsets = load_lt(level_tf)
    candles = CANDLES[candle_w]
    events = {'A1': [], 'A2': [], 'A3': []}
    cooldown = {}
    li = 0
    for k in range(1, len(candles) - 1):
        i0, i1, o, h, l, c, sym, date = candles[k]
        pi0, pi1, po, ph, pl, pc, psym, _ = candles[k - 1]
        if psym != sym:
            continue
        ms = row_ms[i0]
        while li + 1 < len(lts) and lts[li + 1] <= ms:
            li += 1
        if lts[li] > ms:
            continue
        # forward refs from candle close (i1) on the 1m grid
        j60, j120 = i1 + 60, i1 + 120
        if j120 >= N or rows[j120]['sym'] != sym:
            continue
        for L0 in lsets[li]:
            L = L0 + shift
            zone = L * 0.05 / 100
            key = round(L)
            if cooldown.get((key, candle_w), -1) > k:
                continue
            s = 1 if pc > L + zone else -1 if pc < L - zone else 0
            if s == 0:
                continue
            touched = (l <= L + zone) if s > 0 else (h >= L - zone)
            if not touched:
                continue
            cooldown[(key, candle_w)] = k + max(1, 30 // candle_w)
            base = rows[i1]['c']
            f60, f120 = rows[j60]['c'] - base, rows[j120]['c'] - base
            if (c >= L + 2 * zone) if s > 0 else (c <= L - 2 * zone):
                events['A1'].append((date, s * f60, s * f120))
            elif (c <= L - zone) if s > 0 else (c >= L + zone):
                events['A2'].append((date, -s * f60, -s * f120))
            else:
                # A3: next candle resolution
                if k + 1 < len(candles):
                    n = candles[k + 1]
                    if n[6] == sym:
                        d = 1 if n[5] > c else -1 if n[5] < c else 0
                        if d:
                            nb_i1 = n[1]
                            if nb_i1 + 120 < N and rows[nb_i1 + 120]['sym'] == sym:
                                nb = rows[nb_i1]['c']
                                events['A3'].append((date,
                                                     d * (rows[nb_i1 + 60]['c'] - nb),
                                                     d * (rows[nb_i1 + 120]['c'] - nb)))
    return events


print(f'\n{"cell":26s} | ' + ' | '.join(f'{e} real/placebo 120m (n)' for e, _ in ERAS))
survivors = []
for ltf in ('15m', '1h', '4h'):
    for cw in (1, 5, 15):
        real = scan(ltf, cw, 0.0)
        plac = scan(ltf, cw, 37.0)
        for ev in ('A1', 'A2', 'A3'):
            cells = []
            signs = []
            mags = []
            for elab, sel in ERAS:
                re = [x[2] for x in real[ev] if sel(x[0])]
                pe = [x[2] for x in plac[ev] if sel(x[0])]
                if len(re) < 25:
                    cells.append(f'--(n={len(re)})')
                    signs.append(0)
                    continue
                rm = statistics.mean(re)
                pm = statistics.mean(pe) if len(pe) >= 25 else float('nan')
                cells.append(f'{rm:+.1f}/{pm:+.1f}({len(re)})')
                signs.append(1 if rm > 0 else -1)
                mags.append((rm, pm))
            line = f'{ltf}-lvl {cw:2d}m-candle {ev}'
            print(f'{line:26s} | ' + ' | '.join(f'{c:24s}' for c in cells))
            if (len(set(signs)) == 1 and signs[0] != 0
                    and all(abs(r) > 2.2 for r, _ in mags)
                    and all(abs(r) > abs(p) or (r > 0) != (p > 0)
                            for r, p in mags if p == p)):
                survivors.append(line)
print('\nSURVIVORS (same sign 3 eras, >2.2pt, beats placebo):', survivors or 'NONE')
