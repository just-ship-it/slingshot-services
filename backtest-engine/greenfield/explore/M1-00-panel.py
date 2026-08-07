#!/usr/bin/env python3
"""
M1-00: Build aligned daily macro panel.

Master calendar = NQ trading dates (NQ is the trade target).
Every other series is reindexed onto NQ dates with FORWARD-FILL (as-of prior close):
on date D we use the most recent available close <= D of each series. Causal by construction.

BTC is 24/7 -> its close on the NQ date is used; weekend BTC bars are dropped by the join
(we only keep BTC on NQ trading dates, ffilled if BTC itself was missing e.g. rare gaps).

Outputs M1-panel.csv with NQ OHLC (for the forward point-move) + all other closes.
"""
import pandas as pd, numpy as np, os

MACRO = os.path.dirname(os.path.abspath(__file__)) + "/../../data/macro"
OUT = os.path.dirname(os.path.abspath(__file__)) + "/M1-panel.csv"

def load(sym):
    df = pd.read_csv(f"{MACRO}/{sym}_1d.csv")
    df['date'] = pd.to_datetime(df['date'])
    return df.set_index('date').sort_index()

nq = load('nq')
# Master calendar: NQ trading dates
idx = nq.index

panel = pd.DataFrame(index=idx)
panel['nq_open'] = nq['open']
panel['nq_high'] = nq['high']
panel['nq_low']  = nq['low']
panel['nq_close']= nq['close']

others = ['spy','vix','tlt','ief','hyg','lqd','uup','dxy','gld','iwm','btc']
for sym in others:
    s = load(sym)['close']
    # reindex onto NQ calendar with as-of (prior) fill
    panel[f'{sym}_close'] = s.reindex(idx, method='ffill')

# also keep spy full-history separately for signal construction where NQ is short
panel.to_csv(OUT)
print("wrote", OUT, panel.shape)
print(panel.tail(3))
print("\nfirst valid date per column:")
for c in panel.columns:
    fv = panel[c].first_valid_index()
    print(f"  {c:12s} {fv.date() if fv is not None else 'NA'}")
print("\nNQ date range:", idx.min().date(), "->", idx.max().date(), "n=", len(idx))
