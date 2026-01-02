"""GEX Recoil Fade strategy implementation."""

import logging
from typing import Optional, Dict, Any, List
from datetime import datetime

from ..models.candle import Candle
from ..models.levels import GexLevels, LTLevels
from ..models.signal import TradeSignal
from ..config import Config

logger = logging.getLogger(__name__)


class GexRecoilStrategy:
    """GEX Recoil Fade strategy - enters long when price crosses below GEX put wall."""

    def __init__(self, params: Optional[Dict] = None):
        """Initialize strategy with parameters.

        Args:
            params: Strategy parameters dict (uses Config defaults if not provided)
        """
        self.params = params or Config.get_strategy_params()
        self.prev_candle: Optional[Candle] = None
        self.last_signal_time: float = 0
        self.signal_cooldown = 900  # 15 minutes between signals

    def evaluate_entry(
        self,
        candle: Candle,
        prev_candle: Candle,
        gex_levels: GexLevels,
        lt_levels: Optional[LTLevels]
    ) -> Optional[Dict[str, Any]]:
        """Evaluate if entry conditions are met.

        Args:
            candle: Current closed 15m candle
            prev_candle: Previous 15m candle
            gex_levels: Current GEX levels
            lt_levels: Current LT levels (optional)

        Returns:
            Dict with signal details if entry valid, None otherwise
        """
        # Check cooldown
        if candle.timestamp - self.last_signal_time < self.signal_cooldown:
            return None

        # Get GEX levels to check (in priority order)
        levels_to_check = [
            ('put_wall', gex_levels.put_wall),
            ('support_1', gex_levels.get_support_level(0)),
            ('support_2', gex_levels.get_support_level(1)),
            ('support_3', gex_levels.get_support_level(2)),
        ]

        for level_name, level_value in levels_to_check:
            if level_value is None:
                continue

            # Did price cross below this level?
            if prev_candle.close >= level_value and candle.close < level_value:
                logger.info(f"Price crossed below {level_name} at {level_value}")

                # Apply liquidity filter if enabled
                if self.params['use_liquidity_filter'] and lt_levels:
                    lt_below = lt_levels.count_levels_below(level_value)
                    if lt_below > self.params['max_lt_levels_below']:
                        logger.info(f"Liquidity filter failed: {lt_below} LT levels below (max: {self.params['max_lt_levels_below']})")
                        continue
                else:
                    lt_below = 0

                # Risk calculation
                stop_price = candle.low - self.params['stop_buffer']
                risk = candle.close - stop_price

                # Apply risk filter
                if risk > self.params['max_risk'] or risk <= 0:
                    logger.info(f"Risk filter failed: {risk:.2f} points (max: {self.params['max_risk']})")
                    continue

                # Valid entry found
                self.last_signal_time = candle.timestamp
                return {
                    'side': 'buy',
                    'entry_price': candle.close,
                    'stop_loss': stop_price,
                    'take_profit': candle.close + self.params['target_points'],
                    'gex_level': level_value,
                    'gex_level_type': level_name,
                    'lt_levels_below': lt_below,
                    'risk_points': risk,
                }

        return None

    def generate_signal(
        self,
        candle: Candle,
        gex_levels: GexLevels,
        lt_levels: Optional[LTLevels] = None
    ) -> Optional[TradeSignal]:
        """Generate trade signal if conditions are met.

        Args:
            candle: Current closed 15m candle
            gex_levels: Current GEX levels
            lt_levels: Current LT levels (optional)

        Returns:
            TradeSignal if entry conditions met, None otherwise
        """
        # Need previous candle to check for crossover
        if not self.prev_candle:
            self.prev_candle = candle
            return None

        # Skip if same symbol
        if candle.symbol != self.prev_candle.symbol:
            logger.warning(f"Symbol mismatch: {candle.symbol} != {self.prev_candle.symbol}")
            self.prev_candle = candle
            return None

        # Evaluate entry
        entry = self.evaluate_entry(candle, self.prev_candle, gex_levels, lt_levels)

        # Update previous candle
        self.prev_candle = candle

        if not entry:
            return None

        # Create trade signal
        signal = TradeSignal.from_entry_signal(
            symbol=Config.TRADING_SYMBOL,
            entry_price=entry['entry_price'],
            stop_loss=entry['stop_loss'],
            take_profit=entry['take_profit'],
            quantity=Config.DEFAULT_QUANTITY,
            trailing_trigger=self.params.get('trailing_trigger') if self.params.get('use_trailing_stop') else None,
            trailing_offset=self.params.get('trailing_offset') if self.params.get('use_trailing_stop') else None,
            metadata={
                'gex_level': entry['gex_level'],
                'gex_level_type': entry['gex_level_type'],
                'lt_levels_below': entry['lt_levels_below'],
                'risk_points': entry['risk_points'],
                'candle_time': datetime.fromtimestamp(candle.timestamp).isoformat(),
                'entry_reason': f"Price crossed below {entry['gex_level_type']} at {entry['gex_level']}"
            }
        )

        logger.info(f"Generated signal: {entry['side'].upper()} {Config.TRADING_SYMBOL} @ {entry['entry_price']:.2f}, "
                   f"SL: {entry['stop_loss']:.2f}, TP: {entry['take_profit']:.2f}")

        return signal

    def reset(self):
        """Reset strategy state."""
        self.prev_candle = None
        self.last_signal_time = 0
        logger.info("Strategy state reset")