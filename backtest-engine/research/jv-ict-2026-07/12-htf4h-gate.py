#!/usr/bin/env python3
"""
Test 2 (2026-07-23): JV timeframe-hierarchy rule — "larger time frame holds more
value" — as a 4H structure gate. Engine biasMode:'htf4h' capture defines the
aligned subset (causal, R2-verified machinery); membership join by (ts, side).

PRE-REGISTERED: aligned > unaligned on hold-to-1600 EV, pooled AND day-weighted,
sign stable >=3/4 years, AND the improvement must hold PER SIDE (drift control:
a long-only tilt in an up-drifting instrument does not count). Placebo context:
aligned-side EV compared against side-matched placebo EV.
"""
import json, csv
from collections import defaultdict

gated = json.load(open('signals-nq-htf4h.json'))
member = set()
for s in gated['signals']:
    member.add((s['ts'], s['side']))
print(f"htf4h-gated signals: {len(member)}")

def parse_ms(s):
    from datetime import datetime
    return int(datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)

def load(fname):
    rows = []
    for r in csv.DictReader(open(fname)):
        if r['filled'] != 'true':
            continue
        rows.append({
            'universe': r['universe'], 'day': r['trading_day'], 'side': r['side'],
            'year': r['year'], 'pnl': float(r['close_1600_pnl_pts']),
            'race20': (r['s_to_fav_20'] != '' and (r['s_to_adv_20'] == '' or float(r['s_to_fav_20']) < float(r['s_to_adv_20']))),
            'al': (parse_ms(r['signal_ts']), r['side']) in member,
        })
    return rows

real = load('mfe-mae-universe.csv')
plac = load('mfe-mae-placebo.csv')
n_al = sum(1 for r in real if r['al'])
print(f"real fills: {len(real)} | 4H-aligned fills: {n_al}")

def stats(rows):
    n = len(rows)
    if n == 0:
        return dict(n=0, ev=float('nan'), wr20=float('nan'), dwev=float('nan'))
    ev = sum(r['pnl'] for r in rows) / n
    wr = sum(1 for r in rows if r['race20']) / n
    bd = defaultdict(list)
    for r in rows:
        bd[r['day']].append(r['pnl'])
    dw = sum(sum(v) / len(v) for v in bd.values()) / len(bd)
    return dict(n=n, ev=ev, wr20=wr, dwev=dw)

a, u = stats([r for r in real if r['al']]), stats([r for r in real if not r['al']])
print(f"\nPOOLED : al n={a['n']} EV={a['ev']:.2f} dwEV={a['dwev']:.2f} WR20={a['wr20']:.3f}")
print(f"         un n={u['n']} EV={u['ev']:.2f} dwEV={u['dwev']:.2f} WR20={u['wr20']:.3f}  dEV={a['ev']-u['ev']:.2f}")
for y in ['2021', '2022', '2023', '2024']:
    yr = [r for r in real if r['year'] == y]
    ay, uy = stats([r for r in yr if r['al']]), stats([r for r in yr if not r['al']])
    print(f"  {y}: al n={ay['n']:>4} EV={ay['ev']:>7.2f} | un n={uy['n']:>4} EV={uy['ev']:>7.2f} | dEV={ay['ev']-uy['ev']:>7.2f}")
print("\nPER SIDE (drift control), with side-matched placebo EV:")
for side in ['buy', 'sell']:
    rs = [r for r in real if r['side'] == side]
    asd, usd = stats([r for r in rs if r['al']]), stats([r for r in rs if not r['al']])
    ps = stats([r for r in plac if r['side'] == side])
    print(f"  {side:4}: al n={asd['n']:>4} EV={asd['ev']:>7.2f} | un n={usd['n']:>4} EV={usd['ev']:>7.2f} | dEV={asd['ev']-usd['ev']:>7.2f} | placebo({side}) EV={ps['ev']:.2f} n={ps['n']}")
