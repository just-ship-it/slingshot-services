#!/usr/bin/env python3
"""VP-DEFENDED-WICK Phase 1 — daily RTH volume profiles from the minute feature library.

Builds prior-day reference levels for the defended-wick study: POC / VAH / VAL
(70% value area, standard two-bin expansion from POC) plus RTH high/low, from
uniform-spread 1m volume-at-price (each minute bar's volume spread evenly over
[low, high] in 1pt bins). Primary contract per ET date = dominant symbol by
summed volume in the minute library (spreads already dropped there).

Sources: data/features/pilotfish_minute_features_2021-22.csv (2021-01-17→2022-12-30)
         data/features/pilotfish_minute_features.csv          (2023-01-02→2026-06-15)

Output: research/vp-defended-wick/output/nq_daily_profiles.csv
        et_date,symbol,poc,vah,val,rth_high,rth_low,rth_vol,nbars
        (levels are RAW contract prices for that date's primary contract)

KNOWABILITY: every level for trading day D is computed from day D-1 RTH bars
only — fully sealed by 16:00 ET on D-1, available all of day D.
"""
import csv
import os
from collections import defaultdict

BASE = '/home/drew/projects/slingshot-services/backtest-engine'
SRCS = [
    f'{BASE}/data/features/pilotfish_minute_features_2021-22.csv',
    f'{BASE}/data/features/pilotfish_minute_features.csv',
]
OUTDIR = f'{BASE}/research/vp-defended-wick/output'
OUT = f'{OUTDIR}/nq_daily_profiles.csv'
BIN = 1.0  # 1pt bins

os.makedirs(OUTDIR, exist_ok=True)

# pass 1+2 fused: per date, per symbol accumulate RTH bars; pick dominant symbol at date end.
# Files are chronological, so process date groups as they complete.

def value_area(bins, poc_key, total, pct=0.70):
    """Standard VA expansion: from POC, add the larger of the two adjacent bins
    (pairwise) until cumulative >= pct of total. Returns (val, vah)."""
    lo = hi = poc_key
    cum = bins.get(poc_key, 0.0)
    keys = bins
    target = total * pct
    while cum < target:
        up1, up2 = keys.get(hi + 1, 0.0), keys.get(hi + 2, 0.0)
        dn1, dn2 = keys.get(lo - 1, 0.0), keys.get(lo - 2, 0.0)
        up, dn = up1 + up2, dn1 + dn2
        if up <= 0 and dn <= 0:
            break
        if up >= dn:
            cum += up
            hi += 2
        else:
            cum += dn
            lo -= 2
    return lo * BIN, hi * BIN


def flush(date, per_sym, wr):
    if not per_sym:
        return
    # dominant symbol by RTH volume
    sym = max(per_sym, key=lambda s: per_sym[s]['vol'])
    d = per_sym[sym]
    if d['vol'] <= 0 or d['nbars'] < 60:  # skip holidays/broken days (<1h of RTH bars)
        return
    bins = d['bins']
    total = sum(bins.values())
    poc_key = max(bins, key=lambda k: (bins[k], -abs(k - d['mid_key'])))
    val, vah = value_area(bins, poc_key, total)
    wr.writerow([date, sym, f'{poc_key * BIN:.2f}', f'{vah:.2f}', f'{val:.2f}',
                 f'{d["hi"]:.2f}', f'{d["lo"]:.2f}', int(d['vol']), d['nbars']])


out = open(OUT, 'w', newline='')
wr = csv.writer(out)
wr.writerow(['et_date', 'symbol', 'poc', 'vah', 'val', 'rth_high', 'rth_low', 'rth_vol', 'nbars'])

cur_date = None
per_sym = None
ndays = 0

for src in SRCS:
    with open(src) as f:
        rd = csv.reader(f)
        header = next(rd)
        ix = {c: i for i, c in enumerate(header)}
        i_date, i_hhmm, i_sym = ix['et_date'], ix['et_hhmm'], ix['symbol']
        i_h, i_l, i_v = ix['high'], ix['low'], ix['volume']
        for row in rd:
            hhmm = row[i_hhmm]
            if not ('09:30' <= hhmm < '16:00'):
                continue
            date = row[i_date]
            if date != cur_date:
                if cur_date is not None:
                    flush(cur_date, per_sym, wr)
                    ndays += 1
                cur_date = date
                per_sym = {}
            sym = row[i_sym]
            try:
                h, l, v = float(row[i_h]), float(row[i_l]), float(row[i_v])
            except ValueError:
                continue
            if v <= 0 or h < l:
                continue
            d = per_sym.get(sym)
            if d is None:
                d = per_sym[sym] = {'bins': defaultdict(float), 'vol': 0.0,
                                    'hi': -1e18, 'lo': 1e18, 'nbars': 0, 'mid_key': 0}
            k0 = int(l // BIN)
            k1 = int(h // BIN)
            per = v / (k1 - k0 + 1)
            b = d['bins']
            for k in range(k0, k1 + 1):
                b[k] += per
            d['vol'] += v
            d['nbars'] += 1
            if h > d['hi']:
                d['hi'] = h
            if l < d['lo']:
                d['lo'] = l
            d['mid_key'] = int(((d['hi'] + d['lo']) / 2) // BIN)

flush(cur_date, per_sym, wr)
ndays += 1
out.close()
print(f'wrote {OUT}: {ndays} days')
