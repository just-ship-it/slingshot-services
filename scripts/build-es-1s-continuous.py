#!/usr/bin/env python3
"""
Build a back-adjusted continuous ES futures 1-second OHLCV series.

Uses the pre-computed rollover log (from the 1-minute continuous build) and
applies the same back-adjustment methodology to the 1-second data.

Because the raw file is ~6.5GB / 63M rows, this script processes data in a
streaming fashion:
  Pass 1: Determine the primary (highest-volume) contract per hour.
  Pass 2: Stream through the file again, filtering to the primary contract
           and applying back-adjustments, writing output incrementally.

Input:   ES_ohlcv_1s.csv          (~63M rows, 6.5GB)
Rollover: ES_rollover_log.csv     (pre-computed by build-es-continuous.py)
Output:  ES_ohlcv_1s_continuous.csv

Usage:
  python3 scripts/build-es-1s-continuous.py
  python3 scripts/build-es-1s-continuous.py --start 2023-01-01 --end 2025-12-31
"""

import argparse
import csv
import sys
import time
from collections import defaultdict, deque
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent / "backtest-engine" / "data"
OHLCV_FILE = BASE_DIR / "ohlcv" / "es" / "ES_ohlcv_1s.csv"
OUTPUT_FILE = BASE_DIR / "ohlcv" / "es" / "ES_ohlcv_1s_continuous.csv"
ROLLOVER_LOG = BASE_DIR / "ohlcv" / "es" / "ES_rollover_log.csv"

# How often to print progress
PROGRESS_INTERVAL = 5_000_000  # every 5M rows


def hour_key(ts_str):
    """Extract 'YYYY-MM-DDTHH' from a timestamp string for hourly grouping.

    Input format: 2021-01-26T00:00:00.000000000Z
    Returns:      2021-01-26T00
    """
    return ts_str[:13]


