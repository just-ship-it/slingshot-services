#!/usr/bin/env python3
"""
B12-00: day-level feature table for studies B1 (gap-fill) and B2 (compressed-ON fade).

Every conditioning value is knowable at 09:30:00 ET:
  - prior_rth_close: prior trade date's 15:59 1m bar close (knowable 16:00 prior day).
  - atr14_prior: mean day_range of the prior 14 full days, shifted by 1 (a1_common pattern).
  - on_high / on_low / on_range: overnight session 18:00 prev ET -> 09:29 bar; the 09:29
    bar closes at 09:30:00, so ON extremes are knowable exactly at 09:30:00.
  - on_terc_lo_boundary: 33.33rd percentile of on_range over the PRIOR 250 trade dates
    (min 100), strictly excluding today. Trailing-only; never full-sample.
Symbol discipline: gap only defined when prior RTH close symbol == today's RTH symbol;
ON extremes only used when ON session is single-symbol and matches RTH symbol.
Output: B12-days.csv
"""
import numpy as np
import pandas as pd
import a1_common as A

df = A.load_cache("NQ")
dd = A.build_daily(df)

# gap vs prior RTH close (same symbol only)
dd["prior_rth_close"] = dd["rth_close"].shift(1)
dd["prior_sym_rth_last"] = dd["sym_rth_last"].shift(1)
dd["prior_td"] = dd["trade_date"].shift(1)
gap_ok = dd["prior_sym_rth_last"].eq(dd["sym_rth_first"])
dd["gap"] = np.where(gap_ok, dd["rth_open"] - dd["prior_rth_close"], np.nan)
dd["gap_ok"] = gap_ok

dd["gap_atr"] = dd["gap"] / dd["atr14_prior"]
dd["on_range_atr"] = dd["on_range"] / dd["atr14_prior"]

# ON extremes valid for trading use?
dd["on_ok"] = dd["on_same_sym"] & dd["on_to_rth_same_sym"] & (dd["n_on"] >= 700)

# trailing 250-day 33.33rd percentile of on_range (only days with valid ON), strictly prior
vals = dd["on_range"].where(dd["on_ok"])
bound = np.full(len(dd), np.nan)
hist = []
idx_hist = []
arr = vals.to_numpy()
for i in range(len(dd)):
    prior = [v for v in arr[max(0, i - 250):i] if v == v]
    if len(prior) >= 100:
        bound[i] = np.percentile(prior, 100.0 / 3.0)
dd["on_terc_lo_boundary"] = bound
dd["on_compressed"] = dd["on_ok"] & (dd["on_range"] <= dd["on_terc_lo_boundary"])

keep = ["trade_date", "year", "dow", "full_rth", "roll_in_day",
        "sym_rth_first", "sym_rth_last", "rth_same_sym", "same_sym_prev_rth",
        "on_ok", "gap_ok", "n_on", "n_rth",
        "on_high", "on_low", "on_range", "on_range_atr",
        "rth_open", "rth_close", "rth_high", "rth_low",
        "prior_rth_close", "prior_td", "gap", "gap_atr", "atr14_prior",
        "on_terc_lo_boundary", "on_compressed"]
out = dd[keep].copy()
out.to_csv("B12-days.csv", index=False)

m = out["gap_atr"].abs()
print(f"days={len(out)}  gap_ok={out.gap_ok.sum()}  on_ok={out.on_ok.sum()}  "
      f"compressed={out.on_compressed.sum()}")
print("|gap|/ATR deciles:", np.nanpercentile(m, [10, 25, 50, 75, 90]).round(3))
print("B1 band 0.03-0.25:", ((m >= 0.03) & (m <= 0.25) & out.gap_ok & out.full_rth).sum())
print(out.groupby("year")["on_compressed"].sum())
