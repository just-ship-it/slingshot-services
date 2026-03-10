/**
 * Live Trade Manager — MFE ratchet, structural trail, condition tightening, and LLM management.
 *
 * Extracted from the backtest's simulateManagedTrade() logic into a live class
 * that publishes modify_stop and position_closed signals via Redis.
 *
 * Intra-bar: subscribes to price.update for real-time MFE ratchet checks.
 * Bar close: processCandle() handles structural trail, condition tightening, and LLM management.
 *
 * MFE Ratchet Tiers (matching backtest):
 *   MFE 20-39  → lock 25%
 *   MFE 40-59  → lock 40%
 *   MFE 60-99  → lock 50%
 *   MFE 100+   → lock 60%
 *
 * Structural Trail: every 5 bars (MFE >= 20), trail behind nearest structural level.
 * Condition Tightening: every 15 bars (MFE > 0), lock 60% if LT deteriorating.
 *
 * LLM Management (event-gated, supplements mechanical management):
 *   Triggers: MFE tier transitions (20/40/60/100), significant giveback (<50% MFE retained),
 *             time-based fallback (every 15 bars). Actions: hold (no-op), tighten (modify_stop),
 *             exit (position_closed). Guardrails: can only tighten or exit, never widen.
 */

import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';

const logger = createLogger('live-trade-manager');

// MFE ratchet tiers — matching backtest exactly
const MFE_RATCHET_TIERS = [
  { minMFE: 100, lockPct: 0.60, label: 'lock 60%' },
  { minMFE: 60,  lockPct: 0.50, label: 'lock 50%' },
  { minMFE: 40,  lockPct: 0.40, label: 'lock 40%' },
  { minMFE: 20,  lockPct: 0.25, label: 'lock 25%' },
];

export class LiveTradeManager {
  /**
   * @param {Object} opts
   * @param {Object} opts.featureAggregator - LiveFeatureAggregator instance
   * @param {Object} [opts.llmClient]       - LLMClient instance for management (Haiku)
   * @param {Object} [opts.promptBuilder]   - PromptBuilder instance
   * @param {string} [opts.strategyConstant='AI_TRADER']
   */
  constructor(opts = {}) {
    this.featureAggregator = opts.featureAggregator;
    this.llmClient = opts.llmClient || null;
    this.promptBuilder = opts.promptBuilder || null;
    this.strategyConstant = opts.strategyConstant || 'AI_TRADER';
    this.ticker = opts.ticker || process.env.CANDLE_BASE_SYMBOL || 'NQ';

    // Active trade state (null when flat)
    this.trade = null;

    // LLM management cost tracking
    this.llmManagementCalls = 0;

    // Price update subscription handler (bound for clean unsubscribe)
    this._priceUpdateHandler = null;
  }

  /**
   * Activate tracking for a new position.
   * @param {Object} position - { entryPrice, side, symbol, orderStrategyId, stopOrderId, ... }
   */
  activate(position) {
    const isLong = position.side === 'long' || position.side === 'buy';
    this.trade = {
      entryPrice: position.entryPrice,
      initialStop: null, // Will be set from the original signal if available
      initialTarget: null,
      side: position.side,
      isLong,
      symbol: position.symbol,
      orderStrategyId: position.orderStrategyId,
      stopOrderId: position.stopOrderId,
      currentStop: null,
      mfe: 0,
      mae: 0,
      lastRatchetMFE: 0,
      barsHeld: 0,
      entryTimestamp: Date.now(),
      stopAdjustments: [],
      // LLM management state
      lastLLMCheckMFETier: 0,
      lastLLMCheckBar: 0,
      givebackCheckFired: false,
    };

    // Subscribe to real-time price updates for intra-bar MFE ratcheting
    this._priceUpdateHandler = (message) => this._handlePriceUpdate(message);
    messageBus.subscribe(CHANNELS.PRICE_UPDATE, this._priceUpdateHandler);

    logger.info(`Trade manager activated: ${isLong ? 'LONG' : 'SHORT'} ${position.symbol} @ ${position.entryPrice} (intra-bar monitoring enabled)`);
  }

