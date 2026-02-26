// Candle Manager - Per-symbol candle buffers with close detection and Redis publishing
import { createLogger, messageBus, CHANNELS } from '../../shared/index.js';
import { CandleBuffer } from '../../signal-generator/src/utils/candle-buffer.js';

const logger = createLogger('candle-manager');

export class CandleManager {
  constructor() {
    // Per-symbol candle buffers: Map<baseSymbol, CandleBuffer>
    this.buffers = new Map();
    // Per-symbol 1h candle buffers for hourly history
    this.hourlyBuffers = new Map();
    // Per-symbol 1D candle buffers for daily history
    this.dailyBuffers = new Map();
    // Map TradingView symbols to base symbols for routing
    this.symbolMap = {
      'NQ': ['NQ1!', 'MNQ1!', 'NQ', 'MNQ'],
      'ES': ['ES1!', 'MES1!', 'ES', 'MES'],
    };
  }

  /**
   * Get or create a candle buffer for a base symbol
   * @param {string} baseSymbol - 'NQ' or 'ES'
   * @returns {CandleBuffer}
   */
  getBuffer(baseSymbol) {
    if (!this.buffers.has(baseSymbol)) {
      this.buffers.set(baseSymbol, new CandleBuffer({
        symbol: baseSymbol,
        timeframe: '1',
        maxSize: 600  // ~10h of 1m candles for history serving
      }));
      logger.info(`Created candle buffer for ${baseSymbol}`);
    }
    return this.buffers.get(baseSymbol);
  }

  /**
   * Resolve a quote's baseSymbol to our canonical base symbol
   * @param {string} quoteBaseSymbol - e.g. 'NQ1!', 'ES1!', 'NQ', 'ES'
   * @returns {string|null} 'NQ', 'ES', or null if not tracked
   */
  resolveBaseSymbol(quoteBaseSymbol) {
    for (const [canonical, aliases] of Object.entries(this.symbolMap)) {
      if (quoteBaseSymbol === canonical || aliases.some(a => quoteBaseSymbol.includes(a))) {
        return canonical;
      }
    }
    return null;
  }

  /**
   * Process an incoming quote from TradingView
   * Detects candle closes and publishes to Redis
   * @param {Object} quote - Quote data with candleTimestamp, baseSymbol, OHLCV
   * @returns {Object|null} Closed candle data if a candle just closed, null otherwise
   */
  async processQuote(quote) {
    if (!quote.candleTimestamp) return null;

    const baseSymbol = this.resolveBaseSymbol(quote.baseSymbol);
    if (!baseSymbol) return null;

    const buffer = this.getBuffer(baseSymbol);
    const candleData = {
      symbol: quote.symbol,
      timestamp: quote.timestamp,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.close,
      volume: quote.volume
    };

    const isNewCandle = buffer.addCandle(candleData);
    if (isNewCandle) {
      const closedCandle = buffer.getLastClosedCandle();
      if (closedCandle) {
        // Publish candle.close to Redis with product identifier
        const candleCloseData = {
          product: baseSymbol,
          symbol: closedCandle.symbol,
          timestamp: closedCandle.timestamp,
          open: closedCandle.open,
          high: closedCandle.high,
          low: closedCandle.low,
          close: closedCandle.close,
          volume: closedCandle.volume
        };

        await messageBus.publish(CHANNELS.CANDLE_CLOSE, candleCloseData);
        logger.info(`Published candle.close: ${baseSymbol} ${closedCandle.close} @ ${closedCandle.timestamp}`);
        return candleCloseData;
      }
    }

    return null;
  }

  /**
   * Get candle history for a symbol
   * @param {string} symbol - 'NQ' or 'ES'
   * @param {number} count - Number of candles to return
   * @returns {Array} Array of candle objects
   */
  getCandles(symbol, count = 60) {
    const buffer = this.buffers.get(symbol);
    if (!buffer) return [];
    const candles = buffer.getCandles(count) || [];
    return candles.map(c => c.toDict ? c.toDict() : c);
  }

  /**
   * Get or create a 1h candle buffer for a base symbol
   */
  getHourlyBuffer(baseSymbol) {
    if (!this.hourlyBuffers.has(baseSymbol)) {
      this.hourlyBuffers.set(baseSymbol, new CandleBuffer({
        symbol: baseSymbol,
        timeframe: '60',
        maxSize: 500,
      }));
      logger.info(`Created hourly candle buffer for ${baseSymbol}`);
    }
    return this.hourlyBuffers.get(baseSymbol);
  }

  /**
   * Get or create a 1D candle buffer for a base symbol
   */
  getDailyBuffer(baseSymbol) {
    if (!this.dailyBuffers.has(baseSymbol)) {
      this.dailyBuffers.set(baseSymbol, new CandleBuffer({
        symbol: baseSymbol,
        timeframe: '1D',
        maxSize: 30,
      }));
      logger.info(`Created daily candle buffer for ${baseSymbol}`);
    }
    return this.dailyBuffers.get(baseSymbol);
  }

  /**
   * Seed candle buffer from TradingView history_loaded event
   * @param {string} baseSymbol - 'NQ' or 'ES'
   * @param {string} timeframe - '1', '60', or '1D'
   * @param {Array} candles - Array of candle data
   */
  seedHistory(baseSymbol, timeframe, candles) {
    if (!candles || candles.length === 0) return;

    if (timeframe === '1') {
      const buffer = this.getBuffer(baseSymbol);
      const count = buffer.seedCandles(candles);
      logger.info(`Seeded ${count} 1m candles for ${baseSymbol} from TradingView history`);
    } else if (timeframe === '60') {
      const buffer = this.getHourlyBuffer(baseSymbol);
      const count = buffer.seedCandles(candles);
      logger.info(`Seeded ${count} 1h candles for ${baseSymbol} from TradingView history`);
    } else if (timeframe === '1D') {
      const buffer = this.getDailyBuffer(baseSymbol);
      const count = buffer.seedCandles(candles);
      logger.info(`Seeded ${count} 1D candles for ${baseSymbol} from TradingView history`);
    }
  }

  /**
   * Get hourly candle history for a symbol
   * @param {string} symbol - 'NQ' or 'ES'
   * @param {number} count - Number of candles to return
   * @returns {Array} Array of candle objects
   */
  getHourlyCandles(symbol, count = 300) {
    const buffer = this.hourlyBuffers.get(symbol);
    if (!buffer) return [];
    const candles = buffer.getCandles(count) || [];
    return candles.map(c => c.toDict ? c.toDict() : c);
  }

  /**
   * Get daily candle history for a symbol
   * @param {string} symbol - 'NQ' or 'ES'
   * @param {number} count - Number of candles to return
   * @returns {Array} Array of candle objects
   */
  getDailyCandles(symbol, count = 10) {
    const buffer = this.dailyBuffers.get(symbol);
    if (!buffer) return [];
    const candles = buffer.getCandles(count) || [];
    return candles.map(c => c.toDict ? c.toDict() : c);
  }

  /**
   * Get stats for all buffers
   * @returns {Object} Stats per symbol
   */
  getStats() {
    const stats = {};
    for (const [symbol, buffer] of this.buffers) {
      stats[symbol] = buffer.getStats();
    }
    return stats;
  }
}

export default CandleManager;
