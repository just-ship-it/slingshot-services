/**
 * Live Short-DTE IV Provider (Signal-Generator Side)
 *
 * Receives pre-computed short-DTE IV snapshots from the data-service via Redis
 * (channel: short_dte_iv.snapshot) and provides the same getIVPair() interface
 * as the backtest ShortDTEIVLoader so the ShortDTEIVStrategy can run unchanged.
 *
 * The computation happens in data-service (ShortDTEIVCalculator). This class
 * is a thin receiver/buffer.
 */

import { createLogger } from '../../../shared/index.js';

const logger = createLogger('short-dte-iv-provider');

export class LiveShortDTEIVProvider {
  constructor() {
    // Ring buffer of 15-min snapshots (keep last 4)
    this.snapshots = [];
    this.maxSnapshots = 4;
  }

  /**
   * Receive a snapshot from Redis (published by data-service).
   * Called by multi-strategy engine's channel subscription handler.
   *
   * @param {Object} snapshot - IV snapshot with dte0_avg_iv, dte0_skew, etc.
   */
  receiveSnapshot(snapshot) {
    if (!snapshot) return;

    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }

    const d0 = snapshot.dte0_avg_iv != null ? `0DTE=${(snapshot.dte0_avg_iv * 100).toFixed(1)}%` : '0DTE=n/a';
    const d1 = snapshot.dte1_avg_iv != null ? `1DTE=${(snapshot.dte1_avg_iv * 100).toFixed(1)}%` : '1DTE=n/a';
    logger.info(`Received short-DTE IV snapshot: ${d0} | ${d1} | Q=${snapshot.quality} (${this.snapshots.length} buffered)`);
  }

  /**
   * Get the previous and current IV snapshots (same interface as backtest loader).
   * Returns null if fewer than 2 snapshots are available.
   *
   * @param {number} timestamp - Candle timestamp (unused in live mode)
   * @returns {{ prev: Object, curr: Object } | null}
   */
  getIVPair(timestamp) {
    if (this.snapshots.length < 2) {
      return null;
    }
    const curr = this.snapshots[this.snapshots.length - 1];
    const prev = this.snapshots[this.snapshots.length - 2];
    return { prev, curr };
  }

  /**
   * Check if we have enough data to start trading.
   */
  isReady() {
    return this.snapshots.length >= 2;
  }

  /**
   * Get current status for health/monitoring.
   */
  getStatus() {
    const latest = this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
    return {
      snapshots: this.snapshots.length,
      ready: this.isReady(),
      latest: latest ? {
        dte0_avg_iv: latest.dte0_avg_iv,
        dte1_avg_iv: latest.dte1_avg_iv,
        quality: latest.quality,
        timestamp: latest.timestamp,
      } : null,
    };
  }
}

export default LiveShortDTEIVProvider;
