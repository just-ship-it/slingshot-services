#!/usr/bin/env python3
"""Phase 3: full-book MBO replay — does depth BEHIND the touch empty before large candles?

MBP-1 showed no BBO precursor, but the vacuum thesis predicts the ladder BEHIND the best quotes
hollows out (BBO refills tick-by-tick while price jumps levels). MBO (order-by-order, all levels)
is the direct test. Window: 2025-12-29..2026-01-28 (29 files), 38 RTH events.

Per event/control window [t-360s, t+60s+60s]:
  - every 5s: resting size within 10 and 25 ticks (2.5 / 6.25 pts) of mid, per side; order count
  - per 10s bucket: canceled size at >1 tick behind the BBO, per side ("shops pulling")
Output: mbo_depth.csv (samples) + mbo_cancels.csv (buckets)
"""
import csv
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
MBODIR = BASE / 'data/orderflow/nq/mbo'
ET = ZoneInfo('America/New_York')
PRE_S, POST_S = 360, 120
TICK = 0.25
D10, D25 = 10 * TICK, 25 * TICK


def tod_to_ms(date, et_min):
    dt = datetime.strptime(date, '%Y-%m-%d').replace(hour=et_min // 60, minute=et_min % 60, tzinfo=ET)
    return int(dt.timestamp() * 1000)


def load_windows():
    import random
    rng = random.Random(20260723)
    ev = [r for r in csv.DictReader(open(BASE / 'research/vacuum/events.csv'))
          if r['session'] == 'rth' and '2025-12-29' <= r['date'] <= '2026-01-28']
    ct = [r for r in csv.DictReader(open(BASE / 'research/vacuum/controls.csv'))
          if r['session'] == 'rth' and '2025-12-29' <= r['date'] <= '2026-01-28']
    by_date = defaultdict(list)
    for r in ev:
        by_date[r['date']].append(('ev', r))
    ct_by_date = defaultdict(list)
    for r in ct:
        ct_by_date[r['date']].append(r)
    for date in by_date:
        n_ev = len(by_date[date])
        pool = ct_by_date.get(date, [])
        for r in rng.sample(pool, min(2 * n_ev, len(pool))):
            by_date[date].append(('ct', r))
    out = defaultdict(list)
    for date, rows in by_date.items():
        for k, (typ, r) in enumerate(rows):
            ms = tod_to_ms(date, int(r['tod']))
            out[date].append((f'{typ}{k}', ms, r['sym'], r['move']))
    return out


def parse_ts(ts):
    return int(datetime.strptime(ts[:23], '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc).timestamp() * 1000)


def main():
    wins = load_windows()
    fo_d = open(BASE / 'research/vacuum/mbo_depth.csv', 'w', newline='')
    wd = csv.writer(fo_d)
    wd.writerow(['date', 'label', 'move', 'rel_s', 'mid', 'bid10', 'ask10', 'bid25', 'ask25', 'n_ord', 'spread'])
    fo_c = open(BASE / 'research/vacuum/mbo_cancels.csv', 'w', newline='')
    wc = csv.writer(fo_c)
    wc.writerow(['date', 'label', 'move', 'rel_bucket', 'cx_bid_behind', 'cx_ask_behind', 'cx_at_bbo', 'add_sz'])

    for date in sorted(wins):
        fp = MBODIR / f'glbx-mdp3-{date.replace("-", "")}.mbo.csv'
        if not fp.exists():
            print(f'{date}: no mbo file', flush=True)
            continue
        spans = [(lbl, ms - PRE_S * 1000, ms + 60000 + POST_S * 1000, sym, mv) for (lbl, ms, sym, mv) in wins[date]]
        t_min = min(a for _, a, _, _, _ in spans)
        t_max = max(b for _, _, b, _, _ in spans)
        syms = {s for _, _, _, s, _ in spans}
        orders = {}   # order_id -> (side, price, size)
        # sample scheduling
        samples = []   # (ms, lbl, mv, rel_s)
        for lbl, a, b, sym, mv in spans:
            t = a
            while t <= b:
                samples.append((t, lbl, mv, (t - (a + PRE_S * 1000)) // 1000))
                t += 5000
        samples.sort()
        si = 0
        cx = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])   # (lbl, bucket) -> [cx_bid_behind, cx_ask_behind, cx_at_bbo, add]
        n_rows = 0
        with open(fp) as f:
            r = csv.reader(f)
            header = next(r)
            ix = {k: i for i, k in enumerate(header)}
            i_ts, i_act, i_side, i_px, i_sz, i_oid, i_sym = (ix['ts_recv'], ix['action'], ix['side'],
                                                             ix['price'], ix['size'], ix['order_id'], ix['symbol'])
            for row in r:
                if row[i_sym] not in syms:
                    continue
                n_rows += 1
                act = row[i_act]
                try:
                    tms = parse_ts(row[i_ts])
                except (ValueError, IndexError):
                    continue
                # book maintenance (whole day, so state is correct when windows open)
                oid = row[i_oid]
                if act == 'A':
                    try:
                        orders[oid] = (row[i_side], float(row[i_px]), int(row[i_sz]))
                    except ValueError:
                        pass
                elif act in ('C', 'F'):
                    prev = orders.pop(oid, None)
                    if act == 'C' and prev and t_min <= tms <= t_max:
                        side, px, sz = prev
                        bids = [p for s2, p, _ in orders.values() if s2 == 'B']
                        asks = [p for s2, p, _ in orders.values() if s2 == 'A']
                        bb = max(bids) if bids else None
                        ba = min(asks) if asks else None
                        for lbl, a, b, sym, mv in spans:
                            if not (a <= tms < b):
                                continue
                            bucket = (tms - (a + PRE_S * 1000)) // 10000
                            key = (lbl, bucket, mv)
                            at_bbo = (side == 'B' and bb is not None and px >= bb - TICK) or \
                                     (side == 'A' and ba is not None and px <= ba + TICK)
                            if at_bbo:
                                cx[key][2] += sz
                            elif side == 'B':
                                cx[key][0] += sz
                            else:
                                cx[key][1] += sz
                elif act == 'M':
                    try:
                        prev = orders.get(oid)
                        if prev:
                            orders[oid] = (prev[0], float(row[i_px]), int(row[i_sz]))
                    except ValueError:
                        pass
                elif act == 'R':
                    orders.clear()
                # emit due samples
                while si < len(samples) and samples[si][0] <= tms:
                    sms, lbl, mv, rel_s = samples[si]
                    si += 1
                    bids = [(p, z) for s2, p, z in orders.values() if s2 == 'B']
                    asks = [(p, z) for s2, p, z in orders.values() if s2 == 'A']
                    if not bids or not asks:
                        continue
                    bb = max(p for p, _ in bids); ba = min(p for p, _ in asks)
                    mid = (bb + ba) / 2
                    b10 = sum(z for p, z in bids if p >= mid - D10)
                    a10 = sum(z for p, z in asks if p <= mid + D10)
                    b25 = sum(z for p, z in bids if p >= mid - D25)
                    a25 = sum(z for p, z in asks if p <= mid + D25)
                    wd.writerow([date, lbl, mv, int(rel_s), round(mid, 2), b10, a10, b25, a25,
                                 len(bids) + len(asks), round(ba - bb, 2)])
        for (lbl, bucket, mv), v in sorted(cx.items()):
            wc.writerow([date, lbl, mv, int(bucket), round(v[0]), round(v[1]), round(v[2]), round(v[3])])
        print(f'{date}: {len(spans)} windows, {n_rows} mbo rows replayed', flush=True)
    fo_d.close(); fo_c.close()
    print('done', flush=True)


if __name__ == '__main__':
    main()
