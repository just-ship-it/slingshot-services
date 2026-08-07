#!/usr/bin/env python3
"""
09b-confluence-analysis.py — Pre-registered dose-response analysis of
confluence stacking over the jv-ict signal universe.

PRIMARY TEST (registered before looking): does 16:00-hold expectancy
(pts/trade, filled trades, no management) increase monotonically with
confluence_count at the PRIMARY band, bins {0-1, 2, 3, >=4}?
The half/2x bands are robustness checks of the SAME hypothesis, not a search
space. If the monotone trend fails at the primary band the hypothesis is
refuted regardless of sub-cells.
"""
import csv
import random
import statistics as st
from collections import defaultdict

RES = '/home/drew/projects/slingshot-services/backtest-engine/research/jv-ict-2026-07'

tags = {(r['signal_ts'], r['side']): r for r in csv.DictReader(open(f'{RES}/confluence-tags.csv'))}
uni = [r for r in csv.DictReader(open(f'{RES}/mfe-mae-universe.csv')) if r['universe'] == 'real']
plc = [r for r in csv.DictReader(open(f'{RES}/mfe-mae-placebo.csv'))]
assert len(uni) == 3600 and len(tags) == 3600

joined = []
for r in uni:
    t = tags[(r['signal_ts'], r['side'])]
    assert abs(float(t['entry']) - float(r['limit_price'])) < 1e-6
    r['cc'] = int(t['confluence_count_primary'])
    r['cc_half'] = int(t['confluence_count_half'])
    r['cc_double'] = int(t['confluence_count_double'])
    r['tag'] = t
    joined.append(r)

FEATS = ['imb_overlap', 'ob_overlap', 'htf_align', 'smt',
         'pdh_pdl_primary', 'daily_open_primary', 'weekly_open_primary',
         'monthly_open_primary', 'prev_week_hl_primary']

BINS = [('0-1', 0, 1), ('2', 2, 2), ('3', 3, 3), ('>=4', 4, 99)]


def binlab(c):
    for lab, lo, hi in BINS:
        if lo <= c <= hi:
            return lab


def wr20(rows):
    """Fraction of fills winning the +20-before--20 race (ties/never = loss)."""
    w = 0
    for r in rows:
        f, a = r['s_to_fav_20'], r['s_to_adv_20']
        if f != '' and (a == '' or float(f) < float(a)):
            w += 1
    return w / len(rows) if rows else float('nan')


def stats(rows):
    if not rows:
        return dict(n=0)
    pnl = [float(r['close_1600_pnl_pts']) for r in rows]
    ratios = []
    for r in rows:
        mfe, mae = float(r['mfe_pts']), float(r['mae_pts'])
        ratios.append(mfe / mae if mae > 0 else float('inf'))
    return dict(n=len(rows), exp=st.mean(pnl), med_pnl=st.median(pnl),
                wr20=wr20(rows), med_ratio=st.median(ratios))


filled = [r for r in joined if r['filled'] == 'true']
print(f'joined {len(joined)} signals, {len(filled)} filled\n')

# ---------------------------------------------------------------- distributions
print('=== confluence_count distribution (primary band) ===')
for pop, name in ((joined, 'all signals'), (filled, 'filled')):
    d = defaultdict(int)
    for r in pop:
        d[r['cc']] += 1
    tot = len(pop)
    print(f'{name:12s} ' + '  '.join(f'{k}:{d[k]}({d[k]/tot:.1%})' for k in sorted(d)))

print('\n=== fill rate by count bin ===')
for lab, lo, hi in BINS:
    sig = [r for r in joined if lo <= r['cc'] <= hi]
    fil = [r for r in sig if r['filled'] == 'true']
    print(f'  {lab:4s} signals {len(sig):5d}  filled {len(fil):5d}  fill_rate {len(fil)/len(sig):.1%}')

print('\n=== count by year (filled) ===')
for y in ('2021', '2022', '2023', '2024'):
    ys = [r for r in filled if r['year'] == y]
    print(f'  {y}: n={len(ys):4d} mean_count={st.mean(r["cc"] for r in ys):.2f} ' +
          ' '.join(f'{lab}:{sum(1 for r in ys if lo<=r["cc"]<=hi)}' for lab, lo, hi in BINS))

# ---------------------------------------------------------------- primary test
def dose_table(rows, key='cc', label=''):
    print(f'--- dose-response {label} (n / expectancy pts / WR20 race / med MFE:MAE) ---')
    exps = []
    for lab, lo, hi in BINS:
        s = stats([r for r in rows if lo <= r[key] <= hi])
        exps.append(s.get('exp'))
        if s['n']:
            note = ' (n<30: suggestive only)' if s['n'] < 30 else ''
            print(f'  {lab:4s} n={s["n"]:5d} exp={s["exp"]:+7.2f} med={s["med_pnl"]:+7.2f} '
                  f'wr20={s["wr20"]:.3f} ratio={s["med_ratio"]:.2f}{note}')
        else:
            print(f'  {lab:4s} n=0')
    mono = all(exps[i + 1] is not None and exps[i] is not None and exps[i + 1] > exps[i]
               for i in range(len(exps) - 1))
    return mono, exps


