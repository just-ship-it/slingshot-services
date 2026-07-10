/**
 * LT-GEX Path Race Strategy (lgpr)
 *
 * From the LT magnet-race study (research/deepdive-weekly/REPORT-LT-MAGNET.md):
 * raw LT levels are not magnets, but GEX levels act as BARRIERS protecting the
 * LT level behind them. When the path from spot to the nearest LT level on one
 * side is clear of GEX barriers while the opposite path is blocked by a GEX
 * shield, price reaches the clear-side LT level first far more often than the
 * fair-distance model implies.
 *
 * v1 config (1s-validated 2026-07-06/07):
 *   - evaluate once per hour: nearest LT level above and below spot
 *     (0.05% < distance < 8%), GEX snapshot <= 45 min old
 *   - LONG when no GEX resistance sits between spot and the up-LT (minus a
 *     0.15%-of-spot confluence epsilon) AND a GEX support sits between spot
 *     and the down-LT; SHORT mirrored
 *   - limit entry at a 10% pullback of the spot->stop range; the order is
 *     cancelled if the target is touched before the fill (missed trade)
 *   - target = clear-path LT level (limit, exact), stop = opposite LT level
 *     (uncapped — it sits behind the GEX shield), flat time-stop 8h
 *   - one position at a time; no entry window; holds across sessions
 *     (run with --allow-overnight-holds)
 *
 * Optional ES confluence gate ("v1-ES" sleeve, --lgpr-es-gate): only take
 * signals when the same clear-path composite computed on ES (ES LT 15m feed +
 * SPY-derived ES GEX) agrees with the side. Precomputed point-in-time states
 * in data/features/es15_clearpath_states.csv (ES data walls 2026-01).
 *
 * Backtest (research parity): --ticker NQ --timeframe 1m --raw-contracts
 * --gex-dir data/gex/nq --commission 4 --allow-overnight-holds
 */

import fs from 'fs';
import path from 'path';
import { BaseStrategy } from './base-strategy.js';

const HOUR_MS = 60 * 60 * 1000;

