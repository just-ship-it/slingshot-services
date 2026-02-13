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
        'etf_ohlcv': BASE_DIR / 'ohlcv' / 'qqq' / 'QQQ_ohlcv_1m.csv',
        'futures_ohlcv': BASE_DIR / 'ohlcv' / 'nq' / 'NQ_ohlcv_1m.csv',
        'output_dir': BASE_DIR / 'gex' / 'nq',
        'output_prefix': 'nq_gex',
    },
    'es': {
        'futures_symbol': 'ES',
        'etf_symbol': 'SPY',
        'stats_dir': BASE_DIR / 'statistics' / 'spy',
        'etf_ohlcv': BASE_DIR / 'ohlcv' / 'spy' / 'SPY_ohlcv_1m.csv',
        'futures_ohlcv': BASE_DIR / 'ohlcv' / 'es' / 'ES_ohlcv_1m.csv',
        'output_dir': BASE_DIR / 'gex' / 'es',
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

    return merged[['strike', 'type', 'expiry', 'oi', 'close_price']].copy()


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


def calculate_gex_at_spot(stats_df, spot, ref_date):
    """Calculate GEX/VEX/CEX levels at a given spot price (VECTORIZED with per-contract IV)."""
    if stats_df is None or stats_df.empty:
        return None

    # Work on copy
    df = stats_df.copy()

    # Calculate DTE and filter
    df['dte'] = (df['expiry'] - pd.Timestamp(ref_date)).dt.days
    df = df[(df['dte'] > 0) & (df['oi'] > 0) & (df['close_price'] > 0)].copy()

    if df.empty:
        return None

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

    if df.empty:
        return None

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
        return None

    # Find key levels
    strikes = sorted(strike_agg['strike'].tolist())
    gex_dict = dict(zip(strike_agg['strike'], strike_agg['gex']))
    oi_dict = dict(zip(strike_agg['strike'], strike_agg['oi']))

    # Gamma flip: where cumulative GEX crosses from negative to positive
    # Only consider strikes within ±10% of spot (matching gex_calculator.py)
    gamma_flip = None
    near_strikes = [s for s in strikes if spot * 0.9 <= s <= spot * 1.1]
    if near_strikes:
        cumsum = 0
        for strike in near_strikes:
            prev_cumsum = cumsum
            cumsum += gex_dict[strike]
            if prev_cumsum < 0 and cumsum >= 0:
                # Linear interpolation for more precise flip level
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

    # Resistance levels (positive GEX above spot)
    resistance = [s for s, g in call_walls[:5]]

    # Primary walls
    put_wall = put_walls[0][0] if put_walls else None
    call_wall = call_walls[0][0] if call_walls else None

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

    return {
        'gamma_flip': gamma_flip,
        'call_wall': call_wall,
        'put_wall': put_wall,
        'resistance': resistance,
        'support': support,
        'total_gex': total_gex,
        'total_vex': total_vex,
        'total_cex': total_cex,
        'options_count': options_count,
        'regime': regime
    }


def generate_day(date_str, stats_df, etf_prices, futures_prices, config):
    """Generate intraday GEX JSON for a single day."""
    snapshots = []
    ref_date = datetime.strptime(date_str, '%Y-%m-%d')
    futures_sym = config['futures_symbol'].lower()
    etf_sym = config['etf_symbol'].lower()

    # Get all 15-minute buckets for the day
    for bucket_key in sorted(etf_prices.keys()):
        etf_spot = etf_prices[bucket_key]
        futures_spot = futures_prices.get(bucket_key)

        if etf_spot is None or etf_spot <= 0:
            continue
        if futures_spot is None or futures_spot <= 0:
            continue

        # Calculate GEX at ETF spot price
        gex = calculate_gex_at_spot(stats_df, etf_spot, ref_date)
        if gex is None:
            continue

        # Calculate multiplier (futures / ETF)
        multiplier = futures_spot / etf_spot

        # Translate levels to futures
        snapshot = {
            'timestamp': bucket_key,
            f'{futures_sym}_spot': round(futures_spot, 2),
            f'{etf_sym}_spot': round(etf_spot, 2),
            'multiplier': round(multiplier, 4),
            'gamma_flip': round(gex['gamma_flip'] * multiplier, 2) if gex['gamma_flip'] else None,
            'call_wall': round(gex['call_wall'] * multiplier, 2) if gex['call_wall'] else None,
            'put_wall': round(gex['put_wall'] * multiplier, 2) if gex['put_wall'] else None,
            'total_gex': gex['total_gex'],
            'total_vex': gex['total_vex'],
            'total_cex': gex['total_cex'],
            'resistance': [round(r * multiplier, 2) for r in gex['resistance']],
            'support': [round(s * multiplier, 2) for s in gex['support']],
            'regime': gex['regime'],
            'options_count': gex['options_count']
        }
        snapshots.append(snapshot)

    if not snapshots:
        return None

    return {
        'metadata': {
            'symbol': config['futures_symbol'],
            'source_symbol': config['etf_symbol'],
            'date': date_str,
            'interval_minutes': 15,
            'generated': datetime.now().isoformat(),
            'snapshots': len(snapshots)
        },
        'data': snapshots
    }


def main():
    parser = argparse.ArgumentParser(description='Generate intraday GEX JSON files')
    parser.add_argument('--product', choices=list(PRODUCTS.keys()), default='nq',
                        help='Product to generate GEX for (default: nq)')
    parser.add_argument('--start', required=True, help='Start date (YYYY-MM-DD)')
    parser.add_argument('--end', required=True, help='End date (YYYY-MM-DD)')
    args = parser.parse_args()

    config = PRODUCTS[args.product]
    start_date = datetime.strptime(args.start, '%Y-%m-%d')
    end_date = datetime.strptime(args.end, '%Y-%m-%d')

    print(f"Generating {config['futures_symbol']} intraday GEX from {config['etf_symbol']} options")
    print(f"Date range: {args.start} to {args.end}")
    print(f"Stats dir: {config['stats_dir']}")
    print(f"Output dir: {config['output_dir']}")

    # Ensure output directory exists
    config['output_dir'].mkdir(parents=True, exist_ok=True)

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

        # Generate JSON
        result = generate_day(date_str, stats_df, etf_prices, futures_prices, config)

        if result is None:
            print("failed to generate")
            current += timedelta(days=1)
            continue

        # Write output
        output_path = config['output_dir'] / f"{config['output_prefix']}_{date_str}.json"
        with open(output_path, 'w') as f:
            json.dump(result, f, indent=2)

        print(f"OK ({result['metadata']['snapshots']} snapshots)")
        success_count += 1

        current += timedelta(days=1)

    print(f"\nGenerated {success_count} files")


if __name__ == '__main__':
    main()
