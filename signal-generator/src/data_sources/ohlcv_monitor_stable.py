"""OHLCV data monitor for TradingView real-time quotes with stable threading."""

import logging
import threading
import asyncio
import queue
from typing import List, Optional, Callable, Dict, Any
from datetime import datetime
from tradingview_scraper.symbols.stream import Streamer

from ..models.candle import Candle
from .candle_aggregator import CandleAggregator
from .historical_archiver import HistoricalArchiver
from ..config import Config

logger = logging.getLogger(__name__)


class OHLCVMonitor:
    """Monitor real-time OHLCV data from TradingView with stable threading."""

    def __init__(self, jwt_token: str, symbols: List[str], redis_publisher=None):
        """Initialize OHLCV monitor.

        Args:
            jwt_token: Valid TradingView JWT token
            symbols: List of symbols like ["CME_MINI:NQ1!", "CME_MINI:ES1!"]
            redis_publisher: Redis publisher for publishing updates
        """
        self.jwt_token = jwt_token
        self.symbols = symbols
        self.redis_publisher = redis_publisher
        self.candle_close_callback: Optional[Callable] = None
        self.running = False
        self.current_candles: Dict[str, Candle] = {}
        self.last_candle_time: Dict[str, float] = {}
        self.threads: List[threading.Thread] = []

        # Thread-safe queue for passing data from threads to async task
        self.data_queue = queue.Queue()
        self.publisher_task = None

        # Initialize candle aggregator
        self.candle_aggregator = CandleAggregator()

        # Initialize historical archiver if enabled
        self.historical_archiver = None
        if Config.ENABLE_HISTORICAL_ARCHIVING:
            self.historical_archiver = HistoricalArchiver(Config.HISTORICAL_DATA_DIRECTORY)
            # Update contract mappings from config
            self.historical_archiver.update_contract_mappings(Config.CONTRACT_MAPPINGS)
            # Set target symbols from config
            self.historical_archiver.target_symbols = set(Config.ARCHIVE_SYMBOLS)

            # Add archiver as callback for 1-minute candles
            self.candle_aggregator.add_candle_1m_callback(self.historical_archiver.archive_candle)
            logger.info("Historical archiving enabled")

        # Add strategy callback for 15-minute candles
        self.candle_aggregator.add_candle_15m_callback(self._handle_15m_candle_sync)

    def set_candle_close_callback(self, callback: Callable[[Candle], None]):
        """Set callback for candle close events."""
        self.candle_close_callback = callback

    def _handle_15m_candle_sync(self, candle: Candle):
        """Handle completed 15-minute candle (sync version for thread-safe calling).

        Args:
            candle: Completed 15-minute candle
        """
        try:
            # Queue candle close for async processing
            self.data_queue.put({
                'type': 'candle_close',
                'data': candle.to_dict(),
                'callback': self.candle_close_callback
            })

            logger.info(f"Queued 15m candle close: {candle.symbol} @ {candle.close}")

        except Exception as e:
            logger.error(f"Error handling 15m candle: {e}")

    async def _handle_15m_candle(self, candle: Candle):
        """Handle completed 15-minute candle (async version).

        Args:
            candle: Completed 15-minute candle
        """
        try:
            # Call strategy callback if set
            if self.candle_close_callback:
                await self.candle_close_callback(candle)

            # Publish to Redis
            if self.redis_publisher:
                await self.redis_publisher.publish_candle_close(candle.to_dict())

            logger.info(f"Processed 15m candle close: {candle.symbol} @ {candle.close}")

        except Exception as e:
            logger.error(f"Error handling 15m candle: {e}")

    def _process_quote(self, symbol_full: str, price: float, volume: float = 0):
        """Process a quote through the candle aggregator.

        Args:
            symbol_full: Full TradingView symbol
            price: Quote price
            volume: Quote volume
        """
        try:
            # Add quote to aggregator
            self.candle_aggregator.add_quote(symbol_full, price, volume)

        except Exception as e:
            logger.error(f"Error processing quote for {symbol_full}: {e}")

    def parse_quote_data(self, packet: Any) -> Optional[Dict]:
        """Parse quote data from websocket packet."""
        # Try parsing as quote data first
        if isinstance(packet, dict) and packet.get('m') == 'qsd':
            p_data = packet.get('p', [])
            if len(p_data) >= 2:
                quote_data = p_data[1]
                symbol = quote_data.get('n')
                values = quote_data.get('v', {})

                return {
                    'symbol': symbol,
                    'last': values.get('lp'),
                    'bid': values.get('bid'),
                    'ask': values.get('ask'),
                    'volume': values.get('volume'),
                    'open': values.get('open_price'),
                    'high': values.get('high_price'),
                    'low': values.get('low_price'),
                    'prev_close': values.get('prev_close_price'),
                    'change': values.get('ch'),
                    'change_percent': values.get('chp'),
                    'timestamp': datetime.now().timestamp()
                }

        # Try parsing as OHLCV bar data
        if isinstance(packet, dict) and packet.get('m') == 'du':
            p_data = packet.get('p', [])
            if len(p_data) >= 2:
                data_update = p_data[1]
                # Look for sds_1 which contains the series data
                sds_data = data_update.get('sds_1', {})
                series = sds_data.get('s', [])
                if series and len(series) > 0:
                    # Get the latest bar
                    latest_bar = series[-1]
                    values = latest_bar.get('v', [])
                    # v = [timestamp, open, high, low, close, volume]
                    if len(values) >= 5:
                        return {
                            'last': values[4],  # close price
                            'open': values[1],
                            'high': values[2],
                            'low': values[3],
                            'volume': values[5] if len(values) > 5 else 0,
                            'timestamp': datetime.now().timestamp()
                        }

        return None

    def check_candle_close(self, symbol: str, timestamp: float) -> bool:
        """Check if a 15-minute candle has closed."""
        current_interval = int(timestamp // 900) * 900  # 900 seconds = 15 minutes
        last_interval = self.last_candle_time.get(symbol, 0)

        if current_interval > last_interval:
            self.last_candle_time[symbol] = current_interval
            return True
        return False

    def stream_symbol_thread(self, symbol_full: str):
        """Stream OHLCV data for a single symbol in a thread."""
        # Parse exchange:symbol format
        parts = symbol_full.split(':')
        exchange = parts[0] if len(parts) > 1 else "CME_MINI"
        symbol = parts[1] if len(parts) > 1 else parts[0]

        logger.info(f"Starting OHLCV thread for {exchange}:{symbol}")

        # Track last update time for health monitoring
        last_update = datetime.now()

        try:
            streamer = Streamer(
                export_result=False,
                websocket_jwt_token=self.jwt_token
            )

            for packet in streamer.stream(
                exchange=exchange,
                symbol=symbol,
                timeframe="1m",
                numb_price_candles=1,
                indicators=[]
            ):
                if not self.running:
                    break

                # Parse quote data
                quote_data = self.parse_quote_data(packet)

                if quote_data and quote_data.get('last'):
                    # Convert symbol format
                    if "BTCUSD" in symbol:
                        base_symbol = "BTC"
                    else:
                        base_symbol = symbol.replace("1!", "")

                    price_update = {
                        'type': 'price_update',
                        'data': {
                            'symbol': symbol_full,
                            'baseSymbol': base_symbol,
                            'close': quote_data['last'],
                            'open': quote_data.get('open'),
                            'high': quote_data.get('high'),
                            'low': quote_data.get('low'),
                            'previousClose': quote_data.get('prev_close'),
                            'volume': quote_data.get('volume'),
                            'timestamp': datetime.now().isoformat(),
                            'source': 'tradingview'
                        }
                    }

                    # Process quote through candle aggregator
                    volume = quote_data.get('volume', 0) or 0
                    self._process_quote(symbol_full, quote_data['last'], volume)

                    # Queue price update for async publishing
                    if self.redis_publisher:
                        self.data_queue.put({
                            'type': 'price_update',
                            'data': price_update['data']
                        })
                        # Reduced logging for high-frequency price updates

                    last_update = datetime.now()
                    # Quote received and processed

                # Check if we haven't received data in 30 seconds
                if (datetime.now() - last_update).seconds > 30:
                    logger.warning(f"No data received for {symbol_full} in 30 seconds, restarting stream")
                    break

        except Exception as e:
            logger.error(f"Error in OHLCV thread for {symbol_full}: {e}")
        finally:
            logger.info(f"OHLCV thread for {symbol_full} ended")

            # If still running, restart the thread
            if self.running:
                logger.info(f"Restarting thread for {symbol_full}")
                new_thread = threading.Thread(
                    target=self.stream_symbol_thread,
                    args=(symbol_full,),
                    daemon=True
                )
                new_thread.start()

    async def publisher_task_handler(self):
        """Async task to consume queue and publish to Redis."""
        logger.info("Starting publisher task")

        while self.running:
            try:
                # Check queue with timeout (non-blocking)
                try:
                    item = self.data_queue.get_nowait()
                except queue.Empty:
                    await asyncio.sleep(0.1)
                    continue

                # Process the item
                # Processing queue item
                if item['type'] == 'price_update' and self.redis_publisher:
                    await self.redis_publisher.publish_price_update(item['data'])
                    # Price update published to Redis
                elif item['type'] == 'candle_close':
                    # Handle candle close with both Redis and callback
                    candle_data = item['data']

                    # Publish to Redis
                    if self.redis_publisher:
                        await self.redis_publisher.publish_candle_close(candle_data)
                        logger.info(f"📡 Published candle close for {candle_data['symbol']}")

                    # Call strategy callback if provided
                    callback = item.get('callback')
                    if callback:
                        # Reconstruct candle object for callback
                        from ..models.candle import Candle
                        candle = Candle.from_dict(candle_data)
                        await callback(candle)
                        logger.info(f"🧠 Called strategy callback for {candle.symbol}")

            except Exception as e:
                logger.error(f"Error in publisher task: {e}")
                await asyncio.sleep(1)

        logger.info("Publisher task ended")

    async def start(self):
        """Start monitoring OHLCV data."""
        self.running = True
        logger.info(f"Starting OHLCV monitor for symbols: {self.symbols}")

        # Start publisher task
        self.publisher_task = asyncio.create_task(self.publisher_task_handler())

        # Start streaming threads for each symbol
        for symbol_full in self.symbols:
            thread = threading.Thread(
                target=self.stream_symbol_thread,
                args=(symbol_full,),
                daemon=True
            )
            thread.start()
            self.threads.append(thread)

        # Keep main task alive
        while self.running:
            await asyncio.sleep(1)

    async def stop(self):
        """Stop monitoring OHLCV data."""
        self.running = False

        # Wait for publisher task to finish
        if self.publisher_task:
            await self.publisher_task

        # Close archiver files
        if self.historical_archiver:
            self.historical_archiver.close_all_files()
            logger.info("Historical archiver closed")

        logger.info("OHLCV monitor stopped")

    def get_current_candle(self, symbol: str) -> Optional[Candle]:
        """Get the current candle for a symbol."""
        return self.current_candles.get(symbol)

    def get_aggregator_stats(self) -> Dict:
        """Get candle aggregator statistics."""
        return self.candle_aggregator.get_stats()

    def get_archiver_stats(self) -> Optional[Dict]:
        """Get historical archiver statistics."""
        if self.historical_archiver:
            return self.historical_archiver.get_stats()
        return None