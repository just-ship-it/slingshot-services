#!/usr/bin/env python3
"""B3 stage 1: arrival-speed metric bake-off on B3-events.csv.

Judged per metric:
  - decile profile of P(hold) (primary outcome hold_p35_b5; also a25_b5)
  - monotonicity: Spearman rho of decile index vs decile hold rate
  - top-decile lift vs base, per-year sign stability (2021..2026)
  - per-hour-bucket top-quintile lift (ON 18-02, early 02-9:30, RTH am,
    RTH pm, close)
  - vol-regime independence: corr(metric, rv60) and top-decile membership
    across day-vol terciles
Deciles are computed on 2021-2024 only (design window); 2025-26 events are
scored against those same cut points (as live use would).
"""
import os
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
ev = pd.read_csv(os.path.join(HERE, 'B3-events.csv'))
ev['neg_dep'] = -ev['dep_bars']          # so "higher = faster" for all metrics
METRICS = ['arr3', 'arr5', 'arr10', 'arr15', 'eff10', 'accel', 'neg_dep']
OUTS = ['hold_p35_b5', 'hold_a25_b5', 'hold_p20_b5']

dev = ev[ev['year'] <= 2024]
print(f'events: total {len(ev)}, dev(2021-24) {len(dev)}')

def hourbucket(m):
    if m >= 18 * 60 or m < 2 * 60: return 'ON_18-02'
    if m < 9 * 60 + 30: return 'early_02-0930'
    if m < 12 * 60: return 'RTH_am'
    if m < 15 * 60: return 'RTH_pm'
    return 'close_15+'
ev['hb'] = ev['et_min'].map(hourbucket)

# day-vol terciles (on atr-normalized daily rv proxy: mean rv60 per trade_date)
dayvol = ev.groupby('trade_date')['rv60'].mean()
terc = pd.qcut(dayvol, 3, labels=['loV', 'midV', 'hiV'])
ev['dayvol_terc'] = ev['trade_date'].map(dict(zip(dayvol.index, terc)))

for m in METRICS:
    cuts = dev[m].quantile(np.arange(0.1, 1.0, 0.1)).to_numpy()
    ev[f'{m}_dec'] = np.searchsorted(cuts, ev[m].to_numpy(), side='right')

print('\n=== DECILE PROFILES (dev window, hold_p35_b5) ===')
base = {o: dev[o].mean() for o in OUTS}
print('base rates dev:', {k: round(v, 3) for k, v in base.items()})
summary = []
for m in METRICS:
    d = ev[ev['year'] <= 2024]
    prof = d.groupby(f'{m}_dec')['hold_p35_b5'].agg(['mean', 'size'])
    rho, _ = spearmanr(prof.index, prof['mean'])
    top = prof['mean'].iloc[-1]
    # per-year top-decile lift sign (all years incl 25/26 as OOS check)
    signs = []
    for y in sorted(ev['year'].unique()):
        yy = ev[ev['year'] == y]
        by = yy['hold_p35_b5'].mean()
        ty = yy[yy[f'{m}_dec'] == 9]['hold_p35_b5'].mean()
        signs.append('+' if ty > by else '-')
    # hour buckets: top-quintile (dec 8-9) lift sign
    hsigns = []
    for hb in ['ON_18-02', 'early_02-0930', 'RTH_am', 'RTH_pm', 'close_15+']:
        hh = d[d['hb'] == hb]
        bh = hh['hold_p35_b5'].mean()
        th = hh[hh[f'{m}_dec'] >= 8]['hold_p35_b5'].mean()
        hsigns.append('+' if th > bh else '-')
    volcorr = np.corrcoef(d[m], d['rv60'])[0, 1]
    tv = d[d[f'{m}_dec'] == 9]['dayvol_terc'].value_counts(normalize=True)
    profile = ' '.join(f'{v:.2f}' for v in prof['mean'])
    print(f'\n{m}: rho={rho:+.2f} top10={top:.3f} (base {base["hold_p35_b5"]:.3f})')
    print(f'  deciles: {profile}')
    print(f'  yearly top-decile sign 21-26: {"".join(signs)}   '
          f'hour-bucket top-quintile sign: {"".join(hsigns)}')
    print(f'  corr(m,rv60)={volcorr:+.2f}  top-decile dayvol split '
          f'lo/mid/hi: {tv.get("loV",0):.2f}/{tv.get("midV",0):.2f}/{tv.get("hiV",0):.2f}')
    summary.append((m, rho, top - base['hold_p35_b5'], ''.join(signs), volcorr))

print('\n=== secondary outcome hold_a25_b5 (vol-scaled retrace), dev ===')
for m in METRICS:
    d = ev[ev['year'] <= 2024]
    prof = d.groupby(f'{m}_dec')['hold_a25_b5'].mean()
    rho, _ = spearmanr(prof.index, prof.values)
    print(f'{m}: rho={rho:+.2f} deciles ' + ' '.join(f'{v:.3f}' for v in prof))

print('\n=== ranking (dev): metric, mono-rho, top-decile lift, yr signs, volcorr ===')
for m, rho, lift, s, vc in sorted(summary, key=lambda x: -abs(x[1])):
    print(f'{m:8s} rho={rho:+.2f} lift={lift:+.3f} yrs={s} volcorr={vc:+.2f}')