export class LtGexPathRaceStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
      lt: true,       // 15m LT feed (level_1..level_5)
      lt1m: false,
      tradier: false,
      ivSkew: false,
    };
  }

  constructor(params = {}) {
    super(params);

    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Fraction of the spot->stop range to wait for on the limit entry.
    this.params.pullbackFrac = params.pullbackFrac ?? 0.10;
    // Flat time-stop in minutes (engine counts barsSinceEntry per 1m candle).
    this.params.maxHoldMinutes = params.maxHoldMinutes ?? 480;
    // LT level distance band (% of spot).
    this.params.minDistPct = params.minDistPct ?? 0.05;
    this.params.maxDistPct = params.maxDistPct ?? 8.0;
    // Confluence epsilon (% of spot) for the GEX barrier/shield test.
    this.params.conflPct = params.conflPct ?? 0.15;
    // Reject signals when the GEX snapshot is older than this.
    this.params.gexMaxAgeMin = params.gexMaxAgeMin ?? 45;
    // Reject signals when the LT record is older than this (research required
    // a fresh feed row at each hourly sample).
    this.params.ltMaxAgeMin = params.ltMaxAgeMin ?? 20;

    // ES confluence gate (v1-ES sleeve).
    this.params.esGate = params.esGate ?? false;
    this.params.esStatesFile = params.esStatesFile ?? null; // resolved lazily
    this.params.esMaxAgeMs = params.esMaxAgeMs ?? 2 * HOUR_MS;

    // Evaluate on every Nth fresh LT-feed row (research sampled every 4th
    // 15m row = ~hourly, drifting with the feed's own grid).
    this.params.sampleEveryRows = params.sampleEveryRows ?? 4;

    this._lastLtTs = 0;
    this._ltRowCount = 0;
    this._esStates = null;   // [{ts, state}] sorted, lazy-loaded
  }

  reset() {
    super.reset();
    this._lastLtTs = 0;
    this._ltRowCount = 0;
  }

  evaluateSignal(candle, prevCandle, marketData) {
    const ts = this.toMs(candle.timestamp);

    const lt = marketData?.ltLevels;
    if (!lt) return null;
    // Guard against the engine's abs-nearest LT lookup handing us a future
    // row, and against stale feed gaps.
    if (lt.timestamp > ts + 60 * 1000) return null;
    if (ts - lt.timestamp > this.params.ltMaxAgeMin * 60 * 1000) return null;

    // Sample on the LT feed's own row grid: evaluate only on the first candle
    // where every Nth new row is current.
    if (lt.timestamp <= this._lastLtTs) return null;
    this._lastLtTs = lt.timestamp;
    this._ltRowCount++;
    if ((this._ltRowCount - 1) % this.params.sampleEveryRows !== 0) return null;

    const gex = marketData?.gexLevels;
    if (!gex) return null;
    const gexTs = this.toMs(gex.timestamp);
    if (!gexTs || ts - gexTs > this.params.gexMaxAgeMin * 60 * 1000 || gexTs > ts) return null;

    const spot = candle.close;

    // Nearest LT level above and below spot within the distance band.
    const levels = [lt.level_1, lt.level_2, lt.level_3, lt.level_4, lt.level_5]
      .filter(v => v != null && !isNaN(v));
    if (levels.length < 2) return null;
    const minD = this.params.minDistPct / 100 * spot;
    const maxD = this.params.maxDistPct / 100 * spot;
    const ups = levels.filter(v => v - spot > minD && v - spot < maxD);
    const dns = levels.filter(v => spot - v > minD && spot - v < maxD);
    if (!ups.length || !dns.length) return null;
    const up = Math.min(...ups);
    const dn = Math.max(...dns);

    // Clear-path composite: GEX barrier vs shield.
    const res = (gex.resistance || []).filter(v => v != null && !isNaN(v));
    const sup = (gex.support || []).filter(v => v != null && !isNaN(v));
    const eps = spot * this.params.conflPct / 100;
    const resBetween = res.some(x => x > spot && x < up - eps);
    const supBetween = sup.some(x => x > dn + eps && x < spot);

    let side = null;
    if (!resBetween && supBetween) side = 'long';
    else if (!supBetween && resBetween) side = 'short';
    if (!side) return null;

    // Optional ES confluence gate.
    if (this.params.esGate && this._esStateAt(ts) !== side) return null;

    const sign = side === 'long' ? 1 : -1;
    const target = side === 'long' ? up : dn;
    const stop = side === 'long' ? dn : up;
    const entryPrice = spot - sign * this.params.pullbackFrac * Math.abs(spot - stop);

    this.updateLastSignalTime(ts);

    if (this.params.debug) {
      console.log(`[LGPR] ${side.toUpperCase()} spot=${spot.toFixed(2)} ` +
        `E=${entryPrice.toFixed(2)} tgt=${target.toFixed(2)} stop=${stop.toFixed(2)}` +
        (this.params.esGate ? ' [ES agree]' : ''));
    }

    return {
      timestamp: ts,
      side,
      price: entryPrice,
      strategy: 'LT_GEX_PATH_RACE',
      action: 'place_limit',
      // No time-based expiry: the order rests until it fills or the target is
      // touched first (pre-fill invalidation), matching the research sim.
      timeoutCandles: 0,
      cancelOnPreFillExtreme: true,
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss: stop,
      takeProfit: target,
      // Wall-clock time-stop (spans halts/weekends), matching the research
      // sim and the time-as-risk philosophy. NOT maxHoldBars (traded minutes).
      maxHoldWallMs: this.params.maxHoldMinutes * 60 * 1000,

      spotAtSignal: spot,
      upLevel: up,
      dnLevel: dn,

      stop_loss: stop,
      take_profit: target,
    };
  }

  // ── ES confluence state (precomputed, point-in-time) ────────────────────

  _esStateAt(ts) {
    if (!this._esStates) this._loadEsStates();
    const arr = this._esStates;
    if (!arr.length) return null;
    let lo = 0, hi = arr.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].ts <= ts) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best < 0 || ts - arr[best].ts > this.params.esMaxAgeMs) return null;
    return arr[best].state;
  }

  _loadEsStates() {
    this._esStates = [];
    const candidates = [
      this.params.esStatesFile,
      path.resolve(this.params.dataDir || 'data', 'features/es15_clearpath_states.csv'),
      path.resolve('data/features/es15_clearpath_states.csv'),
    ].filter(Boolean);
    const file = candidates.find(f => fs.existsSync(f));
    if (!file) {
      throw new Error('[LGPR] --lgpr-es-gate requires data/features/es15_clearpath_states.csv ' +
        '(generate via research/deepdive-weekly tooling)');
    }
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 3) continue;
      const ts = parseInt(parts[0], 10);
      if (!isNaN(ts)) this._esStates.push({ ts, state: parts[2].trim() });
    }
    this._esStates.sort((a, b) => a.ts - b.ts);
    console.log(`[LGPR] ES gate: loaded ${this._esStates.length} clear-path states from ${file}`);
  }
}
