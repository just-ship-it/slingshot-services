/**
 * GEX-Touch Patterns Strategy (gex-touch-patterns)
 *
 * Framework: each GEX touch (within 10 pt of any S1-S5/R1-R5/gamma_flip/
 * call_wall/put_wall) opens a 30-min "monitoring window". Within the window
 * we look for one of 7 pattern triggers:
 *   R1 — Bounce + higher-low → break of swing-high (LONG, support touch)
 *   R2 — Bounce + lower-high → break of swing-low (SHORT, resistance touch)
 *   R3 — Pin-bar rejection + confirmation bar (either direction)
 *   A1 — Accept + retest hold (LONG break of resistance)
 *   A2 — Accept + retest hold (SHORT break of support)
 *   F1 — Fake-out recovery (LONG, support wicked but closed back above)
 *   F2 — Fake-out recovery (SHORT, resistance wicked but closed back below)
 *
 * A "rulebook" maps (pattern, level_type) cells to target sizes. Default is
 * `best_v2`: per-cell optimal targets calibrated against 17,966 touches /
 * 7,309 triggers on the 2025-01-13 → 2026-04-23 1s-honest dataset (see
 * research/gex-touch-patterns/RESULTS.md).
 *
 * The strategy emits MARKET orders at the trigger bar's close. Stops are
 * derived from the pattern's natural structural reference + buffer.
 *
 * Live data requirements:
 *   • 1m OHLCV (primary)
 *   • GEX snapshots (16-min lag default, matches research)
 *
 * NOTE on max_hold: research uses 4hr max-hold to capture moves up to 150pt.
 * Live should match — set maxHoldBars = 240.
 */

import { BaseStrategy } from './base-strategy.js';

// Rulebook: each row is (pattern, levelType OR null=all, target). First match wins.
// best_v2 — see research/gex-touch-patterns/05-rulebook-sim.js.
// Rulebook pruning notes (engine v3 → v4):
//   • R3 (pin+confirm) removed entirely: 741 trades / -$25k. R3 fires on bar
//     T+1 before other patterns can develop, winning the temporal race on most
//     touches. Slippage drag destroys the small-target edge.
//   • A2×S4 @ 100 removed: 8% WR / -$4,570 in engine vs research 23% WR. Sample
//     size collapses with concurrency and the few accepted trades hit a bad streak.
//   • R2×R5 @ 60 removed: 13% WR / -$3,220 in engine. Same overfit risk.
//   • R1×put_wall/S1 @ 40 removed: -$1,299 in engine. Marginal in research too.
//   • A2×S3 @ 40 removed: -$1,121 in engine.
//   • A1×call_wall/R1 @ 50 removed: -$770 in engine.
//   • A2×S2 @ 30 removed: -$667 in engine.
//   • R1×S3 @ 20 removed: -$455 in engine despite 64.5% research WR.
//
// Remaining cells are those that produced positive engine PnL in v3:
//   R1×S4 @ 80, A2×S5 @ 100, R2×R4 @ 40, R2×call_wall/R1 @ 150,
//   R2×gamma_flip @ 100, R1×S2 @ 20, A1×gamma_flip @ 40, A2×gamma_flip @ 50,
//   A1×R2 @ 30. Ordered by engine $/trade.
// DEFAULT_RULEBOOK — engine-verified pruned cells (v4), $25k/16mo on 1 ctr.
// To switch variants, override `params.rulebook` at construction.
const RULEBOOK_BIG_TARGETS = [
  // Big-target only (T ≥ 80). Fewer cells → less concurrency loss → big targets get room.
  { pattern: 'R2', levels: ['call_wall', 'R1'], target: 150 },
  { pattern: 'R2', levels: ['gamma_flip'], target: 100 },
  { pattern: 'A2', levels: ['S5'], target: 100 },
  { pattern: 'R1', levels: ['S4'], target: 80 },
];

