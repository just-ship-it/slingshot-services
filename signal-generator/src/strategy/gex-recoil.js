// GEX Recoil Fade strategy implementation - enters long when price crosses below GEX put wall
import { createLogger } from '../../../shared/index.js';
import config from '../utils/config.js';

const logger = createLogger('gex-recoil-strategy');

class GexRecoilStrategy {
  constructor(params = null) {
    this.params = params || config.getStrategyParams();
    this.prevCandle = null;
    this.lastSignalTime = 0;
    this.signalCooldown = 900000; // 15 minutes between signals (in milliseconds)
  }

  evaluateEntry(candle, prevCandle, gexLevels, ltLevels) {
    // Check cooldown
    if (candle.timestamp - this.lastSignalTime < this.signalCooldown) {
      return null;
    }

    // Get GEX levels to check (in priority order)
    const levelsToCheck = [
      ['put_wall', gexLevels.putWall],
      ['support_1', gexLevels.support?.[0]],
      ['support_2', gexLevels.support?.[1]],
      ['support_3', gexLevels.support?.[2]],
    ];

    for (const [levelName, levelValue] of levelsToCheck) {
      if (levelValue === null || levelValue === undefined) {
        continue;
      }

      // Did price cross below this level?
      if (prevCandle.close >= levelValue && candle.close < levelValue) {
        logger.info(`Price crossed below ${levelName} at ${levelValue}`);

        // Apply liquidity filter if enabled
        let ltBelow = 0;
        if (this.params.useLiquidityFilter && ltLevels) {
          ltBelow = this.countLtLevelsBelow(ltLevels, levelValue);
          if (ltBelow > this.params.maxLtLevelsBelow) {
            logger.info(`Liquidity filter failed: ${ltBelow} LT levels below (max: ${this.params.maxLtLevelsBelow})`);
            continue;
          }
        }

        // Risk calculation
        const stopPrice = candle.low - this.params.stopBuffer;
        const risk = candle.close - stopPrice;

        // Apply risk filter
        if (risk > this.params.maxRisk || risk <= 0) {
          logger.info(`Risk filter failed: ${risk.toFixed(2)} points (max: ${this.params.maxRisk})`);
          continue;
        }

        // Valid entry found
        this.lastSignalTime = candle.timestamp;
        return {
          side: 'buy',
          entryPrice: candle.close,
          stopLoss: stopPrice,
          takeProfit: candle.close + this.params.targetPoints,
          gexLevel: levelValue,
          gexLevelType: levelName,
          ltLevelsBelow: ltBelow,
          riskPoints: risk,
        };
      }
    }

    return null;
  }

  countLtLevelsBelow(ltLevels, price) {
    // Count LT levels below the given price
    // This is a simplified implementation - adjust based on actual LT levels structure
    if (!ltLevels || !ltLevels.support) {
      return 0;
    }

    return ltLevels.support.filter(level => level < price).length;
  }

  generateSignal(candle, gexLevels, ltLevels = null) {
    // Need previous candle to check for crossover
    if (!this.prevCandle) {
      this.prevCandle = candle;
      return null;
    }

    // Skip if different symbol
    if (candle.symbol !== this.prevCandle.symbol) {
      logger.warn(`Symbol mismatch: ${candle.symbol} != ${this.prevCandle.symbol}`);
      this.prevCandle = candle;
      return null;
    }

    // Evaluate entry
    const entry = this.evaluateEntry(candle, this.prevCandle, gexLevels, ltLevels);

    // Update previous candle
    this.prevCandle = candle;

    if (!entry) {
      return null;
    }

    // Create trade signal in webhook format
    const signal = {
      webhook_type: 'trade_signal',
      action: 'place_limit',
      side: entry.side,
      symbol: config.TRADING_SYMBOL,
      price: entry.entryPrice,
      stop_loss: entry.stopLoss,
      take_profit: entry.takeProfit,
      quantity: config.DEFAULT_QUANTITY,
      strategy: 'GEX_RECOIL',
      timestamp: new Date().toISOString(),
      metadata: {
        gex_level: entry.gexLevel,
        gex_level_type: entry.gexLevelType,
        lt_levels_below: entry.ltLevelsBelow,
        risk_points: entry.riskPoints,
        candle_time: new Date(candle.timestamp).toISOString(),
        entry_reason: `Price crossed below ${entry.gexLevelType} at ${entry.gexLevel}`
      }
    };

    // Add trailing stop if enabled
    if (this.params.useTrailingStop) {
      signal.trailing_trigger = this.params.trailingTrigger;
      signal.trailing_offset = this.params.trailingOffset;
    }

    logger.info(`Generated signal: ${entry.side.toUpperCase()} ${config.TRADING_SYMBOL} @ ${entry.entryPrice.toFixed(2)}, ` +
               `SL: ${entry.stopLoss.toFixed(2)}, TP: ${entry.takeProfit.toFixed(2)}`);

    return signal;
  }

  reset() {
    this.prevCandle = null;
    this.lastSignalTime = 0;
    logger.info('Strategy state reset');
  }
}

export default GexRecoilStrategy;