#!/usr/bin/env python3
"""JV-ICT MFE/MAE universe analysis (feeds 08-MFE-MAE-UNIVERSE.md).

Reads mfe-mae-universe.csv (real) and mfe-mae-placebo.csv (5 seeded placebo
universes) produced by 08-mfe-mae-1s-sim.js. Prints every table used in the
report. Friction for oracle ceilings: $4 round-trip commission + 0.5 pt
slippage per trade = 0.7 pts at $20/pt.
"""
import pandas as pd
import numpy as np

DIR = __file__.rsplit('/', 1)[0]
PT = 20.0
FRICTION_PTS = 0.5 + 4.0 / PT  # 0.7 pts/trade

real = pd.read_csv(f'{DIR}/mfe-mae-universe.csv')
plac = pd.read_csv(f'{DIR}/mfe-mae-placebo.csv')

Q = [0.10, 0.25, 0.50, 0.75, 0.90]


def dist(s):
    q = s.quantile(Q)
    return {f'p{int(x*100)}': round(q[x], 2) for x in Q} | {'mean': round(s.mean(), 2), 'n': len(s)}


def show(title, d):
    print(f'\n== {title} ==')
    if isinstance(d, pd.DataFrame):
        print(d.to_string())
    else:
        print(d)


f = real[real.filled].copy()

print('#' * 70)
print('# A. UNIVERSE')
print('#' * 70)
show('counts', {
    'signals': len(real), 'filled': int(real.filled.sum()),
    'fill_rate': round(real.filled.mean(), 4),
})
show('cancel reasons', real[~real.filled].cancel_reason.value_counts())
show('signals+fills by year', real.groupby('year').agg(signals=('filled', 'size'), fills=('filled', 'sum')))
show('side split (all/filled)', pd.DataFrame({
    'signals': real.side.value_counts(), 'fills': f.side.value_counts()}))
show('signal ET-hour span', real.groupby('signal_hour_et').size())

print('\n' + '#' * 70)
print('# B. MFE / MAE DISTRIBUTIONS (points; $ = pts * 20)')
print('#' * 70)
show('MFE overall', dist(f.mfe_pts))
show('MAE overall', dist(f.mae_pts))
show('MFE by side', pd.DataFrame({s: dist(g.mfe_pts) for s, g in f.groupby('side')}).T)
show('MAE by side', pd.DataFrame({s: dist(g.mae_pts) for s, g in f.groupby('side')}).T)
show('MFE by year', pd.DataFrame({y: dist(g.mfe_pts) for y, g in f.groupby('year')}).T)
show('MAE by year', pd.DataFrame({y: dist(g.mae_pts) for y, g in f.groupby('year')}).T)
show('MFE by entry hour (fill, ET)', pd.DataFrame({h: dist(g.mfe_pts) for h, g in f.groupby('entry_hour_et')}).T)
show('MAE by entry hour (fill, ET)', pd.DataFrame({h: dist(g.mae_pts) for h, g in f.groupby('entry_hour_et')}).T)

print('\n' + '#' * 70)
print('# C. JOINT STRUCTURE')
print('#' * 70)
grid = pd.DataFrame(index=[5, 10, 15, 20, 30, 50], columns=[5, 10, 15, 20, 30, 50], dtype=float)
for X in grid.index:
    for Y in grid.columns:
        tf = f[f'S_to_fav_{X}'.lower()]
        ta = f[f'S_to_adv_{Y}'.lower()]
        # reached +X strictly before -Y (tie on same 1s bar counted as NOT before)
        ok = tf.notna() & (ta.isna() | (tf < ta))
        grid.loc[X, Y] = round(ok.mean() * 100, 1)
show('% of fills reaching +X (rows) before -Y (cols) [ties=fail]', grid)

ratio = (f.mfe_pts / f.mae_pts.replace(0, np.nan)).dropna()
show('MFE:MAE ratio', dist(ratio))
show('% MFE peak before MAE trough', round(f.mfe_before_mae.mean() * 100, 1))
f['min_to_mfe'] = (pd.to_datetime(f.mfe_ts) - pd.to_datetime(f.fill_ts)).dt.total_seconds() / 60
f['min_to_mae'] = (pd.to_datetime(f.mae_ts) - pd.to_datetime(f.fill_ts)).dt.total_seconds() / 60
show('minutes to MFE', dist(f.min_to_mfe))
show('minutes to MAE', dist(f.min_to_mae))
show('minutes held', dist(f.minutes_held))

show('16:00-hold expectancy (pts/trade)', pd.DataFrame({
    'all': dist(f.close_1600_pnl_pts),
    'buy': dist(f[f.side == 'buy'].close_1600_pnl_pts),
    'sell': dist(f[f.side == 'sell'].close_1600_pnl_pts)}).T)
show('16:00-hold expectancy by year x side (mean pts, n)',
     f.groupby(['year', 'side']).close_1600_pnl_pts.agg(['mean', 'sum', 'count']).round(2))

show('excursions by IMB confluence tag', f.groupby('imb_confluence').agg(
    n=('mfe_pts', 'size'), med_mfe=('mfe_pts', 'median'), med_mae=('mae_pts', 'median'),
    mean_pnl=('close_1600_pnl_pts', 'mean')).round(2))
