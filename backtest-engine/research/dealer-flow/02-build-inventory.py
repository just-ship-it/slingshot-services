#!/usr/bin/env python3
"""P0.2 — Dealer inventory + per-strike dealer gamma sign, daily, causal.

Dealer position per contract = -(cumulative net customer flow) from the
contract's first traded day, dropped at expiry. For day D, positioning is
AS OF D-1 close (prior-close causality: knowable before D's open).

Per-strike dealer gamma proxy: sum over live contracts at the strike of
pos * gamma_weight(strike, expiry, spot_ref), gamma from B-S with flat
sigma=0.25 (documented v1 simplification — we need the SIGN and rough
magnitude ranking at near-spot strikes, not precise greeks; flow-signing is
the upgrade, not the vol model). spot_ref = D-1 QQQ close.

Output: data/flow/qqq/dealer-strikes-YYYYMMDD.csv
  strike, dealer_gamma, net_pos, pos_calls, pos_puts,
  pos_dte0_5, pos_dte6_30, pos_dte31p   (|position| by DTE bucket)
"""
import csv
import glob
import math
import os
from collections import defaultdict
from datetime import date
from pathlib import Path

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
FLOW = BASE / 'data/flow/qqq'
SIGMA = 0.25
R = 0.05


def load_spot_closes():
    """QQQ daily close from 1m file (last bar per day)."""
    closes = {}
    with open(BASE / 'data/ohlcv/qqq/QQQ_ohlcv_1m.csv') as f:
        r = csv.reader(f)
        header = next(r)
        i_ts, i_close = header.index('ts_event'), header.index('close')
        for row in r:
            if len(row) <= max(i_ts, i_close):
                continue
            d = row[i_ts][:10]
            try:
                closes[d] = float(row[i_close])
            except ValueError:
                continue
    return closes


def gamma_weight(spot, strike, dte):
    T = max(dte, 0.5) / 365.0
    sig_sqrt = SIGMA * math.sqrt(T)
    try:
        d1 = (math.log(spot / strike) + (R + 0.5 * SIGMA ** 2) * T) / sig_sqrt
    except ValueError:
        return 0.0
    pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    return pdf / (spot * sig_sqrt)


def main():
    closes = load_spot_closes()
    files = sorted(glob.glob(str(FLOW / 'signed-flow-*.csv')))
    dates = [os.path.basename(f).split('-')[2].split('.')[0] for f in files]

    # dealer position per (expiry, type, strike); built cumulatively
    pos = defaultdict(int)

    for idx, (fp, d8) in enumerate(zip(files, dates)):
        d_iso = f'{d8[:4]}-{d8[4:6]}-{d8[6:8]}'

        # BEFORE ingesting day D's flow, positioning reflects flows <= D-1:
        # emit the strike file for day D (as-of prior close). Skip day 1
        # (no prior flow).
        if idx > 0:
            spot = None
            # prior close = most recent close strictly before d_iso
            prior_dates = [dd for dd in dates[:idx]]
            for dd in reversed(prior_dates):
                di = f'{dd[:4]}-{dd[4:6]}-{dd[6:8]}'
                if di in closes:
                    spot = closes[di]
                    break
            if spot:
                today = date.fromisoformat(d_iso)
                strikes = defaultdict(lambda: [0.0, 0, 0, 0, 0, 0, 0])
                for (exp, typ, k), p in pos.items():
                    if p == 0:
                        continue
                    ed = date.fromisoformat(exp)
                    dte = (ed - today).days
                    if dte < 0:
                        continue
                    g = gamma_weight(spot, k, dte) * p
                    a = strikes[k]
                    a[0] += g
                    a[1] += p
                    if typ == 'C':
                        a[2] += p
                    else:
                        a[3] += p
                    if dte <= 5:
                        a[4] += abs(p)
                    elif dte <= 30:
                        a[5] += abs(p)
                    else:
                        a[6] += abs(p)
                out = FLOW / f'dealer-strikes-{d8}.csv'
                with open(out, 'w', newline='') as f:
                    w = csv.writer(f)
                    w.writerow(['strike', 'dealer_gamma', 'net_pos', 'pos_calls',
                                'pos_puts', 'pos_dte0_5', 'pos_dte6_30', 'pos_dte31p'])
                    for k in sorted(strikes):
                        a = strikes[k]
                        w.writerow([k, f'{a[0]:.6e}', a[1], a[2], a[3],
                                    a[4], a[5], a[6]])

        # ingest day D's signed flow (dealer takes the other side)
        with open(fp) as f:
            for r in csv.DictReader(f):
                key = (r['expiry'], r['type'], float(r['strike']))
                pos[key] -= int(r['net_customer'])

        # prune expired
        today = date.fromisoformat(d_iso)
        dead = [k for k in pos if date.fromisoformat(k[0]) < today]
        for k in dead:
            del pos[k]

        if idx % 50 == 0:
            print(f'{d_iso}: {len(pos)} live contracts', flush=True)

    print('done')


if __name__ == '__main__':
    main()
