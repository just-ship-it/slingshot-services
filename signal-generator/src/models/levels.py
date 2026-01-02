"""Level data models for GEX and LT levels."""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
from datetime import datetime


@dataclass
class GexLevels:
    """GEX levels calculated from CBOE options data."""

    timestamp: str
    qqq_spot: float
    nq_spot: float
    multiplier: float
    total_gex: float
    regime: str  # 'positive' or 'negative'
    gamma_flip: int
    call_wall: int
    put_wall: int
    resistance: List[int] = field(default_factory=list)
    support: List[int] = field(default_factory=list)
    from_cache: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'timestamp': self.timestamp,
            'qqq_spot': self.qqq_spot,
            'nq_spot': self.nq_spot,
            'multiplier': self.multiplier,
            'total_gex': self.total_gex,
            'regime': self.regime,
            'gamma_flip': self.gamma_flip,
            'call_wall': self.call_wall,
            'put_wall': self.put_wall,
            'resistance': self.resistance,
            'support': self.support,
            'from_cache': self.from_cache
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'GexLevels':
        """Create from dictionary."""
        return cls(**data)

    def get_support_level(self, index: int) -> Optional[int]:
        """Get support level by index (0-based)."""
        if 0 <= index < len(self.support):
            return self.support[index]
        return None

    def get_resistance_level(self, index: int) -> Optional[int]:
        """Get resistance level by index (0-based)."""
        if 0 <= index < len(self.resistance):
            return self.resistance[index]
        return None


@dataclass
class LTLevels:
    """Liquidity Trigger levels from TradingView."""

    timestamp: float
    candle_time: str
    L0: Optional[float] = None
    L1: Optional[float] = None
    L2: Optional[float] = None
    L3: Optional[float] = None
    L4: Optional[float] = None
    L5: Optional[float] = None
    L6: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'timestamp': self.timestamp,
            'candle_time': self.candle_time,
            'levels': {
                'L0': self.L0,
                'L1': self.L1,
                'L2': self.L2,
                'L3': self.L3,
                'L4': self.L4,
                'L5': self.L5,
                'L6': self.L6
            }
        }

    def get_all_levels(self) -> Dict[str, Optional[float]]:
        """Get all levels as a dictionary."""
        return {
            'L0': self.L0,
            'L1': self.L1,
            'L2': self.L2,
            'L3': self.L3,
            'L4': self.L4,
            'L5': self.L5,
            'L6': self.L6
        }

    def count_levels_below(self, price: float) -> int:
        """Count how many LT levels are below the given price."""
        count = 0
        for level_value in [self.L0, self.L1, self.L2, self.L3, self.L4, self.L5, self.L6]:
            if level_value is not None and level_value < price:
                count += 1
        return count

    def count_levels_above(self, price: float) -> int:
        """Count how many LT levels are above the given price."""
        count = 0
        for level_value in [self.L0, self.L1, self.L2, self.L3, self.L4, self.L5, self.L6]:
            if level_value is not None and level_value > price:
                count += 1
        return count