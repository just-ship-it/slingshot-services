/**
 * AI Strategy Engine — Live trading loop for the AI Trader.
 *
 * Replaces the standard StrategyEngine for the siggen-nq-aitrader instance.
 * Subscribes to the same Redis channels, manages position state the same way,
 * but runs the AI trading lifecycle instead of evaluateSignal():
 *
 *   1. Wait for data (TradingView history + GEX levels)
 *   2. Pre-market bias formation at 9:25 AM ET (LLM call)
 *   3. Entry scanning on 5m candle closes near key levels (9:30–15:30 ET)
 *   4. 30-min bias reassessment
 *   5. Position management (delegated to LiveTradeManager via Sprint 5)
 *   6. EOD force close at 16:00 ET
 */

import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';
import { CandleAggregator } from '../../../shared/utils/candle-aggregator.js';
import { PromptBuilder } from '../../../backtest-engine/src/ai/prompt-builder.js';
import { LLMClient } from '../../../backtest-engine/src/ai/llm-client.js';
import {
  toET, getRTHOpenTime, getRTHCloseTime, formatET,
  isInTradingWindow, getTradingWindowName, isTradingDay,
} from '../../../backtest-engine/src/ai/session-utils.js';
import config from '../utils/config.js';

const logger = createLogger('ai-strategy-engine');

export class AIStrategyEngine {
  /**
   * @param {Object} opts
   * @param {Object} opts.featureAggregator - LiveFeatureAggregator instance
   * @param {Object} opts.gexCalculator     - Live GEX calculator
   * @param {string} opts.tradingSymbol     - e.g. 'NQH6'
   * @param {Object} [opts.tradeManager]    - LiveTradeManager instance (Sprint 5)
   */
  constructor(opts = {}) {
    this.featureAggregator = opts.featureAggregator;
    this.gexCalculator = opts.gexCalculator;
    this.tradingSymbol = opts.tradingSymbol || config.TRADING_SYMBOL || 'NQH6';

    // LLM components — imported from backtest-engine
    this.promptBuilder = new PromptBuilder({ ticker: opts.ticker || config.CANDLE_BASE_SYMBOL || 'NQ' });
    this.llm = new LLMClient({
      model: opts.model || process.env.AI_TRADER_MODEL || 'claude-sonnet-4-20250514',
      apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY,
    });

    // Trade manager (Sprint 5) — null until wired
    this.tradeManager = opts.tradeManager || null;

    // ── Config ─────────────────────────────────────────────
    this.dryRun = (process.env.AI_TRADER_DRY_RUN || 'true').toLowerCase() === 'true';
    this.quantity = parseInt(process.env.AI_TRADER_QUANTITY || '1', 10);
    this.levelProximityThreshold = parseInt(process.env.AI_TRADER_PROXIMITY || '30', 10);
    this.maxEntriesPerDay = parseInt(process.env.AI_TRADER_MAX_ENTRIES || '4', 10);
    this.maxEntriesPerSession = parseInt(process.env.AI_TRADER_MAX_SESSION_ENTRIES || '2', 10);
    this.maxLossesPerDay = parseInt(process.env.AI_TRADER_MAX_LOSSES || '2', 10);
    this.reassessmentIntervalMs = 30 * 60 * 1000; // 30 minutes
    this.stopCooldownMs = 30 * 60 * 1000; // 30 minutes after a stop loss
    this.strategyConstant = 'AI_TRADER';

    // ── Day State (resets each trading day) ─────────────────
    this._resetDayState();

    // ── Position State ──────────────────────────────────────
    this.inPosition = false;
    this.currentPosition = null;

    // ── 5m Candle Aggregation ───────────────────────────────
    this.aggregator = new CandleAggregator();
    this.aggregator.initIncremental('5m', this.strategyConstant);
    this.lastEvaluatedPeriod = null;
    this.recent5mCandles = []; // Rolling buffer of last 20 completed 5m candles

    // ── Data Readiness ──────────────────────────────────────
    this.history1mReady = false;
    this.history1hReady = false;
    this.gexReady = false;
    this.enabled = true;

    // ── Reconciliation ──────────────────────────────────────
    this.reconciliationConfirmed = false;
    this.lastReconciliationTime = 0;
    this.reconciliationIntervalMs = 5 * 60 * 1000;

    // Subscribe to position events
    this._subscribeToPositionEvents();

    logger.info(`AI Strategy Engine initialized (dry-run: ${this.dryRun}, model: ${this.llm.model}, symbol: ${this.tradingSymbol})`);
  }

  // ── Day State Management ──────────────────────────────────

