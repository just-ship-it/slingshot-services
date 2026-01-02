"""Configuration management for Signal Generator service."""

import os
from pathlib import Path
from typing import List, Optional
from dotenv import load_dotenv

# Load environment variables from shared .env if it exists, otherwise local
env_path = Path(__file__).parent.parent.parent / 'shared' / '.env'
if not env_path.exists():
    env_path = Path(__file__).parent.parent / '.env'
load_dotenv(env_path)

class Config:
    """Service configuration from environment variables."""

    # Redis Configuration
    REDIS_HOST: str = os.getenv('REDIS_HOST', 'localhost')
    REDIS_PORT: int = int(os.getenv('REDIS_PORT', '6379'))

    # TradingView Configuration
    TRADINGVIEW_CREDENTIALS: str = os.getenv('TRADINGVIEW_CREDENTIALS', '')
    TRADINGVIEW_JWT_TOKEN: str = os.getenv('TRADINGVIEW_JWT_TOKEN', '')
    TV_TOKEN_CACHE_FILE: str = os.getenv('TV_TOKEN_CACHE_FILE', '.tv_token_cache.json')

    # Symbols to Stream
    OHLCV_SYMBOLS: List[str] = os.getenv(
        'OHLCV_SYMBOLS',
        'CME_MINI:NQ1!,CME_MINI:MNQ1!,CME_MINI:ES1!,CME_MINI:MES1!,BITSTAMP:BTCUSD'
    ).split(',')
    LT_SYMBOL: str = os.getenv('LT_SYMBOL', 'CME_MINI:NQ1!')
    LT_TIMEFRAME: str = os.getenv('LT_TIMEFRAME', '15m')

    # GEX Calculator Configuration
    GEX_SYMBOL: str = os.getenv('GEX_SYMBOL', 'QQQ')
    GEX_FETCH_TIME: str = os.getenv('GEX_FETCH_TIME', '16:35')
    GEX_COOLDOWN_MINUTES: int = int(os.getenv('GEX_COOLDOWN_MINUTES', '5'))
    GEX_CACHE_FILE: str = os.getenv('GEX_CACHE_FILE', './data/gex_cache.json')

    # Strategy Configuration
    STRATEGY_ENABLED: bool = os.getenv('STRATEGY_ENABLED', 'true').lower() == 'true'
    TRADING_SYMBOL: str = os.getenv('TRADING_SYMBOL', 'NQH5')
    DEFAULT_QUANTITY: int = int(os.getenv('DEFAULT_QUANTITY', '1'))

    # Strategy Parameters
    TARGET_POINTS: float = float(os.getenv('TARGET_POINTS', '25.0'))
    STOP_BUFFER: float = float(os.getenv('STOP_BUFFER', '10.0'))
    MAX_RISK: float = float(os.getenv('MAX_RISK', '30.0'))
    USE_TRAILING_STOP: bool = os.getenv('USE_TRAILING_STOP', 'true').lower() == 'true'
    TRAILING_TRIGGER: float = float(os.getenv('TRAILING_TRIGGER', '15.0'))
    TRAILING_OFFSET: float = float(os.getenv('TRAILING_OFFSET', '10.0'))
    USE_LIQUIDITY_FILTER: bool = os.getenv('USE_LIQUIDITY_FILTER', 'true').lower() == 'true'
    MAX_LT_LEVELS_BELOW: int = int(os.getenv('MAX_LT_LEVELS_BELOW', '3'))

    # Session Times (EST)
    SESSION_START_HOUR: int = int(os.getenv('SESSION_START_HOUR', '18'))
    SESSION_END_HOUR: int = int(os.getenv('SESSION_END_HOUR', '16'))

    # Service Configuration
    HTTP_PORT: int = int(os.getenv('HTTP_PORT', '3015'))
    LOG_LEVEL: str = os.getenv('LOG_LEVEL', 'INFO')
    SERVICE_NAME: str = os.getenv('SERVICE_NAME', 'signal-generator')

    # Data Archiving Configuration
    ENABLE_HISTORICAL_ARCHIVING: bool = os.getenv('ENABLE_HISTORICAL_ARCHIVING', 'true').lower() == 'true'
    HISTORICAL_DATA_DIRECTORY: str = os.getenv('HISTORICAL_DATA_DIRECTORY', './data/ohlcv')
    ARCHIVE_SYMBOLS: List[str] = os.getenv(
        'ARCHIVE_SYMBOLS',
        'NQ,MNQ,ES,MES'
    ).split(',')

    # Contract Mappings (update quarterly)
    CONTRACT_MAPPINGS: dict = {
        'NQ': os.getenv('NQ_CONTRACT', 'NQH6'),
        'MNQ': os.getenv('MNQ_CONTRACT', 'MNQH6'),
        'ES': os.getenv('ES_CONTRACT', 'ESH6'),
        'MES': os.getenv('MES_CONTRACT', 'MESH6')
    }

    @classmethod
    def get_strategy_params(cls) -> dict:
        """Get strategy parameters as a dictionary."""
        return {
            'target_points': cls.TARGET_POINTS,
            'stop_buffer': cls.STOP_BUFFER,
            'max_risk': cls.MAX_RISK,
            'use_trailing_stop': cls.USE_TRAILING_STOP,
            'trailing_trigger': cls.TRAILING_TRIGGER,
            'trailing_offset': cls.TRAILING_OFFSET,
            'use_liquidity_filter': cls.USE_LIQUIDITY_FILTER,
            'max_lt_levels_below': cls.MAX_LT_LEVELS_BELOW,
        }

    @classmethod
    def get_redis_url(cls) -> str:
        """Get Redis connection URL."""
        return f"redis://{cls.REDIS_HOST}:{cls.REDIS_PORT}"