#!/usr/bin/env python3
"""ODTE-flow P0b — QQQ intraday 0DTE dealer-inventory timeseries (the on-thesis core).

Reconstructs the dealer's 0DTE (exp==D) book AS IT EVOLVES through day D, causal:
  start = overnight-held position in exp==D contracts (cumulative signed flow through D-1 close)
  + intraday: sign every same-day-expiry trade from tcbbo (trade-time BBO quote rule), dealer takes
    the other side (customer buy -> dealer short that contract).
Snapshot the 0DTE gamma profile every 15 min of RTH (9:30..15:45 ET). At time T only trades <= T are used.

Per snapshot (spot = QQQ 1m close at T):
  net0_gamma (sign = regime: dealers LONG->fade/pin, SHORT->chase/trend), absg0 (magnitude),
  pin_pos = strike of max POSITIVE dealer gamma (flow magnet dealers defend),
  gflip0 = zero-gamma-flip strike, cg_imb = (gamma above spot - below)/abs total.
Note: flat sigma=0.25 & dte=0 TTE (v1) — we need SIGN + relative strike ranking, not precise greeks.
0DTE max-|gamma| ~ ATM (near-tautological) so we key on SIGN / pos-gamma magnet / flip, not raw max-abs.

Output: research/odte-flow/qqq-0dte-intraday.csv
  date, et_min, spot_qqq, net0_gamma, net0_sign, absg0, pin_pos, gflip0, cg_imb, n_trades_cum
"""
import bisect
import csv
import glob
import math
import os
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
TCBBO = BASE / 'data/tcbbo/qqq'
FLOW = BASE / 'data/flow/qqq'
OUT = BASE / 'research/odte-flow/qqq-0dte-intraday.csv'
ET = ZoneInfo('America/New_York')
UTC = ZoneInfo('UTC')
SIGMA, R = 0.25, 0.05
SNAP_ET = [9*60+30 + 15*k for k in range(0, 26)]   # 9:30 .. 15:45 ET, 15-min


def parse_symbol(sym):
    s = sym.strip().split()
    if not s:
        return None
    c = s[-1]
    if len(c) < 15:
        return None
    try:
        exp = f'20{c[0:2]}-{c[2:4]}-{c[4:6]}'
        typ = c[6]
        k = float(c[7:]) / 1000
    except ValueError:
        return None
    return (exp, typ, k) if typ in 'CP' else None


def gamma_weight(spot, strike):
    T = 0.5 / 365.0
    ss = SIGMA * math.sqrt(T)
    try:
        d1 = (math.log(spot / strike) + (R + 0.5 * SIGMA**2) * T) / ss
    except (ValueError, ZeroDivisionError):
        return 0.0
    return math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi) / (spot * ss)


def load_qqq_1m():
    """(date, utc_minute) -> close."""
    m = {}
    with open(BASE / 'data/ohlcv/qqq/QQQ_ohlcv_1m.csv') as f:
        r = csv.reader(f)
        h = next(r)
        i_ts, i_c = h.index('ts_event'), h.index('close')
        for row in r:
            if len(row) <= max(i_ts, i_c):
                continue
            ts = row[i_ts]
            try:
                m[(ts[:10], int(ts[11:13]) * 60 + int(ts[14:16]))] = float(row[i_c])
            except (ValueError, IndexError):
                continue
    return m