  _resetDayState() {
    this.currentTradingDay = null;
    this.activeBias = null;
    this.biasFormed = false;
    this.totalEntriesToday = 0;
    this.totalLossesToday = 0;
    this.sessionEntries = 0;
    this.currentWindow = null;
    this.lastReassessmentTime = 0;
    this.lastStopTimestamp = 0;
    this.llmCallsToday = 0;
    this.entriesMade = [];
    this.outcomesReceived = [];
    this.biasHistory = [];
    this.eodCloseSent = false;
  }

  /**
   * Determine the current trading day string (YYYY-MM-DD) in ET.
   * Trading day rolls at 18:00 ET (overnight session start).
   */
  _getCurrentTradingDay() {
    const now = Date.now();
    const et = toET(now);
    const totalMinutes = et.hour * 60 + et.minute;
    const pad = (n) => String(n).padStart(2, '0');

    // If after 18:00 ET, it's the NEXT day's trading session
    if (totalMinutes >= 1080) {
      const tomorrow = new Date(Date.UTC(et.year, et.month - 1, et.day + 1, 12));
      const tomorrowET = toET(tomorrow.getTime());
      return `${tomorrowET.year}-${pad(tomorrowET.month)}-${pad(tomorrowET.day)}`;
    }

    return `${et.year}-${pad(et.month)}-${pad(et.day)}`;
  }

  // ── Data Readiness ────────────────────────────────────────

  markHistoryReady(timeframe) {
    if (timeframe === '1') {
      this.history1mReady = true;
      logger.info('1m history loaded');
    } else if (timeframe === '60') {
      this.history1hReady = true;
      logger.info('1h history loaded');
    }
    this._checkDataReady();
  }

  markGexReady() {
    this.gexReady = true;
    logger.info('GEX levels loaded');
    this._checkDataReady();
  }

  _checkDataReady() {
    const ready = this.history1mReady && this.history1hReady && this.gexReady;
    if (ready && !this.featureAggregator.dataReady) {
      this.featureAggregator.setDataReady(true);
      logger.info('All data sources ready — AI trader operational');
    }
  }

  isDataReady() {
    return this.featureAggregator.dataReady;
  }

  // ── Position Event Handling ───────────────────────────────

  _subscribeToPositionEvents() {
    messageBus.subscribe(CHANNELS.POSITION_UPDATE, (message) => {
      if (message.netPos === 0 || message.source === 'position_closed') {
        this._handlePositionClosed(message);
      } else if (message.netPos !== 0) {
        this._handlePositionOpened(message);
      }
    });

    messageBus.subscribe(CHANNELS.POSITION_CLOSED, (message) => {
      this._handlePositionClosed(message);
    });

    logger.info('Subscribed to position events');
  }

  _handlePositionOpened(message) {
    if (message.strategy !== this.strategyConstant) return;

    this.inPosition = true;
    this.currentPosition = {
      symbol: message.symbol,
      side: message.side || (message.action === 'Buy' ? 'long' : 'short'),
      entryPrice: message.price || message.entryPrice,
      entryTime: message.timestamp || new Date().toISOString(),
      strategy: message.strategy,
      orderStrategyId: message.orderStrategyId || message.order_strategy_id,
      stopOrderId: message.stopOrderId || message.stop_order_id,
    };

    logger.info(`Position opened: ${this.currentPosition.side} ${this.currentPosition.symbol} @ ${this.currentPosition.entryPrice}`);

    // Initialize trade manager if available (Sprint 5)
    if (this.tradeManager) {
      this.tradeManager.activate(this.currentPosition);
    }
  }

  _handlePositionClosed(message) {
    if (message.strategy !== this.strategyConstant && this.currentPosition?.strategy !== this.strategyConstant) {
      return;
    }

    const exitPrice = message.exitPrice || message.price;
    const pnl = message.pnl;
    logger.info(`Position closed${exitPrice ? ` @ ${exitPrice}` : ''}${pnl ? ` (P&L: ${pnl > 0 ? '+' : ''}${pnl})` : ''}`);

    // Track outcome for reassessment context
    if (this.currentPosition && exitPrice) {
      const isLong = this.currentPosition.side === 'long' || this.currentPosition.side === 'buy';
      const computedPnl = isLong ? exitPrice - this.currentPosition.entryPrice : this.currentPosition.entryPrice - exitPrice;
      this.outcomesReceived.push({
        pnl: pnl || computedPnl,
        exitPrice,
        side: this.currentPosition.side,
        entryPrice: this.currentPosition.entryPrice,
      });
      if ((pnl || computedPnl) < 0) {
        this.totalLossesToday++;
        this.lastStopTimestamp = Date.now();
        logger.info(`Stop loss hit — ${this.stopCooldownMs / 60000} min cooldown active (losses today: ${this.totalLossesToday})`);
      }
    }

    this.inPosition = false;
    this.currentPosition = null;

    // Deactivate trade manager
    if (this.tradeManager) {
      this.tradeManager.deactivate();
    }

    logger.info('Ready for next entry');
  }

  // ── Position Reconciliation ───────────────────────────────

