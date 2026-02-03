/**
 * Example: GEX Data Integration with Backtest Engine
 * Demonstrates how to use historical GEX levels in backtesting strategies
 */

const GexLoader = require('../src/data-loaders/gex-loader');
const path = require('path');

class GEXIntegratedStrategy {
  constructor() {
    this.gexLoader = new GexLoader();
    this.positions = [];
    this.trades = [];
  }

  /**
   * Initialize strategy with GEX data
   */
  async initialize(startDate, endDate) {
    console.log('Loading GEX data for strategy...');

    const success = await this.gexLoader.loadDateRange(startDate, endDate);
    if (!success) {
      throw new Error('Failed to load GEX data');
    }

    const stats = this.gexLoader.getStatistics();
    console.log('GEX Data Statistics:', stats);

    const range = this.gexLoader.getDataRange();
    console.log(`GEX data available from ${range.start} to ${range.end}`);

    return true;
  }

  /**
   * Example strategy: GEX Reversion
   * Buy near gamma flip in positive GEX environment
   * Sell near gamma flip in negative GEX environment
   */
  evaluateSignal(timestamp, price, volume) {
    // Get current GEX levels
    const gexData = this.gexLoader.getGexLevels(timestamp);
    if (!gexData) {
      return { action: 'none', reason: 'No GEX data available' };
    }

    // Get information about nearby levels
    const nearby = this.gexLoader.getNearbyLevels(timestamp, price, 10); // 10-point threshold

    // Strategy logic based on GEX regime and levels
    const signal = this.calculateGEXSignal(price, gexData, nearby);

    return {
      action: signal.action,
      reason: signal.reason,
      gexData: {
        regime: gexData.regime,
        totalGex: gexData.total_gex,
        gammaFlip: gexData.gamma_flip,
        nearGammaFlip: nearby.nearGammaFlip,
        distanceToFlip: nearby.distances.toGammaFlip
      }
    };
  }

  /**
   * Calculate trading signal based on GEX data
   */
  calculateGEXSignal(price, gexData, nearby) {
    // GEX Reversion Strategy Logic

    // Strong positive GEX - expect mean reversion
    if (gexData.regime === 'strong_positive') {
      if (nearby.nearGammaFlip && price < gexData.gamma_flip) {
        return {
          action: 'buy',
          reason: `Price ${price} below gamma flip ${gexData.gamma_flip} in strong positive GEX environment`
        };
      }
    }

    // Strong negative GEX - expect volatility expansion
    if (gexData.regime === 'strong_negative') {
      if (nearby.nearGammaFlip && price > gexData.gamma_flip) {
        return {
          action: 'sell',
          reason: `Price ${price} above gamma flip ${gexData.gamma_flip} in strong negative GEX environment`
        };
      }
    }

    // Support/Resistance based on call/put walls
    if (gexData.regime === 'positive') {
      // In positive GEX, call walls act as resistance, put walls as support
      if (nearby.nearCallWall && price >= gexData.call_wall) {
        return {
          action: 'sell',
          reason: `Price at call wall resistance ${gexData.call_wall}`
        };
      }

      if (nearby.nearPutWall && price <= gexData.put_wall) {
        return {
          action: 'buy',
          reason: `Price at put wall support ${gexData.put_wall}`
        };
      }
    }

    return { action: 'none', reason: 'No clear GEX signal' };
  }

  /**
   * Example backtest run
   */
  async runBacktest() {
    const startDate = new Date('2024-12-20');
    const endDate = new Date('2024-12-21');

    // Initialize with GEX data
    await this.initialize(startDate, endDate);

    // Simulate price data (in real implementation, load from OHLCV data)
    const mockPriceData = this.generateMockPriceData(startDate, endDate);

    console.log('\nRunning GEX-integrated backtest...\n');

    for (const dataPoint of mockPriceData) {
      const signal = this.evaluateSignal(dataPoint.timestamp, dataPoint.price, dataPoint.volume);

      if (signal.action !== 'none') {
        console.log(`${dataPoint.timestamp.toISOString()}: ${signal.action.toUpperCase()} at ${dataPoint.price}`);
        console.log(`  Reason: ${signal.reason}`);
        console.log(`  GEX Regime: ${signal.gexData.regime} (${(signal.gexData.totalGex / 1e9).toFixed(1)}B)`);
        console.log(`  Distance to Gamma Flip: ${signal.gexData.distanceToFlip.toFixed(1)} points\n`);

        // Record trade
        this.trades.push({
          timestamp: dataPoint.timestamp,
          action: signal.action,
          price: dataPoint.price,
          gexRegime: signal.gexData.regime,
          totalGex: signal.gexData.totalGex
        });
      }
    }

    console.log(`Backtest completed. Generated ${this.trades.length} trades.`);
    return this.trades;
  }

