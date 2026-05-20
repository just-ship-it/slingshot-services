/**
 * Strategy Factory
 *
 * Creates strategy instances based on configuration.
 * Centralizes strategy instantiation and parameter handling.
 */

import { createLogger } from '../../../shared/index.js';
import { GexScalpStrategy } from '../../../shared/strategies/gex-scalp.js';
import { IVSkewGexStrategy } from '../../../shared/strategies/iv-skew-gex.js';
import { ESCrossSignalStrategy } from '../../../shared/strategies/es-cross-signal.js';
import { EsStopHuntStrategy } from '../../../shared/strategies/es-stop-hunt.js';
import { MnqAdaptiveScalperStrategy } from '../../../shared/strategies/mnq-adaptive-scalper.js';
import { ImpulseFVGStrategy } from '../../../shared/strategies/impulse-fvg.js';
import { ShortDTEIVStrategy } from '../../../shared/strategies/short-dte-iv.js';
import { GexFlipIvpctStrategy } from '../../../shared/strategies/gex-flip-ivpct.js';
import { LTCandleRegimeStrategy } from '../../../shared/strategies/lt-candle-regime.js';
import { GexLt3mCrossoverStrategy } from '../../../shared/strategies/gex-lt-3m-crossover.js';
import { GexLevelFadeStrategy } from '../../../shared/strategies/gex-level-fade.js';
import { LsFlipTriggerBarStrategy } from '../../../shared/strategies/ls-flip-trigger-bar.js';

const logger = createLogger('strategy-factory');

/**
 * Available strategy types
 */
