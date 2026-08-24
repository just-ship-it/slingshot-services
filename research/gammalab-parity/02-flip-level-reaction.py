#!/usr/bin/env python3
"""
Were GammaLab's flip levels "meaningful" — did price react at them?

Design (point-in-time honest):
  - GammaLab flip published at close of day D  ->  tested as a level on day D+1.
    (Same-day tests are contaminated: their trade-classified gamma moves with
    the day's own flow.)
  - Ours: NQ-space gamma_flip from our 16:00 ET snapshot of day D, same D+1 test.
  - GammaLab QQQ-space flip converted to NQ via the multiplier from our D
    16:00 snapshot.

Metric A — touch reaction:
  First RTH (09:35-15:30 ET) 1m bar where low<=L<=high. Approach side = prior
  bar close vs L. reaction = approach_sign * (L - close[t+K]) for K in {30,60}
  minutes, i.e. positive = level repelled price. Bounce rate = share positive.

Metric B — open above/below level vs RTH direction (regime read):
  sign(09:30 open - L) vs sign(15:59 close - 09:30 open) agreement.

Placebo: for each real level, 4 side-matched offset levels at +-0.3%, +-0.6%
of the level, scored identically on the same day. This is a screening study
(reaction magnitudes / rates), not a fill-simulated strategy — no WR/PF claims.

Uses raw-contract NQ 1m with per-hour primary-contract filter (levels are
raw-contract space).
"""
import csv, json, os, math
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
from collections import defaultdict

