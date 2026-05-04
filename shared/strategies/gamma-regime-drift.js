/**
 * Gamma Regime Drift Strategy
 *
 * Trades NQ on a positive-gamma morning drift bias surfaced by clean-IV/GEX
 * correlation research (research/clean-iv-gex/, 2026-05-02).
 *
 * Core finding (post-detrending, with daily mean removed):
 *   When the GEX regime is 'positive' or 'strong_positive' AND the GEX 15-min
 *   boundary falls in a specific window of UTC hours (10, 11, 12, 15), forward
 *   15-min NQ direction shows a +5 to +8 pp hit-rate bias above the baseline.
 *
 *   Detrended mean returns per cell (vs zero-mean baseline):
 *     positive | hour 10 UTC  → +1.73 pts, hit Δ +7.19pp, t=2.80, n=513
 *     positive | hour 11 UTC  → +2.24 pts, hit Δ +8.50pp, t=3.37, n=510
 *     positive | hour 12 UTC  → +2.97 pts, hit Δ +7.66pp, t=3.37, n=514
 *     positive | hour 15 UTC  → +2.73 pts, hit Δ +5.52pp, t=2.26, n=532
 *
 *   Hours 9, 13, 14 do NOT show the bias.  Hour 16 is positive in raw data
 *   but loses significance under detrending.  Hours 17-22 in positive regime
 *   are inconsistent.
 *
 * Mechanism:
 *   In positive-gamma regimes dealers buy dips and sell rips, dampening vol;
 *   morning order flow (~6-11 AM ET) skews bullish on a structural basis
 *   (overnight gap fades, US-session opening drift).  The two together
 *   produce a small, repeatable upside bias that is masked at other hours
 *   because the gamma-stabilizing effect is symmetric in non-morning windows.
 *
 * Entry: at the OPEN of the 15-min candle whose start aligns with a GEX
 * boundary in the allowed-hours set, IF the GEX regime is in the allowed
 * regime list.
 *
 * Critical timing (mirrored from short-dte-iv.js):
 *   The signal at time T predicts the move T → T+15.  Enter at candle.open
 *   (= T price), use sameCandleFill so the simulator replays 1m bars within
 *   this candle to fill at the open.  Exiting at candle.close = T+15 misses
 *   the entire move.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle } from './strategy-utils.js';

const DEFAULT_PARAMS = {
  // Direction
  enableLong: true,
  enableShort: false,           // cross_down short signal (separate path)

  // Long entry — gamma-regime morning drift
  // Recommended config from sweep (2026-05-03): hours 11–15 UTC + strong_positive
  // regime → PF 1.58, Sharpe 1.90, MaxDD 4.35%, WR 55.3% over 273 trades.
  allowedRegimes: ['strong_positive'],
  allowedHoursUTC: [11, 12, 13, 14, 15],

  // Short entry — gamma_flip cross_down
  // When spot crosses below gamma_flip in the most recent snapshot.
  // Off by default; enable with --enable-short.
  enableCrossDown: false,

  // Optional vol-regime filters (off by default — prove base before layering)
  // When 0-DTE/7-DTE IV ratio is in the top tail, expect 60-min absolute moves
  // ~3.5x baseline (research p04).  Skipping these days avoids macro chaos.
  maxTermRatio: null,           // e.g. 1.7 to skip top decile
  minTermRatio: null,           // e.g. 1.05 to skip very-contango low-vol days

  // Trade parameters
  // Calibration: research detrended mean = +2.4 pts; raw mean = +2.5–3.5 pts.
  // Sweep result: tight stops whipsaw on NQ vol (-PF significantly).  Wide stops
  // (500 pts) effectively never trigger; trades exit at the 15-min max-hold.
  // The edge transfers cleanly to live execution at +1.7 NQ pts / trade after
  // commission.  Catastrophic stop should be added in production (e.g. 100 pts).
  targetPoints: 500,
  stopPoints: 500,
  trailingTrigger: 9999,        // 9999 effectively disables trailing
  trailingOffset: 0,
  maxHoldBars: 15,              // count is in 1-min exit bars; 15 = 15-min hold

  // Cooldown — strategy fires only at 15m boundaries anyway, but enforce
  // 1-bar minimum spacing between same-side entries.
  cooldownMs: 14 * 60 * 1000,

  // Trading symbol
  tradingSymbol: 'NQ',
  defaultQuantity: 1,

  // Debug
  debug: false,
};

export class GammaRegimeDriftStrategy extends BaseStrategy {
  constructor(params = {}) {
    // Accept both stopPoints/targetPoints (native) and stopLossPoints/takeProfitPoints
    // (CLI-mapped from iv-skew-gex convention) for ergonomics.
    // Aliases: CLI plumbs --stop-loss-points / --target-points to the iv-skew-gex
    // naming.  Map to our native names; CLI overrides default.json per-strategy block.
    if (params.stopLossPoints != null) params.stopPoints = params.stopLossPoints;
    if (params.takeProfitPoints != null) params.targetPoints = params.takeProfitPoints;
    super({ ...DEFAULT_PARAMS, ...params });
    this.ivLoader = null;             // 7-DTE IV — for term_ratio filter
    this.shortDTEIVLoader = null;     // 0-DTE IV — for term_ratio filter
    this.prevSpotVsFlip = null;       // for cross_down detection
    this.prevSnapshotTimestamp = null;
  }

  static getDataRequirements() {
    return {
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
      lt: false,
      ivSkew: false,
      shortDTEIV: false,        // optional (only when maxTermRatio is set)
      tradier: false,
    };
  }

  loadIVData(ivLoader) { this.ivLoader = ivLoader; }
  loadShortDTEIVData(loader) { this.shortDTEIVLoader = loader; }

  /**
   * Compute term_ratio = 0-DTE avg IV / 7-DTE ATM IV at the current bar.
   * Returns null if either loader is missing or the data is not present.
   */
  getTermRatio(timestamp) {
    if (!this.ivLoader || !this.shortDTEIVLoader) return null;
    const front = this.shortDTEIVLoader.getIVAtTime?.(timestamp)
                ?? this.shortDTEIVLoader.getIVPair?.(timestamp)?.curr
                ?? null;
    const back = this.ivLoader.getIVAtTime?.(timestamp);
    if (!front || !back) return null;
    const dte0 = front.dte0_avg_iv;
    const dte7 = back.iv ?? back.atm_iv;
    if (!Number.isFinite(dte0) || !Number.isFinite(dte7) || dte7 <= 0) return null;
    return dte0 / dte7;
  }

  /**
   * Update cross_down state using the latest GEX snapshot.  Returns 'cross_down'
   * iff spot just transitioned from at-or-above gamma_flip to below it within
   * a single same-day snapshot.
   */
  updateCrossState(marketData, candle) {
    const gex = marketData?.gexLevels;
    if (!gex || !Number.isFinite(gex.gamma_flip)) return null;
    const flip = gex.gamma_flip;
    const spot = candle.close;
    const sideNow = spot > flip ? 1 : -1;
    let crossSignal = null;
    if (this.prevSpotVsFlip != null) {
      // Reset previous if we crossed days
      const prevDate = this.prevSnapshotTimestamp != null
        ? new Date(this.prevSnapshotTimestamp).toISOString().substring(0, 10)
        : null;
      const currDate = new Date(this.toMs(candle.timestamp)).toISOString().substring(0, 10);
      if (prevDate === currDate) {
        if (this.prevSpotVsFlip === 1 && sideNow === -1) crossSignal = 'cross_down';
        if (this.prevSpotVsFlip === -1 && sideNow === 1) crossSignal = 'cross_up';
      }
    }
    this.prevSpotVsFlip = sideNow;
    this.prevSnapshotTimestamp = this.toMs(candle.timestamp);
    return crossSignal;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle) || !prevCandle) return null;
    if (!marketData?.gexLevels) return null;
    if (!this.checkCooldown(candle.timestamp, this.params.cooldownMs)) return null;

    const ts = this.toMs(candle.timestamp);
    const hourUTC = new Date(ts).getUTCHours();
    const minuteUTC = new Date(ts).getUTCMinutes();

    // Strategy fires ONLY at 15-min GEX boundaries (the same cadence the
    // research was calibrated on).
    if (minuteUTC % 15 !== 0) return null;

    const regime = marketData.gexLevels.regime;

    // Track cross state on every snapshot (must come before short-circuit
    // so prev is always up-to-date).
    const crossSignal = this.updateCrossState(marketData, candle);

    // ── LONG signal: gamma-regime morning drift ─────────────────────────
    let longOk = this.params.enableLong
      && this.params.allowedRegimes.includes(regime)
      && this.params.allowedHoursUTC.includes(hourUTC);

    // ── SHORT signal: cross_down event ──────────────────────────────────
    let shortOk = this.params.enableShort
      && this.params.enableCrossDown
      && crossSignal === 'cross_down';

    if (!longOk && !shortOk) return null;

    // Optional term_ratio gate
    if (this.params.maxTermRatio != null || this.params.minTermRatio != null) {
      const tr = this.getTermRatio(ts);
      if (tr != null) {
        if (this.params.maxTermRatio != null && tr > this.params.maxTermRatio) {
          if (this.params.debug) console.log(`[GRD] reject (tr=${tr.toFixed(3)} > max=${this.params.maxTermRatio})`);
          return null;
        }
        if (this.params.minTermRatio != null && tr < this.params.minTermRatio) {
          if (this.params.debug) console.log(`[GRD] reject (tr=${tr.toFixed(3)} < min=${this.params.minTermRatio})`);
          return null;
        }
      }
    }

    // Build trade signal — long takes priority if both fire same minute
    const side = longOk ? 'buy' : 'sell';

    const entryPrice = candle.open;
    const stopLoss = side === 'buy'
      ? entryPrice - this.params.stopPoints
      : entryPrice + this.params.stopPoints;
    const takeProfit = side === 'buy'
      ? entryPrice + this.params.targetPoints
      : entryPrice - this.params.targetPoints;

    this.updateLastSignalTime(candle.timestamp);

    return {
      strategy: 'GAMMA_REGIME_DRIFT',
      action: 'place_limit',
      sameCandleFill: true,
      side,
      symbol: candle.symbol || 'NQ1!',
      price: entryPrice,
      entryPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      stopLoss,
      takeProfit,
      trailing_trigger: this.params.trailingTrigger,
      trailing_offset: this.params.trailingOffset,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      metadata: {
        regime,
        hour_utc: hourUTC,
        cross_signal: crossSignal,
        gamma_flip: marketData.gexLevels.gamma_flip,
        call_wall: marketData.gexLevels.call_wall ?? marketData.gexLevels.callWall ?? null,
        put_wall: marketData.gexLevels.put_wall ?? marketData.gexLevels.putWall ?? null,
        signal_path: longOk ? 'morning_drift' : 'cross_down',
        entry_reason: longOk
          ? `${regime} regime at ${hourUTC}:00 UTC → long bias`
          : `spot crossed below gamma_flip → short`,
      },
    };
  }

  reset() {
    super.reset();
    this.prevSpotVsFlip = null;
    this.prevSnapshotTimestamp = null;
  }

  getInternalState() {
    return {
      params: this.params,
      prevSpotVsFlip: this.prevSpotVsFlip,
      prevSnapshotTimestamp: this.prevSnapshotTimestamp,
      hasIvLoader: !!this.ivLoader,
      hasShortDTEIVLoader: !!this.shortDTEIVLoader,
    };
  }
}

export default GammaRegimeDriftStrategy;
