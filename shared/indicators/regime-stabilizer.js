/**
 * RegimeStabilizer
 *
 * Prevents regime flapping using multi-tier confirmation:
 * - Hysteresis: Different confidence thresholds for change vs maintain
 * - Minimum duration: Can't change regimes faster than N candles
 * - Historical consensus: Majority vote over sliding window
 * - Transition detection: Flags "uncertain" periods
 */

export class RegimeStabilizer {
  constructor(params = {}) {
    this.params = {
      minRegimeDuration: params.minRegimeDuration || 2,              // Min candles before regime change (6 min on 3m)
      changeConfidenceThreshold: params.changeConfidenceThreshold || 0.55,  // Lower bar for regime transitions
      maintainConfidenceThreshold: params.maintainConfidenceThreshold || 0.4, // Lower bar to maintain
      consensusWindowSize: params.consensusWindowSize || 8,          // Historical consensus window (24 min on 3m)
      consensusThreshold: params.consensusThreshold || 0.4,          // 40% agreement required
      ...params
    };

    // State tracking
    this.currentRegime = null;
    this.regimeSince = 0;
    this.candleCount = 0;
    this.regimeHistory = []; // Rolling window of regime classifications
  }

  /**
   * Stabilize regime using multi-tier confirmation
   *
   * @param {Object} rawRegime - Raw regime from RegimeIdentifier
   * @param {Object} currentCandle - Current candle being processed
   * @returns {Object} Stabilized regime with transition state
   */
  stabilizeRegime(rawRegime, currentCandle) {
    this.candleCount++;

    // First regime - initialize
    if (this.currentRegime === null) {
      this.currentRegime = rawRegime.regime;
      this.regimeSince = this.candleCount;
      this.regimeHistory.push(rawRegime.regime);

      return {
        regime: rawRegime.regime,
        confidence: rawRegime.confidence,
        transitionState: 'stable',
        candlesInRegime: 1,
        raw: rawRegime
      };
    }

    // Calculate duration in current regime
    const durationCandles = this.candleCount - this.regimeSince;

    // Apply hysteresis - different thresholds for change vs maintain
    const isRegimeChange = rawRegime.regime !== this.currentRegime;
    const requiredConfidence = isRegimeChange
      ? this.params.changeConfidenceThreshold
      : this.params.maintainConfidenceThreshold;

    // Check 1: Confidence threshold (hysteresis)
    if (rawRegime.confidence < requiredConfidence) {
      // Not confident enough - maintain current regime but flag uncertainty
      this.regimeHistory.push(this.currentRegime);

      return {
        regime: this.currentRegime,
        confidence: rawRegime.confidence,
        transitionState: isRegimeChange ? 'uncertain' : 'stable',
        candlesInRegime: durationCandles + 1,
        raw: rawRegime
      };
    }

    // Check 2: Minimum duration enforcement
    // Skip for session-based regimes which have fixed time boundaries
    const isFromSessionRegimeForDuration = this.currentRegime === 'SESSION_OPENING' ||
                                            this.currentRegime === 'SESSION_BLOCKED';

    if (isRegimeChange && !isFromSessionRegimeForDuration &&
        durationCandles < this.params.minRegimeDuration) {
      // Too soon to change - maintain current regime
      this.regimeHistory.push(this.currentRegime);

      return {
        regime: this.currentRegime,
        confidence: rawRegime.confidence,
        transitionState: 'locked', // Locked due to minimum duration
        candlesInRegime: durationCandles + 1,
        raw: rawRegime
      };
    }

    // Check 3: Historical consensus validation
    // Skip consensus check when transitioning FROM session-based regimes
    // (SESSION_OPENING, SESSION_BLOCKED) since they have fixed time boundaries
    const isFromSessionRegime = this.currentRegime === 'SESSION_OPENING' ||
                                 this.currentRegime === 'SESSION_BLOCKED';

    if (isRegimeChange && !isFromSessionRegime) {
      const consensus = this.calculateConsensus(rawRegime.regime);

      if (consensus < this.params.consensusThreshold) {
        // Insufficient historical agreement - maintain current regime
        this.regimeHistory.push(this.currentRegime);

        return {
          regime: this.currentRegime,
          confidence: rawRegime.confidence,
          transitionState: 'uncertain', // Uncertain due to low consensus
          candlesInRegime: durationCandles + 1,
          raw: rawRegime,
          consensus: consensus
        };
      }
    }

    // All checks passed - allow regime change (or maintain if no change)
    if (isRegimeChange) {
      // Clear history when exiting session-based regimes to avoid polluting consensus
      if (isFromSessionRegime) {
        this.regimeHistory = [];
      }

      this.currentRegime = rawRegime.regime;
      this.regimeSince = this.candleCount;
    }

    this.regimeHistory.push(rawRegime.regime);

    // Trim history to window size
    if (this.regimeHistory.length > this.params.consensusWindowSize) {
      this.regimeHistory.shift();
    }

    return {
      regime: this.currentRegime,
      confidence: rawRegime.confidence,
      transitionState: isRegimeChange ? 'transition' : 'stable',
      candlesInRegime: isRegimeChange ? 1 : durationCandles + 1,
      raw: rawRegime
    };
  }

  /**
   * Calculate historical consensus for a potential new regime
   *
   * @param {string} newRegime - Proposed new regime
   * @returns {number} Consensus score (0-1)
   */
  calculateConsensus(newRegime) {
    if (this.regimeHistory.length === 0) return 1.0;

    const windowSize = Math.min(
      this.regimeHistory.length,
      this.params.consensusWindowSize
    );

    const recentHistory = this.regimeHistory.slice(-windowSize);
    const agreementCount = recentHistory.filter(r => r === newRegime).length;

    return agreementCount / recentHistory.length;
  }

  /**
   * Reset stabilizer state (e.g., at session boundaries)
   */
  reset() {
    this.currentRegime = null;
    this.regimeSince = 0;
    this.candleCount = 0;
    this.regimeHistory = [];
  }

  /**
   * Get current regime statistics
   */
  getStats() {
    return {
      currentRegime: this.currentRegime,
      candlesInRegime: this.candleCount - this.regimeSince,
      totalCandles: this.candleCount,
      historyLength: this.regimeHistory.length
    };
  }
}
