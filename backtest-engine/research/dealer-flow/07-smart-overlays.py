#!/usr/bin/env python3
"""P2.2 — Event-based "trader mentality" overlays on the flat-stall fade.

Base configs (from 05): B1 = stop25/hold60, B2 = zone-stop/hold120/t35.
Each overlay toggled INDEPENDENTLY (one-at-a-time discipline):

  O1 thesis-erosion  — LS-15m flips BULLISH mid-trade (known at that 15m bar
                       close) -> exit market. "My thesis died."
  O2 structure-target— target = nearest LT level BELOW entry at entry time
                       (>=8pt away, else no target). "Take profit at the next
                       structure, not a fixed number."
  O3 wall-failing    — after being below the zone, price re-enters it and
                       closes >=3 consecutive 1m bars inside -> exit market.
                       "The wall is failing."
  O4 breakeven       — move stop to entry after +15pt favorable. "Protect it."
  E1 limit-at-wall   — entry = limit AT the wall level (instead of market at
                       stall+5m); 30m fill window. "Let it come to me."

Acceptance bar per overlay: PF AND maxDD improve vs base, trade count not
gutted, quarter-blocks stay stable. 1s-honest fills/stops, $4 + 0.5/side.
"""
import bisect
import csv
import importlib.util
import json
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).parent
BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
spec = importlib.util.spec_from_file_location('m5', HERE / '05-shape-flat-stall.py')
m5 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m5)
PT, COMM, SLIP = 20.0, 4.0, 0.5


def load_ls15_bull_known():
    """minute-keys (UTC 'YYYY-MM-DDTHH:MM') at which a BULLISH flip becomes
    KNOWN (flip bar start + 15m)."""
    out = []
    with open(BASE / 'research/lt-extraction/output/nq_ls_15m_raw.csv') as f:
        for r in csv.DictReader(f):
            if r['state'] == '1':
                t = datetime.utcfromtimestamp(int(r['unix_ms']) / 1000) + timedelta(minutes=15)
                out.append(t.strftime('%Y-%m-%dT%H:%M'))
    out.sort()
    return out


def load_lt_rows():
    rows = []
    with open(BASE / 'data/liquidity/nq/NQ_liquidity_levels.csv') as f:
        for r in csv.DictReader(f):
            try:
                ms = int(r['unix_timestamp'])
                lv = [float(r[f'level_{i}']) for i in range(1, 6) if r.get(f'level_{i}')]
            except (ValueError, KeyError):
                continue
            rows.append((ms, lv))
    rows.sort()
    return rows, [x[0] for x in rows]


LS_BULL = load_ls15_bull_known()
LT_ROWS, LT_MS = load_lt_rows()


def next_bull_flip_after(entry_min):
    i = bisect.bisect_right(LS_BULL, entry_min)
    return LS_BULL[i] if i < len(LS_BULL) else None


def lt_target_below(entry_px, entry_min):
    ms = int(datetime.fromisoformat(entry_min + ':00+00:00').timestamp() * 1000)
    i = bisect.bisect_right(LT_MS, ms) - 1
    if i < 0:
        return None
    below = [x for x in LT_ROWS[i][1] if x < entry_px - 8]
    return max(below) if below else None


