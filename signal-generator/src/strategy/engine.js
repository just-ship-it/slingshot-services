// Strategy engine that coordinates strategy evaluation on candle closes
import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';
import { CandleBuffer } from '../utils/candle-buffer.js';
import { CandleAggregator } from '../../../shared/utils/candle-aggregator.js';
import { createStrategy, getStrategyConstant, requiresIVData, supportsBreakevenStop } from './strategy-factory.js';
import config from '../utils/config.js';

const logger = createLogger('strategy-engine');

class StrategyEngine {
  constructor(gexCalculator, redisPublisher, options = {}) {
    this.gexCalculator = gexCalculator;
    this.redisPublisher = redisPublisher;

    // Strategy selection from config
    this.strategyName = config.ACTIVE_STRATEGY;
    this.strategyConstant = getStrategyConstant(this.strategyName);
    this.requiresIV = requiresIVData(this.strategyName);
    this.supportsBreakeven = supportsBreakevenStop(this.strategyName);

    // Initialize strategy using factory
    this.strategy = createStrategy(this.strategyName, config);

    // IV Skew Calculator reference (set by main service if needed)
    this.ivSkewCalculator = null;

    logger.info(`📊 Active strategy: ${this.strategyName} (${this.strategyConstant})`);
    logger.info(`   Requires IV data: ${this.requiresIV}, Supports breakeven: ${this.supportsBreakeven}`);

    // Initialize candle buffer for 1-minute data
    this.candleBuffer = new CandleBuffer({
      symbol: options.candleBaseSymbol || config.CANDLE_BASE_SYMBOL || 'NQ',
      timeframe: '1',
      maxSize: 100
    });

    // Evaluation timeframe: '1m' means evaluate every 1m candle (default),
    // '15m' etc. means aggregate 1m candles and only evaluate on completed higher-TF candles
    this.evalTimeframe = config.EVAL_TIMEFRAME || '1m';
    this.aggregator = null;
    if (this.evalTimeframe !== '1m') {
      this.aggregator = new CandleAggregator();
      this.aggregator.initIncremental(this.evalTimeframe, this.strategyConstant);
      this.lastEvaluatedPeriod = null; // Track last evaluated period to prevent double-eval
      logger.info(`📊 Evaluation timeframe: ${this.evalTimeframe} (aggregating 1m candles)`);
    } else {
      logger.info(`📊 Evaluation timeframe: 1m (every candle close)`);
    }

    this.currentLtLevels = null;
    this.enabled = config.STRATEGY_ENABLED;
    this.inSession = false;
    this.sessionStart = config.SESSION_START_HOUR;
    this.sessionEnd = config.SESSION_END_HOUR;
    this.prevCandle = null;

    // Pending order tracking for limit order timeout
    // Map: signalId -> { symbol, side, price, candleCount, placedAt, strategy }
    this.pendingOrders = new Map();
    this.orderTimeoutCandles = this.strategy.params?.limitOrderTimeout || 3;

    // Position state tracking
    this.inPosition = false;
    this.currentPosition = null; // { symbol, side, entryPrice, entryTime, strategy }

    // Position reconciliation tracking
    this.reconciliationConfirmed = false; // Log confirmation once after first successful check
    this.lastInPositionLogTime = 0; // Rate-limit the "skipping evaluation" info log

    // GF (Zero Gamma) Early Exit configuration
    // Matches backtest behavior: check every 15 minutes, trigger breakeven after 2+ consecutive adverse moves
    this.gfEarlyExitConfig = {
      enabled: config.GF_EARLY_EXIT_ENABLED ?? false,
      breakevenThreshold: config.GF_BREAKEVEN_THRESHOLD ?? 2,  // Consecutive adverse moves to trigger breakeven
      checkIntervalMs: 15 * 60 * 1000  // Check every 15 minutes (matches backtest GEX data resolution)
    };

    // GF tracking state (initialized when position opens)
    this.gfTrackingState = null;

    // Time-Based Trailing Stop configuration
    // Progressive trailing that tightens based on bars held and MFE
    this.timeBasedTrailingConfig = {
      enabled: config.TIME_BASED_TRAILING_ENABLED ?? false,
      rules: this.parseTimeBasedTrailingRules(config.TIME_BASED_TRAILING_RULES || '')
    };

    // Time-based trailing state (initialized when position opens)
    this.timeBasedTrailingState = null;

    // Subscribe to order and position events
    this.subscribeToOrderEvents();
    this.subscribeToPositionEvents();

    if (this.gfEarlyExitConfig.enabled) {
      logger.info(`🛡️ GF Early Exit enabled: breakeven after ${this.gfEarlyExitConfig.breakevenThreshold} consecutive adverse moves (15-min intervals)`);
    }

    if (this.timeBasedTrailingConfig.enabled) {
      logger.info(`⏱️ Time-Based Trailing enabled with ${this.timeBasedTrailingConfig.rules.length} rules:`);
      this.timeBasedTrailingConfig.rules.forEach((rule, i) => {
        const actionStr = rule.action === 'breakeven' ? 'breakeven' : `trail:${rule.trailDistance}`;
        logger.info(`   Rule ${i + 1}: After ${rule.afterBars} bars, if MFE >= ${rule.ifMFE} pts → ${actionStr}`);
      });
    }
  }

