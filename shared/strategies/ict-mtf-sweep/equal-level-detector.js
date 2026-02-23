/**
 * Equal Level Detector
 *
 * Detects when price makes highs or lows at nearly identical levels
 * at different times. These "equal highs" and "equal lows" represent
 * engineered liquidity that institutional traders target for sweeps.
 *
 * More touches at the same level = stronger liquidity pool.
 */

export class EqualLevelDetector {
  constructor(params = {}) {
    this.tolerance = params.tolerance ?? 3;                    // Points
    this.minSeparationMs = (params.minSeparationMinutes ?? 60) * 60 * 1000;
    this.maxAgeMs = (params.maxAgeMinutes ?? 1440) * 60 * 1000;

    this.swingHighs = []; // { price, timestamp }
    this.swingLows = [];
  }

  reset() {
    this.swingHighs = [];
    this.swingLows = [];
  }

  /**
   * Add a confirmed swing point from any timeframe analyzer
   */
  addSwing(type, price, timestamp) {
    const entry = { price, timestamp };
    if (type === 'high') {
      this.swingHighs.push(entry);
    } else {
      this.swingLows.push(entry);
    }
  }

  /**
   * Get equal highs — swing highs clustered at similar prices
   * @returns {Array<{ price: number, touches: number, timestamps: number[] }>}
   */
  getEqualHighs(currentTime) {
    return this._findClusters(this.swingHighs, currentTime);
  }

  /**
   * Get equal lows — swing lows clustered at similar prices
   * @returns {Array<{ price: number, touches: number, timestamps: number[] }>}
   */
  getEqualLows(currentTime) {
    return this._findClusters(this.swingLows, currentTime);
  }

  /**
   * Cluster swings at similar price levels
   */
  _findClusters(swings, currentTime) {
    // Filter out stale swings
    const fresh = swings.filter(s => (currentTime - s.timestamp) <= this.maxAgeMs);

    const clusters = [];
    const used = new Set();

    for (let i = 0; i < fresh.length; i++) {
      if (used.has(i)) continue;

      const cluster = { price: fresh[i].price, touches: 1, timestamps: [fresh[i].timestamp] };
      let priceSum = fresh[i].price;

      for (let j = i + 1; j < fresh.length; j++) {
        if (used.has(j)) continue;

        const priceDiff = Math.abs(fresh[j].price - fresh[i].price);
        const timeDiff = Math.abs(fresh[j].timestamp - fresh[i].timestamp);

        if (priceDiff <= this.tolerance && timeDiff >= this.minSeparationMs) {
          cluster.touches++;
          cluster.timestamps.push(fresh[j].timestamp);
          priceSum += fresh[j].price;
          used.add(j);
        }
      }

      // Only return clusters with 2+ touches (that's what makes them "equal")
      if (cluster.touches >= 2) {
        cluster.price = priceSum / cluster.touches; // Average price
        clusters.push(cluster);
      }

      used.add(i);
    }

    return clusters;
  }

  /**
   * Prune old data to keep memory bounded
   */
  prune(currentTime) {
    this.swingHighs = this.swingHighs.filter(s => (currentTime - s.timestamp) <= this.maxAgeMs);
    this.swingLows = this.swingLows.filter(s => (currentTime - s.timestamp) <= this.maxAgeMs);
  }
}
