#!/usr/bin/env python3
"""
GammaLab vs our GEX — parity screen.

Compares GammaLab's prompt-pulled QQQ dealer gamma series
(backtest-engine/data/gammalab/qqq_gex_daily.csv) against our own
QQQ-derived NQ GEX (backtest-engine/data/gex/nq-cbbo-causal/), converted
back into QQQ strike space via the per-snapshot multiplier.

Ours: 15-min snapshots; we take the snapshot closest to 16:00 ET.
Theirs: daily close values.

Scored (overlap window):
  - gamma_flip: mean abs diff (QQQ pts, %), Pearson corr of levels,
    Pearson corr of day-over-day changes
  - dealer gamma: sign agreement rate, Spearman rank corr of values
  - walls (May 5+ subset only, theirs are sticky/coarse): exact + within-1%
    match rate vs our call_wall/put_wall

Walls are NOT trusted as levels regardless of outcome (see data README).
"""
import csv, json, math, os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.join(os.path.dirname(__file__), '..', '..', 'backtest-engine', 'data')
GL_CSV = os.path.join(ROOT, 'gammalab', 'qqq_gex_daily.csv')
OURS_DIR = os.path.join(ROOT, 'gex', 'nq-cbbo-causal')
ET = ZoneInfo('America/New_York')

def load_gammalab():
    out = {}
    with open(GL_CSV) as f:
        for r in csv.DictReader(f):
            out[r['date']] = {
                'gex': float(r['gex']),
                'flip': float(r['gamma_flip']),
                'call_wall': float(r['call_wall']) if r['call_wall'] else None,
                'put_wall': float(r['put_wall']) if r['put_wall'] else None,
            }
    return out

def load_ours_1600et(date):
    path = os.path.join(OURS_DIR, f'nq_gex_{date}.json')
    if not os.path.exists(path):
        return None
    d = json.load(open(path))
    target = datetime.fromisoformat(f'{date}T16:00:00').replace(tzinfo=ET)
    def nearest(field):
        best, best_dt = None, None
        for snap in d['data']:
            if snap.get(field) is None:
                continue
            ts = datetime.fromisoformat(snap['timestamp'])
            diff = abs((ts - target).total_seconds())
            if best is None or diff < best_dt:
                best, best_dt = snap, diff
        return best if best is not None and best_dt <= 3600 else None

    gex_snap = nearest('total_gex')
    flip_snap = nearest('gamma_flip')  # null on days with no zero-crossing
    if gex_snap is None and flip_snap is None:
        return None
    out = {}
    if gex_snap:
        out['total_gex'] = gex_snap['total_gex']
        out['qqq_spot'] = gex_snap['qqq_spot']
    if flip_snap:
        m = flip_snap['multiplier']
        out['flip_qqq'] = flip_snap['gamma_flip'] / m
        out['qqq_spot'] = flip_snap['qqq_spot']
        if flip_snap.get('call_wall') is not None:
            out['call_wall_qqq'] = flip_snap['call_wall'] / m
            out['put_wall_qqq'] = flip_snap['put_wall'] / m
    return out

def pearson(a, b):
    n = len(a)
    ma, mb = sum(a)/n, sum(b)/n
    cov = sum((x-ma)*(y-mb) for x, y in zip(a, b))
    va = math.sqrt(sum((x-ma)**2 for x in a))
    vb = math.sqrt(sum((y-mb)**2 for y in b))
    return cov/(va*vb) if va and vb else float('nan')

def spearman(a, b):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0]*len(v)
        for rank, i in enumerate(order):
            r[i] = rank
        return r
    return pearson(ranks(a), ranks(b))