  /**
   * Deactivate tracking when position closes.
   */
  deactivate() {
    // Unsubscribe from real-time price updates
    if (this._priceUpdateHandler) {
      messageBus.unsubscribe(CHANNELS.PRICE_UPDATE, this._priceUpdateHandler);
      this._priceUpdateHandler = null;
    }

    if (this.trade) {
      const { barsHeld, mfe, mae, stopAdjustments } = this.trade;
      logger.info(`Trade manager deactivated: ${barsHeld} bars, MFE +${mfe.toFixed(1)}, MAE ${mae.toFixed(1)}, ${stopAdjustments.length} stop adjustments`);
    }
    this.trade = null;
  }

  /**
   * Process a 1m candle while in position.
   * Runs MFE ratchet on every bar, structural trail every 5 bars,
   * and condition tightening every 15 bars.
   */
  async processCandle(candle) {
    if (!this.trade) return;

    const t = this.trade;
    t.barsHeld++;

    // ── Update MFE / MAE ────────────────────────────────────
    if (t.isLong) {
      const excursion = candle.high - t.entryPrice;
      if (excursion > t.mfe) t.mfe = excursion;
      const adverse = t.entryPrice - candle.low;
      if (adverse > t.mae) t.mae = adverse;
    } else {
      const excursion = t.entryPrice - candle.low;
      if (excursion > t.mfe) t.mfe = excursion;
      const adverse = candle.high - t.entryPrice;
      if (adverse > t.mae) t.mae = adverse;
    }

    // ── MFE Ratchet (every bar) ─────────────────────────────
    await this._checkMFERatchet(candle);

    // ── Structural Trail (every 5 bars, MFE >= 20) ──────────
    if (t.barsHeld % 5 === 0 && t.mfe >= 20) {
      await this._checkStructuralTrail(candle);
    }

    // ── Condition Tightening (every 15 bars, MFE > 0) ───────
    if (t.barsHeld % 15 === 0 && t.mfe > 0) {
      await this._checkConditionTightening(candle);
    }

    // ── LLM Management (event-gated) ─────────────────────────
    if (this.llmClient && this.promptBuilder && t.mfe >= 10) {
      await this._checkLLMManagement(candle);
    }

    // ── Periodic log ────────────────────────────────────────
    if (t.barsHeld % 5 === 0) {
      logger.info(`[TRADE] Bar ${t.barsHeld}: MFE +${t.mfe.toFixed(1)}, MAE -${t.mae.toFixed(1)}, stop=${t.currentStop?.toFixed(2) || 'initial'}`);
    }
  }

  // ── Intra-bar Price Update ────────────────────────────────

  async _handlePriceUpdate(message) {
    if (!this.trade) return;
    if (message.baseSymbol !== this.ticker) return;

    const t = this.trade;
    const high = message.high;
    const low = message.low;

    if (high == null || low == null) return;

    // Update MFE / MAE from running bar high/low
    let mfeChanged = false;
    if (t.isLong) {
      const excursion = high - t.entryPrice;
      if (excursion > t.mfe) { t.mfe = excursion; mfeChanged = true; }
      const adverse = t.entryPrice - low;
      if (adverse > t.mae) t.mae = adverse;
    } else {
      const excursion = t.entryPrice - low;
      if (excursion > t.mfe) { t.mfe = excursion; mfeChanged = true; }
      const adverse = high - t.entryPrice;
      if (adverse > t.mae) t.mae = adverse;
    }

    // Only check ratchet if MFE actually increased
    if (mfeChanged) {
      await this._checkMFERatchet({ high, low, close: message.close, timestamp: message.timestamp });
    }
  }

  // ── MFE Ratchet ───────────────────────────────────────────

