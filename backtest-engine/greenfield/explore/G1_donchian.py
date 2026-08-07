#!/usr/bin/env python3
"""
G1 — Independent from-scratch verification of the GC 100d Donchian breakout edge.

Knowability:
  - Channel at day D uses bars D-1 .. D-N (EXCLUDES today's bar D). We compute the
    prior-N-day high/low from bars strictly before D, then compare today's CLOSE.
  - Signal known at D close -> enter at D+1 OPEN -> hold H trading days ->
    exit at close of (entry_idx + H). No future bars used to form the signal.
  - Non-overlapping: while in a trade we take no new signals.

Sizing: MGC micro gold = $10 / 1.0 point.
Cost:   1 tick/side slippage (tick=0.1pt=$1 on MGC) => $2 RT + $1.5 commission = $3.5 RT.
"""
import sys
import numpy as np
import pandas as pd

PT = 10.0          # $ per point, MGC
RT_COST = 3.5      # $ round-trip: 1 tick/side ($2) + $1.5 commission

def load():
    df = pd.read_csv("/home/drew/projects/slingshot-services/backtest-engine/data/macro/gc_1d.csv",
                     parse_dates=["date"])
    df = df.sort_values("date").reset_index(drop=True)
    return df

def backtest(df, N, H, exit_mode="fixed"):
    """Return list of trade dicts. exit_mode: 'fixed' (H-day hold) or 'opposite' (opposite channel)."""
    o = df["open"].values; h = df["high"].values; l = df["low"].values; c = df["close"].values
    dates = df["date"].values
    n = len(df)
    # prior-N high/low EXCLUDING today: roll on shifted series
    hh = pd.Series(h).shift(1).rolling(N).max().values   # highest high of D-1..D-N
    ll = pd.Series(l).shift(1).rolling(N).min().values   # lowest low  of D-1..D-N
    trades = []
    i = N  # first index with a full channel
    while i < n - 1:
        sig = 0
        if not np.isnan(hh[i]) and c[i] > hh[i]:
            sig = 1
        elif not np.isnan(ll[i]) and c[i] < ll[i]:
            sig = -1
        if sig == 0:
            i += 1
            continue
        entry_idx = i + 1                     # enter next open
        if entry_idx >= n:
            break
        entry_px = o[entry_idx]
        if exit_mode == "fixed":
            exit_idx = min(entry_idx + H, n - 1)
        else:  # opposite-channel exit; still cap at data end
            exit_idx = None
            j = entry_idx
            while j < n:
                if sig == 1 and not np.isnan(ll[j]) and c[j] < ll[j]:
                    exit_idx = j; break
                if sig == -1 and not np.isnan(hh[j]) and c[j] > hh[j]:
                    exit_idx = j; break
                j += 1
            if exit_idx is None:
                exit_idx = n - 1
        exit_px = c[exit_idx]
        gross = sig * (exit_px - entry_px) * PT
        net = gross - RT_COST
        trades.append(dict(
            sig=sig, signal_idx=i, entry_idx=entry_idx, exit_idx=exit_idx,
            entry_date=pd.Timestamp(dates[entry_idx]), exit_date=pd.Timestamp(dates[exit_idx]),
            entry_px=entry_px, exit_px=exit_px, gross=gross, net=net,
            hold=exit_idx - entry_idx))
        i = exit_idx + 1  # non-overlapping: resume after exit
    return trades

def stats(trades):
    if not trades:
        return dict(n=0)
    net = np.array([t["net"] for t in trades])
    wins = net[net > 0]; losses = net[net < 0]
    pf = wins.sum() / -losses.sum() if losses.sum() < 0 else float("inf")
    # equity curve by trade order for maxDD (in $ on 1 MGC)
    eq = np.cumsum(net); peak = np.maximum.accumulate(eq); dd = (eq - peak).min()
    return dict(n=len(net), wr=100*(net>0).mean(), pf=pf,
                mean=net.mean(), median=np.median(net), total=net.sum(),
                maxdd=dd, gross_total=sum(t["gross"] for t in trades))

def per_year(trades):
    rows = {}
    for t in trades:
        y = t["exit_date"].year
        rows[y] = rows.get(y, 0.0) + t["net"]
    return dict(sorted(rows.items()))

if __name__ == "__main__":
    df = load()
    N = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    H = int(sys.argv[2]) if len(sys.argv) > 2 else 42
    mode = sys.argv[3] if len(sys.argv) > 3 else "fixed"
    print(f"Data: {df['date'].iloc[0].date()} -> {df['date'].iloc[-1].date()}  ({len(df)} bars)")
    tr = backtest(df, N, H, mode)
    s = stats(tr)
    print(f"\n=== GC Donchian N={N} H={H} exit={mode} (long+short, non-overlap, MGC) ===")
    print(f"n={s['n']}  WR={s['wr']:.1f}%  PF={s['pf']:.2f}  "
          f"mean=${s['mean']:.0f}  median=${s['median']:.0f}  total=${s['total']:,.0f}  maxDD=${s['maxdd']:,.0f}")
    longs = [t for t in tr if t['sig']==1]; shorts=[t for t in tr if t['sig']==-1]
    print(f"  longs: n={len(longs)} total=${sum(t['net'] for t in longs):,.0f}   "
          f"shorts: n={len(shorts)} total=${sum(t['net'] for t in shorts):,.0f}")
    print("\nPer-year net PnL ($ on 1 MGC, by exit year):")
    for y, v in per_year(tr).items():
        print(f"  {y}: ${v:>8,.0f}")
