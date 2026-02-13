/**
 * Trade Execution Simulator
 *
 * Simulates realistic trade execution including:
 * - Order fills with slippage
 * - Stop-loss and take-profit execution
 * - Trailing stops
 * - Commission tracking
 */

import { roundTo } from '../../../shared/strategies/strategy-utils.js';

export class TradeSimulator {
  constructor(config) {
    this.config = config;
    this.commission = config.commission || 5.0;
    this.slippage = config.slippage || {
      limitOrderSlippage: 0.25,
      marketOrderSlippage: 1.0,
      stopOrderSlippage: 1.5
    };
    this.contractSpecs = config.contractSpecs || {};

    // Market close configuration
    this.forceCloseAtMarketClose = config.forceCloseAtMarketClose ?? true;
    this.marketCloseTimeUTC = config.marketCloseTimeUTC || 21; // 4 PM EST = 21:00 UTC

    // Debug mode for detailed trade logging
    this.debugMode = config.debugMode || config.verbose || false;

    this.activeTrades = new Map();
    this.completedTrades = [];
    this.tradeId = 1;

    // Calendar spread tracking for contract rollovers
    this.calendarSpreads = new Map(); // Map<string, number> - spread prices (deprecated)
    this.calendarSpreadsByTime = new Map(); // Map<timestamp, Map<symbol, price>> - time-based lookup

    // Hybrid trailing stop configuration
    this.hybridTrailingConfig = config.hybridTrailing || {
      enabled: false,
      structureThreshold: 30,    // Points profit before switching to structure mode
      swingLookback: 5,          // Bars on each side to confirm swing low
      swingBuffer: 5,            // Points below swing low for stop placement
      minSwingSize: 3            // Minimum swing size in points to be valid
    };

    // Candle history for swing detection (per trade)
    this.tradeCandles = new Map(); // Map<tradeId, candle[]>

    // Time-based trailing stop configuration
    // Progressive stop tightening based on bars held + profit level
    this.timeBasedTrailingConfig = config.timeBasedTrailing || {
      enabled: false,
      rules: [
        // Example rules - tighten stop progressively based on time and profit
        // { afterBars: 15, ifMFE: 20, action: 'breakeven' },      // After 15 bars, if +20pts, move stop to entry
        // { afterBars: 30, ifMFE: 30, trailDistance: 20 },        // After 30 bars, if +30pts, trail 20pts behind
        // { afterBars: 45, ifMFE: 40, trailDistance: 10 },        // After 45 bars, if +40pts, trail 10pts behind
      ]
    };

    // Zero Gamma / Gamma Flip early exit configuration
    // Note: Forced exit (exitThreshold) disabled - only breakeven protection enabled
    // See analysis: breakeven saved +$7,420 (93% success), forced exit had insufficient sample size
    this.gfEarlyExitConfig = config.gfEarlyExit || {
      enabled: false,
      breakevenThreshold: 2,    // Consecutive adverse moves to trigger breakeven stop
      checkIntervalMs: 15 * 60 * 1000  // Check every 15 minutes (GEX data interval)
    };

    // GEX loader reference (set by backtest engine)
    this.gexLoader = null;

    // GF tracking state per trade
    this.tradeGFState = new Map(); // Map<tradeId, { lastGF, lastCheckTime, consecutiveAdverse, breakevenTriggered }>
  }

  /**
   * Process a trading signal and create an order
   *
   * @param {Object} signal - Trading signal object
   * @param {number} timestamp - Current timestamp
   * @returns {Object|null} Order object or null if rejected
   */
  processSignal(signal, timestamp) {
    // Check if we already have an active trade - only allow one trade at a time
    if (this.activeTrades.size > 0) {
      return null; // Reject signal - already have an active position
    }

    const order = {
      id: this.generateTradeId(),
      timestamp: timestamp,
      signalTime: timestamp,  // When the signal was generated (candle close)
      signal: signal,
      status: 'pending',
      side: signal.side,
      symbol: signal.symbol,
      quantity: signal.quantity,
      entryPrice: signal.price || signal.entryPrice, // Handle both field names
      stopLoss: signal.stop_loss || signal.stopLoss, // Handle both field names
      takeProfit: signal.take_profit || signal.takeProfit, // Handle both field names
      trailingTrigger: signal.trailing_trigger || signal.trailingTrigger, // Handle both field names
      trailingOffset: signal.trailing_offset || signal.trailingOffset, // Handle both field names
      breakevenStop: signal.breakeven_stop || signal.breakevenStop, // Handle both field names
      breakevenTrigger: signal.breakeven_trigger || signal.breakevenTrigger, // Handle both field names
      breakevenOffset: signal.breakeven_offset || signal.breakevenOffset, // Handle both field names
      timeBasedTrailing: signal.time_based_trailing || signal.timeBasedTrailing, // Handle both field names
      timeBasedConfig: signal.time_based_config || signal.timeBasedConfig, // Handle both field names
      strategy: signal.strategy || signal.metadata?.strategy,
      metadata: signal.metadata || {},
      // Add timeout tracking for limit orders
      timeoutCandles: signal.timeoutCandles || 0,
      candlesSinceSignal: 0,
      // Max hold bars - force exit after N bars in trade
      maxHoldBars: signal.maxHoldBars || signal.max_hold_bars || 0,
      barsSinceEntry: 0,
      // Track the contract the signal was generated on (for rollover handling)
      signalContract: signal.signalContract || null,
      // Entry time will be set when order fills (separate from signalTime)
      entryTime: null
    };

    // Add to active trades for monitoring
    this.activeTrades.set(order.id, order);

    return order;
  }

  /**
   * Cancel a pending order by ID
   * Used for strategy-driven invalidation (e.g., regime change)
   *
   * @param {string} tradeId - The trade ID to cancel
   * @param {string} reason - Reason for cancellation
   * @returns {Object|null} The cancelled order or null if not found/not pending
   */
  cancelPendingOrder(tradeId, reason = 'strategy_invalidated') {
    const trade = this.activeTrades.get(tradeId);

    if (!trade || trade.status !== 'pending') {
      return null;
    }

    trade.status = 'cancelled';
    this.activeTrades.delete(tradeId);

    if (this.debugMode) {
      console.log(`    ❌ [TRADE ${tradeId}] Order cancelled: ${reason}`);
    }

    return {
      ...trade,
      event: 'order_cancelled',
      cancelReason: reason
    };
  }

  /**
   * Get all pending orders (unfilled limit orders)
   *
   * @returns {Array} Array of pending trade objects
   */
  getPendingOrders() {
    return Array.from(this.activeTrades.values())
      .filter(trade => trade.status === 'pending');
  }

  /**
   * Update all active trades with current market data
   *
   * @param {Object} candle - Current candle data
   * @returns {Object[]} Array of trade updates/completions
   */
  updateActiveTrades(candle) {
    const updates = [];
    const debug = this.debugMode || false;

    if (debug && this.activeTrades.size > 0) {
      console.log(`\n🔍 [DEBUG] Processing candle ${new Date(candle.timestamp).toISOString()} | Symbol: ${candle.symbol} | Price: ${candle.close} | Active trades: ${this.activeTrades.size}`);
    }

    for (const [tradeId, trade] of this.activeTrades) {
      // Log trade status before processing
      if (debug) {
        console.log(`  📊 [TRADE ${tradeId}] Entry: ${trade.entryCandle?.symbol || 'N/A'} @ ${trade.actualEntry || trade.entryPrice} | Status: ${trade.status} | Current candle: ${candle.symbol}`);
      }

      // MODIFIED: Check for contract mismatch but allow calendar spread conversion
      let shouldSkip = false;
      if (trade.entryCandle && trade.entryCandle.symbol && candle.symbol !== trade.entryCandle.symbol) {
        // Check if we can handle this with calendar spread conversion
        const convertedPrice = this.getConvertedPrice(candle, trade.entryCandle.symbol);
        if (convertedPrice === null || convertedPrice === candle.close) {
          if (debug) {
            console.log(`  ⚠️  [TRADE ${tradeId}] Contract mismatch: ${trade.entryCandle.symbol} → ${candle.symbol}, no calendar spread available - SKIPPING`);
          }
          shouldSkip = true;
        } else {
          if (debug) {
            console.log(`  ✅ [TRADE ${tradeId}] Contract mismatch: ${trade.entryCandle.symbol} → ${candle.symbol}, using calendar spread conversion: ${candle.close} → ${convertedPrice}`);
          }
        }
      }

      if (shouldSkip) {
        continue; // Skip this candle - cannot handle contract mismatch
      }

      const update = this.updateTrade(trade, candle);
      if (update) {
        if (debug) {
          console.log(`  🎯 [TRADE ${tradeId}] Update: ${update.event} | Exit reason: ${update.exitReason || 'N/A'}`);
        }
        updates.push(update);

        // Remove from active trades if completed or cancelled
        if (update.status === 'completed' || update.status === 'cancelled') {
          this.activeTrades.delete(tradeId);
          if (update.status === 'completed') {
            this.completedTrades.push(update);
          }
          // Note: cancelled orders are not added to completedTrades since no trade occurred
        }
      }
    }

    return updates;
  }

  /**
   * Check if there are any active trades
   *
   * @returns {boolean} True if there are active trades
   */
  hasActiveTrades() {
    return this.activeTrades.size > 0;
  }

