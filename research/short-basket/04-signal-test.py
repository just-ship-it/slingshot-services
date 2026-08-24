#!/usr/bin/env python3
"""
Short-basket replication: parity vs GammaLab + full-history signal test.

Parity (overlap 2025-08 -> now): corr of our daily basket returns vs
GammaLab's (weighted & equal). High corr = construction replicated.

Signal (full history 2020-06 -> now): excess1 = ret_e − beta_roll×spy_ret,
beta from trailing 60 sessions (PAST ONLY — honest). vs fwd SPY close-close
H∈{1,3,5}. Spearman IC + circular-shift placebo p + per-year ICs + terciles.
"""
import csv, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
OURS = os.path.join(HERE, 'our_basket_daily.csv')
GL = os.path.join(HERE, '..', '..', 'backtest-engine', 'data', 'gammalab', 'short_basket_daily.csv')
SPY = os.path.join(HERE, '..', '..', 'backtest-engine', 'data', 'macro', 'spy_1d.csv')
NQ = os.path.join(HERE, '..', '..', 'backtest-engine', 'data', 'macro', 'nq_1d.csv')
BETA_WIN = 60

def spearman(a, b):
    def rk(v):
        o = sorted(range(len(v)), key=lambda i: v[i]); r = [0] * len(v)
        for i, j in enumerate(o):
            r[j] = i
        return r
    ra, rb = rk(a), rk(b)
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va = math.sqrt(sum((x - ma) ** 2 for x in ra))
    vb = math.sqrt(sum((y - mb) ** 2 for y in rb))
    return cov / (va * vb) if va and vb else float('nan')

def pearson(a, b):
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    va = math.sqrt(sum((x - ma) ** 2 for x in a))
    vb = math.sqrt(sum((y - mb) ** 2 for y in b))
    return cov / (va * vb) if va and vb else float('nan')

def pval(s, r, obs):
    n = len(s); w = 0
    for k in range(1, n):
        if abs(spearman(s[k:] + s[:k], r)) >= abs(obs):
            w += 1
    return w / (n - 1)

ours = {r['date']: (float(r['ret_w']), float(r['ret_e']))
        for r in csv.DictReader(open(OURS))}
spy = {}
for row in csv.reader(open(SPY)):
    if row[0] == 'date' or len(row) < 6:
        continue
    spy[row[0]] = float(row[5])
spy_dates = sorted(spy)
idx = {d: i for i, d in enumerate(spy_dates)}
spy_ret = {spy_dates[i]: spy[spy_dates[i]] / spy[spy_dates[i - 1]] - 1
           for i in range(1, len(spy_dates))}

# ---- parity vs GammaLab ----
gl = [(r['date'], float(r['weighted_index']), float(r['equal_weighted_index']))
      for r in csv.DictReader(open(GL))]
gl_ret = {}
for i in range(1, len(gl)):
    d0, w0, e0 = gl[i - 1]
    d1, w1, e1 = gl[i]
    gl_ret[d1] = (w1 / w0 - 1, e1 / e0 - 1)
common = sorted(set(gl_ret) & set(ours))
if common:
    gw = [gl_ret[d][0] for d in common]; ow = [ours[d][0] for d in common]
    ge = [gl_ret[d][1] for d in common]; oe = [ours[d][1] for d in common]
    print(f'== parity vs GammaLab (n={len(common)}, {common[0]} -> {common[-1]}) ==')
    print(f'  weighted daily-return corr: {pearson(gw, ow):.3f}')
    print(f'  equal    daily-return corr: {pearson(ge, oe):.3f}')

# ---- signal on full history ----
dates = sorted(set(ours) & set(spy_ret))
sig = {}
hist = []  # (basket_e, spy) trailing for rolling beta
for d in dates:
    e = ours[d][1]; s = spy_ret[d]
    if len(hist) >= BETA_WIN:
        win = hist[-BETA_WIN:]
        me = sum(x for x, _ in win) / BETA_WIN
        ms = sum(y for _, y in win) / BETA_WIN
        cov = sum((x - me) * (y - ms) for x, y in win)
        var = sum((y - ms) ** 2 for _, y in win)
        beta = cov / var if var else 0.0
        sig[d] = e - beta * s
    hist.append((e, s))
print(f'\nsignal days (after {BETA_WIN}d beta warmup): {len(sig)}')

# NQ target: nq_1d bars are labeled by session-OPEN date; bar D's RTH is the
# next business day (verified: calendar-mapped NQ/SPY daily corr 0.941).
import datetime as _dt
def _nextb(d):
    x = _dt.date.fromisoformat(d) + _dt.timedelta(days=1)
    while x.weekday() >= 5:
        x += _dt.timedelta(days=1)
    return x.isoformat()
nq_close = {}
for row in csv.reader(open(NQ)):
    if row[0] == 'date' or len(row) < 6:
        continue
    nq_close[_nextb(row[0])] = float(row[5])
nq_dates = sorted(nq_close)
nq_idx = {d: i for i, d in enumerate(nq_dates)}

for label, closes, cdates, cidx in (('SPY', spy, spy_dates, idx),
                                    ('NQ', nq_close, nq_dates, nq_idx)):
    for H in (1, 3, 5):
        ss, rr, dd = [], [], []
        for d, v in sorted(sig.items()):
            i = cidx.get(d)
            if i is not None and i + H < len(cdates):
                ss.append(v)
                rr.append(closes[cdates[i + H]] / closes[d] - 1)
                dd.append(d)
        if len(ss) < 100:
            continue
        ic = spearman(ss, rr)
        p = pval(ss, rr, ic)
        srt = sorted(zip(ss, rr)); t = len(srt) // 3
        lo = sum(r for _, r in srt[:t]) / t * 100
        hi = sum(r for _, r in srt[-t:]) / t * 100
        print(f'\n== {label} H={H} (n={len(ss)}) ==  IC {ic:+.3f}  p={p:.3f}  '
              f'terciles lo {lo:+.3f}% hi {hi:+.3f}%')
        for y in sorted({d[:4] for d in dd}):
            ys = [s for s, d in zip(ss, dd) if d[:4] == y]
            yr = [r for r, d in zip(rr, dd) if d[:4] == y]
            if len(ys) >= 30:
                print(f'   {y}: IC {spearman(ys, yr):+.3f} (n={len(ys)})')