def main():
    gl = load_gammalab()
    joined = []
    for date in sorted(gl):
        ours = load_ours_1600et(date)
        if ours:
            joined.append((date, gl[date], ours))
    print(f'overlap days: {len(joined)} ({joined[0][0]} -> {joined[-1][0]})')

    # --- gamma flip (subset where our flip exists) ---
    fj = [(d, g, o) for d, g, o in joined if 'flip_qqq' in o]
    gl_flip = [g['flip'] for _, g, _ in fj]
    our_flip = [o['flip_qqq'] for _, _, o in fj]
    spot = [o['qqq_spot'] for _, _, o in fj]
    diffs = [a-b for a, b in zip(gl_flip, our_flip)]
    abs_pct = [abs(d)/s*100 for d, s in zip(diffs, spot)]
    print(f'\n== gamma flip (QQQ pts, n={len(fj)}; ours null on no-zero-crossing days) ==')
    print(f'  mean abs diff : {sum(abs(d) for d in diffs)/len(diffs):.2f} pts '
          f'({sum(abs_pct)/len(abs_pct):.2f}% of spot)')
    print(f'  median diff   : {sorted(diffs)[len(diffs)//2]:+.2f} pts (bias)')
    print(f'  level corr    : {pearson(gl_flip, our_flip):.3f}')
    d_gl = [b-a for a, b in zip(gl_flip, gl_flip[1:])]
    d_our = [b-a for a, b in zip(our_flip, our_flip[1:])]
    print(f'  d/d change corr: {pearson(d_gl, d_our):.3f}  (n={len(d_gl)})')

    # --- dealer gamma (subset where our total_gex exists) ---
    gj = [(d, g, o) for d, g, o in joined if 'total_gex' in o]
    gl_gex = [g['gex'] for _, g, _ in gj]
    our_gex = [o['total_gex'] for _, _, o in gj]
    signs = sum(1 for a, b in zip(gl_gex, our_gex) if (a > 0) == (b > 0))
    print(f'\n== dealer gamma (n={len(gj)}) ==')
    print(f'  sign agreement: {signs}/{len(gj)} ({signs/len(gj)*100:.0f}%)')
    print(f'  spearman corr : {spearman(gl_gex, our_gex):.3f}')
    print(f'  pearson corr  : {pearson(gl_gex, our_gex):.3f}')
    neg_gl = sum(1 for x in gl_gex if x < 0)
    neg_our = sum(1 for x in our_gex if x < 0)
    print(f'  negative days : theirs {neg_gl}/{len(gj)}, ours {neg_our}/{len(gj)}')
    mism = [d for d, g, o in gj if (g['gex'] > 0) != (o['total_gex'] > 0)]
    print(f'  mismatch dates: {mism}')

    # --- walls (subset with GL walls populated) ---
    walls = [(g, o) for _, g, o in joined
             if g['call_wall'] is not None and 'call_wall_qqq' in o]
    if walls:
        print(f'\n== walls (n={len(walls)}, informational only) ==')
        for side, ours_key in (('call_wall', 'call_wall_qqq'), ('put_wall', 'put_wall_qqq')):
            within1 = sum(1 for g, o in walls if abs(g[side]-o[ours_key])/o[ours_key] < 0.01)
            mad = sum(abs(g[side]-o[ours_key]) for g, o in walls)/len(walls)
            print(f'  {side}: mean abs diff {mad:.1f} pts, within-1% {within1}/{len(walls)}')

    # per-day dump for eyeballing
    out = os.path.join(os.path.dirname(__file__), 'parity_daily.csv')
    with open(out, 'w') as f:
        w = csv.writer(f)
        w.writerow(['date', 'qqq_spot', 'gl_flip', 'our_flip_qqq', 'flip_diff',
                    'gl_gex', 'our_total_gex', 'sign_match'])
        for date, g, o in joined:
            has_f, has_g = 'flip_qqq' in o, 'total_gex' in o
            w.writerow([date, f"{o['qqq_spot']:.2f}", f"{g['flip']:.2f}",
                        f"{o['flip_qqq']:.2f}" if has_f else '',
                        f"{g['flip']-o['flip_qqq']:+.2f}" if has_f else '',
                        f"{g['gex']:.0f}",
                        f"{o['total_gex']:.0f}" if has_g else '',
                        int((g['gex'] > 0) == (o['total_gex'] > 0)) if has_g else ''])
    print(f'\nper-day rows -> {out}')

if __name__ == '__main__':
    main()
