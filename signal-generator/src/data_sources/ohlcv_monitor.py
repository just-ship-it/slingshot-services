"""OHLCV data monitor for TradingView real-time quotes."""

import logging
import threading
from typing import List, Optional, Callable, Dict, Any
from datetime import datetime
from tradingview_scraper.symbols.stream import Streamer

from ..models.candle import Candle

logger = logging.getLogger(__name__)


class OHLCVMonitor:
    """Monitor real-time OHLCV data from TradingView."""

    def __init__(self, jwt_token: str, symbols: List[str], redis_publisher=None):
        """Initialize OHLCV monitor.

        Args:
            jwt_token: Valid TradingView JWT token
            symbols: List of symbols like ["CME_MINI:NQ1!", "CME_MINI:ES1!"]
            redis_publisher: Redis publisher for direct publishing from threads
        """
        self.jwt_token = jwt_token
        self.symbols = symbols
        self.redis_publisher = redis_publisher
        self.candle_close_callback: Optional[Callable] = None
        self.running = False
        self.current_candles: Dict[str, Candle] = {}
        self.last_candle_time: Dict[str, float] = {}
        self.threads: List[threading.Thread] = []

    def set_candle_close_callback(self, callback: Callable[[Candle], None]):
        """Set callback for candle close events."""
        self.candle_close_callback = callback

    def parse_quote_data(self, packet: Any) -> Optional[Dict]:
        """Parse quote data from websocket packet.

        Args:
            packet: Websocket packet data

        Returns:
            Quote data dict or None
        """
        if isinstance(packet, dict) and packet.get('m') == 'qsd':
            p_data = packet.get('p', [])
            if len(p_data) >= 2:
                quote_data = p_data[1]
                symbol = quote_data.get('n')
                values = quote_data.get('v', {})

                # Extract relevant quote fields
                return {
                    'symbol': symbol,
                    'last': values.get('lp'),  # Last price
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
        return None

    def check_candle_close(self, symbol: str, timestamp: float) -> bool:
        """Check if a 15-minute candle has closed.

        Args:
            symbol: Symbol name
            timestamp: Current timestamp

        Returns:
            True if candle closed, False otherwise
        """
        # Calculate 15-minute intervals
        current_interval = int(timestamp // 900) * 900  # 900 seconds = 15 minutes
        last_interval = self.last_candle_time.get(symbol, 0)

        if current_interval > last_interval:
            self.last_candle_time[symbol] = current_interval
            return True
        return False

    def create_candle_from_quote(self, quote: Dict) -> Candle:
        """Create a candle object from quote data.

        Args:
            quote: Quote data dict

        Returns:
            Candle object
        """
        return Candle(
            symbol=quote['symbol'],
            timestamp=quote['timestamp'],
            open=quote.get('open', quote['last']),
            high=quote.get('high', quote['last']),
            low=quote.get('low', quote['last']),
            close=quote['last'],
            volume=quote.get('volume', 0),
            timeframe="15"
        )

    def stream_symbol_thread(self, symbol_full: str):
        """Stream OHLCV data for a single symbol in a thread."""
        # Parse exchange:symbol format
        parts = symbol_full.split(':')
        exchange = parts[0] if len(parts) > 1 else "CME_MINI"
        symbol = parts[1] if len(parts) > 1 else parts[0]

        logger.info(f"Starting OHLCV thread for {exchange}:{symbol}")

        try:
            streamer = Streamer(
                export_result=False,
                websocket_jwt_token=self.jwt_token
            )

            # Stream real-time quotes (not OHLCV bars)
            for packet in streamer.stream(
                exchange=exchange,
                symbol=symbol,
                timeframe="1m",  # Use 1m for real-time updates
                numb_price_candles=1,
                indicators=[]  # No indicators, just price data
            ):
                if not self.running:
                    break

                # Try parsing as both quote data and OHLCV data
                quote_data = self.parse_quote_data(packet)
                ohlcv_data = self.parse_ohlcv_packet(packet, symbol_full)

                # Process quote data for real-time updates
                if quote_data and quote_data.get('last'):
                    logger.info(f"Processing quote data for {symbol_full}: last={quote_data.get('last')}")

                    # Create price update in market-data-service expected format
                    # Convert TradingView symbol format to base symbol
                    if "BTCUSD" in symbol:
                        base_symbol = "BTC"  # BITSTAMP:BTCUSD -> BTC
                    else:
                        base_symbol = symbol.replace("1!", "")  # NQ1! -> NQ, ES1! -> ES

                    price_update = {
                        'symbol': symbol_full,              # Full TradingView symbol
                        'baseSymbol': base_symbol,           # Base symbol for dashboard
                        'close': quote_data['last'],         # Current price as 'close'
                        'open': quote_data.get('open'),      # Daily open
                        'high': quote_data.get('high'),      # Daily high
                        'low': quote_data.get('low'),        # Daily low
                        'previousClose': quote_data.get('prev_close'),
                        'volume': quote_data.get('volume'),
                        'timestamp': datetime.now().isoformat(),
                        'source': 'tradingview'
                    }

                    # Publish to Redis directly using asyncio.run()
                    if self.redis_publisher:
                        try:
                            import asyncio
                            asyncio.run(self.redis_publisher.publish_price_update(price_update))
                        except Exception as e:
                            logger.error(f"Failed to publish price update: {e}")

                # Process OHLCV bar data for candle closes
                elif ohlcv_data:
                    logger.info(f"Processing OHLCV data for {symbol_full}: close={ohlcv_data.get('close')}")

                    # Create candle and update cache
                    candle = self.create_candle_from_ohlcv(ohlcv_data)
                    self.current_candles[symbol_full] = candle

                    # Check for 15-minute candle close
                    if self.check_candle_close(symbol_full, datetime.now().timestamp()):
                        logger.info(f"15-minute candle closed for {symbol_full}")
                        if self.candle_close_callback:
                            # Call async callback in thread-safe way
                            import asyncio
                            try:
                                asyncio.run(self.candle_close_callback(candle))
                            except Exception as e:
                                logger.error(f"Error calling candle close callback: {e}")

                        # Publish candle close to Redis
                        if self.redis_publisher:
                            try:
                                import asyncio
                                asyncio.run(self.redis_publisher.publish_candle_close(candle.to_dict()))
                            except Exception as e:
                                logger.error(f"Failed to publish candle close: {e}")
                else:
                    # Log raw packet for debugging (use info temporarily for visibility)
                    if not str(packet).startswith("~h~"):  # Skip heartbeats
                        logger.info(f"DEBUG: Raw packet for {symbol_full}: {packet}")

        except Exception as e:
            logger.error(f"Error in OHLCV thread for {symbol_full}: {e}")

    async def process_packets(self):
        """Process packets from the queue."""
        logger.info("Starting packet processor")
        while self.running:
            try:
                # Check for packet with timeout (non-blocking)
                try:
                    symbol_full, packet = self.packet_queue.get_nowait()
                except queue.Empty:
                    await asyncio.sleep(0.1)  # Small delay to prevent busy waiting
                    continue

                # Parse OHLCV from packet
                ohlcv_data = self.parse_ohlcv_packet(packet, symbol_full)

                if ohlcv_data:
                    logger.info(f"Processing OHLCV data for {symbol_full}: price={ohlcv_data.get('close')}")

                    # Update current candle
                    candle = self.create_candle_from_ohlcv(ohlcv_data)
                    self.current_candles[symbol_full] = candle

                    # Check for 15-minute candle close
                    timestamp = datetime.now()
                    if self.check_candle_close(symbol_full, timestamp):
                        logger.info(f"15-minute candle closed for {symbol_full}")
                        if self.candle_close_callback:
                            await self.candle_close_callback(candle)

                    # Send quote update
                    if self.callback:
                        await self.callback(ohlcv_data)

            except Exception as e:
                logger.error(f"Error processing packet: {e}")

    async def start(self):
        """Start monitoring OHLCV data."""
        self.running = True
        logger.info(f"Starting OHLCV monitor for symbols: {self.symbols}")

        # Start streaming threads for each symbol
        for symbol_full in self.symbols:
            thread = threading.Thread(
                target=self.stream_symbol_thread,
                args=(symbol_full,),
                daemon=True
            )
            thread.start()
            self.threads.append(thread)

        # Keep main task alive while threads run
        import asyncio
        while self.running:
            await asyncio.sleep(1)

    async def stop(self):
        """Stop monitoring OHLCV data."""
        self.running = False
        logger.info("OHLCV monitor stopped")

    def get_current_candle(self, symbol: str) -> Optional[Candle]:
        """Get the current candle for a symbol."""
        return self.current_candles.get(symbol)

    def parse_ohlcv_packet(self, packet: Dict, symbol: str) -> Optional[Dict]:
        """Parse OHLCV data packet from streamer."""
        try:
            # Packet structure from streamer contains 'data' with candle info
            if isinstance(packet, dict) and 'data' in packet:
                data = packet['data']
                if isinstance(data, list) and len(data) > 0:
                    candle_data = data[0]  # Get latest candle

                    return {
                        'symbol': symbol,
                        'timestamp': datetime.now().isoformat(),
                        'open': candle_data.get('o'),
                        'high': candle_data.get('h'),
                        'low': candle_data.get('l'),
                        'close': candle_data.get('c'),
                        'volume': candle_data.get('v', 0)
                    }

            # Fallback: extract price info if available
            if isinstance(packet, dict) and 'lp' in packet:
                return {
                    'symbol': symbol,
                    'timestamp': datetime.now().isoformat(),
                    'open': packet.get('lp'),
                    'high': packet.get('lp'),
                    'low': packet.get('lp'),
                    'close': packet.get('lp'),
                    'volume': packet.get('volume', 0)
                }

        except Exception as e:
            logger.debug(f"Failed to parse OHLCV packet for {symbol}: {e}")

        return None

    def create_candle_from_ohlcv(self, ohlcv_data: Dict) -> Candle:
        """Create a Candle object from OHLCV data."""
        return Candle(
            symbol=ohlcv_data['symbol'],
            timestamp=datetime.fromisoformat(ohlcv_data['timestamp'].replace('Z', '+00:00')),
            open=float(ohlcv_data['open'] or 0),
            high=float(ohlcv_data['high'] or 0),
            low=float(ohlcv_data['low'] or 0),
            close=float(ohlcv_data['close'] or 0),
            volume=int(ohlcv_data.get('volume', 0))
        )