#!/usr/bin/env python3
"""Test 3 analysis: scale-in + TP ladder management profiles, real vs placebo.
PnL units: MNQ contract-points (1 pt x 1 MNQ = $2). NQ-equiv pts = /10.
Net view: commission $1.50 per MNQ round-trip = 0.75 contract-pts."""
import csv, re
from collections import defaultdict

ARMS = ['A', 'B', 'C', 'D']
ARMDESC = {'A': 'base10 +BE', 'B': 'scale 5+5 +BE', 'C': 'scale 5+5 noBE', 'D': 'base10 noBE'}
COMM = 0.75  # contract-points per contract round-trip

rows = [r for r in csv.DictReader(open('scalein-results.csv')) if r['filled'] == 'true']
print(f"fills: {len(rows)}")

# ---------- invariant checks ----------
bad = 0
for r in rows:
    for arm in ARMS:
        ex = r[f'{arm}_exits']
        entered = 10 if arm in ('A', 'D') else (10 if r[f'{arm}_e2'] == '1' else 5)
        exit_sz = sum(int(m.group(1)) for m in re.finditer(r'(?:T1|T2|S|L|F):(\d+)@', ex))
        if exit_sz != entered:
            bad += 1
# A==D when TP1 never hit (no BE effect): exits of A lack T1
mism = 0
na = 0
for r in rows:
    if 'T1:' not in r['A_exits']:
        na += 1
        if abs(float(r['A_pnl']) - float(r['D_pnl'])) > 1e-6:
            mism += 1
print(f"invariants: size-mismatch={bad}, A!=D-when-no-TP1: {mism}/{na}")

def contracts_traded(exits_str, entered):
    return entered  # round trips = entered contracts

def analyze(rows, arm, label, years=None):
    daily = defaultdict(float)
    tot = 0.0
    n = 0
    net_tot = 0.0
    for r in rows:
        if years and r['trading_day'][:4] not in years:
            continue
        pnl = float(r[f'{arm}_pnl'])
        entered = 10 if arm in ('A', 'D') else (10 if r[f'{arm}_e2'] == '1' else 5)
        net = pnl - COMM * entered
        daily[r['trading_day']] += net
        tot += pnl
        net_tot += net
        n += 1
    days = sorted(daily)
    vals = [daily[d] for d in days]
    green = [v for v in vals if v > 0]
    red = [v for v in vals if v <= 0]
    gw = sum(green); gl = -sum(red)
    pf = gw / gl if gl > 0 else float('inf')
    # max DD on daily equity
    eq = 0.0; peak = 0.0; dd = 0.0
    for v in vals:
        eq += v
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    med = lambda v: sorted(v)[len(v) // 2] if v else float('nan')
    yrs = (int(days[-1][:4]) - int(days[0][:4]) + 1) if days else 1
    usd_yr = net_tot * 2 / yrs
    print(f"  {arm} {ARMDESC[arm]:<15} n={n:>5} EV/tr={tot/n:>7.2f}c-pts net={net_tot/n:>7.2f} | "
          f"days={len(vals):>4} green={len(green)/len(vals)*100:>5.1f}% medG={med(green):>6.1f} medR={med(red):>7.1f} "
          f"dailyPF={pf:>5.2f} maxDD={dd:>7.0f}c-pts (${dd*2:,.0f}) ${usd_yr:>+9,.0f}/yr")

print("\n=== REAL universe (2021-2024, 10 MNQ ≈ 1 NQ) ===")
real = [r for r in rows if r['universe'] == 'real']
for arm in ARMS:
    analyze(real, arm, 'real')
print("\n  per-year, arm B:")
for y in ['2021', '2022', '2023', '2024']:
    print(f"  {y}:", end='')
    analyze(real, 'B', 'real', years={y})

print("\n=== PLACEBO universes, arm B (same management on noise) ===")
for pid in ['p1', 'p2', 'p3', 'p4', 'p5']:
    pr = [r for r in rows if r['universe'] == pid]
    print(f"  {pid}:", end='')
    analyze(pr, 'B', pid)

print("\n=== PLACEBO arm A (single-entry) ===")
for pid in ['p1', 'p2', 'p3', 'p4', 'p5']:
    pr = [r for r in rows if r['universe'] == pid]
    print(f"  {pid}:", end='')
    analyze(pr, 'A', pid)

# e2 fill rate + TP hit profile, real arm B
e2f = sum(1 for r in real if r['B_e2'] == '1')
t1 = sum(1 for r in real if 'T1:' in r['B_exits'])
t2 = sum(1 for r in real if 'T2:' in r['B_exits'])
sl = sum(1 for r in real if re.search(r'\bS:', r['B_exits']))
lk = sum(1 for r in real if re.search(r'\bL:', r['B_exits']))
fl = sum(1 for r in real if 'F:' in r['B_exits'])
n = len(real)
print(f"\nREAL arm B composition: e2 filled {e2f}/{n} ({e2f/n*100:.0f}%), TP1 hit {t1/n*100:.0f}%, "
      f"TP2 hit {t2/n*100:.0f}%, initial-stop {sl/n*100:.0f}%, BE-stop {lk/n*100:.0f}%, EOD-flat {fl/n*100:.0f}%")