  async _checkMFERatchet(candle) {
    const t = this.trade;

    // Find the highest matching tier
    for (const tier of MFE_RATCHET_TIERS) {
      if (t.mfe >= tier.minMFE) {
        let newStop;
        if (t.isLong) {
          newStop = t.entryPrice + (t.mfe * tier.lockPct);
        } else {
          newStop = t.entryPrice - (t.mfe * tier.lockPct);
        }

        newStop = Math.round(newStop * 100) / 100;

        // Only update if tighter than current
        if (this._isStopTighter(newStop)) {
          const reason = `mfe_ratchet (${tier.label} at ${t.mfe.toFixed(0)}pt MFE)`;
          await this._modifyStop(newStop, reason, candle);
        }

        break; // Only apply highest matching tier
      }
    }
  }

  // ── Structural Trail ──────────────────────────────────────

  async _checkStructuralTrail(candle) {
    if (!this.featureAggregator) return;

    const t = this.trade;
    const timestamp = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();

    const levels = this.featureAggregator.getStructuralLevels(
      timestamp, candle.close, this.featureAggregator._getCurrentTradingDay?.() || null
    );

    if (!levels || levels.length === 0) return;

    // Find nearest structural level BEHIND price (below for long, above for short)
    let trailLevel = null;

    if (t.isLong) {
      // For longs, find the highest level below current price
      const belowLevels = levels
        .filter(l => l.price < candle.close && l.price > t.entryPrice)
        .sort((a, b) => b.price - a.price);
      if (belowLevels.length > 0) {
        trailLevel = belowLevels[0];
      }
    } else {
      // For shorts, find the lowest level above current price
      const aboveLevels = levels
        .filter(l => l.price > candle.close && l.price < t.entryPrice)
        .sort((a, b) => a.price - b.price);
      if (aboveLevels.length > 0) {
        trailLevel = aboveLevels[0];
      }
    }

    if (!trailLevel) return;

    // Trail stop to just behind the structural level (2 points buffer)
    let newStop;
    if (t.isLong) {
      newStop = trailLevel.price - 2;
    } else {
      newStop = trailLevel.price + 2;
    }

    newStop = Math.round(newStop * 100) / 100;

    if (this._isStopTighter(newStop)) {
      const reason = `structural_trail (behind ${trailLevel.label} @ ${trailLevel.price.toFixed(2)})`;
      await this._modifyStop(newStop, reason, candle);
    }
  }

  // ── Condition Tightening ──────────────────────────────────

  async _checkConditionTightening(candle) {
    if (!this.featureAggregator) return;

    const t = this.trade;
    const timestamp = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();

    // Check LT migration over the last 30 minutes
    const ltMigration = this.featureAggregator._computeLTMigration(
      null, // tradingDay not needed for relative computation
      timestamp - 30 * 60 * 1000,
      timestamp
    );

    if (!ltMigration) return;

    // If conditions are deteriorating, lock 60% of MFE
    if (ltMigration.overallSignal === 'deteriorating') {
      let newStop;
      if (t.isLong) {
        newStop = t.entryPrice + (t.mfe * 0.60);
      } else {
        newStop = t.entryPrice - (t.mfe * 0.60);
      }

      newStop = Math.round(newStop * 100) / 100;

      if (this._isStopTighter(newStop)) {
        const reason = `condition_tightening (LT deteriorating, lock 60% of +${t.mfe.toFixed(0)}pt MFE)`;
        await this._modifyStop(newStop, reason, candle);
      }
    }
  }

  // ── Stop Modification ─────────────────────────────────────

  _isStopTighter(newStop) {
    const t = this.trade;
    if (t.currentStop === null) return true;

    if (t.isLong) {
      return newStop > t.currentStop;
    } else {
      return newStop < t.currentStop;
    }
  }

