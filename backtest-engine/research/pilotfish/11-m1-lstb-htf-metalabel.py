#!/usr/bin/env python3
"""PILOTFISH M1 — LSTB × higher-TF LS state meta-label (PLAN.md Phase 3b).

Join LSTB trades (IS gold 2025-26 + OOS 2023-24) with knowability-shifted
3m/5m/15m/1h/4h LS states at signal time. Pre-registered: aligned-with-state
trades outperform counter-state; effect strengthens with TF. A deployable
gate must improve PF+Sharpe+DD together on IS AND hold on OOS.
"""
import json
import statistics
import sys
sys.path.insert(0, '/home/drew/projects/slingshot-services/backtest-engine/research/pilotfish')
from pf_lib import LsSeries

BASE = '/home/drew/projects/slingshot-services/backtest-engine/data/gold-standard/'
series = {tf: LsSeries(tf) for tf in ('3m', '5m', '15m', '1h', '4h')}


def load(fn):
    tr = json.load(open(BASE + fn))['trades']
    out = []
    for t in tr:
        ms = t['timestamp']
        st = {tf: s.state_at(ms) for tf, s in series.items()}
        out.append({'ms': ms, 'side': t['side'], 'pnl': t['netPnL'], 'st': st,
                    'date': None})
    return out


def pf(pnls):
    w = sum(p for p in pnls if p > 0)
    l = -sum(p for p in pnls if p < 0)
    return w / l if l else float('inf')


def daily_sharpe(trades):
    from datetime import datetime, timezone
    days = {}
    for t in trades:
        d = datetime.fromtimestamp(t['ms'] / 1000, timezone.utc).strftime('%Y-%m-%d')
        days[d] = days.get(d, 0) + t['pnl']
    v = list(days.values())
    if len(v) < 20 or statistics.pstdev(v) == 0:
        return float('nan')
    return statistics.mean(v) / statistics.pstdev(v) * (252 ** 0.5)


def maxdd(trades):
    eq = mx = dd = 0
    for t in sorted(trades, key=lambda x: x['ms']):
        eq += t['pnl']
        mx = max(mx, eq)
        dd = min(dd, eq - mx)
    return dd


def report(name, trades):
    if len(trades) < 30:
        print(f'  {name:44s} n={len(trades):5d} (too few)')
        return
    pnls = [t['pnl'] for t in trades]
    print(f'  {name:44s} n={len(trades):5d} pnl=${sum(pnls):>9,.0f} PF={pf(pnls):5.2f} '
          f'Sh={daily_sharpe(trades):5.1f} maxDD=${-maxdd(trades):>7,.0f} '
          f'WR={100*sum(1 for p in pnls if p>0)/len(pnls):4.1f}%')


IS = load('ls-flip-trigger-bar-v3-plain-noBE-slipfix.json')
OOS = load('ls-flip-trigger-bar-v3-plain-noBE-oos2023-24.json')

for label, trades in (('IN-SAMPLE 2025-26 (gate discovery)', IS),
                      ('OOS 2023-24 (gate confirmation)', OOS)):
    print(f'========== {label} ==========')
    report('ALL trades (baseline)', trades)
    for tf in ('3m', '5m', '15m', '1h', '4h'):
        al = [t for t in trades if t['st'][tf] is not None
              and (t['side'] == 'buy') == (t['st'][tf] == 1)]
        co = [t for t in trades if t['st'][tf] is not None
              and (t['side'] == 'buy') != (t['st'][tf] == 1)]
        report(f'{tf} ALIGNED', al)
        report(f'{tf} counter', co)
    print()
