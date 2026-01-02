"""Redis publisher for distributing data to other services."""

import json
import asyncio
import logging
from typing import Any, Dict, Optional
import redis.asyncio as redis
from datetime import datetime

logger = logging.getLogger(__name__)


class RedisPublisher:
    """Async Redis client for publishing messages to channels."""

    # Channel names (matching existing system)
    CHANNELS = {
        # Existing channels
        'TRADE_SIGNAL': 'trade.signal',
        'PRICE_UPDATE': 'price.update',
        'POSITION_UPDATE': 'position.update',
        'ORDER_REQUEST': 'order.request',
        'SERVICE_HEALTH': 'service.health',
        'SERVICE_ERROR': 'service.error',

        # New channels for this service
        'LT_LEVELS': 'lt.levels',
        'GEX_LEVELS': 'gex.levels',
        'CANDLE_CLOSE': 'candle.close',
        'GEX_REFRESH': 'gex.refresh',
    }

    def __init__(self, redis_url: str):
        """Initialize Redis publisher.

        Args:
            redis_url: Redis connection URL (e.g., "redis://localhost:6379")
        """
        self.redis_url = redis_url
        self.client: Optional[redis.Redis] = None
        self.pubsub: Optional[redis.client.PubSub] = None
        self._connected = False

    async def connect(self):
        """Connect to Redis."""
        try:
            self.client = await redis.from_url(self.redis_url, decode_responses=True)
            self.pubsub = self.client.pubsub()
            await self.client.ping()
            self._connected = True
            logger.info(f"Connected to Redis at {self.redis_url}")
        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            raise

    async def disconnect(self):
        """Disconnect from Redis."""
        if self.pubsub:
            await self.pubsub.close()
        if self.client:
            await self.client.close()
        self._connected = False
        logger.info("Disconnected from Redis")

    async def publish(self, channel: str, data: Any):
        """Publish data to a Redis channel.

        Args:
            channel: Channel name or key from CHANNELS dict
            data: Data to publish (will be JSON serialized)
        """
        if not self._connected:
            logger.error("Not connected to Redis")
            return

        # Check if channel is a key in CHANNELS dict
        if channel in self.CHANNELS:
            channel = self.CHANNELS[channel]

        try:
            # Add timestamp if not present
            if isinstance(data, dict) and 'timestamp' not in data:
                data['timestamp'] = datetime.now().isoformat()

            # Wrap data in message bus format to match Node.js services
            payload = {
                'timestamp': datetime.now().isoformat(),
                'channel': channel,
                'data': data
            }

            message = json.dumps(payload)
            await self.client.publish(channel, message)
            # High-frequency publishing - minimal logging
        except Exception as e:
            logger.error(f"Failed to publish to {channel}: {e}")

    async def subscribe(self, channel: str):
        """Subscribe to a Redis channel.

        Args:
            channel: Channel name or key from CHANNELS dict
        """
        if not self._connected:
            logger.error("Not connected to Redis")
            return

        # Check if channel is a key in CHANNELS dict
        if channel in self.CHANNELS:
            channel = self.CHANNELS[channel]

        try:
            await self.pubsub.subscribe(channel)
            logger.info(f"Subscribed to channel: {channel}")
        except Exception as e:
            logger.error(f"Failed to subscribe to {channel}: {e}")

    async def get_message(self, timeout: float = 1.0) -> Optional[Dict]:
        """Get a message from subscribed channels.

        Args:
            timeout: Timeout in seconds

        Returns:
            Message dict or None if no message
        """
        if not self.pubsub:
            return None

        try:
            message = await self.pubsub.get_message(timeout=timeout)
            if message and message['type'] == 'message':
                data = json.loads(message['data'])
                return {
                    'channel': message['channel'],
                    'data': data
                }
        except Exception as e:
            logger.error(f"Error getting message: {e}")

        return None

    async def publish_lt_levels(self, levels: Dict):
        """Publish Liquidity Trigger levels."""
        await self.publish('LT_LEVELS', levels)

    async def publish_gex_levels(self, levels: Dict):
        """Publish GEX levels."""
        await self.publish('GEX_LEVELS', levels)
        # Also store for retrieval
        try:
            await self.client.set('gex_levels_latest', json.dumps(levels))
        except Exception as e:
            logger.error(f"Failed to store GEX levels in Redis: {e}")

    async def get_latest_gex_levels(self) -> Dict:
        """Get the latest GEX levels from Redis storage."""
        if not self._connected:
            return None
        try:
            # Get the latest value from the gex.levels channel storage
            data = await self.client.get('gex_levels_latest')
            if data:
                return json.loads(data)
        except Exception as e:
            logger.error(f"Failed to get latest GEX levels from Redis: {e}")
        return None

    async def publish_candle_close(self, candle: Dict):
        """Publish 15-minute candle close event."""
        await self.publish('CANDLE_CLOSE', candle)

    async def publish_trade_signal(self, signal: Dict):
        """Publish trade signal."""
        await self.publish('TRADE_SIGNAL', signal)

    async def publish_price_update(self, price_data: Dict):
        """Publish price update (compatible with existing format)."""
        await self.publish('PRICE_UPDATE', price_data)

    async def publish_health_check(self, health_data: Dict):
        """Publish service health check."""
        await self.publish('SERVICE_HEALTH', {
            'service': 'signal-generator',
            'status': 'healthy',
            **health_data
        })