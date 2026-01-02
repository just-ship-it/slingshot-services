"""Trade signal data model."""

from dataclasses import dataclass, field
from typing import Dict, Any, Optional
from datetime import datetime


@dataclass
class TradeSignal:
    """Trade signal to be sent to trade orchestrator."""

    webhook_type: str = "trade_signal"
    action: str = "place_limit"  # place_limit, place_market, position_closed, cancel_limit
    side: str = "buy"  # buy or sell
    symbol: str = ""
    quantity: int = 1
    price: float = 0.0
    stop_loss: float = 0.0
    take_profit: float = 0.0
    strategy: str = "GEX_LT_RECOIL"
    trailing_trigger: Optional[float] = None
    trailing_offset: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        data = {
            'webhook_type': self.webhook_type,
            'action': self.action,
            'side': self.side,
            'symbol': self.symbol,
            'quantity': self.quantity,
            'price': self.price,
            'stopLoss': self.stop_loss,
            'takeProfit': self.take_profit,
            'strategy': self.strategy,
            'metadata': self.metadata
        }

        # Add trailing stop if configured
        if self.trailing_trigger is not None and self.trailing_offset is not None:
            data['trailingStop'] = {
                'trigger': self.trailing_trigger,
                'offset': self.trailing_offset
            }

        return data

    @classmethod
    def from_entry_signal(cls, symbol: str, entry_price: float, stop_loss: float,
                          take_profit: float, quantity: int = 1,
                          trailing_trigger: Optional[float] = None,
                          trailing_offset: Optional[float] = None,
                          metadata: Optional[Dict] = None) -> 'TradeSignal':
        """Create a trade signal from entry parameters."""
        return cls(
            symbol=symbol,
            quantity=quantity,
            price=entry_price,
            stop_loss=stop_loss,
            take_profit=take_profit,
            trailing_trigger=trailing_trigger,
            trailing_offset=trailing_offset,
            metadata=metadata or {}
        )