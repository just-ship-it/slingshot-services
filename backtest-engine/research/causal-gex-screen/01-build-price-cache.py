#!/usr/bin/env python3
"""Build NQ primary-contract 1m close cache for the causal-GEX screen.

Streams data/ohlcv/nq/NQ_ohlcv_1m.csv once, keeps rows in [START, END),
drops calendar spreads, resolves the primary contract per clock-hour by
total volume (same rule as engine filterPrimaryContract / the causal GEX
generator), and writes minute rows of the winning contract only:

    ts_minute,close,symbol

Roll handling downstream: consumers must censor any forward-return window
in which `symbol` changes (roll spread is not a market move).
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
SRC = BASE / 'data/ohlcv/nq/NQ_ohlcv_1m.csv'
OUT = Path(__file__).parent / 'nq_1m_primary_2023plus.csv'
START, END = '2023-01-01', '2026-06-18'

hour_vol = defaultdict(float)          # (hour_key, symbol) -> volume
rows = []                              # (ts, hour_key, symbol, close)

with open(SRC) as f:
    reader = csv.reader(f)
    header = next(reader)
    i_ts, i_close, i_vol, i_sym = 0, 7, 8, 9
    for parts in reader:
        if len(parts) < 10:
            continue
        ts = parts[i_ts]
        if ts < START:
            continue
        if ts[:10] >= END:
            break
        sym = parts[i_sym].strip()
        if '-' in sym:
            continue
        hour_key = ts[:13]
        try:
            vol = float(parts[i_vol])
            close = float(parts[i_close])
        except ValueError:
            continue
        hour_vol[(hour_key, sym)] += vol
        rows.append((ts, hour_key, sym, close))

winner = {}
for (hour_key, sym), vol in hour_vol.items():
    if hour_key not in winner or vol > winner[hour_key][1]:
        winner[hour_key] = (sym, vol)

kept = 0
with open(OUT, 'w') as f:
    f.write('ts,close,symbol\n')
    for ts, hour_key, sym, close in rows:
        if winner[hour_key][0] != sym:
            continue
        f.write(f'{ts[:16]},{close},{sym}\n')
        kept += 1

print(f'{kept} primary-contract minutes -> {OUT}')
syms = sorted({w[0] for w in winner.values()})
print('contracts seen:', syms)
