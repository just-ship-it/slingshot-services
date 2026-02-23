/**
 * Liquidity Pool Tracker
 *
 * Aggregates all liquidity sources into a unified, ranked list:
 * - PDH/PDL (Previous Day High/Low)
 * - Session highs/lows (Asia, London, NY)
 * - Equal highs/lows (from EqualLevelDetector)
 * - Swing highs/lows from each timeframe analyzer
 *
 * Detects sweeps: wick beyond level, close back inside.
 */

import { EqualLevelDetector } from './equal-level-detector.js';

// Session definitions in ET decimal hours
const SESSIONS = {
  asia:   { start: 18, end: 2 },   // 6 PM - 2 AM (crosses midnight)
  london: { start: 2,  end: 8 },   // 2 AM - 8 AM
  ny:     { start: 8,  end: 17 },   // 8 AM - 5 PM
};

export class LiquidityPoolTracker {
  constructor(params = {}) {
    this.sweepMinWick = params.sweepMinWick ?? 3;
    this.sweepRequireClose = params.sweepRequireClose ?? true;

    this.equalLevelDetector = new EqualLevelDetector({
      tolerance: params.equalLevelTolerance ?? 3,
      minSeparationMinutes: params.equalLevelSeparation ?? 60,
      maxAgeMinutes: params.equalLevelMaxAge ?? 1440,
    });

    // Daily levels
    this.currentDay = null;
    this.dailyOpen = null;
    this.pdh = null;
    this.pdl = null;
    this.dayHigh = -Infinity;
    this.dayLow = Infinity;

    // Session levels
    this.currentSession = null;
    this.sessionData = {};
    this.asiaHigh = null; this.asiaLow = null;
    this.londonHigh = null; this.londonLow = null;
    this.nyHigh = null; this.nyLow = null;

    // Swing levels from TF analyzers (updated externally)
    this.swingPools = []; // { price, type, source, direction }

    // Weekly/monthly opens
    this.currentWeekKey = null;
    this.weeklyOpen = null;
    this.currentMonthKey = null;
    this.monthlyOpen = null;

    // Previous day tracking for inside/outside bar
    this.prevDayHigh = null;
    this.prevDayLow = null;
    this.dailyBarPattern = 'normal'; // 'inside', 'outside', 'normal'

    // Daily open bias tolerance
    this.dailyOpenBiasTolerance = params.dailyOpenBiasTolerance ?? 5;
  }

  reset() {
    this.currentDay = null;
    this.dailyOpen = null;
    this.pdh = null;
    this.pdl = null;
    this.dayHigh = -Infinity;
    this.dayLow = Infinity;
    this.currentSession = null;
    this.sessionData = {};
    this.asiaHigh = null; this.asiaLow = null;
    this.londonHigh = null; this.londonLow = null;
    this.nyHigh = null; this.nyLow = null;
    this.swingPools = [];
    this.currentWeekKey = null;
    this.weeklyOpen = null;
    this.currentMonthKey = null;
    this.monthlyOpen = null;
    this.prevDayHigh = null;
    this.prevDayLow = null;
    this.dailyBarPattern = 'normal';
    this.equalLevelDetector.reset();
  }

  /**
   * Process a 1m candle to update daily and session levels
   */
  processCandle(candle) {
    const ts = typeof candle.timestamp === 'number' ? candle.timestamp : new Date(candle.timestamp).getTime();
    this._updateDailyLevels(candle, ts);
    this._updateSessionLevels(candle, ts);
    this._updateWeeklyOpen(candle, ts);
    this._updateMonthlyOpen(candle, ts);
    this.equalLevelDetector.prune(ts);
  }

  /**
   * Register swing levels from a TimeframeAnalyzer
   * Called by the main strategy when analyzers produce new swings
   */
  addSwingLevels(swings, timeframe) {
    for (const s of swings) {
      if (s.type === 'high') {
        this.swingPools.push({
          price: s.price,
          type: 'swing_high',
          source: `swing_high_${timeframe}`,
          direction: 'above', // liquidity above (shorts sweep it)
          timestamp: s.timestamp,
        });
        this.equalLevelDetector.addSwing('high', s.price, s.timestamp);
      } else {
        this.swingPools.push({
          price: s.price,
          type: 'swing_low',
          source: `swing_low_${timeframe}`,
          direction: 'below',
          timestamp: s.timestamp,
        });
        this.equalLevelDetector.addSwing('low', s.price, s.timestamp);
      }
    }

    // Keep bounded
    if (this.swingPools.length > 200) {
      this.swingPools = this.swingPools.slice(-200);
    }
  }