  /**
   * Update all active trades using 1-second resolution data
   * This provides more accurate exit detection than 1-minute candles
   *
   * @param {Object[]} secondCandles - Array of 1-second candle data for current minute
   * @param {Object} minuteCandle - The 1-minute candle (for fallback/context)
   * @returns {Object[]} Array of trade updates/completions
   */
  updateActiveTradesWithSeconds(secondCandles, minuteCandle) {
    const updates = [];
    const debug = this.debugMode || false;

    if (debug && this.activeTrades.size > 0) {
      console.log(`\n🔬 [DEBUG-1S] Processing ${secondCandles.length} second bars | Active trades: ${this.activeTrades.size}`);
    }

    // If no 1-second data available, fall back to 1-minute processing
    if (!secondCandles || secondCandles.length === 0) {
      if (minuteCandle) {
        return this.updateActiveTrades(minuteCandle);
      }
      return updates;
    }

    // Sort second candles by timestamp
    secondCandles.sort((a, b) => a.timestamp - b.timestamp);

    if (debug) {
      console.log(`    📦 Processing ${secondCandles.length} second bars for ${this.activeTrades.size} active trade(s)`);
    }

    for (const [tradeId, trade] of this.activeTrades) {
      const update = this.updateTradeWithSecondResolution(trade, secondCandles, minuteCandle);
      if (update) {
        if (debug) {
          console.log(`  🎯 [TRADE ${tradeId}] 1s Update: ${update.event} | Exit reason: ${update.exitReason || 'N/A'}`);
        }
        updates.push(update);

        // Remove from active trades if completed or cancelled
        if (update.status === 'completed' || update.status === 'cancelled') {
          this.activeTrades.delete(tradeId);
          if (update.status === 'completed') {
            this.completedTrades.push(update);
          }
        }
      }
    }

    return updates;
  }

  /**
   * Update a single trade using 1-second resolution candles
   * Processes each second sequentially for accurate trigger/stop ordering
   *
   * @param {Object} trade - Trade object
   * @param {Object[]} secondCandles - Array of 1-second candles
   * @param {Object} minuteCandle - The 1-minute candle (for context/fallback)
   * @returns {Object|null} Trade update or null
   */
  updateTradeWithSecondResolution(trade, secondCandles, minuteCandle) {
    const debug = this.debugMode || false;

    if (trade.status !== 'pending' && trade.status !== 'active') {
      return null;
    }

    // For PENDING orders: check if we need to adjust price levels due to contract rollover
    // When data transitions from one contract to another (e.g., NQH5 → NQM5),
    // we adjust the order's entry, stop, and target prices using the calendar spread
    if (trade.status === 'pending' && trade.signalContract) {
      // Determine current contract from minute candle or first second bar
      const currentContract = minuteCandle?.symbol ||
        (secondCandles.length > 0 ? secondCandles[0].symbol : null);

      if (currentContract && currentContract !== trade.signalContract && !trade._contractAdjusted) {
        // Find calendar spread to convert order prices to new contract
        const spreadKey = `${trade.signalContract}-${currentContract}`;
        const reverseSpreadKey = `${currentContract}-${trade.signalContract}`;
        const timestamp = minuteCandle.timestamp ? new Date(minuteCandle.timestamp).getTime() : Date.now();

        let spread = this.getClosestCalendarSpread(spreadKey, timestamp);
        let adjustmentAmount = null;

        if (spread !== null) {
          // Forward spread: NQH5-NQM5 = -226 means NQH5 is 226 points below NQM5
          // To convert NQH5 price to NQM5 terms: add the absolute spread (since spread is negative)
          adjustmentAmount = -spread; // Negate because spread is (old - new), we want (new - old)
        } else {
          // Try reverse spread
          spread = this.getClosestCalendarSpread(reverseSpreadKey, timestamp);
          if (spread !== null) {
            // Reverse spread: NQM5-NQH5 = 226 means NQM5 is 226 points above NQH5
            // To convert NQH5 price to NQM5 terms: add the spread directly
            adjustmentAmount = spread;
          }
        }

        if (adjustmentAmount !== null) {
          const oldEntry = trade.entryPrice;
          const oldStop = trade.stopLoss;
          const oldTarget = trade.takeProfit;

          // Adjust all price levels to new contract
          trade.entryPrice = roundTo(trade.entryPrice + adjustmentAmount);
          if (trade.stopLoss) trade.stopLoss = roundTo(trade.stopLoss + adjustmentAmount);
          if (trade.takeProfit) trade.takeProfit = roundTo(trade.takeProfit + adjustmentAmount);

          // Mark as adjusted and update signal contract
          trade._contractAdjusted = true;
          trade._originalContract = trade.signalContract;
          trade._adjustmentAmount = adjustmentAmount;
          trade.signalContract = currentContract;

          if (debug) {
            console.log(`    🔄 [TRADE ${trade.id}] Contract rollover adjustment: ${trade._originalContract} → ${currentContract}`);
            console.log(`       Spread: ${adjustmentAmount.toFixed(2)} | Entry: ${oldEntry} → ${trade.entryPrice}`);
            console.log(`       Stop: ${oldStop} → ${trade.stopLoss} | Target: ${oldTarget} → ${trade.takeProfit}`);
          }
        } else if (debug) {
          console.log(`    ⚠️  [TRADE ${trade.id}] No calendar spread found for ${trade.signalContract} → ${currentContract}`);
        }
      }
    }

    // Determine the target contract symbol for price conversion:
    // 1. For active trades: use the entry candle's symbol
    // 2. For pending trades: use the signal contract (which may have been adjusted above)
    const targetSymbol = trade.status === 'active'
      ? (trade.entryCandle?.symbol || minuteCandle?.symbol)
      : (trade.signalContract || minuteCandle?.symbol);

    // Process each second bar sequentially, converting prices as needed
    for (let bar of secondCandles) {
      // CRITICAL: Convert bar prices to target contract using calendar spreads
      // The 1-second data includes multiple contracts (NQH5, NQM5, NQH6, etc.)
      // We must convert all prices to the trade's contract to avoid false exits
      if (targetSymbol && bar.symbol && bar.symbol !== targetSymbol) {
        const convertedClose = this.convertPrice(bar.close, bar.symbol, targetSymbol, bar.timestamp);

        if (convertedClose === null) {
          // No calendar spread available for conversion - skip this bar
          if (debug) {
            console.log(`    ⚠️  [TRADE ${trade.id}] Skipping 1s bar: no spread for ${bar.symbol} → ${targetSymbol}`);
          }
          continue;
        }

        // Create a converted copy of the bar with adjusted prices
        const spread = convertedClose - bar.close;
        bar = {
          ...bar,
          open: bar.open + spread,
          high: bar.high + spread,
          low: bar.low + spread,
          close: convertedClose,
          _originalSymbol: bar.symbol,
          _convertedFrom: bar.symbol,
          symbol: targetSymbol
        };

        if (debug) {
          console.log(`    💱 [TRADE ${trade.id}] Converted ${bar._originalSymbol} → ${targetSymbol}: spread=${spread.toFixed(2)}`);
        }
      }
      // Handle pending orders (entry fills)
      if (trade.status === 'pending') {
        // For pending orders, we still need to track candles for timeout
        // But we check fill on each second bar
        const fillResult = this.checkOrderFill(trade, bar);
        if (fillResult.filled) {
          trade.status = 'active';
          trade.actualEntry = fillResult.fillPrice;
          trade.entryTime = bar.timestamp;
          trade.entryCandle = bar;

          if (debug) {
            console.log(`    ✅ [TRADE ${trade.id}] Order filled at ${fillResult.fillPrice} (1s: ${new Date(bar.timestamp).toISOString()})`);
          }

          // Initialize trailing stop if enabled (regular trailing, breakeven, or time-based mode)
          if ((trade.trailingTrigger && trade.trailingOffset) || trade.breakevenStop || trade.signal?.timeBasedTrailing || this.timeBasedTrailingConfig?.enabled) {
            trade.trailingStop = this.initializeTrailingStop(trade, fillResult.fillPrice);
          }

          // Continue to check exits on subsequent bars in this same second array
          continue;
        }
        // If not filled on this bar, continue to next bar
        continue;
      }

      // Handle active trades - check exits
      if (trade.status === 'active') {
        // Check market close
        if (this.forceCloseAtMarketClose && this.isMarketClose(bar.timestamp)) {
          return this.exitTrade(trade, bar, 'market_close', bar.close);
        }

        // Check forced time exit (e.g., overnight strategy exit at 9:30 AM)
        if (trade.signal?.forceExitTimeUTC && bar.timestamp >= trade.signal.forceExitTimeUTC) {
          return this.exitTrade(trade, bar, 'time_exit', bar.close);
        }

        // Check max hold bars (force exit after N bars in trade)
        if (debug && trade.barsSinceEntry % 10 === 0) {
          console.log(`    🔢 [TRADE ${trade.id}] barsSinceEntry=${trade.barsSinceEntry} / maxHoldBars=${trade.maxHoldBars}`);
        }
        if (trade.maxHoldBars > 0 && trade.barsSinceEntry >= trade.maxHoldBars) {
          if (debug) {
            console.log(`    ⏰ [TRADE ${trade.id}] MAX HOLD BARS (${trade.maxHoldBars}) reached at 1s bar ${new Date(bar.timestamp).toISOString()}`);
          }
          return this.exitTrade(trade, bar, 'max_hold_time', bar.close);
        }

        // Check Zero Gamma early exit conditions (every 15 minutes)
        // Only breakeven protection enabled (forced exit removed - insufficient sample size)
        const gfAction = this.checkGFEarlyExit(trade, bar.timestamp);
        if (gfAction && gfAction.action === 'breakeven') {
          this.applyGFBreakevenStop(trade);
        }

        // CRITICAL: Process in correct order for accurate simulation
        // 1. First check if STOP would be hit at current stop price BEFORE updating trailing
        const currentStopPrice = trade.trailingStop ? trade.trailingStop.currentStop : trade.stopLoss;

        if (this.checkStopHit(trade, bar, currentStopPrice)) {
          const isTrailingStop = trade.trailingStop?.triggered === true;
          const exitReason = isTrailingStop ? 'trailing_stop' : 'stop_loss';
          if (debug) {
            console.log(`    🛑 [TRADE ${trade.id}] ${exitReason.toUpperCase()} hit at 1s bar ${new Date(bar.timestamp).toISOString()}`);
          }
          return this.exitTrade(trade, bar, exitReason, currentStopPrice);
        }

        // 2. Check take profit
        if (this.checkTakeProfitHit(trade, bar)) {
          if (debug) {
            console.log(`    🎯 [TRADE ${trade.id}] TAKE PROFIT hit at 1s bar ${new Date(bar.timestamp).toISOString()}`);
          }
          return this.exitTrade(trade, bar, 'take_profit', trade.takeProfit);
        }

        // 3. Now update trailing stop for next iteration
        // This ensures we check stops BEFORE updating the trailing, preventing
        // the issue where trailing updates and stop checks happen "atomically"
        if (trade.trailingStop) {
          this.updateTrailingStop(trade, bar);
        }
      }
    }

    if (debug) {
      console.log(`    🏁 [TRADE ${trade.id}] For loop complete. status=${trade.status}`);
    }

    // If we're still pending after all second bars, check timeout
    if (trade.status === 'pending' && minuteCandle) {
      trade.candlesSinceSignal++;
      if (trade.signal.action === 'place_limit' && trade.timeoutCandles > 0) {
        if (trade.candlesSinceSignal >= trade.timeoutCandles) {
          trade.status = 'cancelled';
          return {
            ...trade,
            event: 'order_cancelled',
            cancelReason: 'timeout',
            candlesWaited: trade.candlesSinceSignal
          };
        }
      }
    }

    // Increment bars since entry for active trades (for maxHoldBars tracking)
    if (debug) {
      console.log(`    📊 [TRADE ${trade.id}] Before increment: barsSinceEntry=${trade.barsSinceEntry}, status=${trade.status}, hasMinuteCandle=${!!minuteCandle}`);
    }
    if (trade.status === 'active' && minuteCandle) {
      trade.barsSinceEntry++;
      if (debug) {
        console.log(`    📈 [TRADE ${trade.id}] After increment: barsSinceEntry=${trade.barsSinceEntry}`);
      }
    }

    return null;
  }