  async _reconcilePositionState() {
    const accountId = config.TRADOVATE_ACCOUNT_ID;
    if (!accountId) return;

    try {
      const response = await fetch(`http://localhost:3011/positions/${accountId}`);
      if (!response.ok) return;

      const positions = await response.json();
      const baseSymbol = config.CANDLE_BASE_SYMBOL || 'NQ';
      const openPosition = positions.find(p => p.netPos !== 0 && p.symbol && p.symbol.includes(baseSymbol));

      if (this.inPosition && !openPosition) {
        logger.warn(`[RECONCILE] Stale position detected — Tradovate is flat. Resetting.`);
        this.inPosition = false;
        this.currentPosition = null;
        if (this.tradeManager) this.tradeManager.deactivate();
        this.reconciliationConfirmed = false;
      } else if (!this.inPosition && openPosition) {
        this.inPosition = true;
        this.currentPosition = {
          symbol: openPosition.symbol || `Contract ${openPosition.contractId}`,
          side: openPosition.netPos > 0 ? 'long' : 'short',
          entryPrice: openPosition.netPrice || 0,
          entryTime: openPosition.timestamp || new Date().toISOString(),
          strategy: this.strategyConstant,
          quantity: Math.abs(openPosition.netPos),
        };
        this.reconciliationConfirmed = false;
        logger.warn(`[RECONCILE] Missed position open: ${this.currentPosition.side} ${this.currentPosition.symbol} @ ${this.currentPosition.entryPrice}`);
      } else if (!this.reconciliationConfirmed) {
        const stateDesc = this.inPosition
          ? `in position (${this.currentPosition?.side} ${this.currentPosition?.symbol})`
          : 'flat';
        logger.info(`[RECONCILE] Position state confirmed: ${stateDesc}`);
        this.reconciliationConfirmed = true;
      }
    } catch (error) {
      logger.debug(`[RECONCILE] Check skipped: ${error.message}`);
    }
  }

  // ── Startup Sync ──────────────────────────────────────────