ROOT = os.path.join(os.path.dirname(__file__), '..', '..', 'backtest-engine', 'data')
GL_CSV = os.path.join(ROOT, 'gammalab', 'qqq_gex_daily.csv')
OURS_DIR = os.path.join(ROOT, 'gex', 'nq-cbbo-causal')
OHLCV = os.path.join(ROOT, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv')
ET = ZoneInfo('America/New_York')
PLACEBO_OFFS = (-0.006, -0.003, 0.003, 0.006)

# ---------- levels ----------
def snap_1600(d):
    p = os.path.join(OURS_DIR, f'nq_gex_{d}.json')
    if not os.path.exists(p):
        return None
    data = json.load(open(p))['data']
    target = datetime.fromisoformat(f'{d}T16:00:00').replace(tzinfo=ET)
    best, bdt = None, None
    for s in data:
        if s.get('multiplier') is None:
            continue
        dt = abs((datetime.fromisoformat(s['timestamp']) - target).total_seconds())
        if best is None or dt < bdt:
            best, bdt = s, dt
    return best if best and bdt <= 3600 else None

gl_rows = list(csv.DictReader(open(GL_CSV)))
gl_dates = [r['date'] for r in gl_rows]
levels = []  # (test_day, gl_level_nq or None, our_level_nq or None)
for i, r in enumerate(gl_rows[:-1]):
    d, nxt = r['date'], gl_rows[i+1]['date']
    if nxt > '2026-06-16':
        continue
    snap = snap_1600(d)
    if snap is None:
        continue
    gl_nq = float(r['gamma_flip']) * snap['multiplier']
    our_nq = snap['gamma_flip']  # may be None (no zero-crossing)
    levels.append((nxt, gl_nq, our_nq))
print(f'level-days: {len(levels)} (test days {levels[0][0]} -> {levels[-1][0]})')

# ---------- price data ----------
want = {t for t, _, _ in levels}
bars_by_day = defaultdict(list)  # day -> [(et_minute_dt, o,h,l,c,v,symbol)]
with open(OHLCV) as f:
    f.readline()
    for line in f:
        p = line.split(',')
        ts = p[0]
        d10 = ts[:10]
        # ET date can differ from UTC date only for evening hours; RTH is safe:
        # 09:30-16:00 ET == 13:30-20:00 UTC (EDT window here, Mar-Jun)
        if d10 not in want:
            continue
        sym = p[9].strip()
        if '-' in sym:
            continue
        hh = int(ts[11:13])
        if not (13 <= hh <= 20):
            continue
        dt = datetime.fromisoformat(ts[:19]).replace(tzinfo=ZoneInfo('UTC')).astimezone(ET)
        if dt.hour < 9 or (dt.hour == 9 and dt.minute < 30) or dt.hour >= 16:
            continue
        bars_by_day[d10].append((dt, float(p[4]), float(p[5]), float(p[6]), float(p[7]), int(p[8]), sym))

# per-hour primary contract filter
def primary_filter(bars):
    volbyhr = defaultdict(lambda: defaultdict(int))
    for b in bars:
        volbyhr[b[0].hour][b[6]] += b[5]
    out = []
    for b in bars:
        prim = max(volbyhr[b[0].hour].items(), key=lambda kv: kv[1])[0]
        if b[6] == prim:
            out.append(b)
    out.sort(key=lambda b: b[0])
    return out

for d in list(bars_by_day):
    bars_by_day[d] = primary_filter(bars_by_day[d])
print(f'price days loaded: {len(bars_by_day)}')

# ---------- scoring ----------
def score_level(bars, L):
    """returns dict or None if never touched / insufficient data"""
    res = {}
    # metric B: open side vs day direction
    o, c = bars[0][1], bars[-1][4]
    if o != L:
        res['open_above'] = o > L
        res['day_up'] = c > o
    # metric A: first touch 09:35-15:30, need prior bar + fwd 60m
    for i in range(5, len(bars)):
        dt, _, h, l, cl = bars[i][0], *bars[i][1:5]
        if dt.hour == 15 and dt.minute > 30:
            break
        if l <= L <= h:
            prior = bars[i-1][4]
            if prior == L:
                return res or None
            side = 1 if prior < L else -1   # +1 approaching from below
            for K, tag in ((30, 'r30'), (60, 'r60')):
                j = i + K
                if j < len(bars):
                    # positive = repelled back toward approach side
                    res[tag] = side * (L - bars[j][4])
            res['touched'] = True
            return res
    return res or None

def agg(tag, results):
    xs = [r[tag] for r in results if tag in r]
    if not xs:
        return 'n=0'
    m = sum(xs)/len(xs)
    sd = math.sqrt(sum((x-m)**2 for x in xs)/max(len(xs)-1, 1))
    se = sd/math.sqrt(len(xs))
    br = sum(1 for x in xs if x > 0)/len(xs)
    return f'n={len(xs)} mean={m:+.1f}pts se={se:.1f} bounce%={br*100:.0f}'

def run(name, use):
    real, plac = [], []
    for tday, gl_nq, our_nq in levels:
        L = gl_nq if use == 'gl' else our_nq
        if L is None or tday not in bars_by_day or len(bars_by_day[tday]) < 100:
            continue
        r = score_level(bars_by_day[tday], L)
        if r:
            real.append(r)
        for off in PLACEBO_OFFS:
            rp = score_level(bars_by_day[tday], L * (1 + off))
            if rp:
                plac.append(rp)
    print(f'\n== {name} ==')
    for tag in ('r30', 'r60'):
        print(f'  {tag}  real   : {agg(tag, real)}')
        print(f'  {tag}  placebo: {agg(tag, plac)}')
    for label, rs in (('real', real), ('placebo', plac)):
        ab = [r for r in rs if 'open_above' in r]
        if ab:
            agree = sum(1 for r in ab if r['open_above'] == r['day_up'])
            print(f'  open-side->day-dir {label}: {agree}/{len(ab)} ({agree/len(ab)*100:.0f}%)')

run('GammaLab flip (D EOD -> D+1)', 'gl')
run('Our flip (D 16:00 -> D+1)', 'our')

# head-to-head on divergence days: both defined, both touched
print('\n== head-to-head (days both flips defined) ==')
h2h = []
for tday, gl_nq, our_nq in levels:
    if our_nq is None or tday not in bars_by_day or len(bars_by_day[tday]) < 100:
        continue
    rg = score_level(bars_by_day[tday], gl_nq)
    ro = score_level(bars_by_day[tday], our_nq)
    if rg and ro and 'r30' in rg and 'r30' in ro:
        h2h.append((tday, gl_nq - our_nq, rg['r30'], ro['r30']))
print(f'  both touched: n={len(h2h)}')
if h2h:
    gw = sum(1 for _, _, g, o in h2h if g > o)
    print(f'  GL reaction > ours: {gw}/{len(h2h)}')
    print(f'  mean r30: GL {sum(g for _,_,g,_ in h2h)/len(h2h):+.1f} vs ours {sum(o for _,_,_,o in h2h)/len(h2h):+.1f}')