  /**
   * Update a single trade with current market data
   *
   * @param {Object} trade - Trade object
   * @param {Object} candle - Current candle data
   * @returns {Object|null} Trade update or null
   */
  updateTrade(trade, candle) {
    const debug = this.debugMode || false;

    if (trade.status !== 'pending' && trade.status !== 'active') {
      return null;
    }

    // Use calendar spread conversion if needed for contract transitions
    const originalPrice = candle.close;
    const currentPrice = trade.entryCandle ?
      this.getConvertedPrice(candle, trade.entryCandle.symbol) :
      candle.close;

    if (debug && currentPrice !== originalPrice) {
      console.log(`    💱 [TRADE ${trade.id}] Price conversion: ${originalPrice} → ${currentPrice} (${candle.symbol} → ${trade.entryCandle?.symbol})`);
    }

    // Check if order should be filled (entry)
    if (trade.status === 'pending') {
      // Increment candle counter for timeout tracking
      trade.candlesSinceSignal++;

      if (debug) {
        console.log(`    ⏰ [TRADE ${trade.id}] Pending order check | Candles waited: ${trade.candlesSinceSignal} | Timeout: ${trade.timeoutCandles || 'N/A'}`);
      }

      // Check for order timeout (limit orders only)
      if (trade.signal.action === 'place_limit' && trade.timeoutCandles > 0) {
        if (trade.candlesSinceSignal >= trade.timeoutCandles) {
          // Order expired - cancel it
          trade.status = 'cancelled';
          if (debug) {
            console.log(`    ❌ [TRADE ${trade.id}] Order timeout after ${trade.candlesSinceSignal} candles`);
          }
          return {
            ...trade,
            event: 'order_cancelled',
            cancelReason: 'timeout',
            candlesWaited: trade.candlesSinceSignal
          };
        }
      }

      const fillResult = this.checkOrderFill(trade, candle);
      if (fillResult.filled) {
        trade.status = 'active';
        trade.actualEntry = fillResult.fillPrice;
        trade.entryTime = candle.timestamp;
        trade.entryCandle = candle;

        if (debug) {
          console.log(`    ✅ [TRADE ${trade.id}] Order filled at ${fillResult.fillPrice}`);
        }

        // Initialize trailing stop if enabled (regular trailing, breakeven, or time-based mode)
        if ((trade.trailingTrigger && trade.trailingOffset) || trade.breakevenStop || trade.signal?.timeBasedTrailing || this.timeBasedTrailingConfig?.enabled) {
          trade.trailingStop = this.initializeTrailingStop(trade, fillResult.fillPrice);
          if (debug) {
            const mode = trade.trailingStop.mode || 'fixed';
            console.log(`    📈 [TRADE ${trade.id}] Trailing stop initialized: trigger=${trade.trailingTrigger}, offset=${trade.trailingOffset}, mode=${mode}`);
          }
        }

        return { ...trade, event: 'entry_filled', fillPrice: fillResult.fillPrice };
      }

      if (debug && trade.signal.action === 'place_limit') {
        const distanceToFill = this.isBuyPosition(trade) ? (candle.low - trade.entryPrice) : (trade.entryPrice - candle.high);
        console.log(`    📊 [TRADE ${trade.id}] Limit order waiting | Entry: ${trade.entryPrice} | Low: ${candle.low} | High: ${candle.high} | Distance to fill: ${distanceToFill.toFixed(2)}`);
      }
      return null;
    }

    // Trade is active - check for exit conditions
    if (trade.status === 'active') {
      if (debug) {
        console.log(`    🎯 [TRADE ${trade.id}] Active trade exit checks | Current price: ${currentPrice} | Entry: ${trade.actualEntry}`);
      }

      // Check market close first (highest priority)
      if (this.forceCloseAtMarketClose && this.isMarketClose(candle.timestamp)) {
        if (debug) {
          console.log(`    🌅 [TRADE ${trade.id}] Market close detected - forcing exit`);
        }
        return this.exitTrade(trade, candle, 'market_close', currentPrice);
      }

      // Check forced time exit (e.g., overnight strategy exit at 9:30 AM)
      if (trade.signal?.forceExitTimeUTC && candle.timestamp >= trade.signal.forceExitTimeUTC) {
        if (debug) {
          console.log(`    ⏰ [TRADE ${trade.id}] Forced time exit at ${new Date(trade.signal.forceExitTimeUTC).toISOString()}`);
        }
        return this.exitTrade(trade, candle, 'time_exit', currentPrice);
      }

      // Increment bars since entry and check max hold bars
      trade.barsSinceEntry++;
      if (trade.maxHoldBars > 0 && trade.barsSinceEntry >= trade.maxHoldBars) {
        if (debug) {
          console.log(`    ⏰ [TRADE ${trade.id}] MAX HOLD BARS (${trade.maxHoldBars}) reached - forcing exit`);
        }
        return this.exitTrade(trade, candle, 'max_hold_time', currentPrice);
      }

      // Check Zero Gamma early exit conditions (every 15 minutes)
      // Only breakeven protection enabled (forced exit removed - insufficient sample size)
      const gfAction = this.checkGFEarlyExit(trade, candle.timestamp);
      if (gfAction && gfAction.action === 'breakeven') {
        this.applyGFBreakevenStop(trade);
      }

      // Validate contract consistency - BUT USE CONVERSION IF POSSIBLE
      if (this.hasContractMismatch(trade, candle)) {
        if (debug) {
          console.log(`    ⚠️  [TRADE ${trade.id}] Contract mismatch detected: ${trade.entryCandle?.symbol} vs ${candle.symbol} - attempting conversion`);
        }

        // Try to use calendar spread conversion instead of skipping
        if (currentPrice === candle.close) {
          // No conversion possible - log detailed info and skip
          console.warn(`❌ [TRADE ${trade.id}] Cannot convert price between ${trade.entryCandle?.symbol} and ${candle.symbol} - trade stuck!`);
          console.warn(`   Entry symbol: ${trade.entryCandle?.symbol} | Current symbol: ${candle.symbol}`);
          console.warn(`   Available spreads: ${this.calendarSpreadsByTime.size} time periods, ${Array.from(this.calendarSpreadsByTime.values())[0]?.size || 0} spreads per period`);
          return null;
        }
      }

      // Update trailing stop if enabled
      if (trade.trailingStop) {
        const oldStop = trade.trailingStop.currentStop;
        this.updateTrailingStop(trade, candle);
        if (debug && trade.trailingStop.currentStop !== oldStop) {
          const waterMark = this.isBuyPosition(trade) ? trade.trailingStop.highWaterMark : trade.trailingStop.lowWaterMark;
          console.log(`    📈 [TRADE ${trade.id}] Trailing stop updated: ${oldStop} → ${trade.trailingStop.currentStop} | Water mark: ${waterMark}`);
        }
      }

      // Check stop loss
      const stopPrice = trade.trailingStop ? trade.trailingStop.currentStop : trade.stopLoss;
      if (debug) {
        console.log(`    🛑 [TRADE ${trade.id}] Stop check | Stop price: ${stopPrice} | Current: ${currentPrice} | Low: ${candle.low} | High: ${candle.high}`);
      }

      if (this.checkStopHit(trade, candle, stopPrice)) {
        // Determine if this was a trailing stop or regular stop loss
        const isTrailingStop = trade.trailingStop?.triggered === true;
        const exitReason = isTrailingStop ? 'trailing_stop' : 'stop_loss';
        if (debug) {
          console.log(`    🛑 [TRADE ${trade.id}] ${isTrailingStop ? 'TRAILING STOP' : 'STOP LOSS'} HIT! Exiting at ${stopPrice}`);
        }
        return this.exitTrade(trade, candle, exitReason, stopPrice);
      }

      // Check take profit
      if (debug) {
        console.log(`    🎯 [TRADE ${trade.id}] Take profit check | Target: ${trade.takeProfit} | Current: ${currentPrice}`);
      }

      if (this.checkTakeProfitHit(trade, candle)) {
        if (debug) {
          console.log(`    🎯 [TRADE ${trade.id}] TAKE PROFIT HIT! Exiting at ${trade.takeProfit}`);
        }
        return this.exitTrade(trade, candle, 'take_profit', trade.takeProfit);
      }

      if (debug) {
        console.log(`    ➡️  [TRADE ${trade.id}] No exit conditions met - trade continues`);
      }
    }

    return null;
  }

