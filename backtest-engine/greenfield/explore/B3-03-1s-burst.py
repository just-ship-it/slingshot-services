#!/usr/bin/env python3
"""B3 stage 3: metric (d) 1s burst speed, on a subsample (2023-2024 events).

For each event, read the final 10-minute approach [t-9m .. t] from the 1s file
via the minute index (contiguous byte range, one read per event), keep only the
event's primary symbol, and compute:
  burst30 = max over the window of dir*(close_now - close_{<=30s ago}) / atr
  burst60 = same with 60s
Appends columns to B3-events-burst.csv (subsample only).
"""
import json
import os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ONESEC = '/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1s.csv'
IDX = ONESEC.replace('.csv', '.index.json')

print('loading index...')
with open(IDX) as f:
    idx = json.load(f)['minutes']

ev = pd.read_csv(os.path.join(HERE, 'B3-events.csv'))
sub = ev[(ev['year'] >= 2023) & (ev['year'] <= 2024)].copy()
print(f'subsample events: {len(sub)}')

f = open(ONESEC, 'rb')

def read_window(min_epochs):
    """Contiguous byte range covering the given minute epochs (sec)."""
    entries = [idx.get(str(m * 1000)) for m in min_epochs]
    entries = [e for e in entries if e]
    if not entries:
        return b''
    lo = min(e['offset'] for e in entries)
    hi = max(e['offset'] + e['length'] for e in entries)
    f.seek(lo)
    return f.read(hi - lo)

def burst(ev_row):
    t_open = int(ev_row.epoch)          # event bar open epoch sec
    mins = [t_open - 60 * k for k in range(9, -1, -1)]
    blob = read_window(mins)
    if not blob:
        return np.nan, np.nan
    sym = ev_row.sym.encode()
    side = ev_row.side
    ts_list, c_list = [], []
    for line in blob.split(b'\n'):
        if not line or not line.endswith(sym):
            continue
        parts = line.split(b',')
        if parts[9] != sym:
            continue
        # ts_event ISO: epoch = minute epoch from index range; parse H:M:S
        tss = parts[0]
        mm_epoch = None
        # cheap parse: seconds within day from fixed positions
        try:
            import calendar  # noqa - avoid full datetime parse; use slicing
            y, mo, d = int(tss[0:4]), int(tss[5:7]), int(tss[8:10])
            hh, mi, ss = int(tss[11:13]), int(tss[14:16]), int(tss[17:19])
        except ValueError:
            continue
        import datetime as _dt
        ep = int(_dt.datetime(y, mo, d, hh, mi, ss,
                              tzinfo=_dt.timezone.utc).timestamp())
        if ep < mins[0] or ep >= t_open + 60:
            continue
        ts_list.append(ep)
        c_list.append(float(parts[7]))
    if len(ts_list) < 30:
        return np.nan, np.nan
    ts_a = np.asarray(ts_list)
    c_a = np.asarray(c_list)
    order = np.argsort(ts_a, kind='stable')
    ts_a, c_a = ts_a[order], c_a[order]
    out = []
    for W in (30, 60):
        j0 = np.searchsorted(ts_a, ts_a - W, side='left')
        disp = side * (c_a - c_a[j0])
        out.append(disp.max() / ev_row.atr)
    return out[0], out[1]

b30 = np.full(len(sub), np.nan)
b60 = np.full(len(sub), np.nan)
for k, row in enumerate(sub.itertuples()):
    b30[k], b60[k] = burst(row)
    if k % 2000 == 0:
        print(f'  {k}/{len(sub)}')
sub['burst30'] = b30
sub['burst60'] = b60
sub.to_csv(os.path.join(HERE, 'B3-events-burst.csv'), index=False)
ok = sub.dropna(subset=['burst30'])
print(f'done, valid: {len(ok)}/{len(sub)}')

from scipy.stats import spearmanr
OUT = 'hold_p35_b5'
for m in ('burst30', 'burst60'):
    q = pd.qcut(ok[m], 10, labels=False, duplicates='drop')
    prof = ok.groupby(q)[OUT].mean()
    rho, _ = spearmanr(prof.index, prof.values)
    print(f'{m}: rho={rho:+.2f} deciles ' + ' '.join(f'{v:.3f}' for v in prof))
    print(f'  corr with arr5: {np.corrcoef(ok[m], ok["arr5"])[0,1]:+.2f}, '
          f'with rv60: {np.corrcoef(ok[m], ok["rv60"])[0,1]:+.2f}')
# incremental value within arr5 top quintile
q80 = ok['arr5'].quantile(0.8)
top = ok[ok['arr5'] >= q80]
tq = pd.qcut(top['burst60'], 4, labels=False, duplicates='drop')
prof = top.groupby(tq)[OUT].mean()
print(f'within arr5 top-quintile (base {top[OUT].mean():.3f}), burst60 quartiles: '
      + ' '.join(f'{v:.3f}' for v in prof))
# and the reverse: arr5 within burst60 top quintile
qb = ok['burst60'].quantile(0.8)
topb = ok[ok['burst60'] >= qb]
ta = pd.qcut(topb['arr5'], 4, labels=False, duplicates='drop')
prof = topb.groupby(ta)[OUT].mean()
print(f'within burst60 top-quintile (base {topb[OUT].mean():.3f}), arr5 quartiles: '
      + ' '.join(f'{v:.3f}' for v in prof))