  /**
   * Get all active liquidity pools, ranked by strength
   * @param {number} currentPrice
   * @param {number} currentTime
   * @returns {Array<{ price, type, source, direction, strength }>}
   */
  getLiquidityPools(currentPrice, currentTime) {
    const pools = [];

    // PDH/PDL — highest priority
    if (this.pdh !== null) {
      pools.push({ price: this.pdh, type: 'PDH', source: 'daily', direction: 'above', strength: 10 });
    }
    if (this.pdl !== null) {
      pools.push({ price: this.pdl, type: 'PDL', source: 'daily', direction: 'below', strength: 10 });
    }

    // Daily open — direction flips with price
    if (this.dailyOpen !== null) {
      const doDir = currentPrice > this.dailyOpen ? 'below' : 'above';
      pools.push({ price: this.dailyOpen, type: 'daily_open', source: 'daily', direction: doDir, strength: 7 });
    }

    // Weekly open
    if (this.weeklyOpen !== null) {
      const woDir = currentPrice > this.weeklyOpen ? 'below' : 'above';
      pools.push({ price: this.weeklyOpen, type: 'weekly_open', source: 'weekly', direction: woDir, strength: 8 });
    }

    // Monthly open
    if (this.monthlyOpen !== null) {
      const moDir = currentPrice > this.monthlyOpen ? 'below' : 'above';
      pools.push({ price: this.monthlyOpen, type: 'monthly_open', source: 'monthly', direction: moDir, strength: 9 });
    }

    // Session levels
    if (this.asiaHigh !== null) pools.push({ price: this.asiaHigh, type: 'asia_high', source: 'session', direction: 'above', strength: 7 });
    if (this.asiaLow !== null) pools.push({ price: this.asiaLow, type: 'asia_low', source: 'session', direction: 'below', strength: 7 });
    if (this.londonHigh !== null) pools.push({ price: this.londonHigh, type: 'london_high', source: 'session', direction: 'above', strength: 7 });
    if (this.londonLow !== null) pools.push({ price: this.londonLow, type: 'london_low', source: 'session', direction: 'below', strength: 7 });
    if (this.nyHigh !== null) pools.push({ price: this.nyHigh, type: 'ny_high', source: 'session', direction: 'above', strength: 8 });
    if (this.nyLow !== null) pools.push({ price: this.nyLow, type: 'ny_low', source: 'session', direction: 'below', strength: 8 });

    // Equal highs/lows
    const eqHighs = this.equalLevelDetector.getEqualHighs(currentTime);
    for (const eq of eqHighs) {
      pools.push({
        price: eq.price,
        type: 'equal_high',
        source: 'equal_level',
        direction: 'above',
        strength: 6 + Math.min(eq.touches, 4), // More touches = stronger
      });
    }
    const eqLows = this.equalLevelDetector.getEqualLows(currentTime);
    for (const eq of eqLows) {
      pools.push({
        price: eq.price,
        type: 'equal_low',
        source: 'equal_level',
        direction: 'below',
        strength: 6 + Math.min(eq.touches, 4),
      });
    }

    // Swing levels from TF analyzers (recent only)
    const maxSwingAge = 24 * 60 * 60 * 1000; // 24 hours
    for (const sp of this.swingPools) {
      if (currentTime - sp.timestamp <= maxSwingAge) {
        pools.push({ ...sp, strength: 5 });
      }
    }

    // Sort by proximity to current price, then by strength
    pools.sort((a, b) => {
      const distA = Math.abs(a.price - currentPrice);
      const distB = Math.abs(b.price - currentPrice);
      // Prefer stronger pools, then closer ones
      if (b.strength !== a.strength) return b.strength - a.strength;
      return distA - distB;
    });

    return pools;
  }

  /**
   * Check if a candle swept a liquidity pool
   * Sweep = wick beyond level, close back inside
   *
   * @returns {{ swept: boolean, sweepPrice: number, direction: string }|null}
   */
  checkSweep(candle, pool) {
    const minWick = this.sweepMinWick;

    if (pool.direction === 'above') {
      // Price swept above the pool level
      if (candle.high >= pool.price + minWick) {
        const closeInside = this.sweepRequireClose ? candle.close < pool.price : true;
        if (closeInside) {
          return { swept: true, sweepPrice: candle.high, direction: 'bearish' };
        }
      }
    } else if (pool.direction === 'below') {
      // Price swept below the pool level
      if (candle.low <= pool.price - minWick) {
        const closeInside = this.sweepRequireClose ? candle.close > pool.price : true;
        if (closeInside) {
          return { swept: true, sweepPrice: candle.low, direction: 'bullish' };
        }
      }
    }

    return null;
  }