show('excursions by OB overlap tag', f.groupby('ob_confluence').agg(
    n=('mfe_pts', 'size'), med_mfe=('mfe_pts', 'median'), med_mae=('mae_pts', 'median'),
    mean_pnl=('close_1600_pnl_pts', 'mean')).round(2))

print('\n' + '#' * 70)
print('# D. DAILY ORACLE CEILINGS (real universe)')
print('#' * 70)
all_days = real.trading_day.nunique()
fill_days = f.trading_day.nunique()
per_day = f.groupby('trading_day').size()
show('signals/day', {
    'trading_days_with_signals': all_days,
    'days_with_>=1_fill': fill_days,
    'days_with_0_fills': all_days - fill_days,
    'fills_per_fill-day mean': round(per_day.mean(), 2),
    'fills_per_fill-day median': per_day.median(),
    'max': int(per_day.max()),
})


def oracle(df, col, k=1, worst=False, friction=FRICTION_PTS):
    """Sum over days of best-k (or worst-1) `col` minus friction per trade."""
    out = {}
    for y, g in df.groupby('year'):
        v = g.groupby('trading_day')[col].apply(
            lambda s: (s.nsmallest(k) if worst else s.nlargest(k)).sum() - friction * min(k, len(s)))
        out[y] = round(v.sum(), 1)
    out['total'] = round(sum(out.values()), 1)
    return out


tbl = pd.DataFrame({
    'oracle1_hold': oracle(f, 'close_1600_pnl_pts', 1),
    'oracle2_hold': oracle(f, 'close_1600_pnl_pts', 2),
    'oracle1_mfe': oracle(f, 'mfe_pts', 1),
    'oracle2_mfe': oracle(f, 'mfe_pts', 2),
    'antioracle1_hold': oracle(f, 'close_1600_pnl_pts', 1, worst=True),
}).T
tbl['total_$'] = (tbl.total * PT).round(0)
show('oracle ceilings (pts/yr, net of 0.7pt/trade friction)', tbl)

print('\n' + '#' * 70)
print('# E. PLACEBO ORACLE REFERENCE (5 seeds)')
print('#' * 70)
pf = plac[plac.filled].copy()
rows = []
for u, g in pf.groupby('universe'):
    rows.append({
        'universe': u, 'signals': int((plac.universe == u).sum()), 'fills': len(g),
        'fill_rate': round((plac.universe == u).mean() and len(g) / (plac.universe == u).sum(), 3),
        'mean_hold_pnl': round(g.close_1600_pnl_pts.mean(), 2),
        'med_mfe': round(g.mfe_pts.median(), 1), 'med_mae': round(g.mae_pts.median(), 1),
        'oracle1_hold_total': oracle(g, 'close_1600_pnl_pts', 1)['total'],
        'oracle1_mfe_total': oracle(g, 'mfe_pts', 1)['total'],
    })
prow = pd.DataFrame(rows).set_index('universe')
show('placebo universes', prow)
show('placebo oracle1_hold total: mean/min/max',
     (round(prow.oracle1_hold_total.mean(), 1), prow.oracle1_hold_total.min(), prow.oracle1_hold_total.max()))
show('placebo oracle1_mfe total: mean/min/max',
     (round(prow.oracle1_mfe_total.mean(), 1), prow.oracle1_mfe_total.min(), prow.oracle1_mfe_total.max()))
show('REAL oracle1_hold total', oracle(f, 'close_1600_pnl_pts', 1)['total'])
show('REAL oracle1_mfe total', oracle(f, 'mfe_pts', 1)['total'])
# per-year real vs placebo mean
py = pd.DataFrame({
    'real_o1_hold': oracle(f, 'close_1600_pnl_pts', 1),
    'placebo_o1_hold_mean': pd.DataFrame(
        [oracle(g, 'close_1600_pnl_pts', 1) for _, g in pf.groupby('universe')]).mean().round(1),
    'real_o1_mfe': oracle(f, 'mfe_pts', 1),
    'placebo_o1_mfe_mean': pd.DataFrame(
        [oracle(g, 'mfe_pts', 1) for _, g in pf.groupby('universe')]).mean().round(1),
})
show('per-year real vs placebo-mean oracle1', py)

print('\n' + '#' * 70)
print('# F. SELECTION FEASIBILITY (is best-of-day predictable ex ante?)')
print('#' * 70)
multi = f[f.trading_day.isin(per_day[per_day >= 2].index)].copy()
multi['is_best'] = multi.groupby('trading_day').close_1600_pnl_pts.transform('max') == multi.close_1600_pnl_pts
base = multi.is_best.mean()
show('base rate P(best) among multi-trade days', round(base, 3))
for feat in ['side', 'entry_hour_et', 'imb_confluence', 'ob_confluence', 'model']:
    t = multi.groupby(feat).is_best.agg(['mean', 'count']).round(3)
    t['lift'] = (t['mean'] / base).round(2)
    show(f'P(best | {feat})', t)
multi['stop_bucket'] = pd.qcut(multi.stop_distance, 4, labels=['q1_small', 'q2', 'q3', 'q4_large'])
t = multi.groupby('stop_bucket', observed=True).is_best.agg(['mean', 'count']).round(3)
t['lift'] = (t['mean'] / base).round(2)
show('P(best | sweep-leg stop-distance quartile)', t)
