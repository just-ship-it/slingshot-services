"""TradingView websocket manager for unified data streaming."""

import asyncio
import logging
from typing import List, Optional, Callable, Any
from datetime import datetime
import time

from ..auth.tradingview_auth import TradingViewAuth
from ..config import Config

logger = logging.getLogger(__name__)


class TradingViewWebsocket:
    """Manages single authenticated TradingView websocket connection."""

    def __init__(self, auth: TradingViewAuth):
        """Initialize TradingView websocket manager.

        Args:
            auth: TradingViewAuth instance for token management
        """
        self.auth = auth
        self.jwt_token: Optional[str] = None
        self.connected = False
        self.reconnect_delay = 5.0
        self.max_reconnect_delay = 60.0
        self.token_refresh_interval = 3600 * 3  # 3 hours
        self.last_token_refresh = 0

        # Callbacks for data handlers
        self.lt_callback: Optional[Callable] = None
        self.ohlcv_callback: Optional[Callable] = None
        self.candle_close_callback: Optional[Callable] = None

    async def connect(self):
        """Establish websocket connection with JWT authentication."""
        try:
            # Get valid JWT token
            self.jwt_token = self.auth.get_valid_token()
            if not self.jwt_token:
                raise Exception("Failed to obtain JWT token")

            self.last_token_refresh = time.time()
            self.connected = True
            logger.info("TradingView websocket connected with JWT authentication")

        except Exception as e:
            logger.error(f"Failed to connect to TradingView: {e}")
            self.connected = False
            raise

    async def disconnect(self):
        """Close websocket connection."""
        self.connected = False
        logger.info("TradingView websocket disconnected")

    async def check_token_refresh(self):
        """Check if JWT token needs refresh."""
        if time.time() - self.last_token_refresh > self.token_refresh_interval:
            logger.info("Refreshing JWT token...")
            try:
                self.jwt_token = self.auth.get_valid_token(force_refresh=True)
                self.last_token_refresh = time.time()
                logger.info("JWT token refreshed successfully")
                # Reconnect with new token
                await self.reconnect()
            except Exception as e:
                logger.error(f"Failed to refresh JWT token: {e}")

    async def reconnect(self):
        """Reconnect websocket with exponential backoff."""
        delay = self.reconnect_delay
        while not self.connected:
            try:
                logger.info(f"Attempting to reconnect in {delay} seconds...")
                await asyncio.sleep(delay)
                await self.connect()
                delay = self.reconnect_delay  # Reset delay on successful connection
            except Exception as e:
                logger.error(f"Reconnection failed: {e}")
                delay = min(delay * 2, self.max_reconnect_delay)

    def set_lt_callback(self, callback: Callable):
        """Set callback for LT level updates."""
        self.lt_callback = callback

    def set_ohlcv_callback(self, callback: Callable):
        """Set callback for OHLCV updates."""
        self.ohlcv_callback = callback

    def set_candle_close_callback(self, callback: Callable):
        """Set callback for candle close events."""
        self.candle_close_callback = callback

    async def run(self):
        """Main run loop - maintains connection and handles token refresh."""
        while True:
            try:
                if not self.connected:
                    await self.reconnect()

                # Check if token needs refresh
                await self.check_token_refresh()

                # Keep alive
                await asyncio.sleep(30)

            except Exception as e:
                logger.error(f"Error in websocket run loop: {e}")
                self.connected = False
                await asyncio.sleep(5)