#!/usr/bin/env python3
"""
Generate Intraday GEX JSON Files (15-minute snapshots)

Uses daily statistics (OI + close prices) + intraday OHLCV (spot prices) to create
15-minute GEX snapshots for backtesting.

Methodology matches gex-engine/src/gex/gex_calculator.py:
- Uses Brenner-Subrahmanyam IV approximation from close prices
- Calculates gamma, vega, charm per contract
- Aggregates to strike-level GEX/VEX/CEX

Supports both NQ (from QQQ options) and ES (from SPY options).

Usage:
    # NQ (default, backward compatible)
    python generate-intraday-gex.py --start 2025-12-29 --end 2026-01-28

    # ES
    python generate-intraday-gex.py --product es --start 2023-03-28 --end 2026-01-28
"""

import os
import sys
import json
import argparse
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path
from scipy.stats import norm
import subprocess

# Base data directory
BASE_DIR = Path('/home/drew/projects/slingshot-services/backtest-engine/data')

# Product configurations: options ETF -> futures contract
PRODUCTS = {
    'nq': {
        'futures_symbol': 'NQ',
        'etf_symbol': 'QQQ',
        'stats_dir': BASE_DIR / 'statistics' / 'qqq',
        'cbbo_dir': BASE_DIR / 'cbbo-1m' / 'qqq',
        'etf_ohlcv': BASE_DIR / 'ohlcv' / 'qqq' / 'QQQ_ohlcv_1m.csv',
        'futures_ohlcv': BASE_DIR / 'ohlcv' / 'nq' / 'NQ_ohlcv_1m.csv',
        'output_dir': BASE_DIR / 'gex' / 'nq',
        'output_dir_cbbo': BASE_DIR / 'gex' / 'nq-cbbo',
        'output_prefix': 'nq_gex',
    },
    'es': {
        'futures_symbol': 'ES',
        'etf_symbol': 'SPY',
        'stats_dir': BASE_DIR / 'statistics' / 'spy',
        'cbbo_dir': BASE_DIR / 'cbbo-1m' / 'spy',
        'etf_ohlcv': BASE_DIR / 'ohlcv' / 'spy' / 'SPY_ohlcv_1m.csv',
        'futures_ohlcv': BASE_DIR / 'ohlcv' / 'es' / 'ES_ohlcv_1m.csv',
        'output_dir': BASE_DIR / 'gex' / 'es',
        'output_dir_cbbo': BASE_DIR / 'gex' / 'es-cbbo',
        'output_prefix': 'es_gex',
    },
}

# Constants
RISK_FREE_RATE = 0.05
DEFAULT_IV = 0.20


def implied_vol_approx(price, S, K, T, opt_type):
    """
    Approximate IV using Brenner-Subrahmanyam method.
    Good enough for GEX ranking, not for trading options directly.
    """
    if T <= 0 or price <= 0:
        return DEFAULT_IV
    intrinsic = max(0, S - K) if opt_type == 'C' else max(0, K - S)
    time_value = price - intrinsic
    if time_value <= 0:
        return 0.05  # Minimal IV for no time value
    iv = (time_value / S) * np.sqrt(2 * np.pi / T)
    return max(0.05, min(2.0, iv))  # Clamp between 5% and 200%


def load_statistics(stats_dir, date_str):
    """Load statistics file for a date, return OI and close prices per contract."""
    csv_path = stats_dir / f'opra-pillar-{date_str.replace("-", "")}.statistics.csv'

    if not csv_path.exists():
        return None

    df = pd.read_csv(csv_path)

    # Extract OI (stat_type 9) and close prices (stat_type 11)
    oi_data = df[df['stat_type'] == 9].groupby('symbol')['quantity'].max().reset_index()
    close_data = df[df['stat_type'] == 11].groupby('symbol')['price'].max().reset_index()

    # Merge OI and close prices - use inner join (require both OI and close price)
    # This matches gex_calculator.py methodology
    merged = oi_data.merge(close_data, on='symbol', how='inner')
    merged.columns = ['symbol', 'oi', 'close_price']

    # Filter out zero/negative close prices
    merged = merged[merged['close_price'] > 0]

    if merged.empty:
        return None

    # Vectorized symbol parsing
    # Format: "QQQ   YYMMDDTSSSSSSSS" or "SPY   YYMMDDTSSSSSSSS" where T is C/P
    symbols = merged['symbol'].str.strip()
    contracts = symbols.str.split().str[-1]

    # Parse expiry (first 6 chars), type (7th char), strike (rest / 1000)
    merged['expiry'] = pd.to_datetime('20' + contracts.str[:6], format='%Y%m%d', errors='coerce')
    merged['type'] = contracts.str[6]
    merged['strike'] = contracts.str[7:].astype(float) / 1000

    # Filter valid rows - require OI > 0 and valid close_price
    merged = merged[merged['expiry'].notna() & (merged['oi'] > 0) & (merged['close_price'] > 0)]

    # Keep raw OPRA symbol so the cbbo IV path can override close_price by symbol lookup.
    return merged[['symbol', 'strike', 'type', 'expiry', 'oi', 'close_price']].copy()


