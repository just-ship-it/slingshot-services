"""Liquidity Trigger level monitor for TradingView."""

import asyncio
import logging
from typing import Optional, Callable, Dict, Any
from datetime import datetime
from tradingview_scraper.symbols.stream import Streamer

from ..models.levels import LTLevels

logger = logging.getLogger(__name__)

# Liquidity Triggers indicator by DeepDiveStocks
LIQUIDITY_TRIGGER_INDICATOR = ("PUB;7e87924bf26940f3b0e4e245ec9e30b2", "1")


class LTMonitor:
    """Monitor Liquidity Trigger levels from TradingView."""

    def __init__(self, jwt_token: str, symbol: str = "NQ1!",
                 exchange: str = "CME_MINI", timeframe: str = "15"):
        """Initialize LT monitor.

        Args:
            jwt_token: Valid TradingView JWT token
            symbol: Symbol to monitor (default NQ1!)
            exchange: Exchange (default CME_MINI)
            timeframe: Timeframe in minutes (default 15)
        """
        self.jwt_token = jwt_token
        self.symbol = symbol
        self.exchange = exchange
        self.timeframe = timeframe
        self.callback: Optional[Callable] = None
        self.current_levels: Optional[LTLevels] = None
        self.streamer: Optional[Streamer] = None
        self.running = False
        self.main_loop = None  # Store main event loop reference

    def set_callback(self, callback: Callable[[LTLevels], None]):
        """Set callback for LT level updates."""
        self.callback = callback

    def parse_lt_levels(self, packet: Any) -> Optional[LTLevels]:
        """Parse Liquidity Trigger levels from websocket packet.

        Args:
            packet: Websocket packet data

        Returns:
            LTLevels object or None if not an LT update
        """
        if not isinstance(packet, dict) or packet.get('m') != 'du':
            return None

        p_data = packet.get('p', [])
        if len(p_data) < 2 or not isinstance(p_data[1], dict):
            return None

        # LT data comes in 'st9' key
        st9_data = p_data[1].get('st9', {})
        if 'st' not in st9_data:
            return None

        latest_data = st9_data['st']
        if not latest_data:
            return None

        most_recent = max(latest_data, key=lambda x: x['i'])

        values = most_recent['v']
        timestamp = values[0]

        # Levels are at positions: 5, 7, 9, 11, 13, 15, 17 in the values array
        level_positions = [5, 7, 9, 11, 13, 15, 17]
        level_names = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']
        levels_dict = {}

        for name, pos in zip(level_names, level_positions):
            if pos < len(values):
                level_value = values[pos]
                if level_value != 1e+100:  # Skip invalid/empty values
                    levels_dict[name] = level_value
                else:
                    levels_dict[name] = None
            else:
                levels_dict[name] = None

        return LTLevels(
            timestamp=timestamp,
            candle_time=datetime.fromtimestamp(timestamp).isoformat(),
            **levels_dict
        )

    def _blocking_stream_levels(self):
        """Stream LT levels from TradingView (blocking, runs in thread)."""
        try:
            self.streamer = Streamer(export_result=False, websocket_jwt_token=self.jwt_token)

            data_gen = self.streamer.stream(
                exchange=self.exchange,
                symbol=self.symbol,
                timeframe=self.timeframe,
                numb_price_candles=2,
                indicators=[LIQUIDITY_TRIGGER_INDICATOR]
            )

            last_timestamp = None

            for packet in data_gen:
                if not self.running:
                    break

                lt_data = self.parse_lt_levels(packet)

                if lt_data and lt_data.timestamp != last_timestamp:
                    last_timestamp = lt_data.timestamp
                    self.current_levels = lt_data

                    logger.info(f"LT levels updated: {lt_data.get_all_levels()}")

                    # Schedule callback in main event loop
                    if self.callback and self.main_loop:
                        # Schedule callback to run in the main loop from this thread
                        try:
                            asyncio.run_coroutine_threadsafe(self.callback(lt_data), self.main_loop)
                        except Exception as e:
                            logger.warning(f"Failed to schedule LT callback: {e}")

        except Exception as e:
            logger.error(f"Error streaming LT levels: {e}")
            raise

    async def stream_levels(self):
        """Stream LT levels from TradingView (async wrapper)."""
        import concurrent.futures

        # Run the blocking stream in a thread pool
        with concurrent.futures.ThreadPoolExecutor() as executor:
            await asyncio.get_event_loop().run_in_executor(
                executor, self._blocking_stream_levels
            )

    async def start(self):
        """Start monitoring LT levels."""
        self.running = True
        # Store reference to main event loop
        self.main_loop = asyncio.get_running_loop()
        logger.info(f"Starting LT monitor for {self.exchange}:{self.symbol} on {self.timeframe}m")
        await self.stream_levels()

    async def stop(self):
        """Stop monitoring LT levels."""
        self.running = False
        if self.streamer:
            # Streamer doesn't have an explicit close method, setting running=False will break the loop
            pass
        logger.info("LT monitor stopped")

    def get_current_levels(self) -> Optional[LTLevels]:
        """Get the current LT levels."""
        return self.current_levels