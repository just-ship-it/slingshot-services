#!/usr/bin/env python3
"""P1 — Wall-zone EPISODE study with placebo control.

Event = price ENTERS a level's zone (±ZONE_PCT). The episode tracks what
happens from zone entry (NOT just the touch bar): dwell, retests, outcomes
at +5/15/30/60/120m from first entry, onset-of-max-response timing, and
resolution (rejected / accepted-through / expired).

Level classes per day:
  wall     — causal GEX support/resistance (top-5 each side, nq-cbbo-causal)
  placebo_round — round-100 NQ levels within the day's range
  placebo_rand  — seeded random levels within the day's range (same count as walls)

Conditions per episode:
  dealer_gamma_sign at the wall's strike (P0 flow inventory; walls only,
    2025-02→2026-01) — PRE-REGISTERED H1: dealer-long-gamma ⇒ barrier
    (reject), dealer-short-gamma ⇒ accelerant (continuation)
  dte0_5_share of position at the strike; ToD session; DoW; first-vs-nth
    episode at the level today; approach velocity (30m return into entry);
    LT confluence (LT level within 0.15%)

Outputs: episodes JSON + summary tables. Descriptive; shaping comes later.
"""
import bisect
import csv
import glob
import json
import math
import random
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
SCREEN = BASE / 'research/causal-gex-screen'
GEX_DIR = BASE / 'data/gex/nq-cbbo-causal'
FLOW = BASE / 'data/flow/qqq'
ET = ZoneInfo('America/New_York')

ZONE_PCT = 0.10          # zone half-width around level
EXIT_PCT = 0.20          # episode ends when price is this far past/away
MAX_EPISODE_MIN = 120
OUTCOME_MINS = (5, 15, 30, 60, 120)
LT_CONFL_PCT = 0.15
STALE_MIN = 20


def load_prices():
    ts, o, h, l, c, sym = [], [], [], [], [], []
    with open(SCREEN / 'nq_1m_primary_ohlc.csv') as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            ts.append(p[0]); o.append(float(p[1])); h.append(float(p[2]))
            l.append(float(p[3])); c.append(float(p[4])); sym.append(p[5])
    return ts, o, h, l, c, sym


def load_walls():
    """day -> list of (nq_level, qqq_strike, kind) from the day's FIRST usable
    snapshot after 09:30 ET (walls are quote-informed from the open; one wall
    set per day keeps episodes independent of intraday wall drift — v1)."""
    by_day = {}
    for fp in sorted(glob.glob(str(GEX_DIR / 'nq_gex_*.json'))):
        d = json.load(open(fp))
        day = d['metadata']['date']
        for s in d.get('data', []):
            t = datetime.fromisoformat(s['timestamp'].replace('Z', '+00:00'))
            hm = t.astimezone(ET).strftime('%H:%M')
            if hm < '09:45':
                continue
            mult = s.get('multiplier') or 0
            if not mult:
                break
            walls = []
            for kind, key in (('sup', 'support'), ('res', 'resistance')):
                for lv in (s.get(key) or []):
                    if lv:
                        walls.append((lv, round(lv / mult), kind))
            if walls:
                by_day[day] = walls
            break
    return by_day


def load_dealer_gamma():
    """day -> {qqq_strike_int: (sign, dte0_5_share)}"""
    out = {}
    for fp in sorted(glob.glob(str(FLOW / 'dealer-strikes-*.csv'))):
        d8 = fp.split('-')[-1].split('.')[0]
        day = f'{d8[:4]}-{d8[4:6]}-{d8[6:8]}'
        m = {}
        for r in csv.DictReader(open(fp)):
            g = float(r['dealer_gamma'])
            if g == 0:
                continue
            tot = int(r['pos_dte0_5']) + int(r['pos_dte6_30']) + int(r['pos_dte31p'])
            share = int(r['pos_dte0_5']) / tot if tot else 0.0
            m[round(float(r['strike']))] = (1 if g > 0 else -1, share)
        out[day] = m
    return out


def load_lt():
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


