// SMA Crossover Strategy - Generates signals when price crosses the Simple Moving Average

import { BaseStrategy } from './base-strategy.js';

export class SMACrossoverStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      name: 'sma-crossover',
      type: 'sma-crossover',
      period: 20,                  // SMA period
      crossoverThreshold: 0.01,    // Min % move to confirm crossover
      cooldownCandles: 3,          // Candles to wait between signals
      ...config
    });

    // Track last signal time per symbol to implement cooldown
    this.lastSignals = new Map();
    this.previousSMA = new Map();
    this.signalHistory = [];
  }

  /**
   * Calculate Simple Moving Average
   * @private
   */
  calculateSMA(candles, period = this.config.period) {
    if (candles.length < period) {
      return null;
    }

    const relevantCandles = candles.slice(-period);
    const sum = relevantCandles.reduce((acc, candle) => acc + candle.close, 0);
    return sum / period;
  }

  /**
   * Analyze candles and generate trading signals
   */
  analyze(currentCandle, candleHistory, symbol) {
    // Check if we should process this symbol
    if (!this.shouldProcessSymbol(symbol)) {
      return null;
    }

    // Need enough history for SMA calculation
    if (!this.isReady(candleHistory)) {
      return null;
    }

    // Calculate current and previous SMA
    const allCandles = [...candleHistory, currentCandle];
    const currentSMA = this.calculateSMA(allCandles, this.config.period);

    // Get previous candles for previous SMA
    const previousCandles = allCandles.slice(0, -1);
    const previousSMA = this.calculateSMA(previousCandles, this.config.period);

    if (!currentSMA || !previousSMA) {
      return null;
    }

    // Store SMA values for debugging/monitoring
    const smaKey = `${symbol}_${this.config.timeframe}`;
    this.previousSMA.set(smaKey, { current: currentSMA, previous: previousSMA });

    // Check for cooldown period
    if (this.isInCooldown(symbol, candleHistory.length)) {
      return null;
    }

    const currentPrice = currentCandle.close;
    const previousPrice = candleHistory[candleHistory.length - 1].close;

    // Check for bullish crossover (price crosses above SMA)
    if (previousPrice <= previousSMA && currentPrice > currentSMA) {
      const crossoverStrength = ((currentPrice - currentSMA) / currentSMA) * 100;

      if (Math.abs(crossoverStrength) >= this.config.crossoverThreshold) {
        this.recordSignal(symbol, 'buy', candleHistory.length);

        const signal = this.generateSignal('buy', symbol, currentPrice, {
          sma: currentSMA,
          crossoverStrength: crossoverStrength.toFixed(2),
          timeframe: this.config.timeframe,
          smaPeriod: this.config.period
        });

        this.signalHistory.push({
          timestamp: new Date().toISOString(),
          symbol,
          side: 'buy',
          price: currentPrice,
          sma: currentSMA,
          strength: crossoverStrength
        });

        return signal;
      }
    }

    // Check for bearish crossover (price crosses below SMA)
    if (previousPrice >= previousSMA && currentPrice < currentSMA) {
      const crossoverStrength = ((currentSMA - currentPrice) / currentSMA) * 100;

      if (Math.abs(crossoverStrength) >= this.config.crossoverThreshold) {
        this.recordSignal(symbol, 'sell', candleHistory.length);

        const signal = this.generateSignal('sell', symbol, currentPrice, {
          sma: currentSMA,
          crossoverStrength: crossoverStrength.toFixed(2),
          timeframe: this.config.timeframe,
          smaPeriod: this.config.period
        });

        this.signalHistory.push({
          timestamp: new Date().toISOString(),
          symbol,
          side: 'sell',
          price: currentPrice,
          sma: currentSMA,
          strength: crossoverStrength
        });

        return signal;
      }
    }

    return null;
  }

  /**
   * Check if symbol is in cooldown period
   * @private
   */
  isInCooldown(symbol, currentCandleIndex) {
    const key = `${symbol}_${this.config.timeframe}`;
    const lastSignal = this.lastSignals.get(key);

    if (!lastSignal) {
      return false;
    }

    const candlesSinceSignal = currentCandleIndex - lastSignal.candleIndex;
    return candlesSinceSignal < this.config.cooldownCandles;
  }

  /**
   * Record signal generation for cooldown tracking
   * @private
   */
  recordSignal(symbol, side, candleIndex) {
    const key = `${symbol}_${this.config.timeframe}`;
    this.lastSignals.set(key, {
      timestamp: new Date().toISOString(),
      side,
      candleIndex
    });
  }

  /**
   * Get strategy-specific info
   */
  getInfo() {
    const baseInfo = super.getInfo();
    return {
      ...baseInfo,
      parameters: {
        ...baseInfo.parameters,
        smaPeriod: this.config.period,
        crossoverThreshold: this.config.crossoverThreshold,
        cooldownCandles: this.config.cooldownCandles
      },
      currentState: {
        activeSymbols: Array.from(this.lastSignals.keys()),
        recentSignals: this.signalHistory.slice(-10),
        smaValues: Object.fromEntries(this.previousSMA)
      }
    };
  }

  /**
   * Reset strategy state
   */
  reset() {
    this.lastSignals.clear();
    this.previousSMA.clear();
    this.signalHistory = [];
  }
}

export default SMACrossoverStrategy;