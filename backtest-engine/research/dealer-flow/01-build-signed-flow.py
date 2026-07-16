#!/usr/bin/env python3
"""P0.1 — Signed option flow from QQQ TCBBO (dealer-positioning upgrade).

For every option trade, infer the aggressor via the quote rule against the
trade-time NBBO (OPRA does not disseminate side):

    price >= ask        -> customer BUY  (+size)   dealer sells -> short
    price <= bid        -> customer SELL (-size)   dealer buys  -> long
    interior            -> nearer side wins; exact midpoint dropped

Output: one CSV per day, per-contract signed flow:
    data/flow/qqq/signed-flow-YYYYMMDD.csv
    columns: symbol,expiry,type,strike,net_customer,buy_vol,sell_vol,mid_drop

Dealer inventory model consumes these downstream (02-build-inventory.py):
dealer position per contract = -cumulative(net_customer), expiring at expiry.
"""
import csv
import glob
import os
import sys
from collections import defaultdict
from pathlib import Path

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
SRC = BASE / 'data/tcbbo/qqq'
OUT = BASE / 'data/flow/qqq'
OUT.mkdir(parents=True, exist_ok=True)


def parse_symbol(sym):
    """'QQQ   250203C00520000' -> (expiry'2025-02-03', 'C', 520.0)"""
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


def process_file(path, out_path):
    agg = defaultdict(lambda: [0, 0, 0, 0])  # key -> [net, buy, sell, mid_drop]
    with open(path) as f:
        r = csv.reader(f)
        header = next(r)
        i_px = header.index('price')
        i_sz = header.index('size')
        i_bid = header.index('bid_px_00')
        i_ask = header.index('ask_px_00')
        i_sym = header.index('symbol')
        for row in r:
            try:
                px = float(row[i_px])
                sz = int(float(row[i_sz]))
                bid = float(row[i_bid])
                ask = float(row[i_ask])
            except (ValueError, IndexError):
                continue
            if sz <= 0:
                continue
            parsed = parse_symbol(row[i_sym])
            if not parsed:
                continue
            key = parsed
            a = agg[key]
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
        for (exp, typ, strike), (net, b, s, m) in sorted(agg.items()):
            w.writerow([exp, typ, strike, net, b, s, m])
    return len(agg)


def main():
    files = sorted(glob.glob(str(SRC / 'opra-pillar-*.tcbbo.csv')))
    done = 0
    for fp in files:
        date = os.path.basename(fp).split('-')[2].split('.')[0]
        out_path = OUT / f'signed-flow-{date}.csv'
        if out_path.exists():
            continue
        n = process_file(fp, out_path)
        done += 1
        print(f'{date}: {n} contracts', flush=True)
    print(f'done: {done} files processed')


if __name__ == '__main__':
    main()
