#!/usr/bin/env python3
"""ODTE-flow P0.2 — QQQ 0DTE daily positioning features (signed, causal, as-of prior close).

Rebuilds dealer inventory cumulatively from signed flow (dealer pos = -cum(net_customer), pruned at expiry),
then for each day D emits features computed AS-OF D-1 CLOSE, restricted to the **day-D 0DTE book**
(contracts whose expiry == D). This is the overnight-held 0DTE dealer book — knowable before D's open,
the correct input for the opening-range hypothesis (H1).

Signed dealer gamma per strike = pos * BS-gamma(spot=D-1 QQQ close, strike, dte). Flat sigma=0.25 (v1;
we need SIGN + near-spot ranking, same simplification as research/dealer-flow/02).

Output: research/odte-flow/qqq-0dte-daily.csv, one row per day:
  date, spot_qqq, n0_contracts, net0_gamma, net0_gamma_sign, absg0,
  call0_pos, put0_pos, pin_maxabs, pin_maxpos, gflip0,        # 0DTE book (exp==D)
  netAll_gamma, netAll_sign, absgAll                          # all-DTE, for "0DTE vs all-OI" contrast
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
OUT = BASE / 'research/odte-flow/qqq-0dte-daily.csv'
SIGMA = 0.25
R = 0.05


def load_closes():
    closes = {}
    with open(BASE / 'data/ohlcv/qqq/QQQ_ohlcv_1m.csv') as f:
        r = csv.reader(f)
        h = next(r)
        i_ts, i_c = h.index('ts_event'), h.index('close')
        for row in r:
            if len(row) <= max(i_ts, i_c):
                continue
            try:
                closes[row[i_ts][:10]] = float(row[i_c])
            except ValueError:
                continue
    return closes


def gamma_weight(spot, strike, dte):
    T = max(dte, 0.5) / 365.0
    ss = SIGMA * math.sqrt(T)
    try:
        d1 = (math.log(spot / strike) + (R + 0.5 * SIGMA ** 2) * T) / ss
    except (ValueError, ZeroDivisionError):
        return 0.0
    pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    return pdf / (spot * ss)


def zero_gamma_flip(strike_gamma):
    """cumulative signed gamma zero-cross (low->high strikes)."""
    if not strike_gamma:
        return ''
    ks = sorted(strike_gamma)
    cum = 0.0
    prev_k = None
    prev_cum = None
    for k in ks:
        cum += strike_gamma[k]
        if prev_cum is not None and (prev_cum < 0 <= cum or prev_cum > 0 >= cum):
            return round((prev_k + k) / 2, 2)
        prev_k, prev_cum = k, cum
    return ''


def main():
    closes = load_closes()
    files = sorted(glob.glob(str(FLOW / 'signed-flow-*.csv')))
    dates = [os.path.basename(f).split('-')[2].split('.')[0] for f in files]
    pos = defaultdict(int)

    rows = []
    for idx, (fp, d8) in enumerate(zip(files, dates)):
        d_iso = f'{d8[:4]}-{d8[4:6]}-{d8[6:8]}'
        if idx > 0:
            # spot = most recent close strictly before d_iso
            spot = None
            for dd in reversed(dates[:idx]):
                di = f'{dd[:4]}-{dd[4:6]}-{dd[6:8]}'
                if di in closes:
                    spot = closes[di]
                    break
            if spot:
                today = date.fromisoformat(d_iso)
                g0 = defaultdict(float)      # 0DTE (exp==D) signed gamma by strike
                net0 = absg0 = call0 = put0 = 0.0
                n0 = 0
                netAll = absgAll = 0.0
                for (exp, typ, k), p in pos.items():
                    if p == 0:
                        continue
                    ed = date.fromisoformat(exp)
                    dte = (ed - today).days
                    if dte < 0:
                        continue
                    g = gamma_weight(spot, k, dte) * p
                    netAll += g
                    absgAll += abs(g)
                    if exp == d_iso:   # the day-D 0DTE book
                        g0[k] += g
                        net0 += g
                        absg0 += abs(g)
                        n0 += 1
                        if typ == 'C':
                            call0 += p
                        else:
                            put0 += p
                pin_maxabs = max(g0, key=lambda k: abs(g0[k])) if g0 else ''
                pin_maxpos = max(g0, key=lambda k: g0[k]) if g0 else ''
                rows.append(dict(
                    date=d_iso, spot_qqq=round(spot, 2), n0_contracts=n0,
                    net0_gamma=f'{net0:.6e}', net0_gamma_sign=(1 if net0 > 0 else -1 if net0 < 0 else 0),
                    absg0=f'{absg0:.6e}', call0_pos=int(call0), put0_pos=int(put0),
                    pin_maxabs=pin_maxabs, pin_maxpos=pin_maxpos, gflip0=zero_gamma_flip(g0),
                    netAll_gamma=f'{netAll:.6e}', netAll_sign=(1 if netAll > 0 else -1 if netAll < 0 else 0),
                    absgAll=f'{absgAll:.6e}'))

        # ingest day D flow (dealer opposite side)
        with open(fp) as f:
            for r in csv.DictReader(f):
                pos[(r['expiry'], r['type'], float(r['strike']))] -= int(r['net_customer'])
        today = date.fromisoformat(d_iso)
        for k in [k for k in pos if date.fromisoformat(k[0]) < today]:
            del pos[k]

    with open(OUT, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f'wrote {len(rows)} days -> {OUT}')
    # quick sanity
    signs = [r['net0_gamma_sign'] for r in rows]
    print(f"net0 sign split: +{signs.count(1)} / -{signs.count(-1)} / 0:{signs.count(0)}")
    n0s = [r['n0_contracts'] for r in rows]
    print(f"0DTE book size: median {sorted(n0s)[len(n0s)//2]} contracts, "
          f"days with 0 0DTE contracts: {n0s.count(0)}")


if __name__ == '__main__':
    main()