export const STRATEGY_TYPES = {
  GEX_SCALP: 'gex-scalp',
  IV_SKEW_GEX: 'iv-skew-gex',
  ES_CROSS_SIGNAL: 'es-cross-signal',
  ES_STOP_HUNT: 'es-stop-hunt',
  MNQ_ADAPTIVE_SCALPER: 'mnq-adaptive-scalper',
  IMPULSE_FVG: 'impulse-fvg',
  SHORT_DTE_IV: 'short-dte-iv',
  GEX_FLIP_IVPCT: 'gex-flip-ivpct',
  LT_CANDLE_REGIME: 'lt-candle-regime',
  GEX_LT_3M_CROSSOVER: 'gex-lt-3m-crossover',
  GEX_LEVEL_FADE: 'gex-level-fade',
  LS_FLIP_TRIGGER_BAR: 'ls-flip-trigger-bar',
  AI_TRADER: 'ai-trader'
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

    case STRATEGY_TYPES.ES_CROSS_SIGNAL:
    case 'es_cross_signal':
    case 'escrosssignal':
      return createESCrossSignalStrategy(config);

    case STRATEGY_TYPES.ES_STOP_HUNT:
    case 'es_stop_hunt':
    case 'esstophunt':
      return createEsStopHuntStrategy(config);

    case STRATEGY_TYPES.MNQ_ADAPTIVE_SCALPER:
    case 'mnq_adaptive_scalper':
    case 'mnqadaptivescalper':
      return createMnqAdaptiveScalperStrategy(config);

    case STRATEGY_TYPES.IMPULSE_FVG:
    case 'impulse_fvg':
    case 'impulsefvg':
      return createImpulseFVGStrategy(config);

    case STRATEGY_TYPES.SHORT_DTE_IV:
    case 'short_dte_iv':
    case 'shortdteiv':
    case 'sdiv':
      return createShortDTEIVStrategy(config);

    case STRATEGY_TYPES.LT_CANDLE_REGIME:
    case 'lt_candle_regime':
    case 'ltcandleregime':
    case 'lcr':
      return createLTCandleRegimeStrategy(config);

    case STRATEGY_TYPES.GEX_FLIP_IVPCT:
    case 'gex_flip_ivpct':
    case 'gexflipivpct':
    case 'gfi':
      return createGexFlipIvpctStrategy(config);

    case STRATEGY_TYPES.GEX_LT_3M_CROSSOVER:
    case 'gex_lt_3m_crossover':
    case 'gexlt3mcrossover':
    case 'glx':
      return createGexLt3mCrossoverStrategy(config);

    case STRATEGY_TYPES.GEX_LEVEL_FADE:
    case 'gex_level_fade':
    case 'gexlevelfade':
    case 'glf':
      return createGexLevelFadeStrategy(config);

    case STRATEGY_TYPES.LS_FLIP_TRIGGER_BAR:
    case 'ls_flip_trigger_bar':
    case 'lsfliptriggerbar':
    case 'ls-flip':
    case 'lstb':
      return createLsFlipTriggerBarStrategy(config);

    case STRATEGY_TYPES.AI_TRADER:
    case 'ai_trader':
    case 'aitrader':
      // AI Trader uses its own engine — return null placeholder
      return null;

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
 * Create ES Cross-Signal strategy with proper parameters
 */
function createESCrossSignalStrategy(config) {
  const params = config.getESCrossSignalParams();

  // Add common params
  params.tradingSymbol = config.TRADING_SYMBOL;
  params.defaultQuantity = config.DEFAULT_QUANTITY;
  params.debug = true;

  logger.info(`ES-Cross-Signal params: targetPoints=${params.targetPoints}, ` +
    `stopPoints=${params.stopPoints}, ` +
    `breakevenStop=${params.breakevenStop}, ` +
    `breakevenTrigger=${params.breakevenTrigger}, ` +
    `filterRegimeSide=${params.filterRegimeSide?.join(',')}, ` +
    `filterLtSpacingMax=${params.filterLtSpacingMax}`);

  return new ESCrossSignalStrategy(params);
}

/**
 * Create ES Stop Hunt strategy with proper parameters
 */
function createEsStopHuntStrategy(config) {
  const params = {};

  // Add common params
  params.tradingSymbol = config.TRADING_SYMBOL;
  params.defaultQuantity = config.DEFAULT_QUANTITY;
  params.debug = true;

  logger.info(`ES-Stop-Hunt params: symbol=${params.tradingSymbol}, ` +
    `quantity=${params.defaultQuantity}`);

  return new EsStopHuntStrategy(params);
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
    `maxHoldBars=${params.maxHoldBars}, ` +
    `breakevenStop=${params.breakevenStop}, ` +
    `breakevenTrigger=${params.breakevenTrigger}, ` +
    `breakevenOffset=${params.breakevenOffset}, ` +
    `levelProximity=${params.levelProximity}, ` +
    `negSkewThreshold=${params.negSkewThreshold}, ` +
    `posSkewThreshold=${params.posSkewThreshold}, ` +
    `minIV=${params.minIV}, ` +
    `blockedRegimes=${params.blockedRegimes ? params.blockedRegimes.join(',') : 'none'}`);

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

    case STRATEGY_TYPES.ES_CROSS_SIGNAL:
    case 'es_cross_signal':
    case 'escrosssignal':
      return 'ES_CROSS_SIGNAL';

    case STRATEGY_TYPES.ES_STOP_HUNT:
    case 'es_stop_hunt':
    case 'esstophunt':
      return 'ES_STOP_HUNT';

    case STRATEGY_TYPES.MNQ_ADAPTIVE_SCALPER:
    case 'mnq_adaptive_scalper':
    case 'mnqadaptivescalper':
      return 'MNQ_ADAPTIVE_SCALPER';

    case STRATEGY_TYPES.IMPULSE_FVG:
    case 'impulse_fvg':
    case 'impulsefvg':
      return 'IMPULSE_FVG';

    case STRATEGY_TYPES.SHORT_DTE_IV:
    case 'short_dte_iv':
    case 'shortdteiv':
    case 'sdiv':
      return 'SHORT_DTE_IV';

    case STRATEGY_TYPES.GEX_FLIP_IVPCT:
    case 'gex_flip_ivpct':
    case 'gexflipivpct':
    case 'gfi':
      return 'GEX_FLIP_IVPCT';

    case STRATEGY_TYPES.LT_CANDLE_REGIME:
    case 'lt_candle_regime':
    case 'ltcandleregime':
    case 'lcr':
      return 'LT_CANDLE_REGIME';

    case STRATEGY_TYPES.GEX_LT_3M_CROSSOVER:
    case 'gex_lt_3m_crossover':
    case 'gexlt3mcrossover':
    case 'glx':
      return 'GEX_LT_3M_CROSSOVER';

    case STRATEGY_TYPES.GEX_LEVEL_FADE:
    case 'gex_level_fade':
    case 'gexlevelfade':
    case 'glf':
      return 'GEX_LEVEL_FADE';

    case STRATEGY_TYPES.LS_FLIP_TRIGGER_BAR:
    case 'ls_flip_trigger_bar':
    case 'lsfliptriggerbar':
    case 'ls-flip':
    case 'lstb':
      return 'LS_FLIP_TRIGGER_BAR';

    case STRATEGY_TYPES.AI_TRADER:
    case 'ai_trader':
    case 'aitrader':
      return 'AI_TRADER';

    case STRATEGY_TYPES.GEX_SCALP:
    case 'gex_scalp':
    case 'gexscalp':
    default:
      return 'GEX_SCALP';
  }
}

