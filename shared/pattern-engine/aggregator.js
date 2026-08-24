/**
 * SessionAnchoredAggregator — builds tf bars from 1m bars, anchored to the 18:00 ET session open.
 *
 * Contract (KNOWABILITY.md rule 2): bars are stamped at period OPEN and emitted at CLOSE. A tf bar
 * is emitted as soon as its last constituent 1m bar has closed (the period end is a fixed clock
 * boundary, so this is knowable without seeing the next bar). If the data has a hole across the
 * boundary, the stale bar is emitted (flagged `partial`) when the next 1m bar arrives.
 *
 * Input 1m bar: { ts (UTC ms of bar OPEN), open, high, low, close, volume, symbol }
 * Output tf bar: { tf, ts, closeTs, open, high, low, close, volume, symbol, n, partial, mos, ssUtc, tradeDate }
 *   ts      = period open (UTC ms)
 *   closeTs = instant the bar became knowable (last constituent's ts + 60s)
 *   mos     = period start in session minutes
 */
import { sessionInfo, sessionMinuteToUtc, tfMinutes, tradeDate } from './time.js';

const MIN = 60_000;

export class SessionAnchoredAggregator {
  constructor(tf) {
    this.tf = tf;
    this.tfMin = Math.min(tfMinutes(tf), 1440);
    this.cur = null;
  }

  reset() { this.cur = null; }

  /**
   * Feed one closed 1m bar. Returns an array of 0..2 closed tf bars (2 only when a stale partial
   * bar must be flushed before the new one closes).
   */
  add(bar) {
    const out = [];
    if (this.tfMin === 1) {
      const si = sessionInfo(bar.ts);
      out.push({ tf: this.tf, ts: bar.ts, closeTs: bar.ts + MIN, open: bar.open, high: bar.high, low: bar.low,
        close: bar.close, volume: bar.volume, symbol: bar.symbol, n: 1, partial: false, mos: si.mos, ssUtc: si.ssUtc,
        tradeDate: tradeDate(bar.ts) });
      return out;
    }
    const si = sessionInfo(bar.ts);
    const t = this.tfMin;
    const k = Math.floor(si.mos / t);
    const startMos = k * t;
    const endMos = Math.min((k + 1) * t, Math.max(si.endMos, startMos + 1));
    const key = si.ssUtc + ':' + k;
    let cur = this.cur;
    if (cur && (cur.key !== key || cur.symbol !== bar.symbol)) {
      // period changed (or contract rolled) without a clean close → flush stale bar as partial.
      // Its knowable-at instant is NOW (we only learn the period ended when this bar arrives).
      cur.partial = true;
      cur.closeTs = Math.max(cur.closeTs, bar.ts);
      out.push(this._finish(cur));
      cur = null;
    }
    if (!cur) {
      cur = this.cur = {
        key, tf: this.tf, ts: sessionMinuteToUtc(si.ssUtc, startMos, si.fallBack), ssUtc: si.ssUtc, mos: startMos, endMos,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0, symbol: bar.symbol, n: 0,
        closeTs: 0, partial: false, tradeDate: tradeDate(bar.ts),
      };
    }
    if (bar.high > cur.high) cur.high = bar.high;
    if (bar.low < cur.low) cur.low = bar.low;
    cur.close = bar.close;
    cur.volume += bar.volume;
    cur.n += 1;
    cur.closeTs = bar.ts + MIN;
    if (si.mos + 1 >= cur.endMos) {          // last constituent minute closed → bar is knowable now
      out.push(this._finish(cur));
      this.cur = null;
    }
    return out;
  }

  _finish(cur) {
    const { key, endMos, ...bar } = cur;
    return bar;
  }
}

/** Convenience: fan one 1m stream out to many tfs. */
export class MultiTfAggregator {
  constructor(tfs) {
    this.aggs = tfs.map((tf) => new SessionAnchoredAggregator(tf));
  }
  reset() { for (const a of this.aggs) a.reset(); }
  /** returns [{tf, bar}] in tf order */
  add(bar) {
    const out = [];
    for (const a of this.aggs) for (const b of a.add(bar)) out.push(b);
    return out;
  }
}
