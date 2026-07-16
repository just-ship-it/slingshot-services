#!/usr/bin/env python3
"""P0 live-path validation — can Schwab chain-polling replace TCBBO for the
DAILY signed-flow inventory? Zero new data.

A) REAL vs REAL (2026-03-13): archived Schwab snapshots (~5-min chain polls,
   QQQ 0-2 DTE, afternoon window) vs the TCBBO tape for the same day.
   Schwab approx: per-contract volume delta between consecutive polls,
   signed by the poll's `last` vs current bid/ask (quote rule).
   Truth: trade-by-trade quote-rule signing (01's method), restricted to the
   SAME time window and SAME contracts.

B) SIMULATED polls, 15 days across the main window: downsample the TCBBO
   tape itself into 5-min poll views (cum volume, last trade px, BBO at poll
   instant) -> same delta-signing -> vs full-tape truth. Isolates the
   information loss of the polling method with real market microstructure.

Metrics (what the strategy actually consumes):
  1. per-contract daily-net SIGN agreement, |net|-weighted
  2. per-contract daily-net magnitude correlation (Spearman)
  3. per-STRIKE aggregated net sign agreement (top-20 strikes by |net|)
"""
import csv
import glob
import json
import math
import os
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
SNAP = BASE / 'data/schwab-snapshots'
TCB = BASE / 'data/tcbbo/qqq'


def sign_trade(px, bid, ask):
    if bid <= 0 or ask < bid:
        return 0
    if px >= ask:
        return 1
    if px <= bid:
        return -1
    mid = (bid + ask) / 2
    return 1 if px > mid else -1 if px < mid else 0


def tape_truth(tcbbo_path, t_lo=None, t_hi=None, contracts=None):
    """per-contract signed net from the tape (optionally window/universe-restricted)."""
    net = defaultdict(int)
    with open(tcbbo_path) as f:
        r = csv.reader(f)
        header = next(r)
        i_ts = header.index('ts_event')
        i_px, i_sz = header.index('price'), header.index('size')
        i_b, i_a = header.index('bid_px_00'), header.index('ask_px_00')
        i_sym = header.index('symbol')
        for row in r:
            ts = row[i_ts]
            if t_lo and ts < t_lo:
                continue
            if t_hi and ts > t_hi:
                continue
            sym = row[i_sym].strip()
            if contracts is not None and sym not in contracts:
                continue
            try:
                s = sign_trade(float(row[i_px]), float(row[i_b]), float(row[i_a]))
                net[sym] += s * int(float(row[i_sz]))
            except ValueError:
                continue
    return net


def poll_views_from_tape(tcbbo_path, poll_sec=300):
    """Simulate chain polls from the tape: at each poll boundary, per contract:
    cumulative volume, last trade px, latest BBO. Returns ordered poll list."""
    state = {}
    polls = []
    cur_bucket = None
    with open(tcbbo_path) as f:
        r = csv.reader(f)
        header = next(r)
        i_ts = header.index('ts_event')
        i_px, i_sz = header.index('price'), header.index('size')
        i_b, i_a = header.index('bid_px_00'), header.index('ask_px_00')
        i_sym = header.index('symbol')
        for row in r:
            ts = row[i_ts]
            try:
                epoch = int(ts[11:13]) * 3600 + int(ts[14:16]) * 60 + int(ts[17:19])
            except ValueError:
                continue
            b = epoch // poll_sec
            if cur_bucket is None:
                cur_bucket = b
            if b != cur_bucket:
                polls.append({k: dict(v) for k, v in state.items()})
                cur_bucket = b
            sym = row[i_sym].strip()
            try:
                px, sz = float(row[i_px]), int(float(row[i_sz]))
                bid, ask = float(row[i_b]), float(row[i_a])
            except ValueError:
                continue
            st = state.setdefault(sym, {'vol': 0, 'last': None, 'bid': None, 'ask': None})
            st['vol'] += sz
            st['last'] = px
            st['bid'], st['ask'] = bid, ask
        polls.append({k: dict(v) for k, v in state.items()})
    return polls