// Calibrated against 60-min trigger window dataset (Phase 4 stretch analysis).
// 60-min window dramatically lifts A1/A2 acceptance patterns (need K=3 closes
// + retest, takes ~10-15 min to develop). Top per-cell winners:
//   A1×R2 @ 30: 217 trades, 59% WR, PF 3.15, $241/trade ⭐
//   R2×call_wall @ 150: 156 trades, 23% WR, PF 2.54, $397/trade ⭐
//   A2×gamma_flip @ 60: 250 trades, 34% WR, PF 2.00, $197/trade
//   A1×gamma_flip @ 40: 271 trades, 42% WR, PF 2.22, $180/trade
const RULEBOOK_W60 = [
  // Highest-EV per-cell ordered first (priority)
  { pattern: 'A1', levels: ['R2'], target: 30 },                  // 59% WR, $241/tr ⭐
  { pattern: 'R2', levels: ['call_wall', 'R1'], target: 150 },    // 23% WR, $397/tr
  { pattern: 'A2', levels: ['gamma_flip'], target: 60 },          // 34% WR, $197/tr
  { pattern: 'A1', levels: ['gamma_flip'], target: 40 },          // 42% WR, $180/tr
  { pattern: 'A2', levels: ['S3'], target: 40 },                  // 46% WR, $177/tr
  { pattern: 'R2', levels: ['gamma_flip'], target: 100 },         // 23% WR, $155/tr
  { pattern: 'A2', levels: ['S5'], target: 80 },                  // 27% WR, $149/tr
  { pattern: 'R1', levels: ['S2'], target: 20 },                  // 65% WR, $134/tr
  { pattern: 'R1', levels: ['S3'], target: 20 },                  // 63% WR, $134/tr
  { pattern: 'A2', levels: ['S4'], target: 100 },                 // 19% WR, $128/tr
  { pattern: 'R1', levels: ['put_wall', 'S1'], target: 40 },      // 44% WR, $122/tr
  { pattern: 'R2', levels: ['R4'], target: 40 },                  // 43% WR, $120/tr
  { pattern: 'R1', levels: ['S4'], target: 80 },                  // 25% WR, $117/tr
  { pattern: 'A2', levels: ['S2'], target: 20 },                  // 61% WR, $91/tr
];

const DEFAULT_RULEBOOK = [
  // Highest engine $/trade first — these win the priority race when multiple
  // cells could match a single touch. Calibrated against engine v4 backtest.
  { pattern: 'R1', levels: ['S4'], target: 80 },                  // +$7,094 (29 tr, 35% WR)
  { pattern: 'A2', levels: ['S5'], target: 100 },                 // +$4,916 (23 tr, 25% WR)
  { pattern: 'R2', levels: ['R4'], target: 40 },                  // +$2,479 (20 tr, 47% WR)
  { pattern: 'R2', levels: ['call_wall', 'R1'], target: 150 },    // +$2,410 (28 tr, 12% WR)
  { pattern: 'R2', levels: ['gamma_flip'], target: 100 },         // +$2,335 (24 tr, 12.5% WR)
  { pattern: 'A1', levels: ['gamma_flip'], target: 40 },          // +$1,512 (35 tr, 35.5% WR)
  { pattern: 'R1', levels: ['S2'], target: 20 },                  // +$1,015 (37 tr, 55.6% WR)
  { pattern: 'A1', levels: ['R2'], target: 30 },                  // +$430 (16 tr, 37.5% WR)
];

export const RULEBOOKS = {
  DEFAULT: DEFAULT_RULEBOOK,
  BIG_TARGETS: RULEBOOK_BIG_TARGETS,
  W60: RULEBOOK_W60,
};

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

function isSwingLow(bars1m, idx) {
  if (idx < 2) return false;
  const a = bars1m[idx - 2], b = bars1m[idx - 1], c = bars1m[idx];
  return b.low < a.low && b.low < c.low;
}
function isSwingHigh(bars1m, idx) {
  if (idx < 2) return false;
  const a = bars1m[idx - 2], b = bars1m[idx - 1], c = bars1m[idx];
  return b.high > a.high && b.high > c.high;
}
function levelIsSupportFor(levelType, approach) {
  if (levelType === 'gamma_flip') return approach === 'from_above';
  return SUPPORT_TYPES.has(levelType);
}
function levelIsResistanceFor(levelType, approach) {
  if (levelType === 'gamma_flip') return approach === 'from_below';
  return RESIST_TYPES.has(levelType);
}

