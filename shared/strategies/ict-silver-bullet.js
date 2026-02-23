/**
 * ICT Silver Bullet Strategy
 *
 * Based on JV Trading's (Jordan Vera) methodology for the ICT Silver Bullet:
 *
 * Setup sequence:
 * 1. Track PDH/PDL as liquidity pools
 * 2. Detect liquidity sweep (wick beyond PDH/PDL, close inside)
 * 3. Detect structure shift — candle CLOSES beyond a recent swing point
 *    (combines CHoCH + MSS into a single confirmation step)
 * 4. Detect FVG (Fair Value Gap) created during the displacement move
 * 5. Entry when price retraces into FVG, within Fibonacci 50-79% zone
 * 6. Daily open as directional bias filter
 *
 * Silver Bullet time windows (ET):
 * - NY AM:  10:00-11:00 (primary)
 * - London: 03:00-04:00
 * - NY PM:  14:00-15:00
 *
 * W pattern (buy): sweep low → shift up → enter at FVG retest → target high
 * M pattern (sell): sweep high → shift down → enter at FVG retest → target low
 */

import { BaseStrategy } from './base-strategy.js';

export class ICTSilverBulletStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.params = {
      // Silver Bullet windows (ET hours)
      windows: [
        { name: 'NY_AM', startHour: 10, startMin: 0, endHour: 11, endMin: 0 },
        { name: 'LONDON', startHour: 3, startMin: 0, endHour: 4, endMin: 0 },
        { name: 'NY_PM', startHour: 14, startMin: 0, endHour: 15, endMin: 0 }
      ],
      activeWindows: ['NY_AM', 'LONDON', 'NY_PM'],

      // Structure detection
      swingLookback: 5,       // 5 bars each side (11 bars = 11 min on 1m); JV uses 9, but 5 backtests better
      minSwingSize: 5,
      breakConfirmation: 2,

      // Liquidity sweep
      sweepMinWick: 2,
      sweepRequireClose: true,

      // FVG
      minFVGSize: 3,
      maxFVGAge: 360,   // 6 hours — survive gap between setup and next SB window

      // Fibonacci filter
      useFibFilter: false,
      fibOptimalMin: 0.40,
      fibOptimalMax: 0.79,

      // Daily open bias
      useDailyOpenBias: false,

      // Risk management
      defaultRR: 2.0,
      maxStopPoints: 40,
      stopBuffer: 3,

      // Trade management
      maxTradesPerWindow: 1,
      maxTradesPerDay: 2,
      maxHoldBars: 120,
      candleBuffer: 180,

      // Structure shift timeout (candles after sweep before giving up)
      structureShiftTimeout: 60,

      // Direction filter
      useLongEntries: true,
      useShortEntries: true,

      // Standard
      signalCooldownMs: 30 * 60 * 1000,
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      debug: false,