/**
 * Get data requirements for a strategy (static, before instantiation).
 * Returns the strategy's declared data sources or null for config defaults.
 *
 * @param {string} strategyName - Strategy type name
 * @returns {Object|null} Data requirements manifest
 */
export function getDataRequirements(strategyName) {
  switch (strategyName.toLowerCase()) {
    case STRATEGY_TYPES.ES_CROSS_SIGNAL:
    case 'es_cross_signal':
    case 'escrosssignal':
      return ESCrossSignalStrategy.getDataRequirements();

    case STRATEGY_TYPES.ES_STOP_HUNT:
    case 'es_stop_hunt':
    case 'esstophunt':
      return EsStopHuntStrategy.getDataRequirements();

    case STRATEGY_TYPES.IV_SKEW_GEX:
    case 'iv_skew_gex':
    case 'ivskewgex':
      return IVSkewGexStrategy.getDataRequirements();

    case STRATEGY_TYPES.GEX_SCALP:
    case 'gex_scalp':
    case 'gexscalp':
      return GexScalpStrategy.getDataRequirements();

    case STRATEGY_TYPES.MNQ_ADAPTIVE_SCALPER:
    case 'mnq_adaptive_scalper':
    case 'mnqadaptivescalper':
      return MnqAdaptiveScalperStrategy.getDataRequirements();

    case STRATEGY_TYPES.IMPULSE_FVG:
    case 'impulse_fvg':
    case 'impulsefvg':
      return ImpulseFVGStrategy.getDataRequirements();

    case STRATEGY_TYPES.SHORT_DTE_IV:
    case 'short_dte_iv':
    case 'shortdteiv':
    case 'sdiv':
      return ShortDTEIVStrategy.getDataRequirements();

    case STRATEGY_TYPES.LT_CANDLE_REGIME:
    case 'lt_candle_regime':
    case 'ltcandleregime':
    case 'lcr':
      return LTCandleRegimeStrategy.getDataRequirements();

    case STRATEGY_TYPES.GEX_FLIP_IVPCT:
    case 'gex_flip_ivpct':
    case 'gexflipivpct':
    case 'gfi':
      return GexFlipIvpctStrategy.getDataRequirements();

    case STRATEGY_TYPES.GEX_LT_3M_CROSSOVER:
    case 'gex_lt_3m_crossover':
    case 'gexlt3mcrossover':
    case 'glx':
      return GexLt3mCrossoverStrategy.getDataRequirements();

    case STRATEGY_TYPES.GEX_LEVEL_FADE:
    case 'gex_level_fade':
    case 'gexlevelfade':
    case 'glf':
      return GexLevelFadeStrategy.getDataRequirements();

    case STRATEGY_TYPES.LS_FLIP_TRIGGER_BAR:
    case 'ls_flip_trigger_bar':
    case 'lsfliptriggerbar':
    case 'ls-flip':
    case 'lstb':
      return LsFlipTriggerBarStrategy.getDataRequirements();

    case STRATEGY_TYPES.AI_TRADER:
    case 'ai_trader':
    case 'aitrader':
      return {
        candles: { quoteSymbols: ['CME_MINI:NQ1!'], baseSymbol: 'NQ' },
        gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
        lt: { symbol: 'CME_MINI:NQ1!', timeframe: '15' },
        tradier: false,
        ivSkew: false,
      };

    default:
      return null;
  }
}

