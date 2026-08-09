#!/usr/bin/env python3
"""
I1 — Market-internals (breadth) gate study on the 3-edge book.

Question: do NYSE/Nasdaq breadth internals (TICK, ADD, VOLD, TRIN), used as
CAUSAL day-level quality gates, improve the already-confirmed book sleeves?

Sleeves (honest 1s-simulated daily PnL, greenfield/explore/book-*-daily.csv):
  - PCC      (n~709): 15:00 ET decision, aligned with day move, exit 15:30.
               -> same-day internals through 15:00 are causally available.
  - Monday   (n~249): long 09:30 Monday, exit 15:45.
               -> only PRIOR-day (Friday) daily internals are causal.
  - Gap-fade (n~125): short 09:30 on gap-up >= 0.5*ATR14, cover 11:00.
               -> only PRIOR-day daily internals are causal.

Method (house rules):
  - ONE feature at a time; no combos in v1.
  - Split trades by feature (sign alignment or terciles); report n / PnL / PF /
    WR / avg, pooled AND per-year.
  - Permutation placebo: shuffle feature across trades 2000x -> null dist of
    pass-subset mean-PnL uplift -> p-value.
  - PCC alignment features need trade side: derived from raw NQ 1m
    (primary contract at 14:59 by volume; side = sign(14:59 close - 09:30 open)).

Data: backtest-engine/data/macro/{tick,tickq,add,addq,vold,voldq,trin}_{1d,1h,15m}.csv
(ts = epoch sec; internals rows carry no volume column). 1h covers 2020->now
(full book window), 15m covers 2025-01->now (sharper 15:00 cutoff for PCC).
"""
import csv
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.abspath(os.path.join(HERE, '..', '..'))
MACRO = os.path.join(ENGINE, 'data', 'macro')
NQ_1M = os.path.join(ENGINE, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv')
ET = ZoneInfo('America/New_York')
RNG = np.random.default_rng(20260808)
N_PERM = 2000

# ---------------------------------------------------------------- loaders

def load_internals(name, res):
    """-> list of dicts {et: datetime ET, o,h,l,c: float} sorted by ts."""
    path = os.path.join(MACRO, f'{name}_{res}.csv')
    rows = []
    with open(path) as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split(',')
            if len(p) < 6:
                continue
            ts = int(p[1])
            try:
                o, h, l, c = float(p[2]), float(p[3]), float(p[4]), float(p[5])
            except ValueError:
                continue
            rows.append({'ts': ts, 'et': datetime.fromtimestamp(ts, tz=ET),
                         'o': o, 'h': h, 'l': l, 'c': c})
    rows.sort(key=lambda r: r['ts'])
    return rows


def load_book(name):
    path = os.path.join(HERE, f'book-{name}-daily.csv')
    out = []
    with open(path) as f:
        next(f)
        for line in f:
            d, pnl = line.strip().split(',')
            out.append({'date': d, 'pnl': float(pnl)})
    return out


def pcc_sides():
    """Stream raw NQ 1m once; per ET date grab 09:30 open + 14:59 close of the
    primary contract (chosen by 14:59 volume, same symbol for both endpoints).
    -> {date: {'side': +1/-1, 'move': float}}"""
    per_day = defaultdict(dict)  # date -> symbol -> {'o930':x,'c1459':y,'v1459':v}
    with open(NQ_1M) as f:
        next(f)
        for line in f:
            p = line.split(',')
            if len(p) < 10:
                continue
            sym = p[9].strip()
            if '-' in sym:
                continue  # calendar spread
            ts = p[0]
            # ISO UTC -> ET; only need 14:30-15:00 & 09:30 ET area. Cheap filter
            # on UTC hour first (ET = UTC-4/-5 -> 09:30 ET is 13:30/14:30 UTC,
            # 14:59 ET is 18:59/19:59 UTC).
            hh = ts[11:13]
            if hh not in ('13', '14', '18', '19', '20'):
                continue
            dt = datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone(ET)
            hm = dt.strftime('%H:%M')
            if hm not in ('09:30', '14:59'):
                continue
            d = dt.strftime('%Y-%m-%d')
            rec = per_day[d].setdefault(sym, {})
            if hm == '09:30':
                rec['o930'] = float(p[4])
            else:
                rec['c1459'] = float(p[7])
                rec['v1459'] = int(p[8])
    out = {}
    for d, syms in per_day.items():
        best = None
        for sym, rec in syms.items():
            if 'o930' in rec and 'c1459' in rec:
                if best is None or rec['v1459'] > best['v1459']:
                    best = rec
        if best:
            mv = best['c1459'] - best['o930']
            out[d] = {'side': 1 if mv > 0 else -1, 'move': mv}
    return out

# ------------------------------------------------- feature construction

def daily_map(rows):
    return {r['et'].strftime('%Y-%m-%d'): r for r in rows}


def intraday_by_date(rows):
    by = defaultdict(list)
    for r in rows:
        by[r['et'].strftime('%Y-%m-%d')].append(r)
    return by


def last_close_before(bars, cutoff_hm, bar_minutes):
    """Last bar whose CLOSE time (label + bar_minutes) <= cutoff. Bars labeled
    by open time (TV convention)."""
    best = None
    ch, cm = map(int, cutoff_hm.split(':'))
    cut = ch * 60 + cm
    for b in bars:
        lab = b['et'].hour * 60 + b['et'].minute
        if lab + bar_minutes <= cut:
            best = b
    return best


def extreme_counts(bars, cutoff_hm, bar_minutes, thresh):
    ch, cm = map(int, cutoff_hm.split(':'))
    cut = ch * 60 + cm
    pos = neg = 0
    for b in bars:
        lab = b['et'].hour * 60 + b['et'].minute
        if lab + bar_minutes <= cut and lab >= 9 * 60 + 30:
            if b['h'] >= thresh:
                pos += 1
            if b['l'] <= -thresh:
                neg += 1
    return pos, neg

# ------------------------------------------------------------- analysis

def pf(pnls):
    w = sum(p for p in pnls if p > 0)
    l = -sum(p for p in pnls if p < 0)
    return w / l if l > 0 else float('inf')


def stats_line(label, pnls):
    if not pnls:
        return f'    {label:<28} n=0'
    arr = np.array(pnls)
    return (f'    {label:<28} n={len(arr):<4} pnl=${arr.sum():>9,.0f}  '
            f'avg=${arr.mean():>6,.0f}  wr={100*(arr>0).mean():.1f}%  pf={pf(pnls):.2f}')


def perm_test(mask, pnls):
    """p-value for pass-subset mean uplift vs shuffled-feature null."""
    mask = np.asarray(mask, dtype=bool)
    pnls = np.asarray(pnls, dtype=float)
    k = mask.sum()
    if k < 5 or k == len(pnls):
        return float('nan')
    obs = pnls[mask].mean() - pnls.mean()
    null = np.empty(N_PERM)
    for i in range(N_PERM):
        idx = RNG.choice(len(pnls), size=k, replace=False)
        null[i] = pnls[idx].mean() - pnls.mean()
    return float((np.abs(null) >= abs(obs)).mean())


def per_year(dates, pnls, mask):
    by = defaultdict(lambda: [[], []])
    for d, p, m in zip(dates, pnls, mask):
        by[d[:4]][0 if m else 1].append(p)
    parts = []
    for y in sorted(by):
        gp, bp = by[y]
        gs = sum(gp) if gp else 0.0
        bs = sum(bp) if bp else 0.0
        parts.append(f'{y}: pass ${gs:,.0f}({len(gp)}) / fail ${bs:,.0f}({len(bp)})')
    return parts


def report_binary(name, trades, feat, dates):
    """feat: list of +1(pass)/-1(fail)/None per trade."""
    keep = [(t, f, d) for t, f, d in zip(trades, feat, dates) if f is not None]
    if len(keep) < 20:
        print(f'  {name}: insufficient joined n={len(keep)} — skipped')
        return
    pnls = [t for t, _, _ in keep]
    mask = [f > 0 for _, f, _ in keep]
    ds = [d for _, _, d in keep]
    p = perm_test(mask, pnls)
    print(f'  {name}  (joined n={len(keep)}, perm-p={p:.3f})')
    print(stats_line('ALL', pnls))
    print(stats_line('pass (aligned)', [x for x, m in zip(pnls, mask) if m]))
    print(stats_line('fail (misaligned)', [x for x, m in zip(pnls, mask) if not m]))
    for line in per_year(ds, pnls, mask):
        print(f'      {line}')
    print()


def report_terciles(name, trades, feat, dates):
    keep = [(t, f, d) for t, f, d in zip(trades, feat, dates) if f is not None]
    if len(keep) < 30:
        print(f'  {name}: insufficient joined n={len(keep)} — skipped')
        return
    vals = np.array([f for _, f, _ in keep], dtype=float)
    pnls = [t for t, _, _ in keep]
    q1, q2 = np.quantile(vals, [1 / 3, 2 / 3])
    print(f'  {name}  (joined n={len(keep)}, tercile edges {q1:.2f}/{q2:.2f})')
    print(stats_line('ALL', pnls))
    for lab, lo, hi in [('T1 low', -np.inf, q1), ('T2 mid', q1, q2), ('T3 high', q2, np.inf)]:
        sub = [p for p, v in zip(pnls, vals) if lo < v <= hi] if lo != -np.inf \
            else [p for p, v in zip(pnls, vals) if v <= hi]
        print(stats_line(lab, sub))
    # perm test on top tercile
    mask = vals > q2
    p = perm_test(mask, pnls)
    print(f'    top-tercile perm-p={p:.3f}')
    print()

# ----------------------------------------------------------------- main

def main():
    print('=== I1: internals gate study on the book sleeves ===\n')

    # --- load internals
    res_ladder = {}
    for nm in ['tick', 'tickq', 'add', 'addq', 'vold', 'voldq', 'trin']:
        res_ladder[nm] = {
            '1d': daily_map(load_internals(nm, '1d')),
            '1h': intraday_by_date(load_internals(nm, '1h')),
            '15m': intraday_by_date(load_internals(nm, '15m')),
        }

    # --- session sanity: what ET labels do intraday bars carry?
    for res, mins in [('1h', 60), ('15m', 15)]:
        sample_days = [d for d in sorted(res_ladder['tick'][res]) if d >= '2025-03-01'][:5]
        labs = sorted({b['et'].strftime('%H:%M') for d in sample_days
                       for b in res_ladder['tick'][res][d]})
        print(f'sanity tick {res}: ET labels {labs[:8]}...{labs[-3:]} '
              f'({len(labs)} distinct, bar={mins}m)')
    print()

    # --- trade lists
    pcc = load_book('pcc')
    mon = load_book('monday')
    guf = load_book('gapfade')
    sides = pcc_sides()
    pcc_joined = [t for t in pcc if t['date'] in sides]
    moves = [abs(sides[t['date']]['move']) for t in pcc_joined]
    print(f"PCC side derivation: {len(pcc_joined)}/{len(pcc)} trade dates matched; "
          f"min |14:59-09:30 move| = {min(moves):.1f}pt (should be well > 0)\n")

    # helper: prior trading date with daily internals data
    def prior_daily(nm, date):
        dm = res_ladder[nm]['1d']
        ds = sorted(dm)
        # binary search for last date < trade date
        import bisect
        i = bisect.bisect_left(ds, date)
        return dm[ds[i - 1]] if i > 0 else None

    # ---------------- PCC: same-day features through the 15:00 decision
    print('================ PCC (same-day breadth through 15:00 ET) ================\n')
    dates = [t['date'] for t in pcc_joined]
    pnls = [t['pnl'] for t in pcc_joined]
    sd = [sides[t['date']]['side'] for t in pcc_joined]

    def align_last_close(nm, res, mins, cutoff):
        out = []
        for t, s in zip(pcc_joined, sd):
            bars = res_ladder[nm][res].get(t['date'], [])
            b = last_close_before(bars, cutoff, mins)
            out.append(None if b is None else (1 if (b['c'] > 0) == (s > 0) else -1))
        return out

    # 1h features: usable bars close by 14:30 (labels on the half-hour)
    for nm in ['add', 'addq', 'vold', 'voldq']:
        report_binary(f'{nm.upper()} sign aligns w/ trade side [1h, close<=14:30, 2021+]',
                      pnls, align_last_close(nm, '1h', 60, '14:30'), dates)

    # TRIN: <1 = buying pressure; aligned = (trin<1 & long) or (trin>1 & short)
    trin_al = []
    for t, s in zip(pcc_joined, sd):
        b = last_close_before(res_ladder['trin']['1h'].get(t['date'], []), '14:30', 60)
        trin_al.append(None if b is None else (1 if (b['c'] < 1) == (s > 0) else -1))
    report_binary('TRIN<1 aligns w/ trade side [1h, close<=14:30, 2021+]',
                  pnls, trin_al, dates)

    # TICK net extreme count (signed by side) — terciles
    for nm, th in [('tick', 1000), ('tickq', 1000)]:
        feat = []
        for t, s in zip(pcc_joined, sd):
            bars = res_ladder[nm]['1h'].get(t['date'], [])
            if not bars:
                feat.append(None)
                continue
            pos, neg = extreme_counts(bars, '14:30', 60, th)
            feat.append(s * (pos - neg))
        report_terciles(f'{nm.upper()} net +/-{th} extremes x side [1h, 2021+]',
                        pnls, feat, dates)

    # 15m variants on the 2025+ subset (sharper cutoff 15:00)
    print('---- 15m variants, 2025-01+ subset (cutoff = bars closing <= 15:00) ----\n')
    sub = [(t, s) for t, s in zip(pcc_joined, sd) if t['date'] >= '2025-01-02']
    sub_pnls = [t['pnl'] for t, _ in sub]
    sub_dates = [t['date'] for t, _ in sub]
    for nm in ['add', 'addq', 'vold']:
        feat = []
        for t, s in sub:
            b = last_close_before(res_ladder[nm]['15m'].get(t['date'], []), '15:00', 15)
            feat.append(None if b is None else (1 if (b['c'] > 0) == (s > 0) else -1))
        report_binary(f'{nm.upper()} sign aligns [15m, close<=15:00, 2025+]',
                      sub_pnls, feat, sub_dates)
    # afternoon breadth slope (13:00 -> 15:00) alignment
    for nm in ['add', 'addq']:
        feat = []
        for t, s in sub:
            bars = res_ladder[nm]['15m'].get(t['date'], [])
            b1 = last_close_before(bars, '13:00', 15)
            b2 = last_close_before(bars, '15:00', 15)
            feat.append(None if (b1 is None or b2 is None)
                        else (1 if ((b2['c'] - b1['c']) > 0) == (s > 0) else -1))
        report_binary(f'{nm.upper()} 13->15h slope aligns [15m, 2025+]',
                      sub_pnls, feat, sub_dates)

    # ---------------- Monday: prior-day (Friday) daily internals
    print('================ MONDAY long (prior-day daily internals) ================\n')
    m_dates = [t['date'] for t in mon]
    m_pnls = [t['pnl'] for t in mon]
    for nm, lab, fn in [
        ('add', 'prior-day ADD close > 0', lambda r: 1 if r['c'] > 0 else -1),
        ('vold', 'prior-day VOLD close > 0', lambda r: 1 if r['c'] > 0 else -1),
        ('trin', 'prior-day TRIN < 1', lambda r: 1 if r['c'] < 1 else -1),
    ]:
        feat = []
        for t in mon:
            r = prior_daily(nm, t['date'])
            feat.append(None if r is None else fn(r))
        report_binary(lab, m_pnls, feat, m_dates)
    # prior-day TICK washout (daily low) — terciles (hypothesis: washout Friday
    # -> stronger Monday bounce)
    feat = []
    for t in mon:
        r = prior_daily('tick', t['date'])
        feat.append(None if r is None else r['l'])
    report_terciles('prior-day TICK daily LOW (terciles)', m_pnls, feat, m_dates)

    # ---------------- Gap-fade: prior-day daily internals (side = short)
    print('================ GAP-FADE short (prior-day daily internals) ================\n')
    g_dates = [t['date'] for t in guf]
    g_pnls = [t['pnl'] for t in guf]
    for nm, lab, fn in [
        # short works better when prior breadth was WEAK (gap not confirmed)
        ('add', 'prior-day ADD close < 0 (weak breadth)', lambda r: 1 if r['c'] < 0 else -1),
        ('vold', 'prior-day VOLD close < 0', lambda r: 1 if r['c'] < 0 else -1),
        ('trin', 'prior-day TRIN > 1 (selling pressure)', lambda r: 1 if r['c'] > 1 else -1),
    ]:
        feat = []
        for t in guf:
            r = prior_daily(nm, t['date'])
            feat.append(None if r is None else fn(r))
        report_binary(lab, g_pnls, feat, g_dates)

    # save joined PCC table for follow-ups
    out = os.path.join(HERE, 'I1-pcc-joined.csv')
    with open(out, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['date', 'pnl', 'side', 'day_move'])
        for t in pcc_joined:
            w.writerow([t['date'], t['pnl'], sides[t['date']]['side'],
                        f"{sides[t['date']]['move']:.2f}"])
    print(f'\nJoined PCC table -> {out}')


if __name__ == '__main__':
    sys.exit(main())
