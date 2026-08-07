#!/usr/bin/env python3
"""
Task 3 + Task 4 analysis for the R:R geometry study.
Consumes bracket-results.csv (structural + management schemes, real + 5
placebos), rr-levels.json, and mfe-mae-universe.csv (threshold crossings for
the conservation matrix). Emits markdown tables to 10-analysis-out.md and
the per-signal deliverable rr-brackets.csv.

Friction accounting (consistent across all tables):
  gross pnl already includes 0.5 pt adverse slip on stop/lock/flat exits
  (targets are exact limits); net = gross - 0.2 pt commission ($4 at $20/pt).
  Conservation matrix (from 08 crossing data): loss = -(S+0.5), win = +T,
  flat = close_1600_pnl - 0.5; all minus 0.2.
"""
import json, os, math
import numpy as np
import pandas as pd

DIR = os.path.dirname(os.path.abspath(__file__))
COMM = 0.2
OUT = []
def emit(s=''):
    OUT.append(s)
    print(s)

df = pd.read_csv(os.path.join(DIR, 'bracket-results.csv'), low_memory=False)
df['year'] = df.trading_day.str[:4]
fills = df[df.filled].copy()

GRID_S = [20, 25, 30]; GRID_T = [50, 100, 150, 200]; GRID_L = [20, 25, 30]
SCHEMES = ['sb40', 'sb45', 'sb50'] + \
    [f'g{s}_{t}_{L}' for s in GRID_S for t in GRID_T for L in GRID_L] + \
    [f'z25_{t}_25' for t in GRID_T] + ['ms']

for sc in SCHEMES:
    fills[f'{sc}_net'] = fills[f'{sc}_p'] - COMM

def pf(x):
    pos = x[x > 0].sum(); neg = -x[x < 0].sum()
    return pos / neg if neg > 0 else float('inf')

def stats_block(sub, col):
    x = sub[col]
    n = len(x)
    if n == 0: return dict(n=0, wr=np.nan, ev=np.nan, pf=np.nan)
    return dict(n=n, wr=(x > 0).mean() * 100, ev=x.mean(), pf=pf(x))

def daily_profile(sub, pnl_col, exit_col):
    """One-at-a-time gating, chronological by fill_ts."""
    s = sub.sort_values('fill_ts')
    busy_until = 0; taken = []
    for r in s.itertuples():
        ft = pd.Timestamp(r.fill_ts).value // 10**6
        if ft >= busy_until:
            taken.append(r)
            busy_until = getattr(r, exit_col)
    t = pd.DataFrame({'day': [r.trading_day for r in taken],
                      'pnl': [getattr(r, pnl_col) for r in taken]})
    if len(t) == 0: return None
    d = t.groupby('day').pnl.sum().sort_index()
    green = d[d > 0]; red = d[d < 0]
    # max consecutive red (over traded days)
    mx = cur = 0
    for v in d.values:
        cur = cur + 1 if v < 0 else 0
        mx = max(mx, cur)
    return dict(trades=len(t), days=len(d), green_pct=100 * (d > 0).mean(),
                med_green=green.median() if len(green) else np.nan,
                med_red=red.median() if len(red) else np.nan,
                worst_red=red.min() if len(red) else np.nan,
                max_consec_red=mx)

# ================= 1. RR distribution =================
emit('## RR distribution (real universe, all 3,600 signals)\n')
lv = df[df.universe == 'real']
for buf, col in [('4.0', 'rr40'), ('4.5', 'rr45'), ('5.0', 'rr50')]:
    q = lv[col].quantile([.1, .25, .5, .75, .9])
    emit(f'- buffer {buf}: p10 {q[.1]:.2f} | p25 {q[.25]:.2f} | median {q[.5]:.2f} | p75 {q[.75]:.2f} | p90 {q[.9]:.2f} | '
         f'>=1.5: {(lv[col]>=1.5).mean()*100:.1f}% | >=2: {(lv[col]>=2).mean()*100:.1f}%')
emit()
emit('rr45 deciles by side / by year:\n')
emit('| slice | n | p10 | p25 | p50 | p75 | p90 | %>=2 |')
emit('|---|---|---|---|---|---|---|---|')
for name, sub in [('buy', lv[lv.side == 'buy']), ('sell', lv[lv.side == 'sell'])] + \
                 [(y, lv[lv.year == y]) for y in sorted(lv.year.unique())]:
    q = sub.rr45.quantile([.1, .25, .5, .75, .9])
    emit(f'| {name} | {len(sub)} | {q[.1]:.2f} | {q[.25]:.2f} | {q[.5]:.2f} | {q[.75]:.2f} | {q[.9]:.2f} | {(sub.rr45>=2).mean()*100:.1f} |')