def main():
    ts, o, h, l, c, sym = load_prices()
    walls_by_day = load_walls()
    dg_by_day = load_dealer_gamma()
    lt_rows, lt_ms = load_lt()
    print(f'{len(ts)} minutes, {len(walls_by_day)} wall days, {len(dg_by_day)} dealer days')

    # per-day minute index ranges
    day_idx = defaultdict(list)
    for i, t in enumerate(ts):
        day_idx[t[:10]].append(i)

    rng = random.Random(20260712)
    episodes = []

    for day, walls in sorted(walls_by_day.items()):
        idxs = day_idx.get(day)
        if not idxs:
            continue
        i0, i1 = idxs[0], idxs[-1]
        day_hi = max(h[i0:i1 + 1]); day_lo = min(l[i0:i1 + 1])

        # level sets
        levels = [(lv, strike, 'wall', kind) for (lv, strike, kind) in walls]
        lo100 = int(day_lo // 100 + 1) * 100
        rounds = [(float(x), None, 'placebo_round', 'na')
                  for x in range(lo100, int(day_hi), 100)]
        rands = [(rng.uniform(day_lo, day_hi), None, 'placebo_rand', 'na')
                 for _ in range(len(walls))]
        all_levels = levels + rounds + rands

        dg = dg_by_day.get(day, {})
        visits = defaultdict(int)

        for (L, strike, cls, kind) in all_levels:
            zone = L * ZONE_PCT / 100
            j = i0
            while j <= i1:
                # find zone entry: previous close outside, this bar range hits zone
                if j > i0 and abs(c[j - 1] - L) > zone and (l[j] <= L + zone and h[j] >= L - zone):
                    entry_i = j
                    visits[(cls, L)] += 1
                    nth = visits[(cls, L)]
                    side = 'below' if c[j - 1] < L else 'above'
                    t_ent = datetime.fromisoformat(ts[entry_i] + ':00+00:00').astimezone(ET)
                    # approach velocity: 30m return into entry
                    back = max(i0, entry_i - 30)
                    app = math.log(c[entry_i - 1] / c[back]) * 100 if entry_i > back else 0.0
                    # LT confluence
                    ms = int(datetime.fromisoformat(ts[entry_i] + ':00+00:00').timestamp() * 1000)
                    li = bisect.bisect_right(lt_ms, ms) - 1
                    confl = li >= 0 and any(abs(x - L) / L * 100 <= LT_CONFL_PCT
                                            for x in lt_rows[li][1])
                    # walk the episode
                    outc = {}
                    end_i = min(entry_i + MAX_EPISODE_MIN, i1)
                    resolution = 'expired'
                    resolution_min = None
                    max_dev = 0.0; max_dev_min = 0; dwell = 0
                    dwell5 = 0   # zone-minutes within first 5 min (causal early condition)
                    for k in range(entry_i, end_i + 1):
                        if sym[k] != sym[entry_i]:
                            if resolution == 'expired':
                                resolution = 'roll'
                            break
                        mins = k - entry_i
                        dev = (c[k] - L) / L * 100
                        sgn = dev if side == 'below' else -dev
                        # signed: + = broke through (continuation), relative to approach
                        if abs(dev) > abs(max_dev):
                            max_dev, max_dev_min = dev, mins
                        if abs(c[k] - L) <= zone:
                            dwell += 1
                            if mins <= 5:
                                dwell5 += 1
                        for m_ in OUTCOME_MINS:
                            if mins == m_:
                                outc[f'r{m_}'] = math.log(c[k] / c[entry_i]) * 100
                        # Resolution is CLASSIFIED at first threshold cross but the
                        # walk continues to MAX_EPISODE_MIN so every fixed-horizon
                        # outcome exists regardless of resolution speed (otherwise
                        # any analysis conditioned on r30/r60 silently selects
                        # slow episodes — survivorship).
                        if resolution == 'expired':
                            if sgn >= EXIT_PCT:
                                resolution = 'accepted'   # traded through the level
                                resolution_min = mins
                            elif sgn <= -EXIT_PCT:
                                resolution = 'rejected'   # pushed back from the level
                                resolution_min = mins
                    ep = {
                        'ts': ts[entry_i], 'day': day, 'year': day[:4], 'cls': cls, 'kind': kind,
                        'level': L, 'side': side, 'nth': nth,
                        'dow': t_ent.weekday(), 'hour_et': t_ent.hour,
                        'approach_30m': round(app, 4), 'lt_confl': confl,
                        'dwell': dwell, 'dwell5': dwell5,
                        'resolution': resolution, 'resolution_min': resolution_min,
                        'max_dev': round(max_dev, 4), 'onset_min': max_dev_min,
                        **{k_: round(v_, 4) for k_, v_ in outc.items()},
                    }
                    if cls == 'wall' and strike is not None and strike in dg:
                        ep['dg_sign'], ep['dte0_share'] = dg[strike]
                    episodes.append(ep)
                    j = max(j + 1, entry_i + 15)   # debounce: next episode ≥15m later
                else:
                    j += 1

    print(f'{len(episodes)} episodes')
    (HERE / 'episodes.json').write_text(json.dumps(episodes))

    def table(rows, group_fn, title, min_n=80):
        agg = defaultdict(list)
        for e in rows:
            agg[group_fn(e)].append(e)
        print(f'\n=== {title} ===')
        print(f"{'group':44s} {'n':>6s} {'rej%':>6s} {'acc%':>6s} {'onset_med':>9s}")
        for g in sorted(agg):
            ev = agg[g]
            if len(ev) < min_n:
                continue
            rej = 100 * sum(e['resolution'] == 'rejected' for e in ev) / len(ev)
            acc = 100 * sum(e['resolution'] == 'accepted' for e in ev) / len(ev)
            on = sorted(e['onset_min'] for e in ev)[len(ev) // 2]
            print(f'{str(g):44s} {len(ev):6d} {rej:6.1f} {acc:6.1f} {on:9d}')

    # H0: walls vs placebo (the existence test)
    table(episodes, lambda e: (e['cls'], e['year']), 'level class x year (H0: walls vs placebo)')
    # H1 (pre-registered): dealer gamma sign — barrier vs accelerant
    dg_eps = [e for e in episodes if 'dg_sign' in e]
    table(dg_eps, lambda e: (e['dg_sign'], e['side']),
          'H1: dealer gamma sign x approach (walls with flow data)', min_n=50)
    table(dg_eps, lambda e: (e['dg_sign'], e['dte0_share'] > 0.25),
          'H1b: dg sign x 0DTE-heavy(>25%)', min_n=50)


if __name__ == '__main__':
    main()
