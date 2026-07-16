/**
 * Dealer-Wall Fade (DWF) — fade upward approaches into flow-confirmed
 * dealer-LONG-gamma GEX walls after a flat stall in the wall's zone.
 *
 * Mechanism (research/dealer-flow, 2026-07-13): naked GEX walls are placebo;
 * the tradable subset is walls whose QQQ strike carries dealer-LONG gamma in
 * the signed-order-flow inventory (as-of prior close). Setup sequence:
 *   1. price approaches the wall FROM BELOW (prev close below the zone),
 *   2. enters the ±zonePct band around the level,
 *   3. stalls: |log return| over the next stallBars 1m closes < stallMaxPct,
 *   4. -> SHORT market at the stall-confirmation close. Stop stopPts above,
 *      time exit maxHoldBars minutes. No profit target by default (the edge
 *      is a slow drift, ~-0.04%/hr; targets clip it — see overlay study).
 *
 * Research reference (1s sim, 2025-02->2026-01): 334tr / $42,939 / WR 41.9 /
 * PF 1.53 / maxDD $7,635, all quarter-blocks positive. Placebo-controlled,
 * mechanism pre-registered. Engine gold pending (this port).
 *
 * Data requirement: marketData.dwfLevels = array of the CURRENT day's levels
 *   [{ level, kind, dgSign, dte0Share }] (engine: --dwf-levels-file; live:
 *   nightly signed-flow build — requires options tape, see dealer-flow docs).
 */
import { BaseStrategy } from './base-strategy.js';

const ONE_MIN_MS = 60 * 1000;

export class DealerWallFadeStrategy extends BaseStrategy {
  static getDataRequirements() {
    return { dwfLevels: true, gex: false, lt: false, ivSkew: false };
  }

  constructor(params = {}) {
    super(params);
    this.params.zonePct = params.zonePct ?? 0.10;        // zone half-width, % of level
    this.params.stallBars = params.stallBars ?? 5;       // 1m bars to confirm stall
    this.params.stallMaxPct = params.stallMaxPct ?? 0.05;// |r| bound over stallBars
    this.params.stopPts = params.stopPts ?? 25;
    // 'entry' anchors the stop stopPts above the fill; 'zone' anchors it
    // 5pt above the zone top (level * (1+zonePct/100)) — the research B2 shape.
    this.params.stopMode = params.stopMode ?? 'entry';
    this.params.targetPts = params.targetPts ?? null;    // null = time exit only
    this.params.maxHoldBars = params.maxHoldBars ?? 60;
    this.params.requireDgLong = params.requireDgLong ?? true;
    // Conditioning stack (research/dealer-flow overlays + pilotfish D2):
    // lsAlign: short-only strategy — require 15m LS state BEARISH at signal
    // (marketData.ls15Sentiment; engine --ls15-file / live LS_STATUS_15M).
    // minDte0Share: drop walls whose strike carries little same-day gamma
    // (D2 tertile gradient: PF 1.04 low / 1.53 high dte0_share).
    this.params.lsAlign = params.lsAlign ?? false;
    this.params.minDte0Share = params.minDte0Share ?? null;
    this.params.cooldownBars = params.cooldownBars ?? 15; // per-level episode debounce
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // per-level episode state, keyed by rounded level price; reset daily
    this._day = null;
    this._episodes = new Map();
    this._lastRejectReason = null;
  }

  _dayOf(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    this._lastRejectReason = null;
    if (!prevCandle) return null;
    const levels = marketData?.dwfLevels;
    if (!levels || !levels.length) {
      this._lastRejectReason = 'no dwf levels for day';
      return null;
    }
    const day = this._dayOf(candle.timestamp);
    if (day !== this._day) {
      this._day = day;
      this._episodes.clear();
    }

    for (const lv of levels) {
      if (this.params.requireDgLong && lv.dgSign !== 1) continue;
      if (this.params.minDte0Share != null
          && (lv.dte0Share == null || lv.dte0Share < this.params.minDte0Share)) continue;
      const L = lv.level;
      const zone = L * this.params.zonePct / 100;
      const key = Math.round(L * 4) / 4;
      let ep = this._episodes.get(key);

      const prevOutside = Math.abs(prevCandle.close - L) > zone;
      const intersects = candle.low <= L + zone && candle.high >= L - zone;

      if (!ep || ep.state === 'idle') {
        // Cooldown: require idle time after the last episode at this level.
        if (ep && candle.timestamp < ep.cooldownUntil) continue;
        // Zone entry from BELOW only (the validated side).
        if (prevOutside && intersects && prevCandle.close < L) {
          this._episodes.set(key, {
            state: 'stalling',
            entryClose: candle.close,
            entryTs: candle.timestamp,
            barsSeen: 0,
            cooldownUntil: 0,
          });
        }
        continue;
      }

      if (ep.state === 'stalling') {
        ep.barsSeen += 1;
        if (ep.barsSeen < this.params.stallBars) continue;
        // Stall decision bar reached: consume the episode either way.
        ep.state = 'idle';
        ep.cooldownUntil = ep.entryTs + this.params.cooldownBars * ONE_MIN_MS;
        const r = Math.log(candle.close / ep.entryClose) * 100;
        if (Math.abs(r) >= this.params.stallMaxPct) {
          this._lastRejectReason = `no stall (r${this.params.stallBars}=${r.toFixed(3)}%)`;
          continue;
        }
        if (this.params.lsAlign && marketData?.ls15Sentiment !== 'BEARISH') {
          this._lastRejectReason = `ls15 not BEARISH (${marketData?.ls15Sentiment ?? 'missing'})`;
          continue;
        }
        const symbol = options.symbol || this.params.tradingSymbol;
        const quantity = options.quantity || this.params.defaultQuantity;
        const entryPrice = candle.close;
        return {
          timestamp: candle.timestamp + ONE_MIN_MS,
          side: 'sell',
          price: entryPrice,
          action: 'place_market',
          strategy: 'DEALER_WALL_FADE',
          symbol,
          quantity,
          stopLoss: this.params.stopMode === 'zone'
            ? L * (1 + this.params.zonePct / 100) + 5
            : entryPrice + this.params.stopPts,
          takeProfit: this.params.targetPts
            ? entryPrice - this.params.targetPts : null,
          maxHoldBars: this.params.maxHoldBars,
          // Breakeven pass-through: set via engine-wide --breakeven-stop flags
          // (cli maps them onto strategyParams; simulator applies them).
          breakevenStop: this.params.breakevenStop || false,
          breakevenTrigger: this.params.breakevenTrigger ?? null,
          breakevenOffset: this.params.breakevenOffset ?? 0,
          metadata: {
            strategy: 'DEALER_WALL_FADE',
            level: L,
            strike: lv.strike ?? null,
            kind: lv.kind ?? null,
            dgSign: lv.dgSign,
            dte0Share: lv.dte0Share ?? null,
            stallR: +r.toFixed(4),
            zoneEntryTs: ep.entryTs,
          },
        };
      }
    }
    return null;
  }
}

export default DealerWallFadeStrategy;
