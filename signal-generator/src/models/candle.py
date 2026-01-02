"""Candle data model for OHLCV data."""

from dataclasses import dataclass
from typing import Dict, Any


@dataclass
class Candle:
    """OHLCV candle data."""

    symbol: str
    timestamp: float
    open: float
    high: float
    low: float
    close: float
    volume: float
    timeframe: str = "15"  # minutes

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'symbol': self.symbol,
            'timestamp': self.timestamp,
            'open': self.open,
            'high': self.high,
            'low': self.low,
            'close': self.close,
            'volume': self.volume,
            'timeframe': self.timeframe
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Candle':
        """Create from dictionary."""
        return cls(**data)

    @property
    def range(self) -> float:
        """Get the candle range (high - low)."""
        return self.high - self.low

    @property
    def body(self) -> float:
        """Get the candle body size (abs(close - open))."""
        return abs(self.close - self.open)

    @property
    def is_bullish(self) -> bool:
        """Check if candle is bullish (close > open)."""
        return self.close > self.open

    @property
    def is_bearish(self) -> bool:
        """Check if candle is bearish (close < open)."""
        return self.close < self.open