def load_cbbo_buckets(cbbo_dir, date_str, interval_minutes=15):
    """
    Load cbbo-1m for a date and bucket by interval. Returns dict
    {bucket_key: {symbol: mid_price}} where bucket_key matches the iso-format
    string produced by load_ohlcv_for_date for the same minute.

    Bucket key format: 'YYYY-MM-DDTHH:MM:00+00:00' (UTC, matches pandas
    .isoformat() output for tz-aware Timestamps).

    cbbo-1m emits a row only when the BBO changes, so a stable quote may have
    no fresh row in later minutes. We forward-fill across buckets: each bucket's
    dict is a snapshot of every contract's most-recently-seen quote up through
    the end of that bucket's interval. Stale-but-known quotes beat fallback to
    EOD close.

    Filters: bid > 0, ask > 0, ask >= bid, spread <= 50% of bid (matches
    generate-cbbo-gex.js reference).
    """
    import csv as csv_mod

    base_name = f'opra-pillar-{date_str.replace("-", "")}'
    candidates = [
        cbbo_dir / f'{base_name}.cbbo-1m.csv',
        cbbo_dir / f'{base_name}.cbbo-1m.0000.csv',
    ]
    csv_path = next((p for p in candidates if p.exists()), None)
    if csv_path is None:
        return None

    # Streaming pass: maintain running latest-quote-per-symbol map. Whenever we
    # cross a bucket boundary, snapshot the running map as the just-finished
    # bucket's quotes. Snapshots are independent dicts so later updates don't
    # leak backwards into earlier buckets.
    #
    # Bucket on `ts_recv` (the row's publication minute), NOT `ts_event`. The
    # cbbo-1m file is sorted by ts_recv (monotonic), but ts_event can lag by
    # hours — a row published at ts_recv=20:14 may report a ts_event=13:58
    # quote. Bucketing on ts_event puts late-arriving rows into earlier buckets
    # AFTER those buckets were already snapshotted, contaminating their final
    # state with quotes from much later in the day. Using ts_recv keeps each
    # bucket's snapshot causal: bucket "13:45" only contains quotes published
    # in that 15-min window, never future data.
    buckets = {}
    running = {}
    current_bucket_key = None

    def snapshot_bucket(key):
        if key is not None and running:
            buckets[key] = dict(running)

    with open(csv_path, newline='') as f:
        reader = csv_mod.DictReader(f)
        for row in reader:
            # Use ts_recv (the row's publication minute) for bucketing — see
            # comment above. ts_event is the actual quote time and can lag.
            ts_str = row.get('ts_recv') or ''
            if len(ts_str) < 16:
                continue
            try:
                bid_raw = row.get('bid_px_00') or ''
                ask_raw = row.get('ask_px_00') or ''
                if not bid_raw or not ask_raw:
                    continue
                bid = float(bid_raw)
                ask = float(ask_raw)
            except ValueError:
                continue
            if bid <= 0 or ask <= 0 or ask < bid:
                continue
            if (ask - bid) / bid > 0.5:
                continue

            mid = (bid + ask) / 2
            sym = row.get('symbol') or ''
            if not sym:
                continue

            # Manual ISO parse — pd.to_datetime per row would be 100x slower.
            # ts_str format: "2026-04-27T13:30:00.000000000Z"
            date_part = ts_str[:10]
            hour = ts_str[11:13]
            try:
                minute = int(ts_str[14:16])
            except ValueError:
                continue
            bucket_minute = (minute // interval_minutes) * interval_minutes
            bucket_key = f'{date_part}T{hour}:{bucket_minute:02d}:00+00:00'

            if current_bucket_key is None:
                current_bucket_key = bucket_key
            elif bucket_key != current_bucket_key:
                # Closed out a bucket — snapshot running state as that bucket's
                # quote map (forward-fills any contract that didn't get a fresh
                # row in this window).
                snapshot_bucket(current_bucket_key)
                current_bucket_key = bucket_key

            running[sym] = mid

    # Final bucket
    snapshot_bucket(current_bucket_key)

    return buckets if buckets else None


def load_ohlcv_for_date(ohlcv_path, date_str):
    """Load OHLCV data for a specific date, return 15-min sampled prices."""
    prices = {}

    # Use grep to extract only matching lines (much faster than pandas for large files)
    try:
        result = subprocess.run(
            ['grep', date_str, str(ohlcv_path)],
            capture_output=True,
            text=True,
            timeout=60
        )
        lines = result.stdout.strip().split('\n')
    except Exception as e:
        print(f"grep failed: {e}")
        return prices

    for line in lines:
        if not line:
            continue

        parts = line.split(',')
        if len(parts) < 10:
            continue

        # Skip calendar spreads (symbol contains '-')
        if '-' in parts[-1]:
            continue

        try:
            ts_str = parts[0]
            close = float(parts[7])

            ts = pd.to_datetime(ts_str)
            # Round to 15-minute boundary
            minute = (ts.minute // 15) * 15
            bucket = ts.replace(minute=minute, second=0, microsecond=0)
            bucket_key = bucket.isoformat()

            # Keep last price in bucket
            prices[bucket_key] = close
        except:
            continue

    return prices


def calculate_gex_at_spot(stats_df, spot, ref_date, price_overrides=None):
    """Calculate GEX/VEX/CEX levels at a given spot price (VECTORIZED with per-contract IV).

    If `price_overrides` is provided (dict of {symbol: mid_price} for the current
    snapshot bucket), the option close_price is replaced with the cbbo mid on
    a per-symbol basis. Symbols missing from the override dict fall back to
    stat_type 11 close. Returns (result_dict, hit_count, fallback_count).
    """
    if stats_df is None or stats_df.empty:
        return None, 0, 0

    # Work on copy
    df = stats_df.copy()

    cbbo_hits = 0
    cbbo_fallbacks = 0

    if price_overrides is not None and 'symbol' in df.columns:
        override_series = df['symbol'].map(price_overrides)
        cbbo_hits = int(override_series.notna().sum())
        cbbo_fallbacks = int(len(df) - cbbo_hits)
        # Replace close_price where we have an override; keep stat_type 11 elsewhere.
        df['close_price'] = override_series.fillna(df['close_price'])

    # Calculate DTE and filter
    df['dte'] = (df['expiry'] - pd.Timestamp(ref_date)).dt.days
    df = df[(df['dte'] > 0) & (df['oi'] > 0) & (df['close_price'] > 0)].copy()

    if df.empty:
        return None, cbbo_hits, cbbo_fallbacks

    options_count = len(df)

    # Vectorized calculations
    df['T'] = np.maximum(df['dte'] / 365.0, 0.001)
    df['sqrt_T'] = np.sqrt(df['T'])
    r = RISK_FREE_RATE

    # Calculate per-contract IV using Brenner-Subrahmanyam approximation (VECTORIZED)
    # intrinsic = max(0, S - K) for calls, max(0, K - S) for puts
    df['intrinsic'] = np.where(
        df['type'] == 'C',
        np.maximum(0, spot - df['strike']),
        np.maximum(0, df['strike'] - spot)
    )
    df['time_value'] = df['close_price'] - df['intrinsic']

    # IV = (time_value / S) * sqrt(2 * pi / T)
    # Clamp to [0.05, 2.0] range
    df['iv'] = np.where(
        df['time_value'] > 0,
        (df['time_value'] / spot) * np.sqrt(2 * np.pi / df['T']),
        0.05  # Minimal IV for no time value
    )
    df['iv'] = df['iv'].clip(0.05, 2.0)

    # d1 calculation with per-contract IV (vectorized)
    df['d1'] = (np.log(spot / df['strike']) + (r + 0.5 * df['iv']**2) * df['T']) / (df['iv'] * df['sqrt_T'])

    # Gamma with per-contract IV (vectorized)
    df['gamma'] = norm.pdf(df['d1']) / (spot * df['iv'] * df['sqrt_T'])

    # Vega with per-contract IV (vectorized)
    df['vega'] = spot * norm.pdf(df['d1']) * df['sqrt_T'] / 100

    # Charm with per-contract IV (vectorized)
    df['d2'] = df['d1'] - df['iv'] * df['sqrt_T']
    df['charm'] = -norm.pdf(df['d1']) * (
        2 * r * df['T'] - df['d2'] * df['iv'] * df['sqrt_T']
    ) / (2 * df['T'] * df['iv'] * df['sqrt_T'])

    # GEX calculation (vectorized)
    df['gex'] = df['gamma'] * df['oi'] * 100 * spot * spot * 0.01
    # Put gamma is negative
    df.loc[df['type'] == 'P', 'gex'] *= -1

    df['vex'] = df['vega'] * df['oi'] * 100 * spot
    df['cex'] = df['charm'] * df['oi'] * 100 * spot

    # Handle NaN/Inf values
    df = df.replace([np.inf, -np.inf], np.nan).dropna(subset=['gex', 'vex', 'cex'])

    # DEBUG: dump strike 650 contributions when env var set
    import os as _os
    if _os.environ.get('DUMP_STRIKE') and abs(spot - float(_os.environ.get('DUMP_SPOT', '0'))) < 1.0:
        target_strike = float(_os.environ['DUMP_STRIKE'])
        sub = df[df['strike'] == target_strike].copy()
        sub = sub.sort_values('expiry')
        print(f"\n=== DEBUG strike {target_strike} @ spot {spot:.2f} ===", flush=True)
        print(f"{'expiry':<12} {'type':<5} {'oi':>7} {'close':>7} {'iv':>7} {'gamma':>11} {'gex(M)':>9}", flush=True)
        for _, r in sub.iterrows():
            print(f"{str(r['expiry'].date()):<12} {r['type']:<5} {int(r['oi']):>7} {r['close_price']:>7.2f} {r['iv']:>7.4f} {r['gamma']:>11.3e} {r['gex']/1e6:>9.2f}", flush=True)
        print(f"Total @ {target_strike}: {sub['gex'].sum() / 1e6:.2f}M (n={len(sub)})", flush=True)

    if df.empty:
        return None, cbbo_hits, cbbo_fallbacks

    # Aggregate by strike
    strike_agg = df.groupby('strike').agg({
        'gex': 'sum',
        'vex': 'sum',
        'cex': 'sum',
        'oi': 'sum'
    }).reset_index()

    total_gex = strike_agg['gex'].sum()
    total_vex = strike_agg['vex'].sum()
    total_cex = strike_agg['cex'].sum()

    if strike_agg.empty:
        return None, cbbo_hits, cbbo_fallbacks

    # Find key levels
    strikes = sorted(strike_agg['strike'].tolist())
    gex_dict = dict(zip(strike_agg['strike'], strike_agg['gex']))
    oi_dict = dict(zip(strike_agg['strike'], strike_agg['oi']))

    # Gamma flip: where cumulative GEX crosses from negative to positive.
    # Only consider strikes within ±10% of spot (matching gex_calculator.py).
    #
    # Use an epsilon threshold to ignore micro-magnitude crossings that are
    # purely floating-point noise. A typical near-spot strike has |gex| in
    # the tens-of-millions; deep-OTM strikes can have |gex| ~ 1e-9 from
    # near-zero gamma. Without the epsilon, a deep-OTM strike with
    # gex = -1e-9 followed by a strike with gex = +1e-9 would register as a
    # spurious "flip" at the bottom of the search range, even though the
    # real cumulative-GEX zero crossing is hundreds of strikes away near
    # spot. The live ExposureCalculator (JS) coincidentally avoids this
    # because its strike-aggregation produces exactly-zero values at those
    # strikes; the Python pipeline produces tiny non-zero floats from
    # rounding, so we need an explicit guard.
    FLIP_EPSILON = 1e6  # 1M GEX — below this is noise relative to real walls
    gamma_flip = None
    near_strikes = [s for s in strikes if spot * 0.9 <= s <= spot * 1.1]
    if near_strikes:
        cumsum = 0
        for strike in near_strikes:
            prev_cumsum = cumsum
            cumsum += gex_dict[strike]
            if prev_cumsum < -FLIP_EPSILON and cumsum >= FLIP_EPSILON:
                gamma_flip = strike
                break

    # Put walls (strikes with most negative GEX below spot)
    put_walls = [(s, gex_dict[s]) for s in strikes if s < spot and gex_dict[s] < 0]
    put_walls.sort(key=lambda x: x[1])  # Most negative first

    # Call walls (strikes with most positive GEX above spot)
    call_walls = [(s, gex_dict[s]) for s in strikes if s > spot and gex_dict[s] > 0]
    call_walls.sort(key=lambda x: -x[1])  # Most positive first

    # Support levels (negative GEX below spot)
    support = [s for s, g in put_walls[:5]]
    support_gex = [float(g) for s, g in put_walls[:5]]

    # Resistance levels (positive GEX above spot)
    resistance = [s for s, g in call_walls[:5]]
    resistance_gex = [float(g) for s, g in call_walls[:5]]

    # Primary walls + their gamma magnitude
    put_wall = put_walls[0][0] if put_walls else None
    put_wall_gex = float(put_walls[0][1]) if put_walls else None
    call_wall = call_walls[0][0] if call_walls else None
    call_wall_gex = float(call_walls[0][1]) if call_walls else None

    # Gamma imbalance: distribution of GEX above vs below spot (near-spot strikes only, ±10%)
    near_mask = [s for s in strikes if spot * 0.9 <= s <= spot * 1.1]
    gamma_above_spot = sum(gex_dict[s] for s in near_mask if s > spot and gex_dict[s] > 0)
    gamma_below_spot = abs(sum(gex_dict[s] for s in near_mask if s < spot and gex_dict[s] < 0))
    total_near = gamma_above_spot + gamma_below_spot
    gamma_imbalance = (
        (gamma_above_spot - gamma_below_spot) / total_near
        if total_near > 0 else None
    )

    # Regime (matching gex_calculator.py thresholds)
    if total_gex > 5e9:
        regime = 'strong_positive'
    elif total_gex > 1e9:
        regime = 'positive'
    elif total_gex > -1e9:
        regime = 'neutral'
    elif total_gex > -5e9:
        regime = 'negative'
    else:
        regime = 'strong_negative'

    return ({
        'gamma_flip': gamma_flip,
        'call_wall': call_wall,
        'call_wall_gex': call_wall_gex,
        'put_wall': put_wall,
        'put_wall_gex': put_wall_gex,
        'resistance': resistance,
        'resistance_gex': resistance_gex,
        'support': support,
        'support_gex': support_gex,
        'total_gex': float(total_gex),
        'total_vex': float(total_vex),
        'total_cex': float(total_cex),
        'gamma_above_spot': float(gamma_above_spot),
        'gamma_below_spot': float(gamma_below_spot),
        'gamma_imbalance': gamma_imbalance,
        'options_count': options_count,
        'regime': regime
    }, cbbo_hits, cbbo_fallbacks)


def generate_day(date_str, stats_df, etf_prices, futures_prices, config,
                 iv_source='stats', cbbo_buckets=None):
    """Generate intraday GEX JSON for a single day.

    iv_source='stats' (default) uses stat_type 11 EOD close for every snapshot.
    iv_source='cbbo' uses cbbo-1m mid at the snapshot bucket (per contract),
    falling back to stat_type 11 close for any contract with no quote in that
    bucket. cbbo_buckets must be provided when iv_source='cbbo'.
    """
    snapshots = []
    ref_date = datetime.strptime(date_str, '%Y-%m-%d')
    futures_sym = config['futures_symbol'].lower()
    etf_sym = config['etf_symbol'].lower()

    total_cbbo_hits = 0
    total_cbbo_fallbacks = 0

    # Pre-sort cbbo bucket keys for forward-fill lookup. For any snapshot
    # bucket we want the LAST cbbo bucket <= that timestamp. Lexicographic
    # sort works because all keys are zero-padded ISO strings.
    sorted_cbbo_keys = sorted(cbbo_buckets.keys()) if cbbo_buckets else []

    # Get all 15-minute buckets for the day
    for bucket_key in sorted(etf_prices.keys()):
        etf_spot = etf_prices[bucket_key]
        futures_spot = futures_prices.get(bucket_key)

        if etf_spot is None or etf_spot <= 0:
            continue
        if futures_spot is None or futures_spot <= 0:
            continue

        # Per-snapshot price overrides from cbbo (None for stats mode).
        # If this bucket has no cbbo entry, walk back to the most recent prior
        # bucket — once a contract is quoted, that quote stays "known" until
        # updated, even across bucket gaps. Only fully fall back to stats when
        # no cbbo bucket is at-or-before the snapshot (i.e., pre-RTH overnight).
        price_overrides = None
        if iv_source == 'cbbo' and sorted_cbbo_keys:
            import bisect
            idx = bisect.bisect_right(sorted_cbbo_keys, bucket_key) - 1
            if idx >= 0:
                price_overrides = cbbo_buckets[sorted_cbbo_keys[idx]]

        # Calculate GEX at ETF spot price
        gex, cbbo_hits, cbbo_fallbacks = calculate_gex_at_spot(
            stats_df, etf_spot, ref_date, price_overrides=price_overrides
        )
        if gex is None:
            continue

        total_cbbo_hits += cbbo_hits
        total_cbbo_fallbacks += cbbo_fallbacks

        # Calculate multiplier (futures / ETF)
        multiplier = futures_spot / etf_spot

        # Translate levels to futures. Gamma magnitudes are in ETF-dollar space
        # (gamma × OI × 100 × spot²); kept unscaled so they compare consistently
        # across trades on the same product.
        snapshot = {
            'timestamp': bucket_key,
            f'{futures_sym}_spot': round(futures_spot, 2),
            f'{etf_sym}_spot': round(etf_spot, 2),
            'multiplier': round(multiplier, 4),
            'gamma_flip': round(gex['gamma_flip'] * multiplier, 2) if gex['gamma_flip'] else None,
            'call_wall': round(gex['call_wall'] * multiplier, 2) if gex['call_wall'] else None,
            'call_wall_gex': gex['call_wall_gex'],
            'put_wall': round(gex['put_wall'] * multiplier, 2) if gex['put_wall'] else None,
            'put_wall_gex': gex['put_wall_gex'],
            'total_gex': gex['total_gex'],
            'total_vex': gex['total_vex'],
            'total_cex': gex['total_cex'],
            'gamma_above_spot': gex['gamma_above_spot'],
            'gamma_below_spot': gex['gamma_below_spot'],
            'gamma_imbalance': gex['gamma_imbalance'],
            'resistance': [round(r * multiplier, 2) for r in gex['resistance']],
            'resistance_gex': gex['resistance_gex'],
            'support': [round(s * multiplier, 2) for s in gex['support']],
            'support_gex': gex['support_gex'],
            'regime': gex['regime'],
            'options_count': gex['options_count']
        }
        if iv_source == 'cbbo':
            snapshot['cbbo_hits'] = cbbo_hits
            snapshot['cbbo_fallbacks'] = cbbo_fallbacks
        snapshots.append(snapshot)

    if not snapshots:
        return None

    metadata = {
        'symbol': config['futures_symbol'],
        'source_symbol': config['etf_symbol'],
        'date': date_str,
        'interval_minutes': 15,
        'iv_source': iv_source,
        'generated': datetime.now().isoformat(),
        'snapshots': len(snapshots),
    }
    if iv_source == 'cbbo':
        total_lookups = total_cbbo_hits + total_cbbo_fallbacks
        metadata['cbbo_hit_rate'] = (
            total_cbbo_hits / total_lookups if total_lookups > 0 else 0.0
        )
        metadata['cbbo_total_hits'] = total_cbbo_hits
        metadata['cbbo_total_fallbacks'] = total_cbbo_fallbacks

    return {'metadata': metadata, 'data': snapshots}


def main():
    parser = argparse.ArgumentParser(description='Generate intraday GEX JSON files')
    parser.add_argument('--product', choices=list(PRODUCTS.keys()), default='nq',
                        help='Product to generate GEX for (default: nq)')
    parser.add_argument('--start', required=True, help='Start date (YYYY-MM-DD)')
    parser.add_argument('--end', required=True, help='End date (YYYY-MM-DD)')
    parser.add_argument('--iv-source', choices=['stats', 'cbbo'], default='stats',
                        help='IV price source: "stats" (stat_type 11 EOD close, default, '
                             'has lookahead bias) or "cbbo" (cbbo-1m mid at snapshot minute, '
                             'falls back to stat_type 11 for contracts without quote)')
    parser.add_argument('--output-dir', default=None,
                        help='Override default output directory')
    args = parser.parse_args()

    config = PRODUCTS[args.product]
    start_date = datetime.strptime(args.start, '%Y-%m-%d')
    end_date = datetime.strptime(args.end, '%Y-%m-%d')

    # Default output dir depends on iv-source so we never overwrite stats files with cbbo files.
    if args.output_dir:
        output_dir = Path(args.output_dir)
    elif args.iv_source == 'cbbo':
        output_dir = config['output_dir_cbbo']
    else:
        output_dir = config['output_dir']

    print(f"Generating {config['futures_symbol']} intraday GEX from {config['etf_symbol']} options")
    print(f"Date range: {args.start} to {args.end}")
    print(f"IV source: {args.iv_source}")
    print(f"Stats dir: {config['stats_dir']}")
    if args.iv_source == 'cbbo':
        print(f"CBBO dir:  {config['cbbo_dir']}")
    print(f"Output dir: {output_dir}")

    # Ensure output directory exists
    output_dir.mkdir(parents=True, exist_ok=True)

    # Process each day
    current = start_date
    success_count = 0

    while current <= end_date:
        date_str = current.strftime('%Y-%m-%d')

        # Skip weekends
        if current.weekday() >= 5:
            current += timedelta(days=1)
            continue

        print(f"Processing {date_str}...", end=' ', flush=True)

        # Load statistics (OI + close prices)
        stats_df = load_statistics(config['stats_dir'], date_str)
        if stats_df is None:
            print("no statistics data")
            current += timedelta(days=1)
            continue

        # Load OHLCV prices
        etf_prices = load_ohlcv_for_date(config['etf_ohlcv'], date_str)
        futures_prices = load_ohlcv_for_date(config['futures_ohlcv'], date_str)

        if not etf_prices:
            print(f"no {config['etf_symbol']} OHLCV data")
            current += timedelta(days=1)
            continue

        if not futures_prices:
            print(f"no {config['futures_symbol']} OHLCV data")
            current += timedelta(days=1)
            continue

        # Load cbbo-1m if requested
        cbbo_buckets = None
        if args.iv_source == 'cbbo':
            cbbo_buckets = load_cbbo_buckets(config['cbbo_dir'], date_str, interval_minutes=15)
            if cbbo_buckets is None:
                print(f"no cbbo-1m data (will skip)")
                current += timedelta(days=1)
                continue

        # Generate JSON
        result = generate_day(date_str, stats_df, etf_prices, futures_prices, config,
                              iv_source=args.iv_source, cbbo_buckets=cbbo_buckets)

        if result is None:
            print("failed to generate")
            current += timedelta(days=1)
            continue

        # Write output
        output_path = output_dir / f"{config['output_prefix']}_{date_str}.json"
        with open(output_path, 'w') as f:
            json.dump(result, f, indent=2)

        snap_count = result['metadata']['snapshots']
        if args.iv_source == 'cbbo':
            hit_rate = result['metadata'].get('cbbo_hit_rate', 0.0)
            print(f"OK ({snap_count} snapshots, cbbo hit rate {hit_rate*100:.1f}%)")
        else:
            print(f"OK ({snap_count} snapshots)")
        success_count += 1

        current += timedelta(days=1)

    print(f"\nGenerated {success_count} files")


if __name__ == '__main__':
    main()
