#!/usr/bin/env python3
"""Main entry point for Signal Generator service."""

import asyncio
import logging
import signal
import sys
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
import uvicorn

from .config import Config
from .auth.tradingview_auth import TradingViewAuth
from .publishers.redis_publisher import RedisPublisher
# TradingView websocket manager not needed - monitors handle connections directly
from .data_sources.lt_monitor import LTMonitor
from .data_sources.ohlcv_monitor_stable import OHLCVMonitor
from .data_sources.gex_calculator import GexCalculator
from .strategy.engine import StrategyEngine

# Configure logging
logging.basicConfig(
    level=getattr(logging, Config.LOG_LEVEL),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# tradingview_scraper heartbeat logging has been commented out directly in library files

# FastAPI app
app = FastAPI(title="Signal Generator Service", version="1.0.0")

# Global instances
redis_publisher: RedisPublisher = None
tv_auth: TradingViewAuth = None
lt_monitor: LTMonitor = None
ohlcv_monitor: OHLCVMonitor = None
gex_calculator: GexCalculator = None
strategy_engine: StrategyEngine = None

# Temporary for debugging - load GEX from cache file
def load_gex_from_cache():
    """Load GEX data from cache file for endpoints."""
    import json
    from pathlib import Path
    cache_file = Path("data/gex_cache.json")
    if cache_file.exists():
        with open(cache_file) as f:
            return json.load(f)
    return None


@app.get("/health")
async def health():
    """Health check endpoint."""
    health_data = {
        "status": "healthy",
        "service": Config.SERVICE_NAME,
        "timestamp": datetime.now().isoformat(),
        "connected": {
            "redis": redis_publisher._connected if redis_publisher else False,
            "tradingview": tv_auth.jwt_token is not None if tv_auth else False,
        },
        "strategy_enabled": Config.STRATEGY_ENABLED,
    }

    # Publish health check
    if redis_publisher and redis_publisher._connected:
        await redis_publisher.publish_health_check(health_data)

    return health_data


@app.get("/gex/levels")
async def get_gex_levels():
    """Get current cached GEX levels."""
    logger.info("🔍 GEX levels endpoint called")

    # Try to use gex_calculator first, fallback to file
    if gex_calculator and gex_calculator.current_levels:
        logger.info("✅ Returning GEX data from gex_calculator")
        return {
            "success": True,
            "levels": gex_calculator.current_levels.to_dict()
        }

    # Fallback to direct file load
    gex_data = load_gex_from_cache()
    if not gex_data:
        logger.error("❌ No GEX data available")
        raise HTTPException(status_code=404, detail="No GEX levels available")

    logger.info("✅ Returning GEX data from cache file (fallback)")
    return {
        "success": True,
        "timestamp": gex_data.get("timestamp"),
        "levels": {
            "timestamp": gex_data.get("timestamp"),
            "gamma_flip": gex_data.get("gamma_flip"),
            "call_wall": gex_data.get("call_wall"),
            "put_wall": gex_data.get("put_wall"),
            "resistance": gex_data.get("resistance", []),
            "support": gex_data.get("support", []),
            "regime": gex_data.get("regime"),
            "qqq_spot": gex_data.get("qqq_spot"),
            "nq_spot": gex_data.get("nq_spot"),
            "total_gex": gex_data.get("total_gex"),
            "from_cache": True
        }
    }


@app.get("/gex/refresh")
async def refresh_gex_levels(force: bool = False):
    """Trigger GEX recalculation."""
    if not gex_calculator:
        raise HTTPException(status_code=503, detail="GEX calculator not initialized")

    try:
        levels = await gex_calculator.calculate_levels(force=force)

        # Publish updated levels
        if redis_publisher and redis_publisher._connected:
            await redis_publisher.publish_gex_levels(levels.to_dict())

        return {
            "success": True,
            "from_cache": levels.from_cache,
            "levels": levels.to_dict()
        }
    except Exception as e:
        logger.error(f"Failed to refresh GEX levels: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/lt/levels")
async def get_lt_levels():
    """Get current LT levels."""
    if not lt_monitor:
        raise HTTPException(status_code=503, detail="LT monitor not initialized")

    current = lt_monitor.get_current_levels()
    if not current:
        raise HTTPException(status_code=404, detail="No LT levels available")

    return {
        "success": True,
        "levels": current.to_dict()
    }


@app.post("/strategy/enable")
async def enable_strategy():
    """Enable strategy evaluation."""
    if strategy_engine:
        strategy_engine.enable()
        return {"success": True, "message": "Strategy enabled"}
    raise HTTPException(status_code=503, detail="Strategy engine not initialized")


@app.post("/strategy/disable")
async def disable_strategy():
    """Disable strategy evaluation."""
    if strategy_engine:
        strategy_engine.disable()
        return {"success": True, "message": "Strategy disabled"}
    raise HTTPException(status_code=503, detail="Strategy engine not initialized")


async def initialize_services():
    """Initialize all service components."""
    global redis_publisher, tv_auth, lt_monitor, ohlcv_monitor
    global gex_calculator, strategy_engine

    try:
        # Initialize Redis publisher
        logger.info("Initializing Redis publisher...")
        redis_publisher = RedisPublisher(Config.get_redis_url())
        await redis_publisher.connect()

        # Initialize TradingView auth
        logger.info("Initializing TradingView authentication...")
        if not Config.TRADINGVIEW_CREDENTIALS:
            raise Exception("TRADINGVIEW_CREDENTIALS not set in environment")

        tv_auth = TradingViewAuth(
            credentials_string=Config.TRADINGVIEW_CREDENTIALS,
            token_cache_file=Config.TV_TOKEN_CACHE_FILE
        )

        # Get JWT token (prefer hardcoded from env, fallback to extraction)
        jwt_token = tv_auth.get_valid_token(hardcoded_token=Config.TRADINGVIEW_JWT_TOKEN)
        if not jwt_token:
            raise Exception("Failed to obtain TradingView JWT token")

        # Initialize GEX calculator
        logger.info("Initializing GEX calculator...")
        gex_calculator = GexCalculator(
            symbol=Config.GEX_SYMBOL,
            cache_file=Config.GEX_CACHE_FILE
        )

        # Check Redis for recent GEX levels first
        try:
            # Check when GEX levels were last updated in Redis
            redis_data = await redis_publisher.get_latest_gex_levels()
            should_update = True

            if redis_data and 'timestamp' in redis_data:
                from datetime import datetime
                last_update = datetime.fromisoformat(redis_data['timestamp'].replace('Z', '+00:00'))
                hours_since_update = (datetime.now() - last_update.replace(tzinfo=None)).total_seconds() / 3600

                if hours_since_update < 4:
                    logger.info(f"Redis has recent GEX levels ({hours_since_update:.1f}h old), using cached data")
                    gex_calculator.load_cached_levels()  # Fixed method name
                    should_update = False
                else:
                    logger.info(f"Redis GEX levels are stale ({hours_since_update:.1f}h old), will update")
            else:
                logger.info("No GEX levels found in Redis, will fetch fresh data")

            if should_update:
                # Only fetch fresh data if Redis is stale or missing
                levels = await gex_calculator.calculate_levels(force=True)
                await redis_publisher.publish_gex_levels(levels.to_dict())
                logger.info("Published fresh GEX levels to Redis")

        except Exception as e:
            logger.warning(f"Failed to check/update GEX levels: {e}")
            # Fallback to cache file
            try:
                gex_calculator.load_cached_levels()  # Fixed method name
                if gex_calculator.current_levels:
                    await redis_publisher.publish_gex_levels(gex_calculator.current_levels.to_dict())
            except Exception as fallback_e:
                logger.error(f"Fallback cache load also failed: {fallback_e}")

        # Initialize strategy engine
        logger.info("Initializing strategy engine...")
        strategy_engine = StrategyEngine(redis_publisher, gex_calculator)

        # TradingView websocket manager removed - monitors handle connections directly

        # Initialize LT monitor
        logger.info("Initializing LT monitor...")
        lt_symbol = Config.LT_SYMBOL.split(':')
        lt_monitor = LTMonitor(
            jwt_token=jwt_token,
            symbol=lt_symbol[1] if len(lt_symbol) > 1 else lt_symbol[0],
            exchange=lt_symbol[0] if len(lt_symbol) > 1 else "CME_MINI",
            timeframe=Config.LT_TIMEFRAME
        )

        # Set LT callback
        async def on_lt_update(lt_levels):
            await redis_publisher.publish_lt_levels(lt_levels.to_dict())
            strategy_engine.set_lt_levels(lt_levels)

        lt_monitor.set_callback(on_lt_update)

        # Initialize OHLCV monitor
        logger.info("Initializing OHLCV monitor...")
        ohlcv_monitor = OHLCVMonitor(jwt_token, Config.OHLCV_SYMBOLS, redis_publisher)

        # Set OHLCV candle close callback
        async def on_candle_close(candle):
            await redis_publisher.publish_candle_close(candle.to_dict())
            await strategy_engine.evaluate_candle(candle)

        ohlcv_monitor.set_candle_close_callback(on_candle_close)

        logger.info("All services initialized successfully")

    except Exception as e:
        logger.error(f"Failed to initialize services: {e}")
        raise


def start_background_services():
    """Start background services as fire-and-forget tasks."""
    logger.info("🚀 Starting background services...")

    # Start LT monitor
    if lt_monitor:
        logger.info("📡 Starting LT monitor task...")
        asyncio.create_task(lt_monitor.start(), name="lt_monitor")

    # Start OHLCV monitor
    if ohlcv_monitor:
        logger.info("📊 Starting OHLCV monitor task...")
        asyncio.create_task(ohlcv_monitor.start(), name="ohlcv_monitor")

    # Start GEX daily fetch
    if gex_calculator:
        logger.info("⏰ Starting GEX daily fetch task...")
        asyncio.create_task(gex_calculator.run_daily_fetch(), name="gex_daily_fetch")

    # Start strategy engine
    if strategy_engine:
        logger.info("🧠 Starting strategy engine task...")
        asyncio.create_task(strategy_engine.run(), name="strategy_engine")

    logger.info("✅ All background services started")


async def shutdown():
    """Gracefully shutdown all services."""
    logger.info("Shutting down services...")

    if lt_monitor:
        await lt_monitor.stop()

    if ohlcv_monitor:
        await ohlcv_monitor.stop()

    # TradingView websocket manager removed

    if redis_publisher:
        await redis_publisher.disconnect()

    logger.info("All services shut down")


def handle_signal(sig, frame):
    """Handle shutdown signals."""
    logger.info(f"Received signal {sig}, initiating shutdown...")
    asyncio.create_task(shutdown())
    sys.exit(0)


async def main():
    """Main application entry point."""
    logger.info("🚀 Starting signal-generator main()...")

    # Register signal handlers
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    logger.info("✅ Signal handlers registered")

    # Initialize services
    logger.info("🔧 Initializing services...")
    await initialize_services()
    logger.info("✅ Services initialized")

    # Start background services (fire-and-forget)
    start_background_services()

    # Start FastAPI server (this will run until interrupted)
    logger.info(f"🌐 Starting FastAPI server on 127.0.0.1:{Config.HTTP_PORT}...")
    config = uvicorn.Config(
        app=app,
        host="127.0.0.1",  # Bind to localhost only
        port=Config.HTTP_PORT,
        log_level=Config.LOG_LEVEL.lower()
    )
    logger.info(f"📋 Uvicorn config created: host=127.0.0.1, port={Config.HTTP_PORT}")

    server = uvicorn.Server(config)
    logger.info("🖥️  Uvicorn server created")

    # This will run until the service is stopped
    logger.info("📡 Starting server...")
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())