def simulate(events, cfg, prim, overlay):
    trades = []
    busy_until = ''
    for e in events:
        stall_min = (datetime.fromisoformat(e['ts'] + ':00+00:00')
                     + timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M')
        if stall_min <= busy_until:
            continue
        L = e['level']
        zone_top = L * 1.0010
        zone_bot = L * 0.9990

        # ---- entry ----
        entry_px = entry_sym = entry_bar_ts = entry_min_used = None
        if overlay == 'E1':
            # short limit AT the wall; fills when price trades >= L within 30m
            deadline = (datetime.fromisoformat(stall_min + ':00+00:00')
                        + timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M')
            for m in m5.minute_iter(stall_min, 31):
                if m > deadline:
                    break
                psym = prim.get(m)
                if not psym:
                    continue
                for b in m5.bars_for_minute(m):
                    if b[5] != psym:
                        continue
                    if b[2] >= L:                      # 1s high touches the wall
                        entry_px = L - SLIP            # limit fill (short)
                        entry_sym, entry_bar_ts, entry_min_used = psym, b[0], m
                        break
                if entry_px:
                    break
        else:
            for m in m5.minute_iter(stall_min, 4):
                psym = prim.get(m)
                if not psym:
                    continue
                for b in m5.bars_for_minute(m):
                    if b[5] == psym:
                        entry_px = b[1] - SLIP
                        entry_sym, entry_bar_ts, entry_min_used = psym, b[0], m
                        break
                if entry_px:
                    break
        if not entry_px:
            continue

        # ---- exits config ----
        if cfg['stop'] == 'zone':
            stop = zone_top + 5
        else:
            stop = entry_px + cfg['stop']
        tgt = entry_px - cfg['tgt'] if cfg.get('tgt') else None
        if overlay == 'O2':
            lt_t = lt_target_below(entry_px, entry_min_used)
            tgt = lt_t if lt_t else None
        bull_known = next_bull_flip_after(entry_min_used) if overlay == 'O1' else None
        bound = (datetime.fromisoformat(entry_min_used + ':00+00:00')
                 + timedelta(minutes=cfg['hold'])).strftime('%Y-%m-%dT%H:%M')

        pnl = exit_min = None
        last_close = entry_px
        be_armed = False
        below_zone_seen = False
        inzone_streak = 0
        for m in m5.minute_iter(entry_min_used, cfg['hold'] + 240):
            bars = m5.bars_for_minute(m)
            psym = prim.get(m)
            if bars and psym and psym != entry_sym:
                pnl = -(last_close - entry_px) * -1
                pnl = (entry_px - last_close)
                exit_min = m
                break
            hit_bound = m >= bound
            bull_hit = bull_known is not None and m >= bull_known
            minute_close = None
            for b in bars:
                if b[5] != entry_sym:
                    continue
                if m == entry_min_used and b[0] < entry_bar_ts:
                    continue
                if hit_bound or bull_hit:
                    pnl = (entry_px - b[1]) - SLIP
                    exit_min = m
                    break
                if overlay == 'O4' and not be_armed and b[3] <= entry_px - 15:
                    stop = min(stop, entry_px)
                    be_armed = True
                if b[2] >= stop:
                    pnl = (entry_px - stop) - SLIP
                    exit_min = m
                    break
                if tgt and b[3] <= tgt:
                    pnl = (entry_px - tgt) - SLIP
                    exit_min = m
                    break
                last_close = b[4]
                minute_close = b[4]
            if pnl is not None:
                break
            # O3: wall-failing — 1m-close bookkeeping
            if overlay == 'O3' and minute_close is not None:
                if minute_close < zone_bot:
                    below_zone_seen = True
                    inzone_streak = 0
                elif below_zone_seen and zone_bot <= minute_close <= zone_top:
                    inzone_streak += 1
                    if inzone_streak >= 3:
                        pnl = (entry_px - minute_close) - SLIP
                        exit_min = m
                        break
                else:
                    inzone_streak = 0
        if pnl is None:
            continue
        trades.append({'ts': e['ts'], 'exit': exit_min,
                       'usd': pnl * PT - COMM, 'q': e['day'][:7]})
        busy_until = exit_min
    return trades


def main():
    eps = json.load(open(HERE / 'episodes.json'))
    prim = m5.load_primary_sym()
    fade = sorted([e for e in eps if e.get('dg_sign') == 1 and e['side'] == 'below'
                   and 'r5' in e and -0.05 < e['r5'] < 0.05], key=lambda e: e['ts'])
    bases = {
        'B1(stop25/h60)': {'stop': 25, 'hold': 60, 'tgt': None},
        'B2(zone/h120/t35)': {'stop': 'zone', 'hold': 120, 'tgt': 35},
    }
    overlays = ['base', 'O1', 'O2', 'O3', 'O4', 'E1']
    for bname, cfg in bases.items():
        print(f'\n=== {bname} ===')
        print(f"{'overlay':10s} {'n':>4s} {'WR':>5s} {'PnL$':>8s} {'PF':>5s} {'DD$':>7s}  qtr")
        for ov in overlays:
            tr = simulate(fade, cfg, prim, ov)
            m = m5.metrics(tr)
            if not m:
                print(f'{ov:10s}  <25 trades')
                continue
            print(f"{ov:10s} {m['n']:4d} {m['wr']:5.1f} {m['pnl']:8d} "
                  f"{m['pf']:5.2f} {m['maxdd']:7d}  {m['q_pnl']}")


if __name__ == '__main__':
    main()