  /**
   * Find an opposing liquidity pool for targeting
   * E.g., after sweeping PDL (bullish), target PDH
   */
  getOpposingPool(sweptPool, currentPrice) {
    const oppositeDir = sweptPool.direction === 'above' ? 'below' : 'above';

    // Find closest opposing pool
    const candidates = [];

    if (oppositeDir === 'above') {
      if (this.pdh !== null && this.pdh > currentPrice) candidates.push({ price: this.pdh, type: 'PDH', strength: 10 });
      if (this.monthlyOpen !== null && this.monthlyOpen > currentPrice) candidates.push({ price: this.monthlyOpen, type: 'monthly_open', strength: 9 });
      if (this.weeklyOpen !== null && this.weeklyOpen > currentPrice) candidates.push({ price: this.weeklyOpen, type: 'weekly_open', strength: 8 });
      if (this.nyHigh !== null && this.nyHigh > currentPrice) candidates.push({ price: this.nyHigh, type: 'ny_high', strength: 8 });
      if (this.dailyOpen !== null && this.dailyOpen > currentPrice) candidates.push({ price: this.dailyOpen, type: 'daily_open', strength: 7 });
      if (this.londonHigh !== null && this.londonHigh > currentPrice) candidates.push({ price: this.londonHigh, type: 'london_high', strength: 7 });
      if (this.asiaHigh !== null && this.asiaHigh > currentPrice) candidates.push({ price: this.asiaHigh, type: 'asia_high', strength: 7 });
    } else {
      if (this.pdl !== null && this.pdl < currentPrice) candidates.push({ price: this.pdl, type: 'PDL', strength: 10 });
      if (this.monthlyOpen !== null && this.monthlyOpen < currentPrice) candidates.push({ price: this.monthlyOpen, type: 'monthly_open', strength: 9 });
      if (this.weeklyOpen !== null && this.weeklyOpen < currentPrice) candidates.push({ price: this.weeklyOpen, type: 'weekly_open', strength: 8 });
      if (this.nyLow !== null && this.nyLow < currentPrice) candidates.push({ price: this.nyLow, type: 'ny_low', strength: 8 });
      if (this.dailyOpen !== null && this.dailyOpen < currentPrice) candidates.push({ price: this.dailyOpen, type: 'daily_open', strength: 7 });
      if (this.londonLow !== null && this.londonLow < currentPrice) candidates.push({ price: this.londonLow, type: 'london_low', strength: 7 });
      if (this.asiaLow !== null && this.asiaLow < currentPrice) candidates.push({ price: this.asiaLow, type: 'asia_low', strength: 7 });
    }

    if (candidates.length === 0) return null;

    // Prefer strongest, then closest
    candidates.sort((a, b) => {
      if (b.strength !== a.strength) return b.strength - a.strength;
      return Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
    });

    return candidates[0];
  }

  // ── Daily Level Management ──────────────────────────────────