  /**
   * Generate mock price data for demonstration
   */
  generateMockPriceData(startDate, endDate) {
    const data = [];
    const current = new Date(startDate);
    let price = 426.75; // Starting QQQ price

    while (current <= endDate) {
      // Add some random price movement
      const change = (Math.random() - 0.5) * 2; // ±1 point random walk
      price += change;

      data.push({
        timestamp: new Date(current),
        price: price,
        volume: Math.floor(Math.random() * 1000) + 100
      });

      // Advance by 3 minutes (to match GEX data frequency)
      current.setMinutes(current.getMinutes() + 3);
    }

    return data;
  }
}

// Example usage
async function runExample() {
  console.log('='.repeat(60));
  console.log('GEX-Integrated Backtesting Example');
  console.log('='.repeat(60));

  try {
    const strategy = new GEXIntegratedStrategy();
    const trades = await strategy.runBacktest();

    console.log('\n' + '='.repeat(60));
    console.log('BACKTEST RESULTS');
    console.log('='.repeat(60));

    // Analyze trades by GEX regime
    const tradesByRegime = {};
    for (const trade of trades) {
      const regime = trade.gexRegime;
      if (!tradesByRegime[regime]) {
        tradesByRegime[regime] = [];
      }
      tradesByRegime[regime].push(trade);
    }

    console.log('\nTrades by GEX Regime:');
    for (const [regime, regimeTrades] of Object.entries(tradesByRegime)) {
      console.log(`  ${regime}: ${regimeTrades.length} trades`);

      const actions = regimeTrades.reduce((acc, trade) => {
        acc[trade.action] = (acc[trade.action] || 0) + 1;
        return acc;
      }, {});

      console.log(`    Actions: ${JSON.stringify(actions)}`);
    }

  } catch (error) {
    console.error('Example failed:', error.message);
    console.log('\nNote: This example requires actual GEX data files.');
    console.log('Run the OPRA processor first to generate the required data.');
  }
}

// Integration with existing backtest engine
class GEXEnhancedBacktester {
  constructor(backtestEngine) {
    this.backtestEngine = backtestEngine;
    this.gexLoader = new GexLoader();
  }

  /**
   * Enhance existing strategy with GEX data
   */
  enhanceStrategy(originalStrategy) {
    const originalEvaluate = originalStrategy.evaluateSignal.bind(originalStrategy);

    // Wrap the original strategy's evaluate method
    originalStrategy.evaluateSignal = (timestamp, candle, indicators) => {
      // Get original signal
      const originalSignal = originalEvaluate(timestamp, candle, indicators);

      // Get GEX data for this timestamp
      const gexData = this.gexLoader.getGexLevels(timestamp);

      // Enhance signal with GEX information
      if (gexData) {
        return this.enhanceSignalWithGEX(originalSignal, gexData, candle.close);
      }

      return originalSignal;
    };

    return originalStrategy;
  }

  /**
   * Enhance trading signal with GEX data
   */
  enhanceSignalWithGEX(originalSignal, gexData, price) {
    // Example: Filter signals based on GEX regime
    if (gexData.regime === 'strong_negative' && originalSignal.action === 'buy') {
      // In strong negative GEX, avoid buy signals (high volatility expected)
      return {
        ...originalSignal,
        action: 'none',
        reason: `${originalSignal.reason} [FILTERED: Strong negative GEX environment]`,
        gexFilter: 'strong_negative_filter'
      };
    }

    // Example: Enhance signals near gamma flip
    const nearby = this.gexLoader.getNearbyLevels(new Date(), price);
    if (nearby.nearGammaFlip) {
      return {
        ...originalSignal,
        confidence: (originalSignal.confidence || 1.0) * 1.2, // Boost confidence near gamma flip
        reason: `${originalSignal.reason} [ENHANCED: Near gamma flip]`,
        gexEnhancement: 'gamma_flip_proximity'
      };
    }

    return {
      ...originalSignal,
      gexData: {
        regime: gexData.regime,
        totalGex: gexData.total_gex,
        nearGammaFlip: nearby.nearGammaFlip
      }
    };
  }
}

module.exports = {
  GEXIntegratedStrategy,
  GEXEnhancedBacktester
};

// Run example if called directly
if (require.main === module) {
  runExample();
}