def load_rollover_log():
    """Load the pre-computed rollover log."""
    rollovers = []
    with open(ROLLOVER_LOG, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rollovers.append({
                "date": row["date"],
                "from_symbol": row["from_symbol"],
                "to_symbol": row["to_symbol"],
                "spread": float(row["spread"]),
            })
    print(f"Loaded {len(rollovers)} rollovers from {ROLLOVER_LOG.name}")
    for r in rollovers:
        print(f"  {r['date']}  {r['from_symbol']} -> {r['to_symbol']}  "
              f"spread: {r['spread']:+.2f}")
    return rollovers


def build_adjustment_intervals(rollovers):
    """
    Build a list of (boundary_ts, adjustment) intervals for back-adjustment.

    Back-adjustment logic (matches build-es-continuous.py):
      For each rollover that happens AFTER a given bar's timestamp, subtract
      that rollover's spread from the bar's OHLC prices.

    This means:
      - Bars before rollover 0:  adj = -(spread_0 + spread_1 + ... + spread_N)
      - Bars between rollover 0 and 1:  adj = -(spread_1 + ... + spread_N)
      - ...
      - Bars after last rollover:  adj = 0

    Returns a sorted list of (boundary_ts_str, adjustment) tuples.
    The first entry uses "" as boundary (matches everything before rollover 0).
    """
    if not rollovers:
        return [("", 0.0)]

    n = len(rollovers)

    # Suffix sums: suffix_sum[i] = sum of spreads from rollover i to N-1
    suffix_sum = [0.0] * (n + 1)
    for i in range(n - 1, -1, -1):
        suffix_sum[i] = suffix_sum[i + 1] + rollovers[i]["spread"]

    intervals = []

    # Before first rollover: subtract ALL spreads
    intervals.append(("", -suffix_sum[0]))

    # After rollover i: subtract only spreads from i+1 onward
    for i in range(n):
        roll_ts = rollovers[i]["date"] + "T00:00:00.000000000Z"
        adj = -suffix_sum[i + 1]
        intervals.append((roll_ts, adj))

    return intervals


def pass1_primary_contracts(input_file, start_date=None, end_date=None):
    """
    Pass 1: Stream through the file to determine the primary contract per hour.

    The primary contract for each hour is the one with the highest total volume.
    This filters out back-month contracts that trade alongside the front month.

    Returns a dict: { hour_key -> primary_symbol }
    """
    print("\n--- Pass 1: Determining primary contract per hour ---")
    t0 = time.time()

    # Accumulate volume per (hour, symbol)
    hourly_volume = defaultdict(lambda: defaultdict(float))

    row_count = 0
    skipped_spreads = 0
    skipped_date = 0

    with open(input_file, "r") as f:
        reader = csv.reader(f)
        header = next(reader)

        # Find column indices
        col_idx = {name: i for i, name in enumerate(header)}
        ts_idx = col_idx["ts_event"]
        vol_idx = col_idx["volume"]
        sym_idx = col_idx["symbol"]

        for row in reader:
            row_count += 1

            if row_count % PROGRESS_INTERVAL == 0:
                elapsed = time.time() - t0
                rate = row_count / elapsed
                print(f"  Pass 1: {row_count:>12,} rows  "
                      f"({elapsed:.0f}s, {rate:,.0f} rows/s)  "
                      f"last ts: {row[ts_idx][:19]}")

            symbol = row[sym_idx]

            # Filter calendar spreads (symbol contains a dash, e.g. ESH5-ESM5)
            if "-" in symbol:
                skipped_spreads += 1
                continue

            ts = row[ts_idx]

            # Date filtering (string comparison works for ISO timestamps)
            if start_date and ts < start_date:
                skipped_date += 1
                continue
            if end_date and ts > end_date:
                skipped_date += 1
                continue

            hk = hour_key(ts)
            vol = float(row[vol_idx])
            hourly_volume[hk][symbol] += vol

    elapsed = time.time() - t0
    print(f"  Pass 1 complete: {row_count:,} rows in {elapsed:.1f}s "
          f"({row_count/elapsed:,.0f} rows/s)")
    print(f"    Skipped {skipped_spreads:,} calendar spread rows")
    if skipped_date:
        print(f"    Skipped {skipped_date:,} rows outside date range")
    print(f"    Unique hours: {len(hourly_volume):,}")

    # Determine primary contract per hour
    primary_per_hour = {}
    for hk, symbols in hourly_volume.items():
        best_sym = max(symbols, key=symbols.get)
        primary_per_hour[hk] = best_sym

    # Report contract distribution
    contract_hours = defaultdict(int)
    for sym in primary_per_hour.values():
        contract_hours[sym] += 1
    print("  Primary contract distribution (hours):")
    for sym in sorted(contract_hours, key=lambda s: (s[-2:], s)):
        print(f"    {sym}: {contract_hours[sym]:,} hours")

    return primary_per_hour


def pass2_filter_adjust_write(input_file, output_file, primary_per_hour,
                               intervals, start_date=None, end_date=None):
    """
    Pass 2: Stream through the file, keep only primary contract rows,
    apply back-adjustment, and write output incrementally.

    Uses a forward-scanning interval index since timestamps are sorted.
    """
    print("\n--- Pass 2: Filtering, adjusting, and writing output ---")
    t0 = time.time()

    row_count = 0
    written = 0
    skipped_spreads = 0
    skipped_non_primary = 0
    skipped_date = 0

    # Approximate total rows for progress percentage
    approx_total = 63_333_623

    with open(input_file, "r") as fin, open(output_file, "w", newline="") as fout:
        reader = csv.reader(fin)
        header = next(reader)

        col_idx = {name: i for i, name in enumerate(header)}
        ts_idx = col_idx["ts_event"]
        open_idx = col_idx["open"]
        high_idx = col_idx["high"]
        low_idx = col_idx["low"]
        close_idx = col_idx["close"]
        vol_idx = col_idx["volume"]
        sym_idx = col_idx["symbol"]

        writer = csv.writer(fout)
        writer.writerow(["ts_event", "open", "high", "low", "close", "volume",
                          "symbol", "contract"])

        # Track which interval we are in (data is chronologically sorted,
        # so we only advance forward through intervals)
        interval_idx = 0

        for row in reader:
            row_count += 1

            if row_count % PROGRESS_INTERVAL == 0:
                elapsed = time.time() - t0
                rate = row_count / elapsed
                pct = (row_count / approx_total) * 100
                print(f"  Pass 2: {row_count:>12,} rows ({pct:5.1f}%)  "
                      f"written: {written:>12,}  "
                      f"({elapsed:.0f}s, {rate:,.0f} rows/s)  "
                      f"last ts: {row[ts_idx][:19]}")

            symbol = row[sym_idx]

            # Filter calendar spreads
            if "-" in symbol:
                skipped_spreads += 1
                continue

            ts = row[ts_idx]

            # Date filtering
            if start_date and ts < start_date:
                skipped_date += 1
                continue
            if end_date and ts > end_date:
                skipped_date += 1
                continue

            # Primary contract filter
            hk = hour_key(ts)
            primary = primary_per_hour.get(hk)
            if primary is None or symbol != primary:
                skipped_non_primary += 1
                continue

            # Advance interval_idx forward through sorted intervals
            while (interval_idx + 1 < len(intervals) and
                   ts >= intervals[interval_idx + 1][0]):
                interval_idx += 1
            adj = intervals[interval_idx][1]

            # Apply back-adjustment to OHLC prices
            o = float(row[open_idx]) + adj
            h = float(row[high_idx]) + adj
            l = float(row[low_idx]) + adj
            c = float(row[close_idx]) + adj

            writer.writerow([
                ts,
                f"{o:.9f}",
                f"{h:.9f}",
                f"{l:.9f}",
                f"{c:.9f}",
                row[vol_idx],
                "ES_continuous",
                symbol,
            ])
            written += 1

    elapsed = time.time() - t0
    print(f"  Pass 2 complete: {row_count:,} rows processed in {elapsed:.1f}s "
          f"({row_count/elapsed:,.0f} rows/s)")
    print(f"    Written: {written:,} rows")
    print(f"    Skipped: {skipped_spreads:,} calendar spreads, "
          f"{skipped_non_primary:,} non-primary, "
          f"{skipped_date:,} outside date range")
    return written


def verify_output(output_file):
    """
    Single-pass verification of the output file.
    Checks first/last rows and price continuity at contract transitions.
    """
    print("\n--- Verification ---")
    t0 = time.time()

    first_lines = []
    last_lines = deque(maxlen=3)
    total = 0

    prev_contract = None
    prev_close = None
    transitions = []

    with open(output_file, "r") as f:
        reader = csv.reader(f)
        header = next(reader)
        for row in reader:
            total += 1
            if total <= 3:
                first_lines.append(row)
            last_lines.append(row)

            # Track contract transitions
            contract = row[7]
            close = float(row[4])
            if prev_contract and contract != prev_contract:
                gap = close - prev_close
                transitions.append((row[0], prev_contract, contract, gap,
                                    prev_close, close))
            prev_contract = contract
            prev_close = close

    elapsed = time.time() - t0
    print(f"  Scanned {total:,} rows in {elapsed:.1f}s")

    print(f"  First rows:")
    for row in first_lines:
        print(f"    {row[0][:19]}  O={float(row[1]):.2f}  C={float(row[4]):.2f}  "
              f"V={row[5]}  contract={row[7]}")
    print(f"  Last rows:")
    for row in last_lines:
        print(f"    {row[0][:19]}  O={float(row[1]):.2f}  C={float(row[4]):.2f}  "
              f"V={row[5]}  contract={row[7]}")

    print(f"\n  Contract transitions ({len(transitions)}):")
    for ts, from_c, to_c, gap, prev_cl, curr_cl in transitions:
        status = "OK" if abs(gap) < 50 else "WARNING"
        print(f"    [{status}] {ts[:19]}  {from_c} -> {to_c}  "
              f"gap: {gap:+.2f}  "
              f"(prev_close={prev_cl:.2f}, close={curr_cl:.2f})")


def main():
    parser = argparse.ArgumentParser(
        description="Build back-adjusted continuous ES 1-second series"
    )
    parser.add_argument("--start", default=None,
                        help="Start date filter (YYYY-MM-DD), inclusive")
    parser.add_argument("--end", default=None,
                        help="End date filter (YYYY-MM-DD), inclusive")
    parser.add_argument("--skip-verify", action="store_true",
                        help="Skip output verification pass")
    args = parser.parse_args()

    # Convert date filters to ISO-comparable strings
    start_date = args.start + "T" if args.start else None
    end_date = args.end + "T99" if args.end else None  # "T99" > any valid time

    print(f"Input:  {OHLCV_FILE}")
    print(f"Output: {OUTPUT_FILE}")
    print(f"Rollover log: {ROLLOVER_LOG}")
    if start_date:
        print(f"Start filter: {args.start}")
    if end_date:
        print(f"End filter: {args.end}")

    # Check input files exist
    if not OHLCV_FILE.exists():
        print(f"ERROR: Input file not found: {OHLCV_FILE}")
        sys.exit(1)
    if not ROLLOVER_LOG.exists():
        print(f"ERROR: Rollover log not found: {ROLLOVER_LOG}")
        print("  Run build-es-continuous.py first to generate it.")
        sys.exit(1)

    t_total = time.time()

    # Load rollover data
    rollovers = load_rollover_log()

    # Build adjustment intervals
    intervals = build_adjustment_intervals(rollovers)
    print(f"\nBack-adjustment intervals ({len(intervals)}):")
    for boundary, adj in intervals:
        label = boundary[:10] if boundary else "(start)"
        print(f"  {label:>12}  adjustment: {adj:+.2f}")

    # Pass 1: determine primary contract per hour
    primary_per_hour = pass1_primary_contracts(
        OHLCV_FILE, start_date, end_date
    )

    # Pass 2: filter, adjust, write
    written = pass2_filter_adjust_write(
        OHLCV_FILE, OUTPUT_FILE, primary_per_hour,
        intervals, start_date, end_date
    )

    # Verification
    if not args.skip_verify and written > 0:
        verify_output(OUTPUT_FILE)

    elapsed_total = time.time() - t_total
    print(f"\n{'='*60}")
    print(f"COMPLETE in {elapsed_total:.1f}s ({elapsed_total/60:.1f} min)")
    print(f"{'='*60}")
    print(f"  Output: {OUTPUT_FILE}")
    print(f"  Rows written: {written:,}")
    total_adj = sum(r["spread"] for r in rollovers)
    print(f"  Total back-adjustment (earliest data): {-total_adj:+.2f} pts")
    print(f"  Rollovers applied: {len(rollovers)}")


if __name__ == "__main__":
    main()
