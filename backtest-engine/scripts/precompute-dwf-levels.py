#!/usr/bin/env python3
"""Precompute daily levels for the dealer-wall-fade (DWF) strategy.

One row per (day, wall): the day's GEX wall set (first snapshot at/after
09:45 ET from the causal cbbo GEX — same convention as the research episode
study) joined to the flow-signed dealer inventory (as-of prior close).

Output: data/features/dwf_levels.csv
  date,level_nq,strike,kind,dg_sign,dte0_share

The engine loads this via --dwf-levels-file; the strategy trades only
dg_sign=+1 walls (dealer-long gamma) by default.
"""
import csv
import glob
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
GEX_DIR = BASE / 'data/gex/nq-cbbo-causal'
FLOW = BASE / 'data/flow/qqq'
OUT = BASE / 'data/features/dwf_levels.csv'
ET = ZoneInfo('America/New_York')

rows = []
dealer = {}
for fp in sorted(glob.glob(str(FLOW / 'dealer-strikes-*.csv'))):
    d8 = fp.split('-')[-1].split('.')[0]
    day = f'{d8[:4]}-{d8[4:6]}-{d8[6:8]}'
    m = {}
    for r in csv.DictReader(open(fp)):
        g = float(r['dealer_gamma'])
        if g == 0:
            continue
        tot = (int(r['pos_dte0_5']) + int(r['pos_dte6_30']) + int(r['pos_dte31p']))
        m[round(float(r['strike']))] = (1 if g > 0 else -1,
                                        int(r['pos_dte0_5']) / tot if tot else 0.0)
    dealer[day] = m

for fp in sorted(glob.glob(str(GEX_DIR / 'nq_gex_*.json'))):
    d = json.load(open(fp))
    day = d['metadata']['date']
    dg = dealer.get(day)
    if not dg:
        continue
    for s in d.get('data', []):
        t = datetime.fromisoformat(s['timestamp'].replace('Z', '+00:00'))
        if t.astimezone(ET).strftime('%H:%M') < '09:45':
            continue
        mult = s.get('multiplier') or 0
        if not mult:
            break
        for kind, key in (('sup', 'support'), ('res', 'resistance')):
            for lv in (s.get(key) or []):
                if not lv:
                    continue
                strike = round(lv / mult)
                if strike in dg:
                    sign, share = dg[strike]
                    rows.append([day, round(lv, 2), strike, kind, sign,
                                 round(share, 4)])
        break

OUT.parent.mkdir(parents=True, exist_ok=True)
with open(OUT, 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['date', 'level_nq', 'strike', 'kind', 'dg_sign', 'dte0_share'])
    w.writerows(rows)
days = len({r[0] for r in rows})
pos = sum(1 for r in rows if r[4] == 1)
print(f'{len(rows)} levels across {days} days ({pos} dealer-long) -> {OUT}')
