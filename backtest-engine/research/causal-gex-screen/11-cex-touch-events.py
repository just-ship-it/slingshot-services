#!/usr/bin/env python3
"""Charm-wall (CEX) touch study on causal GEX data (2025-01 → 2026-06).

Same event framework as 09-level-touch-events.py, but levels = per-strike
CEX walls (cex_above / cex_below from data/gex/nq-cbbo-causal). Controls:

  - gex_overlap: is this CEX wall within 0.05% of a top-5 GEX level in the
    same snapshot? (charm magnitude concentrates near ATM — without this
    flag the study would just rediscover GEX walls / spot proximity)
  - rank: CEX magnitude rank (1 = biggest)
  - sign: sign of the wall's charm exposure
  - et session, year

Outcomes: reject/cont at 30m (0.10% threshold), fwd15/fwd60 log-returns,
roll-censored. Descriptive only — stability across 2025 vs 2026 required
before any shaping.
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
GEX_DIR = BASE / 'data/gex/nq-cbbo-causal'
STALE_MIN = 20
DEBOUNCE_MIN = 45
CONT_PCT = 0.10
OVERLAP_PCT = 0.05


def load_prices():
    ts, o, h, l, c, sym = [], [], [], [], [], []
    with open(HERE / 'nq_1m_primary_ohlc.csv') as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            ts.append(p[0]); o.append(float(p[1])); h.append(float(p[2]))
            l.append(float(p[3])); c.append(float(p[4])); sym.append(p[5])
    return ts, o, h, l, c, sym


def load_snapshots():
    snaps = []
    for fp in sorted(glob.glob(str(GEX_DIR / 'nq_gex_*.json'))):
        d = json.load(open(fp))
        for s in d.get('data', []):
            mk = s['timestamp'][:16]
            gex_levels = ([x for x in (s.get('support') or []) if x] +
                          [x for x in (s.get('resistance') or []) if x])
            walls = []
            for side in ('cex_above', 'cex_below'):
                lv = s.get(side) or []
                vals = s.get(side + '_val') or []
                for rank, (L, v) in enumerate(zip(lv, vals), 1):
                    if not L:
                        continue
                    overlap = any(abs(g - L) / L * 100 <= OVERLAP_PCT for g in gex_levels)
                    walls.append((L, side, rank, 1 if v > 0 else -1, overlap))
            snaps.append((mk, walls, s.get('regime') or ''))
    snaps.sort(key=lambda x: x[0])
    return snaps


def main():
    ts, o, h, l, c, sym = load_prices()
    snaps = load_snapshots()
    snap_keys = [s[0] for s in snaps]
    print(f'{len(ts)} minutes, {len(snaps)} snapshots')

    def minute_ms(mk):
        return int(datetime.fromisoformat(mk + ':00+00:00').timestamp() * 1000)

    events = []
    last_touch = {}
    for i in range(1, len(ts)):
        mk = ts[i]
        si = bisect.bisect_right(snap_keys, mk) - 1
        if si < 0:
            continue
        smk, walls, regime = snaps[si]
        if (minute_ms(mk) - minute_ms(smk)) > STALE_MIN * 60_000:
            continue
        for (L, side, rank, sign, overlap) in walls:
            if not (l[i] <= L <= h[i]):
                continue
            approach = 'below' if c[i - 1] < L else 'above'
            key = (round(L * 4) / 4, approach)
            if key in last_touch and i - last_touch[key] < DEBOUNCE_MIN:
                last_touch[key] = i
                continue
            last_touch[key] = i

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

            events.append({
                'year': mk[:4], 'side': side, 'rank': rank, 'sign': sign,
                'gex_overlap': overlap, 'approach': approach, 'regime': regime,
                'label': lab,
                'fwd15': math.log(out['p15'] / c[i]) * 100,
                'fwd60': math.log(out['p60'] / c[i]) * 100,
                'ts': mk, 'level': L, 'i': i, 'c0': c[i],
            })

    print(f'{len(events)} CEX-wall touch events')
    (HERE / 'cex-touch-events.json').write_text(json.dumps(events))

    def table(group_fn, title, min_n=60):
        agg = defaultdict(list)
        for e in events:
            agg[group_fn(e)].append(e)
        print(f'\n=== {title} ===')
        print(f"{'group':46s} {'n':>6s} {'rej%':>6s} {'cont%':>6s} {'fwd60_mean':>10s}")
        for g in sorted(agg):
            ev = agg[g]
            if len(ev) < min_n:
                continue
            rej = 100 * sum(e['label'] == 'reject' for e in ev) / len(ev)
            cont = 100 * sum(e['label'] == 'cont' for e in ev) / len(ev)
            f60 = sum(e['fwd60'] for e in ev) / len(ev)
            print(f'{str(g):46s} {len(ev):6d} {rej:6.1f} {cont:6.1f} {f60:10.4f}')

    # KEY CONTROL: non-overlapping CEX walls only (charm-specific info)
    table(lambda e: (e['side'], e['approach'], e['gex_overlap'], e['year']),
          'side x approach x GEX-overlap x year')
    table(lambda e: (e['side'], e['approach'], e['rank'] <= 2, e['year']),
          'rank<=2 vs 3-5 x year', min_n=50)
    table(lambda e: (e['sign'], e['approach'], e['year']),
          'charm sign x approach x year', min_n=50)


if __name__ == '__main__':
    main()
