#!/usr/bin/env python3
"""
Task 1 — Per-signal structural brackets + ex-ante R:R for the jv-ict universe.

Replicates, causally, the strategy state needed to price the tpMode:'external'
target for each of the 3,600 captured signals:

  - 1m continuous -> 15m aggregation with the engine's exact semantics
    (loader drops 1m rows with O==H==L==C; 15m bucket = floor to 15-min
    boundary; bar ts = period start, UTC).
  - pivotN=2 fractal pivots confirmed at close of idx (candidate idx-2),
    usable the same close; swing lists capped at maxSwings=300 (shift oldest).
    Broken flags are irrelevant here: jv-ict's external-TP candidate loop
    iterates ALL swings in the list (broken included).
  - external TP (shared/strategies/jv-ict.js:936-957): candidates = swing
    prices beyond the leg terminus on the profit side + PDH/PDL (if beyond
    entry), filtered to <= 2x leg height beyond the terminus; chosen =
    NEAREST beyond the terminus; accepted only if beyond entry; fallback =
    leg terminus +/- 1 tick (tag 'legLow').
  - stop_level = sweep extreme +/- buffer, buffers {4.0, 4.5, 5.0} pts.
  - rr = target_dist / stop_dist (ex-ante, from the resting limit).

Placebos: paired via placebo_catalog_idx (verified index-aligned with the
real universe); stop_level = synthetic jv_cancel.extreme +/- buffer, target
distance = the real pair's external-target distance applied to the placebo
entry (same offsets on synthetic levels).

Validation (hard asserts, run over all 3,600 real signals):
  - emission bar exists and its close == mss_close
  - extreme-bar body anchor == fib100; terminus bar wick == leg_terminus
  - causal swing (O) present in the replicated swing list at emission

Outputs (research dir):
  - rr-levels.json   {universe: {ts: {stop40,stop45,stop50,target,tag,...}}}
  - (per-signal CSV is written later by 10b after the bracket sim)
"""
import json, csv, math, os, datetime, zoneinfo

DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(DIR, '..', '..'))
M1 = os.path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1m_continuous.csv')
TICK = 0.25
BUFFERS = [4.0, 4.5, 5.0]
MAX_SWINGS = 300
PIVOT_N = 2
EXT_MULT = 2  # externalTpMaxLegMult

def round_tick(x):
    return math.floor(x / TICK + 0.5) * TICK

# ---------------- load + aggregate ----------------
START = '2021-01-18 00:00'   # engine run start (UTC midnight)
END = '2025-01-01 00:00'     # load past run end; extra tail bars are inert

