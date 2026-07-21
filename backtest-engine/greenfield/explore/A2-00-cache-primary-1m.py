#!/usr/bin/env python3
"""A2-00: Build a slim primary-contract 1m cache from the raw NQ 1m CSV.

Rules (per charter / CLAUDE.md data mechanics):
  - Drop calendar-spread rows (symbol contains '-').
  - Per clock-hour (UTC, on ts_event), keep ONLY the symbol with the highest
    total volume in that hour ("primary contract").
  - Input is sorted by ts_event, so we buffer one clock-hour at a time.

Output: greenfield/explore/cache_nq_primary_1m.csv
  header: ts,open,high,low,close,volume,symbol
  ts = minute ISO 'YYYY-MM-DDTHH:MM' (UTC). Bar covers [ts, ts+60s); its
  OHLC is knowable only at ts+60s.

This is the ONLY valid price series for comparing against GEX/LT levels
(both are raw-contract price space).
"""
import csv
import sys
from collections import defaultdict

SRC = '/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv'
OUT = '/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore/cache_nq_primary_1m.csv'


def flush(hour_rows, writer):
    if not hour_rows:
        return 0
    vol = defaultdict(int)
    for r in hour_rows:
        vol[r[6]] += r[5]
    winner = max(vol.items(), key=lambda kv: kv[1])[0]
    n = 0
    for r in hour_rows:
        if r[6] == winner:
            writer.writerow([r[0], f'{r[1]:g}', f'{r[2]:g}', f'{r[3]:g}',
                             f'{r[4]:g}', r[5], r[6]])
            n += 1
    return n


def main():
    n_in = n_out = n_spread = 0
    cur_hour = None
    hour_rows = []  # (ts_min, o, h, l, c, vol, symbol)
    with open(SRC, newline='') as f, open(OUT, 'w', newline='') as g:
        reader = csv.reader(f)
        header = next(reader)
        assert header[0] == 'ts_event' and header[9] == 'symbol', header
        writer = csv.writer(g)
        writer.writerow(['ts', 'open', 'high', 'low', 'close', 'volume', 'symbol'])
        for row in reader:
            n_in += 1
            if len(row) < 10:      # blank/malformed lines exist in the dump
                continue
            sym = row[9]
            if '-' in sym:
                n_spread += 1
                continue
            ts = row[0][:16]           # YYYY-MM-DDTHH:MM
            hour = ts[:13]             # YYYY-MM-DDTHH
            if hour != cur_hour:
                n_out += flush(hour_rows, writer)
                hour_rows = []
                cur_hour = hour
            # cols: 4=open 5=high 6=low 7=close 8=volume 9=symbol
            hour_rows.append((ts, float(row[4]), float(row[5]), float(row[6]),
                              float(row[7]), int(row[8]), sym))
        n_out += flush(hour_rows, writer)
    print(f'in={n_in} spreads_dropped={n_spread} out={n_out}')


if __name__ == '__main__':
    main()