/**
 * Check if a strategy requires IV data
 */
export function requiresIVData(strategyName) {
  const reqs = getDataRequirements(strategyName);
  return reqs?.ivSkew === true;
}

/**
 * Check if a strategy supports breakeven stops
 */
export function supportsBreakevenStop(strategyName) {
  switch (strategyName.toLowerCase()) {
    case STRATEGY_TYPES.IV_SKEW_GEX:
    case 'iv_skew_gex':
    case 'ivskewgex':
    case STRATEGY_TYPES.ES_CROSS_SIGNAL:
    case 'es_cross_signal':
    case 'escrosssignal':
      return true;

    default:
      return false;
  }
}

/**
 * Create MNQ Adaptive Scalper strategy with proper parameters
 */
function createMnqAdaptiveScalperStrategy(config) {
  const params = config.getMnqAdaptiveScalperParams();

  params.tradingSymbol = config.TRADING_SYMBOL;
  params.defaultQuantity = config.DEFAULT_QUANTITY;
  params.debug = true;

  logger.info(`MNQ-Adaptive-Scalper params: stop=${params.stopPoints}, target=${params.targetPoints}, ` +
    `trail=${params.trailingTrigger}/${params.trailingOffset}, proximity=${params.proximity}, ` +
    `dailyLossLimit=${params.dailyLossLimit}, dailyTarget=${params.dailyTarget}`);

  return new MnqAdaptiveScalperStrategy(params);
}

/**
 * Create Impulse FVG strategy with sweep-optimized parameters
 */
function createImpulseFVGStrategy(config) {
  const params = config.getImpulseFVGParams();

  params.tradingSymbol = config.TRADING_SYMBOL;
  params.defaultQuantity = config.DEFAULT_QUANTITY;
  params.debug = true;

  logger.info(`Impulse-FVG params: mode=${params.mode}, trail=${params.trailingTrigger}/${params.trailingOffset}, ` +
    `target=${params.noFvgTargetPoints}, stopBuf=${params.noFvgStopBuffer}, ` +
    `cooldown=${params.signalCooldownMs}ms, minBody=${params.minBodyPoints}`);

  return new ImpulseFVGStrategy(params);
}

/**
 * Create Short-DTE IV strategy with sweep-optimized parameters
 */
function createShortDTEIVStrategy(config) {
  const params = config.getShortDTEIVParams();

  params.tradingSymbol = config.TRADING_SYMBOL;
  params.defaultQuantity = config.DEFAULT_QUANTITY;

  logger.info(`Short-DTE-IV params: threshold=${params.ivChangeThreshold}, ` +
    `stop=${params.stopPoints}, target=${params.targetPoints}, ` +
    `long=${params.enableLong}, short=${params.enableShort}, ` +
    `cooldown=${params.cooldownMs}ms`);

  return new ShortDTEIVStrategy(params);
}

