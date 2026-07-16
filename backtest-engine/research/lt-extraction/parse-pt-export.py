#!/usr/bin/env python3
"""Parse PT_Dumper (Liquidity Toolkit Price Triggers) trade-list exports.

Comment format: P1=..|P5=..|PH=..|PD=..|PW=..|PM=..|T=YYYYMMDDTHHMM (UTC).
Values are chart price space (NQ1! back-adjusted) -> translated to raw
contract space via the rollover log: raw(T) = continuous(T) - sum(spreads of
rolls AFTER T).

Built-in audits:
  - WIRING ALARM: any P* column correlating ~1 with the entry fill price
    (same-bar tracking) is flagged as miswired.
  - CADENCE REPORT: change frequency per column (PH ~hourly, PD ~daily...).
  - Dedupe by T stamp; entry rows only.

Usage: python3 parse-pt-export.py --in <export.csv> [--in ...] --out <out.csv>
"""
import argparse
import csv
import statistics
import sys
from datetime import datetime, timezone

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
KEYS = ('P1', 'P5', 'PH', 'PD', 'PW', 'PM')

ap = argparse.ArgumentParser()
ap.add_argument('--in', dest='ins', action='append', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--no-translate', action='store_true')
args = ap.parse_args()

# rollover log -> (unix_ms, spread) sorted; cumulative spread AFTER t
rolls = []
with open(f'{BASE}/data/ohlcv/nq/NQ_rollover_log.csv') as f:
    for r in csv.DictReader(f):
        ms = int(datetime.strptime(r['date'], '%Y-%m-%d')
                 .replace(tzinfo=timezone.utc).timestamp() * 1000)
        rolls.append((ms, float(r['spread']), r['to_symbol'], r['from_symbol']))
rolls.sort()


def offset_and_contract(ms):
    after = [s for t, s, _, _ in rolls if t > ms]
    # contract: from_symbol of the first roll after ms; else last to_symbol
    nxt = next(((t, s, to, frm) for t, s, to, frm in rolls if t > ms), None)
    contract = nxt[3] if nxt else (rolls[-1][2] if rolls else '?')
    return sum(after), contract


records = {}
prices = {}
for fn in args.ins:
    with open(fn, encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            if not row.get('Type', '').startswith('Entry'):
                continue
            sig = row.get('Signal', '')
            if 'T=' not in sig or 'P1=' not in sig:
                continue
            kv = dict(p.split('=', 1) for p in sig.split('|') if '=' in p)
            t = kv.get('T')
            if not t or t in records:
                continue
            vals = {}
            for k in KEYS:
                v = kv.get(k, 'NaN')
                try:
                    vals[k] = float(v)
                except ValueError:
                    vals[k] = float('nan')
            records[t] = vals
            try:
                prices[t] = float(row['Price USD'].replace(',', ''))
            except (ValueError, KeyError):
                pass

stamps = sorted(records)
print(f'{len(stamps)} deduped bars {stamps[0]} -> {stamps[-1]}')

# ---- wiring alarm ----
print('\n=== wiring audit (corr of P* vs entry fill price; ~1.0 + tiny gap = MISWIRED) ===')
for k in KEYS:
    pairs = [(records[t][k], prices[t]) for t in stamps
             if t in prices and records[t][k] == records[t][k]]
    if len(pairs) < 50:
        print(f'  {k}: n={len(pairs)} (mostly NaN — suppressed on this chart TF or disabled)')
        continue
    xs, ys = zip(*pairs)
    mx, my = statistics.mean(xs), statistics.mean(ys)
    cov = sum((a - mx) * (b - my) for a, b in pairs)
    den = (sum((a - mx) ** 2 for a in xs) * sum((b - my) ** 2 for b in ys)) ** 0.5
    corr = cov / den if den else 0
    gap = statistics.median(abs(a - b) for a, b in pairs)
    flag = '  <-- MISWIRED?' if corr > 0.9999 and gap < 2 else ''
    print(f'  {k}: n={len(pairs)} corr={corr:.5f} median|P-price|={gap:.1f}pt{flag}')

# ---- cadence report ----
print('\n=== cadence (distinct-value changes per column) ===')
for k in KEYS:
    vals = [records[t][k] for t in stamps if records[t][k] == records[t][k]]
    if len(vals) < 10:
        print(f'  {k}: insufficient data')
        continue
    ch = sum(1 for i in range(1, len(vals)) if vals[i] != vals[i - 1])
    print(f'  {k}: {ch} changes over {len(vals)} bars ({ch/len(vals)*100:.1f}%/bar)')

# ---- write output ----
with open(args.out, 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['timestamp_iso', 'unix_ms'] + [k.lower() for k in KEYS]
               + ['raw_contract', 'was_backadjusted'])
    for t in stamps:
        dt = datetime.strptime(t, '%Y%m%dT%H%M').replace(tzinfo=timezone.utc)
        ms = int(dt.timestamp() * 1000)
        off, contract = (0.0, 'NQ1!') if args.no_translate else offset_and_contract(ms)
        row = [dt.strftime('%Y-%m-%dT%H:%M:00.000Z'), ms]
        for k in KEYS:
            v = records[t][k]
            row.append('NaN' if v != v else f'{v - off:.2f}')
        row += [contract, str(not args.no_translate).lower()]
        w.writerow(row)
print(f'\nWrote {args.out} ({len(stamps)} rows, raw-contract space)')