  _getETHour(ts) {
    const d = new Date(ts);
    const str = d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', minute: 'numeric', hour12: false
    });
    const [h, m] = str.split(':').map(Number);
    return h + m / 60;
  }

  _getETDateKey(ts) {
    const d = new Date(ts);
    const etHour = this._getETHour(ts);
    // After 6pm ET = next trading day
    if (etHour >= 18) {
      const next = new Date(d.getTime() + 24 * 60 * 60 * 1000);
      return next.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit'
      });
    }
    return d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
  }

  _updateDailyLevels(candle, ts) {
    const dayKey = this._getETDateKey(ts);

    if (dayKey !== this.currentDay) {
      if (this.currentDay !== null) {
        // Store previous day for inside/outside bar detection
        this.prevDayHigh = this.dayHigh;
        this.prevDayLow = this.dayLow;
        this.pdh = this.dayHigh;
        this.pdl = this.dayLow;
      }
      this.currentDay = dayKey;
      this.dailyOpen = candle.open;
      this.dayHigh = candle.high;
      this.dayLow = candle.low;
      this.dailyBarPattern = 'normal';
    } else {
      if (candle.high > this.dayHigh) this.dayHigh = candle.high;
      if (candle.low < this.dayLow) this.dayLow = candle.low;

      // Update daily bar pattern
      if (this.prevDayHigh !== null && this.prevDayLow !== null) {
        if (this.dayHigh <= this.prevDayHigh && this.dayLow >= this.prevDayLow) {
          this.dailyBarPattern = 'inside';
        } else if (this.dayHigh > this.prevDayHigh && this.dayLow < this.prevDayLow) {
          this.dailyBarPattern = 'outside';
        } else {
          this.dailyBarPattern = 'normal';
        }
      }
    }
  }

  // ── Session Level Management ────────────────────────────────

  _identifySession(ts) {
    const etHour = this._getETHour(ts);

    // Asia: 6 PM - 2 AM (crosses midnight)
    if (etHour >= 18 || etHour < 2) return 'asia';
    // London: 2 AM - 8 AM
    if (etHour >= 2 && etHour < 8) return 'london';
    // NY: 8 AM - 5 PM
    if (etHour >= 8 && etHour < 17) return 'ny';
    // Gap: 5 PM - 6 PM
    return 'gap';
  }

  /**
   * Get daily open bias: bullish if price above open, bearish if below
   */
  getDailyBias(price, tolerance) {
    if (this.dailyOpen === null) return 'neutral';
    const tol = tolerance ?? this.dailyOpenBiasTolerance;
    if (price > this.dailyOpen + tol) return 'bullish';
    if (price < this.dailyOpen - tol) return 'bearish';
    return 'neutral';
  }

  /**
   * Get current daily bar pattern relative to previous day
   */
  getDailyBarPattern() {
    return this.dailyBarPattern;
  }

  // ── Weekly/Monthly Open Tracking ──────────────────────────

  _getETWeekKey(ts) {
    const d = new Date(ts);
    const etStr = d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: 'numeric', hour12: false
    });
    // Trading week starts Sunday 6pm ET
    const etHour = this._getETHour(ts);
    const etDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dayOfWeek = etDate.getDay(); // 0=Sun
    // If Sunday >= 18:00 or Mon-Fri or Saturday < 18:00, same week
    // Week key = the Monday date of this trading week
    let mondayDate;
    if (dayOfWeek === 0 && etHour >= 18) {
      // Sunday evening = start of new week, Monday is tomorrow
      mondayDate = new Date(etDate.getTime() + 24 * 60 * 60 * 1000);
    } else if (dayOfWeek === 0) {
      // Sunday before 6pm = previous week
      mondayDate = new Date(etDate.getTime() - 6 * 24 * 60 * 60 * 1000);
    } else {
      // Mon(1) to Sat(6): Monday of this week
      mondayDate = new Date(etDate.getTime() - (dayOfWeek - 1) * 24 * 60 * 60 * 1000);
    }
    return `${mondayDate.getFullYear()}-${String(mondayDate.getMonth() + 1).padStart(2, '0')}-${String(mondayDate.getDate()).padStart(2, '0')}`;
  }

  _getETMonthKey(ts) {
    const d = new Date(ts);
    const str = d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit'
    });
    return str; // "MM/YYYY" format
  }

  _updateWeeklyOpen(candle, ts) {
    const weekKey = this._getETWeekKey(ts);
    if (weekKey !== this.currentWeekKey) {
      this.currentWeekKey = weekKey;
      this.weeklyOpen = candle.open;
    }
  }

  _updateMonthlyOpen(candle, ts) {
    const monthKey = this._getETMonthKey(ts);
    if (monthKey !== this.currentMonthKey) {
      this.currentMonthKey = monthKey;
      this.monthlyOpen = candle.open;
    }
  }

  _updateSessionLevels(candle, ts) {
    const session = this._identifySession(ts);

    if (session !== this.currentSession) {
      // Finalize previous session
      if (this.currentSession && this.sessionData.high !== undefined) {
        switch (this.currentSession) {
          case 'asia':
            this.asiaHigh = this.sessionData.high;
            this.asiaLow = this.sessionData.low;
            break;
          case 'london':
            this.londonHigh = this.sessionData.high;
            this.londonLow = this.sessionData.low;
            break;
          case 'ny':
            this.nyHigh = this.sessionData.high;
            this.nyLow = this.sessionData.low;
            break;
        }
      }

      this.currentSession = session;
      this.sessionData = { high: candle.high, low: candle.low };
    } else {
      if (candle.high > this.sessionData.high) this.sessionData.high = candle.high;
      if (candle.low < this.sessionData.low) this.sessionData.low = candle.low;
    }
  }
}