print('\n=== PRIMARY TEST: 16:00-hold expectancy vs confluence_count (primary band, filled) ===')
mono, exps = dose_table(filled, 'cc', 'OVERALL primary band')
print(f'  monotone increasing across bins: {"YES" if mono else "NO"} -> PRIMARY TEST {"PASS" if mono else "FAIL"}')

print('\n=== per-year (primary band) ===')
for y in ('2021', '2022', '2023', '2024'):
    dose_table([r for r in filled if r['year'] == y], 'cc', y)

print('\n=== robustness bands (same hypothesis) ===')
for key, label in (('cc_half', '0.5x band'), ('cc_double', '2x band')):
    m, _ = dose_table(filled, key, label)
    print(f'  monotone: {"YES" if m else "NO"}')

# ---------------------------------------------------------------- secondary
print('\n=== per-feature marginal lifts (filled; DESCRIPTIVE ONLY — 9 features, multiplicity!) ===')
for f in FEATS:
    on = [r for r in filled if r['tag'][f] == '1']
    off = [r for r in filled if r['tag'][f] == '0']
    if on and off:
        eon, eoff = st.mean(float(r['close_1600_pnl_pts']) for r in on), st.mean(float(r['close_1600_pnl_pts']) for r in off)
        print(f'  {f:22s} on n={len(on):4d} exp={eon:+7.2f} | off n={len(off):4d} exp={eoff:+7.2f} | delta {eon-eoff:+7.2f}')

print('\n=== side split (primary band) ===')
for side in ('buy', 'sell'):
    dose_table([r for r in filled if r['side'] == side], 'cc', side)

# feature coverage notes
n_smt_na = sum(1 for r in joined if r['tag']['smt_status'] == '')
n_htf_na = sum(1 for r in joined if r['tag']['htf1h_structure'] == '')
print(f'\ncoverage: smt_status unavailable (no ES bar) {n_smt_na}/3600; htf structure null {n_htf_na}/3600')

# ---------------------------------------------------------------- oracle recheck
FRICTION = 0.7  # pts/trade, as in 08


def oracle(rows, restrict=None):
    """oracle-1/day on hold PnL; restrict = predicate on row."""
    bydays = defaultdict(list)
    for r in rows:
        if restrict and not restrict(r):
            continue
        bydays[r['trading_day']].append(float(r['close_1600_pnl_pts']) - FRICTION)
    total = sum(max(v) for v in bydays.values())
    return total, len(bydays)


print('\n=== oracle-1/day re-check: picker restricted to confluence_count>=3 trades ===')
t_all, d_all = oracle(filled)
t_c3, d_c3 = oracle(filled, lambda r: r['cc'] >= 3)
print(f'real  unrestricted : {t_all:9.0f} pts over {d_all} days ({t_all/d_all:.1f}/day)')
print(f'real  cc>=3 only   : {t_c3:9.0f} pts over {d_c3} days ({t_c3/d_c3:.1f}/day)')

# null: placebo fills with counts randomly assigned from the real filled count distribution
real_counts = [r['cc'] for r in filled]
plc_filled = defaultdict(list)
for r in plc:
    if r['filled'] == 'true':
        plc_filled[r['universe']].append(r)
rng = random.Random(42)
null_tot, null_perday = [], []
for u, rows in sorted(plc_filled.items()):
    for draw in range(40):
        for r in rows:
            r['cc'] = rng.choice(real_counts)
        t, d = oracle(rows, lambda r: r['cc'] >= 3)
        null_tot.append(t)
        null_perday.append(t / d)
null_tot.sort()
null_perday.sort()
import bisect
pct_t = bisect.bisect_left(null_tot, t_c3) / len(null_tot)
pct_d = bisect.bisect_left(null_perday, t_c3 / d_c3) / len(null_perday)
print(f'placebo null (5 universes x 40 count-assignments = {len(null_tot)}):')
print(f'  totals   min/median/max: {null_tot[0]:.0f} / {null_tot[len(null_tot)//2]:.0f} / {null_tot[-1]:.0f}'
      f'  -> real percentile {pct_t:.2f}')
print(f'  per-day  min/median/max: {null_perday[0]:.1f} / {null_perday[len(null_perday)//2]:.1f} / {null_perday[-1]:.1f}'
      f'  -> real percentile {pct_d:.2f}')

# per-year oracle cc>=3
print('per-year real cc>=3 oracle (pts):')
for y in ('2021', '2022', '2023', '2024'):
    t, d = oracle([r for r in filled if r['year'] == y], lambda r: r['cc'] >= 3)
    print(f'  {y}: {t:8.0f} over {d} days')
