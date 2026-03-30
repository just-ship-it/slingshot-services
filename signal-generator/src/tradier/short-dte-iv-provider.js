/**
 * Live Short-DTE IV Provider (Signal-Generator Side)
 *
 * Receives pre-computed short-DTE IV snapshots from the data-service via Redis
 * (channel: short_dte_iv.snapshot) and provides the same getIVPair() interface
 * as the backtest ShortDTEIVLoader so the ShortDTEIVStrategy can run unchanged.
 *
 * The computation happens in data-service (ShortDTEIVCalculator). This class
 * is a thin receiver/buffer.
 *
 * IMPORTANT: Multiple data sources (Schwab real-time, CBOE delayed, pre-boundary
 * timer with cached data) can publish snapshots for the same 15-minute period.
 * We deduplicate by period key, keeping only the highest-quality snapshot per
 * period — matching the backtest loader which has one record per period.
 */

import { createLogger } from '../../../shared/index.js';

const logger = createLogger('short-dte-iv-provider');

export class LiveShortDTEIVProvider {
  constructor() {
    // Map of period key -> best snapshot for that period (keeps highest quality)
    this.periodSnapshots = new Map();
    // Ordered list of period keys for sequential access
    this.periodKeys = [];
    this.maxPeriods = 8;
  }

  /**
   * Derive a period key from a snapshot's timestamp or period field.
   * Falls back to wall-clock time if neither is available.
   */
  _getPeriodKey(snapshot) {
    // Use the period field if available (set by ShortDTEIVCalculator)
    if (snapshot.period) return snapshot.period;

    // Fall back to deriving from timestamp
    const d = snapshot.timestamp ? new Date(snapshot.timestamp) : new Date();
    const mins = d.getUTCMinutes();
    const periodMin = Math.floor(mins / 15) * 15;
    return `${d.toISOString().slice(0, 11)}${String(d.getUTCHours()).padStart(2, '0')}:${String(periodMin).padStart(2, '0')}`;
  }

  /**
   * Receive a snapshot from Redis (published by data-service).
   * Called by multi-strategy engine's channel subscription handler.
   *
   * Deduplicates by period key: if a snapshot for this period already exists,
   * only replaces it if the new one has higher quality.
   *
   * @param {Object} snapshot - IV snapshot with dte0_avg_iv, dte0_skew, etc.
   */
  receiveSnapshot(snapshot) {
    if (!snapshot) return;

    const periodKey = this._getPeriodKey(snapshot);
    const existing = this.periodSnapshots.get(periodKey);

    if (existing && (snapshot.quality || 0) <= (existing.quality || 0)) {
      logger.debug(`Ignoring lower/equal quality snapshot for period ${periodKey} (new Q=${snapshot.quality}, existing Q=${existing.quality})`);
      return;
    }

    const isNew = !existing;
    this.periodSnapshots.set(periodKey, snapshot);

    if (isNew) {
      this.periodKeys.push(periodKey);

      // Evict oldest periods
      while (this.periodKeys.length > this.maxPeriods) {
        const oldKey = this.periodKeys.shift();
        this.periodSnapshots.delete(oldKey);
      }
    }

    const d0 = snapshot.dte0_avg_iv != null ? `0DTE=${(snapshot.dte0_avg_iv * 100).toFixed(1)}%` : '0DTE=n/a';
    const d1 = snapshot.dte1_avg_iv != null ? `1DTE=${(snapshot.dte1_avg_iv * 100).toFixed(1)}%` : '1DTE=n/a';
    logger.info(`${isNew ? 'Stored' : 'Upgraded'} short-DTE IV snapshot [${periodKey}]: ${d0} | ${d1} | Q=${snapshot.quality} (${this.periodKeys.length} periods buffered)`);
  }

  /**
   * Get the previous and current IV snapshots (same interface as backtest loader).
   * Returns snapshots from two consecutive 15-minute periods, matching the
   * backtest behavior where each record is a unique period.
   *
   * Returns null if fewer than 2 periods are available.
   *
   * @param {number} timestamp - Candle timestamp (unused in live mode)
   * @returns {{ prev: Object, curr: Object } | null}
   */
  getIVPair(timestamp) {
    if (this.periodKeys.length < 2) {
      return null;
    }

    const currKey = this.periodKeys[this.periodKeys.length - 1];
    const prevKey = this.periodKeys[this.periodKeys.length - 2];

    const curr = this.periodSnapshots.get(currKey);
    const prev = this.periodSnapshots.get(prevKey);

    if (!curr || !prev) return null;

    return { prev, curr };
  }

  /**
   * Check if we have enough data to start trading.
   */
  isReady() {
    return this.periodKeys.length >= 2;
  }

  /**
   * Get current status for health/monitoring.
   */
  getStatus() {
    const latestKey = this.periodKeys.length > 0 ? this.periodKeys[this.periodKeys.length - 1] : null;
    const latest = latestKey ? this.periodSnapshots.get(latestKey) : null;
    return {
      periods: this.periodKeys.length,
      ready: this.isReady(),
      periodKeys: [...this.periodKeys],
      latest: latest ? {
        period: latestKey,
        dte0_avg_iv: latest.dte0_avg_iv,
        dte1_avg_iv: latest.dte1_avg_iv,
        quality: latest.quality,
        timestamp: latest.timestamp,
      } : null,
    };
  }
}

export default LiveShortDTEIVProvider;
