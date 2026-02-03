/**
 * GEX Mean Reversion Strategy - Configuration
 *
 * Default parameters and parameter ranges for optimization
 */

export const defaultConfig = {
  // Strategy identification
  name: 'GEX_MEAN_REVERSION',
  version: '1.0.0',

  // GEX level proximity (points)
  levelProximity: 15,

  // Risk management - MUST maintain 1:3 R:R minimum
  stopLossPoints: 20,      // Max 30 points
  takeProfitPoints: 60,    // Must be >= 3x stop
  maxHoldBars: 60,         // 1 hour on 1m chart

  // Signal management
  signalCooldownMs: 1800000, // 30 minutes

  // GEX regime filter
  requireNegativeGEX: true,

  // IV filter
  maxIVPercentile: 80,

  // Session filter
  useSessionFilter: true,
  allowedSessions: ['rth'],

  // Entry cutoff (EST)
  entryCutoffHour: 15,
  entryCutoffMinute: 30,

  // Trailing stop (optional)
  useTrailingStop: false,
  trailingTrigger: 30,
  trailingOffset: 10,

  // Trading
  tradingSymbol: 'NQ',
  defaultQuantity: 1,

  // Debug
  debug: false
};

export const parameterRanges = {
  levelProximity: {
    min: 10,
    max: 25,
    step: 5,
    description: 'Points from GEX level to consider "near"'
  },
  stopLossPoints: {
    min: 15,
    max: 30,
    step: 5,
    description: 'Fixed stop loss distance in points',
    constraint: 'Must be <= 30'
  },
  takeProfitPoints: {
    min: 45,
    max: 90,
    step: 15,
    description: 'Fixed take profit distance in points',
    constraint: 'Must be >= 3x stopLossPoints'
  },
  signalCooldownMs: {
    min: 900000,
    max: 3600000,
    step: 900000,
    description: 'Milliseconds between signals (15-60 min)'
  },
  maxHoldBars: {
    min: 30,
    max: 120,
    step: 30,
    description: 'Maximum bars to hold before time stop'
  },
  maxIVPercentile: {
    min: 60,
    max: 90,
    step: 10,
    description: 'Maximum IV percentile to trade'
  },
  trailingTrigger: {
    min: 20,
    max: 40,
    step: 5,
    description: 'Points profit before trailing activates'
  },
  trailingOffset: {
    min: 5,
    max: 15,
    step: 5,
    description: 'Points behind high water mark for trailing stop'
  }
};

/**
 * Validate configuration
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result { valid, errors }
 */
export function validateConfig(config) {
  const errors = [];

  // Stop loss must be <= 30 points
  if (config.stopLossPoints > 30) {
    errors.push(`Stop loss (${config.stopLossPoints}) exceeds 30 point maximum`);
  }

  // R:R must be >= 3.0
  const rr = config.takeProfitPoints / config.stopLossPoints;
  if (rr < 3.0) {
    errors.push(`R:R ratio (${rr.toFixed(2)}) is below 3.0 minimum`);
  }

  // Sessions must be valid
  const validSessions = ['overnight', 'premarket', 'rth', 'afterhours'];
  if (config.allowedSessions) {
    for (const session of config.allowedSessions) {
      if (!validSessions.includes(session)) {
        errors.push(`Invalid session: ${session}`);
      }
    }
  }

  // Entry cutoff must be valid
  if (config.entryCutoffHour < 0 || config.entryCutoffHour > 23) {
    errors.push(`Invalid entry cutoff hour: ${config.entryCutoffHour}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Generate parameter combinations for grid search optimization
 * @param {Object} ranges - Parameter ranges to search
 * @returns {Array} Array of parameter combinations
 */
export function generateParameterGrid(ranges = parameterRanges) {
  const combinations = [];

  // Generate combinations for key parameters
  const stopValues = [15, 20, 25, 30];
  const proximityValues = [10, 15, 20, 25];
  const cooldownValues = [1800000, 2700000, 3600000]; // 30, 45, 60 min

  for (const stop of stopValues) {
    const target = stop * 3; // Maintain 1:3 R:R

    for (const proximity of proximityValues) {
      for (const cooldown of cooldownValues) {
        combinations.push({
          ...defaultConfig,
          stopLossPoints: stop,
          takeProfitPoints: target,
          levelProximity: proximity,
          signalCooldownMs: cooldown
        });
      }
    }
  }

  return combinations;
}

export default {
  defaultConfig,
  parameterRanges,
  validateConfig,
  generateParameterGrid
};
