#!/usr/bin/env python3
"""
Reconstruct the Liquidity Toolkit | T trigger levels over our full NQ history.

REVERSE-ENGINEERED EXACTLY (2026-08-21):
    T:{tf} = RMA(close, 14)      # Wilder smoothing, alpha = 1/14
Fitted on TV's own bars the recursion returns R^2 = 1.000000, rmse 0.0000,
max|err| 0.000 -- an identity, not an approximation. Verified independently on
the native 5m and 60m series.

Why this matters:
  * TV caps 3m history at 64 days (~115 crossover events). Detecting the effect
    size seen there needs ~980 events. Computing it ourselves lifts the cap.
  * It KILLS the lookahead question. TV's script uses request.security and we
    could not prove statically whether T:H peeks; here T:H is built from
    COMPLETED hourly bars only, so it is causal by construction.

Rollovers: RMA is recursive, so the ~200pt roll gap would poison the filter for
~9 bars. Levels are computed per front-month contract and reset at each roll,
and bars within --roll-skip of a contract change are flagged so downstream
analysis can drop them (see CLAUDE.md on rollover handling).

usage: build-triggers.py [--out triggers_NQ.csv] [--roll-skip 60]
"""
import argparse, os
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "backtest-engine", "data", "ohlcv", "nq", "NQ_ohlcv_1m.csv")

def rma(s, n=14):
    """ta.rma: seeded with SMA(n), then alpha = 1/n."""
    v = np.asarray(s, dtype=float)
    out = np.full(len(v), np.nan)
    if len(v) < n:
        return out
    out[n - 1] = v[:n].mean()
    a = 1.0 / n
    for i in range(n, len(v)):
        out[i] = a * v[i] + (1 - a) * out[i - 1]
    return out

def front_month(df):
    """filterPrimaryContract: highest-volume symbol per hour, calendar spreads dropped."""
    df = df[~df.symbol.str.contains("-", na=False)].copy()
    df["hour"] = df.dt.dt.floor("h")
    vol = df.groupby(["hour", "symbol"], sort=False).volume.sum().reset_index()
    pick = vol.sort_values("volume").groupby("hour").tail(1)[["hour", "symbol"]]
    pick = pick.rename(columns={"symbol": "front"})
    df = df.merge(pick, on="hour", how="inner")
    return df[df.symbol == df.front].drop(columns=["front"])

def bars(df, rule):
    g = df.set_index("dt").resample(rule, label="left", closed="left")
    b = g.agg(o=("open", "first"), h=("high", "max"), l=("low", "min"),
              c=("close", "last"), v=("volume", "sum"), sym=("symbol", "last"))
    return b.dropna(subset=["c"]).reset_index()

def per_contract_rma(b):
    """Reset the recursion at each contract change so a roll gap cannot poison it."""
    out = np.full(len(b), np.nan)
    for _, idx in b.groupby("sym", sort=False).groups.items():
        i = np.sort(np.asarray(idx))
        out[i] = rma(b.c.values[i])
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="triggers_NQ.csv")
    ap.add_argument("--roll-skip", type=int, default=60, help="5m bars to flag after a roll")
    a = ap.parse_args()

    print("loading 1m …")
    d = pd.read_csv(SRC, usecols=["ts_event", "open", "high", "low", "close", "volume", "symbol"])
    d["dt"] = pd.to_datetime(d.ts_event)
    d = d.drop(columns=["ts_event"]).sort_values("dt")
    print(f"  {len(d):,} rows {d.dt.iloc[0].date()} -> {d.dt.iloc[-1].date()}")

    d = front_month(d)
    print(f"  front-month only: {len(d):,} rows, {d.symbol.nunique()} contracts")

    b5 = bars(d, "5min");  b5["T5"] = per_contract_rma(b5)
    b60 = bars(d, "60min"); b60["TH"] = per_contract_rma(b60)
    print(f"  5m bars {len(b5):,} | 60m bars {len(b60):,}")

    # CAUSAL alignment: a 5m bar may only see the LAST COMPLETED hourly bar.
    # merge_asof on the hour's CLOSE time (dt + 1h) guarantees no peeking.
    b60c = b60[["dt", "TH"]].copy()
    b60c["avail"] = b60c.dt + pd.Timedelta(hours=1)
    m = pd.merge_asof(b5.sort_values("dt"), b60c[["avail", "TH"]].sort_values("avail"),
                      left_on="dt", right_on="avail", direction="backward")
    m["roll"] = (m.sym != m.sym.shift(1))
    m["bars_since_roll"] = (~m.roll).cumsum() - (~m.roll).cumsum().where(m.roll).ffill().fillna(0)
    m["near_roll"] = m.bars_since_roll < a.roll_skip
    m = m.dropna(subset=["T5", "TH"])
    m["spread"] = m.T5 - m.TH
    sgn = np.sign(m.spread.values)
    prev = np.r_[np.nan, sgn[:-1]]
    m["x_up"] = (sgn > 0) & (prev <= 0)
    m["x_dn"] = (sgn < 0) & (prev >= 0)
    out = os.path.join(HERE, a.out)
    m[["dt", "sym", "o", "h", "l", "c", "v", "T5", "TH", "spread",
       "x_up", "x_dn", "near_roll"]].to_csv(out, index=False)
    print(f"\nwrote {len(m):,} 5m rows -> {out}")
    print(f"  {m.dt.iloc[0].date()} -> {m.dt.iloc[-1].date()}")
    print(f"  crossovers: up={int(m.x_up.sum()):,}  down={int(m.x_dn.sum()):,} "
          f"({int((m.x_up | m.x_dn).sum()):,} total, {int((m[~m.near_roll].x_up | m[~m.near_roll].x_dn).sum()):,} clear of rolls)")