  /**
   * Parse time-based trailing rules from config string
   * Format: "bars,mfe,action|bars,mfe,action" where action is "breakeven" or "trail:N"
   * Example: "20,35,trail:20|35,50,trail:10"
   * @param {string} rulesStr - Rules configuration string
   * @returns {Array} Parsed rules array
   */
  parseTimeBasedTrailingRules(rulesStr) {
    if (!rulesStr || rulesStr.trim() === '') return [];

    const rules = [];
    const ruleParts = rulesStr.split('|');

    for (const part of ruleParts) {
      const [barsStr, mfeStr, actionStr] = part.split(',').map(s => s.trim());

      if (!barsStr || !mfeStr || !actionStr) {
        logger.warn(`Invalid time-based trailing rule: "${part}" - skipping`);
        continue;
      }

      const afterBars = parseInt(barsStr, 10);
      const ifMFE = parseFloat(mfeStr);

      if (isNaN(afterBars) || isNaN(ifMFE)) {
        logger.warn(`Invalid numeric values in rule: "${part}" - skipping`);
        continue;
      }

      let action, trailDistance;
      if (actionStr === 'breakeven') {
        action = 'breakeven';
        trailDistance = 0;
      } else if (actionStr.startsWith('trail:')) {
        action = 'trail';
        trailDistance = parseFloat(actionStr.substring(6));
        if (isNaN(trailDistance)) {
          logger.warn(`Invalid trail distance in rule: "${part}" - skipping`);
          continue;
        }
      } else {
        logger.warn(`Unknown action in rule: "${part}" - skipping`);
        continue;
      }

      rules.push({ afterBars, ifMFE, action, trailDistance });
    }

    // Sort rules by afterBars ascending so we apply them in order
    rules.sort((a, b) => a.afterBars - b.afterBars);

    return rules;
  }

  /**
   * Find a position matching this instance's base symbol (NQ or ES)
   * Filters out positions for other products so each signal-generator
   * instance only tracks its own product.
   * @param {Array} positions - Array of Tradovate position objects
   * @returns {Object|undefined} Matching position or undefined
   */
  _findMatchingPosition(positions) {
    const baseSymbol = config.CANDLE_BASE_SYMBOL || 'NQ';
    return positions.find(p => p.netPos !== 0 && p.symbol && p.symbol.includes(baseSymbol));
  }

  /**
   * Sync position state from Tradovate service on startup
   * Prevents duplicate signals if service restarts while in a position
   */
  async syncPositionState() {
    const maxRetries = 3;
    const delayMs = 3000; // 3 seconds between retries

    // Get account ID from config
    const accountId = config.TRADOVATE_ACCOUNT_ID;
    if (!accountId) {
      logger.warn('No TRADOVATE_ACCOUNT_ID configured, skipping position sync');
      return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`🔄 Syncing position state from Tradovate (attempt ${attempt}/${maxRetries})...`);

        // Fetch positions from Tradovate service
        const response = await fetch(`http://localhost:3011/positions/${accountId}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch positions: ${response.status}`);
        }

        const positions = await response.json();

        // Look for an open position matching this instance's product
        const openPosition = this._findMatchingPosition(positions);

        if (openPosition) {
          this.inPosition = true;
          this.currentPosition = {
            symbol: openPosition.symbol || `Contract ${openPosition.contractId}`,
            side: openPosition.netPos > 0 ? 'long' : 'short',
            entryPrice: openPosition.netPrice || 0,
            entryTime: openPosition.timestamp || new Date().toISOString(),
            strategy: this.strategyConstant,
            quantity: Math.abs(openPosition.netPos)
          };

          logger.info(`📈 Found existing position: ${this.currentPosition.side} ${this.currentPosition.symbol} @ ${this.currentPosition.entryPrice} (qty: ${this.currentPosition.quantity})`);
        } else {
          logger.info('✅ No open positions found - starting fresh');
        }