emit()
emit(f'tp tag: external {(lv.tp_tag=="external").sum()}, legLow fallback {(lv.tp_tag=="legLow").sum()}\n')

# ================= 2. PRIMARY: dose-response =================
BINS = [('<1', 0, 1), ('1-1.5', 1, 1.5), ('1.5-2', 1.5, 2), ('2-3', 2, 3), ('>3', 3, 1e9)]

def dose_table(sub, rrcol, netcol, label):
    emit(f'### {label}\n')
    emit('| rr bin | n | WR% | EV net (pts) | PF | 2021 EV(n) | 2022 EV(n) | 2023 EV(n) | 2024 EV(n) |')
    emit('|---|---|---|---|---|---|---|---|---|')
    for bname, lo, hi in BINS:
        b = sub[(sub[rrcol] >= lo) & (sub[rrcol] < hi)]
        st = stats_block(b, netcol)
        yr = []
        for y in ['2021', '2022', '2023', '2024']:
            by = b[b.year == y]
            yr.append(f'{by[netcol].mean():+.1f} ({len(by)})' if len(by) else '— (0)')
        emit(f'| {bname} | {st["n"]} | {st["wr"]:.1f} | {st["ev"]:+.2f} | {st["pf"]:.2f} | ' + ' | '.join(yr) + ' |')
    emit()

emit('## PRIMARY — dose-response, structural brackets (buffer 4.5)\n')
real_f = fills[fills.universe == 'real']
plc_f = fills[fills.universe != 'real']
dose_table(real_f, 'rr45', 'sb45_net', 'REAL, buffer 4.5 (sb45)')
dose_table(plc_f, 'rr45', 'sb45_net', 'PLACEBO pooled (5 seeds), buffer 4.5')

emit('Placebo per-seed span for key subsets (buffer 4.5):\n')
emit('| subset | real EV | real PF | placebo EV span | placebo PF span | seeds beating real (EV) |')
emit('|---|---|---|---|---|---|')
for label, lo in [('rr>=1.5', 1.5), ('rr>=2', 2.0), ('rr>=3', 3.0)]:
    r = real_f[real_f.rr45 >= lo]
    rs = stats_block(r, 'sb45_net')
    evs, pfs, beat = [], [], 0
    for u in ['p1', 'p2', 'p3', 'p4', 'p5']:
        p = plc_f[(plc_f.universe == u) & (plc_f.rr45 >= lo)]
        st = stats_block(p, 'sb45_net')
        evs.append(st['ev']); pfs.append(st['pf'])
        if st['ev'] >= rs['ev']: beat += 1
    emit(f'| {label} | {rs["ev"]:+.2f} (n={rs["n"]}) | {rs["pf"]:.2f} | {min(evs):+.2f}..{max(evs):+.2f} | {min(pfs):.2f}..{max(pfs):.2f} | {beat}/5 |')
emit()

emit('Robustness buffers:\n')
dose_table(real_f, 'rr40', 'sb40_net', 'REAL, buffer 4.0 (sb40)')
dose_table(real_f, 'rr50', 'sb50_net', 'REAL, buffer 5.0 (sb50)')

# ================= 3. JV-profile daily comparison =================
emit('## JV-profile daily P&L (one-at-a-time gating, structural b45)\n')
emit('| portfolio | universe | trades taken | traded days | green% | med green | med red | worst red | max consec red |')
emit('|---|---|---|---|---|---|---|---|---|')
for label, lo in [('rr>=1.5', 1.5), ('rr>=2', 2.0), ('all fills', 0.0)]:
    r = real_f[real_f.rr45 >= lo]
    dp = daily_profile(r, 'sb45_net', 'sb45_x')
    emit(f'| {label} | real | {dp["trades"]} | {dp["days"]} | {dp["green_pct"]:.1f} | {dp["med_green"]:+.1f} | {dp["med_red"]:+.1f} | {dp["worst_red"]:+.1f} | {dp["max_consec_red"]} |')
    g, mg, mr, wr_, mc = [], [], [], [], []
    for u in ['p1', 'p2', 'p3', 'p4', 'p5']:
        p = plc_f[(plc_f.universe == u) & (plc_f.rr45 >= lo)]
        d2 = daily_profile(p, 'sb45_net', 'sb45_x')
        if d2: g.append(d2['green_pct']); mg.append(d2['med_green']); mr.append(d2['med_red']); wr_.append(d2['worst_red']); mc.append(d2['max_consec_red'])
    emit(f'| {label} | placebo mean (5) | — | — | {np.mean(g):.1f} | {np.mean(mg):+.1f} | {np.mean(mr):+.1f} | {np.mean(wr_):+.1f} | {np.mean(mc):.1f} |')
