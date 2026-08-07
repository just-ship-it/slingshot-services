#!/usr/bin/env python3
"""Phase 2: does the BOOK thin out BEFORE large 1m candles? (Drew's quote-pull hypothesis.)

Tape volume showed no precursor (day-vol-clustering artifact) — but quote pulls don't print on the
tape. MBP-1 (top-of-book, every update, action A/C/M) can see them directly.

Per RTH event (from events.csv) and 2 same-day RTH controls: extract MBP-1 rows for the event's
primary contract in [t-360s, t+60s], aggregate per 10s bucket:
  - mean BBO depth (bid_sz+ask_sz), mean order counts (bid_ct+ask_ct), mean spread
  - cancel intensity: count of action=C rows per bucket (quote pulls), and adds (A) for the ratio
Output long-format bucket rows -> mbp_windows.csv. Analysis (03) tests whether depth/cancel
trajectories diverge from same-day controls in the minutes BEFORE the candle.

Extraction: grep alternation on the needed 'YYYY-MM-DDTHH:MM' ts_recv prefixes per day (fast prefilter
on ~1.2GB/day files), then parse. Caps 40 events/day (April 2025 has 100+/day).
"""
import csv
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
MBPDIR = BASE / 'data/orderflow/nq/mbp-1'
PRE_S, POST_S = 360, 60
BUCKET_MS = 10000
MAX_EVENTS_PER_DAY = 40


def load_windows():
    """-> {date: [(label, ms_start_of_event_minute, sym), ...]} for RTH events + 2 controls each."""
    import random
    rng = random.Random(20260723)
    ev = list(csv.DictReader(open(BASE / 'research/vacuum/events.csv')))
    ct = list(csv.DictReader(open(BASE / 'research/vacuum/controls.csv')))
    by_date = defaultdict(list)
    ct_by_date = defaultdict(list)
    for r in ct:
        if r['session'] == 'rth':
            ct_by_date[r['date']].append(r)
    for r in ev:
        if r['session'] != 'rth':
            continue
        by_date[r['date']].append(r)
    out = defaultdict(list)
    for date, rows in by_date.items():
        if len(rows) > MAX_EVENTS_PER_DAY:
            rows = rng.sample(rows, MAX_EVENTS_PER_DAY)
        for k, r in enumerate(rows):
            ms = tod_to_ms(date, int(r['tod']))
            out[date].append((f'ev{k}', ms, r['sym'], r['move']))
        pool = ct_by_date.get(date, [])
        for k, r in enumerate(rng.sample(pool, min(2 * len(rows), len(pool)))):
            ms = tod_to_ms(date, int(r['tod']))
            out[date].append((f'ct{k}', ms, r['sym'], r['move']))
    return out


def tod_to_ms(date, et_min):
    """ET minute-of-day on date -> UTC epoch ms of that minute's start."""
    from zoneinfo import ZoneInfo
    ET = ZoneInfo('America/New_York')
    dt = datetime.strptime(date, '%Y-%m-%d').replace(hour=et_min // 60, minute=et_min % 60, tzinfo=ET)
    return int(dt.timestamp() * 1000)


def minute_prefixes(ms0, ms1):
    out = set()
    m = (ms0 // 60000) * 60000
    while m < ms1:
        out.add(datetime.fromtimestamp(m / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M'))
        m += 60000
    return out


def main():
    wins = load_windows()
    outfp = BASE / 'research/vacuum/mbp_windows.csv'
    with open(outfp, 'w', newline='') as fo:
        w = csv.writer(fo)
        w.writerow(['date', 'label', 'sym', 'move', 'rel_bucket', 'n_upd', 'n_cancel', 'n_add',
                    'mean_depth', 'mean_ct', 'mean_spread'])
        for date in sorted(wins):
            fp = MBPDIR / f'glbx-mdp3-{date.replace("-", "")}.mbp-1.csv'
            if not fp.exists():
                print(f'{date}: no mbp file', flush=True)
                continue
            spans = [(lbl, ms - PRE_S * 1000, ms + 60000 + POST_S * 1000, sym, mv)
                     for (lbl, ms, sym, mv) in wins[date]]
            prefixes = set()
            for lbl, a, b, sym, mv in spans:
                prefixes |= minute_prefixes(a, b)
            pat = '|'.join(sorted(prefixes))
            try:
                res = subprocess.run(['grep', '-E', f'^({pat})', str(fp)],
                                     capture_output=True, text=True, timeout=900)
            except subprocess.TimeoutExpired:
                print(f'{date}: grep timeout', flush=True)
                continue
            # bucket aggregation per span
            agg = {}
            for line in res.stdout.split('\n'):
                p = line.split(',')
                if len(p) < 20:
                    continue
                ts = p[0]
                try:
                    tms = int(datetime.strptime(ts[:23], '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc).timestamp() * 1000)
                except ValueError:
                    continue
                sym = p[19].strip()
                action = p[5]
                for lbl, a, b, wsym, mv in spans:
                    if sym != wsym or not (a <= tms < b):
                        continue
                    rb = (tms - (a + PRE_S * 1000)) // BUCKET_MS   # 0 at event-minute start; negatives = pre
                    key = (lbl, rb)
                    st = agg.setdefault(key, dict(n=0, nc=0, na=0, dsum=0.0, csum=0.0, ssum=0.0, wsym=wsym, mv=mv))
                    st['n'] += 1
                    if action == 'C':
                        st['nc'] += 1
                    elif action == 'A':
                        st['na'] += 1
                    try:
                        bp, ap = float(p[13]), float(p[14])
                        bs, asz = float(p[15]), float(p[16])
                        bc, ac = float(p[17]), float(p[18])
                        st['dsum'] += bs + asz
                        st['csum'] += bc + ac
                        st['ssum'] += (ap - bp)
                    except ValueError:
                        pass
            for (lbl, rb), st in sorted(agg.items()):
                n = st['n']
                w.writerow([date, lbl, st['wsym'], st['mv'], int(rb), n, st['nc'], st['na'],
                            round(st['dsum'] / n, 2), round(st['csum'] / n, 2), round(st['ssum'] / n, 3)])
            print(f'{date}: {len(spans)} windows, {len(res.stdout)//1024}KB matched', flush=True)
    print(f'-> {outfp}', flush=True)


if __name__ == '__main__':
    main()
