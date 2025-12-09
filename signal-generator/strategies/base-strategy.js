// Base Strategy Class - All strategies must extend this
export class BaseStrategy {
  constructor(config = {}) {
    this.name = config.name || 'base-strategy';
    this.type = config.type || 'base';
    this.config = {
      enabled: true,
      timeframe: '1m',           // Default to 1-minute chart
      historyRequired: 20,       // Number of candles needed for analysis
      symbol: null,               // Specific symbol or null for all symbols
      // Default order parameters
      stopLoss: 10,               // Points
      takeProfit: 100,            // Points
      trailingTrigger: 10,        // Points from entry
      trailingOffset: 5,          // Points
      quantity: 1,                // Default quantity
      ...config
    };
  }

  /**
   * Analyze current market conditions and generate trading signal
   * @param {Object} currentCandle - Current completed candle
   * @param {Array} candleHistory - Historical candles (not including current)
   * @param {string} symbol - Trading symbol
   * @returns {Object|null} - Trade signal object or null if no signal
   */
  analyze(currentCandle, candleHistory, symbol) {
    throw new Error(`Strategy ${this.name} must implement analyze method`);
  }

  /**
   * Generate a trade signal object
   * @param {string} side - 'buy' or 'sell'
   * @param {string} symbol - Trading symbol
   * @param {number} price - Entry price
   * @param {Object} overrides - Optional parameter overrides
   * @returns {Object} - Formatted trade signal
   */
  generateSignal(side, symbol, price, overrides = {}) {
    const pointsToPrice = side === 'buy' ? -1 : 1;
    const stopLoss = price + (pointsToPrice * this.config.stopLoss);
    const takeProfit = price - (pointsToPrice * this.config.takeProfit);

    return {
      webhook_type: 'trade_signal',
      action: 'place_limit',
      side,
      symbol,
      price,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      trailing_trigger: this.config.trailingTrigger,
      trailing_offset: this.config.trailingOffset,
      quantity: this.config.quantity,
      strategy: this.name,
      timeframe: this.config.timeframe,
      timestamp: new Date().toISOString(),
      ...overrides
    };
  }

  /**
   * Check if strategy should process this symbol
   * @param {string} symbol - Trading symbol to check
   * @returns {boolean}
   */
  shouldProcessSymbol(symbol) {
    if (!this.config.symbol) return true; // Process all symbols
    return this.config.symbol === symbol;
  }

  /**
   * Check if strategy is ready to analyze (has enough history)
   * @param {Array} candleHistory - Available candle history
   * @returns {boolean}
   */
  isReady(candleHistory) {
    return candleHistory.length >= this.config.historyRequired;
  }

  /**
   * Update strategy configuration
   * @param {Object} updates - Configuration updates
   */
  updateConfig(updates) {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Get strategy info for monitoring/debugging
   * @returns {Object}
   */
  getInfo() {
    return {
      name: this.name,
      type: this.type,
      enabled: this.config.enabled,
      timeframe: this.config.timeframe,
      historyRequired: this.config.historyRequired,
      symbol: this.config.symbol || 'all',
      parameters: {
        stopLoss: this.config.stopLoss,
        takeProfit: this.config.takeProfit,
        trailingTrigger: this.config.trailingTrigger,
        trailingOffset: this.config.trailingOffset,
        quantity: this.config.quantity
      }
    };
  }
}

export default BaseStrategy;