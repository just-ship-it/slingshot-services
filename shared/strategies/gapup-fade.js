/**
 * Gap-Up Fade (GUF) — the book's downside HEDGE.
 *
 * Mechanism (greenfield R8 census + B9 1s sim, 2026-07-18): a large opening
 * gap UP over-extends and reliably fades back through the morning — index gap-ups
 * exhaust while the up-drift that rescues them only kicks in later in the day.
 * SHORT the exhaustion. Census/1s: full-sample PF 1.61, locked 2025-26 PF 2.07;
 * loses ONLY in melt-up 2021 (when the long book wins), pays hardest in down/vol
 * years (2025 +$26k) — a genuine negative-correlation hedge for the long edges.
 *
 * Rule: at the 09:30 ET RTH open, gap = open − prior RTH close. If
 * gap >= gapAtrMult * ATR14(prior-day, full-session), SHORT 1 contract at the
 * open. No stop, no target. Exit at 11:00 ET (maxHoldBars minutes from 09:30).
 *
 * ATR14 convention: identical to preclose-continuation.js (Globex trade_date,
 * day_range = max(onHigh,rthHigh)−min(onLow,rthLow), mean of prior 14 full days) —
 * computed in-strategy, no external file; needs the full-session feed.
 * Prior RTH close is tracked from the stream (the last RTH bar's close). Run on
 * CONTINUOUS data (default) so the gap is roll-adjusted — a maxGapAtr sanity cap
 * guards against data glitches / any residual roll artifact.
 *
 * HONEST NOTE: standalone it fails the strict "positive every year" bar (2021
 * melt-up) — it is a HEDGE sleeve, valued by its composite contribution (adds PnL
 * for ~zero added book drawdown), not as a standalone core.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

const ONE_MIN_MS = 60 * 1000;

export class GapUpFadeStrategy extends BaseStrategy {
  static getDataRequirements() {
    return { candles: true, gex: false, lt: false, tradier: false, ivSkew: false };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      gapAtrMult: 0.50,        // short if gap >= this * ATR14 (frozen research K=0.5,
                               // PF 1.61; 0.30 is a more-inclusive tested band, 5/6yr)
      maxGapAtr: 3.0,          // skip absurd gaps (roll artifact / data glitch)
      atrPeriod: 14,
      atrMinPeriods: 10,
      rthOpenHour: 9,
      rthOpenMinute: 30,
      holdBars: 90,            // 09:30 -> 11:00 ET
      fullRthMinBars: 300,
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      seedSymbol: 'NQ',   // data-service root used by seedHistoricalData
      signalCooldownMs: 12 * 60 * 60 * 1000,
      debug: false
    };
    this.params = { ...this.defaultParams, ...params };

    this.dayRanges = [];
    this.sessTradeDate = null;
    this.priorRthClose = null;   // prior trade_date's last RTH close
    this._resetSession();
  }

  _resetSession() {
    this.onHigh = null; this.onLow = null;
    this.rthHigh = null; this.rthLow = null; this.rthClose = null;
    this.rthOpen = null; this.rthBarCount = 0;
    this.firedToday = false;
  }

  _finalizeSession() {
    if (this.rthBarCount >= this.params.fullRthMinBars &&
        this.rthHigh !== null && this.rthLow !== null) {
      const hi = this.onHigh !== null ? Math.max(this.onHigh, this.rthHigh) : this.rthHigh;
      const lo = this.onLow !== null ? Math.min(this.onLow, this.rthLow) : this.rthLow;
      this.dayRanges.push(hi - lo);
      if (this.dayRanges.length > this.params.atrPeriod) this.dayRanges.shift();
      if (this.rthClose !== null) this.priorRthClose = this.rthClose; // carry for next day's gap
    }
  }

  getETTime(timestamp) {
    const ms = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    const date = new Date(ms);
    const s = date.toLocaleString('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
    const [datePart, timePart] = s.split(', ');
    const [month, day, year] = datePart.split('/');
    let [hour, minute] = timePart.split(':');
    hour = parseInt(hour); minute = parseInt(minute);
    if (hour === 24) hour = 0;
    const cal = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    if (hour >= 18) cal.setDate(cal.getDate() + 1);
    const tdKey = `${cal.getFullYear()}-${String(cal.getMonth() + 1).padStart(2, '0')}-${String(cal.getDate()).padStart(2, '0')}`;
    return { hour, minute, hhmm: hour * 100 + minute, tradeDate: tdKey };
  }

  _atr() {
    if (this.dayRanges.length < this.params.atrMinPeriods) return null;
    return this.dayRanges.reduce((a, b) => a + b, 0) / this.dayRanges.length;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);

    if (et.tradeDate !== this.sessTradeDate) {
      if (this.sessTradeDate !== null) this._finalizeSession();
      this.sessTradeDate = et.tradeDate;
      this._resetSession();
    }

    const isRTH = et.hhmm >= 930 && et.hhmm < 1600;
    const isON = et.hhmm >= 1800 || et.hhmm < 930;

    if (isON) {
      this.onHigh = this.onHigh === null ? candle.high : Math.max(this.onHigh, candle.high);
      this.onLow = this.onLow === null ? candle.low : Math.min(this.onLow, candle.low);
    } else if (isRTH) {
      if (et.hhmm === this.params.rthOpenHour * 100 + this.params.rthOpenMinute && this.rthOpen === null) {
        this.rthOpen = candle.open;
      }
      this.rthHigh = this.rthHigh === null ? candle.high : Math.max(this.rthHigh, candle.high);
      this.rthLow = this.rthLow === null ? candle.low : Math.min(this.rthLow, candle.low);
      this.rthClose = candle.close; // last RTH bar seen = session close so far
      this.rthBarCount++;
    }

    // Decision only at the 09:30 RTH-open bar, once per day.
    if (et.hhmm !== this.params.rthOpenHour * 100 + this.params.rthOpenMinute || this.firedToday) return null;
    this.firedToday = true;

    if (this.rthOpen === null || this.priorRthClose === null) return null;
    const atr = this._atr();
    if (atr === null || atr <= 0) return null;
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    const gap = candle.open - this.priorRthClose;
    const gapAtr = gap / atr;
    if (gapAtr < this.params.gapAtrMult) return null;          // not a large gap-up
    if (gapAtr > this.params.maxGapAtr) return null;           // roll/glitch guard

    const entryPrice = candle.open;
    if (this.params.debug) {
      console.log(`[GUF] ${et.tradeDate} SHORT gap=${gap.toFixed(1)} (${gapAtr.toFixed(2)}ATR) `
        + `atr14=${atr.toFixed(1)} entry~${entryPrice.toFixed(2)} → 11:00`);
    }

    return {
      timestamp: timestamp + ONE_MIN_MS,
      side: 'sell',
      action: 'place_market',
      strategy: 'GAPUP_FADE',
      symbol: options.symbol || this.params.tradingSymbol,
      price: roundTo(entryPrice),
      quantity: options.quantity || this.params.defaultQuantity,
      stopLoss: null,
      takeProfit: null,
      maxHoldBars: this.params.holdBars,
      metadata: {
        strategy: 'GAPUP_FADE',
        direction: 'short',
        gap: roundTo(gap),
        gap_atr: roundTo(gapAtr),
        atr14_prior: roundTo(atr),
        prior_rth_close: roundTo(this.priorRthClose),
        rth_open: roundTo(entryPrice),
        trading_date: et.tradeDate
      }
    };
  }

  /**
   * Seed ATR14 (from daily candles — TV daily = full Globex session, so
   * high-low == day_range) AND priorRthClose (from the most recent completed
   * 15:00-ET hourly bar, whose close ≈ the 16:00 RTH close) so the strategy can
   * evaluate the opening gap on day one. Best-effort; on failure it builds ATR
   * from live candles and waits one live RTH session for priorRthClose.
   */
  async seedHistoricalData(dataServiceUrl) {
    const root = this.params.seedSymbol || 'NQ';
    // 1. ATR14 from daily candles
    try {
      const res = await fetch(`${dataServiceUrl}/candles/daily?symbol=${root}&count=${this.params.atrPeriod + 6}`);
      if (!res.ok) throw new Error(`daily candles HTTP ${res.status}`);
      const body = await res.json();
      const candles = Array.isArray(body?.candles) ? body.candles.slice() : [];
      if (candles.length >= this.params.atrMinPeriods + 1) {
        candles.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        const use = candles.slice(0, -1).slice(-this.params.atrPeriod);
        this.dayRanges = use.map(c => Number(c.high) - Number(c.low)).filter(r => r > 0);
      }
    } catch (err) {
      if (this.params.debug) console.log(`[GUF] ATR seed failed: ${err.message} — building from live candles`);
    }
    // 2. priorRthClose from the latest completed 15:00-ET hourly bar (~16:00 RTH close)
    try {
      const res = await fetch(`${dataServiceUrl}/candles/hourly?symbol=${root}&count=48`);
      if (res.ok) {
        const body = await res.json();
        const hc = Array.isArray(body?.candles) ? body.candles.slice() : [];
        hc.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        const cutoff = Date.now() - 60 * 60 * 1000; // bar must have closed (16:00 passed)
        let best = null;
        for (const c of hc) {
          const et = this.getETTime(c.timestamp);
          if (et.hhmm === 1500 && new Date(c.timestamp).getTime() < cutoff) best = c;
        }
        if (best) this.priorRthClose = Number(best.close);
      }
    } catch (err) {
      if (this.params.debug) console.log(`[GUF] priorRthClose seed failed: ${err.message} — waiting one live RTH session`);
    }
    if (this.params.debug) {
      const atr = this._atr();
      console.log(`[GUF] seeded: ATR14 from ${this.dayRanges.length} daily bars (atr=${atr ? atr.toFixed(1) : 'n/a'}), `
        + `priorRthClose=${this.priorRthClose ?? 'pending live session'}`);
    }
  }

  isSeeded() {
    return this.dayRanges.length >= this.params.atrMinPeriods && this.priorRthClose !== null;
  }

  reset() {
    super.reset();
    this.dayRanges = [];
    this.sessTradeDate = null;
    this.priorRthClose = null;
    this._resetSession();
  }

  getName() { return 'GAPUP_FADE'; }
  getDescription() { return 'Gap-Up Fade — short a large opening gap-up into its morning exhaustion (book hedge)'; }
  getRequiredMarketData() { return []; }
}

export default GapUpFadeStrategy;