      ...params
    };

    // Rolling candle buffer
    this.candles = [];

    // Global candle counter (doesn't shift with buffer trimming)
    this.globalCounter = 0;

    // Daily tracking
    this.currentDay = null;
    this.dailyOpen = null;
    this.prevDayHigh = null;
    this.prevDayLow = null;
    this.dayHigh = -Infinity;
    this.dayLow = Infinity;
    this.tradesThisDay = 0;

    // Per-window tracking
    this.currentWindowName = null;
    this.tradesThisWindow = 0;

    // Setup state — all tracking uses timestamps, not buffer indices
    this.resetSetup();
  }

  reset() {
    super.reset();
    this.candles = [];
    this.globalCounter = 0;
    this.currentDay = null;
    this.dailyOpen = null;
    this.prevDayHigh = null;
    this.prevDayLow = null;
    this.dayHigh = -Infinity;
    this.dayLow = Infinity;
    this.tradesThisDay = 0;
    this.currentWindowName = null;
    this.tradesThisWindow = 0;
    this.resetSetup();
  }

  resetSetup() {
    this.setup = {
      phase: 'IDLE', // IDLE → SWEEP → STRUCTURE_SHIFT → FVG_READY
      direction: null,
      sweepTimestamp: null,
      sweepLevel: null,
      sweepPrice: null,
      sweepGlobalIdx: null,
      mssLevel: null,
      mssTimestamp: null,
      displacementHigh: null,
      displacementLow: null,
      fvgs: [],           // FVGs tracked by timestamp
      lastFVGScanTs: 0,   // Avoid rescanning same candles
    };
  }

  /**
   * Main entry: evaluate on each candle close
   */
  evaluateSignal(candle, prevCandle, marketData = {}, options = {}) {
    const ts = this.toMs(candle.timestamp);
    this.globalCounter++;

    // Add candle to rolling buffer
    this.candles.push(candle);
    if (this.candles.length > this.params.candleBuffer) {
      this.candles = this.candles.slice(-this.params.candleBuffer);
    }

    // Update daily levels
    this.updateDailyLevels(candle, ts);

    // Need enough candles for swing detection
    const minCandles = this.params.swingLookback * 2 + 3;
    if (this.candles.length < minCandles) return null;

    // Cooldown check
    if (!this.checkCooldown(ts, this.params.signalCooldownMs)) return null;

    // Daily trade limit
    if (this.tradesThisDay >= this.params.maxTradesPerDay) return null;

    // --- Layer 1: Continuous structure tracking ---
    this.trackStructure(candle, ts);

    // --- Layer 2: Entry window filter ---
    // The setup can form at any time, but entry must occur during a SB window
    // OR within a short period after the setup completes (to handle setups
    // that form just before/during the window)
    const window = this.getActiveWindow(ts);

    // Track window transitions for per-window trade limit
    if (window) {
      if (window.name !== this.currentWindowName) {
        this.currentWindowName = window.name;
        this.tradesThisWindow = 0;
      }
      if (this.tradesThisWindow >= this.params.maxTradesPerWindow) return null;
    }

    // Check if we have a ready setup
    if (this.setup.phase !== 'FVG_READY') return null;

    // Entry only during Silver Bullet windows
    if (!window) return null;

    // Check for FVG fill (price retracing into an unfilled FVG)
    const signal = this.checkFVGEntry(candle, ts);
    if (signal) {
      this.updateLastSignalTime(ts);
      this.tradesThisDay++;
      this.tradesThisWindow++;
      this.resetSetup();
      return signal;
    }

    return null;
  }

  // ── Daily Level Management ──────────────────────────────────────

  updateDailyLevels(candle, ts) {
    // Detect new trading day (using 18:00 ET as session boundary)
    const etHour = this.getETHour(ts);
    const date = new Date(ts);
    const etDateStr = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });

    // After 6pm ET, we're in the next trading day
    const dayKey = etHour >= 18
      ? this.getNextETDate(date)
      : etDateStr;

    if (dayKey !== this.currentDay) {
      if (this.currentDay !== null) {
        this.prevDayHigh = this.dayHigh;
        this.prevDayLow = this.dayLow;
      }
      this.currentDay = dayKey;
      this.dailyOpen = candle.open;
      this.dayHigh = candle.high;
      this.dayLow = candle.low;
      this.tradesThisDay = 0;
      this.resetSetup();
    } else {
      if (candle.high > this.dayHigh) this.dayHigh = candle.high;
      if (candle.low < this.dayLow) this.dayLow = candle.low;
    }
  }

  getETHour(ts) {
    const d = new Date(ts);
    const str = d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', minute: 'numeric', hour12: false
    });
    const [h, m] = str.split(':').map(Number);
    return h + m / 60;
  }

  getNextETDate(date) {
    const next = new Date(date.getTime() + 24 * 60 * 60 * 1000);
    return next.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
  }

  // ── Silver Bullet Window Check ──────────────────────────────────

  getActiveWindow(ts) {
    const etHour = this.getETHour(ts);

    for (const w of this.params.windows) {
      if (!this.params.activeWindows.includes(w.name)) continue;
      const start = w.startHour + w.startMin / 60;
      const end = w.endHour + w.endMin / 60;
      if (etHour >= start && etHour < end) return w;
    }
    return null;
  }

  // ── Layer 1: Continuous Structure Tracking ──────────────────────

  trackStructure(candle, ts) {
    const buf = this.candles;

    // Always check for new liquidity sweeps if we have PDH/PDL
    if (this.setup.phase === 'IDLE' && this.prevDayHigh !== null && this.prevDayLow !== null) {
      this.detectSweep(candle, ts);
    }

    // After sweep, look for structure shift
    if (this.setup.phase === 'SWEEP') {
      this.detectStructureShift(candle, ts);
    }

    // After structure shift, scan for FVGs in the displacement move
    if (this.setup.phase === 'STRUCTURE_SHIFT') {
      // Keep updating displacement extremes while displacement continues
      this.updateDisplacementExtremes();
      this.scanFVGs(ts);
      if (this.setup.fvgs.length > 0) {
        // Freeze displacement extremes — from here we wait for retrace
        this.setup.phase = 'FVG_READY';
      }
    }

    // If FVG_READY, only expire old FVGs (don't scan for new ones —
    // only displacement FVGs matter, and those were captured at STRUCTURE_SHIFT)
    if (this.setup.phase === 'FVG_READY') {
      // Expire FVGs older than maxFVGAge candles (using global counter)
      this.setup.fvgs = this.setup.fvgs.filter(
        fvg => (this.globalCounter - fvg.globalIdx) <= this.params.maxFVGAge
      );
      if (this.setup.fvgs.length === 0) {
        this.resetSetup();
      }
    }
  }

  // ── Swing Detection ─────────────────────────────────────────────

  /**
   * Find swing highs and lows in the buffer.
   * Returns swings with buffer indices and timestamps.
   * Note: swings at positions < lookback or > buf.length - lookback cannot be confirmed.
   */
  identifySwings() {
    const buf = this.candles;
    const lb = this.params.swingLookback;
    const highs = [];
    const lows = [];

    if (buf.length < lb * 2 + 1) return { highs, lows };

    for (let i = lb; i < buf.length - lb; i++) {
      let isHigh = true;
      let isLow = true;

      for (let j = 1; j <= lb; j++) {
        if (buf[i - j].high >= buf[i].high || buf[i + j].high >= buf[i].high) isHigh = false;
        if (buf[i - j].low <= buf[i].low || buf[i + j].low <= buf[i].low) isLow = false;
        if (!isHigh && !isLow) break;
      }

      if (isHigh) highs.push({ bufIdx: i, price: buf[i].high, timestamp: buf[i].timestamp });
      if (isLow) lows.push({ bufIdx: i, price: buf[i].low, timestamp: buf[i].timestamp });
    }

    return { highs, lows };
  }

  // ── Liquidity Sweep Detection ───────────────────────────────────

  detectSweep(candle, ts) {
    const pdh = this.prevDayHigh;
    const pdl = this.prevDayLow;
    const minWick = this.params.sweepMinWick;

    // Bearish sweep: wick above PDH, close below → short setup
    if (candle.high >= pdh + minWick) {
      const closeInside = this.params.sweepRequireClose ? candle.close < pdh : true;
      if (closeInside) {
        this.setup.phase = 'SWEEP';
        this.setup.direction = 'bearish';
        this.setup.sweepTimestamp = ts;
        this.setup.sweepLevel = pdh;
        this.setup.sweepPrice = candle.high;
        this.setup.sweepGlobalIdx = this.globalCounter;
        if (this.params.debug) {
          console.log(`  [SB] SWEEP HIGH @ ${candle.high.toFixed(2)} > PDH ${pdh.toFixed(2)} | ${new Date(ts).toISOString()}`);
        }
        return;
      }
    }

    // Bullish sweep: wick below PDL, close above → long setup
    if (candle.low <= pdl - minWick) {
      const closeInside = this.params.sweepRequireClose ? candle.close > pdl : true;
      if (closeInside) {
        this.setup.phase = 'SWEEP';
        this.setup.direction = 'bullish';
        this.setup.sweepTimestamp = ts;
        this.setup.sweepLevel = pdl;
        this.setup.sweepPrice = candle.low;
        this.setup.sweepGlobalIdx = this.globalCounter;
        if (this.params.debug) {
          console.log(`  [SB] SWEEP LOW @ ${candle.low.toFixed(2)} < PDL ${pdl.toFixed(2)} | ${new Date(ts).toISOString()}`);
        }
        return;
      }
    }
  }

  // ── Structure Shift Detection ───────────────────────────────────

  /**
   * After a sweep, look for a candle that closes beyond a recent swing point.
   * This confirms the reversal (combines CHoCH + MSS).
   *
   * For bullish (PDL sweep): current candle closes above a recent swing high
   * For bearish (PDH sweep): current candle closes below a recent swing low
   *
   * The key swing to break is one that existed AROUND the sweep time — it's
   * the structure from the old trend that gets broken by the reversal.
   */
  detectStructureShift(candle, ts) {
    const dir = this.setup.direction;
    const breakConf = this.params.breakConfirmation;
    const sweepTs = this.setup.sweepTimestamp;
    const elapsed = this.globalCounter - this.setup.sweepGlobalIdx;

    // Timeout check
    if (elapsed > this.params.structureShiftTimeout) {
      if (this.params.debug) {
        console.log(`  [SB] TIMEOUT: no structure shift within ${elapsed} bars of sweep`);
      }
      this.resetSetup();
      return;
    }

    const swings = this.identifySwings();

    if (dir === 'bullish') {
      // Look for swing highs that exist in the buffer (any confirmed swing high)
      // The most relevant are those near or before the sweep (the "old" structure to break)
      // But also include any that formed after the sweep
      const relevantHighs = swings.highs.filter(h => {
        // Include swings from up to 60 bars before sweep through present
        const sweepBufIdx = this.findBufIndexByTimestamp(sweepTs);
        return sweepBufIdx !== -1 && h.bufIdx >= Math.max(0, sweepBufIdx - 30);
      });

      // Sort by price ascending — break the nearest swing high first
      relevantHighs.sort((a, b) => a.price - b.price);

      for (const sh of relevantHighs) {
        if (candle.close > sh.price + breakConf) {
          this.setup.phase = 'STRUCTURE_SHIFT';
          this.setup.mssLevel = sh.price;
          this.setup.mssTimestamp = ts;
          // Track displacement extremes starting from sweep
          this.updateDisplacementExtremes();
          if (this.params.debug) {
            console.log(`  [SB] BULLISH STRUCTURE SHIFT: close ${candle.close.toFixed(2)} > swing high ${sh.price.toFixed(2)} | ${new Date(ts).toISOString()}`);
          }
          return;
        }
      }
    } else if (dir === 'bearish') {
      const relevantLows = swings.lows.filter(l => {
        const sweepBufIdx = this.findBufIndexByTimestamp(sweepTs);
        return sweepBufIdx !== -1 && l.bufIdx >= Math.max(0, sweepBufIdx - 30);
      });

      // Sort by price descending — break the nearest swing low first
      relevantLows.sort((a, b) => b.price - a.price);

      for (const sl of relevantLows) {
        if (candle.close < sl.price - breakConf) {
          this.setup.phase = 'STRUCTURE_SHIFT';
          this.setup.mssLevel = sl.price;
          this.setup.mssTimestamp = ts;
          this.updateDisplacementExtremes();
          if (this.params.debug) {
            console.log(`  [SB] BEARISH STRUCTURE SHIFT: close ${candle.close.toFixed(2)} < swing low ${sl.price.toFixed(2)} | ${new Date(ts).toISOString()}`);
          }
          return;
        }
      }
    }
  }

  /**
   * Find buffer index of candle closest to the given timestamp.
   */
  findBufIndexByTimestamp(targetTs) {
    const buf = this.candles;
    for (let i = buf.length - 1; i >= 0; i--) {
      const ct = this.toMs(buf[i].timestamp);
      if (ct <= targetTs) return i;
    }
    return 0;
  }

  /**
   * Calculate displacement high/low from sweep through current candle.
   */
  updateDisplacementExtremes() {
    const buf = this.candles;
    const sweepIdx = this.findBufIndexByTimestamp(this.setup.sweepTimestamp);
    let high = -Infinity;
    let low = Infinity;

    for (let i = sweepIdx; i < buf.length; i++) {
      if (buf[i].high > high) high = buf[i].high;
      if (buf[i].low < low) low = buf[i].low;
    }

    this.setup.displacementHigh = high;
    this.setup.displacementLow = low;
  }

  // ── FVG Detection ───────────────────────────────────────────────

  /**
   * Scan for Fair Value Gaps from the displacement start to current candle.
   * Uses timestamp-based dedup to avoid re-scanning old candles.
   */
  scanFVGs(currentTs) {
    const buf = this.candles;
    const dir = this.setup.direction;
    const minSize = this.params.minFVGSize;

    // Start scanning from the sweep candle position in buffer
    const sweepBufIdx = this.findBufIndexByTimestamp(this.setup.sweepTimestamp);
    const startIdx = Math.max(sweepBufIdx, 2);

    for (let i = startIdx; i < buf.length; i++) {
      if (i < 2) continue;

      const candleTs = this.toMs(buf[i].timestamp);
      // Skip if we already scanned this candle
      if (candleTs <= this.setup.lastFVGScanTs) continue;

      const c0 = buf[i - 2];
      const c1 = buf[i - 1]; // displacement candle
      const c2 = buf[i];

      if (dir === 'bullish') {
        // Bullish FVG: gap between c0.high and c2.low (price jumped up)
        const gapBottom = c0.high;
        const gapTop = c2.low;
        const gapSize = gapTop - gapBottom;

        if (gapSize >= minSize && c1.close > c1.open) {
          this.setup.fvgs.push({
            type: 'bullish',
            top: gapTop,
            bottom: gapBottom,
            midpoint: (gapTop + gapBottom) / 2,
            size: gapSize,
            globalIdx: this.globalCounter - (buf.length - 1 - i),
            timestamp: this.toMs(c2.timestamp),
            filled: false
          });
          if (this.params.debug) {
            console.log(`  [SB] BULLISH FVG: ${gapBottom.toFixed(2)} - ${gapTop.toFixed(2)} (${gapSize.toFixed(1)}pts) | ${new Date(c2.timestamp).toISOString()}`);
          }
        }
      } else if (dir === 'bearish') {
        // Bearish FVG: gap between c2.high and c0.low (price dropped)
        const gapTop = c0.low;
        const gapBottom = c2.high;
        const gapSize = gapTop - gapBottom;

        if (gapSize >= minSize && c1.close < c1.open) {
          this.setup.fvgs.push({
            type: 'bearish',
            top: gapTop,
            bottom: gapBottom,
            midpoint: (gapTop + gapBottom) / 2,
            size: gapSize,
            globalIdx: this.globalCounter - (buf.length - 1 - i),
            timestamp: this.toMs(c2.timestamp),
            filled: false
          });
          if (this.params.debug) {
            console.log(`  [SB] BEARISH FVG: ${gapBottom.toFixed(2)} - ${gapTop.toFixed(2)} (${gapSize.toFixed(1)}pts) | ${new Date(c2.timestamp).toISOString()}`);
          }
        }
      }
    }

    // Mark how far we've scanned
    if (buf.length > 0) {
      this.setup.lastFVGScanTs = this.toMs(buf[buf.length - 1].timestamp);
    }
  }

  // ── Layer 2: FVG Entry Check ────────────────────────────────────

  checkFVGEntry(candle, ts) {
    const dir = this.setup.direction;
    const fvgs = this.setup.fvgs;

    if (fvgs.length === 0) return null;

    // Direction filter
    if (dir === 'bullish' && !this.params.useLongEntries) return null;
    if (dir === 'bearish' && !this.params.useShortEntries) return null;

    // Daily open bias check
    if (this.params.useDailyOpenBias && this.dailyOpen !== null) {
      if (dir === 'bullish' && candle.close < this.dailyOpen) return null;
      if (dir === 'bearish' && candle.close > this.dailyOpen) return null;
    }

    for (const fvg of fvgs) {
      if (fvg.filled) continue;

      let entering = false;
      let entryPrice = null;

      if (dir === 'bullish' && fvg.type === 'bullish') {
        // Price retracing DOWN into bullish FVG — enter at midpoint (CE)
        // Midpoint entry = better long price + more confirmation
        if (candle.low <= fvg.midpoint && candle.high >= fvg.midpoint) {
          entering = true;
          entryPrice = fvg.midpoint;
        }
      } else if (dir === 'bearish' && fvg.type === 'bearish') {
        // Price retracing UP into bearish FVG — enter at midpoint (CE)
        // Midpoint entry = better short price + more confirmation
        if (candle.high >= fvg.midpoint && candle.low <= fvg.midpoint) {
          entering = true;
          entryPrice = fvg.midpoint;
        }
      }

      if (!entering) continue;

      // Mark FVG as filled
      fvg.filled = true;

      // Fibonacci zone filter
      if (this.params.useFibFilter) {
        const fibCheck = this.checkFibZone(entryPrice, dir);
        if (!fibCheck.inZone) {
          if (this.params.debug) {
            console.log(`  [SB] FIB FILTER blocked entry at ${entryPrice.toFixed(2)} (retracement: ${(fibCheck.retracement * 100).toFixed(1)}%)`);
          }
          continue;
        }
      }

      const signal = this.buildSignal(candle, fvg, entryPrice, dir, ts);
      if (signal) return signal;
    }

    return null;
  }

  // ── Fibonacci Zone Check ────────────────────────────────────────

  checkFibZone(entryPrice, direction) {
    const sweepPrice = this.setup.sweepPrice;

    if (!sweepPrice) return { inZone: true, retracement: 0 };

    // Displacement extremes are frozen at FVG_READY transition — use as-is
    let displacementExtreme;
    let swingRange, retracement;

    if (direction === 'bullish') {
      displacementExtreme = this.setup.displacementHigh;
      swingRange = displacementExtreme - sweepPrice;
      if (swingRange <= 0) return { inZone: true, retracement: 0 };
      retracement = (displacementExtreme - entryPrice) / swingRange;
    } else {
      displacementExtreme = this.setup.displacementLow;
      swingRange = sweepPrice - displacementExtreme;
      if (swingRange <= 0) return { inZone: true, retracement: 0 };
      retracement = (entryPrice - displacementExtreme) / swingRange;
    }

    const inZone = retracement >= this.params.fibOptimalMin && retracement <= this.params.fibOptimalMax;
    return { inZone, retracement };
  }

  // ── Signal Builder ──────────────────────────────────────────────

  buildSignal(candle, fvg, entryPrice, direction, ts) {
    const side = direction === 'bullish' ? 'buy' : 'sell';

    // Stop loss: beyond the swept level + buffer
    let stopLoss;
    if (side === 'buy') {
      const sweepExtreme = Math.min(this.setup.sweepPrice, this.setup.sweepLevel);
      stopLoss = sweepExtreme - this.params.stopBuffer;
    } else {
      const sweepExtreme = Math.max(this.setup.sweepPrice, this.setup.sweepLevel);
      stopLoss = sweepExtreme + this.params.stopBuffer;
    }

    const stopDistance = Math.abs(entryPrice - stopLoss);

    // Validate stop distance
    if (stopDistance > this.params.maxStopPoints) {
      if (this.params.debug) {
        console.log(`  [SB] SKIP: stop distance ${stopDistance.toFixed(1)} > max ${this.params.maxStopPoints}`);
      }
      return null;
    }

    if (stopDistance < 3) {
      if (this.params.debug) {
        console.log(`  [SB] SKIP: stop distance ${stopDistance.toFixed(1)} too tight`);
      }
      return null;
    }

    // Target: opposing PDH/PDL or R:R based
    let target;
    if (side === 'buy') {
      const rrTarget = entryPrice + stopDistance * this.params.defaultRR;
      const pdhTarget = this.prevDayHigh;
      if (pdhTarget && pdhTarget > entryPrice && (pdhTarget - entryPrice) >= stopDistance * 1.5) {
        target = Math.min(pdhTarget, rrTarget);
      } else {
        target = rrTarget;
      }
    } else {
      const rrTarget = entryPrice - stopDistance * this.params.defaultRR;
      const pdlTarget = this.prevDayLow;
      if (pdlTarget && pdlTarget < entryPrice && (entryPrice - pdlTarget) >= stopDistance * 1.5) {
        target = Math.max(pdlTarget, rrTarget);
      } else {
        target = rrTarget;
      }
    }

    const targetDistance = Math.abs(target - entryPrice);
    const riskReward = targetDistance / stopDistance;

    if (this.params.debug) {
      console.log(`  [SB] SIGNAL: ${side.toUpperCase()} @ ${entryPrice.toFixed(2)} | SL ${stopLoss.toFixed(2)} (${stopDistance.toFixed(1)}pts) | TP ${target.toFixed(2)} (${targetDistance.toFixed(1)}pts) | R:R ${riskReward.toFixed(2)} | ${new Date(ts).toISOString()}`);
    }

    return {
      strategy: 'ICT_SILVER_BULLET',
      side,
      action: 'place_limit',
      symbol: candle.symbol || this.params.tradingSymbol,
      price: entryPrice,
      stop_loss: stopLoss,
      take_profit: target,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      metadata: {
        signalType: direction === 'bullish' ? 'W_PATTERN' : 'M_PATTERN',
        window: this.currentWindowName,
        sweepLevel: this.setup.sweepLevel,
        sweepPrice: this.setup.sweepPrice,
        sweepDirection: direction === 'bullish' ? 'PDL_SWEEP' : 'PDH_SWEEP',
        mssLevel: this.setup.mssLevel,
        chochLevel: this.setup.mssLevel,
        fvg: {
          top: fvg.top,
          bottom: fvg.bottom,
          size: fvg.size,
          timestamp: fvg.timestamp
        },
        dailyOpen: this.dailyOpen,
        pdh: this.prevDayHigh,
        pdl: this.prevDayLow,
        riskReward,
        stopDistance,
        targetDistance,
      }
    };
  }
}

export default ICTSilverBulletStrategy;
