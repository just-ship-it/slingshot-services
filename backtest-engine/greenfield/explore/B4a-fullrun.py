#!/usr/bin/env python3
"""
B4a PRE-CLOSE CONTINUATION — consolidated full-period backtest (2021-2026), 1 NQ contract.

This is NOT new research. It runs the ALREADY-FROZEN, already-validated B4a config
(dev 2021-24 + locked 2025-26, independently raw-data-verified) as ONE continuous
series so we get real cumulative PnL and an equity curve for a single 1-lot NQ
long/short strategy. Reuses the verified 1s walker (B4_common.sim_market_hold) and
signal precompute logic from B4-01-preclose.py verbatim — no logic changes.

FROZEN RULE (unchanged):
  At 15:00:00 ET, day_move = (last 1s close before 15:00) - (first 1s open >= 09:30).
  If |day_move| > 0.30 * ATR14(prior-day, full-session): enter 1 contract MARKET at
  15:00:01 in the direction of the move (long up-day / short down-day). No stop.
  Exit MARKET at 15:30:00. Costs: 0.25pt adverse slip each side + $5 RT commission,
  NQ $20/pt. Roll days and half sessions excluded.

Outputs: per-year table, full-period summary (PnL/PF/WR/Sharpe/maxDD for 1 contract),
and writes B4a-fullrun-trades.csv + B4a-fullrun-equity.csv.
Usage: python3 B4a-fullrun.py [slip_mult=1.0]
"""
import sys
import numpy as np
import pandas as pd
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from B4_common import load_1s_npz, load_days_features, sim_market_hold, et_epoch

ET = ZoneInfo("America/New_York")
SLIP = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
FMOVE = 0.30  # frozen |move| filter in ATR14 units

ts, o, h, l, c, dayidx = load_1s_npz()
days = load_days_features().set_index(
    load_days_features().trade_date.dt.strftime("%Y-%m-%d"))

# ---- per-day signal precompute (identical to B4-01-preclose.py, all years) ------
trades = []
skipped = {"not_in_days": 0, "not_full": 0, "roll": 0, "atr": 0, "cover": 0,
           "zero": 0, "filtered": 0, "no_fill": 0}
for d in sorted(dayidx.keys()):
    a, b = dayidx[d]
    if d not in days.index:
        skipped["not_in_days"] += 1; continue
    r = days.loc[d]
    if not r.full_rth:
        skipped["not_full"] += 1; continue
    if not r.rth_same_sym:
        skipped["roll"] += 1; continue
    if not r.atr_terc_known:      # ATR14 knowable (identical eligibility to research)
        skipped["atr"] += 1; continue
    td = r.trade_date
    t0930, t1500 = et_epoch(td, 9, 30), et_epoch(td, 15, 0)
    dts = ts[a:b]
    i0 = int(np.searchsorted(dts, t0930, "left"))
    j = int(np.searchsorted(dts, t1500, "left"))
    if i0 >= len(dts) or dts[i0] > t0930 + 30 or j == 0 or dts[j - 1] < t1500 - 120:
        skipped["cover"] += 1; continue
    move = c[a:b][j - 1] - o[a:b][i0]
    if move == 0:
        skipped["zero"] += 1; continue
    if abs(move) <= FMOVE * r.atr14_prior:   # frozen filter
        skipped["filtered"] += 1; continue
    side = 1 if move > 0 else -1
    flat_ts = et_epoch(td, 15, 30)
    tr = sim_market_hold(ts, o, h, l, c, a, b, side, t1500 + 1, flat_ts,
                         stop_pts=None, slip_mult=SLIP)
    if tr is None:
        skipped["no_fill"] += 1; continue
    trades.append(dict(
        date=d, year=int(d[:4]), side=("LONG" if side > 0 else "SHORT"),
        day_move_pts=round(float(move), 2), atr14=round(float(r.atr14_prior), 1),
        entry_px=round(float(tr["entry_px"]), 2), exit_px=round(float(tr["exit_px"]), 2),
        gross_pts=round(float(tr["gross_pts"]), 2), pnl=round(float(tr["pnl"]), 2)))

tf = pd.DataFrame(trades).sort_values("date").reset_index(drop=True)
tf["cum_pnl"] = tf["pnl"].cumsum()
tf["peak"] = tf["cum_pnl"].cummax()
tf["drawdown"] = tf["cum_pnl"] - tf["peak"]

print(f"\n{'='*70}\nB4a PRE-CLOSE CONTINUATION — full backtest 2021-2026 | 1 NQ contract"
      f" | slip {SLIP:g}x\n{'='*70}")
print(f"eligible trade days -> trades taken: {len(tf)}   skipped: {skipped}\n")


def block(df, label):
    n = len(df)
    if n == 0:
        print(f"{label:12s}  no trades"); return
    wins = df[df.pnl > 0]; losses = df[df.pnl < 0]
    gp, gl = wins.pnl.sum(), -losses.pnl.sum()
    pf = gp / gl if gl > 0 else float("inf")
    wr = 100 * len(wins) / n
    print(f"{label:12s}  n={n:4d}  WR={wr:4.1f}%  PF={pf:4.2f}  "
          f"PnL=${df.pnl.sum():>9,.0f}  avg=${df.pnl.mean():>6.0f}/tr  "
          f"grossPts={df.gross_pts.mean():+5.2f}")


print("Per year (1 contract):")
for y in range(2021, 2027):
    block(tf[tf.year == y], f"  {y}")
print("-" * 70)
block(tf, "  ALL")

# full-period risk metrics (1 contract)
total = tf.pnl.sum()
maxdd = tf.drawdown.min()
# daily Sharpe: aggregate PnL by calendar day (>=1 trade/day here, but be safe)
daily = tf.groupby("date").pnl.sum()
sharpe = (daily.mean() / daily.std() * np.sqrt(252)) if daily.std() > 0 else float("nan")
gp_all = tf[tf.pnl > 0].pnl.sum(); gl_all = -tf[tf.pnl < 0].pnl.sum()
print(f"\n{'='*70}\nFULL-PERIOD SUMMARY (1 NQ contract, {tf.date.iloc[0]} -> {tf.date.iloc[-1]})")
print(f"  Total net PnL ...... ${total:,.0f}")
print(f"  Trades ............. {len(tf)}  (~{len(tf)/6:.0f}/yr)")
print(f"  Win rate ........... {100*(tf.pnl>0).mean():.1f}%")
print(f"  Profit factor ...... {gp_all/gl_all:.3f}")
print(f"  Avg / trade ........ ${tf.pnl.mean():.0f}   (median ${tf.pnl.median():.0f})")
print(f"  Best / worst trade . ${tf.pnl.max():,.0f} / ${tf.pnl.min():,.0f}")
print(f"  Max drawdown ....... ${maxdd:,.0f}  (equity peak-to-trough, closed trades)")
print(f"  Daily Sharpe (ann) . {sharpe:.2f}")
print(f"  Return/$ risked .... {total/abs(maxdd):.2f}x  (total PnL / max drawdown)")
print("=" * 70)

tf.to_csv(f"{sys.path[0] or '.'}/B4a-fullrun-trades.csv", index=False)
eq = tf[["date", "year", "side", "pnl", "cum_pnl", "drawdown"]]
eq.to_csv(f"{sys.path[0] or '.'}/B4a-fullrun-equity.csv", index=False)
print("wrote B4a-fullrun-trades.csv (per-trade log) and B4a-fullrun-equity.csv (equity curve)")