def approx_from_polls(polls):
    """Delta-sign the poll sequence."""
    net = defaultdict(int)
    prev = {}
    for view in polls:
        for sym, st in view.items():
            pv = prev.get(sym, {'vol': 0})
            dv = st['vol'] - pv.get('vol', 0)
            if dv > 0 and st['last'] is not None and st['bid'] and st['ask']:
                s = sign_trade(st['last'], st['bid'], st['ask'])
                net[sym] += s * dv
        prev = view
    return net


def compare(truth, approx, label):
    syms = [s for s in truth if truth[s] != 0]
    if not syms:
        print(f'{label}: no truth contracts')
        return
    agree_w = tot_w = 0
    pairs = []
    for s in syms:
        t = truth[s]
        a = approx.get(s, 0)
        w = abs(t)
        tot_w += w
        if a != 0 and (t > 0) == (a > 0):
            agree_w += w
        pairs.append((t, a))
    # strike-level aggregation
    def strike_of(sym):
        c = sym.split()[-1]
        return float(c[7:]) / 1000
    st_t, st_a = defaultdict(int), defaultdict(int)
    for s in set(list(truth) + list(approx)):
        st_t[strike_of(s)] += truth.get(s, 0)
        st_a[strike_of(s)] += approx.get(s, 0)
    top = sorted(st_t, key=lambda k: -abs(st_t[k]))[:20]
    st_agree = sum(1 for k in top if st_a.get(k, 0) != 0
                   and (st_t[k] > 0) == (st_a[k] > 0))
    from scipy.stats import spearmanr
    rho = spearmanr([p[0] for p in pairs], [p[1] for p in pairs])[0] if len(pairs) > 10 else float('nan')
    print(f'{label}: contracts={len(syms)} | net-sign agreement (|net|-wtd) '
          f'{100*agree_w/tot_w:.1f}% | magnitude rho {rho:.3f} | '
          f'top-20-strike sign agreement {st_agree}/20')
    return 100 * agree_w / tot_w, rho, st_agree


def main():
    # ---- A) real vs real: 2026-03-13 ----
    tpath = None
    for cand in glob.glob(str(SNAP / '**/opra-pillar-20260313.tcbbo.csv'), recursive=True):
        tpath = cand
        break
    day_dir = SNAP / '2026-03-13'
    if tpath and day_dir.exists():
        snaps = sorted(glob.glob(str(day_dir / 'snapshot_*.json')))
        views = []
        window_lo = window_hi = None
        universe = set()
        for fp in snaps:
            j = json.load(open(fp))
            ts = j['timestamp']
            window_lo = window_lo or ts
            window_hi = ts
            view = {}
            for exp in j['chains'].get('QQQ', []):
                for o in exp['options']:
                    sym = o['symbol'].strip()
                    universe.add(sym)
                    view[sym] = {'vol': o.get('volume') or 0, 'last': o.get('last'),
                                 'bid': o.get('bid'), 'ask': o.get('ask')}
            views.append(view)
        truth = tape_truth(tpath, t_lo=window_lo, t_hi=window_hi, contracts=universe)
        approx = approx_from_polls(views)
        print('=== A) REAL Schwab polls vs REAL tape — 2026-03-13 '
              f'({len(snaps)} polls, window {window_lo[11:16]}→{window_hi[11:16]}Z) ===')
        compare(truth, approx, 'real-vs-real')
    else:
        print('A) overlap day inputs missing')

    # ---- B) simulated polls across the main window ----
    print('\n=== B) SIMULATED 5-min polls from tape (method information-loss) ===')
    files = sorted(glob.glob(str(TCB / 'opra-pillar-*.tcbbo.csv')))
    step = max(1, len(files) // 15)
    stats = []
    for fp in files[::step][:15]:
        d8 = os.path.basename(fp).split('-')[2].split('.')[0]
        truth = tape_truth(fp)
        approx = approx_from_polls(poll_views_from_tape(fp))
        r = compare(truth, approx, d8)
        if r:
            stats.append(r)
    if stats:
        import statistics
        print(f'\nacross {len(stats)} days: sign-agreement mean '
              f'{statistics.mean(s[0] for s in stats):.1f}% '
              f'(min {min(s[0] for s in stats):.1f}) | rho mean '
              f'{statistics.mean(s[1] for s in stats):.3f} | strike-sign mean '
              f'{statistics.mean(s[2] for s in stats):.1f}/20')


if __name__ == '__main__':
    main()
