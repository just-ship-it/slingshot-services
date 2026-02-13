#!/usr/bin/env python3
"""Aggregate ES 1-second OHLCV to 1-minute bars.

Streams the 6.5GB 1s CSV and outputs 1m bars with proper OHLCV aggregation.
Filters out calendar spreads (symbols containing '-').
"""
import csv
import sys
from collections import defaultdict

INPUT = 'backtest-engine/data/ohlcv/es/ES_ohlcv_1s.csv'
OUTPUT = 'backtest-engine/data/ohlcv/es/ES_ohlcv_1m.csv'

def minute_key(ts):
    """Truncate ISO timestamp to minute."""
    return ts[:16] + ':00.000000000Z'

def main():
    with open(INPUT, 'r') as fin, open(OUTPUT, 'w', newline='') as fout:
        reader = csv.reader(fin)
        writer = csv.writer(fout)

        header = next(reader)
        writer.writerow(header)

        # ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
        current_minute = None
        current_symbol = None
        bar = None
        count = 0
        written = 0

        for row in reader:
            count += 1
            if count % 10_000_000 == 0:
                print(f'  Processed {count/1e6:.0f}M rows, written {written} bars...', file=sys.stderr)

            ts = row[0]
            symbol = row[9]

            # Skip calendar spreads
            if '-' in symbol:
                continue

            minute = minute_key(ts)

            if minute != current_minute or symbol != current_symbol:
                # Write previous bar
                if bar is not None:
                    writer.writerow(bar)
                    written += 1

                # Start new bar
                current_minute = minute
                current_symbol = symbol
                o = float(row[4])
                h = float(row[5])
                l = float(row[6])
                c = float(row[7])
                v = int(row[8])
                bar = [minute, row[1], row[2], row[3],
                       f'{o:.6f}', f'{h:.6f}', f'{l:.6f}', f'{c:.6f}',
                       str(v), symbol]
            else:
                # Update current bar
                h = float(row[5])
                l = float(row[6])
                c = float(row[7])
                v = int(row[8])

                if h > float(bar[5]):
                    bar[5] = f'{h:.6f}'
                if l < float(bar[6]):
                    bar[6] = f'{l:.6f}'
                bar[7] = f'{c:.6f}'
                bar[8] = str(int(bar[8]) + v)

        # Write last bar
        if bar is not None:
            writer.writerow(bar)
            written += 1

        print(f'Done. Processed {count} rows, wrote {written} 1-minute bars.', file=sys.stderr)

if __name__ == '__main__':
    main()