  async syncPositionState() {
    const accountId = config.TRADOVATE_ACCOUNT_ID;
    if (!accountId) {
      logger.warn('No TRADOVATE_ACCOUNT_ID configured, skipping position sync');
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logger.info(`Syncing position state from Tradovate (attempt ${attempt}/3)...`);
        const response = await fetch(`http://localhost:3011/positions/${accountId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const positions = await response.json();
        const baseSymbol = config.CANDLE_BASE_SYMBOL || 'NQ';
        const openPosition = positions.find(p => p.netPos !== 0 && p.symbol && p.symbol.includes(baseSymbol));

        if (openPosition) {
          this.inPosition = true;
          this.currentPosition = {
            symbol: openPosition.symbol || `Contract ${openPosition.contractId}`,
            side: openPosition.netPos > 0 ? 'long' : 'short',
            entryPrice: openPosition.netPrice || 0,
            entryTime: openPosition.timestamp || new Date().toISOString(),
            strategy: this.strategyConstant,
            quantity: Math.abs(openPosition.netPos),
          };
          logger.info(`Found existing position: ${this.currentPosition.side} ${this.currentPosition.symbol} @ ${this.currentPosition.entryPrice}`);
        } else {
          logger.info('No open positions — starting fresh');
        }
        return;
      } catch (error) {
        logger.warn(`Position sync attempt ${attempt} failed: ${error.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
      }
    }
    logger.warn('Continuing without position sync');
  }

  // ── Core: Process 1m Candle ───────────────────────────────

  /**
   * Called on every new 1m candle close from TradingView.
   * Handles day transitions, bias formation timing, 5m aggregation,
   * entry scanning, position management, and EOD.
   */
  async processCandle(candle) {
    if (!this.enabled || !this.isDataReady()) return;

    const now = Date.now();
    const candleTs = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();

    // ── Day Management ──────────────────────────────────────
    const tradingDay = this._getCurrentTradingDay();
    if (tradingDay !== this.currentTradingDay) {
      if (this.currentTradingDay) {
        this._logDaySummary();
      }
      this._resetDayState();
      this.currentTradingDay = tradingDay;

      // Reset 5m aggregator
      this.aggregator.resetIncremental('5m', this.strategyConstant);
      this.aggregator.initIncremental('5m', this.strategyConstant);
      this.lastEvaluatedPeriod = null;
      this.recent5mCandles = [];

      if (isTradingDay(tradingDay)) {
        logger.info(`New trading day: ${tradingDay}`);
      }
    }

    if (!isTradingDay(tradingDay)) return;

    // ── Position Management (on every 1m candle while in position) ──
    if (this.inPosition && this.tradeManager) {
      await this.tradeManager.processCandle(candle);
    }

    // ── EOD Force Close (15:55 ET) ──────────────────────────
    const et = toET(candleTs);
    const totalMinutes = et.hour * 60 + et.minute;
    if (this.inPosition && totalMinutes >= 955 && !this.eodCloseSent) {
      logger.info(`EOD force close triggered at ${et.hour}:${String(et.minute).padStart(2, '0')} ET`);
      await this._publishSignal({
        webhook_type: 'trade_signal',
        action: 'position_closed',
        symbol: this.currentPosition?.symbol || this.tradingSymbol,
        side: this.currentPosition?.side,
        strategy: this.strategyConstant,
        reason: 'EOD force close (3:55 PM ET)',
        timestamp: new Date().toISOString(),
      });
      this.eodCloseSent = true;
      return;
    }

    // ── Pre-market Bias Formation (9:25 AM ET) ──────────────
    if (!this.biasFormed && totalMinutes >= 565 && totalMinutes < 570) {
      await this._formBias(tradingDay);
    }

    // ── Late-start Bias (if service restarted mid-day) ───────
    // If we're in a trading window but missed the 9:25 AM bias window,
    // form bias now so we don't sit idle all day.
    if (!this.biasFormed && totalMinutes >= 570 && isInTradingWindow(candleTs)) {
      logger.info('Missed pre-market bias window — forming late-start bias...');
      await this._formBias(tradingDay);
    }

    // ── Skip evaluation outside trading windows ─────────────
    if (!isInTradingWindow(candleTs)) return;

    // ── Skip if not enough context yet (no bias formed) ─────
    if (!this.biasFormed) return;

    // ── Skip if in position (management only) ───────────────
    if (this.inPosition) return;

    // ── Daily/session limits ────────────────────────────────
    if (this.totalEntriesToday >= this.maxEntriesPerDay) return;
    if (this.totalLossesToday >= this.maxLossesPerDay) return;

    // ── Post-stop cooldown ──────────────────────────────────
    if (this.lastStopTimestamp > 0 && now - this.lastStopTimestamp < this.stopCooldownMs) {
      return;
    }

    // ── Session transition tracking ─────────────────────────
    const windowName = getTradingWindowName(candleTs);
    if (windowName !== this.currentWindow) {
      if (this.currentWindow !== null) {
        logger.info(`Session transition: ${this.currentWindow} -> ${windowName}`);
      }
      this.currentWindow = windowName;
      this.sessionEntries = 0;
      this.lastReassessmentTime = candleTs;
    }
    if (this.sessionEntries >= this.maxEntriesPerSession) return;

    // ── 5m Candle Aggregation ───────────────────────────────
    const key = `${this.strategyConstant}_5m`;
    const state = this.aggregator.incrementalState[key];
    const prevCompletedCount = state ? state.aggregatedCandles.length : 0;

    this.aggregator.addCandleIncremental(candle, '5m', this.strategyConstant);

    const newCompletedCount = state ? state.aggregatedCandles.length : 0;
    let completed5mCandle = null;

    if (newCompletedCount > prevCompletedCount) {
      const finalized = state.aggregatedCandles[state.aggregatedCandles.length - 1];
      if (finalized.timestamp !== this.lastEvaluatedPeriod) {
        completed5mCandle = finalized;
        this.lastEvaluatedPeriod = finalized.timestamp;
      }
    }

    // Also check if this 1m candle is the LAST in the current 5m period
    if (!completed5mCandle && state && state.currentPeriod) {
      const nextMinute = candleTs + 60000;
      const intervalMinutes = this.aggregator.getIntervalMinutes('5m');
      const currentPeriodStart = this.aggregator.getPeriodStart(candleTs, intervalMinutes);
      const nextPeriodStart = this.aggregator.getPeriodStart(nextMinute, intervalMinutes);

      if (nextPeriodStart !== currentPeriodStart && currentPeriodStart !== this.lastEvaluatedPeriod) {
        completed5mCandle = { ...state.currentPeriod };
        this.lastEvaluatedPeriod = currentPeriodStart;
      }
    }

    if (!completed5mCandle) return;

    logger.info(`5m candle closed: ${completed5mCandle.close} @ ${new Date(completed5mCandle.timestamp || candleTs).toISOString()}`);

    // Track the recent 5m candle
    this.recent5mCandles.push(completed5mCandle);
    if (this.recent5mCandles.length > 20) this.recent5mCandles.shift();

    // ── 30-min Reassessment ─────────────────────────────────
    if (this.lastReassessmentTime > 0 && candleTs - this.lastReassessmentTime >= this.reassessmentIntervalMs) {
      await this._reassessBias(tradingDay, candleTs);
    }

    // ── Proximity Gate ──────────────────────────────────────
    const price = completed5mCandle.close;
    const proximity = this.featureAggregator.isNearKeyLevel(
      candleTs, price, this.levelProximityThreshold, tradingDay
    );

    if (!proximity.near) {
      logger.info(`Not near key level (price=${price}, threshold=${this.levelProximityThreshold}pt) — nearest: ${proximity.nearest?.label || 'none'} @ ${proximity.nearest?.price || 'N/A'} (${proximity.nearest?.distance?.toFixed(1) || '?'}pt away)`);
      return;
    }

    logger.info(`Near key level! ${proximity.nearest.label} @ ${proximity.nearest.price} (${proximity.nearest.distance.toFixed(1)}pt away) — triggering entry evaluation`);

    // ── Entry Evaluation (LLM Call) ─────────────────────────
    await this._evaluateEntry(tradingDay, candleTs, completed5mCandle, proximity);
  }

  // ── Phase 1: Bias Formation ───────────────────────────────

  async _formBias(tradingDay) {
    logger.info(`Phase 1: Pre-market bias formation for ${tradingDay}...`);

    const preMarketState = this.featureAggregator.getPreMarketState(tradingDay);
    if (!preMarketState.priorDailyCandles || preMarketState.priorDailyCandles.length < 2) {
      logger.warn('Insufficient prior daily data — skipping bias formation');
      return;
    }

    const biasPrompt = this.promptBuilder.buildBiasPrompt(preMarketState);
    let bias;

    if (this.dryRun) {
      bias = this.llm.dryRun(biasPrompt.system, biasPrompt.user, 'bias');
    } else {
      try {
        bias = await this.llm.query(biasPrompt.system, biasPrompt.user);
      } catch (e) {
        logger.error(`Bias LLM error: ${e.message}`);
        return;
      }
    }

    this.activeBias = bias;
    this.biasFormed = true;
    this.lastReassessmentTime = getRTHOpenTime(tradingDay);
    this.biasHistory.push({
      time: formatET(Date.now()),
      bias: bias.bias,
      conviction: bias.conviction,
      source: 'pre-market',
    });

    this.llmCallsToday++;
    logger.info(`Bias: ${bias.bias} (conviction: ${bias.conviction}/5)`);
    logger.info(`Reasoning: ${bias.reasoning}`);

    if (bias.key_levels_to_watch) {
      for (const kl of bias.key_levels_to_watch) {
        logger.info(`  Level: ${kl.price} (${kl.type}) -> ${kl.action}`);
      }
    }
  }

  // ── Bias Reassessment ─────────────────────────────────────

  async _reassessBias(tradingDay, currentTimestamp) {
    const previousBias = this.activeBias?.bias;
    const windowSummary = this.featureAggregator.getWindowSummary(
      tradingDay, this.lastReassessmentTime, currentTimestamp
    );

    // Build recent trades for context
    const recentTrades = [];
    for (let i = 0; i < this.entriesMade.length; i++) {
      if (this.outcomesReceived[i]) {
        recentTrades.push({ entry: this.entriesMade[i], outcome: this.outcomesReceived[i] });
      }
    }

    const reassessPrompt = this.promptBuilder.buildReassessmentPrompt(
      windowSummary, this.activeBias, recentTrades
    );

    let newBias;
    if (this.dryRun) {
      newBias = this.llm.dryRun(reassessPrompt.system, reassessPrompt.user, 'reassessment');
    } else {
      try {
        newBias = await this.llm.query(reassessPrompt.system, reassessPrompt.user);
      } catch (e) {
        logger.error(`Reassessment LLM error: ${e.message} — keeping current bias`);
        this.lastReassessmentTime = currentTimestamp;
        return;
      }
    }

    this.llmCallsToday++;
    this.lastReassessmentTime = currentTimestamp;

    const changed = newBias.bias !== previousBias;
    if (changed) {
      logger.info(`30-min reassessment: ${previousBias}(${this.activeBias?.conviction}) -> ${newBias.bias}(${newBias.conviction})`);
    } else {
      logger.debug(`30-min reassessment: bias unchanged — ${newBias.bias}(${newBias.conviction})`);
    }

    this.activeBias = newBias;
    this.biasHistory.push({
      time: formatET(currentTimestamp),
      bias: newBias.bias,
      conviction: newBias.conviction,
      source: 'reassessment',
    });
  }

  // ── Entry Evaluation ──────────────────────────────────────

  async _evaluateEntry(tradingDay, timestamp, candle, proximity) {
    const nearest = proximity.nearest;
    logger.info(`[${formatET(timestamp)}] Near ${nearest.label} (${nearest.price.toFixed(2)}, ${nearest.distance.toFixed(1)} pts) — evaluating...`);

    // Build real-time state
    const realTimeState = this.featureAggregator.getRealTimeState(
      timestamp, candle, this.recent5mCandles, tradingDay
    );

    // Inject LT migration
    const rthOpen = getRTHOpenTime(tradingDay);
    const ltMig = this.featureAggregator._computeLTMigration(
      tradingDay,
      Math.max(rthOpen, timestamp - 30 * 60 * 1000),
      timestamp
    );
    if (ltMig) {
      realTimeState.ltMigration = {
        overallSignal: ltMig.overallSignal,
        shortTermTrend: ltMig.shortTermTrend,
        longTermTrend: ltMig.longTermTrend,
      };
    }

    const entryPrompt = this.promptBuilder.buildEntryPrompt(realTimeState, this.activeBias);

    let decision;
    if (this.dryRun) {
      decision = this.llm.dryRun(entryPrompt.system, entryPrompt.user, 'entry');
    } else {
      try {
        decision = await this.llm.query(entryPrompt.system, entryPrompt.user);
      } catch (e) {
        logger.error(`Entry LLM error at ${formatET(timestamp)}: ${e.message}`);
        return;
      }
    }

    this.llmCallsToday++;

    if (decision.action !== 'enter') {
      logger.info(`PASS at ${formatET(timestamp)}: ${decision.reasoning}`);
      return;
    }

    // ── Post-decision validation ────────────────────────────
    const riskPts = Math.abs(decision.entry_price - decision.stop_loss);
    const rewardPts = Math.abs(decision.take_profit - decision.entry_price);
    const rrRatio = riskPts > 0 ? rewardPts / riskPts : 0;

    if (riskPts > 40) {
      logger.warn(`REJECTED: risk ${riskPts.toFixed(1)} pts exceeds 40pt safety cap`);
      return;
    }
    if (isNaN(decision.stop_loss) || isNaN(decision.take_profit)) {
      logger.warn(`REJECTED: invalid stop/target values`);
      return;
    }
    if (rrRatio < 1.5) {
      logger.warn(`REJECTED: R:R ${rrRatio.toFixed(2)} below 1.5 minimum`);
      return;
    }
    if (rrRatio < 2.0) {
      logger.warn(`WARNING: R:R ${rrRatio.toFixed(2)} below 2.0 target (accepted)`);
    }

    // ── Entry accepted ──────────────────────────────────────
    this.totalEntriesToday++;
    this.sessionEntries++;

    const stopRef = decision.stop_level_reference || '';
    const targetRef = decision.target_level_reference || '';
    logger.info(`ENTRY #${this.totalEntriesToday} [${this.currentWindow}]: ${decision.side.toUpperCase()} at ${decision.entry_price} (stop: ${decision.stop_loss}${stopRef ? ' ' + stopRef : ''}, target: ${decision.take_profit}${targetRef ? ' ' + targetRef : ''})`);
    logger.info(`  Risk: ${riskPts.toFixed(1)} pts, Target: ${rewardPts.toFixed(1)} pts, R:R: ${rrRatio.toFixed(1)}:1, Confidence: ${decision.confidence}/5`);
    logger.info(`  Reason: ${decision.reasoning}`);
    logger.info(`  Active bias: ${this.activeBias.bias} (conviction: ${this.activeBias.conviction}/5)`);

    // Track entry
    this.entriesMade.push({
      time: formatET(timestamp),
      session: this.currentWindow,
      activeBias: this.activeBias.bias,
      ...decision,
      nearestLevel: proximity.nearest,
    });

    // ── Publish Trade Signal ────────────────────────────────
    const signal = {
      webhook_type: 'trade_signal',
      action: 'place_limit',
      side: decision.side,
      symbol: this.tradingSymbol,
      price: decision.entry_price,
      stop_loss: decision.stop_loss,
      take_profit: decision.take_profit,
      quantity: this.quantity,
      strategy: this.strategyConstant,
      metadata: {
        bias: this.activeBias.bias,
        conviction: this.activeBias.conviction,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        nearestLevel: `${nearest.label} @ ${nearest.price.toFixed(2)}`,
        riskRewardRatio: rrRatio.toFixed(2),
        llmCallsToday: this.llmCallsToday,
        entryNumber: this.totalEntriesToday,
      },
      timestamp: new Date().toISOString(),
    };

    await this._publishSignal(signal);
  }

  // ── Signal Publishing ─────────────────────────────────────

  async _publishSignal(signal) {
    if (this.dryRun) {
      logger.info(`[DRY RUN] Would publish: ${signal.action} ${signal.side || ''} ${signal.symbol} @ ${signal.price || ''}`);
      logger.info(`[DRY RUN] Signal: ${JSON.stringify(signal, null, 2)}`);
      return;
    }

    try {
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, signal);
      logger.info(`Published trade signal: ${signal.action} ${signal.side || ''} ${signal.symbol}`);
    } catch (error) {
      logger.error('Failed to publish signal:', error);
    }
  }

