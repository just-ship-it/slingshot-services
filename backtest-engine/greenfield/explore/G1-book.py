#!/usr/bin/env python3
"""G1 STEP 4 — freeze config, produce DAILY mark-to-market PnL, write book-gold-daily.csv.

Frozen: GC Donchian N=100, H=42, fixed hold, long+short, non-overlapping, MGC $10/pt,
        RT cost $3.5 (1 tick/side + $1.5 comm), split $1.75 entry / $1.75 exit.

Daily MTM: pos held entry_idx..exit_idx.
  entry day: sig*(close-open)*PT - 1.75
  mid  days: sig*(close[t]-close[t-1])*PT
  exit day : sig*(close[t]-close[t-1])*PT - 1.75
Sum of daily == trade net (telescopes to gross - 3.5).

Alignment: gold futures label date = session date - 1 business day. To align gold PnL to
the equity book (dated by actual session), shift each label date +1 business day:
  session = np.busday_offset(label, 1, roll='backward').
"""
import numpy as np, pandas as pd
from G1_donchian import load, backtest, PT

N, H = 100, 42
HALFCOST = 1.75

if __name__ == "__main__":
    df = load()
    c = df["close"].values; o = df["open"].values; dates = df["date"].values
    tr = backtest(df, N, H, "fixed")
    daily = {}  # label_date -> pnl
    for t in tr:
        sig = t["sig"]; e = t["entry_idx"]; x = t["exit_idx"]
        for idx in range(e, x + 1):
            if idx == e:
                p = sig * (c[idx] - o[idx]) * PT - HALFCOST
            else:
                p = sig * (c[idx] - c[idx-1]) * PT
            if idx == x:
                p -= HALFCOST
            d = pd.Timestamp(dates[idx])
            daily[d] = daily.get(d, 0.0) + p

    lab = pd.Series(daily).sort_index()
    # sanity: sum of daily == sum of trade net
    trade_net = sum(t["net"] for t in tr)
    print(f"daily-sum=${lab.sum():,.2f}  trade-net=${trade_net:,.2f}  "
          f"(match={abs(lab.sum()-trade_net)<0.01})")

    # shift label -> session date (+1 business day)
    sess = np.busday_offset(lab.index.values.astype("datetime64[D]"), 1, roll="backward")
    out = pd.DataFrame({"date": pd.to_datetime(sess), "pnl": lab.values})
    out = out.groupby("date", as_index=False)["pnl"].sum().sort_values("date")
    out["pnl"] = out["pnl"].round(2)
    out.to_csv("/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore/book-gold-daily.csv", index=False)
    print(f"wrote book-gold-daily.csv: {len(out)} rows, "
          f"{out['date'].min().date()} -> {out['date'].max().date()}, total=${out['pnl'].sum():,.0f}")

    # book-era only (>=2021) for context
    era = out[out["date"] >= "2021-01-01"]
    print(f"book-era (2021+): {len(era)} active days, total=${era['pnl'].sum():,.0f}")
