#!/usr/bin/env python3
"""
ES Signal Overlap Analysis

How much do the top Phase 2 signals overlap in time?
- LT crossings (down_through / up_through) conditioned on GEX regime
- GEX regime transitions (improving / deteriorating)

Key questions:
1. What % of regime transitions have an LT crossing within the same window?
2. What % of LT crossings coincide with a regime transition?
3. When they co-occur, are returns better/worse than either alone?
4. Could these be unified into a single strategy with a composite score?
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent / "backtest-engine" / "data"
GEX_DIR = BASE_DIR / "gex" / "es"
LT_15M = BASE_DIR / "liquidity" / "es" / "ES_liquidity_levels_15m.csv"
OHLCV_FILE = BASE_DIR / "ohlcv" / "es" / "ES_ohlcv_1m_continuous.csv"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "skunkworks" / "es exploration"

START_DATE = pd.Timestamp("2023-03-28", tz="UTC")
END_DATE = pd.Timestamp("2026-01-27", tz="UTC")

FORWARD_HORIZONS = {"5min": 5, "15min": 15, "1hr": 60, "4hr": 240}


def classify_session(ts):
    et = ts.tz_convert("America/New_York")
    t = et.hour * 60 + et.minute
    if 570 <= t < 960:
        return "rth"
    elif t >= 1080 or t < 570:
        return "overnight"
    else:
        return "afterhours"


def load_gex():
    print("Loading GEX...")
    files = sorted(GEX_DIR.glob("es_gex_*.json"))
    rows = []
    for f in files:
        ds = f.stem.replace("es_gex_", "")
        if ds < "2023-03-28" or ds > "2026-01-27":
            continue
        with open(f) as fh:
            data = json.load(fh)
        for snap in data.get("data", []):
            rows.append({
                "timestamp": pd.Timestamp(snap["timestamp"]),
                "es_spot": snap.get("es_spot"),
                "regime": snap.get("regime"),
                "total_gex": snap.get("total_gex"),
            })
    df = pd.DataFrame(rows)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df.sort_values("timestamp").reset_index(drop=True)


def load_lt():
    print("Loading LT 15m...")
    df = pd.read_csv(LT_15M)
    df["timestamp"] = pd.to_datetime(df["unix_timestamp"], unit="ms", utc=True)
    df = df[(df["timestamp"] >= START_DATE) & (df["timestamp"] <= END_DATE)]
    return df.sort_values("timestamp").reset_index(drop=True)


def load_ohlcv():
    print("Loading continuous OHLCV...")
    df = pd.read_csv(OHLCV_FILE, usecols=["ts_event", "close"], dtype={"close": float})
    df["ts_event"] = pd.to_datetime(df["ts_event"], utc=True)
    df = df[(df["ts_event"] >= START_DATE) & (df["ts_event"] <= END_DATE)]
    df = df.set_index("ts_event").sort_index()
    df = df[~df.index.duplicated(keep="first")]
    return df


def build_forward_returns(ohlcv):
    close = ohlcv["close"]
    fwd = pd.DataFrame(index=close.index)
    for label, minutes in FORWARD_HORIZONS.items():
        fwd[f"fwd_{label}_pts"] = close.shift(-minutes) - close
    return fwd


def get_fwd(timestamps, fwd_df):
    rounded = timestamps.round("min")
    matched = fwd_df.reindex(rounded)
    matched.index = timestamps
    return matched


def summarize(fwd_returns, label=""):
    stats = {}
    for horizon in FORWARD_HORIZONS:
        col = f"fwd_{horizon}_pts"
        vals = fwd_returns[col].dropna()
        if len(vals) < 5:
            continue
        stats[horizon] = {
            "n": int(len(vals)),
            "mean": round(float(vals.mean()), 2),
            "median": round(float(vals.median()), 2),
            "win_pct": round(float((vals > 0).mean() * 100), 1),
        }
    return stats


def print_stats(stats, indent="    "):
    if not stats:
        print(f"{indent}(insufficient data)")
        return
    print(f"{indent}{'Horizon':>8s}  {'N':>6s}  {'Mean':>8s}  {'Median':>8s}  {'Win%':>6s}")
    for h, s in stats.items():
        print(f"{indent}{h:>8s}  {s['n']:>6,}  {s['mean']:>+8.2f}  {s['median']:>+8.2f}  {s['win_pct']:>5.1f}%")


def main():
    gex = load_gex()
    lt = load_lt()
    ohlcv = load_ohlcv()
    fwd_df = build_forward_returns(ohlcv)

    # ── Build LT crossing events ──────────────────────────────────────────
    print("Detecting LT crossings...")
    level_cols = ["level_1", "level_2", "level_3", "level_4", "level_5"]
    fib_labels = {"level_1": "fib-34", "level_2": "fib-55", "level_3": "fib-144",
                  "level_4": "fib-377", "level_5": "fib-610"}

    # Merge GEX regime onto LT
    gex_slim = gex[["timestamp", "regime", "es_spot"]].copy().sort_values("timestamp")
    lt_merged = pd.merge_asof(lt.sort_values("timestamp"), gex_slim,
                              on="timestamp", direction="nearest",
                              tolerance=pd.Timedelta("16min"))
    lt_merged = lt_merged.dropna(subset=["regime", "es_spot"])
    lt_merged["price"] = lt_merged["es_spot"]

    crossing_events = []
    for col in level_cols:
        above = lt_merged[col].values > lt_merged["price"].values
        crossings = above[1:] != above[:-1]
        for idx in np.where(crossings)[0]:
            direction = "down_through" if above[idx] and not above[idx + 1] else "up_through"
            crossing_events.append({
                "timestamp": lt_merged["timestamp"].iloc[idx + 1],
                "fib": fib_labels[col],
                "direction": direction,
                "price": float(lt_merged["price"].iloc[idx + 1]),
                "regime": lt_merged["regime"].iloc[idx + 1],
            })

    cx_df = pd.DataFrame(crossing_events).sort_values("timestamp").reset_index(drop=True)

    # Collapse regime to group
    regime_map = {"strong_positive": "positive", "positive": "positive",
                  "neutral": "neutral", "negative": "negative", "strong_negative": "negative"}
    cx_df["regime_group"] = cx_df["regime"].map(regime_map)

    # Tag the signal type
    cx_df["signal"] = cx_df["direction"] + "_" + cx_df["regime_group"]
    cx_df["session"] = cx_df["timestamp"].apply(classify_session)

    # ── Build regime transition events ────────────────────────────────────
    print("Detecting regime transitions...")
    regime_rank = {"strong_negative": -2, "negative": -1, "neutral": 0,
                   "positive": 1, "strong_positive": 2}
    tx_events = []
    for i in range(1, len(gex)):
        prev = gex["regime"].iloc[i - 1]
        curr = gex["regime"].iloc[i]
        if prev != curr:
            tx_events.append({
                "timestamp": gex["timestamp"].iloc[i],
                "price": gex["es_spot"].iloc[i],
                "from_regime": prev,
                "to_regime": curr,
                "direction": "improving" if regime_rank[curr] > regime_rank[prev] else "deteriorating",
            })
    tx_df = pd.DataFrame(tx_events).sort_values("timestamp").reset_index(drop=True)
    tx_df["session"] = tx_df["timestamp"].apply(classify_session)

    total_days = (gex["timestamp"].max() - gex["timestamp"].min()).days

    print(f"\n  LT crossing events: {len(cx_df):,} ({len(cx_df)/total_days:.1f}/day)")
    print(f"  Regime transitions:  {len(tx_df):,} ({len(tx_df)/total_days:.1f}/day)")

    # ── Overlap analysis ──────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("SIGNAL OVERLAP ANALYSIS")
    print("=" * 80)

    # For each regime transition, check if there's a directionally-aligned
    # LT crossing within various time windows
    for window_min in [15, 30, 60]:
        window = pd.Timedelta(minutes=window_min)
        match_count = 0
        both_events = []

        for _, tx in tx_df.iterrows():
            ts = tx["timestamp"]
            tx_dir = tx["direction"]

            # Find LT crossings within window
            nearby = cx_df[(cx_df["timestamp"] >= ts - window) &
                           (cx_df["timestamp"] <= ts + window)]

            if tx_dir == "improving":
                aligned = nearby[nearby["direction"] == "down_through"]
            else:
                aligned = nearby[nearby["direction"] == "up_through"]

            if len(aligned) > 0:
                match_count += 1
                both_events.append({
                    "timestamp": ts,
                    "tx_direction": tx_dir,
                    "lt_crossings": len(aligned),
                    "session": tx["session"],
                })

        pct = match_count / len(tx_df) * 100
        print(f"\n  ±{window_min}min window: {match_count}/{len(tx_df)} "
              f"transitions ({pct:.1f}%) have aligned LT crossing")

    # Detailed overlap with ±15min (tightest meaningful window for 15m data)
    print(f"\n{'='*80}")
    print(f"DETAILED OVERLAP (±15min window)")
    print(f"{'='*80}")

    window = pd.Timedelta(minutes=15)
    composite_events = []

    for _, tx in tx_df.iterrows():
        ts = tx["timestamp"]
        tx_dir = tx["direction"]
        nearby = cx_df[(cx_df["timestamp"] >= ts - window) &
                       (cx_df["timestamp"] <= ts + window)]

        if tx_dir == "improving":
            aligned = nearby[nearby["direction"] == "down_through"]
            contrary = nearby[nearby["direction"] == "up_through"]
        else:
            aligned = nearby[nearby["direction"] == "up_through"]
            contrary = nearby[nearby["direction"] == "down_through"]

        composite_events.append({
            "timestamp": ts,
            "price": tx["price"],
            "tx_direction": tx_dir,
            "session": tx["session"],
            "aligned_lt_count": len(aligned),
            "contrary_lt_count": len(contrary),
            "has_aligned_lt": len(aligned) > 0,
            "has_contrary_lt": len(contrary) > 0,
            "high_fib_aligned": len(aligned[aligned["fib"].isin(["fib-144", "fib-377", "fib-610"])]) if len(aligned) > 0 else 0,
        })

    comp_df = pd.DataFrame(composite_events)

    # Get forward returns
    comp_fwd = get_fwd(comp_df["timestamp"], fwd_df)
    comp_df = comp_df.set_index("timestamp").join(comp_fwd)

    # ── Category: transition ONLY (no aligned LT crossing) ──
    tx_only = comp_df[~comp_df["has_aligned_lt"]]
    tx_with_lt = comp_df[comp_df["has_aligned_lt"]]

    print(f"\n  Transitions WITH aligned LT crossing:    {len(tx_with_lt):,} ({len(tx_with_lt)/len(comp_df)*100:.1f}%)")
    print(f"  Transitions WITHOUT aligned LT crossing: {len(tx_only):,} ({len(tx_only)/len(comp_df)*100:.1f}%)")

    # Split by direction
    for direction in ["improving", "deteriorating"]:
        subset_both = tx_with_lt[tx_with_lt["tx_direction"] == direction]
        subset_tx_only = tx_only[tx_only["tx_direction"] == direction]

        print(f"\n  ── {direction.upper()} ──")

        print(f"\n    Transition + aligned LT crossing (n={len(subset_both):,}):")
        print_stats(summarize(subset_both), indent="      ")

        print(f"\n    Transition only, no LT crossing (n={len(subset_tx_only):,}):")
        print_stats(summarize(subset_tx_only), indent="      ")

    # ── Now check from the LT crossing side ──
    print(f"\n{'='*80}")
    print(f"FROM THE LT CROSSING SIDE")
    print(f"{'='*80}")

    lt_composite = []
    for _, cx in cx_df.iterrows():
        ts = cx["timestamp"]
        nearby_tx = tx_df[(tx_df["timestamp"] >= ts - window) &
                          (tx_df["timestamp"] <= ts + window)]

        if cx["direction"] == "down_through":
            aligned_tx = nearby_tx[nearby_tx["direction"] == "improving"]
        else:
            aligned_tx = nearby_tx[nearby_tx["direction"] == "deteriorating"]

        lt_composite.append({
            "timestamp": ts,
            "direction": cx["direction"],
            "regime_group": cx["regime_group"],
            "fib": cx["fib"],
            "session": cx["session"],
            "has_aligned_tx": len(aligned_tx) > 0,
        })

    lt_comp = pd.DataFrame(lt_composite)
    lt_fwd = get_fwd(lt_comp["timestamp"], fwd_df)
    lt_comp = lt_comp.set_index("timestamp").join(lt_fwd)

    for direction in ["down_through", "up_through"]:
        for regime in ["negative", "positive"]:
            subset = lt_comp[(lt_comp["direction"] == direction) &
                             (lt_comp["regime_group"] == regime)]
            with_tx = subset[subset["has_aligned_tx"]]
            without_tx = subset[~subset["has_aligned_tx"]]

            if len(with_tx) < 10 and len(without_tx) < 10:
                continue

            print(f"\n  ── {direction} + {regime} GEX ──")
            print(f"    With regime transition (n={len(with_tx):,}):")
            print_stats(summarize(with_tx), indent="      ")
            print(f"    Without regime transition (n={len(without_tx):,}):")
            print_stats(summarize(without_tx), indent="      ")

    # ── Composite score approach ──────────────────────────────────────────
    print(f"\n{'='*80}")
    print(f"COMPOSITE SIGNAL SCORING")
    print(f"{'='*80}")
    print(f"\n  Scoring each 15-min window: +1 for each bullish signal, -1 for bearish")
    print(f"  Signals: LT down_through (+1), LT up_through (-1), ")
    print(f"           regime improving (+1), regime deteriorating (-1)")

    # Build a 15-min timeline and assign composite scores
    all_timestamps = pd.date_range(START_DATE, END_DATE, freq="15min", tz="UTC")
    timeline = pd.DataFrame({"timestamp": all_timestamps})
    timeline["score"] = 0

    # Score LT crossings
    for _, cx in cx_df.iterrows():
        ts_rounded = cx["timestamp"].round("15min")
        mask = timeline["timestamp"] == ts_rounded
        if cx["direction"] == "down_through":
            timeline.loc[mask, "score"] += 1
        else:
            timeline.loc[mask, "score"] -= 1

    # Score regime transitions
    for _, tx in tx_df.iterrows():
        ts_rounded = tx["timestamp"].round("15min")
        mask = timeline["timestamp"] == ts_rounded
        if tx["direction"] == "improving":
            timeline.loc[mask, "score"] += 1
        else:
            timeline.loc[mask, "score"] -= 1

    # Add regime context
    gex_regime = gex[["timestamp", "regime"]].copy()
    gex_regime = gex_regime.sort_values("timestamp")
    timeline = pd.merge_asof(timeline.sort_values("timestamp"),
                             gex_regime, on="timestamp",
                             direction="backward")

    timeline["regime_group"] = timeline["regime"].map(regime_map)
    timeline["session"] = timeline["timestamp"].apply(classify_session)

    # Forward returns for scored windows
    timeline_fwd = get_fwd(timeline["timestamp"], fwd_df)
    timeline = timeline.set_index("timestamp").join(timeline_fwd)

    # Filter to non-zero scores (signal windows)
    signals = timeline[timeline["score"] != 0]
    print(f"\n  Windows with any signal: {len(signals):,} / {len(timeline):,} "
          f"({len(signals)/len(timeline)*100:.1f}%)")

    score_dist = signals["score"].value_counts().sort_index()
    print(f"\n  Score distribution:")
    for score, count in score_dist.items():
        print(f"    Score {score:+d}: {count:>6,}")

    # Returns by score
    print(f"\n  ── Forward Returns by Composite Score ──")
    for score in sorted(signals["score"].unique()):
        subset = signals[signals["score"] == score]
        if len(subset) < 20:
            continue
        stats = summarize(subset)
        print(f"\n    Score {score:+d} (n={len(subset):,}):")
        print_stats(stats, indent="      ")

    # Strong signals: |score| >= 2
    print(f"\n  ── Strong Signals (|score| >= 2) ──")
    strong_long = signals[signals["score"] >= 2]
    strong_short = signals[signals["score"] <= -2]

    if len(strong_long) >= 10:
        print(f"\n    Strong LONG (score >= +2, n={len(strong_long):,}, "
              f"{len(strong_long)/total_days:.1f}/day):")
        print_stats(summarize(strong_long), indent="      ")

    if len(strong_short) >= 10:
        print(f"\n    Strong SHORT (score <= -2, n={len(strong_short):,}, "
              f"{len(strong_short)/total_days:.1f}/day):")
        print_stats(summarize(strong_short), indent="      ")

    # Strong signals by regime
    print(f"\n  ── Strong Signals by GEX Regime ──")
    for regime in ["positive", "negative", "neutral"]:
        long_r = strong_long[strong_long["regime_group"] == regime]
        short_r = strong_short[strong_short["regime_group"] == regime]
        if len(long_r) >= 10:
            print(f"\n    Strong LONG + {regime} GEX (n={len(long_r):,}):")
            print_stats(summarize(long_r), indent="      ")
        if len(short_r) >= 10:
            print(f"\n    Strong SHORT + {regime} GEX (n={len(short_r):,}):")
            print_stats(summarize(short_r), indent="      ")

    # Strong signals by session
    print(f"\n  ── Strong Signals by Session ──")
    for session in ["rth", "overnight"]:
        long_s = strong_long[strong_long["session"] == session]
        short_s = strong_short[strong_short["session"] == session]
        if len(long_s) >= 10:
            print(f"\n    Strong LONG + {session} (n={len(long_s):,}):")
            print_stats(summarize(long_s), indent="      ")
        if len(short_s) >= 10:
            print(f"\n    Strong SHORT + {session} (n={len(short_s):,}):")
            print_stats(summarize(short_s), indent="      ")

    # ── Timing distribution ───────────────────────────────────────────────
    print(f"\n{'='*80}")
    print(f"SIGNAL TIMING DISTRIBUTION (hour of day, ET)")
    print(f"{'='*80}")

    strong_all = signals[signals["score"].abs() >= 2]
    if len(strong_all) > 0:
        strong_all_reset = strong_all.reset_index()
        strong_all_reset["hour_et"] = strong_all_reset["timestamp"].dt.tz_convert(
            "America/New_York").dt.hour
        hour_dist = strong_all_reset["hour_et"].value_counts().sort_index()
        print(f"\n  Strong signals (|score| >= 2) by hour (ET):")
        for hour, count in hour_dist.items():
            bar = "█" * (count // 5)
            print(f"    {hour:02d}:00  {count:>5,}  {bar}")

    # Save results
    results = {
        "overlap_rates": {},
        "composite_score_dist": {str(k): int(v) for k, v in score_dist.items()},
    }
    output_file = OUTPUT_DIR / "signal_overlap_results.json"
    with open(output_file, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\nResults saved to {output_file}")


if __name__ == "__main__":
    main()
