#!/usr/bin/env python3
"""
Analyze ES contract rollover in the OHLCV data.

Questions:
1. When do rollovers happen? (primary contract changes)
2. What's the spread between old/new contracts at rollover time?
3. How many 1-min bars have both contracts trading simultaneously?
4. How would back-adjustment work?
"""

import sys
from pathlib import Path
import pandas as pd
import numpy as np

OHLCV_FILE = Path(__file__).resolve().parent.parent / "backtest-engine" / "data" / "ohlcv" / "es" / "ES_ohlcv_1m.csv"
START_DATE = pd.Timestamp("2023-03-28", tz="UTC")
END_DATE = pd.Timestamp("2026-01-27", tz="UTC")


def main():
    print("Loading ES OHLCV...")
    chunks = []
    for chunk in pd.read_csv(
        OHLCV_FILE,
        usecols=["ts_event", "open", "high", "low", "close", "volume", "symbol"],
        dtype={"open": float, "high": float, "low": float, "close": float,
               "volume": float, "symbol": str},
        chunksize=2_000_000,
    ):
        chunk["ts_event"] = pd.to_datetime(chunk["ts_event"], utc=True)
        chunk = chunk[(chunk["ts_event"] >= START_DATE) & (chunk["ts_event"] <= END_DATE)]
        chunk = chunk[~chunk["symbol"].str.contains("-", na=False)]
        if not chunk.empty:
            chunks.append(chunk)
    df = pd.concat(chunks, ignore_index=True)
    print(f"  Total candles: {len(df):,}")

    # Primary contract per hour
    df["hour"] = df["ts_event"].dt.floor("h")
    hourly_vol = df.groupby(["hour", "symbol"])["volume"].sum().reset_index()
    idx = hourly_vol.groupby("hour")["volume"].idxmax()
    primary_map = hourly_vol.loc[idx, ["hour", "symbol"]].rename(columns={"symbol": "primary"})

    # Walk through hours and detect rollovers
    primary_map = primary_map.sort_values("hour")
    rollovers = []
    prev_symbol = None
    for _, row in primary_map.iterrows():
        if prev_symbol is not None and row["primary"] != prev_symbol:
            rollovers.append({
                "hour": row["hour"],
                "from_symbol": prev_symbol,
                "to_symbol": row["primary"],
            })
        prev_symbol = row["primary"]

    print(f"\n{'='*80}")
    print(f"CONTRACT ROLLOVERS DETECTED: {len(rollovers)}")
    print(f"{'='*80}")

    for r in rollovers:
        hour = r["hour"]
        from_sym = r["from_symbol"]
        to_sym = r["to_symbol"]

        # Find overlap: bars where both contracts trade at the same minute
        window_start = hour - pd.Timedelta("4h")
        window_end = hour + pd.Timedelta("4h")
        window = df[(df["ts_event"] >= window_start) & (df["ts_event"] <= window_end)]

        from_bars = window[window["symbol"] == from_sym].drop_duplicates("ts_event", keep="last").set_index("ts_event")["close"]
        to_bars = window[window["symbol"] == to_sym].drop_duplicates("ts_event", keep="last").set_index("ts_event")["close"]

        # Find minutes where both exist
        overlap_times = from_bars.index.intersection(to_bars.index)
        if len(overlap_times) > 0:
            spreads = to_bars.reindex(overlap_times) - from_bars.reindex(overlap_times)
            mean_spread = float(spreads.mean())
            last_spread = float(spreads.iloc[-1])
            from_price = float(from_bars.loc[overlap_times[-1]])
            to_price = float(to_bars.loc[overlap_times[-1]])
        else:
            mean_spread = float("nan")
            last_spread = float("nan")
            from_price = float(from_bars.iloc[-1]) if len(from_bars) > 0 else float("nan")
            to_price = float(to_bars.iloc[0]) if len(to_bars) > 0 else float("nan")

        print(f"\n  {hour.strftime('%Y-%m-%d %H:%M')}  {from_sym} → {to_sym}")
        print(f"    {from_sym} last price: {from_price:.2f}")
        print(f"    {to_sym} first price: {to_price:.2f}")
        print(f"    Overlap bars: {len(overlap_times)}")
        if len(overlap_times) > 0:
            print(f"    Spread (mean): {mean_spread:+.2f} pts")
            print(f"    Spread (last): {last_spread:+.2f} pts")
            print(f"    Spread range: [{spreads.min():+.2f}, {spreads.max():+.2f}]")

        r["overlap_bars"] = len(overlap_times)
        r["spread_mean"] = float(mean_spread) if not np.isnan(mean_spread) else None
        r["spread_last"] = float(last_spread) if not np.isnan(last_spread) else None
        r["from_price"] = float(from_price)
        r["to_price"] = float(to_price)

    # Check: sometimes volume flips back and forth during rollover
    # Look for "flicker" days where primary changes multiple times
    primary_map_sorted = primary_map.sort_values("hour")
    symbols = primary_map_sorted["primary"].values
    hours = primary_map_sorted["hour"].values
    flicker_events = []
    for i in range(2, len(symbols)):
        if symbols[i] == symbols[i-2] and symbols[i] != symbols[i-1]:
            flicker_events.append({
                "hour": hours[i-1],
                "flicker_to": symbols[i-1],
                "main": symbols[i],
            })

    print(f"\n{'='*80}")
    print(f"VOLUME FLICKER EVENTS (primary bounces back): {len(flicker_events)}")
    print(f"{'='*80}")
    for f in flicker_events[:20]:
        print(f"  {pd.Timestamp(f['hour']).strftime('%Y-%m-%d %H:%M')}  "
              f"flickered to {f['flicker_to']} (main: {f['main']})")
    if len(flicker_events) > 20:
        print(f"  ... and {len(flicker_events) - 20} more")

    # Impact assessment: how many forward-return windows cross a rollover?
    print(f"\n{'='*80}")
    print(f"IMPACT ON FORWARD RETURNS")
    print(f"{'='*80}")
    rollover_hours = set()
    for r in rollovers:
        h = r["hour"]
        # Any bar within 4 hours before a rollover could have a 4hr forward return crossing it
        for delta_h in range(0, 5):
            rollover_hours.add(h - pd.Timedelta(hours=delta_h))

    total_hours = len(primary_map)
    contaminated = len(rollover_hours)
    print(f"  Total hours in dataset: {total_hours:,}")
    print(f"  Hours with 4hr forward returns crossing rollover: {contaminated}")
    print(f"  Percentage contaminated: {contaminated/total_hours*100:.2f}%")

    # Per rollover: the spread as % of price
    print(f"\n{'='*80}")
    print(f"SPREAD SUMMARY")
    print(f"{'='*80}")
    spreads_pts = [r["spread_last"] for r in rollovers if r.get("spread_last")]
    prices = [r["from_price"] for r in rollovers if r.get("spread_last")]
    if spreads_pts:
        spreads_pct = [s/p*100 for s, p in zip(spreads_pts, prices)]
        print(f"  Rollovers with spread data: {len(spreads_pts)}")
        print(f"  Mean spread: {np.mean(spreads_pts):+.2f} pts ({np.mean(spreads_pct):+.3f}%)")
        print(f"  Max spread:  {max(spreads_pts, key=abs):+.2f} pts")
        print(f"  Min spread:  {min(spreads_pts, key=abs):+.2f} pts")


if __name__ == "__main__":
    main()