export class GexTouchPatternsStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
      lt: false, lt1m: false, tradier: false, ivSkew: false, s1Vwap: false,
    };
  }

  constructor(params = {}) {
    super(params);
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;
    this.params.touchDistance = params.touchDistance ?? 10;
    this.params.triggerWindowMin = params.triggerWindowMin ?? 30;
    this.params.maxHoldBars = params.maxHoldBars ?? 240;
    this.params.stopBuffer = params.stopBuffer ?? 2;
    this.params.maxStopPts = params.maxStopPts ?? 25;
    this.params.acceptK = params.acceptK ?? 3;
    this.params.fakePiercePts = params.fakePiercePts ?? 3;
    this.params.snapLagMin = params.snapLagMin ?? 16;
    // Allow picking a named rulebook via params.rulebookName ('default' | 'big_targets' | 'w60').
    let rb = params.rulebook;
    if (!rb && params.rulebookName) {
      const named = (params.rulebookName || '').toLowerCase();
      if (named === 'big_targets') rb = RULEBOOK_BIG_TARGETS;
      else if (named === 'w60') rb = RULEBOOK_W60;
      else rb = DEFAULT_RULEBOOK;
    }
    this.params.rulebook = rb ?? DEFAULT_RULEBOOK;
    this.params.signalCooldownMs = params.signalCooldownMs ?? 0;
    // Entry window — pre-RTH 7am ET start captures Europe-open momentum
    // (engine sweep 2026-05-13: 07:00–16:00 = +42% PnL vs 09:30 baseline,
    // Sharpe 2.24 vs 2.07, DD 5.58% vs 3.90%)
    this.params.entryWindowStartHour = params.entryWindowStartHour ?? 7;
    this.params.entryWindowStartMinute = params.entryWindowStartMinute ?? 0;
    this.params.entryWindowEndHour = params.entryWindowEndHour ?? 16;
    this.params.entryWindowEndMinute = params.entryWindowEndMinute ?? 0;
    this.params.disableEntryWindow = params.disableEntryWindow ?? false;
    this.params.eodCutoffEt = params.eodCutoffEt ?? '16:40';
    // Breakeven / trailing — engine handles application
    this.params.breakevenTrigger = params.breakevenTrigger ?? 0;  // 0 = disabled
    this.params.breakevenOffset = params.breakevenOffset ?? 0;
    this.params.trailingTrigger = params.trailingTrigger ?? 0;
    this.params.trailingOffset = params.trailingOffset ?? 0;
    this.params.debug = params.debug ?? false;

    // State: active monitoring windows (per touch event)
    // Map<windowId, { touchTs, level, approach, state, touchBar, bars1m: [], firedTriggerPatterns: Set, expireTs }>
    this._monitors = [];
    this._candleBuffer = [];
    this._currentSymbol = null;

    this.lastUpdateTs = null;
    this.lastEvalLog = [];
  }

  reset() {
    super.reset();
    this._monitors = [];
    this._candleBuffer = [];
    this._currentSymbol = null;
    this.lastUpdateTs = null;
    this.lastEvalLog = [];
  }

  _toEt(ts) {
    const d = new Date(ts);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    }).formatToParts(d);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    const weekday = parts.find(p => p.type === 'weekday')?.value || '';
    return { hour, minute, timeInMinutes: hour * 60 + minute, weekday };
  }

  _isInEntryWindow(et) {
    if (et.weekday === 'Sat' || et.weekday === 'Sun') return false;
    if (this.params.disableEntryWindow) return true;
    const startMin = this.params.entryWindowStartHour * 60 + this.params.entryWindowStartMinute;
    const endMin = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    return et.timeInMinutes >= startMin && et.timeInMinutes < endMin;
  }

  _gexLevels(g) {
    const out = [];
    if (!g) return out;
    const cw = g.call_wall ?? g.callWall;
    const pw = g.put_wall ?? g.putWall;
    const gf = g.gamma_flip ?? g.gammaFlip;
    if (cw != null) out.push({ type: 'call_wall', price: cw, isResistance: true });
    if (pw != null) out.push({ type: 'put_wall', price: pw, isResistance: false });
    if (gf != null) out.push({ type: 'gamma_flip', price: gf, isResistance: null });
    const resistance = g.resistance || [];
    for (let i = 0; i < resistance.length; i++) {
      if (resistance[i] != null) out.push({ type: `R${i + 1}`, price: resistance[i], isResistance: true });
    }
    const support = g.support || [];
    for (let i = 0; i < support.length; i++) {
      if (support[i] != null) out.push({ type: `S${i + 1}`, price: support[i], isResistance: false });
    }
    return out;
  }

  // Find a matching rulebook entry for (pattern, levelType). First match wins.
  _matchRule(pattern, levelType) {
    for (const r of this.params.rulebook) {
      if (r.pattern !== pattern) continue;
      if (r.levels !== '*' && !r.levels.includes(levelType)) continue;
      return r;
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Pattern detectors. Each takes (monitor, bars1m, idx) and may return a
  // trigger spec: { pattern, direction, entry_price, stop_price, stop_distance }
  // ────────────────────────────────────────────────────────────────────────

  _tryR1(monitor, bars1m, idx) {
    if (monitor.fired.has('R1')) return null;
    if (monitor.approach !== 'from_above') return null;
    if (!levelIsSupportFor(monitor.levelType, monitor.approach)) return null;
    const lvl = monitor.levelPrice;
    const bar = bars1m[idx];
    if (bar.close < lvl - 3) { monitor.r1Disq = true; return null; }
    if (monitor.r1Disq) return null;

    if (!monitor.r1SwingLow && isSwingLow(bars1m, idx)) {
      const b = bars1m[idx - 1];
      if (b.low > lvl - 1) monitor.r1SwingLow = { price: b.low, ts: b.timestamp };
    }
    if (monitor.r1SwingLow && !monitor.r1SwingHigh && isSwingHigh(bars1m, idx)) {
      const b = bars1m[idx - 1];
      if (b.timestamp > monitor.r1SwingLow.ts) monitor.r1SwingHigh = { price: b.high, ts: b.timestamp };
    }
    if (monitor.r1SwingLow && monitor.r1SwingHigh && bar.close > monitor.r1SwingHigh.price) {
      const entryPrice = bar.close;
      const stopRef = monitor.r1SwingLow.price - this.params.stopBuffer;
      const stopDist = entryPrice - stopRef;
      if (stopDist > this.params.maxStopPts || stopDist <= 0) return null;
      monitor.fired.add('R1');
      return { pattern: 'R1', direction: 'long', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist };
    }
    return null;
  }

  _tryR2(monitor, bars1m, idx) {
    if (monitor.fired.has('R2')) return null;
    if (monitor.approach !== 'from_below') return null;
    if (!levelIsResistanceFor(monitor.levelType, monitor.approach)) return null;
    const lvl = monitor.levelPrice;
    const bar = bars1m[idx];
    if (bar.close > lvl + 3) { monitor.r2Disq = true; return null; }
    if (monitor.r2Disq) return null;

    if (!monitor.r2SwingHigh && isSwingHigh(bars1m, idx)) {
      const b = bars1m[idx - 1];
      if (b.high < lvl + 1) monitor.r2SwingHigh = { price: b.high, ts: b.timestamp };
    }
    if (monitor.r2SwingHigh && !monitor.r2SwingLow && isSwingLow(bars1m, idx)) {
      const b = bars1m[idx - 1];
      if (b.timestamp > monitor.r2SwingHigh.ts) monitor.r2SwingLow = { price: b.low, ts: b.timestamp };
    }
    if (monitor.r2SwingHigh && monitor.r2SwingLow && bar.close < monitor.r2SwingLow.price) {
      const entryPrice = bar.close;
      const stopRef = monitor.r2SwingHigh.price + this.params.stopBuffer;
      const stopDist = stopRef - entryPrice;
      if (stopDist > this.params.maxStopPts || stopDist <= 0) return null;
      monitor.fired.add('R2');
      return { pattern: 'R2', direction: 'short', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist };
    }
    return null;
  }

  _tryR3(monitor, bars1m, idx) {
    if (monitor.fired.has('R3')) return null;
    const touchBar = monitor.touchBar;
    const lvl = monitor.levelPrice;
    const range = touchBar.high - touchBar.low;
    if (range <= 0) return null;
    const body = Math.abs(touchBar.close - touchBar.open);
    const upperWick = touchBar.high - Math.max(touchBar.open, touchBar.close);
    const lowerWick = Math.min(touchBar.open, touchBar.close) - touchBar.low;
    let pinDir = null;
    if (monitor.approach === 'from_above') {
      if (lowerWick >= 2 * body && touchBar.low <= lvl + this.params.touchDistance && touchBar.close > lvl) pinDir = 'long';
    } else {
      if (upperWick >= 2 * body && touchBar.high >= lvl - this.params.touchDistance && touchBar.close < lvl) pinDir = 'short';
    }
    if (!pinDir) return null;
    if (idx === 0) return null;
    const bar = bars1m[idx];
    const midline = (touchBar.open + touchBar.close) / 2;
    let confirmed = false;
    if (pinDir === 'long' && bar.close > midline && bar.close > touchBar.close) confirmed = true;
    if (pinDir === 'short' && bar.close < midline && bar.close < touchBar.close) confirmed = true;
    if (!confirmed) return null;
    const entryPrice = bar.close;
    let stopRef, stopDist;
    if (pinDir === 'long') {
      stopRef = touchBar.low - this.params.stopBuffer;
      stopDist = entryPrice - stopRef;
    } else {
      stopRef = touchBar.high + this.params.stopBuffer;
      stopDist = stopRef - entryPrice;
    }
    if (stopDist > this.params.maxStopPts || stopDist <= 0) return null;
    monitor.fired.add('R3');
    return { pattern: 'R3', direction: pinDir, entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist };
  }

  _tryA1(monitor, bars1m, idx) {
    if (monitor.fired.has('A1')) return null;
    if (monitor.approach !== 'from_below') return null;
    if (!levelIsResistanceFor(monitor.levelType, monitor.approach)) return null;
    const lvl = monitor.levelPrice;
    const bar = bars1m[idx];
    if (bar.close > lvl + this.params.stopBuffer) {
      monitor.a1ClosesAbove = (monitor.a1ClosesAbove || 0) + 1;
      if (monitor.a1ClosesAbove >= this.params.acceptK) monitor.a1Broke = true;
    } else if (bar.close < lvl - 1) {
      monitor.a1ClosesAbove = 0; monitor.a1Broke = false; monitor.a1RetestLow = null;
    }
    if (!monitor.a1Broke) return null;
    if (!monitor.a1RetestLow) {
      if (bar.low <= lvl + 3 && bar.close > lvl) monitor.a1RetestLow = { price: bar.low, ts: bar.timestamp, high: bar.high };
      return null;
    }
    if (bar.timestamp <= monitor.a1RetestLow.ts) return null;
    if (bar.close > monitor.a1RetestLow.high) {
      const entryPrice = bar.close;
      const stopRef = monitor.a1RetestLow.price - this.params.stopBuffer;
      const stopDist = entryPrice - stopRef;
      if (stopDist > this.params.maxStopPts || stopDist <= 0) return null;
      monitor.fired.add('A1');
      return { pattern: 'A1', direction: 'long', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist };
    }
    return null;
  }

  _tryA2(monitor, bars1m, idx) {
    if (monitor.fired.has('A2')) return null;
    if (monitor.approach !== 'from_above') return null;
    if (!levelIsSupportFor(monitor.levelType, monitor.approach)) return null;
    const lvl = monitor.levelPrice;
    const bar = bars1m[idx];
    if (bar.close < lvl - this.params.stopBuffer) {
      monitor.a2ClosesBelow = (monitor.a2ClosesBelow || 0) + 1;
      if (monitor.a2ClosesBelow >= this.params.acceptK) monitor.a2Broke = true;
    } else if (bar.close > lvl + 1) {
      monitor.a2ClosesBelow = 0; monitor.a2Broke = false; monitor.a2RetestHigh = null;
    }
    if (!monitor.a2Broke) return null;
    if (!monitor.a2RetestHigh) {
      if (bar.high >= lvl - 3 && bar.close < lvl) monitor.a2RetestHigh = { price: bar.high, ts: bar.timestamp, low: bar.low };
      return null;
    }
    if (bar.timestamp <= monitor.a2RetestHigh.ts) return null;
    if (bar.close < monitor.a2RetestHigh.low) {
      const entryPrice = bar.close;
      const stopRef = monitor.a2RetestHigh.price + this.params.stopBuffer;
      const stopDist = stopRef - entryPrice;
      if (stopDist > this.params.maxStopPts || stopDist <= 0) return null;
      monitor.fired.add('A2');
      return { pattern: 'A2', direction: 'short', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist };
    }
    return null;
  }

  _tryF1(monitor, bars1m, idx) {
    if (monitor.fired.has('F1')) return null;
    if (idx !== 0) return null;
    if (monitor.approach !== 'from_above') return null;
    if (!levelIsSupportFor(monitor.levelType, monitor.approach)) return null;
    const lvl = monitor.levelPrice;
    const tb = monitor.touchBar;
    if (lvl - tb.low < this.params.fakePiercePts) return null;
    if (tb.close <= lvl) return null;
    const entryPrice = tb.close;
    const stopRef = tb.low - this.params.stopBuffer;
    const stopDist = entryPrice - stopRef;
    if (stopDist > this.params.maxStopPts || stopDist <= 0) return null;
    monitor.fired.add('F1');
    return { pattern: 'F1', direction: 'long', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist };
  }

  _tryF2(monitor, bars1m, idx) {
    if (monitor.fired.has('F2')) return null;
    if (idx !== 0) return null;
    if (monitor.approach !== 'from_below') return null;
    if (!levelIsResistanceFor(monitor.levelType, monitor.approach)) return null;
    const lvl = monitor.levelPrice;
    const tb = monitor.touchBar;
    if (tb.high - lvl < this.params.fakePiercePts) return null;
    if (tb.close >= lvl) return null;
    const entryPrice = tb.close;
    const stopRef = tb.high + this.params.stopBuffer;
    const stopDist = stopRef - entryPrice;
    if (stopDist > this.params.maxStopPts || stopDist <= 0) return null;
    monitor.fired.add('F2');
    return { pattern: 'F2', direction: 'short', entry_price: entryPrice, stop_price: stopRef, stop_distance: stopDist };
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const ts = this.toMs(candle.timestamp);
    this.lastUpdateTs = ts;

    // Symbol change → reset
    if (candle.symbol && this._currentSymbol && candle.symbol !== this._currentSymbol) {
      this._candleBuffer = [];
      this._monitors = [];
    }
    if (candle.symbol) this._currentSymbol = candle.symbol;
    this._candleBuffer.push({
      timestamp: ts, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume || 0,
    });
    if (this._candleBuffer.length > 200) this._candleBuffer = this._candleBuffer.slice(-200);

    const et = this._toEt(ts);

    // 1. Garbage-collect expired monitors
    const expireMs = this.params.triggerWindowMin * 60_000;
    this._monitors = this._monitors.filter(m => ts - m.touchTs <= expireMs);

    // 2. Check entry window for NEW touches
    const windowOK = this._isInEntryWindow(et);

    // 3. Detect touches on this candle (if in entry window)
    if (windowOK && prevCandle && marketData?.gexLoader) {
      const lagTs = ts - this.params.snapLagMin * 60_000;
      const gexSnap = marketData.gexLoader.getGexLevels(new Date(lagTs)) || marketData.gexLevels;
      if (gexSnap) {
        const levels = this._gexLevels(gexSnap);
        for (const lvl of levels) {
          if (lvl.price == null || isNaN(lvl.price)) continue;
          const distLow = Math.abs(candle.low - lvl.price);
          const distHigh = Math.abs(candle.high - lvl.price);
          const inside = candle.low <= lvl.price && lvl.price <= candle.high;
          const edgeMin = Math.min(distLow, distHigh);
          if (edgeMin > this.params.touchDistance) continue;
          let approach;
          if (prevCandle.close > lvl.price) approach = 'from_above';
          else if (prevCandle.close < lvl.price) approach = 'from_below';
          else continue;
          // Open a new monitor for this touch (one per touch event)
          this._monitors.push({
            touchTs: ts,
            levelType: lvl.type,
            levelPrice: lvl.price,
            approach,
            touchBar: { open: candle.open, high: candle.high, low: candle.low, close: candle.close, timestamp: ts },
            bars1m: [{ open: candle.open, high: candle.high, low: candle.low, close: candle.close, timestamp: ts, volume: candle.volume || 0 }],
            fired: new Set(),
          });
        }
      }
    }

    // 4. Run detectors on all active monitors. Each new candle is appended,
    //    detectors run with idx = bars1m.length - 1.
    let bestTrigger = null;
    let bestRuleIdx = Infinity;
    let bestMonitor = null;
    for (const m of this._monitors) {
      // The current candle is appended to the monitor's bars1m only if it's
      // not the touch bar itself (touch bar was added at monitor creation).
      const isTouchBar = m.touchTs === ts;
      if (!isTouchBar) {
        m.bars1m.push({ open: candle.open, high: candle.high, low: candle.low, close: candle.close, timestamp: ts, volume: candle.volume || 0 });
      }
      const idx = m.bars1m.length - 1;
      const detectors = [this._tryR1, this._tryR2, this._tryR3, this._tryA1, this._tryA2, this._tryF1, this._tryF2];
      for (const det of detectors) {
        const trig = det.call(this, m, m.bars1m, idx);
        if (!trig) continue;
        const rule = this._matchRule(trig.pattern, m.levelType);
        if (!rule) continue;  // not in rulebook
        const ruleIdx = this.params.rulebook.indexOf(rule);
        // Prefer earlier rule (higher priority). Tie-broken by smallest stop_distance.
        if (ruleIdx < bestRuleIdx || (ruleIdx === bestRuleIdx && (!bestTrigger || trig.stop_distance < bestTrigger.stop_distance))) {
          bestTrigger = { ...trig, target_pts: rule.target };
          bestRuleIdx = ruleIdx;
          bestMonitor = m;
        }
      }
    }

    if (!bestTrigger) return this._logEval(ts, 'no_trigger');
    if (!this.checkCooldown(ts, this.params.signalCooldownMs)) return this._logEval(ts, 'cooldown');

    const entryPrice = bestTrigger.entry_price;
    const stopLoss = bestTrigger.stop_price;
    const takeProfit = bestTrigger.direction === 'long' ? entryPrice + bestTrigger.target_pts : entryPrice - bestTrigger.target_pts;

    this.updateLastSignalTime(ts);
    const signal = {
      timestamp: ts,
      side: bestTrigger.direction,
      price: entryPrice,
      strategy: 'GEX_TOUCH_PATTERNS',
      action: 'place_market',
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss, takeProfit,
      maxHoldBars: this.params.maxHoldBars,
      // Diagnostics
      pattern: bestTrigger.pattern,
      levelType: bestMonitor.levelType,
      levelPrice: bestMonitor.levelPrice,
      approach: bestMonitor.approach,
      touchTs: bestMonitor.touchTs,
      stopDistance: bestTrigger.stop_distance,
      targetPoints: bestTrigger.target_pts,
      // Mirror keys for orchestrator
      stop_loss: stopLoss,
      take_profit: takeProfit,
    };
    if (this.params.breakevenTrigger) {
      signal.breakevenStop = true;
      signal.breakevenTrigger = this.params.breakevenTrigger;
      signal.breakevenOffset = this.params.breakevenOffset ?? 0;
    }
    if (this.params.trailingTrigger && this.params.trailingOffset) {
      signal.trailingTrigger = this.params.trailingTrigger;
      signal.trailingOffset = this.params.trailingOffset;
    }
    if (this.params.debug) {
      console.log(`[GTP] ${bestTrigger.pattern} ${bestTrigger.direction.toUpperCase()} @${entryPrice.toFixed(2)} lvl=${bestMonitor.levelType}@${bestMonitor.levelPrice.toFixed(2)} sl=${stopLoss.toFixed(2)} tp=${takeProfit.toFixed(2)} (T=${bestTrigger.target_pts})`);
    }
    // Remove the monitor so we don't fire again on it
    this._monitors = this._monitors.filter(m => m !== bestMonitor);
    this._logEval(ts, null, signal);
    return signal;
  }

  onPositionClosed(info) {
    if (info?.timestamp) this.lastSignalTime = this.toMs(info.timestamp);
  }

  _logEval(ts, blockedReason, signal = null) {
    this.lastEvalLog.push({ ts, blockedReason, fired: !!signal, side: signal?.side ?? null, pattern: signal?.pattern ?? null });
    if (this.lastEvalLog.length > 20) this.lastEvalLog = this.lastEvalLog.slice(-20);
    return signal;
  }

  getName() { return 'GEX_TOUCH_PATTERNS'; }

  getInternalState() {
    return {
      activeMonitors: this._monitors.length,
      rulebookSize: this.params.rulebook.length,
      touchDistance: this.params.touchDistance,
      triggerWindowMin: this.params.triggerWindowMin,
      maxHoldBars: this.params.maxHoldBars,
      currentSymbol: this._currentSymbol,
      lastUpdateTs: this.lastUpdateTs,
      lastEvalLog: this.lastEvalLog.slice(-10),
    };
  }
}

export default GexTouchPatternsStrategy;
