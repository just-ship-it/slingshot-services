#!/usr/bin/env python3
"""B3 stage 4: honest 1s simulation of fading fast-arrival fresh extremes.

Trigger: B3-events.csv event (fresh 120m extreme at 1m close) with
arr5 >= 0.089 (dev-2021-24 q80, FIXED). Fade: short at new highs, long at
new lows. Order placed at event bar close instant (epoch+60s).

Entry styles:
  L : limit at E (the extreme). TTL 15 min, else cancel.
  C : confirmation - first 1m close back inside the old range (beyond prior
      120-bar extreme) within 15 min of event close; market at next 1s open.
Exits (short shown; long mirrored):
  stop  = E + S,   S in {15, 25} pts        -> fill stop + 0.5 slip
  target= E - T,   T in {0.10, 0.20}*atr14  -> limit, exact fill
  max hold in {30, 60} min from fill        -> 1s open + 0.25 slip
  hard flat 15:45 ET                        -> 1s open + 0.25 slip
  same-1s-bar stop+target -> STOP. No fills at/after 15:15 ET.
Costs: $5 RT commission, $20/pt. One contract, non-overlapping per config.
Simulation walks 1s bars of the event's own symbol only, from order
placement onward; exits only from the fill bar onward.

Usage: python3 B3-04-sim.py 2021 2024   (year range; val = 2025 2026 ONCE)
       optional 3rd arg: slipmult (default 1.0; use 2.0 for sensitivity)
       optional 4th arg: arr5 threshold override (default 0.089)
"""
import json
import os
import sys
import numpy as np
import pandas as pd
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
ONESEC = '/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1s.csv'
Y0, Y1 = int(sys.argv[1]), int(sys.argv[2])
SLIPM = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
THRESH = float(sys.argv[4]) if len(sys.argv) > 4 else 0.089
STOP_SLIP = 0.5 * SLIPM
MKT_SLIP = 0.25 * SLIPM
COMM = 5.0
PTVAL = 20.0
ET = ZoneInfo('America/New_York')

print(f'B3 sim years {Y0}-{Y1} slipmult={SLIPM} arr5>={THRESH}')
with open(ONESEC.replace('.csv', '.index.json')) as f:
    IDX = json.load(f)['minutes']
F = open(ONESEC, 'rb')

ev = pd.read_csv(os.path.join(HERE, 'B3-events.csv'))
ev = ev[(ev['year'] >= Y0) & (ev['year'] <= Y1) & (ev['arr5'] >= THRESH)]
ev = ev.sort_values('epoch').reset_index(drop=True)

# prior-extreme (old range edge) + event-bar close, from 1m cache
cache = pd.read_csv(os.path.join(HERE, 'cache_nq_primary_1m.csv'),
                    usecols=['high', 'low', 'close'])
h1 = cache['high'].to_numpy(); l1 = cache['low'].to_numpy()
roll_max = pd.Series(h1).rolling(120).max().shift(1).to_numpy()
roll_min = pd.Series(l1).rolling(120).min().shift(1).to_numpy()
ev['prior_ext'] = np.where(ev['side'] == 1, roll_max[ev['i']], roll_min[ev['i']])
ev['ev_close'] = cache['close'].to_numpy()[ev['i']]
del cache, h1, l1

_day_epoch = {}
def day_epoch(ds):
    e = _day_epoch.get(ds)
    if e is None:
        e = int(datetime(int(ds[:4]), int(ds[5:7]), int(ds[8:10]),
                         tzinfo=timezone.utc).timestamp())
        _day_epoch[ds] = e
    return e

_eod_cache = {}
def et_cutoffs(et_date):
    """(epoch of 15:15 ET, epoch of 15:45 ET) for an ET calendar date."""
    got = _eod_cache.get(et_date)
    if got is None:
        y, m, d = int(et_date[:4]), int(et_date[5:7]), int(et_date[8:10])
        base = datetime(y, m, d, 15, 15, tzinfo=ET)
        got = (int(base.timestamp()), int(base.timestamp()) + 1800)
        _eod_cache[et_date] = got
    return got

