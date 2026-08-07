#!/usr/bin/env python3
"""
Test 1 (2026-07-23): JV's "make sure they all break" gate — ES break-alignment.

Source of rule: YouTube journal 7/10/26 loss post-mortem: "my one rule is always
make sure they all match up. Make sure they all break." Operationalized 2-way
(NQ trade gated on ES having broken same-direction structure recently).

ES break events = jv-ict capture run on ES 15m continuous (identical detector):
event time = metadata.mss_close_ts (close-confirmed MSS), direction = side.

Alignment(W): NQ signal is ALIGNED iff an ES event of the SAME side has
mss_close_ts in [t_ref - W, t_ref], t_ref = fill_ts (filled) / signal_ts (cancelled).
Causal: only uses ES info available at or before NQ commit.

PRE-REGISTERED (before running):
  - Primary window W=60m; sweep {30,60,90,120}m for dose-response.
  - Primary metric: hold-to-16:00 expectancy (close_1600_pnl_pts) aligned vs not.
  - Secondary: +20-before--20 race WR; MFE-MAE.
  - Success = aligned > unaligned on primary, sign stable >=3/4 years,
    AND aligned-vs-unaligned spread on REAL exceeds the same spread on the
    placebo universes (same gate applied to seed placebo entries), pooled AND
    day-weighted. Anything else = refuted.
"""
import json, csv, bisect
from collections import defaultdict

DIR = '.'
W_SWEEP = [30, 60, 90, 120]  # minutes
PRIMARY_W = 60

# --- ES events ---
es = json.load(open(f'{DIR}/signals-es-universe.json'))
events = {'buy': [], 'sell': []}
for s in es['signals']:
    ts = s['metadata'].get('mss_close_ts')
    if ts:
        from datetime import datetime
        t = datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000
        events[s['side']].append(t)
for k in events:
    events[k].sort()
print(f"ES events: buy={len(events['buy'])} sell={len(events['sell'])}")

def aligned(side, t_ref_ms, w_min):
    evs = events[side]
    lo = t_ref_ms - w_min * 60000
    i = bisect.bisect_right(evs, t_ref_ms)
    return i > 0 and evs[i - 1] >= lo

def parse_ts(s):
    from datetime import datetime
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000

def load(fname):
    rows = []
    for r in csv.DictReader(open(fname)):
        if r['filled'] != 'true':
            continue
        t_ref = parse_ts(r['fill_ts'])
        row = {
            'universe': r['universe'], 'day': r['trading_day'], 'side': r['side'],
            'year': r['year'], 'pnl': float(r['close_1600_pnl_pts']),
            'mfe': float(r['mfe_pts']), 'mae': float(r['mae_pts']),
            'race20': (r['s_to_fav_20'] != '' and
                       (r['s_to_adv_20'] == '' or float(r['s_to_fav_20']) < float(r['s_to_adv_20']))),
        }
        for w in W_SWEEP:
            row[f'al{w}'] = aligned(r['side'], t_ref, w)
        rows.append(row)
    return rows

real = load(f'{DIR}/mfe-mae-universe.csv')
plac = load(f'{DIR}/mfe-mae-placebo.csv')
print(f"real fills: {len(real)}; placebo fills: {len(plac)}")

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

def report(rows, label):
    print(f"\n=== {label} ===")
    print(f"{'W':>5} {'n_al':>6} {'EV_al':>8} {'EV_un':>8} {'dEV':>7} {'dwEV_al':>8} {'dwEV_un':>8} {'WR20_al':>8} {'WR20_un':>8}")
    for w in W_SWEEP:
        a = stats([r for r in rows if r[f'al{w}']])
        u = stats([r for r in rows if not r[f'al{w}']])
        print(f"{w:>5} {a['n']:>6} {a['ev']:>8.2f} {u['ev']:>8.2f} {a['ev']-u['ev']:>7.2f} "
              f"{a['dwev']:>8.2f} {u['dwev']:>8.2f} {a['wr20']:>8.3f} {u['wr20']:>8.3f}")
    # per-year at primary window
    print(f"  per-year @W={PRIMARY_W}:")
    for y in ['2021', '2022', '2023', '2024']:
        yr = [r for r in rows if r['year'] == y]
        a = stats([r for r in yr if r[f'al{PRIMARY_W}']])
        u = stats([r for r in yr if not r[f'al{PRIMARY_W}']])
        print(f"    {y}: n_al={a['n']:>4} EV_al={a['ev']:>7.2f} n_un={u['n']:>4} EV_un={u['ev']:>7.2f} dEV={a['ev']-u['ev']:>7.2f}")

report(real, 'REAL universe')
# placebo arms by universe id
plac_ids = sorted(set(r['universe'] for r in plac))
spreads = []
for pid in plac_ids:
    rows = [r for r in plac if r['universe'] == pid]
    a = stats([r for r in rows if r[f'al{PRIMARY_W}']])
    u = stats([r for r in rows if not r[f'al{PRIMARY_W}']])
    spreads.append(a['ev'] - u['ev'])
    print(f"placebo {pid}: n_al={a['n']} dEV@{PRIMARY_W}={a['ev']-u['ev']:.2f} (al {a['ev']:.2f} vs un {u['ev']:.2f})")
ra = stats([r for r in real if r[f'al{PRIMARY_W}']])
ru = stats([r for r in real if not r[f'al{PRIMARY_W}']])
rspread = ra['ev'] - ru['ev']
beat = sum(1 for s in spreads if rspread > s)
print(f"\nREAL dEV@{PRIMARY_W}={rspread:.2f} beats {beat}/{len(spreads)} placebo spreads: {['%.2f' % s for s in spreads]}")

# also: sides split at primary (drift control)
for side in ['buy', 'sell']:
    rows = [r for r in real if r['side'] == side]
    a = stats([r for r in rows if r[f'al{PRIMARY_W}']])
    u = stats([r for r in rows if not r[f'al{PRIMARY_W}']])
    print(f"REAL {side}: n_al={a['n']} EV_al={a['ev']:.2f} vs EV_un={u['ev']:.2f} (dEV {a['ev']-u['ev']:.2f})")

# save tags for reuse (test 2/3 compositing)
with open(f'{DIR}/11-alignment-tags.csv', 'w', newline='') as f:
    wcsv = csv.writer(f)
    wcsv.writerow(['universe', 'day', 'side', 'year'] + [f'al{w}' for w in W_SWEEP])
    for r in real + plac:
        wcsv.writerow([r['universe'], r['day'], r['side'], r['year']] + [int(r[f'al{w}']) for w in W_SWEEP])
print("\nsaved 11-alignment-tags.csv")