emit()

# ================= 4. Conservation-law bracket matrix =================
emit('## Conservation matrix — fixed target x stop on ALL real fills (from 08 crossing data)\n')
old = pd.read_csv(os.path.join(DIR, 'mfe-mae-universe.csv'))
of = old[old.filled].copy()
of['year'] = of.trading_day.str[:4]
of['fill_ms'] = pd.to_datetime(of.fill_ts).astype('int64') // 10**6
TH = [5, 10, 15, 20, 30, 50]
emit('Per cell: WR% / EV net pts / green-day% / med red day (gated). n=1390 fills each.\n')
flag_cells = []
for metric in range(1):
    pass
emit('| tgt\\stop | ' + ' | '.join(str(s) for s in TH) + ' |')
emit('|---|' + '---|' * len(TH))
for T in TH:
    cells = []
    for S in TH:
        tf = of[f's_to_fav_{T}']; ta = of[f's_to_adv_{S}']
        win = tf.notna() & (ta.isna() | (tf < ta))
        loss = ta.notna() & (tf.isna() | (ta <= tf))
        flat = ~win & ~loss
        pnl = np.where(win, T, np.where(loss, -(S + 0.5), of.close_1600_pnl_pts - 0.5)) - COMM
        # exit ts for gating
        exit_s = np.where(win, tf, np.where(loss, ta, of.minutes_held * 60))
        tmp = of[['trading_day', 'fill_ms']].copy()
        tmp['pnl'] = pnl
        tmp['exit_ms'] = of.fill_ms + (exit_s * 1000).astype('int64')
        tmp = tmp.sort_values('fill_ms')
        busy = 0; rows = []
        for r in tmp.itertuples():
            if r.fill_ms >= busy:
                rows.append((r.trading_day, r.pnl)); busy = r.exit_ms
        d = pd.DataFrame(rows, columns=['day', 'pnl']).groupby('day').pnl.sum()
        red = d[d < 0]
        wrp = win.mean() * 100; ev = pnl.mean(); gp = (d > 0).mean() * 100
        mred = red.median() if len(red) else 0
        cells.append(f'{wrp:.0f}% / {ev:+.2f} / {gp:.0f}% / {mred:+.0f}')
        if ev >= 0 and gp >= 65 and (abs(mred) <= np.median(d[d>0]) if len(d[d>0]) else False):
            flag_cells.append((T, S, wrp, ev, gp, mred))
    emit(f'| **+{T}** | ' + ' | '.join(cells) + ' |')
emit()
if flag_cells:
    emit('FLAGGED cells (EV>=0 AND green%>=65 AND |med red| <= med green): ' + str(flag_cells))
else:
    emit('No cell satisfies (EV net >= 0) AND (green-day% >= 65) AND (median red small vs median green).')
emit()