        return; // Success

      } catch (error) {
        logger.warn(`Position sync attempt ${attempt} failed: ${error.message}`);

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          logger.warn('⚠️ Continuing without position sync - may generate duplicate signals if position exists');
        }
      }
    }
  }

  /**
   * Periodically reconcile internal position state against Tradovate
   * Catches stale state from missed WebSocket events (e.g., disconnects during fills)
   */
  async reconcilePositionState() {
    const accountId = config.TRADOVATE_ACCOUNT_ID;
    if (!accountId) {
      return; // No account configured, skip
    }

    try {
      const response = await fetch(`http://localhost:3011/positions/${accountId}`);
      if (!response.ok) {
        logger.debug(`[RECONCILE] Failed to fetch positions: ${response.status}`);
        return;
      }

      const positions = await response.json();
      const openPosition = this._findMatchingPosition(positions);

      if (this.inPosition && !openPosition) {
        // STALE: We think we're in a position but Tradovate says flat
        logger.warn(`[RECONCILE] Stale position detected! Internal state: ${this.currentPosition?.side} ${this.currentPosition?.symbol} @ ${this.currentPosition?.entryPrice} — Tradovate: flat. Resetting.`);
        this.inPosition = false;
        this.currentPosition = null;
        this.gfTrackingState = null;
        this.timeBasedTrailingState = null;
        this.strategy.lastSignalTime = 0;
        this.reconciliationConfirmed = false;
        logger.warn('[RECONCILE] Position state reset — strategy ready for next signal');

      } else if (!this.inPosition && openPosition) {
        // MISSED OPEN: Tradovate has a position we don't know about
        this.inPosition = true;
        this.currentPosition = {
          symbol: openPosition.symbol || `Contract ${openPosition.contractId}`,
          side: openPosition.netPos > 0 ? 'long' : 'short',
          entryPrice: openPosition.netPrice || 0,
          entryTime: openPosition.timestamp || new Date().toISOString(),
          strategy: this.strategyConstant,
          quantity: Math.abs(openPosition.netPos)
        };
        this.reconciliationConfirmed = false;
        logger.warn(`[RECONCILE] Missed position open detected! Now tracking: ${this.currentPosition.side} ${this.currentPosition.symbol} @ ${this.currentPosition.entryPrice} (qty: ${this.currentPosition.quantity})`);

      } else if (!this.reconciliationConfirmed) {
        // States match — log once on first successful check
        const stateDesc = this.inPosition
          ? `in position (${this.currentPosition?.side} ${this.currentPosition?.symbol})`
          : 'flat';
        logger.info(`[RECONCILE] Position state confirmed: ${stateDesc}`);
        this.reconciliationConfirmed = true;
      }

    } catch (error) {
      logger.debug(`[RECONCILE] Check skipped (fetch error): ${error.message}`);
    }
  }

  /**
   * Subscribe to order events for tracking pending limit orders
   */
  subscribeToOrderEvents() {
    // Track when our orders are placed
    messageBus.subscribe(CHANNELS.ORDER_PLACED, (message) => {
      this.handleOrderPlaced(message);
    });

    // Remove from tracking when filled (entry fill means we're now in position)
    messageBus.subscribe(CHANNELS.ORDER_FILLED, (message) => {
      this.handleOrderFilled(message);
    });

    // Remove from tracking when cancelled
    messageBus.subscribe(CHANNELS.ORDER_CANCELLED, (message) => {
      this.handleOrderCancelled(message);
    });

    logger.info('Subscribed to order events for limit order timeout tracking');
  }

  /**
   * Subscribe to position events to track when we're in/out of a position
   */
  subscribeToPositionEvents() {
    // Subscribe to POSITION_UPDATE - trade-orchestrator publishes all position changes here
    messageBus.subscribe(CHANNELS.POSITION_UPDATE, (message) => {
      this.handlePositionUpdate(message);
    });

    // Also subscribe to POSITION_CLOSED for explicit close events
    messageBus.subscribe(CHANNELS.POSITION_CLOSED, (message) => {
      this.handlePositionClosed(message);
    });

    logger.info('Subscribed to position events for state tracking');
  }

  /**
   * Handle position update - detect opens and closes
   */
  handlePositionUpdate(message) {
    // Check if this is a position close (netPos = 0 or source indicates closure)
    if (message.netPos === 0 || message.source === 'position_closed') {
      this.handlePositionClosed(message);
      return;
    }

    // Otherwise it's a new or updated position
    if (message.netPos !== 0) {
      this.handlePositionOpened(message);
    }
  }

  /**
   * Handle position opened - mark as in position
   */
  handlePositionOpened(message) {
    // Only track positions from our strategy
    if (message.strategy !== this.strategyConstant) {
      return;
    }

    this.inPosition = true;
    this.currentPosition = {
      symbol: message.symbol,
      side: message.side || (message.action === 'Buy' ? 'long' : 'short'),
      entryPrice: message.price || message.entryPrice,
      entryTime: message.timestamp || new Date().toISOString(),
      strategy: message.strategy,
      orderStrategyId: message.orderStrategyId || message.order_strategy_id,
      stopOrderId: message.stopOrderId || message.stop_order_id
    };

    logger.info(`📈 Position opened: ${this.currentPosition.side} ${this.currentPosition.symbol} @ ${this.currentPosition.entryPrice}`);

    // Initialize GF tracking state for early exit monitoring
    if (this.gfEarlyExitConfig.enabled) {
      this.initializeGFTracking();
    }

    // Initialize time-based trailing state
    if (this.timeBasedTrailingConfig.enabled) {
      this.initializeTimeBasedTrailing();
    }
  }

  /**
   * Handle position closed - reset state for next signal
   */
  handlePositionClosed(message) {
    // Only track positions from our strategy
    if (message.strategy !== this.strategyConstant && this.currentPosition?.strategy !== this.strategyConstant) {
      return;
    }

    const exitInfo = message.exitPrice ? ` @ ${message.exitPrice}` : '';
    const pnlInfo = message.pnl ? ` (P&L: ${message.pnl > 0 ? '+' : ''}${message.pnl})` : '';
    const reasonInfo = message.reason ? ` - ${message.reason}` : '';

    logger.info(`📉 Position closed${exitInfo}${pnlInfo}${reasonInfo}`);

    // Reset position state
    this.inPosition = false;
    this.currentPosition = null;

    // Reset GF tracking state
    this.gfTrackingState = null;

    // Reset time-based trailing state
    this.timeBasedTrailingState = null;

    // Reset strategy cooldown so we're immediately ready for next signal
    this.strategy.lastSignalTime = 0;

    logger.info('✅ Strategy reset and ready for next signal');
  }

  /**
   * Initialize GF tracking state when a position is opened
   * Records the entry GF level for comparison during the trade
   */
  initializeGFTracking() {
    const gexLevels = this.gexCalculator.getCurrentLevels();
    if (!gexLevels || gexLevels.gammaFlip == null) {
      logger.warn('Cannot initialize GF tracking - no GEX levels available');
      return;
    }

    // Calculate current 15-minute period (aligned to clock time)
    // This ensures we evaluate on GEX update boundaries, not relative to position entry
    const now = Date.now();
    const periodMs = this.gfEarlyExitConfig.checkIntervalMs;
    const currentPeriod = Math.floor(now / periodMs);

    this.gfTrackingState = {
      entryGF: gexLevels.gammaFlip,
      lastGF: gexLevels.gammaFlip,
      lastCheckPeriod: currentPeriod,  // Track which 15-min period was last evaluated
      consecutiveAdverse: 0,
      breakevenTriggered: false
    };

    logger.info(`🛡️ GF tracking initialized: entry GF = ${gexLevels.gammaFlip.toFixed(2)}, period = ${currentPeriod}`);
  }

  /**
   * Check for adverse GF movement and trigger breakeven if threshold reached
   * Uses period-based checking aligned to 15-minute clock boundaries (matches backtest behavior)
   *
   * Example: If GEX updates at :00, :15, :30, :45 and position opens at 10:14:30:
   * - Entry period = 40 (10:00-10:14:59)
   * - At 10:15:00, current period = 41, so we evaluate
   * - This ensures we check on each new GEX data period, not relative to entry time
   */
  checkGFEarlyExit() {
    // Skip if not enabled or not in position
    if (!this.gfEarlyExitConfig.enabled || !this.inPosition || !this.gfTrackingState) {
      return;
    }

    // Calculate current 15-minute period (aligned to clock time)
    const now = Date.now();
    const periodMs = this.gfEarlyExitConfig.checkIntervalMs;
    const currentPeriod = Math.floor(now / periodMs);

    // Only evaluate once per 15-minute period
    if (currentPeriod <= this.gfTrackingState.lastCheckPeriod) {
      return;
    }

    // Get current GF level
    const gexLevels = this.gexCalculator.getCurrentLevels();
    if (!gexLevels || gexLevels.gammaFlip == null) {
      logger.debug('No GEX levels available for GF early exit check');
      return;
    }

    const currentGF = gexLevels.gammaFlip;
    const gfDelta = currentGF - this.gfTrackingState.lastGF;
    const isLong = this.currentPosition.side === 'long' || this.currentPosition.side === 'buy';

    // Determine if movement is adverse to position
    const isAdverse = isLong ? gfDelta < 0 : gfDelta > 0;

    // Update tracking state - mark this period as checked
    this.gfTrackingState.lastCheckPeriod = currentPeriod;

    // Only count significant moves (filter noise)
    if (isAdverse && Math.abs(gfDelta) > 0.5) {
      this.gfTrackingState.consecutiveAdverse++;
      logger.info(`📉 [GF-EXIT] Adverse move #${this.gfTrackingState.consecutiveAdverse}: GF ${this.gfTrackingState.lastGF.toFixed(2)} → ${currentGF.toFixed(2)} (Δ${gfDelta.toFixed(2)})`);
    } else if (!isAdverse && Math.abs(gfDelta) > 0.5) {
      // Reset consecutive count on favorable move
      if (this.gfTrackingState.consecutiveAdverse > 0) {
        logger.info(`📈 [GF-EXIT] Favorable move, resetting consecutive count (was ${this.gfTrackingState.consecutiveAdverse})`);
      }
      this.gfTrackingState.consecutiveAdverse = 0;
    }

    this.gfTrackingState.lastGF = currentGF;

    // Check if breakeven threshold reached
    if (this.gfTrackingState.consecutiveAdverse >= this.gfEarlyExitConfig.breakevenThreshold &&
        !this.gfTrackingState.breakevenTriggered) {
      logger.info(`🛡️ [GF-EXIT] Breakeven threshold reached (${this.gfTrackingState.consecutiveAdverse} consecutive adverse moves)`);
      this.gfTrackingState.breakevenTriggered = true;
      this.sendBreakevenStopModification();
    }
  }

  /**
   * Send modify_stop signal to move stop to breakeven (entry price)
   */
  async sendBreakevenStopModification() {
    if (!this.currentPosition) {
      logger.warn('Cannot send breakeven modification - no current position');
      return;
    }

    const modifyStopSignal = {
      webhook_type: 'trade_signal',
      action: 'modify_stop',
      strategy: this.currentPosition.strategy,
      symbol: this.currentPosition.symbol,
      new_stop_price: this.currentPosition.entryPrice,
      reason: 'gf_adverse_breakeven',
      order_strategy_id: this.currentPosition.orderStrategyId,
      order_id: this.currentPosition.stopOrderId,
      metadata: {
        entryPrice: this.currentPosition.entryPrice,
        consecutiveAdverse: this.gfTrackingState.consecutiveAdverse,
        entryGF: this.gfTrackingState.entryGF,
        currentGF: this.gfTrackingState.lastGF
      },
      timestamp: new Date().toISOString()
    };

    try {
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, modifyStopSignal);
      logger.info(`🛡️ [GF-EXIT] Breakeven stop modification sent: ${this.currentPosition.symbol} stop → ${this.currentPosition.entryPrice}`);
    } catch (error) {
      logger.error('Failed to send breakeven stop modification:', error);
    }
  }

  /**
   * Initialize time-based trailing state when a position is opened
   * Tracks MFE (Maximum Favorable Excursion), bars in trade, and current stop level
   */
  initializeTimeBasedTrailing() {
    if (!this.currentPosition) {
      logger.warn('Cannot initialize time-based trailing - no current position');
      return;
    }

    this.timeBasedTrailingState = {
      entryPrice: this.currentPosition.entryPrice,
      barsInTrade: 0,
      mfe: 0,                    // Maximum Favorable Excursion in points
      peakPrice: this.currentPosition.entryPrice,  // High water mark price
      currentStopPrice: null,   // Will be set when first rule triggers
      activeRuleIndex: -1,      // Index of the most recently applied rule
      lastModificationBar: -1,  // Bar when stop was last modified (prevent spam)
      rulesTriggered: []        // Track which rules have been triggered
    };

    logger.info(`⏱️ [TB-TRAIL] Initialized: entry @ ${this.currentPosition.entryPrice}, ${this.timeBasedTrailingConfig.rules.length} rules active`);
  }

  /**
   * Update time-based trailing on each candle
   * Called when a new 1-minute candle closes while in position
   * @param {Object} candle - The closed candle with OHLC data
   */
  updateTimeBasedTrailing(candle) {
    if (!this.timeBasedTrailingConfig.enabled || !this.inPosition || !this.timeBasedTrailingState) {
      return;
    }

    const state = this.timeBasedTrailingState;
    const isLong = this.currentPosition.side === 'long' || this.currentPosition.side === 'buy';
    const entryPrice = state.entryPrice;

    // Increment bars in trade
    state.barsInTrade++;

    // Update peak price and MFE
    if (isLong) {
      if (candle.high > state.peakPrice) {
        state.peakPrice = candle.high;
        state.mfe = state.peakPrice - entryPrice;
      }
    } else {
      // For shorts, peak is the lowest price (most favorable)
      if (candle.low < state.peakPrice) {
        state.peakPrice = candle.low;
        state.mfe = entryPrice - state.peakPrice;
      }
    }

    // Log status every 5 bars
    if (state.barsInTrade % 5 === 0) {
      logger.info(`⏱️ [TB-TRAIL] Bar ${state.barsInTrade}: MFE=${state.mfe.toFixed(1)} pts, Peak=${state.peakPrice.toFixed(2)}, Current=${candle.close.toFixed(2)}`);
    }

    // Check rules in order (they're sorted by afterBars)
    this.checkTimeBasedTrailingRules(candle);
  }

  /**
   * Check time-based trailing rules and apply if conditions are met
   * @param {Object} candle - Current candle data
   */
  checkTimeBasedTrailingRules(candle) {
    const state = this.timeBasedTrailingState;
    const rules = this.timeBasedTrailingConfig.rules;
    const isLong = this.currentPosition.side === 'long' || this.currentPosition.side === 'buy';

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];

      // Skip if already triggered this rule
      if (state.rulesTriggered.includes(i)) {
        continue;
      }

      // Check if rule conditions are met
      if (state.barsInTrade >= rule.afterBars && state.mfe >= rule.ifMFE) {
        // Calculate new stop price based on rule action
        let newStopPrice;

        if (rule.action === 'breakeven') {
          newStopPrice = state.entryPrice;
        } else {
          // Trail: stop is trailDistance behind peak
          if (isLong) {
            newStopPrice = state.peakPrice - rule.trailDistance;
          } else {
            newStopPrice = state.peakPrice + rule.trailDistance;
          }
        }

        // Only modify if new stop is better (tighter) than current
        const shouldUpdate = this.shouldUpdateStop(newStopPrice, isLong);

        if (shouldUpdate) {
          logger.info(`⏱️ [TB-TRAIL] Rule ${i + 1} triggered: bars=${state.barsInTrade} >= ${rule.afterBars}, MFE=${state.mfe.toFixed(1)} >= ${rule.ifMFE}`);
          logger.info(`⏱️ [TB-TRAIL] Moving stop: ${state.currentStopPrice?.toFixed(2) || 'initial'} → ${newStopPrice.toFixed(2)} (${rule.action === 'breakeven' ? 'breakeven' : `trail:${rule.trailDistance}`})`);

          // Mark rule as triggered
          state.rulesTriggered.push(i);
          state.activeRuleIndex = i;
          state.lastModificationBar = state.barsInTrade;

          // Send the stop modification
          this.sendTimeBasedTrailingModification(newStopPrice, rule, i);
        }
      }
    }
  }

  /**
   * Check if new stop price is better (tighter) than current
   * @param {number} newStopPrice - Proposed new stop price
   * @param {boolean} isLong - True if long position
   * @returns {boolean} True if stop should be updated
   */
  shouldUpdateStop(newStopPrice, isLong) {
    const state = this.timeBasedTrailingState;

    // Always update if no stop has been set yet
    if (state.currentStopPrice === null) {
      return true;
    }

    // For longs, higher stop is better (tighter)
    // For shorts, lower stop is better (tighter)
    if (isLong) {
      return newStopPrice > state.currentStopPrice;
    } else {
      return newStopPrice < state.currentStopPrice;
    }
  }

  /**
   * Send modify_stop signal for time-based trailing
   * @param {number} newStopPrice - New stop price
   * @param {Object} rule - The rule that triggered this modification
   * @param {number} ruleIndex - Index of the rule
   */
  async sendTimeBasedTrailingModification(newStopPrice, rule, ruleIndex) {
    if (!this.currentPosition) {
      logger.warn('Cannot send time-based trailing modification - no current position');
      return;
    }

    const state = this.timeBasedTrailingState;
    const actionStr = rule.action === 'breakeven' ? 'breakeven' : `trail:${rule.trailDistance}`;

    const modifyStopSignal = {
      webhook_type: 'trade_signal',
      action: 'modify_stop',
      strategy: this.currentPosition.strategy,
      symbol: this.currentPosition.symbol,
      new_stop_price: newStopPrice,
      reason: `time_based_trailing_rule_${ruleIndex + 1}`,
      order_strategy_id: this.currentPosition.orderStrategyId,
      order_id: this.currentPosition.stopOrderId,
      metadata: {
        entryPrice: state.entryPrice,
        barsInTrade: state.barsInTrade,
        mfe: state.mfe,
        peakPrice: state.peakPrice,
        ruleIndex: ruleIndex,
        ruleCondition: `bars>=${rule.afterBars}, MFE>=${rule.ifMFE}`,
        ruleAction: actionStr,
        previousStop: state.currentStopPrice
      },
      timestamp: new Date().toISOString()
    };

    try {
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, modifyStopSignal);

      // Update state with new stop price
      state.currentStopPrice = newStopPrice;

      logger.info(`⏱️ [TB-TRAIL] Stop modification sent: ${this.currentPosition.symbol} stop → ${newStopPrice.toFixed(2)} (Rule ${ruleIndex + 1}: ${actionStr})`);
    } catch (error) {
      logger.error('Failed to send time-based trailing stop modification:', error);
    }
  }

  /**
   * Handle order placed event - start tracking for timeout
   */
  handleOrderPlaced(message) {
    // Only track orders from our strategy
    if (message.strategy !== this.strategyConstant) {
      return;
    }

    const orderId = message.orderId || message.strategyId;
    if (!orderId) {
      logger.warn('Order placed without orderId, cannot track for timeout');
      return;
    }

    this.pendingOrders.set(orderId, {
      orderId: orderId,
      symbol: message.symbol,
      side: message.action === 'Buy' ? 'buy' : 'sell',
      price: message.price,
      candleCount: 0,
      placedAt: new Date().toISOString(),
      strategy: message.strategy
    });

    logger.info(`📋 Tracking pending order ${orderId} for timeout (${this.orderTimeoutCandles} candles)`);
  }

  /**
   * Handle order filled event - remove from tracking
   */
  handleOrderFilled(message) {
    const orderId = message.orderId || message.strategyId;
    if (orderId && this.pendingOrders.has(orderId)) {
      this.pendingOrders.delete(orderId);
      logger.info(`✅ Order ${orderId} filled, removed from timeout tracking`);
    }
  }

  /**
   * Handle order cancelled event - remove from tracking
   */
  handleOrderCancelled(message) {
    const orderId = message.orderId || message.strategyId;
    if (orderId && this.pendingOrders.has(orderId)) {
      this.pendingOrders.delete(orderId);
      logger.info(`🚫 Order ${orderId} cancelled, removed from timeout tracking`);
    }
  }

  /**
   * Check for timed out orders and send cancel signals
   * Called after each candle close
   */
  async checkOrderTimeouts() {
    if (this.pendingOrders.size === 0) {
      return;
    }

    const ordersToCancel = [];

    // Increment candle count and check for timeouts
    for (const [orderId, order] of this.pendingOrders) {
      order.candleCount++;
      logger.debug(`Order ${orderId} candle count: ${order.candleCount}/${this.orderTimeoutCandles}`);

      if (order.candleCount >= this.orderTimeoutCandles) {
        ordersToCancel.push(order);
      }
    }

    // Send cancel signals for timed out orders
    for (const order of ordersToCancel) {
      logger.info(`⏰ Order ${order.orderId} timed out after ${order.candleCount} candles, sending cancel_limit`);

      const cancelSignal = {
        webhook_type: 'trade_signal',
        action: 'cancel_limit',
        symbol: order.symbol,
        side: order.side,
        strategy: order.strategy,
        reason: `Limit order timeout after ${order.candleCount} candles (${order.candleCount} minutes)`,
        original_price: order.price,
        placed_at: order.placedAt,
        timestamp: new Date().toISOString()
      };

      await this.publishSignal(cancelSignal);

      // Remove from tracking (will also be removed when ORDER_CANCELLED event comes back)
      this.pendingOrders.delete(order.orderId);
    }
  }

  setLtLevels(ltLevels) {
    // Map monitor fields (L2-L6) to strategy fields (level_1-level_5)
    // Monitor L0/L1 are non-Fibonacci indicator outputs; L2-L6 are the Fib 34/55/144/377/610 levels
    if (ltLevels && ltLevels.L2 !== undefined) {
      this.currentLtLevels = {
        ...ltLevels,
        level_1: ltLevels.L2,
        level_2: ltLevels.L3,
        level_3: ltLevels.L4,
        level_4: ltLevels.L5,
        level_5: ltLevels.L6
      };
    } else {
      // Already has level_1-level_5 (e.g. from backtest loader)
      this.currentLtLevels = ltLevels;
    }
    logger.debug(`LT levels updated: ${JSON.stringify(this.currentLtLevels)}`);
  }

  setGexCalculator(gexCalculator) {
    this.gexCalculator = gexCalculator;
    logger.info('GEX calculator updated in strategy engine');
  }

  setIVSkewCalculator(ivSkewCalculator) {
    this.ivSkewCalculator = ivSkewCalculator;
    logger.info('IV Skew calculator set in strategy engine');
  }

  /**
   * Process incoming candle data from TradingView
   * @param {object} candleData - Raw candle data with TradingView timestamp
   * @returns {boolean} True if new candle was closed
   */
  processCandle(candleData) {
    // Add candle to buffer and check if it's a new closed candle
    return this.candleBuffer.addCandle(candleData);
  }

  isInTradingSession() {
    // Check if we're in the trading session (6PM - 4PM EST)
    const now = new Date();
    const hour = now.getHours();

    // Session runs from 18:00 to 16:00 next day
    if (this.sessionStart > this.sessionEnd) {
      // Session crosses midnight
      return hour >= this.sessionStart || hour < this.sessionEnd;
    } else {
      // Session within same day
      return hour >= this.sessionStart && hour < this.sessionEnd;
    }
  }

  async evaluateCandle(candle) {
    if (!this.enabled) {
      logger.debug('Strategy evaluation disabled');
      return;
    }

    // Check if we're in trading session
    if (!this.isInTradingSession()) {
      logger.debug('Outside trading session, skipping evaluation');
      return;
    }

    // If in position, update time-based trailing but skip new signal evaluation
    if (this.inPosition) {
      // Update time-based trailing on each candle close (always on 1m)
      if (this.timeBasedTrailingConfig.enabled && this.timeBasedTrailingState) {
        this.updateTimeBasedTrailing(candle);
      }
      const now = Date.now();
      if (now - this.lastInPositionLogTime >= 60000) {
        logger.info(`Skipping signal evaluation - in position: ${this.currentPosition?.side} ${this.currentPosition?.symbol} @ ${this.currentPosition?.entryPrice}`);
        this.lastInPositionLogTime = now;
      }
      // Always check order timeouts on every 1m candle
      await this.checkOrderTimeouts();
      return;
    }

    // Only evaluate candles matching configured base symbol
    const baseSymbol = config.CANDLE_BASE_SYMBOL || 'NQ';
    if (!candle.symbol.includes(baseSymbol)) {
      logger.debug(`Skipping non-${baseSymbol} symbol: ${candle.symbol}`);
      return;
    }

    // If using a higher evaluation timeframe, aggregate 1m candles
    // and only run strategy evaluation when a new aggregated candle completes
    if (this.aggregator) {
      const key = `${this.strategyConstant}_${this.evalTimeframe}`;
      const state = this.aggregator.incrementalState[key];
      const prevCompletedCount = state ? state.aggregatedCandles.length : 0;

      this.aggregator.addCandleIncremental(candle, this.evalTimeframe, this.strategyConstant);

      const newCompletedCount = state ? state.aggregatedCandles.length : 0;

      let completedCandle = null;

      if (newCompletedCount > prevCompletedCount) {
        // Aggregator finalized previous period (a candle from the next period arrived).
        // Only evaluate if we didn't already evaluate this period early.
        const finalized = state.aggregatedCandles[state.aggregatedCandles.length - 1];
        if (finalized.timestamp !== this.lastEvaluatedPeriod) {
          completedCandle = finalized;
          this.lastEvaluatedPeriod = finalized.timestamp;
        }
      }

      if (!completedCandle && state && state.currentPeriod) {
        // Check if this 1m candle is the LAST in the current period
        // (i.e., the next minute would start a new period)
        const candleTime = typeof candle.timestamp === 'number'
          ? candle.timestamp : new Date(candle.timestamp).getTime();
        const nextMinute = candleTime + 60000;
        const intervalMinutes = this.aggregator.getIntervalMinutes(this.evalTimeframe);
        const currentPeriodStart = this.aggregator.getPeriodStart(candleTime, intervalMinutes);
        const nextPeriodStart = this.aggregator.getPeriodStart(nextMinute, intervalMinutes);

        if (nextPeriodStart !== currentPeriodStart && currentPeriodStart !== this.lastEvaluatedPeriod) {
          // This is the last 1m candle in the period — evaluate now
          completedCandle = { ...state.currentPeriod };
          this.lastEvaluatedPeriod = currentPeriodStart;
        }
      }

      if (!completedCandle) {
        // Still accumulating — check order timeouts on every 1m candle
        await this.checkOrderTimeouts();
        return;
      }

      logger.info(`🕯️ ${this.evalTimeframe} candle closed: O=${completedCandle.open} H=${completedCandle.high} L=${completedCandle.low} C=${completedCandle.close} (${completedCandle.candleCount} 1m candles)`);

      // Evaluate using the aggregated candle instead of the raw 1m candle
      await this._evaluateStrategyOnCandle(completedCandle);
      return;
    }

    // Default: evaluate on every 1m candle (evalTimeframe === '1m')
    await this._evaluateStrategyOnCandle(candle);
  }

  /**
   * Core strategy evaluation logic, called with either a 1m candle or an aggregated candle
   * @param {Object} candle - The candle to evaluate (1m or aggregated)
   */
  async _evaluateStrategyOnCandle(candle) {
    try {
      // Get current GEX levels
      const gexLevels = this.gexCalculator.getCurrentLevels();
      if (!gexLevels) {
        logger.warn('No GEX levels available, skipping evaluation');
        return;
      }

      // Debug: Log candle and configured trading levels
      const tradeLevels = this.strategy.params.tradeLevels || [1];
      const levelInfo = tradeLevels.map(level => {
        const idx = level - 1;  // tradeLevels are 1-indexed, arrays are 0-indexed
        const sLevel = gexLevels.support?.[idx];
        const rLevel = gexLevels.resistance?.[idx];
        const sDist = sLevel ? Math.abs(candle.close - sLevel).toFixed(2) : 'N/A';
        const rDist = rLevel ? Math.abs(candle.close - rLevel).toFixed(2) : 'N/A';
        return `S${level}=${sLevel}(${sDist}) R${level}=${rLevel}(${rDist})`;
      }).join(', ');

      // Prepare market data for strategy
      const marketData = {
        gexLevels: gexLevels,
        ltLevels: this.currentLtLevels
      };

      // Add IV data for strategies that require it
      if (this.requiresIV && this.ivSkewCalculator) {
        const ivData = this.ivSkewCalculator.getCurrentIVSkew();
        if (ivData) {
          // Set live IV data on strategy for getIVAtTime() method
          if (typeof this.strategy.setLiveIVData === 'function') {
            this.strategy.setLiveIVData(ivData);
          }
          marketData.ivData = ivData;
          logger.info(`📊 Evaluating: close=${candle.close}, ${levelInfo}, IV=${(ivData.iv * 100).toFixed(2)}%, Skew=${(ivData.skew * 100).toFixed(3)}%`);
        } else {
          logger.debug(`📊 Evaluating: close=${candle.close}, ${levelInfo} (no IV data)`);
        }
      } else {
        logger.info(`📊 Evaluating: close=${candle.close}, ${levelInfo}, vol=${candle.volume}`);
      }

      // Generate signal using shared strategy logic
      const signal = this.strategy.evaluateSignal(
        candle,
        this.prevCandle,
        marketData
      );

      // Update previous candle for next evaluation
      this.prevCandle = candle;

      if (signal) {
        // Add webhook format fields for compatibility
        signal.webhook_type = 'trade_signal';

        // Add breakeven parameters if strategy supports it and is configured
        if (this.supportsBreakeven && this.strategy.params.breakevenStop) {
          signal.breakeven_trigger = this.strategy.params.breakevenTrigger;
          signal.breakeven_offset = this.strategy.params.breakevenOffset;
        }

        await this.publishSignal(signal);
      }

      // Check for timed out limit orders after each evaluation
      await this.checkOrderTimeouts();

    } catch (error) {
      logger.error('Error evaluating candle:', error);
    }
  }

  async publishSignal(signal) {
    try {
      // Publish trade signal via message bus
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, signal);
      logger.info(`Published trade signal: ${JSON.stringify(signal)}`);

      // Also publish to monitoring service
      await messageBus.publish(CHANNELS.SERVICE_HEALTH, {
        service: 'signal-generator',
        event: 'signal_generated',
        signal: signal,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to publish signal:', error);
    }
  }

  resetStrategy() {
    this.strategy.reset();
    this.prevCandle = null;
    this.candleBuffer.clear();
    this.pendingOrders.clear();
    // Note: Do NOT reset position state here - it's managed by position events and startup sync
    // this.inPosition and this.currentPosition should persist across session resets
    this.gfTrackingState = null;
    this.timeBasedTrailingState = null;
    this.reconciliationConfirmed = false;
    this.lastInPositionLogTime = 0;
    // Reset aggregator state so partial periods don't carry over across sessions
    if (this.aggregator) {
      this.aggregator.resetIncremental(this.evalTimeframe, this.strategyConstant);
      this.aggregator.initIncremental(this.evalTimeframe, this.strategyConstant);
      this.lastEvaluatedPeriod = null;
    }
    logger.info('Strategy engine reset for new session');
  }

  /**
   * Get candle buffer statistics
   * @returns {object} Buffer statistics
   */
  getCandleBufferStats() {
    return this.candleBuffer.getStats();
  }

  enable() {
    this.enabled = true;
    logger.info('Strategy engine enabled');
  }

  disable() {
    this.enabled = false;
    logger.info('Strategy engine disabled');
  }

  async publishStrategyStatus() {
    try {
      const gexLevels = this.gexCalculator.getCurrentLevels();
      const now = new Date();

      // Get IV data if available
      const ivData = this.ivSkewCalculator?.getCurrentIVSkew() || null;

      const status = {
        strategy: {
          name: this.strategy.getName(),
          type: this.strategyName,
          constant: this.strategyConstant,
          enabled: this.enabled,
          requires_iv: this.requiresIV,
          supports_breakeven: this.supportsBreakeven,
          session: {
            in_session: this.inSession,
            current_hour: now.getHours(),
            session_hours: `${this.sessionStart}:00 - ${this.sessionEnd}:00`
          },
          cooldown: {
            in_cooldown: !this.strategy.checkCooldown(now.getTime(), this.strategy.params.signalCooldownMs),
            formatted: this.strategy.checkCooldown(now.getTime(), this.strategy.params.signalCooldownMs) ? "Ready" : "In cooldown",
            seconds_remaining: Math.max(0, Math.ceil((this.strategy.lastSignalTime + this.strategy.params.signalCooldownMs - now.getTime()) / 1000))
          }
        },
        iv_data: ivData ? {
          symbol: ivData.symbol,
          iv: ivData.iv,
          skew: ivData.skew,
          call_iv: ivData.callIV,
          put_iv: ivData.putIV,
          signal: ivData.signal,
          atm_strike: ivData.atmStrike,
          timestamp: ivData.timestamp
        } : null,
        gex_levels: gexLevels ? {
          put_wall: gexLevels.putWall,
          call_wall: gexLevels.callWall,
          support: gexLevels.support || [],
          resistance: gexLevels.resistance || [],
          regime: gexLevels.regime,
          total_gex: gexLevels.totalGex
        } : null,
        candle_buffer: {
          count: this.candleBuffer.getStats().count,
          initialized: this.candleBuffer.getStats().initialized,
          last_candle_time: this.candleBuffer.getStats().lastCandleTime
        },
        pending_orders: {
          count: this.pendingOrders.size,
          timeout_candles: this.orderTimeoutCandles,
          orders: Array.from(this.pendingOrders.values()).map(o => ({
            orderId: o.orderId,
            side: o.side,
            price: o.price,
            candleCount: o.candleCount,
            placedAt: o.placedAt
          }))
        },
        position: {
          in_position: this.inPosition,
          current: this.currentPosition ? {
            symbol: this.currentPosition.symbol,
            side: this.currentPosition.side,
            entry_price: this.currentPosition.entryPrice,
            entry_time: this.currentPosition.entryTime
          } : null
        },
        gf_early_exit: {
          enabled: this.gfEarlyExitConfig.enabled,
          breakeven_threshold: this.gfEarlyExitConfig.breakevenThreshold,
          check_interval_minutes: this.gfEarlyExitConfig.checkIntervalMs / 60000,
          tracking_active: !!this.gfTrackingState,
          state: this.gfTrackingState ? {
            entry_gf: this.gfTrackingState.entryGF,
            current_gf: this.gfTrackingState.lastGF,
            consecutive_adverse: this.gfTrackingState.consecutiveAdverse,
            breakeven_triggered: this.gfTrackingState.breakevenTriggered,
            last_check_period: this.gfTrackingState.lastCheckPeriod,
            // Convert period back to time for readability
            last_check_time: new Date(this.gfTrackingState.lastCheckPeriod * this.gfEarlyExitConfig.checkIntervalMs).toISOString()
          } : null
        },
        time_based_trailing: {
          enabled: this.timeBasedTrailingConfig.enabled,
          rules_count: this.timeBasedTrailingConfig.rules.length,
          rules: this.timeBasedTrailingConfig.rules.map(r => ({
            after_bars: r.afterBars,
            if_mfe: r.ifMFE,
            action: r.action === 'breakeven' ? 'breakeven' : `trail:${r.trailDistance}`
          })),
          tracking_active: !!this.timeBasedTrailingState,
          state: this.timeBasedTrailingState ? {
            bars_in_trade: this.timeBasedTrailingState.barsInTrade,
            mfe: this.timeBasedTrailingState.mfe,
            peak_price: this.timeBasedTrailingState.peakPrice,
            current_stop: this.timeBasedTrailingState.currentStopPrice,
            active_rule_index: this.timeBasedTrailingState.activeRuleIndex,
            rules_triggered: this.timeBasedTrailingState.rulesTriggered
          } : null
        },
        evaluation_readiness: {
          ready: this.enabled && this.inSession && !!gexLevels && !this.inPosition,
          conditions_met: [],
          blockers: []
        },
        timestamp: now.toISOString()
      };

      // Add condition details
      if (this.enabled) status.evaluation_readiness.conditions_met.push("Strategy enabled");
      else status.evaluation_readiness.blockers.push("Strategy disabled");

      if (this.inSession) status.evaluation_readiness.conditions_met.push("In trading session");
      else status.evaluation_readiness.blockers.push("Outside trading session");

      if (gexLevels) status.evaluation_readiness.conditions_met.push("GEX levels available");
      else status.evaluation_readiness.blockers.push("GEX levels unavailable");

      await messageBus.publish(CHANNELS.STRATEGY_STATUS, status);
      logger.debug('📈 Strategy status published');
    } catch (error) {
      logger.error('Failed to publish strategy status:', error);
    }
  }

  async run() {
    logger.info('Strategy engine started');
    let lastReconciliationTime = 0;
    const reconciliationIntervalMs = 5 * 60 * 1000; // 5 minutes

    while (true) {
      try {
        // Check for session change
        const inSessionNow = this.isInTradingSession();
        if (inSessionNow !== this.inSession) {
          this.inSession = inSessionNow;
          if (inSessionNow) {
            logger.info('Trading session started');
            this.resetStrategy();
          } else {
            logger.info('Trading session ended');
          }
        }

        // Periodically reconcile position state against Tradovate
        const now = Date.now();
        if (now - lastReconciliationTime >= reconciliationIntervalMs) {
          await this.reconcilePositionState();
          lastReconciliationTime = now;
        }

        // Publish strategy status
        await this.publishStrategyStatus();

        // Check GF early exit conditions (only evaluates every 15 minutes internally)
        this.checkGFEarlyExit();

        // Sleep and continue
        await new Promise(resolve => setTimeout(resolve, 30000)); // Check every 30 seconds

      } catch (error) {
        logger.error('Error in strategy engine run loop:', error);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
}

export default StrategyEngine;