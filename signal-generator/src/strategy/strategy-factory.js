/**
 * Strategy Factory
 *
 * Creates strategy instances based on configuration.
 * Centralizes strategy instantiation and parameter handling.
 */

import { createLogger } from '../../../shared/index.js';
import { GexScalpStrategy } from '../../../shared/strategies/gex-scalp.js';
import { IVSkewGexStrategy } from '../../../shared/strategies/iv-skew-gex.js';

const logger = createLogger('strategy-factory');

/**
 * Available strategy types
 */
export const STRATEGY_TYPES = {
  GEX_SCALP: 'gex-scalp',
  IV_SKEW_GEX: 'iv-skew-gex'
};

/**
 * Create a strategy instance based on name and configuration
 *
 * @param {string} strategyName - Strategy type name
 * @param {Object} config - Configuration object with getStrategyParams/getIVSkewStrategyParams methods
 * @returns {Object} Strategy instance
 */
export function createStrategy(strategyName, config) {
  logger.info(`Creating strategy: ${strategyName}`);

  switch (strategyName.toLowerCase()) {
    case STRATEGY_TYPES.IV_SKEW_GEX:
    case 'iv_skew_gex':
    case 'ivskewgex':
      return createIVSkewGexStrategy(config);

    case STRATEGY_TYPES.GEX_SCALP:
    case 'gex_scalp':
    case 'gexscalp':
    default:
      return createGexScalpStrategy(config);
  }
}

/**
 * Create GEX Scalp strategy with proper parameters
 */
function createGexScalpStrategy(config) {
  const params = config.getStrategyParams();

  // Add standard GEX Scalp params
  params.tradingSymbol = config.TRADING_SYMBOL;
  params.defaultQuantity = config.DEFAULT_QUANTITY;
  params.signalCooldownMs = 65000; // 65 seconds
  params.debug = true;

  logger.info(`GEX Scalp params: useSessionFilter=${params.useSessionFilter}, ` +
    `allowedSessions=${params.allowedSessions?.join(',')}, ` +
    `tradeLevels=${params.tradeLevels?.join(',')}, ` +
    `touchThreshold=${params.touchThreshold || 3}`);

  return new GexScalpStrategy(params);
}

/**
 * Create IV Skew GEX strategy with proper parameters
 */
function createIVSkewGexStrategy(config) {
  const params = config.getIVSkewStrategyParams();

  // Add common params
  params.tradingSymbol = config.TRADING_SYMBOL;
  params.defaultQuantity = config.DEFAULT_QUANTITY;
  params.debug = true;

  logger.info(`IV-Skew-GEX params: stopLoss=${params.stopLossPoints}, ` +
    `takeProfit=${params.takeProfitPoints}, ` +
    `breakevenStop=${params.breakevenStop}, ` +
    `breakevenTrigger=${params.breakevenTrigger}, ` +
    `levelProximity=${params.levelProximity}, ` +
    `negSkewThreshold=${params.negSkewThreshold}, ` +
    `posSkewThreshold=${params.posSkewThreshold}, ` +
    `minIV=${params.minIV}`);

  return new IVSkewGexStrategy(params);
}

/**
 * Get the strategy name constant for a given strategy type
 * Used for tracking in position/order events
 */
export function getStrategyConstant(strategyName) {
  switch (strategyName.toLowerCase()) {
    case STRATEGY_TYPES.IV_SKEW_GEX:
    case 'iv_skew_gex':
    case 'ivskewgex':
      return 'IV_SKEW_GEX';

    case STRATEGY_TYPES.GEX_SCALP:
    case 'gex_scalp':
    case 'gexscalp':
    default:
      return 'GEX_SCALP';
  }
}

/**
 * Check if a strategy requires IV data
 */
export function requiresIVData(strategyName) {
  switch (strategyName.toLowerCase()) {
    case STRATEGY_TYPES.IV_SKEW_GEX:
    case 'iv_skew_gex':
    case 'ivskewgex':
      return true;

    default:
      return false;
  }
}

/**
 * Check if a strategy supports breakeven stops
 */
export function supportsBreakevenStop(strategyName) {
  switch (strategyName.toLowerCase()) {
    case STRATEGY_TYPES.IV_SKEW_GEX:
    case 'iv_skew_gex':
    case 'ivskewgex':
      return true;

    default:
      return false;
  }
}

export default {
  createStrategy,
  getStrategyConstant,
  requiresIVData,
  supportsBreakevenStop,
  STRATEGY_TYPES
};