# ================= 5. Management-scheme grid (Task 4) =================
emit('## Management grid — stop x target x lockTrigger (lockOffset +2), real vs placebo\n')
emit('Per cell: n / T%(win) / L%(scratch) / S%(loss) / F%(flat) / EV net / PF / EV by year 21-24 / placebo pooled EV\n')
emit('| cell | n | T% | L% | S% | F% | EV | PF | 21 | 22 | 23 | 24 | plc EV | plc PF |')
emit('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
best = []
for s in GRID_S:
    for t in GRID_T:
        for L in GRID_L:
            sc = f'g{s}_{t}_{L}'
            x = real_f[f'{sc}_net']; r_ = real_f[f'{sc}_r']
            n = len(x)
            pcts = {k: (r_ == k).mean() * 100 for k in 'TLSF'}
            yr = [real_f[real_f.year == y][f'{sc}_net'].mean() for y in ['2021', '2022', '2023', '2024']]
            pev = plc_f[f'{sc}_net'].mean(); ppf = pf(plc_f[f'{sc}_net'])
            ev = x.mean(); p_ = pf(x)
            emit(f'| {s}/{t}/{L} | {n} | {pcts["T"]:.0f} | {pcts["L"]:.0f} | {pcts["S"]:.0f} | {pcts["F"]:.0f} | {ev:+.2f} | {p_:.2f} | '
                 + ' | '.join(f'{v:+.1f}' for v in yr) + f' | {pev:+.2f} | {ppf:.2f} |')
            best.append((ev, sc, p_, yr, pev))
best.sort(reverse=True)
emit()
emit(f'Best real cell by EV: {best[0][1]} EV {best[0][0]:+.2f} PF {best[0][2]:.2f} yr {["%+.1f"%v for v in best[0][3]]} (placebo pooled EV {best[0][4]:+.2f})')
emit()
emit('lockOffset 0 robustness (stop 25, lock 25) + structural mgmt variant:\n')
emit('| cell | n | T% | L% | S% | F% | EV | PF | plc EV | plc PF |')
emit('|---|---|---|---|---|---|---|---|---|---|')
for sc in [f'z25_{t}_25' for t in GRID_T] + ['ms']:
    x = real_f[f'{sc}_net']; r_ = real_f[f'{sc}_r']
    pcts = {k: (r_ == k).mean() * 100 for k in 'TLSF'}
    emit(f'| {sc} | {len(x)} | {pcts["T"]:.0f} | {pcts["L"]:.0f} | {pcts["S"]:.0f} | {pcts["F"]:.0f} | {x.mean():+.2f} | {pf(x):.2f} | {plc_f[f"{sc}_net"].mean():+.2f} | {pf(plc_f[f"{sc}_net"]):.2f} |')
emit()

# daily profile for selected mgmt cells
emit('Daily profile (gated) for representative mgmt cells, real universe:\n')
emit('| cell | trades | days | green% | med green | med red | worst red | max consec red |')
emit('|---|---|---|---|---|---|---|---|')
for sc in ['g25_100_25', 'g20_50_20', 'g30_200_30', best[0][1], 'ms']:
    dp = daily_profile(real_f, f'{sc}_net', f'{sc}_x')
    emit(f'| {sc} | {dp["trades"]} | {dp["days"]} | {dp["green_pct"]:.1f} | {dp["med_green"]:+.1f} | {dp["med_red"]:+.1f} | {dp["worst_red"]:+.1f} | {dp["max_consec_red"]} |')
    g = []
    for u in ['p1','p2','p3','p4','p5']:
        d2 = daily_profile(plc_f[plc_f.universe==u], f'{sc}_net', f'{sc}_x')
        if d2: g.append((d2['green_pct'], d2['med_green'], d2['med_red'], d2['worst_red'], d2['max_consec_red']))
    ga = np.mean([v[0] for v in g]); emit(f'| {sc} placebo mean | — | — | {ga:.1f} | {np.mean([v[1] for v in g]):+.1f} | {np.mean([v[2] for v in g]):+.1f} | {np.mean([v[3] for v in g]):+.1f} | {np.mean([v[4] for v in g]):.1f} |')
emit()

# ================= 6. worked example =================
hi = real_f[(real_f.rr45 >= 3) & (real_f.tp_tag == 'external')].sort_values('rr45', ascending=False)
ex = hi.iloc[len(hi)//2]
emit('## Worked example (high-rr trade)\n')
for k in ['signal_ts', 'trading_day', 'side', 'limit_price', 'stop45', 'target_level', 'tp_tag', 'rr45', 'fill_ts', 'sb45_r', 'sb45_p']:
    emit(f'- {k}: {ex[k]}')
emit()

# ================= deliverable CSV =================
cols = ['signal_ts', 'trading_day', 'side', 'limit_price', 'filled', 'cancel_reason',
        'fill_ts', 'stop45', 'target_level', 'tp_tag', 'rr40', 'rr45', 'rr50',
        'sb40_r', 'sb40_p', 'sb45_r', 'sb45_p', 'sb45_x', 'sb50_r', 'sb50_p']
real_all = df[df.universe == 'real']
real_all[cols].to_csv(os.path.join(DIR, 'rr-brackets.csv'), index=False)
emit(f'wrote rr-brackets.csv ({len(real_all)} rows)')

with open(os.path.join(DIR, '10-analysis-out.md'), 'w') as f:
    f.write('\n'.join(OUT) + '\n')