/**
 * Create GEX-FLIP-IVPCT strategy with proper parameters
 */
function createGexFlipIvpctStrategy(config) {
  const params = config.getGexFlipIvpctParams();

  // Add common params
  params.tradingSymbol = config.TRADING_SYMBOL;
  params.defaultQuantity = config.DEFAULT_QUANTITY;
  params.liveMode = true;
  params.debug = false;

  logger.info(`GEX-FLIP-IVPCT params: wallProx=${params.wallProximity}, ` +
    `ivPctile [low<=${params.ivPctileLowMax}, high>=${params.ivPctileHighMin}], ` +
    `skewMin=${params.skewPositiveMin}, ` +
    `entry=${params.entryWindowStartHour}-${params.entryWindowEndHour} ET, ` +
    `cooldown=${params.signalCooldownMs}ms, maxHold=${params.maxHoldBars}min, ` +
    `stop=${params.globalStopPts}, target=${params.globalTargetPts}, ` +
    `breakevenStop=${params.breakevenStop}, breakevenTrigger=${params.breakevenTrigger}, breakevenOffset=${params.breakevenOffset}, ` +
    `fibRetrace=${params.fibRetrace}, fibRetracePct=${params.fibRetracePct}, fibActivationMFE=${params.fibActivationMFE}, ` +
    `lsBeOnFlip=${params.lsBeOnFlip === true ? `ON(off=${params.lsBeOffset ?? 0})` : 'off'}`);

  return new GexFlipIvpctStrategy(params);
}

/**
 * Create GEX-LT-3M-Crossover strategy.
 *
 * The strategy class bakes the W12 gold-standard config in as defaults
 * (4 active rules, force-any filter, no cooldown, 7am-16:00 ET window with
 * 13:00 blocked, 5min limit timeout, 16:40 ET EOD cutoff). Override via
 * config.getGexLt3mCrossoverParams() when present.
 */
function createGexLt3mCrossoverStrategy(config) {
  const overrides = typeof config.getGexLt3mCrossoverParams === 'function'
    ? config.getGexLt3mCrossoverParams()
    : {};
  const params = {
    ...overrides,
    tradingSymbol: config.TRADING_SYMBOL,
    defaultQuantity: config.DEFAULT_QUANTITY,
    // Mirror trade-orchestrator's EOD_CUTOFF_ET so the dashboard panel can
    // render the same cutoff time the orchestrator enforces.
    eodCutoffEt: overrides.eodCutoffEt ?? process.env.EOD_CUTOFF_ET ?? '16:40',
    debug: true,
  };

  logger.info(`GEX-LT-3M-Crossover params: ` +
    `disabledRules=${params.disabledRules ? Array.from(params.disabledRules).join(',') : 'W12-default'}, ` +
    `forceFilterAny=${params.forceFilterAny ?? true}, ` +
    `entry=${params.entryWindowStartHour ?? 7}-${params.entryWindowEndHour ?? 16} ET, ` +
    `blockedHours=${params.blockedHoursEt ?? '[13]'}, ` +
    `limitTimeoutCandles=${params.limitTimeoutCandles ?? 5}, ` +
    `lsBeOnFlip=${params.lsBeOnFlip === true ? `ON(off=${params.lsBeOffset ?? 0})` : 'off'}`);

  return new GexLt3mCrossoverStrategy(params);
}

/**
 * Create GEX-LEVEL-FADE strategy.
 *
 * Defaults to the 100/18 gold-standard config (2026-05-17 wide-net rebuild).
 * Overrides come from config.getGexLevelFadeParams() (GLF_* env vars).
 */
