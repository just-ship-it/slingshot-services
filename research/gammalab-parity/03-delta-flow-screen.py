#!/usr/bin/env python3
"""
GammaLab SPX delta-flow daily change vs next-day SPY returns — first screen.

Signal: net_delta is a running cumulative of classified SPX dealer delta flow.
The tradable candidate is the DAILY CHANGE (d1), known at day D close.
Tested against day D+1 SPY open->close and D close->D+1 close returns.

Cleaning:
  - drop exchange-holiday rows their pipeline stamped anyway
  - drop re-basing breaks (|d1| > BREAK_X * median |d1|) — recomputes, not flow
  - drop the final (live, unsettled) row

Stats: Spearman IC, sign hit rate, tercile spread; p-value via circular-shift
placebo (structure-preserving). n is ~60 — this is a SCREEN, not validation.
"""
import csv, math, os, statistics as st

HERE = os.path.dirname(__file__)
ND_CSV = os.path.join(HERE, '..', '..', 'backtest-engine', 'data', 'gammalab', 'spx_net_delta_daily.csv')
SPY_CSV = os.path.join(HERE, '..', '..', 'backtest-engine', 'data', 'macro', 'spy_1d.csv')
HOLIDAYS = {'2026-05-25', '2026-06-19', '2026-07-03'}
BREAK_X = 8

# ---- load + clean signal ----
nd = [(r['date'], float(r['net_delta'])) for r in csv.DictReader(open(ND_CSV))
      if r['date'] not in HOLIDAYS]
nd = nd[:-1]  # drop live unsettled last row
d1 = [(nd[i][0], nd[i][1] - nd[i-1][1]) for i in range(1, len(nd))]  # date D, change into D close
med = st.median(abs(x) for _, x in d1)
breaks = [(d, x) for d, x in d1 if abs(x) > BREAK_X * med]
clean = [(d, x) for d, x in d1 if abs(x) <= BREAK_X * med]
print(f'signal days: {len(d1)}, breaks dropped: {[(d, f"{x/1e6:+.0f}M") for d, x in breaks]}')
print(f'clean n={len(clean)}, median |d1|={med/1e6:.1f}M')

# ---- load SPY ----
spy = {}
for row in csv.reader(open(SPY_CSV)):
    if row[0] == 'date' or len(row) < 6:
        continue
    spy[row[0]] = (float(row[2]), float(row[5]))  # open, close
spy_dates = sorted(spy)
nxt = {d: spy_dates[i+1] for i, d in enumerate(spy_dates[:-1])}

# ---- join: signal at D -> returns on D+1 ----
rows = []
for d, x in clean:
    if d not in spy or d not in nxt:
        continue
    n = nxt[d]
    o1, c1 = spy[n]
    _, c0 = spy[d]
    rows.append((d, x, (c1-o1)/o1*100, (c1-c0)/c0*100))  # oc = D+1 open->close, cc = close->close
print(f'joined n={len(rows)} ({rows[0][0]} -> {rows[-1][0]})')

def spearman(a, b):
    def rk(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0]*len(v)
        for i, j in enumerate(order):
            r[j] = i
        return r
    ra, rb = rk(a), rk(b)
    ma, mb = sum(ra)/len(ra), sum(rb)/len(rb)
    cov = sum((x-ma)*(y-mb) for x, y in zip(ra, rb))
    va = math.sqrt(sum((x-ma)**2 for x in ra)); vb = math.sqrt(sum((y-mb)**2 for y in rb))
    return cov/(va*vb) if va and vb else float('nan')

def shift_pval(sig, ret, obs):
    n = len(sig)
    worse = 0; total = 0
    for s in range(1, n):  # all circular shifts
        ic = spearman(sig[s:]+sig[:s], ret)
        total += 1
        if abs(ic) >= abs(obs):
            worse += 1
    return worse/total

for tag, idx in (('D+1 open->close', 2), ('D close->D+1 close', 3)):
    sig = [r[1] for r in rows]; ret = [r[idx] for r in rows]
    ic = spearman(sig, ret)
    hits = sum(1 for s, r in zip(sig, ret) if (s > 0) == (r > 0))
    p = shift_pval(sig, ret, ic)
    srt = sorted(zip(sig, ret))
    t = len(srt)//3
    lo = sum(r for _, r in srt[:t])/t
    hi = sum(r for _, r in srt[-t:])/t
    print(f'\n== {tag} ==')
    print(f'  spearman IC : {ic:+.3f}  (circular-shift p={p:.2f})')
    print(f'  sign hit    : {hits}/{len(rows)} ({hits/len(rows)*100:.0f}%)')
    print(f'  tercile     : lo-third {lo:+.3f}%/d  hi-third {hi:+.3f}%/d  spread {hi-lo:+.3f}%')
