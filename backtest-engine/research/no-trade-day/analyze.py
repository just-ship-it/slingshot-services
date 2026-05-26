#!/usr/bin/env python3
"""
Worst/best day pattern analysis.

For each trading session, computes feature vector and looks for predictive
correlations with same-day FCFS portfolio PnL. Goal: find a robust no-trade-day
rule that avoids killer days without skipping recoverable losers.

Key constraint: missing a $10k winner costs the same as taking 3x $3k losers.
The rule must be highly specific or it's net negative.
"""

import csv
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

# ── Load daily PnL ────────────────────────────────────────────────────────
pnl_by_date = {}
with open(ROOT / 'research/4strategy-portfolio/output/daily-pnl-mnq-4strat.csv') as f:
    for row in csv.DictReader(f):
        pnl_by_date[row['date']] = float(row['pnl_mnq']) * 10  # MNQ → NQ

# ── Load 1m OHLCV → aggregate to daily ────────────────────────────────────
print(f'Aggregating daily OHLC from 1m raw...', file=sys.stderr)
daily = {}  # date → {open, high, low, close, volume}
with open(ROOT / 'data/ohlcv/nq/NQ_ohlcv_1m.csv') as f:
    r = csv.reader(f)
    header = next(r)
    cols = {name: i for i, name in enumerate(header)}
    sym_i = cols['symbol']
    ts_i = 0
    o_i, h_i, l_i, c_i, v_i = cols['open'], cols['high'], cols['low'], cols['close'], cols['volume']
    for row in r:
        if len(row) <= max(sym_i, o_i, h_i, l_i, c_i, v_i):
            continue
        sym = row[sym_i]
        if '-' in sym:
            continue  # skip calendar spreads
        try:
            ts = row[ts_i]
            o, h, l, c, v = float(row[o_i]), float(row[h_i]), float(row[l_i]), float(row[c_i]), float(row[v_i])
        except (ValueError, IndexError):
            continue
        # ET date (very rough — UTC date is fine for our daily aggregation since trading day is multi-tz)
        # For simplicity, use ISO date prefix from UTC ts.
        date = ts[:10]
        if date not in daily:
            daily[date] = {'open': o, 'high': h, 'low': l, 'close': c, 'volume': v, 'first_ts': ts, 'last_ts': ts, 'symbol': sym}
        else:
            d = daily[date]
            if h > d['high']: d['high'] = h
            if l < d['low']: d['low'] = l
            if ts > d['last_ts']: d['close'] = c; d['last_ts'] = ts
            if ts < d['first_ts']: d['open'] = o; d['first_ts'] = ts
            d['volume'] += v

print(f'Loaded {len(daily)} daily bars', file=sys.stderr)

# ── Build feature rows ────────────────────────────────────────────────────
dates_sorted = sorted(d for d in daily if d in pnl_by_date)
feats = []
for i, date in enumerate(dates_sorted):
    d = daily[date]
    dt = datetime.strptime(date, '%Y-%m-%d')
    rng = d['high'] - d['low']
    body = abs(d['close'] - d['open'])
    direction = 1 if d['close'] > d['open'] else -1 if d['close'] < d['open'] else 0
    prev = daily.get(dates_sorted[i-1]) if i > 0 else None
    prev_pnl = pnl_by_date.get(dates_sorted[i-1]) if i > 0 else None
    prev_range = (prev['high'] - prev['low']) if prev else None
    gap = (d['open'] - prev['close']) if prev else None
    # 5-day range
    last5_dates = dates_sorted[max(0, i-5):i]
    last5_bars = [daily[dd] for dd in last5_dates if dd in daily]
    range5 = (max(b['high'] for b in last5_bars) - min(b['low'] for b in last5_bars)) if last5_bars else None
    # Prior-5-day PnL sum
    prev5_pnl = sum(pnl_by_date.get(dd, 0) for dd in last5_dates)
    feats.append({
        'date': date,
        'dow': dt.strftime('%a'),
        'month': dt.strftime('%Y-%m'),
        'pnl': pnl_by_date[date],
        'open': d['open'],
        'high': d['high'],
        'low': d['low'],
        'close': d['close'],
        'range': rng,
        'body': body,
        'direction': direction,
        'volume': d['volume'],
        'prev_pnl': prev_pnl,
        'prev_range': prev_range,
        'gap': gap,
        'range5': range5,
        'prev5_pnl': prev5_pnl,
    })

# ── Summaries ────────────────────────────────────────────────────────────
print()
print('═' * 70)
print('  4-STRATEGY FCFS PORTFOLIO — DAILY PNL ANALYSIS (16 mo)')
print('═' * 70)
print()
print(f'Sessions: {len(feats)}   Total PnL: ${sum(f["pnl"] for f in feats):,.0f}')
print()

# Worst 15 days table
print('WORST 15 DAYS:')
print(f'  {"Date":<10}  {"DoW":<3}  {"PnL":>10}  {"Range":>7}  {"PrevDay":>8}  {"PrevRng":>7}  {"5dPnL":>8}  {"Gap":>7}  {"Dir":>3}')
for f in sorted(feats, key=lambda x: x['pnl'])[:15]:
    print(f'  {f["date"]:<10}  {f["dow"]:<3}  ${f["pnl"]:>9,.0f}  {f["range"]:>7.0f}  ${f.get("prev_pnl", 0) or 0:>7,.0f}  {f.get("prev_range", 0) or 0:>7.0f}  ${f.get("prev5_pnl", 0):>7,.0f}  {f.get("gap", 0) or 0:>7.0f}  {f["direction"]:>+3}')
print()

