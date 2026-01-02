"""GEX calculator for fetching and calculating gamma exposure from CBOE options data."""

import json
import logging
import asyncio
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import pandas as pd
import numpy as np
from scipy.stats import norm
import requests
import yfinance as yf
import aiohttp
import pytz

from ..models.levels import GexLevels
from ..config import Config

logger = logging.getLogger(__name__)

CBOE_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json"


class GexCalculator:
    """Calculate GEX levels from CBOE options data."""

    def __init__(self, symbol: str = "QQQ", cache_file: Optional[str] = None):
        """Initialize GEX calculator.

        Args:
            symbol: Options symbol to fetch (default QQQ)
            cache_file: Optional file path to cache GEX levels
        """
        self.symbol = symbol
        self.cache_file = Path(cache_file) if cache_file else None
        self.current_levels: Optional[GexLevels] = None
        self.last_fetch_time = 0
        self.cooldown_seconds = Config.GEX_COOLDOWN_MINUTES * 60
        self.fetch_time = self._parse_fetch_time(Config.GEX_FETCH_TIME)
        self.est_tz = pytz.timezone('US/Eastern')

        # Load cached levels if available
        if self.cache_file:
            self.load_cached_levels()

    def _parse_fetch_time(self, time_str: str) -> time:
        """Parse fetch time from string (e.g., '16:35' to time object)."""
        parts = time_str.split(':')
        return time(int(parts[0]), int(parts[1]))

    def load_cached_levels(self):
        """Load cached GEX levels from file if available."""
        if not self.cache_file or not self.cache_file.exists():
            return

        try:
            with open(self.cache_file, 'r') as f:
                data = json.load(f)
                self.current_levels = GexLevels.from_dict(data)
                logger.info(f"Loaded cached GEX levels from {self.cache_file}")
        except Exception as e:
            logger.error(f"Failed to load cached GEX levels: {e}")

    def save_cached_levels(self):
        """Save current GEX levels to cache file."""
        if not self.cache_file or not self.current_levels:
            return

        try:
            # Ensure directory exists
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)

            with open(self.cache_file, 'w') as f:
                json.dump(self.current_levels.to_dict(), f, indent=2)
            logger.info(f"Saved GEX levels to cache: {self.cache_file}")
        except Exception as e:
            logger.error(f"Failed to save GEX levels to cache: {e}")

    async def fetch_cboe_options(self) -> Dict:
        """Fetch options chain from CBOE delayed quotes API."""
        url = CBOE_URL.format(symbol=self.symbol)

        async with aiohttp.ClientSession() as session:
            try:
                async with session.get(url, timeout=30) as response:
                    response.raise_for_status()
                    data = await response.json()
                    logger.info(f"Fetched CBOE options data for {self.symbol}")
                    return data
            except Exception as e:
                logger.error(f"Failed to fetch CBOE data: {e}")
                raise

    def calc_gamma_ex(self, S: float, K: float, vol: float, T: float,
                     r: float, q: float, opt_type: str, OI: float) -> float:
        """Calculate Black-Scholes gamma exposure for a single option.

        Args:
            S: Spot price
            K: Strike price
            vol: Implied volatility
            T: Time to expiration in years
            r: Risk-free rate
            q: Dividend yield
            opt_type: 'call' or 'put'
            OI: Open interest

        Returns:
            Gamma exposure value
        """
        if T <= 0 or vol <= 0 or np.isnan(vol) or S <= 0 or K <= 0 or np.isnan(OI):
            return 0

        try:
            dp = (np.log(S/K) + (r - q + 0.5*vol**2)*T) / (vol*np.sqrt(T))
            dm = dp - vol*np.sqrt(T)

            if opt_type == 'call':
                gamma = np.exp(-q*T) * norm.pdf(dp) / (S * vol * np.sqrt(T))
                return OI * 100 * S * S * 0.01 * gamma
            else:
                gamma = K * np.exp(-r*T) * norm.pdf(dm) / (S * S * vol * np.sqrt(T))
                return OI * 100 * S * S * 0.01 * gamma * -1
        except:
            return 0

    def parse_option_symbol(self, symbol: str) -> Tuple[str, datetime, str, float]:
        """Parse CBOE option symbol.

        Args:
            symbol: Option symbol like 'QQQ250117C00400000'

        Returns:
            Tuple of (underlying, expiry, type, strike)
        """
        # Last 9 chars: C00400000 → C=Call, 00400=strike ($400), 000=decimal
        strike_info = symbol[-9:]
        opt_type = 'call' if strike_info[0] == 'C' else 'put'
        strike = float(strike_info[1:6]) + float(strike_info[6:]) / 1000

        # Chars -15 to -9: 250117 → Expiry 2025-01-17
        expiry_str = symbol[-15:-9]
        year = 2000 + int(expiry_str[:2])
        month = int(expiry_str[2:4])
        day = int(expiry_str[4:6])
        expiry = datetime(year, month, day)

        # Underlying symbol
        underlying = symbol[:-15]

        return underlying, expiry, opt_type, strike

    def calculate_gex(self, options_data: Dict) -> Dict:
        """Calculate GEX levels from CBOE options data.

        Args:
            options_data: CBOE API response data

        Returns:
            Dict with GEX calculations
        """
        data = options_data.get("data", {})
        spot_price = data.get("close")

        if not spot_price:
            raise ValueError("No spot price in options data")

        options = data.get("options", [])
        if not options:
            raise ValueError("No options in data")

        # Parameters
        r = 0.05  # Risk-free rate
        q = 0.01  # Dividend yield

        # Process options into DataFrame
        rows = []
        for opt in options:
            symbol = opt.get("option")
            if not symbol:
                continue

            try:
                underlying, expiry, opt_type, strike = self.parse_option_symbol(symbol)

                # Calculate time to expiration
                dte = (expiry - datetime.now()).days
                T = dte / 365.0

                if T <= 0:
                    continue

                iv = opt.get("iv", 0.25)  # Default IV if missing
                oi = opt.get("open_interest", 0)

                # Calculate gamma exposure
                gex = self.calc_gamma_ex(spot_price, strike, iv, T, r, q, opt_type, oi)

                rows.append({
                    'StrikePrice': strike,
                    'Expiry': expiry,
                    'Type': opt_type,
                    'IV': iv,
                    'OpenInt': oi,
                    'GEX': gex,
                    'DTE': dte
                })
            except Exception as e:
                logger.debug(f"Error processing option {symbol}: {e}")
                continue

        if not rows:
            raise ValueError("No valid options processed")

        df = pd.DataFrame(rows)

        # Aggregate by strike
        df_calls = df[df['Type'] == 'call'].groupby('StrikePrice').agg({
            'OpenInt': 'sum',
            'GEX': 'sum'
        }).rename(columns={'OpenInt': 'CallOI', 'GEX': 'CallGEX'})

        df_puts = df[df['Type'] == 'put'].groupby('StrikePrice').agg({
            'OpenInt': 'sum',
            'GEX': 'sum'
        }).rename(columns={'OpenInt': 'PutOI', 'GEX': 'PutGEX'})

        df_agg = pd.concat([df_calls, df_puts], axis=1).fillna(0)
        df_agg['TotalGEX'] = df_agg['CallGEX'] + df_agg['PutGEX']

        # Key levels
        call_wall = int(df_agg['CallOI'].idxmax()) if len(df_agg) > 0 else 0
        put_wall = int(df_agg['PutOI'].idxmax()) if len(df_agg) > 0 else 0

        # Find gamma flip (zero crossing)
        gamma_flip = self.find_zero_gamma_crossing(df_agg, spot_price)

        # Find support/resistance levels
        resistance = self.find_resistance_levels(df_agg, spot_price, n=5)
        support = self.find_support_levels(df_agg, spot_price, n=5)

        # Total GEX in billions
        total_gex = df_agg['TotalGEX'].sum() / 1e9

        return {
            'spot_price': spot_price,
            'total_gex': total_gex,
            'regime': 'positive' if total_gex > 0 else 'negative',
            'gamma_flip': gamma_flip,
            'call_wall': call_wall,
            'put_wall': put_wall,
            'resistance': resistance,
            'support': support
        }

    def find_zero_gamma_crossing(self, df: pd.DataFrame, spot: float) -> int:
        """Find the strike where gamma crosses zero."""
        if len(df) == 0:
            return int(spot)

        # Sort by distance from spot
        df_sorted = df.copy()
        df_sorted['Distance'] = abs(df_sorted.index - spot)
        df_sorted = df_sorted.sort_values('Distance')

        # Find where TotalGEX changes sign
        for i in range(len(df_sorted) - 1):
            if df_sorted['TotalGEX'].iloc[i] * df_sorted['TotalGEX'].iloc[i+1] < 0:
                # Linear interpolation
                strike1 = df_sorted.index[i]
                strike2 = df_sorted.index[i+1]
                gex1 = df_sorted['TotalGEX'].iloc[i]
                gex2 = df_sorted['TotalGEX'].iloc[i+1]

                zero_crossing = strike1 + (strike2 - strike1) * (-gex1 / (gex2 - gex1))
                return int(zero_crossing)

        # If no crossing found, return spot
        return int(spot)

    def find_resistance_levels(self, df: pd.DataFrame, spot: float, n: int = 5) -> List[int]:
        """Find resistance levels based on gamma and OI concentration."""
        if len(df) == 0:
            return []

        # Filter strikes above spot
        df_above = df[df.index > spot].copy()
        if len(df_above) == 0:
            return []

        # Score by CallOI + abs(TotalGEX)
        df_above['Score'] = df_above['CallOI'] + abs(df_above['TotalGEX'])

        # Get top n strikes
        top_strikes = df_above.nlargest(n, 'Score').index.tolist()
        return [int(s) for s in sorted(top_strikes)]

    def find_support_levels(self, df: pd.DataFrame, spot: float, n: int = 5) -> List[int]:
        """Find support levels based on gamma and OI concentration."""
        if len(df) == 0:
            return []

        # Filter strikes below spot
        df_below = df[df.index < spot].copy()
        if len(df_below) == 0:
            return []

        # Score by PutOI + abs(TotalGEX)
        df_below['Score'] = df_below['PutOI'] + abs(df_below['TotalGEX'])

        # Get top n strikes
        top_strikes = df_below.nlargest(n, 'Score').index.tolist()
        return [int(s) for s in sorted(top_strikes, reverse=True)]

    def translate_to_nq(self, qqq_levels: Dict) -> Dict:
        """Translate QQQ levels to NQ futures using current multiplier.

        Args:
            qqq_levels: GEX levels for QQQ

        Returns:
            Dict with NQ translated levels
        """
        try:
            # Get current NQ and QQQ prices
            nq = yf.Ticker("NQ=F")
            nq_info = nq.info
            nq_spot = nq_info.get('regularMarketPrice', 0)

            if not nq_spot:
                # Fallback to historical data
                hist = nq.history(period="1d")
                if not hist.empty:
                    nq_spot = hist['Close'].iloc[-1]

            qqq_spot = qqq_levels['spot_price']
            multiplier = nq_spot / qqq_spot if qqq_spot > 0 else 41.5  # Default multiplier

            return {
                'spot': nq_spot,
                'multiplier': multiplier,
                'gamma_flip': int(qqq_levels['gamma_flip'] * multiplier),
                'call_wall': int(qqq_levels['call_wall'] * multiplier),
                'put_wall': int(qqq_levels['put_wall'] * multiplier),
                'resistance': [int(r * multiplier) for r in qqq_levels['resistance']],
                'support': [int(s * multiplier) for s in qqq_levels['support']]
            }
        except Exception as e:
            logger.error(f"Failed to translate to NQ: {e}")
            # Return with default multiplier
            multiplier = 41.5
            return {
                'spot': qqq_levels['spot_price'] * multiplier,
                'multiplier': multiplier,
                'gamma_flip': int(qqq_levels['gamma_flip'] * multiplier),
                'call_wall': int(qqq_levels['call_wall'] * multiplier),
                'put_wall': int(qqq_levels['put_wall'] * multiplier),
                'resistance': [int(r * multiplier) for r in qqq_levels['resistance']],
                'support': [int(s * multiplier) for s in qqq_levels['support']]
            }

    async def calculate_levels(self, force: bool = False) -> GexLevels:
        """Calculate GEX levels, respecting cooldown unless forced.

        Args:
            force: Force recalculation even within cooldown

        Returns:
            GexLevels object
        """
        current_time = datetime.now().timestamp()

        # Check cooldown
        if not force and self.current_levels:
            time_since_fetch = current_time - self.last_fetch_time
            if time_since_fetch < self.cooldown_seconds:
                logger.info(f"Returning cached GEX levels (cooldown: {self.cooldown_seconds - time_since_fetch:.0f}s remaining)")
                self.current_levels.from_cache = True
                return self.current_levels

        try:
            # Fetch and calculate
            logger.info("Fetching fresh GEX levels from CBOE...")
            options_data = await self.fetch_cboe_options()
            qqq_levels = self.calculate_gex(options_data)
            nq_levels = self.translate_to_nq(qqq_levels)

            # Create GexLevels object
            self.current_levels = GexLevels(
                timestamp=datetime.now().isoformat(),
                qqq_spot=qqq_levels['spot_price'],
                nq_spot=nq_levels['spot'],
                multiplier=nq_levels['multiplier'],
                total_gex=qqq_levels['total_gex'],
                regime=qqq_levels['regime'],
                gamma_flip=nq_levels['gamma_flip'],
                call_wall=nq_levels['call_wall'],
                put_wall=nq_levels['put_wall'],
                resistance=nq_levels['resistance'],
                support=nq_levels['support'],
                from_cache=False
            )

            self.last_fetch_time = current_time
            self.save_cached_levels()

            logger.info(f"GEX levels calculated: Put Wall={nq_levels['put_wall']}, "
                       f"Call Wall={nq_levels['call_wall']}, Regime={qqq_levels['regime']}")

            return self.current_levels

        except Exception as e:
            logger.error(f"Failed to calculate GEX levels: {e}")
            if self.current_levels:
                logger.info("Returning cached GEX levels due to error")
                self.current_levels.from_cache = True
                return self.current_levels
            raise

    def should_fetch_daily(self) -> bool:
        """Check if it's time for daily fetch (4:35 PM EST)."""
        now_est = datetime.now(self.est_tz)

        # Check if it's the scheduled time
        if now_est.time() >= self.fetch_time:
            # Check if we've already fetched today after the scheduled time
            if self.last_fetch_time > 0:
                last_fetch_est = datetime.fromtimestamp(self.last_fetch_time, self.est_tz)
                if last_fetch_est.date() == now_est.date() and last_fetch_est.time() >= self.fetch_time:
                    return False
            return True
        return False

    async def run_daily_fetch(self):
        """Run daily fetch task at configured time."""
        while True:
            try:
                if self.should_fetch_daily():
                    logger.info("Running scheduled daily GEX fetch...")
                    await self.calculate_levels(force=True)

                # Check every minute
                await asyncio.sleep(60)

            except Exception as e:
                logger.error(f"Error in daily fetch task: {e}")
                await asyncio.sleep(60)