#!/usr/bin/env python3
"""
Precompute Charm/Vanna Dataset for ES Overnight Strategy

Uses daily SPY options statistics (OI + close prices) + intraday SPY OHLCV
to create two outputs:

1. Intraday 15-minute JSON snapshots (for future RTH strategies)
   - data/charm-vanna/es/es_charm_vanna_YYYY-MM-DD.json

2. Daily EOD summary CSV (for overnight strategy)
   - data/charm-vanna/es/es_charm_vanna_daily.csv

Methodology matches generate-intraday-gex.py:
- Uses Brenner-Subrahmanyam IV approximation from close prices
- Calculates gamma, vega, charm, vanna per contract
- Aggregates to net GEX/CEX/VEX with DTE bucket splits

Usage:
    python precompute-charm-vanna.py --start 2023-08-03 --end 2026-01-28
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

# Paths
BASE_DIR = Path('/home/drew/projects/slingshot-services/backtest-engine/data')
STATS_DIR = BASE_DIR / 'statistics' / 'spy'
SPY_OHLCV = BASE_DIR / 'ohlcv' / 'spy' / 'SPY_ohlcv_1m.csv'
ES_OHLCV = BASE_DIR / 'ohlcv' / 'es' / 'ES_ohlcv_1s.csv'
VIX_CSV = BASE_DIR / 'iv' / 'vix' / 'VIX_History.csv'
OUTPUT_DIR = BASE_DIR / 'charm-vanna' / 'es'

# Constants
RISK_FREE_RATE = 0.05
DEFAULT_IV = 0.20


def load_vix_data():
    """Load VIX daily close data into a date->close dict."""
    vix = {}
    if not VIX_CSV.exists():
        print("Warning: VIX_History.csv not found, VIX data will be empty")
        return vix

    df = pd.read_csv(VIX_CSV)
    for _, row in df.iterrows():
        try:
            date_str = pd.to_datetime(row['DATE']).strftime('%Y-%m-%d')
            vix[date_str] = float(row['CLOSE'])
        except:
            continue
    return vix


def load_statistics(date_str):
    """Load SPY statistics file for a date, return OI and close prices per contract."""
    csv_path = STATS_DIR / f'opra-pillar-{date_str.replace("-", "")}.statistics.csv'

    if not csv_path.exists():
        return None

    df = pd.read_csv(csv_path)

    # Extract OI (stat_type 9) and close prices (stat_type 11)
    oi_data = df[df['stat_type'] == 9].groupby('symbol')['quantity'].max().reset_index()
    close_data = df[df['stat_type'] == 11].groupby('symbol')['price'].max().reset_index()

    # Merge OI and close prices - use inner join (require both)
    merged = oi_data.merge(close_data, on='symbol', how='inner')
    merged.columns = ['symbol', 'oi', 'close_price']

    # Filter out zero/negative close prices
    merged = merged[merged['close_price'] > 0]

    if merged.empty:
        return None

    # Vectorized symbol parsing
    # Format: "SPY   YYMMDDTSSSSSSSS" where T is C/P
    symbols = merged['symbol'].str.strip()
    contracts = symbols.str.split().str[-1]

    # Parse expiry (first 6 chars), type (7th char), strike (rest / 1000)
    merged['expiry'] = pd.to_datetime('20' + contracts.str[:6], format='%Y%m%d', errors='coerce')
    merged['type'] = contracts.str[6]
    merged['strike'] = contracts.str[7:].astype(float) / 1000

    # Filter valid rows
    merged = merged[merged['expiry'].notna() & (merged['oi'] > 0) & (merged['close_price'] > 0)]

    return merged[['strike', 'type', 'expiry', 'oi', 'close_price']].copy()


def load_ohlcv_for_date(ohlcv_path, date_str, is_1s=False):
    """Load OHLCV data for a specific date, return 15-min sampled prices."""
    prices = {}

    try:
        result = subprocess.run(
            ['grep', date_str, str(ohlcv_path)],
            capture_output=True,
            text=True,
            timeout=120
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

        # Skip calendar spreads
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


def calculate_greeks_at_spot(stats_df, spot, ref_date):
    """Calculate GEX/CEX/VEX levels at a given spot price (VECTORIZED with per-contract IV)."""
    if stats_df is None or stats_df.empty:
        return None

    df = stats_df.copy()

    # Calculate DTE and filter
    df['dte'] = (df['expiry'] - pd.Timestamp(ref_date)).dt.days
    df = df[(df['dte'] >= 1) & (df['dte'] <= 45) & (df['oi'] > 10) & (df['close_price'] > 0)].copy()

    # Filter strikes within 20% of spot
    df = df[(df['strike'] >= spot * 0.80) & (df['strike'] <= spot * 1.20)].copy()

    if df.empty:
        return None

    options_count = len(df)

    # Vectorized calculations
    df['T'] = np.maximum(df['dte'] / 365.0, 0.001)
    df['sqrt_T'] = np.sqrt(df['T'])
    r = RISK_FREE_RATE

    # Per-contract IV using Brenner-Subrahmanyam approximation (VECTORIZED)
    df['intrinsic'] = np.where(
        df['type'] == 'C',
        np.maximum(0, spot - df['strike']),
        np.maximum(0, df['strike'] - spot)
    )
    df['time_value'] = df['close_price'] - df['intrinsic']

    df['iv'] = np.where(
        df['time_value'] > 0,
        (df['time_value'] / spot) * np.sqrt(2 * np.pi / df['T']),
        0.05
    )
    df['iv'] = df['iv'].clip(0.05, 2.0)

    # d1, d2 calculation with per-contract IV (vectorized)
    df['d1'] = (np.log(spot / df['strike']) + (r + 0.5 * df['iv']**2) * df['T']) / (df['iv'] * df['sqrt_T'])
    df['d2'] = df['d1'] - df['iv'] * df['sqrt_T']

    # Gamma (vectorized)
    df['gamma'] = norm.pdf(df['d1']) / (spot * df['iv'] * df['sqrt_T'])

    # Vega (vectorized)
    df['vega'] = spot * norm.pdf(df['d1']) * df['sqrt_T'] / 100

    # Charm (vectorized) — dDelta/dTime
    df['charm'] = -norm.pdf(df['d1']) * (
        2 * r * df['T'] - df['d2'] * df['iv'] * df['sqrt_T']
    ) / (2 * df['T'] * df['iv'] * df['sqrt_T'])

    # Vanna (vectorized) — dDelta/dVol
    df['vanna'] = -norm.pdf(df['d1']) * df['d2'] / df['iv']

    # GEX/CEX/VEX calculation (vectorized)
    # Put gamma is negated (dealer short assumption)
    df['gex'] = df['gamma'] * df['oi'] * 100 * spot * spot * 0.01
    df.loc[df['type'] == 'P', 'gex'] *= -1

    df['cex'] = df['charm'] * df['oi'] * 100 * spot
    df.loc[df['type'] == 'P', 'cex'] *= -1

    df['vex'] = df['vanna'] * df['oi'] * 100 * spot
    df.loc[df['type'] == 'P', 'vex'] *= -1

    # Handle NaN/Inf
    df = df.replace([np.inf, -np.inf], np.nan).dropna(subset=['gex', 'cex', 'vex'])

    if df.empty:
        return None

    # Total aggregates
    total_gex = df['gex'].sum()
    total_cex = df['cex'].sum()
    total_vex = df['vex'].sum()

    # Split by put/call
    put_mask = df['type'] == 'P'
    call_mask = df['type'] == 'C'
    put_cex = df.loc[put_mask, 'cex'].sum()
    call_cex = df.loc[call_mask, 'cex'].sum()
    put_vex = df.loc[put_mask, 'vex'].sum()
    call_vex = df.loc[call_mask, 'vex'].sum()

    # Split by DTE bucket
    short_mask = df['dte'] <= 7
    medium_mask = (df['dte'] > 7) & (df['dte'] <= 21)
    long_mask = df['dte'] > 21
    short_term_cex = df.loc[short_mask, 'cex'].sum()
    medium_term_cex = df.loc[medium_mask, 'cex'].sum()
    long_term_cex = df.loc[long_mask, 'cex'].sum()

    # OI totals
    total_oi = int(df['oi'].sum())
    put_oi = int(df.loc[put_mask, 'oi'].sum())
    call_oi = int(df.loc[call_mask, 'oi'].sum())

    # Key GEX levels (aggregate by strike)
    strike_agg = df.groupby('strike').agg({'gex': 'sum', 'oi': 'sum'}).reset_index()
    strikes = sorted(strike_agg['strike'].tolist())
    gex_dict = dict(zip(strike_agg['strike'], strike_agg['gex']))

    # Gamma flip
    gamma_flip = None
    near_strikes = [s for s in strikes if spot * 0.9 <= s <= spot * 1.1]
    if near_strikes:
        cumsum = 0
        for strike in near_strikes:
            prev_cumsum = cumsum
            cumsum += gex_dict[strike]
            if prev_cumsum < 0 and cumsum >= 0:
                gamma_flip = strike
                break

    # Put walls (most negative GEX below spot)
    put_walls = [(s, gex_dict[s]) for s in strikes if s < spot and gex_dict[s] < 0]
    put_walls.sort(key=lambda x: x[1])
    put_wall = put_walls[0][0] if put_walls else None
    support = [s for s, g in put_walls[:5]]

    # Call walls (most positive GEX above spot)
    call_walls = [(s, gex_dict[s]) for s in strikes if s > spot and gex_dict[s] > 0]
    call_walls.sort(key=lambda x: -x[1])
    call_wall = call_walls[0][0] if call_walls else None
    resistance = [s for s, g in call_walls[:5]]

    # Regime
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
        'total_gex': total_gex,
        'total_cex': total_cex,
        'total_vex': total_vex,
        'put_cex': put_cex,
        'call_cex': call_cex,
        'put_vex': put_vex,
        'call_vex': call_vex,
        'short_term_cex': short_term_cex,
        'medium_term_cex': medium_term_cex,
        'long_term_cex': long_term_cex,
        'total_oi': total_oi,
        'put_oi': put_oi,
        'call_oi': call_oi,
        'options_count': options_count,
        'gamma_flip': gamma_flip,
        'put_wall': put_wall,
        'call_wall': call_wall,
        'support': support,
        'resistance': resistance,
        'regime': regime
    }


def generate_day(date_str, stats_df, spy_prices, es_prices):
    """Generate intraday charm/vanna JSON for a single day."""
    snapshots = []
    ref_date = datetime.strptime(date_str, '%Y-%m-%d')

    for bucket_key in sorted(spy_prices.keys()):
        spy_spot = spy_prices[bucket_key]
        es_spot = es_prices.get(bucket_key)

        if spy_spot is None or spy_spot <= 0:
            continue
        if es_spot is None or es_spot <= 0:
            continue

        greeks = calculate_greeks_at_spot(stats_df, spy_spot, ref_date)
        if greeks is None:
            continue

        multiplier = es_spot / spy_spot

        snapshot = {
            'timestamp': bucket_key,
            'spy_spot': round(spy_spot, 2),
            'es_spot': round(es_spot, 2),
            'multiplier': round(multiplier, 4),
            'gamma_flip': round(greeks['gamma_flip'] * multiplier, 2) if greeks['gamma_flip'] else None,
            'call_wall': round(greeks['call_wall'] * multiplier, 2) if greeks['call_wall'] else None,
            'put_wall': round(greeks['put_wall'] * multiplier, 2) if greeks['put_wall'] else None,
            'resistance': [round(r * multiplier, 2) for r in greeks['resistance']],
            'support': [round(s * multiplier, 2) for s in greeks['support']],
            'total_gex': greeks['total_gex'],
            'total_cex': greeks['total_cex'],
            'total_vex': greeks['total_vex'],
            'put_cex': greeks['put_cex'],
            'call_cex': greeks['call_cex'],
            'put_vex': greeks['put_vex'],
            'call_vex': greeks['call_vex'],
            'short_term_cex': greeks['short_term_cex'],
            'medium_term_cex': greeks['medium_term_cex'],
            'long_term_cex': greeks['long_term_cex'],
            'regime': greeks['regime'],
            'options_count': greeks['options_count'],
            'total_oi': greeks['total_oi'],
            'put_oi': greeks['put_oi'],
            'call_oi': greeks['call_oi']
        }
        snapshots.append(snapshot)

    if not snapshots:
        return None

    return {
        'metadata': {
            'symbol': 'ES',
            'source_symbol': 'SPY',
            'date': date_str,
            'interval_minutes': 15,
            'generated': datetime.now().isoformat(),
            'snapshots': len(snapshots)
        },
        'data': snapshots
    }


def main():
    parser = argparse.ArgumentParser(description='Precompute Charm/Vanna dataset for ES overnight strategy')
    parser.add_argument('--start', required=True, help='Start date (YYYY-MM-DD)')
    parser.add_argument('--end', required=True, help='End date (YYYY-MM-DD)')
    args = parser.parse_args()

    start_date = datetime.strptime(args.start, '%Y-%m-%d')
    end_date = datetime.strptime(args.end, '%Y-%m-%d')

    print(f"Precomputing Charm/Vanna from {args.start} to {args.end}")
    print(f"Output directory: {OUTPUT_DIR}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Load VIX data
    vix_data = load_vix_data()
    print(f"Loaded VIX data: {len(vix_data)} days")

    # Daily CSV header
    daily_csv_path = OUTPUT_DIR / 'es_charm_vanna_daily.csv'
    daily_rows = []
    csv_header = (
        'date,spy_spot,es_spot,multiplier,vix_close,'
        'net_cex,net_vex,short_term_cex,medium_term_cex,long_term_cex,'
        'put_cex,call_cex,put_vex,call_vex,'
        'net_gex,total_oi,put_oi,call_oi,options_count,regime,'
        'gamma_flip,put_wall,call_wall'
    )

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
        stats_df = load_statistics(date_str)
        if stats_df is None:
            print("no statistics data")
            current += timedelta(days=1)
            continue

        # Load OHLCV prices
        spy_prices = load_ohlcv_for_date(SPY_OHLCV, date_str)
        es_prices = load_ohlcv_for_date(ES_OHLCV, date_str, is_1s=True)

        if not spy_prices:
            print("no SPY OHLCV data")
            current += timedelta(days=1)
            continue

        if not es_prices:
            print("no ES OHLCV data")
            current += timedelta(days=1)
            continue

        # Generate intraday JSON
        result = generate_day(date_str, stats_df, spy_prices, es_prices)

        if result is None:
            print("failed to generate")
            current += timedelta(days=1)
            continue

        # Write intraday JSON file
        output_path = OUTPUT_DIR / f'es_charm_vanna_{date_str}.json'
        with open(output_path, 'w') as f:
            json.dump(result, f, indent=2)

        # Extract EOD snapshot for daily CSV (last snapshot of the day, ~4pm ET)
        eod_snapshot = result['data'][-1]
        vix_close = vix_data.get(date_str, '')

        daily_row = (
            f"{date_str},{eod_snapshot['spy_spot']},{eod_snapshot['es_spot']},"
            f"{eod_snapshot['multiplier']},{vix_close},"
            f"{eod_snapshot['total_cex']},{eod_snapshot['total_vex']},"
            f"{eod_snapshot['short_term_cex']},{eod_snapshot['medium_term_cex']},{eod_snapshot['long_term_cex']},"
            f"{eod_snapshot['put_cex']},{eod_snapshot['call_cex']},"
            f"{eod_snapshot['put_vex']},{eod_snapshot['call_vex']},"
            f"{eod_snapshot['total_gex']},{eod_snapshot['total_oi']},"
            f"{eod_snapshot['put_oi']},{eod_snapshot['call_oi']},"
            f"{eod_snapshot['options_count']},{eod_snapshot['regime']},"
            f"{eod_snapshot.get('gamma_flip', '')},{eod_snapshot.get('put_wall', '')},"
            f"{eod_snapshot.get('call_wall', '')}"
        )
        daily_rows.append(daily_row)

        print(f"OK ({result['metadata']['snapshots']} snapshots)")
        success_count += 1

        current += timedelta(days=1)

    # Write daily CSV
    with open(daily_csv_path, 'w') as f:
        f.write(csv_header + '\n')
        for row in daily_rows:
            f.write(row + '\n')

    print(f"\nGenerated {success_count} intraday JSON files")
    print(f"Daily CSV written to {daily_csv_path} ({len(daily_rows)} rows)")


if __name__ == '__main__':
    main()