  /**
   * Check if an entry order should be filled
   *
   * IMPORTANT: This simulates realistic limit order fills:
   * - If price reaches the limit level, fill at the limit price
   * - If price gaps THROUGH the limit (opens beyond it), fill at the open (price improvement)
   * - This handles overnight gaps and fast markets correctly
   *
   * @param {Object} trade - Trade object
   * @param {Object} candle - Current candle
   * @returns {Object} { filled: boolean, fillPrice: number }
   */
  checkOrderFill(trade, candle) {
    // Normalize side: handle both 'buy'/'sell' and 'long'/'short' conventions
    const isBuyOrder = trade.side === 'buy' || trade.side === 'long';

    if (trade.signal.action === 'place_market') {
      // Market order - always fills with slippage
      const slippage = isBuyOrder ? this.slippage.marketOrderSlippage : -this.slippage.marketOrderSlippage;
      return {
        filled: true,
        fillPrice: roundTo(candle.close + slippage)
      };
    }

    if (trade.signal.action === 'place_limit') {
      // Limit order - check if price reached our level
      if (isBuyOrder) {
        // Buy limit: fill if market went at or below our limit price
        if (candle.low <= trade.entryPrice) {
          // Check if price gapped through (opened below our limit)
          // In this case, we get filled at the open (price improvement)
          if (candle.open <= trade.entryPrice) {
            return {
              filled: true,
              fillPrice: roundTo(candle.open)  // Price improvement - filled at open
            };
          }
          // Normal fill at limit price
          return {
            filled: true,
            fillPrice: roundTo(trade.entryPrice)
          };
        }
      } else {
        // Sell limit: fill if market went at or above our limit price
        if (candle.high >= trade.entryPrice) {
          // Check if price gapped through (opened above our limit)
          // In this case, we get filled at the open (price improvement)
          if (candle.open >= trade.entryPrice) {
            return {
              filled: true,
              fillPrice: roundTo(candle.open)  // Price improvement - filled at open
            };
          }
          // Normal fill at limit price
          return {
            filled: true,
            fillPrice: roundTo(trade.entryPrice)
          };
        }
      }
    }

    return { filled: false, fillPrice: null };
  }

  /**
   * Update trailing stop logic
   *
   * @param {Object} trade - Trade object with trailing stop
   * @param {Object} candle - Current candle (use high/low for better tracking)
   */
  updateTrailingStop(trade, candle) {
    // Check if time-based trailing is enabled for this trade
    if (trade.trailingStop?.mode === 'timeBased') {
      return this.updateTimeBasedTrailingStop(trade, candle);
    }

    // Check if hybrid trailing is enabled for this trade
    if (trade.trailingStop?.mode === 'hybrid') {
      return this.updateHybridTrailingStop(trade, candle);
    }

    // Check if breakeven mode is enabled (move stop to entry, don't trail further)
    if (trade.trailingStop?.mode === 'breakeven') {
      return this.updateBreakevenStop(trade, candle);
    }

    const trailing = trade.trailingStop;
    const entryPrice = trade.actualEntry || trade.entryPrice;

    if (this.isBuyPosition(trade)) {
      // Long position: track high water mark using candle high
      if (candle.high > trailing.highWaterMark) {
        trailing.highWaterMark = candle.high;

        // Check if we should trigger trailing stop
        const gainFromEntry = candle.high - entryPrice;

        if (!trailing.triggered && gainFromEntry >= trade.trailingTrigger) {
          trailing.triggered = true;
        }

        // Update stop if triggered
        if (trailing.triggered) {
          const newStop = candle.high - trade.trailingOffset;
          trailing.currentStop = Math.max(trailing.currentStop, newStop);
        }
      }
    } else {
      // Short position: track low water mark using candle low
      if (candle.low < trailing.lowWaterMark) {
        trailing.lowWaterMark = candle.low;

        // Check if we should trigger trailing stop
        const gainFromEntry = entryPrice - candle.low;

        if (!trailing.triggered && gainFromEntry >= trade.trailingTrigger) {
          trailing.triggered = true;
        }

        // Update stop if triggered (move stop DOWN for shorts)
        if (trailing.triggered) {
          const newStop = candle.low + trade.trailingOffset;
          trailing.currentStop = Math.min(trailing.currentStop, newStop);
        }
      }
    }
  }

  /**
   * Update breakeven stop - moves stop to entry when trigger reached, no further trailing
   *
   * This mode is designed to protect capital without cutting winners short:
   * - When trade reaches X points profit, move stop to entry (breakeven)
   * - Keep original take profit target
   * - Do NOT trail further - just protect against reversals
   *
   * @param {Object} trade - Trade object with breakeven stop
   * @param {Object} candle - Current candle
   */
  updateBreakevenStop(trade, candle) {
    const trailing = trade.trailingStop;
    const entryPrice = trade.actualEntry || trade.entryPrice;
    const trigger = trailing.breakevenTrigger || trade.breakevenTrigger || trade.trailingTrigger || 20;
    // Protection offset: how far from entry the stop moves (0 = breakeven, negative = allow some loss)
    const protectionOffset = trade.breakevenOffset || trade.signal?.breakevenOffset || 0;

    if (this.isBuyPosition(trade)) {
      // Long position: track high water mark
      if (candle.high > trailing.highWaterMark) {
        trailing.highWaterMark = candle.high;
      }

      // Check if we should move stop
      const gainFromEntry = trailing.highWaterMark - entryPrice;

      if (!trailing.triggered && gainFromEntry >= trigger) {
        trailing.triggered = true;
        // Move stop to entry + offset (0 = breakeven, -30 = allow 30pt loss)
        trailing.currentStop = entryPrice + protectionOffset;
      }
    } else {
      // Short position: track low water mark
      if (candle.low < trailing.lowWaterMark) {
        trailing.lowWaterMark = candle.low;
      }

      // Check if we should move stop
      const gainFromEntry = entryPrice - trailing.lowWaterMark;

      if (!trailing.triggered && gainFromEntry >= trigger) {
        trailing.triggered = true;
        // Move stop to entry - offset (for shorts, + is against us)
        trailing.currentStop = entryPrice - protectionOffset;
      }
    }
  }

