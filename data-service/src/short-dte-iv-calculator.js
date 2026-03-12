/**
 * Short-DTE IV Calculator (Data-Service Side)
 *
 * Computes 0-DTE and 1-DTE implied volatility from live QQQ options chain data
 * and publishes snapshots to Redis every 15 minutes for consumption by the
 * short-dte-iv strategy in the signal-generator.
 *
 * Called by OptionsExposureService.calculateExposures() on every chain refresh
 * (~2 minutes). Only publishes a new snapshot when the 15-minute period changes.
 *
 * Redis channel: short_dte_iv.snapshot
 */

import { createLogger, messageBus, CHANNELS } from '../../shared/index.js';

const logger = createLogger('short-dte-iv-calculator');

const BS_RISK_FREE_RATE = 0.05;

// ── Black-Scholes helpers ────────────────────────────────────────────

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function bsPrice(S, K, T, r, sigma, type) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return type === 'C'
    ? S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2)
    : K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
}

function bsVega(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * normalPDF(d1);
}

function calcIV(price, S, K, T, r, type) {
  if (price <= 0 || T <= 0) return null;
  const intrinsic = type === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (price < intrinsic * 0.99) return null;

  // Newton-Raphson
  let iv = 0.30;
  for (let i = 0; i < 100; i++) {
    const p = bsPrice(S, K, T, r, iv, type);
    const v = bsVega(S, K, T, r, iv);
    if (v < 0.0001) break;
    const diff = p - price;
    if (Math.abs(diff) < 0.0001) return iv;
    iv -= diff / v;
    if (iv <= 0.001) iv = 0.001;
    if (iv > 5.0) iv = 5.0;
  }

  // Bisection fallback
  let lo = 0.001, hi = 3.0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(S, K, T, r, mid, type);
    if (Math.abs(p - price) < 0.0001) return mid;
    if (p > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// ── Calculator ───────────────────────────────────────────────────────

export class ShortDTEIVCalculator {
  constructor() {
    this.lastSnapshotPeriod = null;
    this.latestSnapshot = null;

    // Cached data for pre-boundary recalculation
    this.cachedSpotPrice = null;
    this.cachedChainsData = null;

    // Pre-boundary timer
    this.preBoundaryTimer = null;
    this.PRE_BOUNDARY_OFFSET_SEC = 10; // Fire 10 seconds before boundary
  }

  /**
   * Get the 15-minute period key for current time.
   * When within PRE_BOUNDARY_OFFSET_SEC of the next boundary, returns
   * the upcoming period key so the snapshot publishes early.
   */
  _getPeriodKey() {
    const d = new Date();
    // Shift forward by the offset so we transition early
    const shifted = new Date(d.getTime() + this.PRE_BOUNDARY_OFFSET_SEC * 1000);
    const mins = shifted.getUTCMinutes();
    const periodMin = Math.floor(mins / 15) * 15;
    return `${shifted.toISOString().slice(0, 11)}${String(shifted.getUTCHours()).padStart(2, '0')}:${String(periodMin).padStart(2, '0')}`;
  }

  /**
   * Start a recurring timer that fires ~10 seconds before each 15-minute
   * boundary and forces an IV recalculation from cached chain data.
   * This ensures the snapshot is available before the candle.close event.
   */
  startPreBoundaryTimer() {
    if (this.preBoundaryTimer) return;

    const scheduleNext = () => {
      const now = Date.now();
      const d = new Date(now);
      const mins = d.getUTCMinutes();
      const secs = d.getUTCSeconds();
      const ms = d.getUTCMilliseconds();

      // Seconds into current 15-minute period
      const secsIntoPeriod = (mins % 15) * 60 + secs;
      // Seconds until next boundary
      const secsUntilBoundary = 15 * 60 - secsIntoPeriod;
      // Fire PRE_BOUNDARY_OFFSET_SEC before that
      let delayMs = (secsUntilBoundary - this.PRE_BOUNDARY_OFFSET_SEC) * 1000 - ms;
      // If we already passed the pre-fire window, schedule for next period
      if (delayMs < 500) delayMs += 15 * 60 * 1000;

      this.preBoundaryTimer = setTimeout(async () => {
        this.preBoundaryTimer = null;
        if (this.cachedSpotPrice && this.cachedChainsData) {
          logger.info('Pre-boundary IV computation triggered');
          await this.update(this.cachedSpotPrice, this.cachedChainsData);
        }
        scheduleNext();
      }, delayMs);
    };

    scheduleNext();
    logger.info(`Pre-boundary timer started (${this.PRE_BOUNDARY_OFFSET_SEC}s before each 15m mark)`);
  }

  /**
   * Stop the pre-boundary timer.
   */
  stopPreBoundaryTimer() {
    if (this.preBoundaryTimer) {
      clearTimeout(this.preBoundaryTimer);
      this.preBoundaryTimer = null;
    }
  }

  /**
   * Calculate DTE for an expiration date string (YYYY-MM-DD).
   * Uses calendar-day comparison in ET timezone so that today's
   * expiration is always DTE 0 regardless of time of day.
   */
  _calcDTE(expirationDate) {
    // Get today's date in ET (YYYY-MM-DD)
    const nowET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    // Calendar day difference
    const expMs = new Date(expirationDate + 'T12:00:00Z').getTime();
    const todayMs = new Date(nowET + 'T12:00:00Z').getTime();
    return Math.max(0, Math.round((expMs - todayMs) / (1000 * 60 * 60 * 24)));
  }

  /**
   * Called by OptionsExposureService on every calculation cycle (~2 min).
   * Computes short-DTE IV from QQQ chains and publishes to Redis at
   * 15-minute boundaries.
   *
   * @param {number} spotPrice - QQQ spot price
   * @param {Object} chainsData - Full options chain data from Tradier/Schwab
   */
  async update(spotPrice, chainsData) {
    if (!spotPrice || !chainsData) return;

    const chains = chainsData.QQQ || chainsData.qqq;
    if (!chains || chains.length === 0) return;

    // Cache for pre-boundary recalculation
    this.cachedSpotPrice = spotPrice;
    this.cachedChainsData = chainsData;

    // Only publish at 15-minute boundaries (offset by PRE_BOUNDARY_OFFSET_SEC)
    const periodKey = this._getPeriodKey();
    if (periodKey === this.lastSnapshotPeriod) return;

    // Skip 0-DTE after 3:45 PM ET (too noisy near expiry)
    const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const etDate = new Date(nowET);
    const etHour = etDate.getHours();
    const etMin = etDate.getMinutes();
    const skip0DTE = etHour > 15 || (etHour === 15 && etMin >= 45);

    // Group options by DTE bucket
    const buckets = new Map();

    for (const chain of chains) {
      if (!chain.options) continue;
      for (const opt of chain.options) {
        const dte = this._calcDTE(opt.expiration_date);
        if (dte > 2) continue;
        if (dte === 0 && skip0DTE) continue;

        const bid = opt.bid, ask = opt.ask;
        if (!bid || bid <= 0 || !ask || ask <= 0 || ask < bid) continue;

        const spread = (ask - bid) / ((bid + ask) / 2);
        if (spread > 0.50) continue;

        const mid = (bid + ask) / 2;
        const T = Math.max(dte, 0.5) / 365;

        // Only ATM: within 1% of spot
        if (Math.abs(opt.strike - spotPrice) / spotPrice > 0.01) continue;

        if (!buckets.has(dte)) buckets.set(dte, { calls: [], puts: [] });
        const bucket = buckets.get(dte);

        const entry = { strike: opt.strike, mid, T };
        if (opt.option_type === 'call') bucket.calls.push(entry);
        else if (opt.option_type === 'put') bucket.puts.push(entry);
      }
    }

    // Log what we found per DTE bucket
    for (const [dte, bucket] of buckets) {
      logger.info(`  DTE ${dte}: ${bucket.calls.length} calls, ${bucket.puts.length} puts (ATM within 1% of ${spotPrice.toFixed(2)})`);
    }
    if (buckets.size === 0) {
      logger.warn(`No 0-2 DTE options found in chains. Skip0DTE=${skip0DTE}. Chain count: ${chains.length}`);
    }

    // Compute IV per DTE bucket
    const ivByDTE = {};
    let quality = 0;

    for (const dte of [0, 1, 2]) {
      const bucket = buckets.get(dte);
      if (!bucket || bucket.calls.length === 0 || bucket.puts.length === 0) continue;

      const bestCall = bucket.calls.reduce((a, b) =>
        Math.abs(a.strike - spotPrice) < Math.abs(b.strike - spotPrice) ? a : b);
      const bestPut = bucket.puts.reduce((a, b) =>
        Math.abs(a.strike - spotPrice) < Math.abs(b.strike - spotPrice) ? a : b);

      const callIV = calcIV(bestCall.mid, spotPrice, bestCall.strike, bestCall.T, BS_RISK_FREE_RATE, 'C');
      const putIV = calcIV(bestPut.mid, spotPrice, bestPut.strike, bestPut.T, BS_RISK_FREE_RATE, 'P');

      if (callIV && putIV && callIV > 0.05 && callIV < 2.0 && putIV > 0.05 && putIV < 2.0) {
        ivByDTE[dte] = {
          call_iv: callIV,
          put_iv: putIV,
          avg_iv: (callIV + putIV) / 2,
          skew: putIV - callIV,
        };
        quality++;
      }
    }

    // Build snapshot
    const snapshot = {
      timestamp: new Date().toISOString(),
      period: periodKey,
      spotPrice,
      dte0_call_iv: ivByDTE[0]?.call_iv ?? null,
      dte0_put_iv: ivByDTE[0]?.put_iv ?? null,
      dte0_avg_iv: ivByDTE[0]?.avg_iv ?? null,
      dte0_skew: ivByDTE[0]?.skew ?? null,
      dte1_call_iv: ivByDTE[1]?.call_iv ?? null,
      dte1_put_iv: ivByDTE[1]?.put_iv ?? null,
      dte1_avg_iv: ivByDTE[1]?.avg_iv ?? null,
      dte1_skew: ivByDTE[1]?.skew ?? null,
      term_slope: (ivByDTE[1]?.avg_iv != null && ivByDTE[0]?.avg_iv != null)
        ? ivByDTE[1].avg_iv - ivByDTE[0].avg_iv
        : null,
      quality,
    };

    this.lastSnapshotPeriod = periodKey;
    this.latestSnapshot = snapshot;

    // Log
    const d0 = snapshot.dte0_avg_iv != null ? `0DTE=${(snapshot.dte0_avg_iv * 100).toFixed(1)}%` : '0DTE=n/a';
    const d1 = snapshot.dte1_avg_iv != null ? `1DTE=${(snapshot.dte1_avg_iv * 100).toFixed(1)}%` : '1DTE=n/a';
    logger.info(`Short-DTE IV snapshot [${periodKey}]: ${d0} | ${d1} | Q=${quality}`);

    // Publish to Redis
    try {
      await messageBus.publish(CHANNELS.SHORT_DTE_IV_SNAPSHOT, snapshot);
    } catch (error) {
      logger.warn('Failed to publish short-DTE IV snapshot:', error.message);
    }
  }

  getLatestSnapshot() {
    return this.latestSnapshot;
  }
}

export default ShortDTEIVCalculator;
