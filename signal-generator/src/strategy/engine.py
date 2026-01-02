"""Strategy engine that coordinates strategy evaluation on candle closes."""

import asyncio
import logging
from typing import Optional, Callable
from datetime import datetime

from ..models.candle import Candle
from ..models.levels import GexLevels, LTLevels
from ..models.signal import TradeSignal
from ..publishers.redis_publisher import RedisPublisher
from ..data_sources.gex_calculator import GexCalculator
from .gex_recoil import GexRecoilStrategy
from ..config import Config

logger = logging.getLogger(__name__)


class StrategyEngine:
    """Coordinates strategy evaluation on 15-minute candle closes."""

    def __init__(
        self,
        redis_publisher: RedisPublisher,
        gex_calculator: GexCalculator
    ):
        """Initialize strategy engine.

        Args:
            redis_publisher: Redis publisher instance
            gex_calculator: GEX calculator instance
        """
        self.redis_publisher = redis_publisher
        self.gex_calculator = gex_calculator
        self.strategy = GexRecoilStrategy()
        self.current_lt_levels: Optional[LTLevels] = None
        self.enabled = Config.STRATEGY_ENABLED
        self.in_session = False
        self.session_start = Config.SESSION_START_HOUR
        self.session_end = Config.SESSION_END_HOUR

    def set_lt_levels(self, lt_levels: LTLevels):
        """Update current LT levels.

        Args:
            lt_levels: New LT levels
        """
        self.current_lt_levels = lt_levels
        logger.debug(f"LT levels updated: {lt_levels.get_all_levels()}")

    def is_in_trading_session(self) -> bool:
        """Check if we're in the trading session (6PM - 4PM EST).

        Returns:
            True if in session, False otherwise
        """
        # TODO: Implement proper EST timezone handling
        # For now, simplified check
        now = datetime.now()
        hour = now.hour

        # Session runs from 18:00 to 16:00 next day
        if self.session_start > self.session_end:
            # Session crosses midnight
            return hour >= self.session_start or hour < self.session_end
        else:
            # Session within same day
            return self.session_start <= hour < self.session_end

    async def evaluate_candle(self, candle: Candle):
        """Evaluate strategy on candle close.

        Args:
            candle: Closed 15-minute candle
        """
        if not self.enabled:
            logger.debug("Strategy evaluation disabled")
            return

        # Check if we're in trading session
        if not self.is_in_trading_session():
            logger.debug("Outside trading session, skipping evaluation")
            return

        # Only evaluate NQ candles
        if 'NQ' not in candle.symbol:
            logger.debug(f"Skipping non-NQ symbol: {candle.symbol}")
            return

        try:
            # Get current GEX levels
            gex_levels = self.gex_calculator.current_levels
            if not gex_levels:
                logger.warning("No GEX levels available, skipping evaluation")
                return

            # Generate signal
            signal = self.strategy.generate_signal(
                candle=candle,
                gex_levels=gex_levels,
                lt_levels=self.current_lt_levels
            )

            if signal:
                await self.publish_signal(signal)

        except Exception as e:
            logger.error(f"Error evaluating candle: {e}", exc_info=True)

    async def publish_signal(self, signal: TradeSignal):
        """Publish trade signal to Redis.

        Args:
            signal: Trade signal to publish
        """
        try:
            signal_data = signal.to_dict()
            await self.redis_publisher.publish_trade_signal(signal_data)
            logger.info(f"Published trade signal: {signal_data}")

            # Also publish to monitoring service
            await self.redis_publisher.publish('SERVICE_HEALTH', {
                'service': 'signal-generator',
                'event': 'signal_generated',
                'signal': signal_data
            })

        except Exception as e:
            logger.error(f"Failed to publish signal: {e}")

    def reset_strategy(self):
        """Reset strategy state (e.g., at session start)."""
        self.strategy.reset()
        logger.info("Strategy engine reset for new session")

    def enable(self):
        """Enable strategy evaluation."""
        self.enabled = True
        logger.info("Strategy engine enabled")

    def disable(self):
        """Disable strategy evaluation."""
        self.enabled = False
        logger.info("Strategy engine disabled")

    async def run(self):
        """Run the strategy engine."""
        logger.info("Strategy engine started")

        while True:
            try:
                # Check for session change
                in_session_now = self.is_in_trading_session()
                if in_session_now != self.in_session:
                    self.in_session = in_session_now
                    if in_session_now:
                        logger.info("Trading session started")
                        self.reset_strategy()
                    else:
                        logger.info("Trading session ended")

                # Sleep and continue
                await asyncio.sleep(60)  # Check every minute

            except Exception as e:
                logger.error(f"Error in strategy engine run loop: {e}")
                await asyncio.sleep(5)