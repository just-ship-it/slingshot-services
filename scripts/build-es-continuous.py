#!/usr/bin/env python3
"""
Build a back-adjusted continuous ES futures 1-min OHLCV series.

Reads the raw multi-contract ES_ohlcv_1m.csv, detects quarterly rollovers,
computes spreads from overlapping bars, and back-adjusts all historical prices
to produce a seamless continuous series.

Output:
  - ES_ohlcv_1m_continuous.csv  (same format, single continuous series)
  - ES_rollover_log.csv         (rollover timestamps, contracts, spreads)

Usage:
  python3 scripts/build-es-continuous.py [--start 2021-01-01] [--end 2026-02-01]
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent / "backtest-engine" / "data"
OHLCV_FILE = BASE_DIR / "ohlcv" / "es" / "ES_ohlcv_1m.csv"
OUTPUT_FILE = BASE_DIR / "ohlcv" / "es" / "ES_ohlcv_1m_continuous.csv"
ROLLOVER_LOG = BASE_DIR / "ohlcv" / "es" / "ES_rollover_log.csv"

# Minimum hours a contract must be primary to count as the "true" rollover
# (filters out volume flicker during roll week)
MIN_DOMINANCE_HOURS = 12


def load_raw_data(start_date=None, end_date=None):
    """Load raw ES OHLCV with all contracts."""
    print("Loading raw ES OHLCV...")
    chunks = []
    for chunk in pd.read_csv(
        OHLCV_FILE,
        usecols=["ts_event", "open", "high", "low", "close", "volume", "symbol"],
        dtype={"open": float, "high": float, "low": float, "close": float,
               "volume": float, "symbol": str},
        chunksize=2_000_000,
    ):
        chunk["ts_event"] = pd.to_datetime(chunk["ts_event"], utc=True)
        if start_date:
            chunk = chunk[chunk["ts_event"] >= pd.Timestamp(start_date, tz="UTC")]
        if end_date:
            chunk = chunk[chunk["ts_event"] <= pd.Timestamp(end_date, tz="UTC")]
        # Filter calendar spreads (symbols with dash)
        chunk = chunk[~chunk["symbol"].str.contains("-", na=False)]
        if not chunk.empty:
            chunks.append(chunk)
    df = pd.concat(chunks, ignore_index=True)
    df = df.sort_values("ts_event").reset_index(drop=True)
    print(f"  Loaded {len(df):,} raw candles, {df['symbol'].nunique()} contracts")
    return df


def detect_true_rollovers(df):
    """
    Detect true contract rollovers, ignoring volume flicker.

    Strategy: find the dominant contract per day (by total volume).
    A rollover occurs when the dominant contract changes from one day to the next
    and the new contract remains dominant for at least MIN_DOMINANCE_HOURS worth
    of subsequent daily data.
    """
    print("Detecting true rollovers...")

    # Dominant contract per day
    df["date"] = df["ts_event"].dt.date
    daily_vol = df.groupby(["date", "symbol"])["volume"].sum().reset_index()
    idx = daily_vol.groupby("date")["volume"].idxmax()
    daily_primary = daily_vol.loc[idx, ["date", "symbol"]].sort_values("date").reset_index(drop=True)
    daily_primary.rename(columns={"symbol": "primary"}, inplace=True)

    # Walk through days and detect rollovers
    rollovers = []
    prev_symbol = daily_primary["primary"].iloc[0]
    for i in range(1, len(daily_primary)):
        curr_symbol = daily_primary["primary"].iloc[i]
        if curr_symbol != prev_symbol:
            # Check persistence: does this new contract stay dominant?
            future = daily_primary.iloc[i:i+5]  # look 5 days ahead
            if len(future) >= 2 and (future["primary"] == curr_symbol).sum() >= 2:
                rollovers.append({
                    "date": daily_primary["date"].iloc[i],
                    "from_symbol": prev_symbol,
                    "to_symbol": curr_symbol,
                })
                prev_symbol = curr_symbol
            # else: flicker, ignore

    print(f"  Found {len(rollovers)} true rollovers (flicker filtered)")
    return rollovers, daily_primary


def compute_rollover_spreads(df, rollovers):
    """
    For each rollover, compute the spread between old and new contracts
    using overlapping 1-min bars near the rollover point.
    """
    print("Computing rollover spreads from overlapping bars...")

    for r in rollovers:
        roll_date = pd.Timestamp(str(r["date"]), tz="UTC")
        from_sym = r["from_symbol"]
        to_sym = r["to_symbol"]

        # Look at overlap in the 24 hours around rollover
        window_start = roll_date - pd.Timedelta("12h")
        window_end = roll_date + pd.Timedelta("12h")
        window = df[(df["ts_event"] >= window_start) & (df["ts_event"] <= window_end)]

        from_bars = (window[window["symbol"] == from_sym]
                     .drop_duplicates("ts_event", keep="last")
                     .set_index("ts_event")["close"])
        to_bars = (window[window["symbol"] == to_sym]
                   .drop_duplicates("ts_event", keep="last")
                   .set_index("ts_event")["close"])

        overlap = from_bars.index.intersection(to_bars.index)

        if len(overlap) > 0:
            spreads = to_bars.reindex(overlap) - from_bars.reindex(overlap)
            # Use the median spread for robustness
            spread = float(spreads.median())
            r["spread"] = spread
            r["overlap_bars"] = len(overlap)
            r["spread_min"] = float(spreads.min())
            r["spread_max"] = float(spreads.max())
            print(f"  {r['date']}  {from_sym} → {to_sym}  "
                  f"spread: {spread:+.2f} pts  (overlap: {len(overlap)} bars, "
                  f"range: [{spreads.min():+.2f}, {spreads.max():+.2f}])")
        else:
            # No overlap — use the last close of old and first close of new
            last_old = df[(df["symbol"] == from_sym) & (df["ts_event"] < roll_date)]["close"].iloc[-1]
            first_new = df[(df["symbol"] == to_sym) & (df["ts_event"] >= roll_date)]["close"].iloc[0]
            spread = float(first_new - last_old)
            r["spread"] = spread
            r["overlap_bars"] = 0
            r["spread_min"] = spread
            r["spread_max"] = spread
            print(f"  {r['date']}  {from_sym} → {to_sym}  "
                  f"spread: {spread:+.2f} pts  (NO overlap, using last/first)")

    return rollovers


def find_rollover_minute(df, rollover):
    """
    Find the exact minute where we switch from old to new contract.
    Uses the first minute on rollover day where the new contract has a bar.
    We actually want to switch at the start of the rollover day since that's
    when daily volume shifts.
    """
    roll_date = pd.Timestamp(str(rollover["date"]), tz="UTC")
    # Start of futures session on rollover day (6pm ET previous day = ~22:00-23:00 UTC)
    # Use midnight UTC of rollover date as the cutoff
    return roll_date


def build_continuous_series(df, rollovers, daily_primary):
    """
    Build the back-adjusted continuous series.

    1. Determine which contract is active at each minute
    2. Keep only bars from the active contract
    3. Back-adjust all prices by cumulative spread
    """
    print("\nBuilding continuous series...")

    # Build a timeline of active contracts
    # Each rollover defines a switch point
    roll_points = []
    if rollovers:
        # Before the first rollover: use the from_symbol of the first rollover
        first_contract = rollovers[0]["from_symbol"]
    else:
        first_contract = daily_primary["primary"].iloc[0]

    # Create contract assignment periods
    periods = []
    prev_start = df["ts_event"].min()
    prev_sym = first_contract

    for r in rollovers:
        switch_ts = find_rollover_minute(df, r)
        periods.append({
            "start": prev_start,
            "end": switch_ts,
            "symbol": prev_sym,
        })
        prev_start = switch_ts
        prev_sym = r["to_symbol"]

    # Last period: from last rollover to end of data
    periods.append({
        "start": prev_start,
        "end": df["ts_event"].max() + pd.Timedelta("1min"),
        "symbol": prev_sym,
    })

    print(f"  Contract periods: {len(periods)}")
    for p in periods:
        print(f"    {p['start'].strftime('%Y-%m-%d')} → {p['end'].strftime('%Y-%m-%d')}  {p['symbol']}")

    # Filter: keep only bars from the active contract in each period
    mask = pd.Series(False, index=df.index)
    for p in periods:
        period_mask = (
            (df["ts_event"] >= p["start"]) &
            (df["ts_event"] < p["end"]) &
            (df["symbol"] == p["symbol"])
        )
        mask |= period_mask

    continuous = df[mask].copy()
    continuous = continuous.drop_duplicates("ts_event", keep="last")
    continuous = continuous.sort_values("ts_event").reset_index(drop=True)
    print(f"  Bars after contract filtering: {len(continuous):,}")

    # Back-adjust: work backwards from the most recent contract
    # The most recent contract keeps its actual prices
    # Each rollover's spread is subtracted from all bars before it.
    # Since bars before earlier rollovers are also before later ones,
    # they naturally accumulate all needed adjustments.
    price_cols = ["open", "high", "low", "close"]
    cumulative = 0.0

    # Process rollovers in reverse order (most recent first)
    for r in reversed(rollovers):
        spread = r["spread"]
        cumulative += spread
        switch_ts = find_rollover_minute(df, r)
        # Subtract just THIS rollover's spread from all bars before it
        prior_mask = continuous["ts_event"] < switch_ts
        for col in price_cols:
            continuous.loc[prior_mask, col] -= spread
        print(f"  Subtracted {spread:+.2f} pts from {prior_mask.sum():,} bars before "
              f"{r['date']} ({r['from_symbol']} → {r['to_symbol']})  "
              f"[cumulative at earliest: {cumulative:+.2f}]")

    # Verify no price discontinuities
    print("\nVerifying continuity...")
    closes = continuous.set_index("ts_event")["close"]
    diffs = closes.diff().abs()
    # Flag any single-bar moves > 50 pts as potential issues
    big_moves = diffs[diffs > 50]
    if len(big_moves) > 0:
        print(f"  WARNING: {len(big_moves)} bars with >50pt single-bar moves (may include real volatility events)")
        for ts, val in big_moves.head(10).items():
            idx = continuous[continuous["ts_event"] == ts].index
            if len(idx) > 0:
                i = idx[0]
                sym_now = continuous.loc[i, "symbol"]
                sym_prev = continuous.loc[max(0, i-1), "symbol"] if i > 0 else "N/A"
                print(f"    {ts}  Δ={val:+.2f}  {sym_prev} → {sym_now}")
    else:
        print("  No discontinuities > 50 pts detected")

    return continuous


def main():
    parser = argparse.ArgumentParser(description="Build back-adjusted continuous ES series")
    parser.add_argument("--start", default=None, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end", default=None, help="End date (YYYY-MM-DD)")
    args = parser.parse_args()

    df = load_raw_data(args.start, args.end)
    rollovers, daily_primary = detect_true_rollovers(df)
    rollovers = compute_rollover_spreads(df, rollovers)
    continuous = build_continuous_series(df, rollovers, daily_primary)

    # Save continuous OHLCV
    print(f"\nSaving continuous series to {OUTPUT_FILE}...")
    output = continuous[["ts_event", "open", "high", "low", "close", "volume", "symbol"]].copy()
    # Add a column for the original (unadjusted) symbol
    output.rename(columns={"symbol": "contract"}, inplace=True)
    output["symbol"] = "ES_continuous"
    output = output[["ts_event", "open", "high", "low", "close", "volume", "symbol", "contract"]]
    output.to_csv(OUTPUT_FILE, index=False)
    print(f"  Written {len(output):,} bars")

    # Save rollover log
    print(f"Saving rollover log to {ROLLOVER_LOG}...")
    log_df = pd.DataFrame(rollovers)
    log_df.to_csv(ROLLOVER_LOG, index=False)
    print(f"  {len(log_df)} rollovers logged")

    # Summary stats
    print(f"\n{'='*60}")
    print(f"SUMMARY")
    print(f"{'='*60}")
    print(f"  Date range: {continuous['ts_event'].min()} → {continuous['ts_event'].max()}")
    print(f"  Total bars: {len(continuous):,}")
    print(f"  Contracts: {continuous['symbol'].nunique()}")
    print(f"  Rollovers: {len(rollovers)}")
    total_adj = sum(r["spread"] for r in rollovers)
    print(f"  Total back-adjustment: {total_adj:+.2f} pts")
    print(f"  Most recent contract: {continuous['symbol'].iloc[-1]} (unadjusted prices)")
    print(f"  Earliest contract: {continuous['symbol'].iloc[0]} (adjusted by {total_adj:+.2f} pts)")


if __name__ == "__main__":
    main()
