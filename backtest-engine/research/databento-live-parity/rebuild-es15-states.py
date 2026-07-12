#!/usr/bin/env python3
"""Rebuild data/features/es15_clearpath_states.csv from causal ES GEX.

Replicates the clear-path composite from
research/deepdive-weekly/sweep-es-confluence.py (CONFL_PCT=0.15, snapshot
freshness <= 2700s, races_ES15.csv race geometry) but reads snapshots from
data/gex/es-causal (prevday-close IV, as-of labels, primary-contract spot)
instead of the contaminated data/gex/es.

Output format matches the original gate file: unix_ms,t_et,state
(state in long|short|none). The engine (--lgpr-es-gate) reads it point-in-time.

Usage: python3 rebuild-es15-states.py [--gex-dir data/gex/es-causal] [--out ...]
"""
import argparse
import bisect
import csv
import glob
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
RACES = BASE / 'research/deepdive-weekly/races/races_ES15.csv'
ET = ZoneInfo('America/New_York')
CONFL_PCT = 0.15
FRESH_S = 2700


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gex-dir', default=str(BASE / 'data/gex/es-causal'))
    ap.add_argument('--out', default=str(BASE / 'data/features/es15_clearpath_states.csv'))
    args = ap.parse_args()

    print('loading ES GEX snapshots from', args.gex_dir)
    snaps = []
    for fp in sorted(glob.glob(str(Path(args.gex_dir) / 'es_gex_*.json'))):
        try:
            d = json.load(open(fp))
        except Exception:
            continue
        for s in d.get('data', []):
            try:
                ts = datetime.fromisoformat(
                    s['timestamp'].replace('Z', '+00:00')).timestamp()
            except Exception:
                continue
            snaps.append((ts, s))
    snaps.sort(key=lambda x: x[0])
    snap_ts = [x[0] for x in snaps]
    print(f'{len(snaps)} snapshots')

    rows = []
    for r in csv.DictReader(open(RACES)):
        t = datetime.strptime(r['t_et'], '%Y-%m-%d %H:%M:%S').replace(
            tzinfo=ET).timestamp()
        i = bisect.bisect_right(snap_ts, t) - 1
        if i < 0 or t - snap_ts[i] > FRESH_S:
            continue
        s = snaps[i][1]
        spot, up, dn = float(r['spot']), float(r['up']), float(r['dn'])
        res = [x for x in (s.get('resistance') or []) if x]
        sup = [x for x in (s.get('support') or []) if x]
        eps = spot * CONFL_PCT / 100
        res_between = any(spot < x < up - eps for x in res)
        sup_between = any(dn + eps < x < spot for x in sup)
        if not res_between and sup_between:
            st = 'long'
        elif not sup_between and res_between:
            st = 'short'
        else:
            st = 'none'
        rows.append((int(t * 1000), r['t_et'], st))

    rows.sort()
    out = Path(args.out)
    if out.exists():
        bak = out.with_suffix('.csv.pre-causal-bak')
        if not bak.exists():
            out.rename(bak)
            print(f'backed up original -> {bak}')
    with open(out, 'w') as f:
        f.write('unix_ms,t_et,state\n')
        for u, t_et, st in rows:
            f.write(f'{u},{t_et},{st}\n')
    from collections import Counter
    print(f'wrote {len(rows)} states -> {out}')
    print('state histogram:', dict(Counter(st for _, _, st in rows)))


if __name__ == '__main__':
    main()