  /**
   * Update time-based trailing stop - progressive stop tightening based on bars held + profit
   *
   * This mode addresses the problem where 64% of losers were profitable (up 30+ points)
   * before reversing to full losses. By progressively tightening stops based on time in trade,
   * we can protect profits without clipping winners too early.
   *
   * Rules are evaluated in order and can specify:
   * - action: 'breakeven' - move stop to entry price
   * - trailDistance: N - trail N points behind high/low water mark
   *
   * Example configuration:
   * rules: [
   *   { afterBars: 15, ifMFE: 20, action: 'breakeven' },   // After 15 bars, if +20pts, breakeven
   *   { afterBars: 30, ifMFE: 30, trailDistance: 20 },     // After 30 bars, if +30pts, trail 20pts
   *   { afterBars: 45, ifMFE: 40, trailDistance: 10 },     // After 45 bars, if +40pts, trail 10pts
   * ]
   *
   * @param {Object} trade - Trade object with time-based trailing stop
   * @param {Object} candle - Current candle
   */
  updateTimeBasedTrailingStop(trade, candle) {
    const trailing = trade.trailingStop;
    const entryPrice = trade.actualEntry || trade.entryPrice;
    const rules = trailing.rules || [];
    const debug = this.debugMode;

    // Track which rule we're currently operating under
    const activeRuleIndex = trailing.activeRuleIndex ?? -1;

    if (this.isBuyPosition(trade)) {
      // Long position: track high water mark
      if (candle.high > trailing.highWaterMark) {
        trailing.highWaterMark = candle.high;
      }

      const currentMFE = trailing.highWaterMark - entryPrice;
      const barsHeld = trade.barsSinceEntry;

      // Find the most advanced rule that should be active
      let newActiveRule = null;
      let newActiveIndex = -1;

      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        // Rule applies if we've held long enough AND achieved required MFE
        if (barsHeld >= rule.afterBars && currentMFE >= rule.ifMFE) {
          newActiveRule = rule;
          newActiveIndex = i;
        }
      }

      // Apply the new rule if it's more advanced than current
      if (newActiveRule && newActiveIndex > activeRuleIndex) {
        trailing.activeRuleIndex = newActiveIndex;

        if (newActiveRule.action === 'breakeven') {
          // Move stop to entry (breakeven)
          const newStop = entryPrice;
          if (newStop > trailing.currentStop) {
            if (debug) {
              console.log(`    ⏱️  [TIME-BASED] Long ${trade.id}: Rule ${newActiveIndex} (bars>=${newActiveRule.afterBars}, MFE>=${newActiveRule.ifMFE}) → BREAKEVEN @ ${newStop.toFixed(2)}`);
            }
            trailing.currentStop = newStop;
            trailing.triggered = true;
            trailing.lastAction = 'breakeven';
          }
        } else if (newActiveRule.trailDistance != null) {
          // Trail at specified distance behind high water mark
          const newStop = trailing.highWaterMark - newActiveRule.trailDistance;
          if (newStop > trailing.currentStop) {
            if (debug) {
              console.log(`    ⏱️  [TIME-BASED] Long ${trade.id}: Rule ${newActiveIndex} (bars>=${newActiveRule.afterBars}, MFE>=${newActiveRule.ifMFE}) → Trail ${newActiveRule.trailDistance}pts @ ${newStop.toFixed(2)}`);
            }
            trailing.currentStop = newStop;
            trailing.triggered = true;
            trailing.currentTrailDistance = newActiveRule.trailDistance;
            trailing.lastAction = `trail_${newActiveRule.trailDistance}`;
          }
        }
      }

      // If we have an active trailing distance, continue to trail
      if (trailing.currentTrailDistance != null && trailing.currentTrailDistance > 0) {
        const trailingStop = trailing.highWaterMark - trailing.currentTrailDistance;
        if (trailingStop > trailing.currentStop) {
          if (debug) {
            console.log(`    📈 [TIME-BASED] Long ${trade.id}: Trailing stop updated ${trailing.currentStop.toFixed(2)} → ${trailingStop.toFixed(2)} (HWM: ${trailing.highWaterMark.toFixed(2)})`);
          }
          trailing.currentStop = trailingStop;
        }
      }
    } else {
      // Short position: track low water mark
      if (candle.low < trailing.lowWaterMark) {
        trailing.lowWaterMark = candle.low;
      }

      const currentMFE = entryPrice - trailing.lowWaterMark;
      const barsHeld = trade.barsSinceEntry;

      // Find the most advanced rule that should be active
      let newActiveRule = null;
      let newActiveIndex = -1;

      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (barsHeld >= rule.afterBars && currentMFE >= rule.ifMFE) {
          newActiveRule = rule;
          newActiveIndex = i;
        }
      }

      // Apply the new rule if it's more advanced than current
      if (newActiveRule && newActiveIndex > activeRuleIndex) {
        trailing.activeRuleIndex = newActiveIndex;

        if (newActiveRule.action === 'breakeven') {
          // Move stop to entry (breakeven)
          const newStop = entryPrice;
          if (newStop < trailing.currentStop) {
            if (debug) {
              console.log(`    ⏱️  [TIME-BASED] Short ${trade.id}: Rule ${newActiveIndex} (bars>=${newActiveRule.afterBars}, MFE>=${newActiveRule.ifMFE}) → BREAKEVEN @ ${newStop.toFixed(2)}`);
            }
            trailing.currentStop = newStop;
            trailing.triggered = true;
            trailing.lastAction = 'breakeven';
          }
        } else if (newActiveRule.trailDistance != null) {
          // Trail at specified distance behind low water mark
          const newStop = trailing.lowWaterMark + newActiveRule.trailDistance;
          if (newStop < trailing.currentStop) {
            if (debug) {
              console.log(`    ⏱️  [TIME-BASED] Short ${trade.id}: Rule ${newActiveIndex} (bars>=${newActiveRule.afterBars}, MFE>=${newActiveRule.ifMFE}) → Trail ${newActiveRule.trailDistance}pts @ ${newStop.toFixed(2)}`);
            }
            trailing.currentStop = newStop;
            trailing.triggered = true;
            trailing.currentTrailDistance = newActiveRule.trailDistance;
            trailing.lastAction = `trail_${newActiveRule.trailDistance}`;
          }
        }
      }