# Best 15 days table
print('BEST 15 DAYS:')
print(f'  {"Date":<10}  {"DoW":<3}  {"PnL":>10}  {"Range":>7}  {"PrevDay":>8}  {"PrevRng":>7}  {"5dPnL":>8}  {"Gap":>7}  {"Dir":>3}')
for f in sorted(feats, key=lambda x: -x['pnl'])[:15]:
    print(f'  {f["date"]:<10}  {f["dow"]:<3}  ${f["pnl"]:>9,.0f}  {f["range"]:>7.0f}  ${f.get("prev_pnl", 0) or 0:>7,.0f}  {f.get("prev_range", 0) or 0:>7.0f}  ${f.get("prev5_pnl", 0):>7,.0f}  {f.get("gap", 0) or 0:>7.0f}  {f["direction"]:>+3}')
print()

# Day-of-week breakdown
print('DAY-OF-WEEK PNL:')
by_dow = defaultdict(lambda: {'n': 0, 'pnl': 0, 'wins': 0, 'losses': 0})
for f in feats:
    by_dow[f['dow']]['n'] += 1
    by_dow[f['dow']]['pnl'] += f['pnl']
    if f['pnl'] > 0: by_dow[f['dow']]['wins'] += 1
    else: by_dow[f['dow']]['losses'] += 1
for dow in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']:
    if dow in by_dow:
        x = by_dow[dow]
        avg = x['pnl'] / x['n']
        wr = x['wins'] / x['n'] * 100
        print(f'  {dow}  n={x["n"]:>3}  total=${x["pnl"]:>8,.0f}  avg=${avg:>6,.0f}  WR={wr:.0f}%')
print()

# Monthly breakdown
print('MONTHLY PNL:')
by_month = defaultdict(lambda: {'n': 0, 'pnl': 0})
for f in feats:
    by_month[f['month']]['n'] += 1
    by_month[f['month']]['pnl'] += f['pnl']
for m in sorted(by_month):
    x = by_month[m]
    print(f'  {m}  n={x["n"]:>2}  total=${x["pnl"]:>8,.0f}')
print()

# Correlation candidates: bucket worst-day rate by feature
def bucket_analysis(name, key, bins):
    """For each feature bucket, show count and worst-day rate."""
    print(f'{name}:')
    buckets = defaultdict(list)
    for f in feats:
        v = f.get(key)
        if v is None: continue
        for label, lo, hi in bins:
            if lo <= v < hi:
                buckets[label].append(f)
                break
    for label, _, _ in bins:
        bs = buckets[label]
        if not bs:
            print(f'  {label}  n=0')
            continue
        total_pnl = sum(b['pnl'] for b in bs)
        avg = total_pnl / len(bs)
        worst_threshold = -1500
        bad_days = [b for b in bs if b['pnl'] < worst_threshold]
        print(f'  {label}  n={len(bs):>3}  total=${total_pnl:>9,.0f}  avg=${avg:>6,.0f}  bad-days(<-${abs(worst_threshold)})={len(bad_days):>2}')
    print()

bucket_analysis('PREV-DAY PNL bucket', 'prev_pnl', [
    ('<-$3k    ', -1e9, -3000),
    ('-$3k..-$1k', -3000, -1000),
    ('-$1k..0  ', -1000, 0),
    ('0..$1k   ', 0, 1000),
    ('$1k..$3k ', 1000, 3000),
    ('>$3k     ', 3000, 1e9),
])

bucket_analysis('5-DAY ROLLING PNL bucket', 'prev5_pnl', [
    ('<-$5k    ', -1e9, -5000),
    ('-$5k..0  ', -5000, 0),
    ('0..$5k   ', 0, 5000),
    ('$5k..$15k', 5000, 15000),
    ('>$15k    ', 15000, 1e9),
])

bucket_analysis('PREV-DAY RANGE bucket', 'prev_range', [
    ('<200pt   ', 0, 200),
    ('200-400  ', 200, 400),
    ('400-700  ', 400, 700),
    ('700-1000 ', 700, 1000),
    ('>1000    ', 1000, 1e9),
])

bucket_analysis('GAP bucket (open vs prev close)', 'gap', [
    ('<-100pt  ', -1e9, -100),
    ('-100..-30', -100, -30),
    ('-30..+30 ', -30, 30),
    ('+30..+100', 30, 100),
    ('>+100pt  ', 100, 1e9),
])

# Streak analysis — consecutive losing days
print('CONSECUTIVE LOSING DAYS — what does the NEXT day look like?')
streak = 0
streak_next = defaultdict(list)
for i, f in enumerate(feats):
    if f['pnl'] < 0:
        streak += 1
    else:
        # End of streak → record next day was positive
        if streak >= 1 and i > 0:
            streak_next[min(streak, 5)].append(f['pnl'])
        streak = 0
for s in sorted(streak_next):
    n = streak_next[s]
    pos = len([x for x in n if x > 0])
    print(f'  After {s}-day losing streak, next day:  n={len(n):>3}  avg=${sum(n)/len(n):>6,.0f}  pos-rate={pos/len(n)*100:.0f}%')
print()

# Cumulative if we skip bottom N days
print('IF WE PERFECTLY SKIP THE WORST N DAYS:')
sorted_pnls = sorted([f['pnl'] for f in feats])
for skip_n in [5, 10, 15, 20, 30]:
    saved = -sum(sorted_pnls[:skip_n])
    base = sum(sorted_pnls)
    print(f'  Skip worst {skip_n:>2}: save ${saved:>7,.0f}  →  total ${base + saved:>9,.0f}  ({(base+saved)/base*100:.1f}% of FCFS)')
print()

print('IF WE ACCIDENTALLY SKIP THE BEST N DAYS (cost of false-positives):')
for skip_n in [1, 3, 5, 10]:
    cost = sum(sorted_pnls[-skip_n:])
    print(f'  Miss best {skip_n:>2}: cost ${cost:>7,.0f}')
print()
