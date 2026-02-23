/**
 * Live Trade Manager — MFE ratchet, structural trail, and condition tightening.
 *
 * Extracted from the backtest's simulateManagedTrade() logic into a live class
 * that publishes modify_stop signals via Redis on each 1m candle.
 *
 * MFE Ratchet Tiers (same as backtest):
 *   MFE 20-39  → breakeven
 *   MFE 40-59  → lock 33%
 *   MFE 60-99  → lock 40%
 *   MFE 100+   → lock 50%
 *
 * Structural Trail: every 5 bars (MFE >= 20), trail behind nearest structural level.
 * Condition Tightening: every 15 bars (MFE > 0), lock 60% if LT deteriorating.
 */

import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';

const logger = createLogger('live-trade-manager');

// MFE ratchet tiers — matching backtest exactly
const MFE_RATCHET_TIERS = [
  { minMFE: 100, lockPct: 0.50, label: 'lock 50%' },
  { minMFE: 60,  lockPct: 0.40, label: 'lock 40%' },
  { minMFE: 40,  lockPct: 0.33, label: 'lock 33%' },
  { minMFE: 20,  lockPct: 0.00, label: 'breakeven' }, // lockPct 0 = entry price
];

export class LiveTradeManager {
  /**
   * @param {Object} opts
   * @param {Object} opts.featureAggregator - LiveFeatureAggregator instance
   * @param {string} [opts.strategyConstant='AI_TRADER']
   */
  constructor(opts = {}) {
    this.featureAggregator = opts.featureAggregator;
    this.strategyConstant = opts.strategyConstant || 'AI_TRADER';

    // Active trade state (null when flat)
    this.trade = null;
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
    };

    logger.info(`Trade manager activated: ${isLong ? 'LONG' : 'SHORT'} ${position.symbol} @ ${position.entryPrice}`);
  }

  /**
   * Deactivate tracking when position closes.
   */
  deactivate() {
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

    // ── Periodic log ────────────────────────────────────────
    if (t.barsHeld % 5 === 0) {
      logger.info(`[TRADE] Bar ${t.barsHeld}: MFE +${t.mfe.toFixed(1)}, MAE -${t.mae.toFixed(1)}, stop=${t.currentStop?.toFixed(2) || 'initial'}`);
    }
  }

  // ── MFE Ratchet ───────────────────────────────────────────

  async _checkMFERatchet(candle) {
    const t = this.trade;

    // Find the highest matching tier
    for (const tier of MFE_RATCHET_TIERS) {
      if (t.mfe >= tier.minMFE) {
        let newStop;
        if (tier.lockPct === 0) {
          // Breakeven = entry price
          newStop = t.entryPrice;
        } else {
          // Lock lockPct of MFE
          if (t.isLong) {
            newStop = t.entryPrice + (t.mfe * tier.lockPct);
          } else {
            newStop = t.entryPrice - (t.mfe * tier.lockPct);
          }
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

  // ── Status ────────────────────────────────────────────────

  getStatus() {
    if (!this.trade) return { active: false };

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
      lastAdjustment: t.stopAdjustments.length > 0
        ? t.stopAdjustments[t.stopAdjustments.length - 1]
        : null,
    };
  }
}

export default LiveTradeManager;
