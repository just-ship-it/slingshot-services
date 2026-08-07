#!/usr/bin/env python3
"""ODTE-flow P0.1 — SPX signed option flow (cross-validation instrument for the QQQ dealer-flow path).

SPX has per-trade options (`data/options-trades/spx`) but NO trade-time BBO (OPRA side='N', and the
trades file carries no bid/ask). We reconstruct the aggressor by joining each trade to its contract's
prevailing MINUTE BBO from `data/cbbo-1m/spx` (per-contract 1-min top-of-book grid):

    price >= ask   -> customer BUY  (+size)   dealer short
    price <= bid   -> customer SELL (-size)   dealer long
    interior       -> nearer side; exact midpoint dropped

vs the QQQ path (true trade-time TCBBO), this is coarser: the quote is the snapshot at the trade's
minute-start, held constant through the minute. For DAILY per-contract NET flow this is robust (random
intra-minute quote drift averages out); documented v1 limitation. Trades before the first cbbo snapshot
minute use the first snapshot (forward-fill; affects only the first ~1 min of aggressor signs).

Output (drop-in compatible with research/dealer-flow/02 schema, so inventory reuses it):
    data/flow/spx/signed-flow-YYYYMMDD.csv
    columns: expiry,type,strike,net_customer,buy_vol,sell_vol,mid_drop
"""
import bisect
import csv
import glob
import os
import sys
from collections import defaultdict
from pathlib import Path

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
TRADES = BASE / 'data/options-trades/spx'
CBBO = BASE / 'data/cbbo-1m/spx'
OUT = BASE / 'data/flow/spx'
OUT.mkdir(parents=True, exist_ok=True)


def parse_symbol(sym):
    """'SPX   250221P05700000' -> ('2025-02-21','P',5700.0)"""
    s = sym.strip().split()
    if not s:
        return None
    c = s[-1]
    if len(c) < 15:
        return None
    try:
        exp = f'20{c[0:2]}-{c[2:4]}-{c[4:6]}'
        typ = c[6]
        strike = float(c[7:]) / 1000
    except ValueError:
        return None
    if typ not in 'CP':
        return None
    return exp, typ, strike


def minute_of_day(ts):
    """'2025-01-02T14:31:00...' -> 14*60+31 (UTC minute index)."""
    try:
        return int(ts[11:13]) * 60 + int(ts[14:16])
    except (ValueError, IndexError):
        return None


def build_bbo_grid(cbbo_path, traded):
    """symbol -> (sorted minute list, parallel [ (bid,ask) ]) for traded contracts only."""
    grid = defaultdict(lambda: ([], []))
    with open(cbbo_path) as f:
        r = csv.reader(f)
        h = next(r)
        i_ts = h.index('ts_recv')
        i_bid = h.index('bid_px_00')
        i_ask = h.index('ask_px_00')
        i_sym = h.index('symbol')
        for row in r:
            try:
                sym = row[i_sym]
            except IndexError:
                continue
            if sym not in traded:
                continue
            m = minute_of_day(row[i_ts])
            if m is None:
                continue
            try:
                bid = float(row[i_bid]); ask = float(row[i_ask])
            except ValueError:
                continue
            mins, quotes = grid[sym]
            # rows are time-ordered so minutes arrive ascending per symbol
            if mins and m == mins[-1]:
                quotes[-1] = (bid, ask)   # keep last snapshot within the minute
            else:
                mins.append(m); quotes.append((bid, ask))
    return grid


def lookup_bbo(grid, sym, m):
    entry = grid.get(sym)
    if not entry:
        return None
    mins, quotes = entry
    j = bisect.bisect_right(mins, m) - 1
    if j < 0:
        j = 0   # trade before first snapshot -> forward-fill from first
    return quotes[j]


def process_day(trades_path, cbbo_path, out_path):
    # pass 1: read trades, collect traded symbols
    trades = []
    traded = set()
    with open(trades_path) as f:
        r = csv.reader(f)
        h = next(r)
        i_ts = h.index('ts_event')
        i_px = h.index('price')
        i_sz = h.index('size')
        i_sym = h.index('symbol')
        for row in r:
            try:
                sym = row[i_sym]
                px = float(row[i_px]); sz = int(float(row[i_sz]))
            except (ValueError, IndexError):
                continue
            if sz <= 0:
                continue
            m = minute_of_day(row[i_ts])
            if m is None:
                continue
            trades.append((sym, m, px, sz))
            traded.add(sym)

    grid = build_bbo_grid(cbbo_path, traded)

    agg = defaultdict(lambda: [0, 0, 0, 0])   # (exp,typ,strike) -> [net,buy,sell,mid_drop]
    no_quote = 0
    for sym, m, px, sz in trades:
        parsed = parse_symbol(sym)
        if not parsed:
            continue
        bbo = lookup_bbo(grid, sym, m)
        a = agg[parsed]
        if not bbo:
            no_quote += 1
            a[3] += sz
            continue
        bid, ask = bbo
        if bid > 0 and ask >= bid:
            if px >= ask:
                a[0] += sz; a[1] += sz
            elif px <= bid:
                a[0] -= sz; a[2] += sz
            else:
                mid = (bid + ask) / 2
                if px > mid:
                    a[0] += sz; a[1] += sz
                elif px < mid:
                    a[0] -= sz; a[2] += sz
                else:
                    a[3] += sz
        else:
            a[3] += sz

    with open(out_path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['expiry', 'type', 'strike', 'net_customer', 'buy_vol', 'sell_vol', 'mid_drop'])
        for (exp, typ, strike), (net, b, s, md) in sorted(agg.items()):
            w.writerow([exp, typ, strike, net, b, s, md])
    return len(agg), len(trades), no_quote


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    tfiles = sorted(glob.glob(str(TRADES / 'opra-pillar-*.trades.csv')))
    done = 0
    for tp in tfiles:
        d8 = os.path.basename(tp).split('-')[2].split('.')[0]
        if only and d8 != only:
            continue
        cp = CBBO / f'opra-pillar-{d8}.cbbo-1m.csv'
        if not cp.exists():
            print(f'{d8}: NO cbbo-1m file, skip', flush=True)
            continue
        out_path = OUT / f'signed-flow-{d8}.csv'
        if out_path.exists() and not only:
            continue
        nc, nt, nq = process_day(tp, cp, out_path)
        done += 1
        print(f'{d8}: {nc} contracts, {nt} trades, {nq} no-quote ({100*nq/max(nt,1):.1f}%)', flush=True)
    print(f'done: {done} files processed')


if __name__ == '__main__':
    main()