  async _modifyStop(newStop, reason, candle) {
    const t = this.trade;
    const prevStop = t.currentStop;
    t.currentStop = newStop;

    t.stopAdjustments.push({
      bar: t.barsHeld,
      from: prevStop,
      to: newStop,
      reason,
      mfe: t.mfe,
      timestamp: new Date().toISOString(),
    });

    logger.info(`[STOP] ${prevStop?.toFixed(2) || 'initial'} -> ${newStop.toFixed(2)} (${reason})`);

    // Publish modify_stop signal
    const signal = {
      webhook_type: 'trade_signal',
      action: 'modify_stop',
      strategy: this.strategyConstant,
      symbol: t.symbol,
      new_stop_price: newStop,
      reason,
      order_strategy_id: t.orderStrategyId,
      order_id: t.stopOrderId,
      metadata: {
        entryPrice: t.entryPrice,
        barsHeld: t.barsHeld,
        mfe: t.mfe,
        mae: t.mae,
        previousStop: prevStop,
        adjustmentCount: t.stopAdjustments.length,
      },
      timestamp: new Date().toISOString(),
    };

    try {
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, signal);
    } catch (error) {
      logger.error('Failed to publish modify_stop:', error);
    }
  }

  // ── LLM Management (event-gated) ─────────────────────────

  async _checkLLMManagement(candle) {
    const t = this.trade;
    const currentUnrealized = t.isLong
      ? candle.close - t.entryPrice
      : t.entryPrice - candle.close;

    let trigger = null;

    // Gate 1: MFE tier transition (20, 40, 60, 100)
    const mfeTier = t.mfe >= 100 ? 100 : t.mfe >= 60 ? 60 : t.mfe >= 40 ? 40 : t.mfe >= 20 ? 20 : 0;
    if (mfeTier > 0 && mfeTier > t.lastLLMCheckMFETier) {
      trigger = `MFE crossed ${mfeTier}pt tier (+${t.mfe.toFixed(0)}pts peak)`;
      t.lastLLMCheckMFETier = mfeTier;
    }

    // Gate 2: Significant giveback (unrealized < 50% of MFE, MFE >= 20)
    if (!trigger && t.mfe >= 20 && currentUnrealized > 0 && currentUnrealized < t.mfe * 0.5 && !t.givebackCheckFired) {
      trigger = `Giveback: unrealized ${currentUnrealized.toFixed(0)}pts vs MFE ${t.mfe.toFixed(0)}pts (${Math.round(currentUnrealized / t.mfe * 100)}% retained)`;
      t.givebackCheckFired = true;
    }

    // Gate 3: Time-based fallback every 15 bars (if no other trigger)
    if (!trigger && t.barsHeld >= 15 && t.barsHeld - t.lastLLMCheckBar >= 15) {
      trigger = `Periodic check (bar ${t.barsHeld})`;
    }

    if (!trigger) return;

    t.lastLLMCheckBar = t.barsHeld;
    this.llmManagementCalls++;

    // Build compact context for the management prompt
    const recentCandles = [];
    const candle1mBuffer = this.featureAggregator?.candle1mBuffer;
    if (candle1mBuffer) {
      const recent = candle1mBuffer.getCandles(10);
      for (const rc of recent) {
        recentCandles.push({
          time: new Date(rc.timestamp).toISOString(),
          open: rc.open, high: rc.high, low: rc.low, close: rc.close,
          volume: rc.volume,
        });
      }
    }

    // Get nearby structural levels
    const timestamp = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();

    let nearestResistance = null, nearestSupport = null;
    if (this.featureAggregator) {
      const tradingDay = this.featureAggregator._getCurrentTradingDay?.() || null;
      const structLevels = this.featureAggregator.getStructuralLevels(timestamp, candle.close, tradingDay);
      if (structLevels) {
        const above = structLevels.filter(l => l.aboveBelow === 'above').sort((a, b) => a.price - b.price);
        const below = structLevels.filter(l => l.aboveBelow === 'below').sort((a, b) => b.price - a.price);
        if (above.length > 0) nearestResistance = { price: above[0].price, label: above[0].label, distance: Math.abs(above[0].price - candle.close) };
        if (below.length > 0) nearestSupport = { price: below[0].price, label: below[0].label, distance: Math.abs(candle.close - below[0].price) };
      }
    }

    // Get GEX regime
    const gexRegime = this.featureAggregator?.gexCalculator?.getCurrentLevels()?.regime || null;

    const mgmtCtx = {
      entryPrice: t.entryPrice,
      isLong: t.isLong,
      currentStop: t.currentStop || t.initialStop,
      target: t.initialTarget,
      mfe: t.mfe,
      unrealizedPnl: currentUnrealized,
      barsHeld: t.barsHeld,
      trigger,
      recentCandles,
      nearestResistance,
      nearestSupport,
      gexRegime,
    };

    const mgmtPrompt = this.promptBuilder.buildManagementPrompt(mgmtCtx);

    try {
      logger.info(`[LLM MGMT] Trigger: ${trigger}`);
      const decision = await this.llmClient.query(mgmtPrompt.system, mgmtPrompt.user);

      if (decision.action === 'exit') {
        logger.info(`[LLM MGMT] EXIT: ${decision.reasoning}`);
        t.stopAdjustments.push({
          bar: t.barsHeld, from: t.currentStop, to: candle.close,
          reason: `llm_exit: ${decision.reasoning || 'LLM exit'}`,
          mfe: t.mfe,
          timestamp: new Date().toISOString(),
        });
        await this._exitPosition(candle, `llm_exit: ${decision.reasoning || 'LLM exit'}`);
        return;
      }

      if (decision.action === 'tighten' && decision.new_stop != null) {
        const proposed = decision.new_stop;
        // Guardrails: must be tighter AND between entry and current price
        const beyondPrice = t.isLong ? proposed > candle.close : proposed < candle.close;
        if (this._isStopTighter(proposed) && !beyondPrice && !isNaN(proposed)) {
          const reason = `llm_tighten: ${decision.reasoning || 'LLM tighten'}`;
          logger.info(`[LLM MGMT] TIGHTEN: ${t.currentStop?.toFixed(2) || 'initial'} -> ${proposed.toFixed(2)} (${decision.reasoning})`);
          await this._modifyStop(Math.round(proposed * 100) / 100, reason, candle);
        } else {
          logger.info(`[LLM MGMT] TIGHTEN rejected (${beyondPrice ? 'beyond price' : 'not tighter'}) proposed=${proposed}`);
        }
      } else if (decision.action === 'hold') {
        logger.debug(`[LLM MGMT] HOLD: ${decision.reasoning}`);
      }
    } catch (e) {
      logger.warn(`[LLM MGMT] Error: ${e.message} — continuing with mechanical management`);
    }
  }

  // ── Exit Position ───────────────────────────────────────────

  async _exitPosition(candle, reason) {
    const t = this.trade;
    if (!t) return;

    logger.info(`[EXIT] Publishing position_closed: ${reason}`);

    const signal = {
      webhook_type: 'trade_signal',
      action: 'position_closed',
      strategy: this.strategyConstant,
      symbol: t.symbol,
      side: t.side,
      reason,
      metadata: {
        entryPrice: t.entryPrice,
        barsHeld: t.barsHeld,
        mfe: t.mfe,
        mae: t.mae,
        stopAdjustments: t.stopAdjustments.length,
        llmManagementCalls: this.llmManagementCalls,
      },
      timestamp: new Date().toISOString(),
    };

    try {
      await messageBus.publish(CHANNELS.TRADE_SIGNAL, signal);
    } catch (error) {
      logger.error('Failed to publish position_closed:', error);
    }
  }

  // ── Status ────────────────────────────────────────────────

  getStatus() {
    if (!this.trade) return { active: false, llmManagementCalls: this.llmManagementCalls };

    const t = this.trade;
    return {
      active: true,
      side: t.side,
      entryPrice: t.entryPrice,
      barsHeld: t.barsHeld,
      mfe: t.mfe,
      mae: t.mae,
      currentStop: t.currentStop,
      stopAdjustments: t.stopAdjustments.length,
      llmManagementCalls: this.llmManagementCalls,
      llmEnabled: !!(this.llmClient && this.promptBuilder),
      lastAdjustment: t.stopAdjustments.length > 0
        ? t.stopAdjustments[t.stopAdjustments.length - 1]
        : null,
    };
  }
}

export default LiveTradeManager;