  // ── Background Run Loop ───────────────────────────────────

  /**
   * Background loop that runs alongside the candle-driven processCandle().
   * Handles periodic reconciliation and status publishing.
   */
  async run() {
    logger.info('AI Strategy Engine run loop started');

    while (true) {
      try {
        const now = Date.now();

        // Periodic position reconciliation
        if (now - this.lastReconciliationTime >= this.reconciliationIntervalMs) {
          await this._reconcilePositionState();
          this.lastReconciliationTime = now;
        }

        // Publish strategy status
        await this._publishStatus();

        await new Promise(resolve => setTimeout(resolve, 30000));
      } catch (error) {
        logger.error('Error in AI engine run loop:', error);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  // ── Status Publishing ─────────────────────────────────────

  async _publishStatus() {
    try {
      const gexLevels = this.gexCalculator?.getCurrentLevels();
      const now = new Date();

      const status = {
        strategy: {
          name: 'AI Trader',
          type: 'ai-trader',
          constant: this.strategyConstant,
          enabled: this.enabled,
          dryRun: this.dryRun,
          model: this.llm.model,
        },
        data_readiness: {
          history_1m: this.history1mReady,
          history_1h: this.history1hReady,
          gex: this.gexReady,
          all_ready: this.isDataReady(),
        },
        trading_day: {
          date: this.currentTradingDay,
          bias: this.activeBias ? {
            direction: this.activeBias.bias,
            conviction: this.activeBias.conviction,
          } : null,
          biasFormed: this.biasFormed,
          entries: this.totalEntriesToday,
          losses: this.totalLossesToday,
          llmCalls: this.llmCallsToday,
          biasHistory: this.biasHistory,
        },
        position: {
          in_position: this.inPosition,
          current: this.currentPosition ? {
            symbol: this.currentPosition.symbol,
            side: this.currentPosition.side,
            entry_price: this.currentPosition.entryPrice,
            entry_time: this.currentPosition.entryTime,
          } : null,
        },
        cost: this.llm.getCostSummary(),
        gex_levels: gexLevels ? {
          put_wall: gexLevels.putWall,
          call_wall: gexLevels.callWall,
          support: gexLevels.support || [],
          resistance: gexLevels.resistance || [],
          regime: gexLevels.regime,
        } : null,
        timestamp: now.toISOString(),
      };

      await messageBus.publish(CHANNELS.STRATEGY_STATUS, status);
    } catch (error) {
      logger.error('Failed to publish strategy status:', error);
    }
  }

  // ── Day Summary ───────────────────────────────────────────

  _logDaySummary() {
    if (!this.currentTradingDay) return;

    const totalPnl = this.outcomesReceived.reduce((s, o) => s + (o.pnl || 0), 0);
    logger.info(`Day summary for ${this.currentTradingDay}: ${this.totalEntriesToday} entries, ${this.totalLossesToday} losses, ${this.llmCallsToday} LLM calls, P&L: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} pts`);
    if (this.biasHistory.length > 0) {
      logger.info(`  Bias progression: ${this.biasHistory.map(b => `${b.bias}(${b.conviction})`).join(' -> ')}`);
    }
    logger.info(`  LLM cost: $${this.llm.getCostSummary().estimatedCostUSD}`);
  }

  // ── Control Methods ───────────────────────────────────────

  enable() {
    this.enabled = true;
    logger.info('AI Strategy Engine enabled');
  }

  disable() {
    this.enabled = false;
    logger.info('AI Strategy Engine disabled');
  }

  // ── Test Cycle (manual trigger, bypasses time gates) ──

  /**
   * Run a full bias → entry evaluation cycle using live data.
   * Bypasses isTradingDay, time-of-day checks, and cooldowns.
   * Always runs in dry-run mode regardless of config.
   *
   * @returns {Object} Results of bias + entry evaluation
   */
  async testCycle() {
    if (!this.isDataReady()) {
      return { error: 'Data not ready', readiness: {
        history1m: this.history1mReady,
        history1h: this.history1hReady,
        gex: this.gexReady,
      }};
    }

    const results = { timestamp: new Date().toISOString(), steps: [] };

    // Use tomorrow (Monday) as a fake trading day so daily-candle aggregation works
    const fakeTradingDay = '2026-02-24'; // Monday

    // ── Step 1: Bias Formation ──────────────────────────
    logger.info('[TEST] Running bias formation...');
    const preMarketState = this.featureAggregator.getPreMarketState(fakeTradingDay);

    results.steps.push({
      step: 'pre_market_state',
      priorDailyCandles: preMarketState.priorDailyCandles?.length || 0,
      overnightRange: preMarketState.overnightRange,
      gex: preMarketState.gex ? {
        putWall: preMarketState.gex.putWall,
        callWall: preMarketState.gex.callWall,
        gammaFlip: preMarketState.gex.gammaFlip,
        regime: preMarketState.gex.regime,
        support: preMarketState.gex.support,
        resistance: preMarketState.gex.resistance,
      } : null,
      lt: preMarketState.lt ? {
        sentiment: preMarketState.lt.sentiment,
        levels: preMarketState.lt.levels,
      } : null,
      priorDayHLC: preMarketState.priorDayHLC,
    });

    if (!preMarketState.priorDailyCandles || preMarketState.priorDailyCandles.length < 2) {
      results.steps.push({ step: 'bias', status: 'skipped', reason: `Only ${preMarketState.priorDailyCandles?.length || 0} prior daily candles (need 2+)` });
    } else {
      const biasPrompt = this.promptBuilder.buildBiasPrompt(preMarketState);
      let bias;
      try {
        bias = await this.llm.query(biasPrompt.system, biasPrompt.user);
      } catch (e) {
        logger.error(`[TEST] Bias LLM error: ${e.message}`);
        results.steps.push({ step: 'bias', status: 'error', error: e.message });
        return results;
      }
      results.bias = bias;
      results.biasPrompt = biasPrompt.user; // Include prompt for inspection
      results.steps.push({
        step: 'bias',
        status: 'ok',
        direction: bias.bias,
        conviction: bias.conviction,
        reasoning: bias.reasoning,
        promptLength: biasPrompt.system.length + biasPrompt.user.length,
      });

      // Temporarily set bias for entry eval
      this.activeBias = bias;
      this.biasFormed = true;
    }

    // ── Step 2: Current Market State ────────────────────
    const candle1mBuffer = this.featureAggregator.candle1mBuffer;
    const candles = candle1mBuffer.getCandles(5);
    const latestCandle = candles[candles.length - 1];

    if (!latestCandle) {
      results.steps.push({ step: 'entry', status: 'skipped', reason: 'No candles in buffer' });
      return results;
    }

    const price = latestCandle.close || latestCandle.c;
    const candleTs = typeof latestCandle.timestamp === 'number'
      ? latestCandle.timestamp
      : new Date(latestCandle.timestamp).getTime();

    // ── Step 3: Proximity Check ─────────────────────────
    const proximity = this.featureAggregator.isNearKeyLevel(
      candleTs, price, this.levelProximityThreshold, fakeTradingDay
    );

    results.steps.push({
      step: 'proximity',
      price,
      threshold: this.levelProximityThreshold,
      near: proximity.near,
      nearest: proximity.nearest ? {
        label: proximity.nearest.label,
        price: proximity.nearest.price,
        distance: proximity.nearest.distance,
      } : null,
      allLevels: proximity.levels?.slice(0, 10) || [],
    });

    // ── Step 4: Entry Evaluation ────────────────────────
    if (!this.biasFormed) {
      results.steps.push({ step: 'entry', status: 'skipped', reason: 'No bias formed' });
      return results;
    }

    // Build a synthetic 5m candle from recent 1m candles
    const recent5m = candles.slice(-5);
    const synthetic5m = {
      timestamp: recent5m[0]?.timestamp,
      open: recent5m[0]?.open || recent5m[0]?.o,
      high: Math.max(...recent5m.map(c => c.high || c.h || 0)),
      low: Math.min(...recent5m.map(c => c.low || c.l || Infinity)),
      close: price,
      volume: recent5m.reduce((s, c) => s + (c.volume || c.v || 0), 0),
    };

    logger.info(`[TEST] Running entry evaluation at price ${price}...`);

    const realTimeState = this.featureAggregator.getRealTimeState(
      candleTs, synthetic5m, this.recent5mCandles.length > 0 ? this.recent5mCandles : [synthetic5m], fakeTradingDay
    );

    // Inject LT migration
    const ltMig = this.featureAggregator._computeLTMigration(
      fakeTradingDay,
      candleTs - 30 * 60 * 1000,
      candleTs
    );
    if (ltMig) {
      realTimeState.ltMigration = {
        overallSignal: ltMig.overallSignal,
        shortTermTrend: ltMig.shortTermTrend,
        longTermTrend: ltMig.longTermTrend,
      };
    }

    const entryPrompt = this.promptBuilder.buildEntryPrompt(realTimeState, this.activeBias);
    let decision;
    try {
      decision = await this.llm.query(entryPrompt.system, entryPrompt.user);
    } catch (e) {
      logger.error(`[TEST] Entry LLM error: ${e.message}`);
      results.steps.push({ step: 'entry', status: 'error', error: e.message });
      return results;
    }

    results.entry = decision;
    results.steps.push({
      step: 'entry',
      status: 'ok',
      action: decision.action,
      side: decision.side,
      entryPrice: decision.entry_price,
      stopLoss: decision.stop_loss,
      takeProfit: decision.take_profit,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      promptLength: entryPrompt.system.length + entryPrompt.user.length,
      ltMigration: realTimeState.ltMigration || null,
    });

    logger.info(`[TEST] Complete. Bias: ${results.bias?.bias}, Entry: ${decision.action} ${decision.side || ''}`);
    return results;
  }
}

export default AIStrategyEngine;
