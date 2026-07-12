#!/usr/bin/env python3
"""Level-touch event study on causal GEX levels (all years, stability-first).

Event: a primary-contract 1m bar touches an active causal GEX level
(support/resistance rank 1-5 or gamma_flip; snapshot staleness <= 20 min;
45-min debounce per level price+side). Descriptive outcomes:

  reject  — 30 min later price is back on the approach side by >= 0.10%
  cont    — 30 min later price has closed through by >= 0.10%
  fwd15/fwd60 — log-return % from touch-bar close (roll-censored)

Cuts: level kind, approach side, year, wick-only vs close-through,
gamma regime, LT-level confluence (LT within 0.15% of the GEX level).
No shaping here — the point is to find reactions stable across ALL years.
"""
import bisect
import csv
import glob
import json
import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
GEX_DIR = BASE / 'data/gex/nq'
LT_CSV = BASE / 'data/liquidity/nq/NQ_liquidity_levels.csv'
STALE_MIN = 20
DEBOUNCE_MIN = 45
CONT_PCT = 0.10
CONFL_PCT = 0.15


def load_prices():
    ts, o, h, l, c, sym = [], [], [], [], [], []
    with open(HERE / 'nq_1m_primary_ohlc.csv') as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            ts.append(p[0])
            o.append(float(p[1])); h.append(float(p[2]))
            l.append(float(p[3])); c.append(float(p[4])); sym.append(p[5])
    return ts, o, h, l, c, sym


def load_snapshots():
    snaps = []  # (minute_key, levels list [(price, kind, rank)], regime)
    for fp in sorted(glob.glob(str(GEX_DIR / 'nq_gex_*.json'))):
        d = json.load(open(fp))
        for s in d.get('data', []):
            mk = s['timestamp'].replace('Z', '+00:00')[:16].replace('+00:0', '')
            mk = s['timestamp'][:16]
            levels = []
            for i, x in enumerate(s.get('support') or []):
                if x:
                    levels.append((x, 'sup', i + 1))
            for i, x in enumerate(s.get('resistance') or []):
                if x:
                    levels.append((x, 'res', i + 1))
            if s.get('gamma_flip'):
                levels.append((s['gamma_flip'], 'flip', 0))
            snaps.append((mk, levels, s.get('regime') or ''))
    snaps.sort(key=lambda x: x[0])
    return snaps


def load_lt():
    rows = []
    with open(LT_CSV) as f:
        for r in csv.DictReader(f):
            try:
                ms = int(r['unix_timestamp'])
                lv = [float(r[f'level_{i}']) for i in range(1, 6)
                      if r.get(f'level_{i}')]
            except (ValueError, KeyError):
                continue
            rows.append((ms, lv))
    rows.sort()
    return rows


def main():
    ts, o, h, l, c, sym = load_prices()
    print(f'{len(ts)} minutes')
    snaps = load_snapshots()
    snap_keys = [s[0] for s in snaps]
    print(f'{len(snaps)} snapshots')
    lt = load_lt()
    lt_ms = [x[0] for x in lt]
    print(f'{len(lt)} LT rows')

    def minute_ms(mk):
        return int(datetime.fromisoformat(mk + ':00+00:00').timestamp() * 1000)

    events = []
    last_touch = {}   # (round(level), side) -> minute index
    for i in range(1, len(ts)):
        mk = ts[i]
        si = bisect.bisect_right(snap_keys, mk) - 1
        if si < 0:
            continue
        smk, levels, regime = snaps[si]
        if (minute_ms(mk) - minute_ms(smk)) > STALE_MIN * 60_000:
            continue
        for (L, kind, rank) in levels:
            if not (l[i] <= L <= h[i]):
                continue
            approach = 'below' if c[i - 1] < L else 'above'
            key = (round(L * 4) / 4, approach)
            if key in last_touch and i - last_touch[key] < DEBOUNCE_MIN:
                last_touch[key] = i
                continue
            last_touch[key] = i
            closed_through = (c[i] > L) if approach == 'below' else (c[i] < L)

            # outcomes at +30m (reject/cont) and fwd15/fwd60
            out = {}
            ok = True
            for lbl, mins in (('p30', 30), ('p15', 15), ('p60', 60)):
                j = min(i + mins, len(ts) - 1)
                if sym[j] != sym[i]:
                    ok = False
                    break
                out[lbl] = c[j]
            if not ok:
                continue
            thr = L * CONT_PCT / 100
            if approach == 'below':
                lab = ('cont' if out['p30'] >= L + thr
                       else 'reject' if out['p30'] <= L - thr else 'flat')
            else:
                lab = ('cont' if out['p30'] <= L - thr
                       else 'reject' if out['p30'] >= L + thr else 'flat')

            li = bisect.bisect_right(lt_ms, minute_ms(mk)) - 1
            confl = False
            if li >= 0:
                confl = any(abs(x - L) / L * 100 <= CONFL_PCT for x in lt[li][1])

            events.append({
                'ts': mk, 'level': L, 'c0': c[i], 'i': i,
                'year': mk[:4], 'kind': kind, 'rank': rank,
                'approach': approach, 'regime': regime,
                'closed_through': closed_through, 'lt_confl': confl,
                'label': lab,
                'fwd15': math.log(out['p15'] / c[i]) * 100,
                'fwd60': math.log(out['p60'] / c[i]) * 100,
            })

    print(f'{len(events)} touch events')
    (HERE / 'touch-events.json').write_text(json.dumps(events))

    def table(group_fn, title, min_n=80):
        agg = defaultdict(list)
        for e in events:
            agg[group_fn(e)].append(e)
        print(f'\n=== {title} ===')
        print(f"{'group':42s} {'n':>6s} {'rej%':>6s} {'cont%':>6s} {'fwd60_mean':>10s}")
        for g in sorted(agg):
            ev = agg[g]
            if len(ev) < min_n:
                continue
            rej = 100 * sum(e['label'] == 'reject' for e in ev) / len(ev)
            cont = 100 * sum(e['label'] == 'cont' for e in ev) / len(ev)
            f60 = sum(e['fwd60'] for e in ev) / len(ev)
            print(f'{str(g):42s} {len(ev):6d} {rej:6.1f} {cont:6.1f} {f60:10.4f}')

    table(lambda e: (e['kind'], e['approach'], e['year']),
          'kind x approach x year')
    table(lambda e: (e['kind'], e['approach'], e['closed_through'], e['year']),
          'wick vs close-through x year', min_n=60)
    table(lambda e: (e['kind'], e['approach'], e['lt_confl'], e['year']),
          'LT confluence x year', min_n=60)


if __name__ == '__main__':
    main()