def read_1s(start_epoch, end_epoch, sym):
    """1s arrays (ts,o,h,l,c) for [start,end) filtered to sym."""
    mins = range(start_epoch // 60 * 60, end_epoch, 60)
    entries = [IDX.get(str(m * 1000)) for m in mins]
    entries = [e for e in entries if e]
    if not entries:
        return None
    lo = min(e['offset'] for e in entries)
    hi = max(e['offset'] + e['length'] for e in entries)
    F.seek(lo)
    blob = F.read(hi - lo)
    symb = sym.encode()
    ts_l, o_l, h_l, l_l, c_l = [], [], [], [], []
    for line in blob.split(b'\n'):
        if not line.endswith(symb):
            continue
        p = line.split(b',')
        if p[9] != symb:
            continue
        tss = p[0]
        de = day_epoch(tss[:10].decode())
        ep = de + int(tss[11:13]) * 3600 + int(tss[14:16]) * 60 + int(tss[17:19])
        if ep < start_epoch or ep >= end_epoch:
            continue
        ts_l.append(ep); o_l.append(float(p[4])); h_l.append(float(p[5]))
        l_l.append(float(p[6])); c_l.append(float(p[7]))
    if not ts_l:
        return None
    a = np.argsort(np.asarray(ts_l), kind='stable')
    return (np.asarray(ts_l)[a], np.asarray(o_l)[a], np.asarray(h_l)[a],
            np.asarray(l_l)[a], np.asarray(c_l)[a])

CONFIGS = []
for entry in ('L', 'C'):
    for S in (15.0, 25.0):
        for Tfrac in (0.10, 0.20):
            for hold in (30, 60):
                CONFIGS.append((entry, S, Tfrac, hold))
last_exit = {cfg: 0 for cfg in CONFIGS}
trades = {cfg: [] for cfg in CONFIGS}
ENTRY_TTL = 900
MAXWIN = ENTRY_TTL + 120 * 60 + 120

nev = len(ev)
print(f'eligible events: {nev}')
for k, e in enumerate(ev.itertuples()):
    if k % 500 == 0:
        print(f'  {k}/{nev}')
    t_close = int(e.epoch) + 60
    cut_entry, cut_flat = et_cutoffs(e.et_date)
    # event in the no-entry window (15:15-18:00 ET)?  ET hour from et_min
    if 15 * 60 + 15 <= e.et_min < 18 * 60:
        continue
    data = read_1s(t_close, t_close + MAXWIN, e.sym)
    if data is None:
        continue
    ts, o, h, l, c = data
    side = e.side           # +1 high event -> SHORT fade; -1 -> LONG fade
    E = e.E
    # applicable flat cutoff: only if event is before 15:45 ET same ET day
    flat_ts = cut_flat if (e.et_min < 15 * 60 + 45) else None

    # no-fill window: [15:15, 18:00) ET on the event's ET date
    def fill_blocked(t):
        return cut_entry <= t < cut_entry + 9900

    # ---- entry fills per style ----
    fills = {}
    # L: limit at E
    ttl_end = t_close + ENTRY_TTL
    touch = (h >= E) if side == 1 else (l <= E)
    cand = np.flatnonzero((ts < ttl_end) & touch)
    if len(cand):
        fi = cand[0]
        if not fill_blocked(ts[fi]):
            fills['L'] = (fi, E)
    # C: first 1m close back inside old range within TTL
    pe = e.prior_ext
    conf_ts = None
    inside = (lambda x: x < pe) if side == 1 else (lambda x: x > pe)
    if inside(e.ev_close):
        conf_ts = t_close
    else:
        for m in range(1, ENTRY_TTL // 60):
            w = np.flatnonzero((ts >= t_close + (m - 1) * 60)
                               & (ts < t_close + m * 60))
            if w.size and inside(c[w[-1]]):
                conf_ts = t_close + m * 60
                break
    if conf_ts is not None:
        after = np.flatnonzero(ts >= conf_ts)
        if after.size:
            fi = after[0]
            if not fill_blocked(ts[fi]):
                px = o[fi] - MKT_SLIP * side  # short sells lower, long buys higher
                fills['C'] = (fi, px)

    for cfg in CONFIGS:
        entry, S, Tfrac, hold = cfg
        if entry not in fills:
            continue
        if t_close < last_exit[cfg]:
            continue
        fi, fpx = fills[entry]
        fill_ts = ts[fi]
        stop = E + S * side
        target = E - Tfrac * e.atr * side
        hold_end = fill_ts + hold * 60
        # walk from fill bar onward
        seg = slice(fi, len(ts))
        tseg = ts[seg]
        if side == 1:
            hit_stop = h[seg] >= stop
            hit_tgt = l[seg] <= target
        else:
            hit_stop = l[seg] <= stop
            hit_tgt = h[seg] >= target
        end_ts = hold_end if flat_ts is None else min(hold_end, flat_ts)
        within = tseg < end_ts
        si = np.flatnonzero(hit_stop & within)
        gi = np.flatnonzero(hit_tgt & within)
        s0 = si[0] if si.size else None
        g0 = gi[0] if gi.size else None
        if s0 is not None and (g0 is None or s0 <= g0):
            xi = fi + s0
            xpx = stop + STOP_SLIP * side
            reason = 'stop'
        elif g0 is not None:
            xi = fi + g0
            xpx = target
            reason = 'target'
        else:
            after = np.flatnonzero(tseg >= end_ts)
            if after.size:
                xi = fi + after[0]
                xpx = o[xi] - MKT_SLIP * side
                reason = 'flat_eod' if (flat_ts is not None and end_ts == flat_ts
                                        and flat_ts < hold_end) else 'max_hold'
            else:
                xi = len(ts) - 1
                xpx = c[xi]
                reason = 'data_end'
        pnl = side * (fpx - xpx) * PTVAL - COMM
        trades[cfg].append({
            'trade_date': e.trade_date, 'year': e.year, 'side': side,
            'fill_ts': int(fill_ts), 'exit_ts': int(ts[xi]),
            'hold_min': (ts[xi] - fill_ts) / 60.0, 'reason': reason,
            'pnl': pnl,
        })
        last_exit[cfg] = int(ts[xi])

# ---------- report ----------
all_days = sorted(ev['trade_date'].unique())
print(f'\n=== RESULTS {Y0}-{Y1} slipx{SLIPM} arr5>={THRESH} '
      f'(entry,stop,tgt_atr,hold) ===')
rows_out = []
for cfg in CONFIGS:
    tr = pd.DataFrame(trades[cfg])
    tag = f'{cfg[0]} S{int(cfg[1])} T{cfg[2]:.2f} H{cfg[3]}'
    if not len(tr):
        print(f'{tag}: 0 trades')
        continue
    wr = (tr['pnl'] > 0).mean()
    gp = tr.loc[tr['pnl'] > 0, 'pnl'].sum()
    gl = -tr.loc[tr['pnl'] < 0, 'pnl'].sum()
    pf = gp / gl if gl > 0 else float('inf')
    daily = tr.groupby('trade_date')['pnl'].sum().reindex(all_days, fill_value=0.0)
    sharpe = daily.mean() / daily.std() * np.sqrt(252) if daily.std() > 0 else 0
    eq = tr['pnl'].cumsum()
    dd = (eq - eq.cummax()).min()
    yr = tr.groupby('year')['pnl'].sum()
    yrpf = {}
    for y, g in tr.groupby('year'):
        gpp = g.loc[g['pnl'] > 0, 'pnl'].sum(); gll = -g.loc[g['pnl'] < 0, 'pnl'].sum()
        yrpf[y] = gpp / gll if gll > 0 else float('inf')
    print(f'{tag}: n={len(tr)} WR={wr:.3f} PF={pf:.2f} Sharpe={sharpe:.2f} '
          f'maxDD=${dd:,.0f} pnl=${tr["pnl"].sum():,.0f} '
          f'hold med/avg={tr["hold_min"].median():.0f}/{tr["hold_min"].mean():.0f}m')
    print('   per-year pnl: ' + ' '.join(f'{y}:{v:+,.0f}(PF{yrpf[y]:.2f})'
                                         for y, v in yr.items()))
    sp = []
    for sd, g in tr.groupby('side'):
        gpp = g.loc[g['pnl'] > 0, 'pnl'].sum(); gll = -g.loc[g['pnl'] < 0, 'pnl'].sum()
        sp.append(f'{"short@hi" if sd == 1 else "long@lo"}: n={len(g)} '
                  f'PF{(gpp / gll if gll > 0 else float("inf")):.2f} {g["pnl"].sum():+,.0f}')
    print('   sides: ' + ' | '.join(sp))
    rows_out.append({'cfg': tag, 'n': len(tr), 'wr': wr, 'pf': pf,
                     'sharpe': sharpe, 'dd': dd, 'pnl': tr['pnl'].sum()})
pd.DataFrame(rows_out).to_csv(
    os.path.join(HERE, f'B3-sim-{Y0}-{Y1}-slip{SLIPM}.csv'), index=False)