function createGexLevelFadeStrategy(config) {
  const overrides = typeof config.getGexLevelFadeParams === 'function'
    ? config.getGexLevelFadeParams()
    : {};
  const params = {
    ...overrides,
    tradingSymbol: config.TRADING_SYMBOL,
    defaultQuantity: config.DEFAULT_QUANTITY,
    // Mirror trade-orchestrator's EOD_CUTOFF_ET so the dashboard panel can
    // render the same cutoff time the orchestrator enforces.
    eodCutoffEt: overrides.eodCutoffEt ?? process.env.EOD_CUTOFF_ET ?? '16:40',
    debug: false,
  };

  logger.info(`GEX-LEVEL-FADE params: target=${params.targetPts}pt stop=${params.stopPts}pt mh=${params.maxHoldBars}bars, ` +
    `entry=${params.entryWindowStartHour ?? 9}:${String(params.entryWindowStartMinute ?? 0).padStart(2,'0')}-${params.entryWindowEndHour ?? 10}:${String(params.entryWindowEndMinute ?? 30).padStart(2,'0')} ET, ` +
    `minEp=${params.minEpisodeNum ?? 2}, includeGex=${params.includeGexLevels ?? false}, ` +
    `blockedRegimes=[${(params.blockedRegimes ?? ['strong_negative']).join(',')}], ` +
    `cooldown=${params.signalCooldownMs ?? 0}ms, ` +
    `lsBeOnFlip=${params.lsBeOnFlip === true ? `ON(off=${params.lsBeOffset ?? 0})` : 'off'}`);

  return new GexLevelFadeStrategy(params);
}

/**
 * Create LS-Flip-Trigger-Bar strategy.
 *
 * v2 prod-honest gold: 6,952 trades / $130,500 / PF 1.48 / Sharpe 10.97 / DD 1.93%
 * over Jan 2025 → Apr 2026. Default blocked hours [5, 16, 21] ET baked into the
 * strategy class; env overrides via LSTB_* vars. Trades the 1m LS-flip trigger
 * bar as a structural setup: limit-entry at fib retrace, opposite-extreme stop,
 * same-side-extreme target, cb_atr<1.81 filter to drop big-body momentum flips.
 */
function createLsFlipTriggerBarStrategy(config) {
  const overrides = typeof config.getLsFlipTriggerBarParams === 'function'
    ? config.getLsFlipTriggerBarParams()
    : {};
  const params = {
    ...overrides,
    tradingSymbol: config.TRADING_SYMBOL,
    defaultQuantity: config.DEFAULT_QUANTITY,
    eodCutoffEt: overrides.eodCutoffEt ?? process.env.EOD_CUTOFF_ET ?? '15:45',
    debug: false,
  };

  logger.info(`LS-FLIP-TRIGGER-BAR params: fib=${params.fib ?? 0.5}, cbAtrMax=${params.cbAtrMax ?? 1.81}, ` +
    `atrPeriod=${params.atrPeriod ?? 20}, fillTimeoutCandles=${params.fillTimeoutCandles ?? 10}, ` +
    `maxHoldBars=${params.maxHoldBars ?? 60}, blockedHours=[${params.blockedHoursEt ?? '5,16,21'}], ` +
    `eodCutoff=${params.eodCutoffEt}`);

  return new LsFlipTriggerBarStrategy(params);
}

function createLTCandleRegimeStrategy(config) {
  const params = config.getLTCandleRegimeParams();

  params.tradingSymbol = config.TRADING_SYMBOL;
  params.defaultQuantity = config.DEFAULT_QUANTITY;
  params.debug = true;

  logger.info(`LT-Candle-Regime params: holdBars=${params.holdBars}, ` +
    `ratchetTrigger=${params.ratchetTrigger}, ratchetTrailDist=${params.ratchetTrailDist}, ` +
    `maxHold=${params.maxHoldWithTrail}, direction=${params.direction}, ` +
    `requireSentiment=${params.requireSentiment}`);

  return new LTCandleRegimeStrategy(params);
}

export default {
  createStrategy,
  getStrategyConstant,
  getDataRequirements,
  requiresIVData,
  supportsBreakevenStop,
  STRATEGY_TYPES
};