      // If we have an active trailing distance, continue to trail
      if (trailing.currentTrailDistance != null && trailing.currentTrailDistance > 0) {
        const trailingStop = trailing.lowWaterMark + trailing.currentTrailDistance;
        if (trailingStop < trailing.currentStop) {
          if (debug) {
            console.log(`    📈 [TIME-BASED] Short ${trade.id}: Trailing stop updated ${trailing.currentStop.toFixed(2)} → ${trailingStop.toFixed(2)} (LWM: ${trailing.lowWaterMark.toFixed(2)})`);
          }
          trailing.currentStop = trailingStop;
        }
      }
    }
  }

  /**
   * Update hybrid trailing stop - switches from fixed offset to swing-based trailing
   *
   * Phase 1 (Initial): Fixed trailing stop until structureThreshold profit reached
   * Phase 2 (Structure): Trail below swing lows once we have enough profit cushion
   *
   * @param {Object} trade - Trade object with hybrid trailing stop
   * @param {Object} candle - Current candle
   */
  updateHybridTrailingStop(trade, candle) {
    const trailing = trade.trailingStop;
    const entryPrice = trade.actualEntry || trade.entryPrice;
    const config = trailing.hybridConfig || this.hybridTrailingConfig;
    const debug = this.debugMode;

    // Store candle for swing detection
    if (!this.tradeCandles.has(trade.id)) {
      this.tradeCandles.set(trade.id, []);
    }
    const candles = this.tradeCandles.get(trade.id);
    candles.push({
      timestamp: candle.timestamp,
      high: candle.high,
      low: candle.low,
      close: candle.close
    });

    // Keep only enough candles for swing detection (2 * lookback + buffer)
    const maxCandles = (config.swingLookback * 2) + 20;
    if (candles.length > maxCandles) {
      candles.shift();
    }

    if (this.isBuyPosition(trade)) {
      // Long position logic

      // Update high water mark
      if (candle.high > trailing.highWaterMark) {
        trailing.highWaterMark = candle.high;
      }

      const currentProfit = trailing.highWaterMark - entryPrice;

      // Phase 1: Initial fixed trailing
      if (trailing.phase === 'initial') {
        // Check if we should activate initial trailing
        if (!trailing.triggered && currentProfit >= trade.trailingTrigger) {
          trailing.triggered = true;
          if (debug) {
            console.log(`    🔄 [HYBRID] Phase 1 activated: profit ${currentProfit.toFixed(1)} pts >= trigger ${trade.trailingTrigger}`);
          }
        }

        // Update fixed trailing stop if triggered
        if (trailing.triggered) {
          const newStop = trailing.highWaterMark - trade.trailingOffset;
          trailing.currentStop = Math.max(trailing.currentStop, newStop);
        }

        // Check if we should transition to structure mode
        if (currentProfit >= config.structureThreshold) {
          // Look for a valid swing low to trail
          const swingLow = this.findSwingLow(candles, config.swingLookback, config.minSwingSize, trade.side);

          if (swingLow !== null) {
            const swingStop = swingLow - config.swingBuffer;

            // Only switch if swing stop is better than (or close to) current stop
            // This prevents switching to a worse stop
            if (swingStop >= trailing.currentStop - 5) {
              trailing.phase = 'structure';
              trailing.currentStop = Math.max(trailing.currentStop, swingStop);
              trailing.lastSwingLow = swingLow;

              if (debug) {
                console.log(`    🏗️  [HYBRID] Phase 2 (Structure) activated!`);
                console.log(`       Profit: ${currentProfit.toFixed(1)} pts | Swing low: ${swingLow.toFixed(2)} | New stop: ${trailing.currentStop.toFixed(2)}`);
              }
            }
          }
        }
      }

      // Phase 2: Structure-based trailing
      else if (trailing.phase === 'structure') {
        // Look for new higher swing lows
        const swingLow = this.findSwingLow(candles, config.swingLookback, config.minSwingSize, trade.side);

        if (swingLow !== null && swingLow > (trailing.lastSwingLow || 0)) {
          const newStop = swingLow - config.swingBuffer;

          // Only move stop up, never down
          if (newStop > trailing.currentStop) {
            const oldStop = trailing.currentStop;
            trailing.currentStop = newStop;
            trailing.lastSwingLow = swingLow;

            if (debug) {
              console.log(`    📈 [HYBRID] Structure stop updated: ${oldStop.toFixed(2)} → ${newStop.toFixed(2)} (swing: ${swingLow.toFixed(2)})`);
            }
          }
        }
      }
    } else {
      // Short position logic (mirror of long logic)

      // Update low water mark
      if (candle.low < trailing.lowWaterMark) {
        trailing.lowWaterMark = candle.low;
      }

      const currentProfit = entryPrice - trailing.lowWaterMark;

      // Phase 1: Initial fixed trailing
      if (trailing.phase === 'initial') {
        if (!trailing.triggered && currentProfit >= trade.trailingTrigger) {
          trailing.triggered = true;
        }

        if (trailing.triggered) {
          const newStop = trailing.lowWaterMark + trade.trailingOffset;
          trailing.currentStop = Math.min(trailing.currentStop, newStop);
        }

        // Check for transition to structure mode
        if (currentProfit >= config.structureThreshold) {
          const swingHigh = this.findSwingHigh(candles, config.swingLookback, config.minSwingSize, trade.side);

          if (swingHigh !== null) {
            const swingStop = swingHigh + config.swingBuffer;

            if (swingStop <= trailing.currentStop + 5) {
              trailing.phase = 'structure';
              trailing.currentStop = Math.min(trailing.currentStop, swingStop);
              trailing.lastSwingHigh = swingHigh;

              if (debug) {
                console.log(`    🏗️  [HYBRID] Phase 2 (Structure) activated for SHORT`);
              }
            }
          }
        }
      }

      // Phase 2: Structure-based trailing for shorts
      else if (trailing.phase === 'structure') {
        const swingHigh = this.findSwingHigh(candles, config.swingLookback, config.minSwingSize, trade.side);

        if (swingHigh !== null && swingHigh < (trailing.lastSwingHigh || Infinity)) {
          const newStop = swingHigh + config.swingBuffer;

          if (newStop < trailing.currentStop) {
            trailing.currentStop = newStop;
            trailing.lastSwingHigh = swingHigh;
          }
        }
      }
    }
  }

  /**
   * Find the most recent valid swing low in the candle history
   * A swing low is a bar with lower lows than N bars on each side
   *
   * @param {Object[]} candles - Array of candle objects
   * @param {number} lookback - Number of bars on each side to confirm swing
   * @param {number} minSize - Minimum swing size in points
   * @param {string} side - Trade side ('buy' or 'sell')
   * @returns {number|null} Swing low price or null if not found
   */
  findSwingLow(candles, lookback, minSize, side) {
    if (candles.length < (lookback * 2 + 1)) {
      return null; // Not enough data
    }

    // Search from most recent backwards (but not the very last bars - need confirmation)
    for (let i = candles.length - lookback - 1; i >= lookback; i--) {
      const candidateLow = candles[i].low;
      let isSwingLow = true;

      // Check bars to the left
      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].low <= candidateLow) {
          isSwingLow = false;
          break;
        }
      }

      if (!isSwingLow) continue;

      // Check bars to the right
      for (let j = 1; j <= lookback; j++) {
        if (candles[i + j].low <= candidateLow) {
          isSwingLow = false;
          break;
        }
      }

      if (isSwingLow) {
        // Check minimum size - swing should be meaningful
        const leftHigh = Math.max(...candles.slice(i - lookback, i).map(c => c.high));
        const rightHigh = Math.max(...candles.slice(i + 1, i + lookback + 1).map(c => c.high));
        const swingDepth = Math.min(leftHigh, rightHigh) - candidateLow;

        if (swingDepth >= minSize) {
          return candidateLow;
        }
      }
    }

    return null;
  }

  /**
   * Find the most recent valid swing high in the candle history
   * A swing high is a bar with higher highs than N bars on each side
   *
   * @param {Object[]} candles - Array of candle objects
   * @param {number} lookback - Number of bars on each side to confirm swing
   * @param {number} minSize - Minimum swing size in points
   * @param {string} side - Trade side ('buy' or 'sell')
   * @returns {number|null} Swing high price or null if not found
   */
  findSwingHigh(candles, lookback, minSize, side) {
    if (candles.length < (lookback * 2 + 1)) {
      return null;
    }

    for (let i = candles.length - lookback - 1; i >= lookback; i--) {
      const candidateHigh = candles[i].high;
      let isSwingHigh = true;

      // Check bars to the left
      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].high >= candidateHigh) {
          isSwingHigh = false;
          break;
        }
      }

      if (!isSwingHigh) continue;

      // Check bars to the right
      for (let j = 1; j <= lookback; j++) {
        if (candles[i + j].high >= candidateHigh) {
          isSwingHigh = false;
          break;
        }
      }

      if (isSwingHigh) {
        const leftLow = Math.min(...candles.slice(i - lookback, i).map(c => c.low));
        const rightLow = Math.min(...candles.slice(i + 1, i + lookback + 1).map(c => c.low));
        const swingHeight = candidateHigh - Math.max(leftLow, rightLow);

        if (swingHeight >= minSize) {
          return candidateHigh;
        }
      }
    }

    return null;
  }

  /**
   * Initialize trailing stop for a trade
   * Supports fixed offset, breakeven, hybrid (structure-based), and time-based modes
   *
   * @param {Object} trade - Trade object
   * @param {number} fillPrice - Entry fill price
   * @returns {Object} Trailing stop configuration object
   */
  initializeTrailingStop(trade, fillPrice) {
    const baseTrailing = {
      triggered: false,
      highWaterMark: fillPrice,
      lowWaterMark: fillPrice,
      currentStop: trade.stopLoss
    };

    // Check if time-based mode is enabled (highest priority - most sophisticated)
    // This mode uses progressive rules based on bars held + profit level
    const useTimeBased = trade.signal?.timeBasedTrailing ||
                         trade.timeBasedTrailing ||
                         this.timeBasedTrailingConfig?.enabled;

    if (useTimeBased) {
      // Merge trade-specific config with defaults
      const tradeConfig = trade.signal?.timeBasedConfig || trade.timeBasedConfig || {};
      const rules = tradeConfig.rules || this.timeBasedTrailingConfig?.rules || [];

      return {
        ...baseTrailing,
        mode: 'timeBased',
        rules: rules,
        activeRuleIndex: -1,  // No rule active yet
        currentTrailDistance: null,  // Will be set when a trailing rule activates
        lastAction: null  // Track what action was last applied
      };
    }

    // Check if breakeven mode is enabled (move stop to entry, don't trail further)
    const useBreakeven = trade.signal?.breakevenStop ||
                         trade.breakevenStop ||
                         this.breakevenConfig?.enabled;

    if (useBreakeven) {
      return {
        ...baseTrailing,
        mode: 'breakeven',
        breakevenTrigger: trade.breakevenTrigger || trade.trailingTrigger || 20
      };
    }

    // Check if hybrid mode is enabled (via trade signal or global config)
    const useHybrid = trade.signal?.hybridTrailing ||
                      trade.hybridTrailing ||
                      this.hybridTrailingConfig.enabled;

    if (useHybrid) {
      // Merge trade-specific config with defaults
      const tradeConfig = trade.signal?.hybridConfig || trade.hybridConfig || {};
      const hybridConfig = {
        ...this.hybridTrailingConfig,
        ...tradeConfig
      };

      return {
        ...baseTrailing,
        mode: 'hybrid',
        phase: 'initial',  // Start in initial phase (fixed trailing)
        hybridConfig: hybridConfig,
        lastSwingLow: null,
        lastSwingHigh: null
      };
    }

    return {
      ...baseTrailing,
      mode: 'fixed'
    };
  }

  /**
   * Enable hybrid trailing mode globally
   *
   * @param {Object} config - Hybrid trailing configuration
   */
  enableHybridTrailing(config = {}) {
    this.hybridTrailingConfig = {
      ...this.hybridTrailingConfig,
      ...config,
      enabled: true
    };
  }

  /**
   * Disable hybrid trailing mode
   */
  disableHybridTrailing() {
    this.hybridTrailingConfig.enabled = false;
  }

  /**
   * Enable time-based trailing stop mode globally
   *
   * This mode progressively tightens stops based on:
   * 1. How long the trade has been open (bars held)
   * 2. How much profit has been achieved (MFE - max favorable excursion)
   *
   * Rules are evaluated in order. Each rule specifies:
   * - afterBars: Minimum bars held before rule applies
   * - ifMFE: Minimum points profit (MFE) before rule applies
   * - action: 'breakeven' to move stop to entry, OR
   * - trailDistance: Points to trail behind high/low water mark
   *
   * Example configuration based on correlation analysis:
   * {
   *   rules: [
   *     { afterBars: 15, ifMFE: 20, action: 'breakeven' },   // Protect entry after decent profit
   *     { afterBars: 30, ifMFE: 30, trailDistance: 20 },     // Start trailing after more time/profit
   *     { afterBars: 45, ifMFE: 40, trailDistance: 10 },     // Tighten trail for extended trades
   *   ]
   * }
   *
   * @param {Object} config - Time-based trailing configuration
   */
  enableTimeBasedTrailing(config = {}) {
    this.timeBasedTrailingConfig = {
      ...this.timeBasedTrailingConfig,
      ...config,
      enabled: true
    };
  }

  /**
   * Disable time-based trailing mode
   */
  disableTimeBasedTrailing() {
    this.timeBasedTrailingConfig.enabled = false;
  }

  /**
   * Check if stop loss was hit
   *
   * @param {Object} trade - Trade object
   * @param {Object} candle - Current candle
   * @param {number} stopPrice - Stop loss price
   * @returns {boolean} True if stop was hit
   */
  checkStopHit(trade, candle, stopPrice) {
    if (this.isBuyPosition(trade)) {
      // Long position: stop hit if price went below stop
      return candle.low <= stopPrice;
    } else {
      // Short position: stop hit if price went above stop
      return candle.high >= stopPrice;
    }
  }

  /**
   * Check if take profit was hit
   *
   * @param {Object} trade - Trade object
   * @param {Object} candle - Current candle
   * @returns {boolean} True if take profit was hit
   */
  checkTakeProfitHit(trade, candle) {
    // Skip take profit check if no target set (trailing stop only mode)
    if (trade.takeProfit == null) {
      return false;
    }

    if (this.isBuyPosition(trade)) {
      // Long position: TP hit if price went above target
      return candle.high >= trade.takeProfit;
    } else {
      // Short position: TP hit if price went below target
      return candle.low <= trade.takeProfit;
    }
  }

  /**
   * Exit a trade
   *
   * @param {Object} trade - Trade object
   * @param {Object} candle - Exit candle
   * @param {string} reason - Exit reason ('stop_loss', 'take_profit', 'manual')
   * @param {number} exitPrice - Target exit price
   * @returns {Object} Completed trade object
   */
  exitTrade(trade, candle, reason, exitPrice) {
    // Apply slippage to exit
    const isBuy = this.isBuyPosition(trade);
    let actualExitPrice;
    if (reason === 'stop_loss') {
      // Stops typically get worse slippage
      const slippage = isBuy ? -this.slippage.stopOrderSlippage : this.slippage.stopOrderSlippage;
      actualExitPrice = roundTo(exitPrice + slippage);
    } else {
      // Take profits and manual exits
      const slippage = isBuy ? -this.slippage.limitOrderSlippage : this.slippage.limitOrderSlippage;
      actualExitPrice = roundTo(exitPrice + slippage);
    }

    // Calculate P&L with correct contract specifications
    const entryPrice = trade.actualEntry || trade.entryPrice;
    const pointsPnL = isBuy
      ? actualExitPrice - entryPrice
      : entryPrice - actualExitPrice;

    // Get point value for the symbol (extract base symbol like NQ from NQH5)
    const baseSymbol = this.extractBaseSymbol(trade.symbol);
    const pointValue = this.getPointValue(baseSymbol);

    const grossPnL = pointsPnL * trade.quantity * pointValue;
    const netPnL = grossPnL - this.commission;

    // Clean up GF tracking state for this trade
    this.cleanupGFState(trade.id);

    // Get GF state info if available for trade metadata
    const gfState = this.tradeGFState.get(trade.id);
    const gfMetadata = gfState ? {
      gfConsecutiveAdverse: gfState.consecutiveAdverse,
      gfTotalAdverseSum: gfState.totalAdverseSum,
      gfBreakevenTriggered: gfState.breakevenTriggered
    } : {};

    const completedTrade = {
      ...trade,
      status: 'completed',
      signalTime: trade.signalTime,  // When the signal was generated (candle close)
      exitTime: candle.timestamp,
      exitCandle: candle,
      actualExit: actualExitPrice,
      exitReason: reason,
      grossPnL: roundTo(grossPnL),
      netPnL: roundTo(netPnL),
      commission: this.commission,
      duration: candle.timestamp - trade.entryTime,
      fillDelay: trade.entryTime - trade.signalTime,  // Time between signal and fill
      event: 'trade_completed',
      pointValue: pointValue,
      baseSymbol: baseSymbol,
      ...gfMetadata  // Include GF tracking data in trade record
    };

    // Add additional trade statistics
    completedTrade.pointsPnL = roundTo(pointsPnL);
    completedTrade.percentPnL = roundTo((pointsPnL / entryPrice) * 100);

    return completedTrade;
  }

  /**
   * Get current portfolio summary
   *
   * @returns {Object} Portfolio statistics
   */
  getPortfolioSummary() {
    const totalTrades = this.completedTrades.length;
    const winningTrades = this.completedTrades.filter(t => t.netPnL > 0);
    const losingTrades = this.completedTrades.filter(t => t.netPnL < 0);

    const totalPnL = this.completedTrades.reduce((sum, t) => sum + t.netPnL, 0);
    const totalCommission = this.completedTrades.reduce((sum, t) => sum + t.commission, 0);

    const avgWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.netPnL, 0) / winningTrades.length
      : 0;

    const avgLoss = losingTrades.length > 0
      ? losingTrades.reduce((sum, t) => sum + t.netPnL, 0) / losingTrades.length
      : 0;

    return {
      totalTrades,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: totalTrades > 0 ? roundTo((winningTrades.length / totalTrades) * 100) : 0,
      totalPnL: roundTo(totalPnL),
      totalCommission: roundTo(totalCommission),
      avgWin: roundTo(avgWin),
      avgLoss: roundTo(avgLoss),
      profitFactor: avgLoss !== 0 ? roundTo(Math.abs(avgWin / avgLoss)) : Infinity,
      activeTrades: this.activeTrades.size
    };
  }

  /**
   * Generate unique trade ID
   *
   * @returns {string} Trade ID
   */
  generateTradeId() {
    return `T${String(this.tradeId++).padStart(6, '0')}`;
  }

  /**
   * Get all completed trades
   *
   * @returns {Object[]} Array of completed trade objects
   */
  getCompletedTrades() {
    return this.completedTrades;
  }

  /**
   * Get all active trades
   *
   * @returns {Object[]} Array of active trade objects
   */
  getActiveTrades() {
    return Array.from(this.activeTrades.values());
  }

  /**
   * Extract base symbol from contract symbol (e.g., NQH5 -> NQ, MNQZ25 -> MNQ)
   *
   * @param {string} symbol - Full contract symbol
   * @returns {string} Base symbol
   */
  extractBaseSymbol(symbol) {
    // Handle continuous contracts (NQ1!, ES1!)
    if (symbol.includes('!')) {
      return symbol.replace(/[0-9!]+$/, '').toUpperCase();
    }

    // Handle dated contracts (NQH5, NQM25, MNQZ5)
    // Futures month codes: F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun,
    //                      N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec
    return symbol.replace(/[FGHJKMNQUVXZ]\d+$/i, '').toUpperCase();
  }

  /**
   * Get point value for a symbol
   *
   * @param {string} baseSymbol - Base symbol (e.g., NQ, ES)
   * @returns {number} Point value
   */
  getPointValue(baseSymbol) {
    if (this.contractSpecs[baseSymbol] && this.contractSpecs[baseSymbol].pointValue) {
      return this.contractSpecs[baseSymbol].pointValue;
    }

    // Default point values for common symbols
    const defaultPointValues = {
      'NQ': 20.0,   // E-mini NASDAQ-100
      'ES': 50.0,   // E-mini S&P 500
      'MNQ': 2.0,   // Micro E-mini NASDAQ-100
      'MES': 5.0,   // Micro E-mini S&P 500
      'RTY': 50.0,  // E-mini Russell 2000
      'YM': 5.0,    // E-mini Dow Jones
      'MYM': 0.50   // Micro E-mini Dow Jones
    };

    return defaultPointValues[baseSymbol] || 1.0; // Default to $1 per point if unknown
  }

  /**
   * Check if trade side indicates a buy/long position
   * Handles both 'buy'/'sell' and 'long'/'short' naming conventions
   *
   * @param {Object} trade - Trade object
   * @returns {boolean} True if this is a buy/long position
   */
  isBuyPosition(trade) {
    return trade.side === 'buy' || trade.side === 'long';
  }

  /**
   * Check if current time is at or past market close
   *
   * @param {number} timestamp - Current timestamp
   * @returns {boolean} True if market is closed
   */
  isMarketClose(timestamp) {
    const date = new Date(timestamp);
    const utcHour = date.getUTCHours();
    const utcMinute = date.getUTCMinutes();

    // Market closes at 4:00 PM EST = 21:00 UTC
    // Allow for some buffer (close at 20:55 UTC to be safe)
    const closeTimeUTC = this.marketCloseTimeUTC - 0.08; // 5 minute buffer = 20:55 UTC
    const currentTimeDecimal = utcHour + (utcMinute / 60);

    return currentTimeDecimal >= closeTimeUTC;
  }

  /**
   * Check if trade contract differs from current candle contract
   *
   * @param {Object} trade - Trade object with entry candle
   * @param {Object} candle - Current candle
   * @returns {boolean} True if contract mismatch detected
   */
  hasContractMismatch(trade, candle) {
    if (!trade.entryCandle || !trade.entryCandle.symbol || !candle.symbol) {
      return false; // No symbol info available
    }

    const entrySymbol = trade.entryCandle.symbol;
    const currentSymbol = candle.symbol;

    // If symbols match exactly, no mismatch
    if (entrySymbol === currentSymbol) {
      return false;
    }

    // If we can convert prices using calendar spreads, no mismatch
    const convertedPrice = this.convertPrice(candle.close, currentSymbol, entrySymbol);
    if (convertedPrice !== null) {
      return false; // We can handle this with price conversion
    }

    // Only return true if we truly cannot handle the price conversion
    return true;
  }

  /**
   * Initialize calendar spread data for efficient timestamp-based lookup
   *
   * @param {Object[]} calendarSpreads - Array of calendar spread records
   */
  initializeCalendarSpreads(calendarSpreads) {
    if (!calendarSpreads || calendarSpreads.length === 0) return;

    console.log(`📊 Initializing ${calendarSpreads.length} calendar spread records for price conversion...`);

    // Build timestamp-based lookup map
    calendarSpreads.forEach(spread => {
      if (!spread.symbol || !spread.symbol.includes('-') || !spread.timestamp) return;

      const timestamp = new Date(spread.timestamp).getTime();

      // Initialize timestamp entry if needed
      if (!this.calendarSpreadsByTime.has(timestamp)) {
        this.calendarSpreadsByTime.set(timestamp, new Map());
      }

      // Store spread price by symbol for this timestamp
      this.calendarSpreadsByTime.get(timestamp).set(spread.symbol, spread.close);
    });

    const timeCount = this.calendarSpreadsByTime.size;
    console.log(`✅ Calendar spread lookup initialized: ${timeCount} time periods with spread data`);
  }

  /**
   * Get calendar spread price for a specific symbol at a given timestamp
   *
   * @param {string} symbol - Calendar spread symbol (e.g., 'NQM4-NQU4')
   * @param {number} timestamp - Timestamp to lookup
   * @returns {number|null} Spread price or null if not found
   */
  getCalendarSpreadAtTime(symbol, timestamp) {
    const timeData = this.calendarSpreadsByTime.get(timestamp);
    if (!timeData) return null;

    return timeData.get(symbol) || null;
  }

  /**
   * Find the closest calendar spread data to a given timestamp
   *
   * @param {string} symbol - Calendar spread symbol
   * @param {number} targetTimestamp - Target timestamp
   * @param {number} maxDelta - Maximum allowed time difference in milliseconds (default: 15 minutes)
   * @returns {number|null} Spread price or null if not found within time threshold
   */
  getClosestCalendarSpread(symbol, targetTimestamp, maxDelta = 15 * 60 * 1000) {
    let closestTime = null;
    let smallestDelta = Infinity;

    // Search for closest timestamp with spread data
    for (const timestamp of this.calendarSpreadsByTime.keys()) {
      const delta = Math.abs(timestamp - targetTimestamp);
      if (delta < smallestDelta && delta <= maxDelta) {
        const timeData = this.calendarSpreadsByTime.get(timestamp);
        if (timeData && timeData.has(symbol)) {
          smallestDelta = delta;
          closestTime = timestamp;
        }
      }
    }

    if (closestTime === null) return null;

    return this.calendarSpreadsByTime.get(closestTime).get(symbol);
  }

  /**
   * Track calendar spread prices for contract conversion
   */
  trackCalendarSpread(symbol, spreadPrice) {
    if (symbol && symbol.includes('-')) {
      this.calendarSpreads.set(symbol, spreadPrice);
    }
  }

  /**
   * Convert price from one contract to another using calendar spread data
   *
   * @param {number} price - Price to convert
   * @param {string} fromContract - Source contract symbol
   * @param {string} toContract - Target contract symbol
   * @param {number} timestamp - Timestamp for spread lookup
   * @returns {number|null} Converted price or null if conversion not possible
   */
  convertPrice(price, fromContract, toContract, timestamp) {
    if (fromContract === toContract) {
      return price;
    }

    // Look for spread between these contracts using timestamp-based lookup
    const forwardSpreadKey = `${fromContract}-${toContract}`;
    const reverseSpreadKey = `${toContract}-${fromContract}`;

    // Try exact timestamp first, then closest within 15 minutes
    let spread = null;

    if (timestamp) {
      spread = this.getCalendarSpreadAtTime(forwardSpreadKey, timestamp);
      if (spread === null) {
        spread = this.getClosestCalendarSpread(forwardSpreadKey, timestamp);
      }

      if (spread !== null) {
        return price + spread;
      }

      // Try reverse spread
      spread = this.getCalendarSpreadAtTime(reverseSpreadKey, timestamp);
      if (spread === null) {
        spread = this.getClosestCalendarSpread(reverseSpreadKey, timestamp);
      }

      if (spread !== null) {
        return price - spread;
      }
    }

    // Fallback to old method for backwards compatibility
    if (this.calendarSpreads.has(forwardSpreadKey)) {
      const legacySpread = this.calendarSpreads.get(forwardSpreadKey);
      return price + legacySpread;
    }

    if (this.calendarSpreads.has(reverseSpreadKey)) {
      const legacySpread = this.calendarSpreads.get(reverseSpreadKey);
      return price - legacySpread;
    }

    // No spread data available - return null to indicate conversion not possible
    return null;
  }

  /**
   * Get current price with calendar spread conversion if needed
   */
  getConvertedPrice(candle, targetContract) {
    if (!candle.symbol || candle.symbol === targetContract) {
      return candle.close;
    }

    // Extract calendar spread info from candle if present
    if (candle.calendarSpread && candle.calendarSpreadPrice) {
      this.trackCalendarSpread(candle.calendarSpread, candle.calendarSpreadPrice);
    }

    // Try to convert using tracked spreads with timestamp
    const candleTimestamp = new Date(candle.timestamp).getTime();
    const convertedPrice = this.convertPrice(candle.close, candle.symbol, targetContract, candleTimestamp);
    if (convertedPrice !== null) {
      return convertedPrice;
    }

    // Fallback: use current candle price (may be inaccurate but prevents trade from getting stuck)
    console.warn(`⚠️ No calendar spread data available for ${candle.symbol} -> ${targetContract}, using current price`);
    return candle.close;
  }

  /**
   * Set the GEX loader for Zero Gamma early exit monitoring
   *
   * @param {Object} gexLoader - GexLoader instance with getGexLevels() method
   */
  setGexLoader(gexLoader) {
    this.gexLoader = gexLoader;
  }

  /**
   * Enable Zero Gamma early exit with configuration
   * Note: Only breakeven protection is enabled (forced exit removed due to insufficient sample size)
   *
   * @param {Object} config - GF early exit configuration
   */
  enableGFEarlyExit(config = {}) {
    this.gfEarlyExitConfig = {
      enabled: true,
      breakevenThreshold: config.breakevenThreshold ?? 2,
      checkIntervalMs: config.checkIntervalMs ?? 15 * 60 * 1000
    };
  }

  /**
   * Check and update GF early exit state for a trade
   * Returns exit action if threshold reached
   *
   * @param {Object} trade - Active trade object
   * @param {number} timestamp - Current timestamp in ms
   * @returns {Object|null} { action: 'breakeven'|'exit', consecutiveAdverse: number } or null
   */
  checkGFEarlyExit(trade, timestamp) {
    if (!this.gfEarlyExitConfig.enabled || !this.gexLoader) {
      return null;
    }

    // Initialize GF state for this trade if not exists
    if (!this.tradeGFState.has(trade.id)) {
      // Get initial GF value at trade entry
      const entryGF = this.gexLoader.getGexLevels(new Date(trade.entryTime));
      if (!entryGF || entryGF.gamma_flip == null) {
        return null; // No GF data at entry
      }

      this.tradeGFState.set(trade.id, {
        lastGF: entryGF.gamma_flip,
        lastCheckTime: trade.entryTime,
        consecutiveAdverse: 0,
        breakevenTriggered: false,
        totalAdverseSum: 0
      });
    }

    const state = this.tradeGFState.get(trade.id);

    // Only check at 15-minute intervals
    const timeSinceLastCheck = timestamp - state.lastCheckTime;
    if (timeSinceLastCheck < this.gfEarlyExitConfig.checkIntervalMs) {
      return null; // Not time to check yet
    }

    // Get current GF value
    const currentGexLevels = this.gexLoader.getGexLevels(new Date(timestamp));
    if (!currentGexLevels || currentGexLevels.gamma_flip == null) {
      return null; // No GF data at this time
    }

    const currentGF = currentGexLevels.gamma_flip;
    const gfDelta = currentGF - state.lastGF;

    // Determine if movement is adverse
    const isAdverse = this.isBuyPosition(trade)
      ? gfDelta < 0  // For longs, GF dropping is adverse
      : gfDelta > 0; // For shorts, GF rising is adverse

    // Update state
    state.lastCheckTime = timestamp;

    if (isAdverse && Math.abs(gfDelta) > 0.5) { // Small threshold to filter noise
      state.consecutiveAdverse++;
      state.totalAdverseSum += Math.abs(gfDelta);

      if (this.debugMode) {
        console.log(`    📉 [GF-EXIT] Trade ${trade.id}: Adverse move #${state.consecutiveAdverse}, GF: ${state.lastGF.toFixed(1)} → ${currentGF.toFixed(1)} (Δ${gfDelta.toFixed(1)})`);
      }
    } else if (!isAdverse && Math.abs(gfDelta) > 0.5) {
      // Reset consecutive count on favorable move
      state.consecutiveAdverse = 0;
      state.totalAdverseSum = 0;
    }

    state.lastGF = currentGF;

    // Check breakeven threshold only (forced exit removed - insufficient sample size to validate)
    if (state.consecutiveAdverse >= this.gfEarlyExitConfig.breakevenThreshold && !state.breakevenTriggered) {
      state.breakevenTriggered = true;
      return {
        action: 'breakeven',
        consecutiveAdverse: state.consecutiveAdverse,
        totalAdverseSum: state.totalAdverseSum
      };
    }

    return null;
  }

  /**
   * Apply GF-triggered breakeven stop to a trade
   *
   * @param {Object} trade - Trade object
   */
  applyGFBreakevenStop(trade) {
    const entryPrice = trade.actualEntry || trade.entryPrice;

    if (!trade.trailingStop) {
      // Initialize trailing stop in breakeven mode
      trade.trailingStop = {
        triggered: true,
        highWaterMark: entryPrice,
        lowWaterMark: entryPrice,
        currentStop: entryPrice, // Breakeven
        mode: 'gf_breakeven'
      };
    } else {
      // Move existing stop to breakeven
      trade.trailingStop.currentStop = entryPrice;
      trade.trailingStop.mode = 'gf_breakeven';
      trade.trailingStop.triggered = true;
    }

    if (this.debugMode) {
      console.log(`    🛡️  [GF-EXIT] Trade ${trade.id}: Stop moved to breakeven @ ${entryPrice.toFixed(2)}`);
    }
  }

  /**
   * Clean up GF state for a completed trade
   *
   * @param {string} tradeId - Trade ID
   */
  cleanupGFState(tradeId) {
    this.tradeGFState.delete(tradeId);
  }

  /**
   * Reset simulator state
   */
  reset() {
    this.activeTrades.clear();
    this.completedTrades = [];
    this.tradeId = 1;
    this.calendarSpreads.clear();
    this.tradeCandles.clear();
    this.tradeGFState.clear();
  }

  /**
   * Clean up candle history for a completed trade
   *
   * @param {string} tradeId - Trade ID to clean up
   */
  cleanupTradeCandles(tradeId) {
    this.tradeCandles.delete(tradeId);
  }
}