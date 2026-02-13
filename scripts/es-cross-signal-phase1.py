#!/usr/bin/env python3
"""
ES Cross-Signal Exploration — Phase 1: Individual Signal Characterization

Analyzes:
  Q1. GEX regime distribution and GEX/VEX/CEX correlations
  Q2. LT level dynamics per timeframe (crossing frequency, level lifespan)
  Q3. LT sentiment alignment across timeframes

Data period: March 2023 — January 2026
Output: summary to stdout + detailed JSON to skunkworks/es exploration/
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent / "backtest-engine" / "data"
GEX_DIR = BASE_DIR / "gex" / "es"
LT_DAILY = BASE_DIR / "liquidity" / "es" / "ES_liquidity_levels_1D.csv"
LT_HOURLY = BASE_DIR / "liquidity" / "es" / "ES_liquidity_levels_1h.csv"
LT_15M = BASE_DIR / "liquidity" / "es" / "ES_liquidity_levels_15m.csv"
OHLCV_FILE = BASE_DIR / "ohlcv" / "es" / "ES_ohlcv_1m.csv"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "skunkworks" / "es exploration"

# Analysis window (overlap of all datasets)
START_DATE = pd.Timestamp("2023-03-28", tz="UTC")
END_DATE = pd.Timestamp("2026-01-27", tz="UTC")


# ── Data Loaders ───────────────────────────────────────────────────────────────

def load_gex_data():
    """Load all ES GEX intraday JSON files into a DataFrame."""
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
                "spy_spot": snap.get("spy_spot"),
                "multiplier": snap.get("multiplier"),
                "gamma_flip": snap.get("gamma_flip"),
                "call_wall": snap.get("call_wall"),
                "put_wall": snap.get("put_wall"),
                "total_gex": snap.get("total_gex"),
                "total_vex": snap.get("total_vex"),
                "total_cex": snap.get("total_cex"),
                "regime": snap.get("regime"),
                "options_count": snap.get("options_count"),
            }
            # Flatten support/resistance arrays
            for i, v in enumerate(snap.get("resistance", [])):
                row[f"resistance_{i}"] = v
            for i, v in enumerate(snap.get("support", [])):
                row[f"support_{i}"] = v
            rows.append(row)

    df = pd.DataFrame(rows)
    if df.empty:
        print("  WARNING: No GEX data loaded!")
        return df
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.sort_values("timestamp").reset_index(drop=True)
    print(f"  Loaded {len(df):,} GEX snapshots from {len(files)} files")
    print(f"  Date range: {df['timestamp'].min()} → {df['timestamp'].max()}")
    return df


def load_lt_data(filepath, name):
    """Load LT levels CSV."""
    print(f"Loading LT {name} data...")
    df = pd.read_csv(filepath)
    # unix_timestamp is in milliseconds
    df["timestamp"] = pd.to_datetime(df["unix_timestamp"], unit="ms", utc=True)
    df = df[(df["timestamp"] >= START_DATE) & (df["timestamp"] <= END_DATE)]
    df = df.sort_values("timestamp").reset_index(drop=True)
    print(f"  Loaded {len(df):,} snapshots ({name})")
    return df


def load_ohlcv_15m():
    """Load ES 1-min OHLCV, filter primary contract, resample to 15-min."""
    print("Loading ES OHLCV (this may take a minute)...")
    chunks = []
    for chunk in pd.read_csv(
        OHLCV_FILE,
        usecols=["ts_event", "open", "high", "low", "close", "volume", "symbol"],
        dtype={"open": float, "high": float, "low": float, "close": float,
               "volume": float, "symbol": str},
        chunksize=2_000_000,
    ):
        # Parse timestamps
        chunk["ts_event"] = pd.to_datetime(chunk["ts_event"], utc=True)
        # Filter date range
        chunk = chunk[(chunk["ts_event"] >= START_DATE) & (chunk["ts_event"] <= END_DATE)]
        # Filter calendar spreads (symbols with dash)
        chunk = chunk[~chunk["symbol"].str.contains("-", na=False)]
        if not chunk.empty:
            chunks.append(chunk)

    df = pd.concat(chunks, ignore_index=True)
    print(f"  Raw candles in range: {len(df):,}")

    # Primary contract filtering: highest volume contract per hour
    df["hour"] = df["ts_event"].dt.floor("h")
    hourly_vol = df.groupby(["hour", "symbol"])["volume"].sum().reset_index()
    idx = hourly_vol.groupby("hour")["volume"].idxmax()
    primary_map = hourly_vol.loc[idx, ["hour", "symbol"]].rename(columns={"symbol": "primary"})
    df = df.merge(primary_map, on="hour")
    df = df[df["symbol"] == df["primary"]].drop(columns=["primary", "hour"])
    print(f"  After primary contract filter: {len(df):,}")

    # Resample to 15-min
    df = df.set_index("ts_event").sort_index()
    ohlcv_15m = df.resample("15min").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }).dropna(subset=["close"])
    ohlcv_15m = ohlcv_15m.reset_index()
    ohlcv_15m.rename(columns={"ts_event": "timestamp"}, inplace=True)
    print(f"  15-min bars: {len(ohlcv_15m):,}")
    return ohlcv_15m


# ── Q1: GEX Regime Distribution & Greek Correlations ──────────────────────────

def analyze_gex_regimes(gex_df):
    """Characterize GEX regime distribution and Greek correlations."""
    print("\n" + "=" * 80)
    print("Q1: GEX REGIME DISTRIBUTION & GREEK CORRELATIONS")
    print("=" * 80)
    results = {}

    # Regime distribution
    regime_counts = gex_df["regime"].value_counts()
    regime_pct = (regime_counts / len(gex_df) * 100).round(2)
    print("\n── Regime Distribution ──")
    for regime in ["strong_positive", "positive", "neutral", "negative", "strong_negative"]:
        count = regime_counts.get(regime, 0)
        pct = regime_pct.get(regime, 0)
        bar = "█" * int(pct / 2)
        print(f"  {regime:20s}  {count:6,}  ({pct:5.1f}%)  {bar}")

    results["regime_distribution"] = {
        k: {"count": int(v), "pct": float(regime_pct.get(k, 0))}
        for k, v in regime_counts.items()
    }

    # Greek distributions
    print("\n── Greek Distributions ──")
    for col in ["total_gex", "total_vex", "total_cex"]:
        vals = gex_df[col].dropna()
        stats = {
            "count": int(len(vals)),
            "mean": float(vals.mean()),
            "std": float(vals.std()),
            "min": float(vals.min()),
            "p5": float(vals.quantile(0.05)),
            "p25": float(vals.quantile(0.25)),
            "median": float(vals.median()),
            "p75": float(vals.quantile(0.75)),
            "p95": float(vals.quantile(0.95)),
            "max": float(vals.max()),
        }
        print(f"\n  {col}:")
        print(f"    Mean: {stats['mean']:>20,.0f}   Median: {stats['median']:>20,.0f}")
        print(f"    Std:  {stats['std']:>20,.0f}")
        print(f"    5th:  {stats['p5']:>20,.0f}   95th:   {stats['p95']:>20,.0f}")
        print(f"    Min:  {stats['min']:>20,.0f}   Max:    {stats['max']:>20,.0f}")
        results[f"{col}_stats"] = stats

    # Greek correlations
    print("\n── Greek Correlations ──")
    greeks = gex_df[["total_gex", "total_vex", "total_cex"]].dropna()
    corr = greeks.corr()
    print(f"  GEX ↔ VEX:  {corr.loc['total_gex', 'total_vex']:+.4f}")
    print(f"  GEX ↔ CEX:  {corr.loc['total_gex', 'total_cex']:+.4f}")
    print(f"  VEX ↔ CEX:  {corr.loc['total_vex', 'total_cex']:+.4f}")
    results["greek_correlations"] = {
        "gex_vex": float(corr.loc["total_gex", "total_vex"]),
        "gex_cex": float(corr.loc["total_gex", "total_cex"]),
        "vex_cex": float(corr.loc["total_vex", "total_cex"]),
    }

    # Greeks by regime
    print("\n── Greek Means by Regime ──")
    regime_means = gex_df.groupby("regime")[["total_gex", "total_vex", "total_cex"]].mean()
    regime_order = ["strong_negative", "negative", "neutral", "positive", "strong_positive"]
    regime_means = regime_means.reindex([r for r in regime_order if r in regime_means.index])
    print(f"  {'Regime':20s}  {'GEX':>18s}  {'VEX':>18s}  {'CEX':>18s}")
    print(f"  {'─' * 20}  {'─' * 18}  {'─' * 18}  {'─' * 18}")
    results["greek_means_by_regime"] = {}
    for regime in regime_means.index:
        row = regime_means.loc[regime]
        print(f"  {regime:20s}  {row['total_gex']:>18,.0f}  {row['total_vex']:>18,.0f}  {row['total_cex']:>18,.0f}")
        results["greek_means_by_regime"][regime] = {
            "gex": float(row["total_gex"]),
            "vex": float(row["total_vex"]),
            "cex": float(row["total_cex"]),
        }

    # Regime transitions
    print("\n── Regime Transitions ──")
    transitions = {}
    prev_regime = None
    for regime in gex_df["regime"]:
        if prev_regime is not None and regime != prev_regime:
            key = f"{prev_regime} → {regime}"
            transitions[key] = transitions.get(key, 0) + 1
        prev_regime = regime
    total_transitions = sum(transitions.values())
    print(f"  Total transitions: {total_transitions:,}")
    top_transitions = sorted(transitions.items(), key=lambda x: -x[1])[:10]
    for t, count in top_transitions:
        print(f"    {t:45s}  {count:5,}  ({count/total_transitions*100:.1f}%)")
    results["regime_transitions"] = {
        "total": total_transitions,
        "top_10": {t: int(c) for t, c in top_transitions},
    }

    # Regime persistence (average consecutive snapshots in same regime)
    print("\n── Regime Persistence ──")
    regime_runs = []
    current_regime = gex_df["regime"].iloc[0]
    run_length = 1
    for regime in gex_df["regime"].iloc[1:]:
        if regime == current_regime:
            run_length += 1
        else:
            regime_runs.append((current_regime, run_length))
            current_regime = regime
            run_length = 1
    regime_runs.append((current_regime, run_length))

    run_df = pd.DataFrame(regime_runs, columns=["regime", "run_length"])
    persistence = run_df.groupby("regime")["run_length"].agg(["mean", "median", "max", "count"])
    print(f"  {'Regime':20s}  {'Mean Run':>10s}  {'Median':>8s}  {'Max':>6s}  {'Runs':>6s}")
    results["regime_persistence"] = {}
    for regime in regime_order:
        if regime in persistence.index:
            row = persistence.loc[regime]
            # Convert to hours (15-min snapshots)
            mean_hrs = row["mean"] * 15 / 60
            med_hrs = row["median"] * 15 / 60
            max_hrs = row["max"] * 15 / 60
            print(f"  {regime:20s}  {mean_hrs:>8.1f}h  {med_hrs:>6.1f}h  {max_hrs:>5.0f}h  {int(row['count']):>6,}")
            results["regime_persistence"][regime] = {
                "mean_snapshots": float(row["mean"]),
                "mean_hours": round(mean_hrs, 2),
                "median_hours": round(med_hrs, 2),
                "max_hours": round(max_hrs, 2),
                "num_runs": int(row["count"]),
            }

    return results


# ── Q2: LT Level Dynamics Per Timeframe ───────────────────────────────────────

def analyze_lt_dynamics(lt_df, price_df, name, merge_tolerance="30min"):
    """Analyze LT level crossing frequency and lifespan for one timeframe."""
    print(f"\n── LT Dynamics: {name} ──")
    results = {}

    level_cols = ["level_1", "level_2", "level_3", "level_4", "level_5"]
    fib_labels = {
        "level_1": "fib-34",
        "level_2": "fib-55",
        "level_3": "fib-144",
        "level_4": "fib-377",
        "level_5": "fib-610",
    }

    # Merge price data onto LT timestamps via nearest-match
    lt = lt_df.copy()
    price = price_df[["timestamp", "close"]].copy()
    price = price.sort_values("timestamp")
    lt = lt.sort_values("timestamp")

    # Use merge_asof to get the closest price for each LT snapshot
    lt = pd.merge_asof(lt, price, on="timestamp", direction="nearest", tolerance=pd.Timedelta(merge_tolerance))
    lt = lt.dropna(subset=["close"])
    results["snapshots_with_price"] = int(len(lt))
    print(f"  Snapshots with price match: {len(lt):,} / {len(lt_df):,}")

    if len(lt) < 2:
        print("  Not enough data for crossing analysis")
        return results

    # Level crossing detection
    # A crossing occurs when a level moves from one side of price to the other
    crossing_counts = {col: 0 for col in level_cols}
    crossing_events = []

    for col in level_cols:
        above = lt[col].values > lt["close"].values  # True = level above price
        # Crossing = sign change between consecutive snapshots
        crossings = above[1:] != above[:-1]
        crossing_indices = np.where(crossings)[0]
        crossing_counts[col] = int(len(crossing_indices))

        for idx in crossing_indices:
            direction = "down_through" if above[idx] and not above[idx + 1] else "up_through"
            crossing_events.append({
                "timestamp": lt["timestamp"].iloc[idx + 1],
                "level": col,
                "fib": fib_labels[col],
                "direction": direction,
                "price": float(lt["close"].iloc[idx + 1]),
                "level_value": float(lt[col].iloc[idx + 1]),
            })

    total_crossings = sum(crossing_counts.values())
    days_in_range = (lt["timestamp"].max() - lt["timestamp"].min()).days
    print(f"\n  Level Crossings (total: {total_crossings:,} over {days_in_range} days)")
    print(f"  {'Level':10s}  {'Fib':8s}  {'Count':>7s}  {'Per Day':>8s}")
    results["crossings_per_level"] = {}
    for col in level_cols:
        per_day = crossing_counts[col] / max(days_in_range, 1)
        print(f"  {col:10s}  {fib_labels[col]:8s}  {crossing_counts[col]:>7,}  {per_day:>8.2f}")
        results["crossings_per_level"][fib_labels[col]] = {
            "count": crossing_counts[col],
            "per_day": round(per_day, 3),
        }

    # Crossing direction breakdown
    crossing_df = pd.DataFrame(crossing_events)
    if not crossing_df.empty:
        dir_counts = crossing_df.groupby(["fib", "direction"]).size().unstack(fill_value=0)
        print(f"\n  Crossing Direction Breakdown:")
        print(f"  {'Fib':10s}  {'Down Through':>14s}  {'Up Through':>12s}")
        results["crossing_directions"] = {}
        for fib in ["fib-34", "fib-55", "fib-144", "fib-377", "fib-610"]:
            if fib in dir_counts.index:
                down = int(dir_counts.loc[fib].get("down_through", 0))
                up = int(dir_counts.loc[fib].get("up_through", 0))
                print(f"  {fib:10s}  {down:>14,}  {up:>12,}")
                results["crossing_directions"][fib] = {"down_through": down, "up_through": up}

    # Level proximity to price distribution
    print(f"\n  Level Proximity to Price:")
    print(f"  {'Level':10s}  {'Fib':8s}  {'Mean Dist':>10s}  {'Med Dist':>10s}  {'Within 0.1%':>12s}")
    results["proximity"] = {}
    for col in level_cols:
        dist = ((lt[col] - lt["close"]) / lt["close"] * 100).abs()
        within_01 = (dist < 0.1).sum()
        pct_within = within_01 / len(dist) * 100
        print(f"  {col:10s}  {fib_labels[col]:8s}  {dist.mean():>9.3f}%  {dist.median():>9.3f}%  {pct_within:>10.2f}%")
        results["proximity"][fib_labels[col]] = {
            "mean_distance_pct": round(float(dist.mean()), 4),
            "median_distance_pct": round(float(dist.median()), 4),
            "within_01_pct": round(float(pct_within), 3),
        }

    # Level lifespan (how long before a level moves significantly)
    # Define "significant move" as the level changing by more than 0.1% between snapshots
    print(f"\n  Level Stability (% change between consecutive snapshots):")
    results["stability"] = {}
    for col in level_cols:
        pct_change = lt[col].pct_change().abs() * 100
        pct_change = pct_change.dropna()
        stable = (pct_change < 0.05).sum()  # less than 0.05% change
        print(f"  {fib_labels[col]:10s}  Mean Δ: {pct_change.mean():.4f}%  Stable (<0.05%): {stable/len(pct_change)*100:.1f}%")
        results["stability"][fib_labels[col]] = {
            "mean_change_pct": round(float(pct_change.mean()), 5),
            "stable_pct": round(float(stable / len(pct_change) * 100), 2),
        }

    # Sentiment distribution
    sent_counts = lt_df["sentiment"].value_counts()
    results["sentiment"] = {k: int(v) for k, v in sent_counts.items()}
    print(f"\n  Sentiment: {dict(sent_counts)}")

    return results


# ── Q3: LT Sentiment Alignment Across Timeframes ─────────────────────────────

def analyze_lt_alignment(lt_daily, lt_hourly, lt_15m):
    """Check when the three LT timeframes agree/disagree on sentiment."""
    print("\n" + "=" * 80)
    print("Q3: LT SENTIMENT ALIGNMENT ACROSS TIMEFRAMES")
    print("=" * 80)
    results = {}

    # Align timestamps: use hourly as the reference, merge daily + 15m onto it
    # For daily: forward-fill to each hour within the day
    # For 15m: take the most recent reading before each hour

    hourly = lt_hourly[["timestamp", "sentiment"]].copy().rename(columns={"sentiment": "hourly_sentiment"})
    hourly = hourly.sort_values("timestamp")

    # Daily: each daily reading applies to the next 24 hours
    daily = lt_daily[["timestamp", "sentiment"]].copy().rename(columns={"sentiment": "daily_sentiment"})
    daily = daily.sort_values("timestamp")

    # 15m: take the last reading at or before each hourly timestamp
    m15 = lt_15m[["timestamp", "sentiment"]].copy().rename(columns={"sentiment": "m15_sentiment"})
    m15 = m15.sort_values("timestamp")

    # Merge daily onto hourly (forward fill)
    merged = pd.merge_asof(hourly, daily, on="timestamp", direction="backward", tolerance=pd.Timedelta("2D"))
    # Merge 15m onto hourly
    merged = pd.merge_asof(merged, m15, on="timestamp", direction="backward", tolerance=pd.Timedelta("30min"))
    merged = merged.dropna()

    print(f"\n  Aligned timestamps: {len(merged):,}")

    if merged.empty:
        return results

    # Agreement analysis
    merged["all_agree"] = (
        (merged["daily_sentiment"] == merged["hourly_sentiment"]) &
        (merged["hourly_sentiment"] == merged["m15_sentiment"])
    )
    merged["daily_hourly_agree"] = merged["daily_sentiment"] == merged["hourly_sentiment"]
    merged["hourly_15m_agree"] = merged["hourly_sentiment"] == merged["m15_sentiment"]
    merged["daily_15m_agree"] = merged["daily_sentiment"] == merged["m15_sentiment"]

    all_agree_pct = merged["all_agree"].mean() * 100
    dh_agree_pct = merged["daily_hourly_agree"].mean() * 100
    h15_agree_pct = merged["hourly_15m_agree"].mean() * 100
    d15_agree_pct = merged["daily_15m_agree"].mean() * 100

    print(f"\n  ── Sentiment Agreement ──")
    print(f"  All 3 agree:          {all_agree_pct:5.1f}%")
    print(f"  Daily ↔ Hourly:       {dh_agree_pct:5.1f}%")
    print(f"  Hourly ↔ 15m:         {h15_agree_pct:5.1f}%")
    print(f"  Daily ↔ 15m:          {d15_agree_pct:5.1f}%")

    results["agreement_rates"] = {
        "all_three": round(all_agree_pct, 2),
        "daily_hourly": round(dh_agree_pct, 2),
        "hourly_15m": round(h15_agree_pct, 2),
        "daily_15m": round(d15_agree_pct, 2),
    }

    # Breakdown by combination
    combo = merged.groupby(["daily_sentiment", "hourly_sentiment", "m15_sentiment"]).size()
    combo_pct = (combo / len(merged) * 100).round(2)
    print(f"\n  ── Sentiment Combinations ──")
    print(f"  {'Daily':10s}  {'Hourly':10s}  {'15m':10s}  {'Count':>8s}  {'Pct':>6s}")
    results["combinations"] = {}
    for (d, h, m), count in combo.sort_values(ascending=False).items():
        pct = float(combo_pct.loc[(d, h, m)])
        print(f"  {d:10s}  {h:10s}  {m:10s}  {count:>8,}  {pct:>5.1f}%")
        results["combinations"][f"{d}_{h}_{m}"] = {"count": int(count), "pct": pct}

    # Alignment persistence — how long do all-agree streaks last?
    print(f"\n  ── All-Agree Streak Duration ──")
    streaks = []
    current_streak = 0
    current_agree = merged["all_agree"].iloc[0]
    for agree in merged["all_agree"]:
        if agree == current_agree:
            current_streak += 1
        else:
            if current_agree:
                streaks.append(current_streak)
            current_streak = 1
            current_agree = agree
    if current_agree:
        streaks.append(current_streak)

    if streaks:
        streaks_arr = np.array(streaks)
        print(f"  Mean streak: {streaks_arr.mean():.1f} hours  "
              f"Median: {np.median(streaks_arr):.0f}h  "
              f"Max: {streaks_arr.max()}h  "
              f"Num streaks: {len(streaks)}")
        results["agree_streaks"] = {
            "mean_hours": round(float(streaks_arr.mean()), 2),
            "median_hours": float(np.median(streaks_arr)),
            "max_hours": int(streaks_arr.max()),
            "num_streaks": len(streaks),
        }

    # Sentiment flip detection: when does a timeframe flip while others don't?
    print(f"\n  ── Sentiment Flips (one TF flips, others stay) ──")
    flip_counts = {"daily_only": 0, "hourly_only": 0, "m15_only": 0, "multiple": 0}
    for i in range(1, len(merged)):
        d_flip = merged["daily_sentiment"].iloc[i] != merged["daily_sentiment"].iloc[i - 1]
        h_flip = merged["hourly_sentiment"].iloc[i] != merged["hourly_sentiment"].iloc[i - 1]
        m_flip = merged["m15_sentiment"].iloc[i] != merged["m15_sentiment"].iloc[i - 1]
        num_flips = d_flip + h_flip + m_flip
        if num_flips == 1:
            if d_flip:
                flip_counts["daily_only"] += 1
            elif h_flip:
                flip_counts["hourly_only"] += 1
            else:
                flip_counts["m15_only"] += 1
        elif num_flips > 1:
            flip_counts["multiple"] += 1

    total_flips = sum(flip_counts.values())
    print(f"  Total flip events: {total_flips:,}")
    for k, v in flip_counts.items():
        pct = v / max(total_flips, 1) * 100
        print(f"    {k:15s}  {v:6,}  ({pct:.1f}%)")
    results["flip_events"] = flip_counts

    return results


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    print("=" * 80)
    print("ES CROSS-SIGNAL EXPLORATION — PHASE 1")
    print(f"Analysis window: {START_DATE.date()} → {END_DATE.date()}")
    print("=" * 80)

    all_results = {"analysis_window": {"start": str(START_DATE.date()), "end": str(END_DATE.date())}}

    # Load data
    gex_df = load_gex_data()
    lt_daily = load_lt_data(LT_DAILY, "Daily")
    lt_hourly = load_lt_data(LT_HOURLY, "Hourly")
    lt_15m = load_lt_data(LT_15M, "15-min")
    ohlcv_15m = load_ohlcv_15m()

    # Q1: GEX regime distribution and Greek correlations
    all_results["q1_gex_regimes"] = analyze_gex_regimes(gex_df)

    # Q2: LT level dynamics per timeframe
    print("\n" + "=" * 80)
    print("Q2: LT LEVEL DYNAMICS PER TIMEFRAME")
    print("=" * 80)

    # For daily LT, we need daily price (resample OHLCV to daily)
    ohlcv_daily = ohlcv_15m.copy()
    ohlcv_daily = ohlcv_daily.set_index("timestamp").resample("1D").agg({
        "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
    }).dropna(subset=["close"]).reset_index()

    # For hourly LT, resample OHLCV to hourly
    ohlcv_hourly = ohlcv_15m.copy()
    ohlcv_hourly = ohlcv_hourly.set_index("timestamp").resample("1h").agg({
        "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
    }).dropna(subset=["close"]).reset_index()

    all_results["q2_lt_dynamics_daily"] = analyze_lt_dynamics(lt_daily, ohlcv_daily, "Daily", merge_tolerance="12h")
    all_results["q2_lt_dynamics_hourly"] = analyze_lt_dynamics(lt_hourly, ohlcv_hourly, "Hourly")
    all_results["q2_lt_dynamics_15m"] = analyze_lt_dynamics(lt_15m, ohlcv_15m, "15-min")

    # Q3: LT sentiment alignment across timeframes
    all_results["q3_lt_alignment"] = analyze_lt_alignment(lt_daily, lt_hourly, lt_15m)

    # Save results
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_file = OUTPUT_DIR / "phase1_results.json"
    with open(output_file, "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\n\nResults saved to {output_file}")
    print("Done.")


if __name__ == "__main__":
    main()
