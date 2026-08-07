#!/usr/bin/env python3
"""
M2-00 build panel: merge daily OHLCV for commodities + equity/macro context + book PnL.
Outputs:
  M2-panel.csv    : per-date close for every series (outer-join on date), aligned by trading date.
  M2-book.csv     : per-date combined + per-strategy book PnL (2021-2026).
Everything downstream aligns by inner-join on overlapping trading dates.
"""
import pandas as pd, numpy as np, os

MACRO = "/home/drew/projects/slingshot-services/backtest-engine/data/macro"
EXPL  = "/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"

SERIES = ["gc","cl","si","hg","ng","nq","spy","vix","tlt","ief","hyg","lqd","uup","dxy","gld","iwm","btc"]

def load(sym):
    df = pd.read_csv(f"{MACRO}/{sym}_1d.csv", parse_dates=["date"])
    df = df[["date","open","high","low","close","volume"]].copy()
    df.columns = ["date"] + [f"{sym}_{c}" for c in ["open","high","low","close","volume"]]
    return df

panel = None
for s in SERIES:
    d = load(s)
    panel = d if panel is None else panel.merge(d, on="date", how="outer")
panel = panel.sort_values("date").reset_index(drop=True)
panel.to_csv(f"{EXPL}/M2-panel.csv", index=False)
print("panel:", panel.shape, panel.date.min().date(), "->", panel.date.max().date())

# Book PnL
books = {}
for name in ["pcc","monday","gapfade"]:
    b = pd.read_csv(f"{EXPL}/book-{name}-daily.csv", parse_dates=["date"])
    b = b.rename(columns={"pnl": f"pnl_{name}"})
    books[name] = b
book = books["pcc"].merge(books["monday"], on="date", how="outer").merge(books["gapfade"], on="date", how="outer")
book = book.sort_values("date").reset_index(drop=True)
book["pnl_combined"] = book[["pnl_pcc","pnl_monday","pnl_gapfade"]].sum(axis=1, min_count=1)
book.to_csv(f"{EXPL}/M2-book.csv", index=False)
print("book:", book.shape, book.date.min().date(), "->", book.date.max().date())
for c in ["pnl_pcc","pnl_monday","pnl_gapfade","pnl_combined"]:
    v = book[c].dropna()
    print(f"  {c}: n={len(v)} sum=${v.sum():,.0f} mean=${v.mean():.1f} std=${v.std():.1f}")
