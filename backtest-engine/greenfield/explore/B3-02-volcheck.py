#!/usr/bin/env python3
"""B3 stage 2: is arrival speed just a vol proxy?
Within each day-vol tercile and each rv60 (intraday vol) tercile, re-check
the arr5 quintile profile.  Also test arr5_rel = arr5 / rv60 (speed relative
to the last hour's own churn)."""
import os
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
ev = pd.read_csv(os.path.join(HERE, 'B3-events.csv'))
dev = ev[ev['year'] <= 2024].copy()

dayvol = ev.groupby('trade_date')['rv60'].mean()
terc = pd.qcut(dayvol, 3, labels=['loV', 'midV', 'hiV'])
ev['dv'] = ev['trade_date'].map(dict(zip(dayvol.index, terc)))
dev['dv'] = dev.index.map(ev['dv'])

OUT = 'hold_p35_b5'
for regvar, name in [('dv', 'day-vol tercile'), (None, 'rv60 tercile')]:
    print(f'\n=== arr5 quintiles WITHIN {name} (dev 2021-24) ===')
    if regvar is None:
        dev['reg'] = pd.qcut(dev['rv60'], 3, labels=['loV', 'midV', 'hiV'])
    else:
        dev['reg'] = dev[regvar]
    for r in ['loV', 'midV', 'hiV']:
        d = dev[dev['reg'] == r]
        q = pd.qcut(d['arr5'], 5, labels=False, duplicates='drop')
        prof = d.groupby(q)[OUT].agg(['mean', 'size'])
        rho, _ = spearmanr(prof.index, prof['mean'])
        print(f'  {r}: base={d[OUT].mean():.3f} rho={rho:+.2f} '
              f'quintiles ' + ' '.join(f'{v:.3f}' for v in prof['mean']) +
              f'  (n={len(d)})')

print('\n=== arr5_rel = arr5 / rv60 (burstiness, vol-stripped) ===')
ev['arr5_rel'] = ev['arr5'] / ev['rv60'].clip(lower=0.05)
dev = ev[ev['year'] <= 2024]
cuts = dev['arr5_rel'].quantile(np.arange(0.1, 1.0, 0.1)).to_numpy()
ev['dec'] = np.searchsorted(cuts, ev['arr5_rel'], side='right')
d = ev[ev['year'] <= 2024]
prof = d.groupby('dec')[OUT].mean()
rho, _ = spearmanr(prof.index, prof.values)
print(f'dev: rho={rho:+.2f} deciles ' + ' '.join(f'{v:.3f}' for v in prof))
print(f'corr(arr5_rel, rv60) = {np.corrcoef(d["arr5_rel"], d["rv60"])[0,1]:+.2f}')
for y in sorted(ev['year'].unique()):
    yy = ev[ev['year'] == y]
    print(f'  {y}: base={yy[OUT].mean():.3f} top-decile={yy[yy["dec"]==9][OUT].mean():.3f} '
          f'(n_top={len(yy[yy["dec"]==9])})')

print('\n=== joint: arr5 top-quintile lift within regime, per year ===')
q80 = dev['arr5'].quantile(0.8)
for y in sorted(ev['year'].unique()):
    yy = ev[ev['year'] == y].copy()
    yy['reg'] = pd.qcut(yy['rv60'], 3, labels=['loV', 'midV', 'hiV'])
    parts = []
    for r in ['loV', 'midV', 'hiV']:
        d2 = yy[yy['reg'] == r]
        b = d2[OUT].mean(); t = d2[d2['arr5'] >= q80][OUT].mean()
        parts.append(f'{r}:{b:.2f}->{t:.2f}')
    print(f'  {y}: ' + '  '.join(parts))
