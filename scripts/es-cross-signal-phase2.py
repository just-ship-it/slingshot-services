#!/usr/bin/env python3
"""
ES Cross-Signal Exploration — Phase 2: Cross-Signal Event Analysis

Three investigations, all targeting "a few signals per trading day":

  INV1. GEX + LT level convergence zones
        When a GEX level lands within 0.1% of an LT level, does that zone hold?

  INV2. 15-min LT crossings conditioned on GEX regime
        Does crossing direction + regime predict the next move?

  INV3. GEX regime transitions near LT levels
        When regime changes while price is near an LT level, what happens?

Forward returns computed at 5min, 15min, 1hr, 4hr horizons.
Session context: overnight (18:00-09:30 ET) vs RTH (09:30-16:00 ET).
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent / "backtest-engine" / "data"
GEX_DIR = BASE_DIR / "gex" / "es"
LT_15M = BASE_DIR / "liquidity" / "es" / "ES_liquidity_levels_15m.csv"
LT_HOURLY = BASE_DIR / "liquidity" / "es" / "ES_liquidity_levels_1h.csv"
OHLCV_FILE = BASE_DIR / "ohlcv" / "es" / "ES_ohlcv_1m_continuous.csv"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "skunkworks" / "es exploration"

START_DATE = pd.Timestamp("2023-03-28", tz="UTC")
END_DATE = pd.Timestamp("2026-01-27", tz="UTC")

PROXIMITY_PCT = 0.1  # 0.1% ≈ ±6 points at ES 6000
FORWARD_HORIZONS = {"5min": 5, "15min": 15, "1hr": 60, "4hr": 240}


# ── Data Loaders ───────────────────────────────────────────────────────────────

def load_gex_data():
    """Load ES GEX intraday JSON files."""
    print("Loading ES GEX intraday data...")
    files = sorted(GEX_DIR.glob("es_gex_*.json"))
    rows = []
    for f in files:
        date_str = f.stem.replace("es_gex_", "")
        if date_str < "2023-03-28" or date_str > "2026-01-27":
            continue
        with open(f) as fh:
            data = json.load(fh)
        for snap in data.get("data", []):
            row = {
                "timestamp": pd.Timestamp(snap["timestamp"]),
                "es_spot": snap.get("es_spot"),
                "gamma_flip": snap.get("gamma_flip"),
                "call_wall": snap.get("call_wall"),
                "put_wall": snap.get("put_wall"),
                "total_gex": snap.get("total_gex"),
                "total_vex": snap.get("total_vex"),
                "total_cex": snap.get("total_cex"),
                "regime": snap.get("regime"),
            }
            for i, v in enumerate(snap.get("resistance", [])):
                row[f"resistance_{i}"] = v
            for i, v in enumerate(snap.get("support", [])):
                row[f"support_{i}"] = v
            rows.append(row)
    df = pd.DataFrame(rows)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.sort_values("timestamp").reset_index(drop=True)
    print(f"  {len(df):,} GEX snapshots")
    return df


def load_lt_data(filepath, name):
    """Load LT levels CSV."""
    print(f"Loading LT {name} data...")
    df = pd.read_csv(filepath)
    df["timestamp"] = pd.to_datetime(df["unix_timestamp"], unit="ms", utc=True)
    df = df[(df["timestamp"] >= START_DATE) & (df["timestamp"] <= END_DATE)]
    df = df.sort_values("timestamp").reset_index(drop=True)
    print(f"  {len(df):,} snapshots")
    return df


def load_ohlcv_1m():
    """Load back-adjusted continuous ES 1-min OHLCV."""
    print("Loading ES 1-min continuous OHLCV...")
    df = pd.read_csv(
        OHLCV_FILE,
        usecols=["ts_event", "open", "high", "low", "close", "volume"],
        dtype={"open": float, "high": float, "low": float, "close": float,
               "volume": float},
    )
    df["ts_event"] = pd.to_datetime(df["ts_event"], utc=True)
    df = df[(df["ts_event"] >= START_DATE) & (df["ts_event"] <= END_DATE)]
    df = df.set_index("ts_event").sort_index()
    df = df[~df.index.duplicated(keep="first")]
    print(f"  {len(df):,} 1-min bars (continuous, back-adjusted)")
    return df


def build_forward_returns(ohlcv_1m):
    """Pre-compute forward return columns on the 1-min close series."""
    print("Building forward return lookup...")
    close = ohlcv_1m["close"]
    fwd = pd.DataFrame(index=close.index)
    for label, minutes in FORWARD_HORIZONS.items():
        fwd[f"fwd_{label}_pts"] = close.shift(-minutes) - close
        fwd[f"fwd_{label}_pct"] = (close.shift(-minutes) / close - 1) * 100
    print(f"  Forward returns computed for {len(fwd):,} bars")
    return fwd


def classify_session(ts):
    """Classify a UTC timestamp into session: overnight, premarket, rth, afterhours."""
    # Convert to US/Eastern
    et = ts.tz_convert("America/New_York")
    hour, minute = et.hour, et.minute
    t = hour * 60 + minute
    if t >= 570 and t < 960:    # 09:30 - 16:00
        return "rth"
    elif t >= 1080 or t < 570:  # 18:00 - 09:30
        return "overnight"
    else:                        # 16:00 - 18:00
        return "afterhours"


def get_forward_returns_at(timestamps, fwd_df):
    """Look up forward returns for a list of timestamps via nearest-1min bar."""
    # Round to nearest minute for alignment
    rounded = timestamps.round("min")
    matched = fwd_df.reindex(rounded)
    matched.index = timestamps  # restore original index
    return matched


def summarize_returns(fwd_returns, label=""):
    """Compute summary statistics for forward returns."""
    stats = {}
    for horizon in FORWARD_HORIZONS:
        col_pts = f"fwd_{horizon}_pts"
        col_pct = f"fwd_{horizon}_pct"
        vals = fwd_returns[col_pts].dropna()
        if len(vals) < 5:
            continue
        positive = (vals > 0).sum()
        stats[horizon] = {
            "n": int(len(vals)),
            "mean_pts": round(float(vals.mean()), 3),
            "median_pts": round(float(vals.median()), 3),
            "std_pts": round(float(vals.std()), 3),
            "win_rate": round(float(positive / len(vals) * 100), 1),
            "p25_pts": round(float(vals.quantile(0.25)), 3),
            "p75_pts": round(float(vals.quantile(0.75)), 3),
        }
    return stats


def print_return_table(stats, indent="    "):
    """Pretty-print forward return stats."""
    if not stats:
        print(f"{indent}(insufficient data)")
        return
    horizons = list(stats.keys())
    print(f"{indent}{'Horizon':>8s}  {'N':>6s}  {'Mean':>8s}  {'Median':>8s}  {'Std':>8s}  {'Win%':>6s}")
    for h in horizons:
        s = stats[h]
        print(f"{indent}{h:>8s}  {s['n']:>6,}  {s['mean_pts']:>+8.2f}  {s['median_pts']:>+8.2f}  {s['std_pts']:>8.2f}  {s['win_rate']:>5.1f}%")


# ── INV1: GEX + LT Level Convergence Zones ────────────────────────────────────

def investigate_convergence(gex_df, lt_15m, fwd_df):
    """When GEX levels cluster near LT levels, does the zone hold?"""
    print("\n" + "=" * 80)
    print("INV1: GEX + LT LEVEL CONVERGENCE ZONES")
    print("=" * 80)
    results = {}

    gex_level_cols = (
        ["gamma_flip", "call_wall", "put_wall"] +
        [f"resistance_{i}" for i in range(5)] +
        [f"support_{i}" for i in range(5)]
    )
    lt_level_cols = ["level_1", "level_2", "level_3", "level_4", "level_5"]

    # Align GEX and LT on 15-min timestamps
    gex = gex_df[["timestamp", "es_spot", "regime"] + gex_level_cols].copy()
    lt = lt_15m[["timestamp", "sentiment"] + lt_level_cols].copy()

    merged = pd.merge_asof(
        gex.sort_values("timestamp"),
        lt.sort_values("timestamp"),
        on="timestamp",
        direction="nearest",
        tolerance=pd.Timedelta("8min"),
    )
    merged = merged.dropna(subset=["level_1", "es_spot"])
    print(f"  Aligned snapshots: {len(merged):,}")

    # Find convergence events: any GEX level within PROXIMITY_PCT of any LT level
    convergence_events = []
    for _, row in merged.iterrows():
        price = row["es_spot"]
        threshold = price * PROXIMITY_PCT / 100

        for gcol in gex_level_cols:
            gex_val = row[gcol]
            if pd.isna(gex_val):
                continue
            for lcol in lt_level_cols:
                lt_val = row[lcol]
                if pd.isna(lt_val):
                    continue
                if abs(gex_val - lt_val) <= threshold:
                    zone_mid = (gex_val + lt_val) / 2
                    price_to_zone = price - zone_mid  # positive = price above zone
                    convergence_events.append({
                        "timestamp": row["timestamp"],
                        "price": price,
                        "gex_level": gcol,
                        "lt_level": lcol,
                        "gex_val": gex_val,
                        "lt_val": lt_val,
                        "zone_mid": zone_mid,
                        "price_to_zone_pts": price_to_zone,
                        "regime": row["regime"],
                        "sentiment": row["sentiment"],
                    })

    conv_df = pd.DataFrame(convergence_events)
    if conv_df.empty:
        print("  No convergence events found!")
        return results

    # Deduplicate: keep one event per timestamp (the tightest convergence)
    conv_df["gap"] = abs(conv_df["gex_val"] - conv_df["lt_val"])
    conv_dedup = conv_df.loc[conv_df.groupby("timestamp")["gap"].idxmin()]

    total_days = (merged["timestamp"].max() - merged["timestamp"].min()).days
    events_per_day = len(conv_dedup) / max(total_days, 1)

    print(f"\n  Raw convergence pairs: {len(conv_df):,}")
    print(f"  Unique timestamp events (tightest pair): {len(conv_dedup):,}")
    print(f"  Events per day: {events_per_day:.1f}")
    results["raw_events"] = len(conv_df)
    results["unique_events"] = len(conv_dedup)
    results["events_per_day"] = round(events_per_day, 2)

    # Which GEX levels converge most with LT?
    print(f"\n  ── Most Common GEX Levels in Convergence ──")
    gex_counts = conv_df["gex_level"].value_counts().head(10)
    for lvl, cnt in gex_counts.items():
        print(f"    {lvl:20s}  {cnt:>6,}")

    # Which LT levels converge most?
    print(f"\n  ── Most Common LT Levels in Convergence ──")
    lt_counts = conv_df["lt_level"].value_counts()
    for lvl, cnt in lt_counts.items():
        print(f"    {lvl:10s}  {cnt:>6,}")

    # Forward returns for convergence events
    print(f"\n  ── Forward Returns: All Convergence Events ──")
    fwd_at_events = get_forward_returns_at(conv_dedup["timestamp"], fwd_df)
    conv_dedup = conv_dedup.set_index("timestamp")
    conv_dedup = conv_dedup.join(fwd_at_events)

    all_stats = summarize_returns(conv_dedup, "all_convergence")
    print_return_table(all_stats)
    results["all_convergence_returns"] = all_stats

    # Split: price ABOVE zone vs BELOW zone
    above = conv_dedup[conv_dedup["price_to_zone_pts"] > 0]
    below = conv_dedup[conv_dedup["price_to_zone_pts"] <= 0]

    print(f"\n  ── Price ABOVE convergence zone (n={len(above):,}) ──")
    above_stats = summarize_returns(above)
    print_return_table(above_stats)
    results["price_above_zone"] = {"n": len(above), "returns": above_stats}

    print(f"\n  ── Price BELOW convergence zone (n={len(below):,}) ──")
    below_stats = summarize_returns(below)
    print_return_table(below_stats)
    results["price_below_zone"] = {"n": len(below), "returns": below_stats}

    # Split by GEX regime
    print(f"\n  ── Forward Returns by GEX Regime ──")
    results["by_regime"] = {}
    for regime in ["strong_positive", "positive", "neutral", "negative", "strong_negative"]:
        subset = conv_dedup[conv_dedup["regime"] == regime]
        if len(subset) < 10:
            continue
        stats = summarize_returns(subset)
        print(f"\n    {regime} (n={len(subset):,}):")
        print_return_table(stats, indent="      ")
        results["by_regime"][regime] = {"n": len(subset), "returns": stats}

    # Split by session
    conv_dedup_reset = conv_dedup.reset_index()
    conv_dedup_reset["session"] = conv_dedup_reset["timestamp"].apply(classify_session)
    print(f"\n  ── Forward Returns by Session ──")
    results["by_session"] = {}
    for session in ["overnight", "rth"]:
        subset = conv_dedup_reset[conv_dedup_reset["session"] == session]
        if len(subset) < 10:
            continue
        stats = summarize_returns(subset)
        print(f"\n    {session} (n={len(subset):,}):")
        print_return_table(stats, indent="      ")
        results["by_session"][session] = {"n": len(subset), "returns": stats}

    # Convergence zone as support/resistance test
    # Price near zone (<0.05%): does it bounce (revert) or break through?
    near_zone = conv_dedup[abs(conv_dedup["price_to_zone_pts"]) / conv_dedup["price"] * 100 < 0.05]
    if len(near_zone) >= 10:
        print(f"\n  ── Price RIGHT AT convergence zone (<0.05%, n={len(near_zone):,}) ──")
        # Check if 15-min forward move reverts toward or away from zone
        fwd_15m = near_zone["fwd_15min_pts"].dropna()
        above_zone_near = near_zone[near_zone["price_to_zone_pts"] > 0]
        below_zone_near = near_zone[near_zone["price_to_zone_pts"] <= 0]

        if len(above_zone_near) >= 5:
            bounce_up = (above_zone_near["fwd_15min_pts"] > 0).sum()
            print(f"    Price just above zone: {len(above_zone_near)} events, "
                  f"continued up {bounce_up} ({bounce_up/len(above_zone_near)*100:.0f}%), "
                  f"fell back {len(above_zone_near)-bounce_up} ({(len(above_zone_near)-bounce_up)/len(above_zone_near)*100:.0f}%)")

        if len(below_zone_near) >= 5:
            bounce_down = (below_zone_near["fwd_15min_pts"] < 0).sum()
            print(f"    Price just below zone: {len(below_zone_near)} events, "
                  f"continued down {bounce_down} ({bounce_down/len(below_zone_near)*100:.0f}%), "
                  f"bounced up {len(below_zone_near)-bounce_down} ({(len(below_zone_near)-bounce_down)/len(below_zone_near)*100:.0f}%)")

    return results


# ── INV2: LT Crossings Conditioned on GEX Regime ──────────────────────────────

def investigate_lt_crossings_gex(lt_15m, gex_df, fwd_df):
    """LT level crossings through price, split by GEX regime and direction."""
    print("\n" + "=" * 80)
    print("INV2: 15-MIN LT CROSSINGS CONDITIONED ON GEX REGIME")
    print("=" * 80)
    results = {}

    level_cols = ["level_1", "level_2", "level_3", "level_4", "level_5"]
    fib_labels = {"level_1": "fib-34", "level_2": "fib-55", "level_3": "fib-144",
                  "level_4": "fib-377", "level_5": "fib-610"}

    # Merge LT with nearest GEX snapshot for regime context
    lt = lt_15m.copy().sort_values("timestamp")
    gex_slim = gex_df[["timestamp", "regime", "es_spot", "total_gex"]].copy().sort_values("timestamp")
    lt = pd.merge_asof(lt, gex_slim, on="timestamp", direction="nearest",
                       tolerance=pd.Timedelta("16min"))
    lt = lt.dropna(subset=["regime", "es_spot"])

    # Use es_spot from GEX as our price reference (already merged above)
    lt["price"] = lt["es_spot"]

    # Detect crossings
    crossing_events = []
    for col in level_cols:
        above = lt[col].values > lt["price"].values
        crossings = above[1:] != above[:-1]
        indices = np.where(crossings)[0]
        for idx in indices:
            direction = "down_through" if above[idx] and not above[idx + 1] else "up_through"
            crossing_events.append({
                "timestamp": lt["timestamp"].iloc[idx + 1],
                "fib": fib_labels[col],
                "direction": direction,
                "price": float(lt["price"].iloc[idx + 1]),
                "level_value": float(lt[col].iloc[idx + 1]),
                "regime": lt["regime"].iloc[idx + 1],
                "session": classify_session(lt["timestamp"].iloc[idx + 1]),
            })

    cx_df = pd.DataFrame(crossing_events)
    total_days = (lt["timestamp"].max() - lt["timestamp"].min()).days
    print(f"  Total crossing events: {len(cx_df):,} ({len(cx_df)/max(total_days,1):.1f}/day)")
    results["total_crossings"] = len(cx_df)
    results["per_day"] = round(len(cx_df) / max(total_days, 1), 2)

    # Get forward returns for all crossings
    fwd_at_cx = get_forward_returns_at(cx_df["timestamp"], fwd_df)
    cx_df = cx_df.set_index("timestamp").join(fwd_at_cx)

    # Overall crossing returns (baseline)
    print(f"\n  ── Baseline: All Crossings ──")
    baseline = summarize_returns(cx_df)
    print_return_table(baseline)
    results["baseline"] = baseline

    # By direction
    for direction in ["up_through", "down_through"]:
        subset = cx_df[cx_df["direction"] == direction]
        print(f"\n  ── Direction: {direction} (n={len(subset):,}) ──")
        stats = summarize_returns(subset)
        print_return_table(stats)
        results[direction] = {"n": len(subset), "returns": stats}

    # By fib level
    print(f"\n  ── By Fibonacci Level ──")
    results["by_fib"] = {}
    for fib in ["fib-34", "fib-55", "fib-144", "fib-377", "fib-610"]:
        subset = cx_df[cx_df["fib"] == fib]
        if len(subset) < 10:
            continue
        stats = summarize_returns(subset)
        print(f"\n    {fib} (n={len(subset):,}):")
        print_return_table(stats, indent="      ")
        results["by_fib"][fib] = {"n": len(subset), "returns": stats}

    # THE KEY ANALYSIS: Direction × Regime
    print(f"\n  ── Direction × GEX Regime (the money table) ──")
    results["direction_x_regime"] = {}
    regimes = ["strong_positive", "positive", "neutral", "negative", "strong_negative"]
    # Collapsed regime groups for more sample size
    cx_df["regime_group"] = cx_df["regime"].map({
        "strong_positive": "positive", "positive": "positive",
        "neutral": "neutral",
        "negative": "negative", "strong_negative": "negative",
    })

    for direction in ["up_through", "down_through"]:
        for rgroup in ["positive", "neutral", "negative"]:
            subset = cx_df[(cx_df["direction"] == direction) & (cx_df["regime_group"] == rgroup)]
            if len(subset) < 20:
                continue
            stats = summarize_returns(subset)
            label = f"{direction} + {rgroup} GEX"
            print(f"\n    {label} (n={len(subset):,}):")
            print_return_table(stats, indent="      ")
            results["direction_x_regime"][label] = {"n": len(subset), "returns": stats}

    # Direction × Regime × Fib (only higher-fib for sample size)
    print(f"\n  ── Direction × Regime × Higher Fib (144/377/610) ──")
    results["direction_x_regime_x_highfib"] = {}
    high_fib = cx_df[cx_df["fib"].isin(["fib-144", "fib-377", "fib-610"])]
    for direction in ["up_through", "down_through"]:
        for rgroup in ["positive", "negative"]:
            subset = high_fib[(high_fib["direction"] == direction) & (high_fib["regime_group"] == rgroup)]
            if len(subset) < 20:
                continue
            stats = summarize_returns(subset)
            label = f"{direction} + {rgroup} GEX + high-fib"
            print(f"\n    {label} (n={len(subset):,}):")
            print_return_table(stats, indent="      ")
            results["direction_x_regime_x_highfib"][label] = {"n": len(subset), "returns": stats}

    # By session
    print(f"\n  ── By Session ──")
    results["by_session"] = {}
    for session in ["overnight", "rth"]:
        subset = cx_df[cx_df["session"] == session]
        if len(subset) < 20:
            continue
        stats = summarize_returns(subset)
        print(f"\n    {session} (n={len(subset):,}):")
        print_return_table(stats, indent="      ")
        results["by_session"][session] = {"n": len(subset), "returns": stats}

    # Session × Direction for the best combos
    print(f"\n  ── Session × Direction ──")
    results["session_x_direction"] = {}
    for session in ["overnight", "rth"]:
        for direction in ["up_through", "down_through"]:
            subset = cx_df[(cx_df["session"] == session) & (cx_df["direction"] == direction)]
            if len(subset) < 20:
                continue
            stats = summarize_returns(subset)
            label = f"{session} + {direction}"
            print(f"\n    {label} (n={len(subset):,}):")
            print_return_table(stats, indent="      ")
            results["session_x_direction"][label] = {"n": len(subset), "returns": stats}

    return results


# ── INV3: GEX Regime Transitions Near LT Levels ───────────────────────────────

def investigate_regime_transitions(gex_df, lt_15m, fwd_df):
    """When GEX regime changes while price is near an LT level, what happens?"""
    print("\n" + "=" * 80)
    print("INV3: GEX REGIME TRANSITIONS NEAR LT LEVELS")
    print("=" * 80)
    results = {}

    # Detect regime transitions
    transition_events = []
    for i in range(1, len(gex_df)):
        prev_regime = gex_df["regime"].iloc[i - 1]
        curr_regime = gex_df["regime"].iloc[i]
        if prev_regime != curr_regime:
            transition_events.append({
                "timestamp": gex_df["timestamp"].iloc[i],
                "price": gex_df["es_spot"].iloc[i],
                "from_regime": prev_regime,
                "to_regime": curr_regime,
                "total_gex": gex_df["total_gex"].iloc[i],
            })

    tx_df = pd.DataFrame(transition_events)
    total_days = (gex_df["timestamp"].max() - gex_df["timestamp"].min()).days
    print(f"  Regime transitions: {len(tx_df):,} ({len(tx_df)/max(total_days,1):.1f}/day)")

    # Classify transition direction
    regime_rank = {"strong_negative": -2, "negative": -1, "neutral": 0, "positive": 1, "strong_positive": 2}
    tx_df["from_rank"] = tx_df["from_regime"].map(regime_rank)
    tx_df["to_rank"] = tx_df["to_regime"].map(regime_rank)
    tx_df["direction"] = np.where(tx_df["to_rank"] > tx_df["from_rank"], "improving", "deteriorating")
    tx_df["session"] = tx_df["timestamp"].apply(classify_session)

    # Merge nearest LT 15m levels
    lt = lt_15m[["timestamp", "level_1", "level_2", "level_3", "level_4", "level_5", "sentiment"]].copy()
    tx_df = tx_df.sort_values("timestamp")
    lt = lt.sort_values("timestamp")
    tx_df = pd.merge_asof(tx_df, lt, on="timestamp", direction="nearest",
                          tolerance=pd.Timedelta("16min"))

    # Check if price is near any LT level
    lt_level_cols = ["level_1", "level_2", "level_3", "level_4", "level_5"]
    near_lt = []
    for _, row in tx_df.iterrows():
        price = row["price"]
        if pd.isna(price):
            near_lt.append(False)
            continue
        threshold = price * PROXIMITY_PCT / 100
        is_near = False
        for lcol in lt_level_cols:
            if pd.notna(row[lcol]) and abs(row[lcol] - price) <= threshold:
                is_near = True
                break
        near_lt.append(is_near)
    tx_df["near_lt_level"] = near_lt

    near_count = tx_df["near_lt_level"].sum()
    not_near_count = (~tx_df["near_lt_level"]).sum()
    print(f"  Near LT level (within {PROXIMITY_PCT}%): {near_count:,} ({near_count/len(tx_df)*100:.1f}%)")
    print(f"  Not near LT level: {not_near_count:,}")

    # Forward returns
    fwd_at_tx = get_forward_returns_at(tx_df["timestamp"], fwd_df)
    tx_df = tx_df.set_index("timestamp").join(fwd_at_tx)

    # Overall transition returns
    print(f"\n  ── Baseline: All Transitions ──")
    baseline = summarize_returns(tx_df)
    print_return_table(baseline)
    results["baseline"] = baseline

    # By direction (improving vs deteriorating)
    print(f"\n  ── By Transition Direction ──")
    results["by_direction"] = {}
    for d in ["improving", "deteriorating"]:
        subset = tx_df[tx_df["direction"] == d]
        stats = summarize_returns(subset)
        print(f"\n    {d} (n={len(subset):,}):")
        print_return_table(stats, indent="      ")
        results["by_direction"][d] = {"n": len(subset), "returns": stats}

    # KEY: Near LT level vs not, split by direction
    print(f"\n  ── Transition Direction × LT Proximity (the key question) ──")
    results["direction_x_proximity"] = {}
    for d in ["improving", "deteriorating"]:
        for near in [True, False]:
            subset = tx_df[(tx_df["direction"] == d) & (tx_df["near_lt_level"] == near)]
            if len(subset) < 15:
                continue
            stats = summarize_returns(subset)
            near_label = "near_LT" if near else "not_near_LT"
            label = f"{d} + {near_label}"
            print(f"\n    {label} (n={len(subset):,}):")
            print_return_table(stats, indent="      ")
            results["direction_x_proximity"][label] = {"n": len(subset), "returns": stats}

    # Specific transitions: into/out of strong regimes
    print(f"\n  ── Key Transition Types ──")
    results["key_transitions"] = {}
    key_types = [
        ("entering strong_positive", lambda r: r["to_regime"] == "strong_positive"),
        ("leaving strong_positive", lambda r: r["from_regime"] == "strong_positive"),
        ("entering strong_negative", lambda r: r["to_regime"] == "strong_negative"),
        ("leaving strong_negative", lambda r: r["from_regime"] == "strong_negative"),
        ("crossing neutral (improving)", lambda r: (r["from_rank"] < 0) & (r["to_rank"] >= 0)),
        ("crossing neutral (deteriorating)", lambda r: (r["from_rank"] >= 0) & (r["to_rank"] < 0)),
    ]
    for name, filter_fn in key_types:
        subset = tx_df[filter_fn(tx_df)]
        if len(subset) < 15:
            print(f"\n    {name}: n={len(subset)} (too few)")
            continue
        stats = summarize_returns(subset)
        print(f"\n    {name} (n={len(subset):,}):")
        print_return_table(stats, indent="      ")
        results["key_transitions"][name] = {"n": len(subset), "returns": stats}

    # Session context
    print(f"\n  ── By Session ──")
    results["by_session"] = {}
    for session in ["overnight", "rth"]:
        subset = tx_df[tx_df["session"] == session]
        if len(subset) < 20:
            continue
        stats = summarize_returns(subset)
        print(f"\n    {session} (n={len(subset):,}):")
        print_return_table(stats, indent="      ")
        results["by_session"][session] = {"n": len(subset), "returns": stats}

    # Session × Direction
    print(f"\n  ── Session × Direction ──")
    results["session_x_direction"] = {}
    for session in ["overnight", "rth"]:
        for d in ["improving", "deteriorating"]:
            subset = tx_df[(tx_df["session"] == session) & (tx_df["direction"] == d)]
            if len(subset) < 15:
                continue
            stats = summarize_returns(subset)
            label = f"{session} + {d}"
            print(f"\n    {label} (n={len(subset):,}):")
            print_return_table(stats, indent="      ")
            results["session_x_direction"][label] = {"n": len(subset), "returns": stats}

    return results


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    print("=" * 80)
    print("ES CROSS-SIGNAL EXPLORATION — PHASE 2")
    print(f"Analysis window: {START_DATE.date()} → {END_DATE.date()}")
    print("=" * 80)

    all_results = {}

    # Load data
    gex_df = load_gex_data()
    lt_15m = load_lt_data(LT_15M, "15-min")
    ohlcv_1m = load_ohlcv_1m()
    fwd_df = build_forward_returns(ohlcv_1m)

    # Run investigations
    all_results["inv1_convergence"] = investigate_convergence(gex_df, lt_15m, fwd_df)
    all_results["inv2_lt_crossings_gex"] = investigate_lt_crossings_gex(lt_15m, gex_df, fwd_df)
    all_results["inv3_regime_transitions"] = investigate_regime_transitions(gex_df, lt_15m, fwd_df)

    # Save results
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_file = OUTPUT_DIR / "phase2_results.json"
    with open(output_file, "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\n\nResults saved to {output_file}")
    print("Done.")


if __name__ == "__main__":
    main()
