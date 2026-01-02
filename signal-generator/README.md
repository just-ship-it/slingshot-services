# Signal Generator Service

Python-based signal generator service for the Slingshot automated trading system. Streams real-time data from TradingView, calculates GEX levels, and generates trading signals.

## Features

- **TradingView Integration**: Streams real-time OHLCV data and Liquidity Trigger (LT) indicator levels
- **GEX Calculator**: Fetches CBOE options data and calculates gamma exposure levels
- **Strategy Engine**: Implements GEX Recoil Fade strategy for signal generation
- **Redis Pub/Sub**: Publishes data to Redis channels for other services to consume
- **HTTP API**: REST endpoints for health checks, GEX level management, and strategy control

## Architecture

```
signal-generator/
├── src/
│   ├── main.py                    # Entry point with FastAPI server
│   ├── config.py                  # Configuration management
│   │
│   ├── auth/
│   │   └── tradingview_auth.py    # TradingView JWT authentication
│   │
│   ├── data_sources/
│   │   ├── tv_websocket.py        # TradingView websocket manager
│   │   ├── lt_monitor.py          # Liquidity Trigger levels streaming
│   │   ├── ohlcv_monitor.py       # OHLCV data streaming
│   │   └── gex_calculator.py      # GEX levels calculator
│   │
│   ├── publishers/
│   │   └── redis_publisher.py     # Redis pub/sub client
│   │
│   ├── strategy/
│   │   ├── engine.py              # Strategy evaluation engine
│   │   └── gex_recoil.py          # GEX Recoil Fade strategy
│   │
│   └── models/
│       ├── levels.py              # GEX and LT level models
│       ├── candle.py              # OHLCV candle model
│       └── signal.py              # Trade signal model
│
├── data/                          # Data storage (GEX cache)
├── requirements.txt               # Python dependencies
├── .env.example                   # Environment configuration template
└── README.md                      # This file
```

## Setup

### Prerequisites

- Python 3.9+
- Redis server running
- TradingView account with valid credentials

### Installation

1. Install Python dependencies:
```bash
pip install -r requirements.txt
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env or shared/.env with your configuration
```

3. Set TradingView credentials in .env:
```bash
# Generate the encoded credentials string:
python -c "
import base64, json
username = 'your_username'
password = 'your_password'
creds = {'username': username, 'password': password}
encoded = base64.b64encode(json.dumps(creds).encode()).decode()
print(f'TRADINGVIEW_CREDENTIALS={encoded}')
"
# Add the output to your .env file
```

### Configuration

Key environment variables:

- `TRADINGVIEW_CREDENTIALS`: Base64 encoded JSON with username/password
- `REDIS_HOST`: Redis server host (default: localhost)
- `REDIS_PORT`: Redis server port (default: 6379)
- `HTTP_PORT`: HTTP server port (default: 3015)
- `STRATEGY_ENABLED`: Enable/disable signal generation (default: true)
- `TRADING_SYMBOL`: Symbol to trade (default: NQH5)
- `GEX_FETCH_TIME`: Time to fetch GEX levels daily (default: 16:35)

See `.env.example` for all configuration options.

## Running the Service

### Standalone
```bash
cd signal-generator
python -m src.main
```

### With PM2 (Recommended)
```bash
# From project root
pm2 start ecosystem.config.cjs --only signal-generator
```

### With Docker
```bash
docker build -t signal-generator .
docker run -p 3015:3015 signal-generator
```

## API Endpoints

### Health Check
```
GET /health
```
Returns service health status and connection states.

### GEX Levels
```
GET /gex/levels          # Get current cached GEX levels
GET /gex/refresh         # Trigger GEX recalculation
GET /gex/refresh?force=true  # Force refresh (bypass cooldown)
```

### LT Levels
```
GET /lt/levels           # Get current Liquidity Trigger levels
```

### Strategy Control
```
POST /strategy/enable    # Enable strategy evaluation
POST /strategy/disable   # Disable strategy evaluation
```

## Redis Channels

### Publishing Channels

- `trade.signal` - Generated trade signals
- `price.update` - Real-time price updates
- `lt.levels` - Liquidity Trigger level updates
- `gex.levels` - GEX level updates
- `candle.close` - 15-minute candle close events
- `service.health` - Service health updates

### Subscribing Channels

- `gex.refresh` - Trigger GEX recalculation on demand

## Strategy: GEX Recoil Fade

The strategy enters **LONG** positions when price crosses below GEX put wall levels.

### Entry Conditions

1. Previous candle close >= GEX level
2. Current candle close < GEX level
3. LT levels below entry <= 3 (liquidity filter)
4. Risk (entry - stop) <= 30 points

### Exit Rules

- **Take Profit**: 25 points above entry
- **Stop Loss**: Bar low - 10 points
- **Trailing Stop**: Triggers at +15, trails by 10 points

### GEX Levels Checked (Priority Order)

1. Put Wall (highest put OI strike)
2. Support Level 1
3. Support Level 2
4. Support Level 3

## Data Flow

1. **TradingView** → Real-time OHLCV and LT levels
2. **CBOE API** → Options data for GEX calculation
3. **Strategy Engine** → Evaluates conditions on 15m closes
4. **Redis Pub/Sub** → Distributes signals and data
5. **Trade Orchestrator** → Executes trades via Tradovate

## Monitoring

### Logs
```bash
# PM2 logs
pm2 logs signal-generator

# Python logs (standalone)
tail -f logs/signal-generator.log
```

### Metrics
- Signal generation rate
- GEX calculation success/failure
- WebSocket connection status
- Redis publish throughput

## Development

### Running Tests
```bash
pytest tests/
```

### Code Structure

- **Async Architecture**: Uses asyncio for concurrent operations
- **Single WebSocket**: One authenticated TradingView connection
- **State Management**: In-memory with optional file persistence
- **Error Handling**: Graceful degradation and reconnection logic

## Troubleshooting

### JWT Token Issues
- Tokens expire after ~4 hours
- Auto-refresh enabled (3-hour interval)
- Check `.tv_token_cache.json` for cached token
- Ensure TRADINGVIEW_CREDENTIALS is properly encoded in .env

### GEX Calculation
- CBOE data updates at 4:30 PM EST
- 5-minute cooldown between fetches
- Cached levels persist in `data/gex_cache.json`

### Connection Issues
- Verify Redis is running: `redis-cli ping`
- Check TradingView credentials in `.tv_credentials.json`
- Monitor websocket status in health endpoint

## Dependencies

- **tradingview-scraper**: TradingView data streaming
- **fastapi/uvicorn**: HTTP API server
- **redis/aioredis**: Redis pub/sub
- **pandas/numpy/scipy**: GEX calculations
- **yfinance**: NQ futures price data
- **websocket-client**: WebSocket connections

## License

Proprietary - All rights reserved