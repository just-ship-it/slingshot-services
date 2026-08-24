/**
 * Shared helpers for the structure-primitive detectors (P6–P13). Not a detector (leading underscore →
 * excluded from the registry). Everything here reads only closed tf bars passed in by the detector.
 */
import { etMinuteOfDay } from '../../time.js';

export const TICK = 0.25;
export const RTH_OPEN_MIN = 9 * 60 + 30;    // 09:30 ET
export const RTH_CLOSE_MIN = 16 * 60;       // 16:00 ET
export const GLOBEX_OPEN_MIN = 18 * 60;     // 18:00 ET

/** ATR-scaled threshold with a tick floor */
export function atrFloor(mult, atr, minTicks = 1) { return Math.max(minTicks * TICK, mult * (Number.isFinite(atr) ? atr : 0)); }

/** bar → anchor */
export function barAnchor(role, bar, price = bar.close) { return { role, ts: bar.ts, price, confirmedAt: bar.closeTs }; }
/** pivot → anchor (pivot.confirmedAt already ≤ now by construction) */
export function pivotAnchor(role, p) { return { role, ts: p.ts, price: p.price, confirmedAt: p.confirmedAt }; }
/** sort anchors chronologically (stable), drop exact duplicates (same role+ts) */
export function sortAnchors(list) {
  const seen = new Set(); const out = [];
  for (const a of list) { if (!a) continue; const k = a.role + ':' + a.ts; if (seen.has(k)) continue; seen.add(k); out.push(a); }
  return out.sort((a, b) => a.ts - b.ts);
}

/** highest high / lowest low over bars.at(-from-1) .. bars.at(-to-1)  (from=1,to=N → the N bars BEFORE the latest) */
export function extremes(bars, n, skipLatest = 1) {
  let hi = -Infinity, lo = Infinity, hiBar = null, loBar = null;
  const L = bars.length;
  const end = L - skipLatest;
  const start = Math.max(0, end - n);
  for (let i = start; i < end; i++) {
    const b = bars.at(i);
    if (b.high > hi) { hi = b.high; hiBar = b; }
    if (b.low < lo) { lo = b.low; loBar = b; }
  }
  return { hi, lo, hiBar, loBar, n: end - start };
}

/** Kaufman efficiency ratio of closes over the last n+1 bars (net / path). */
export function efficiencyRatio(bars, n) {
  const L = bars.length; if (L < n + 1) return NaN;
  let path = 0;
  for (let i = L - n; i < L; i++) path += Math.abs(bars.at(i).close - bars.at(i - 1).close);
  return path > 0 ? Math.abs(bars.at(L - 1).close - bars.at(L - 1 - n).close) / path : 0;
}

/**
 * Per-tf session bookkeeping from closed tf bars only. Call `update(bar)` at the top of onBar; then
 * `cur`, `prev`, `or30`, `ib`, `rthOpenBar`, `prevRthCloseBar` are as of the latest closed bar.
 * `curBefore` = current-session extremes EXCLUDING the latest bar (for sweep tests).
 */
export class SessionState {
  constructor(tfMin) {
    this.tfMin = tfMin;
    this.cur = null; this.prev = null; this.curBefore = null;
    this.or30 = null; this.ib = null;               // { high, low, hiBar, loBar, formed, n }
    this.rthOpenBar = null; this.rthCloseBar = null; this.prevRthCloseBar = null;
    this.prevSessionCloseBar = null;
    this.barsInSession = 0;
  }
  _fresh(bar) { return { ssUtc: bar.ssUtc, high: bar.high, low: bar.low, hiBar: bar, loBar: bar, openBar: bar, n: 1 }; }
  update(bar) {
    const s = this.cur;
    if (!s || s.ssUtc !== bar.ssUtc) {
      // session roll
      if (s) { this.prev = s; this.prevSessionCloseBar = s.lastBar; this.prevRthCloseBar = this.rthCloseBar; }
      this.curBefore = null;
      this.cur = this._fresh(bar); this.cur.lastBar = bar;
      this.or30 = null; this.ib = null; this.rthOpenBar = null; this.rthCloseBar = null;
      this.barsInSession = 1;
    } else {
      this.curBefore = { high: s.high, low: s.low, hiBar: s.hiBar, loBar: s.loBar, n: s.n };
      if (bar.high > s.high) { s.high = bar.high; s.hiBar = bar; }
      if (bar.low < s.low) { s.low = bar.low; s.loBar = bar; }
      s.n++; s.lastBar = bar;
      this.barsInSession++;
    }
    const m = etMinuteOfDay(bar.ts);
    const endM = m + this.tfMin;
    if (m >= RTH_OPEN_MIN && m < RTH_CLOSE_MIN) {
      if (!this.rthOpenBar) this.rthOpenBar = bar;
      this.rthCloseBar = bar;
      // opening range 30 / IB 60 (only for tfs that fit inside the window)
      for (const [key, W] of [['or30', 30], ['ib', 60]]) {
        if (this.tfMin > W) continue;
        let r = this[key];
        if (m < RTH_OPEN_MIN + W) {
          if (!r) r = this[key] = { high: bar.high, low: bar.low, hiBar: bar, loBar: bar, openBar: bar, n: 1, formed: false, formedAt: null };
          else { if (bar.high > r.high) { r.high = bar.high; r.hiBar = bar; } if (bar.low < r.low) { r.low = bar.low; r.loBar = bar; } r.n++; }
          r.lastBar = bar;
          if (endM >= RTH_OPEN_MIN + W && !r.formed) { r.formed = true; r.formedAt = bar.closeTs; }
        } else if (r && !r.formed) { r.formed = true; r.formedAt = bar.closeTs; }   // last window bar missing → formed at this (later) bar's close
      }
    }
  }
}