def et_to_utc_min(d_iso, et_min):
    dt = datetime(int(d_iso[:4]), int(d_iso[5:7]), int(d_iso[8:10]),
                  et_min // 60, et_min % 60, tzinfo=ET)
    u = dt.astimezone(UTC)
    return u.hour * 60 + u.minute


def snapshot(intr, spot, gcache):
    g0 = defaultdict(float)
    net = absg = above = below = 0.0
    for (typ, k), p in intr.items():
        if p == 0:
            continue
        gw = gcache.get(k)
        if gw is None:
            gw = gamma_weight(spot, k); gcache[k] = gw
        g = gw * p
        g0[k] += g; net += g; absg += abs(g)
        if k >= spot:
            above += g
        else:
            below += g
    if not g0:
        return None
    pin_pos = max(g0, key=lambda k: g0[k])
    # zero-gamma flip (cumulative low->high)
    flip = ''
    ks = sorted(g0); cum = 0.0; pk = pc = None
    for k in ks:
        cum += g0[k]
        if pc is not None and (pc < 0 <= cum or pc > 0 >= cum):
            flip = round((pk + k) / 2, 2); break
        pk, pc = k, cum
    cg_imb = (above - below) / absg if absg > 0 else 0.0
    return net, absg, pin_pos, flip, cg_imb


def process_day(d8, qqq1m, pos):
    d_iso = f'{d8[:4]}-{d8[4:6]}-{d8[6:8]}'
    d6 = d8[2:]
    # overnight seed: exp==D contracts in cumulative pos
    intr = defaultdict(int)
    for (exp, typ, k), p in pos.items():
        if exp == d_iso and p != 0:
            intr[(typ, k)] += p
    # snapshot schedule in UTC minutes
    snaps = [(et_to_utc_min(d_iso, em), em) for em in SNAP_ET]
    snaps.sort()
    snap_utc = [s[0] for s in snaps]
    next_i = 0
    out_rows = []
    gcache = {}
    ntr = 0
    fn = TCBBO / f'opra-pillar-{d8}.tcbbo.csv'
    with open(fn) as f:
        r = csv.reader(f)
        h = next(r)
        i_ts = h.index('ts_event'); i_px = h.index('price'); i_sz = h.index('size')
        i_bid = h.index('bid_px_00'); i_ask = h.index('ask_px_00'); i_sym = h.index('symbol')
        for row in r:
            try:
                sym = row[i_sym]
            except IndexError:
                continue
            if d6 not in sym:      # cheap 0DTE pre-filter (expiry substring)
                continue
            parsed = parse_symbol(sym)
            if not parsed or parsed[0] != d_iso:
                continue
            ts = row[i_ts]
            try:
                umin = int(ts[11:13]) * 60 + int(ts[14:16])
            except (ValueError, IndexError):
                continue
            # emit snapshots whose UTC minute we've passed
            while next_i < len(snap_utc) and umin >= snap_utc[next_i]:
                su, em = snaps[next_i]
                spot = qqq1m.get((d_iso, su)) or qqq1m.get((d_iso, su - 1)) or qqq1m.get((d_iso, su + 1))
                if spot:
                    snp = snapshot(intr, spot, gcache)
                    if snp:
                        net, absg, pin, flip, imb = snp
                        out_rows.append([d_iso, em, round(spot, 2), f'{net:.6e}',
                                         1 if net > 0 else -1 if net < 0 else 0,
                                         f'{absg:.6e}', pin, flip, f'{imb:.4f}', ntr])
                gcache = {}  # spot changed -> recompute gamma
                next_i += 1
            try:
                px = float(row[i_px]); sz = int(float(row[i_sz]))
                bid = float(row[i_bid]); ask = float(row[i_ask])
            except (ValueError, IndexError):
                continue
            if sz <= 0:
                continue
            typ, k = parsed[1], parsed[2]
            cust = 0
            if bid > 0 and ask >= bid:
                if px >= ask:
                    cust = sz
                elif px <= bid:
                    cust = -sz
                else:
                    mid = (bid + ask) / 2
                    cust = sz if px > mid else -sz if px < mid else 0
            intr[(typ, k)] -= cust   # dealer opposite
            ntr += 1
    # flush remaining snapshots (end of tape) using last spot
    while next_i < len(snap_utc):
        su, em = snaps[next_i]
        spot = qqq1m.get((d_iso, su)) or qqq1m.get((d_iso, su - 1))
        if spot:
            snp = snapshot(intr, spot, {})
            if snp:
                net, absg, pin, flip, imb = snp
                out_rows.append([d_iso, em, round(spot, 2), f'{net:.6e}',
                                 1 if net > 0 else -1 if net < 0 else 0,
                                 f'{absg:.6e}', pin, flip, f'{imb:.4f}', ntr])
        next_i += 1
    return out_rows, ntr


def main():
    import sys
    only = sys.argv[1] if len(sys.argv) > 1 else None
    qqq1m = load_qqq_1m()
    sf_files = sorted(glob.glob(str(FLOW / 'signed-flow-*.csv')))
    sf_dates = {os.path.basename(f).split('-')[2].split('.')[0]: f for f in sf_files}
    tc_files = sorted(glob.glob(str(TCBBO / 'opra-pillar-*.tcbbo.csv')))
    tc_dates = [os.path.basename(f).split('-')[2].split('.')[0] for f in tc_files]

    pos = defaultdict(int)
    all_rows = []
    hdr = ['date', 'et_min', 'spot_qqq', 'net0_gamma', 'net0_sign', 'absg0', 'pin_pos', 'gflip0', 'cg_imb', 'n_trades_cum']
    # to keep the overnight seed correct, ingest signed-flow for ALL dates in order;
    # for dates that also have a tcbbo file, produce intraday snapshots first (as-of prior close seed).
    for d8 in sorted(set(list(sf_dates) + tc_dates)):
        d_iso = f'{d8[:4]}-{d8[4:6]}-{d8[6:8]}'
        if d8 in tc_dates and (only is None or d8 == only):
            rows, ntr = process_day(d8, qqq1m, pos)
            all_rows.extend(rows)
            print(f'{d_iso}: {len(rows)} snaps, {ntr} 0DTE trades', flush=True)
        # ingest this day's signed flow into cumulative pos (for future seeds)
        if d8 in sf_dates:
            with open(sf_dates[d8]) as f:
                for r in csv.DictReader(f):
                    pos[(r['expiry'], r['type'], float(r['strike']))] -= int(r['net_customer'])
            today = date.fromisoformat(d_iso)
            for k in [k for k in pos if date.fromisoformat(k[0]) < today]:
                del pos[k]
        if only and d8 == only:
            break

    if not only:
        with open(OUT, 'w', newline='') as f:
            w = csv.writer(f); w.writerow(hdr); w.writerows(all_rows)
        print(f'wrote {len(all_rows)} snapshot rows -> {OUT}')
    else:
        print(hdr)
        for row in all_rows[:30]:
            print(row)


if __name__ == '__main__':
    main()