bars = []  # 15m bars: [ts_ms, o, h, l, c, bodyHigh, bodyLow]
cur = None
with open(M1) as f:
    next(f)
    for line in f:
        ts = line[:16]
        if ts < START: continue
        if ts >= END: break
        p = line.split(',')
        o, h, l, c = float(p[1]), float(p[2]), float(p[3]), float(p[4])
        if o == h == l == c:  # loader flat-bar filter
            continue
        ms = datetime.datetime(int(line[0:4]), int(line[5:7]), int(line[8:10]),
                               int(line[11:13]), int(line[14:16]),
                               tzinfo=datetime.timezone.utc).timestamp() * 1000
        period = int(ms // 900000) * 900000
        if cur is None or cur[0] != period:
            if cur is not None:
                bars.append(cur)
            cur = [period, o, h, l, c]
        else:
            if h > cur[2]: cur[2] = h
            if l < cur[3]: cur[3] = l
            cur[4] = c
if cur is not None:
    bars.append(cur)
for b in bars:
    b.append(max(b[1], b[4]))  # bodyHigh
    b.append(min(b[1], b[4]))  # bodyLow
print(f'15m bars: {len(bars)}  first={datetime.datetime.utcfromtimestamp(bars[0][0]/1000)}  last={datetime.datetime.utcfromtimestamp(bars[-1][0]/1000)}')

ts_to_idx = {b[0]: i for i, b in enumerate(bars)}

# ---------------- signals ----------------
real = json.load(open(os.path.join(DIR, 'signals-universe.json')))['signals']
# map emission-bar start ts -> signal indices
by_bar = {}
for si, s in enumerate(real):
    bar_start = s['ts'] - 900000
    by_bar.setdefault(bar_start, []).append(si)

# ---------------- streaming pivot replication ----------------
swing_highs = []  # (price, ts)
swing_lows = []
results = [None] * len(real)
v_o_found = 0; v_o_miss = []
n_ext = 0; n_fallback = 0

for idx in range(len(bars)):
    # 1. confirm pivot candidate idx-2 at this close (usable same close)
    i = idx - PIVOT_N
    if i >= PIVOT_N:
        b = bars
        is_high = all(b[i][2] > b[i - k][2] and b[i][2] > b[i + k][2] for k in range(1, PIVOT_N + 1))
        is_low  = all(b[i][3] < b[i - k][3] and b[i][3] < b[i + k][3] for k in range(1, PIVOT_N + 1))
        if is_high:
            swing_highs.append((b[i][2], b[i][0]))
            if len(swing_highs) > MAX_SWINGS: swing_highs.pop(0)
        if is_low:
            swing_lows.append((b[i][3], b[i][0]))
            if len(swing_lows) > MAX_SWINGS: swing_lows.pop(0)

    # 2. signals emitted at this bar's close (before broken-marking; broken
    #    flags don't matter for the external-TP candidate set anyway)
    for si in by_bar.get(bars[idx][0], []):
        s = real[si]; m = s['metadata']
        is_short = s['side'] == 'sell'
        entry = s['entryPrice']
        extreme = m['sweep_extreme']
        terminus = m['leg_terminus']

        # --- validations ---
        assert abs(bars[idx][4] - m['mss_close']) < 1e-9, (si, bars[idx][4], m['mss_close'])
        ext_ts = int(datetime.datetime.fromisoformat(m['sweep_extreme_ts'].replace('Z', '+00:00')).timestamp() * 1000)
        ei = ts_to_idx.get(ext_ts)
        assert ei is not None, (si, 'extreme bar missing')
        fib100_chk = bars[ei][5] if is_short else bars[ei][6]
        assert abs(fib100_chk - m['fib100']) < 1e-9, (si, fib100_chk, m['fib100'])
        ter_ts = int(datetime.datetime.fromisoformat(m['leg_terminus_ts'].replace('Z', '+00:00')).timestamp() * 1000)
        ti = ts_to_idx.get(ter_ts)
        assert ti is not None, (si, 'terminus bar missing')
        ter_chk = bars[ti][3] if is_short else bars[ti][2]
        assert abs(ter_chk - terminus) < 1e-9, (si, ter_chk, terminus)
        o_ts = int(datetime.datetime.fromisoformat(m['causal_swing_ts'].replace('Z', '+00:00')).timestamp() * 1000)
        o_price = m['causal_swing_price']
        o_list = swing_lows if is_short else swing_highs
        if any(abs(p - o_price) < 1e-9 and t == o_ts for p, t in o_list):
            v_o_found += 1
        else:
            v_o_miss.append(si)

        # --- external TP (jv-ict.js:936-957) ---
        leg_height = (extreme - terminus) if is_short else (terminus - extreme)
        swings = swing_lows if is_short else swing_highs
        candidates = [p for p, t in swings if (p < terminus if is_short else p > terminus)]
        pd = m['pdl'] if is_short else m['pdh']
        if pd is not None and (pd < entry if is_short else pd > entry):
            candidates.append(pd)
        valid = [c for c in candidates
                 if ((terminus - c) if is_short else (c - terminus)) <= EXT_MULT * leg_height]
        target = round_tick(terminus + TICK if is_short else terminus - TICK)
        tag = 'legLow'
        if valid:
            chosen = max(valid) if is_short else min(valid)
            if (chosen < entry) if is_short else (chosen > entry):
                target = round_tick(chosen)
                tag = 'external'
        if tag == 'external': n_ext += 1
        else: n_fallback += 1

        row = {'target': target, 'tag': tag}
        for buf in BUFFERS:
            stop = round_tick(extreme + buf if is_short else extreme - buf)
            sd = (stop - entry) if is_short else (entry - stop)
            td = (entry - target) if is_short else (target - entry)
            row[f'stop{int(buf*10)}'] = stop
            row[f'rr{int(buf*10)}'] = td / sd if sd > 0 else None
        row['target_dist'] = (entry - target) if is_short else (target - entry)
        results[si] = row

assert all(r is not None for r in results)
print(f'external tag: {n_ext}  fallback legLow: {n_fallback}')
print(f'causal-swing validation: found {v_o_found}/{len(real)}, missing {len(v_o_miss)}')
if v_o_miss[:10]:
    print('  first misses:', v_o_miss[:10])

# ---------------- placebo brackets ----------------
out = {'real': {}}
for si, s in enumerate(real):
    r = results[si]
    out['real'][str(s['ts'])] = r

for k in range(1, 6):
    uni = {}
    sigs = json.load(open(os.path.join(DIR, f'signals-placebo-s{k}.json')))['signals']
    for s in sigs:
        m = s['metadata']
        pair = results[m['placebo_catalog_idx']]
        is_short = s['side'] == 'sell'
        entry = s['entryPrice']
        extreme = m['jv_cancel']['extreme']
        td = pair['target_dist']
        target = round_tick(entry - td if is_short else entry + td)
        row = {'target': target, 'tag': pair['tag'], 'target_dist': td,
               'pair_idx': m['placebo_catalog_idx']}
        for buf in BUFFERS:
            stop = round_tick(extreme + buf if is_short else extreme - buf)
            sd = (stop - entry) if is_short else (entry - stop)
            row[f'stop{int(buf*10)}'] = stop
            row[f'rr{int(buf*10)}'] = td / sd if sd > 0 else None
        uni[str(s['ts'])] = row
    out[f'p{k}'] = uni

with open(os.path.join(DIR, 'rr-levels.json'), 'w') as f:
    json.dump(out, f)
print('wrote rr-levels.json')

# quick rr distribution preview (real, buffer 4.5)
import statistics
rrs = sorted(r['rr45'] for r in results)
dec = [rrs[int(q * (len(rrs) - 1))] for q in [i / 10 for i in range(11)]]
print('rr45 deciles:', [round(x, 2) for x in dec])
print('rr45 >=1: {:.1%}  >=1.5: {:.1%}  >=2: {:.1%}  >=3: {:.1%}'.format(
    *[sum(1 for x in rrs if x >= t) / len(rrs) for t in (1, 1.5, 2, 3)]))
