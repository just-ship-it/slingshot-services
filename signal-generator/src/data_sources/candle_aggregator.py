"""Candle aggregator for converting streaming quotes to OHLCV bars."""

import logging
import time
from datetime import datetime, timezone
from typing import Dict, Optional, Callable, List
from collections import defaultdict

from ..models.candle import Candle

logger = logging.getLogger(__name__)


class CandleBuilder:
    """Builds OHLCV candles from streaming quotes."""

    def __init__(self, symbol: str, interval_seconds: int):
        """Initialize candle builder.

        Args:
            symbol: Trading symbol
            interval_seconds: Candle interval in seconds (60 for 1m, 900 for 15m)
        """
        self.symbol = symbol
        self.interval_seconds = interval_seconds
        self.current_candle: Optional[Candle] = None
        self.current_interval_start: Optional[float] = None

    def add_quote(self, price: float, volume: float, timestamp: float) -> Optional[Candle]:
        """Add a quote and return completed candle if interval finished.

        Args:
            price: Quote price
            volume: Quote volume
            timestamp: Quote timestamp

        Returns:
            Completed candle if interval finished, None otherwise
        """
        # Calculate current interval start time
        interval_start = int(timestamp // self.interval_seconds) * self.interval_seconds

        # Check if we're starting a new interval
        if self.current_interval_start is None or interval_start > self.current_interval_start:
            # Complete previous candle if it exists
            completed_candle = self.current_candle

            # Start new candle
            self.current_interval_start = interval_start
            self.current_candle = Candle(
                symbol=self.symbol,
                timestamp=interval_start,
                open=price,
                high=price,
                low=price,
                close=price,
                volume=volume,
                timeframe=f"{self.interval_seconds // 60}m" if self.interval_seconds >= 60 else f"{self.interval_seconds}s"
            )

            return completed_candle

        # Update current candle
        if self.current_candle:
            self.current_candle.high = max(self.current_candle.high, price)
            self.current_candle.low = min(self.current_candle.low, price)
            self.current_candle.close = price
            self.current_candle.volume += volume

        return None


class CandleAggregator:
    """Aggregates streaming quotes into OHLCV candles with multiple timeframes."""

    def __init__(self):
        """Initialize candle aggregator."""
        # Candle builders for different timeframes
        self.builders_1m: Dict[str, CandleBuilder] = {}
        self.builders_15m: Dict[str, CandleBuilder] = {}

        # Callbacks for completed candles
        self.candle_1m_callbacks: List[Callable[[Candle], None]] = []
        self.candle_15m_callbacks: List[Callable[[Candle], None]] = []

        # Symbol conversion mapping (TradingView symbol -> Trading symbol)
        self.symbol_mapping = {
            'CME_MINI:NQ1!': 'NQ',
            'CME_MINI:MNQ1!': 'MNQ',
            'CME_MINI:ES1!': 'ES',
            'CME_MINI:MES1!': 'MES',
            'BITSTAMP:BTCUSD': 'BTC'
        }

        logger.info("CandleAggregator initialized")

    def add_candle_1m_callback(self, callback: Callable[[Candle], None]):
        """Add callback for 1-minute candle completions."""
        self.candle_1m_callbacks.append(callback)

    def add_candle_15m_callback(self, callback: Callable[[Candle], None]):
        """Add callback for 15-minute candle completions."""
        self.candle_15m_callbacks.append(callback)

    def get_trading_symbol(self, tv_symbol: str) -> str:
        """Convert TradingView symbol to trading symbol.

        Args:
            tv_symbol: TradingView symbol like 'CME_MINI:NQ1!'

        Returns:
            Trading symbol like 'NQ'
        """
        base_symbol = self.symbol_mapping.get(tv_symbol)
        if base_symbol:
            return base_symbol

        # Fallback: extract from symbol format
        if ':' in tv_symbol:
            symbol_part = tv_symbol.split(':')[1]
            return symbol_part.replace('1!', '')

        return tv_symbol

    def add_quote(self, tv_symbol: str, price: float, volume: float = 0, timestamp: Optional[float] = None):
        """Add a quote and trigger candle building.

        Args:
            tv_symbol: TradingView symbol
            price: Quote price
            volume: Quote volume (default 0 if not available)
            timestamp: Quote timestamp (default current time)
        """
        if timestamp is None:
            timestamp = time.time()

        # Convert symbol
        trading_symbol = self.get_trading_symbol(tv_symbol)

        # Create builders if they don't exist
        if trading_symbol not in self.builders_1m:
            self.builders_1m[trading_symbol] = CandleBuilder(trading_symbol, 60)  # 1 minute
            logger.info(f"Created 1m candle builder for {trading_symbol}")

        if trading_symbol not in self.builders_15m:
            self.builders_15m[trading_symbol] = CandleBuilder(trading_symbol, 900)  # 15 minutes
            logger.info(f"Created 15m candle builder for {trading_symbol}")

        # Process 1-minute candles
        completed_1m = self.builders_1m[trading_symbol].add_quote(price, volume, timestamp)
        if completed_1m:
            logger.info(f"Completed 1m candle for {trading_symbol}: {completed_1m.close} @ {datetime.fromtimestamp(completed_1m.timestamp)}")
            for callback in self.candle_1m_callbacks:
                try:
                    callback(completed_1m)
                except Exception as e:
                    logger.error(f"Error in 1m candle callback: {e}")

        # Process 15-minute candles
        completed_15m = self.builders_15m[trading_symbol].add_quote(price, volume, timestamp)
        if completed_15m:
            logger.info(f"Completed 15m candle for {trading_symbol}: {completed_15m.close} @ {datetime.fromtimestamp(completed_15m.timestamp)}")
            for callback in self.candle_15m_callbacks:
                try:
                    # Check if callback is async
                    import asyncio
                    if asyncio.iscoroutinefunction(callback):
                        # Get the current event loop
                        try:
                            loop = asyncio.get_running_loop()
                            # Schedule the coroutine in the running event loop
                            asyncio.run_coroutine_threadsafe(callback(completed_15m), loop)
                        except RuntimeError:
                            # No running loop, create a task for later execution
                            logger.warning("No running event loop for async callback, queuing for later")
                    else:
                        # Call sync callback
                        callback(completed_15m)
                except Exception as e:
                    logger.error(f"Error in 15m candle callback: {e}")

    def get_current_candles(self) -> Dict[str, Dict[str, Candle]]:
        """Get current incomplete candles for all symbols and timeframes.

        Returns:
            Dict with structure: {symbol: {'1m': candle, '15m': candle}}
        """
        result = defaultdict(dict)

        for symbol, builder in self.builders_1m.items():
            if builder.current_candle:
                result[symbol]['1m'] = builder.current_candle

        for symbol, builder in self.builders_15m.items():
            if builder.current_candle:
                result[symbol]['15m'] = builder.current_candle

        return dict(result)

    def reset_symbol(self, symbol: str):
        """Reset candle builders for a specific symbol."""
        trading_symbol = self.get_trading_symbol(symbol)

        if trading_symbol in self.builders_1m:
            del self.builders_1m[trading_symbol]

        if trading_symbol in self.builders_15m:
            del self.builders_15m[trading_symbol]

        logger.info(f"Reset candle builders for {trading_symbol}")

    def get_stats(self) -> Dict[str, Dict]:
        """Get aggregator statistics.

        Returns:
            Statistics about active builders and current candles
        """
        return {
            'active_symbols': list(set(list(self.builders_1m.keys()) + list(self.builders_15m.keys()))),
            'builders_1m': len(self.builders_1m),
            'builders_15m': len(self.builders_15m),
            'callbacks_1m': len(self.candle_1m_callbacks),
            'callbacks_15m': len(self.candle_15m_callbacks),
            'current_candles': self.get_current_candles()
        }