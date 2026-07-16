#!/usr/bin/env python3
"""P2 — 1s-honest shaping of the flat-stall setups (both sides).

  FADE:  dealer-LONG-gamma wall, approach from below, flat first 5 min
         -> SHORT at entry+5m (stall confirmation), ride the downward drift.
  BREAK: dealer-SHORT-gamma wall, approach from below, flat first 5 min
         -> LONG at entry+5m, ride the acceleration through the level.

Execution per CLAUDE.md research mandate: entry = market at the open of the
first 1s bar at/after (episode entry + 5 min), +0.5pt slip; stops/targets on
1s highs/lows (stop-market fill slip 0.5); time exits at fixed horizon; $4 RT
commission, $20/pt; one position at a time per variant (single slot).

Grid: stop ∈ {above zone +5pt, fixed 15/25pt}, exit ∈ {time 60m, time 120m,
target 20/35pt with 120m cap}. Stability: quarterly PnL split (single
12-month window — TCBBO limit; no year split possible).
"""
import bisect
import json
import math
import statistics
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).parent
BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
F1S = BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.csv'
IDX = json.load(open(BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.index.json'))['minutes']
PT, COMM, SLIP = 20.0, 4.0, 0.5

_f = open(F1S, 'rb')


def minute_epoch(ts_min):
    return int(datetime.fromisoformat(ts_min + ':00+00:00').timestamp() * 1000)


def bars_for_minute(ts_min):
    ent = IDX.get(str(minute_epoch(ts_min)))
    if not ent:
        return []
    _f.seek(ent['offset'])
    chunk = _f.read(ent['length']).decode('utf-8', 'replace')
    out = []
    for line in chunk.splitlines():
        p = line.split(',')
        if len(p) < 10 or '-' in p[9]:
            continue
        try:
            out.append((p[0], float(p[4]), float(p[5]), float(p[6]),
                        float(p[7]), p[9].strip()))
        except ValueError:
            continue
    return out


def minute_iter(start_min, n):
    t = datetime.fromisoformat(start_min + ':00+00:00')
    for _ in range(n):
        yield t.strftime('%Y-%m-%dT%H:%M')
        t += timedelta(minutes=1)


def load_primary_sym():
    m = {}
    with open(BASE / 'research/causal-gex-screen/nq_1m_primary_2023plus.csv') as f:
        next(f)
        for line in f:
            ts, close, sym = line.rstrip('\n').split(',')
            m[ts] = sym
    return m


def simulate(events, side, cfg, prim):
    """events sorted by ts; side=+1 long, -1 short."""
    trades = []
    busy_until = ''
    for e in events:
        entry_min = (datetime.fromisoformat(e['ts'] + ':00+00:00')
                     + timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M')
        if entry_min <= busy_until:
            continue
        # find entry bar
        entry_px = entry_sym = entry_bar_ts = None
        for m in minute_iter(entry_min, 4):
            psym = prim.get(m)
            if not psym:
                continue
            for b in bars_for_minute(m):
                if b[5] == psym:
                    entry_px = b[1] + side * SLIP
                    entry_sym, entry_bar_ts, entry_min_used = psym, b[0], m
                    break
            if entry_px:
                break
        if not entry_px:
            continue
        L = e['level']
        zone_edge = L * (1 + 0.0010) if side == -1 else L * (1 - 0.0010)
        if cfg['stop'] == 'zone':
            stop = zone_edge + (5 if side == -1 else -5)
        else:
            stop = entry_px + (cfg['stop'] if side == -1 else -cfg['stop'])
        tgt = None
        if cfg.get('tgt'):
            tgt = entry_px - cfg['tgt'] if side == -1 else entry_px + cfg['tgt']
        bound = (datetime.fromisoformat(entry_min_used + ':00+00:00')
                 + timedelta(minutes=cfg['hold'])).strftime('%Y-%m-%dT%H:%M')
        pnl = exit_min = None
        last_close = entry_px
        for m in minute_iter(entry_min_used, cfg['hold'] + 200):
            bars = bars_for_minute(m)
            psym = prim.get(m)
            if bars and psym and psym != entry_sym:
                pnl = side * (last_close - entry_px)
                exit_min = m
                break
            hit_bound = m >= bound
            for b in bars:
                if b[5] != entry_sym:
                    continue
                if m == entry_min_used and b[0] < entry_bar_ts:
                    continue
                if hit_bound:
                    pnl = side * (b[1] - entry_px) - SLIP
                    exit_min = m
                    break
                if (side == -1 and b[2] >= stop) or (side == 1 and b[3] <= stop):
                    pnl = side * (stop - entry_px) - SLIP
                    exit_min = m
                    break
                if tgt and ((side == -1 and b[3] <= tgt) or (side == 1 and b[2] >= tgt)):
                    pnl = side * (tgt - entry_px) - SLIP
                    exit_min = m
                    break
                last_close = b[4]
            if pnl is not None:
                break
        if pnl is None:
            continue
        trades.append({'ts': e['ts'], 'exit': exit_min,
                       'usd': pnl * PT - COMM, 'q': e['day'][:7]})
        busy_until = exit_min
    return trades


def metrics(trades):
    if len(trades) < 25:
        return None
    usd = [t['usd'] for t in trades]
    wins = [u for u in usd if u > 0]
    losses = [u for u in usd if u <= 0]
    eq = peak = dd = 0.0
    for u in usd:
        eq += u; peak = max(peak, eq); dd = max(dd, peak - eq)
    qs = defaultdict(float)
    for t in trades:
        qs[t['q'][:7]] += t['usd']
    # quarterly-ish: group months into 4 blocks
    months = sorted(qs)
    blocks = [sum(qs[m] for m in months[i::4] if False) for i in range(0)]  # unused
    qblocks = defaultdict(float)
    for i, m in enumerate(months):
        qblocks[i // 3] += qs[m]
    return {'n': len(trades), 'wr': round(100 * len(wins) / len(usd), 1),
            'pnl': round(sum(usd)),
            'pf': round(sum(wins) / abs(sum(losses)), 2) if losses else 99.0,
            'maxdd': round(dd),
            'q_pnl': [round(v) for _, v in sorted(qblocks.items())]}


def main():
    eps = json.load(open(HERE / 'episodes.json'))
    prim = load_primary_sym()

    fade = sorted([e for e in eps if e.get('dg_sign') == 1 and e['side'] == 'below'
                   and 'r5' in e and -0.05 < e['r5'] < 0.05], key=lambda e: e['ts'])
    brk = sorted([e for e in eps if e.get('dg_sign') == -1 and e['side'] == 'below'
                  and 'r5' in e and -0.05 < e['r5'] < 0.05], key=lambda e: e['ts'])
    print(f'fade events: {len(fade)}, breakout events: {len(brk)}')

    grid = []
    for stop in ('zone', 15, 25):
        for hold, tgt in ((60, None), (120, None), (120, 20), (120, 35)):
            grid.append({'stop': stop, 'hold': hold, 'tgt': tgt})

    for name, events, side in (('FADE-short@dgLong', fade, -1),
                               ('BREAK-long@dgShort', brk, 1)):
        print(f'\n=== {name} ===')
        print(f"{'cfg':22s} {'n':>4s} {'WR':>5s} {'PnL$':>8s} {'PF':>5s} {'DD$':>7s}  qtr_pnl")
        for cfg in grid:
            m = metrics(simulate(events, side, cfg, prim))
            if not m:
                continue
            cs = f"stop={cfg['stop']}/h{cfg['hold']}/t{cfg['tgt']}"
            print(f"{cs:22s} {m['n']:4d} {m['wr']:5.1f} {m['pnl']:8d} "
                  f"{m['pf']:5.2f} {m['maxdd']:7d}  {m['q_pnl']}")


if __name__ == '__main__':
    main()
