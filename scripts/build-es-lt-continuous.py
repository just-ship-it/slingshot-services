#!/usr/bin/env python3
"""
Build back-adjusted continuous ES LT levels.

Takes the original contract-price LT file and applies the same back-adjustment
used by build-es-continuous.py (from the rollover log) so that LT levels are
in the same price space as ES_ohlcv_1m_continuous.csv.

Usage:
    python3 scripts/build-es-lt-continuous.py
"""

import csv
from pathlib import Path
from datetime import datetime, timezone

BASE_DIR = Path(__file__).resolve().parent.parent / "backtest-engine" / "data"

LT_INPUT  = BASE_DIR / "liquidity" / "es" / "ES_liquidity_levels_15m.csv"
ROLLOVER  = BASE_DIR / "ohlcv" / "es" / "ES_rollover_log.csv"
LT_OUTPUT = BASE_DIR / "liquidity" / "es" / "ES_liquidity_levels_15m_backadjusted.csv"


def load_rollovers():
    """Load rollover log and compute switch timestamps + cumulative adjustments."""
    rollovers = []
    with open(ROLLOVER, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            date_str = row["date"]
            spread = float(row["spread"])
            # Rollover happens at the START of this date (midnight UTC)
            switch_ts = datetime.strptime(date_str, "%Y-%m-%d").replace(
                tzinfo=timezone.utc
            )
            rollovers.append({
                "date": date_str,
                "switch_ts": switch_ts,
                "switch_ms": int(switch_ts.timestamp() * 1000),
                "spread": spread,
                "from": row["from_symbol"],
                "to": row["to_symbol"],
            })

    # Sort chronologically
    rollovers.sort(key=lambda r: r["switch_ms"])
    return rollovers


def compute_adjustment(timestamp_ms, rollovers):
    """
    Compute the back-adjustment for a given timestamp.

    For each rollover that happened AFTER this timestamp,
    subtract that rollover's spread. This matches the logic in
    build-es-continuous.py.
    """
    adjustment = 0.0
    for r in rollovers:
        if timestamp_ms < r["switch_ms"]:
            adjustment -= r["spread"]
    return adjustment


def main():
    print(f"Loading rollovers from {ROLLOVER}...")
    rollovers = load_rollovers()
    print(f"  {len(rollovers)} rollovers loaded")

    # Show cumulative adjustment range
    total_adj = sum(-r["spread"] for r in rollovers)
    print(f"  Total back-adjustment for oldest data: {total_adj:.2f} pts")

    print(f"\nLoading LT levels from {LT_INPUT}...")
    rows_in = 0
    rows_out = 0

    with open(LT_INPUT, newline="") as fin, open(LT_OUTPUT, "w", newline="") as fout:
        reader = csv.DictReader(fin)
        writer = csv.writer(fout)
        writer.writerow(["datetime", "unix_timestamp", "sentiment",
                         "level_1", "level_2", "level_3", "level_4", "level_5"])

        for row in reader:
            rows_in += 1
            ts_ms = int(row["unix_timestamp"])
            adj = compute_adjustment(ts_ms, rollovers)

            # Apply adjustment to all 5 levels
            levels = []
            for i in range(1, 6):
                raw = float(row[f"level_{i}"])
                levels.append(round(raw + adj, 2))

            writer.writerow([
                row["datetime"],
                row["unix_timestamp"],
                row["sentiment"],
                *levels,
            ])
            rows_out += 1

    print(f"  Processed {rows_in} -> {rows_out} rows")
    print(f"  Written to {LT_OUTPUT}")

    # Verification: show a few sample adjustments
    print("\nSample adjustments:")
    for sample_date, sample_ms in [
        ("2023-03-15", 1678838400000),
        ("2024-06-03", 1717372800000),
        ("2025-06-15", 1750003200000),
        ("2025-12-15", 1765756800000),
    ]:
        adj = compute_adjustment(sample_ms, rollovers)
        print(f"  {sample_date}: adjustment = {adj:+.2f} pts")


if __name__ == "__main__":
    main()
