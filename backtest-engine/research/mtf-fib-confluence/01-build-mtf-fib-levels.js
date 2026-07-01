/**
 * 01-build-mtf-fib-levels.js
 *
 * Build a causal, rollover-aware time series of multi-timeframe (15m / 1h / 4h)
 * structural-swing Fibonacci RETRACEMENT levels for NQ, in RAW CONTRACT price space.
 *
 * This is the "establish / find the 15m, 1h, 4h retracement levels and track them over
 * time as new highs/lows are established" deliverable for the JV (Jordan Vera) MTF
 * confluence research. Levels are JV/ICT-authentic: drawn off the most recent CONFIRMED
 * structural swing leg per timeframe, re-anchoring only when a new pivot confirms.
 *
 * PRICE SPACE: raw front-contract (matches GEX levels + the gold-standard trade entries,
 * which are also raw). We replicate filterPrimaryContract() (highest-volume symbol per
 * hour) in a single streaming pass over NQ_ohlcv_1m.csv. Rows are sorted by ts_event so
 * every hour's rows are contiguous.
 *
 * CAUSALITY (no lookahead): a fractal swing pivot at bar i is only CONFIRMED after
 * `lookback` bars to its RIGHT have closed. A leg therefore becomes "active" at the close
 * time of bar (i + lookback) -- the instant it is first knowable live. Downstream
 * annotation must use, for a trade at entryTime, the latest leg with activeFrom <= entryTime.
 *
 * ROLLOVER: when the primary contract symbol changes, we hard-reset per-TF pivot state and
 * drop any aggregated bucket that mixes two contracts. Old-contract legs stop being emitted;
 * new legs form in the new contract's price space after a short warmup. Trades are matched
 * to legs of their OWN contract at annotation time.
 *
 * OUTPUT: output/mtf-fib-active.json
 *   { meta, tf: { "15m": [legSnap...], "1h": [...], "4h": [...] } }
 * legSnap = {
 *   activeFrom,                 // ms, close time of the confirmation bar
 *   contract,                   // e.g. "NQH5"
 *   up:   { high, hts, low, lts, range, levels:[{r,price}] } | null,  // long-side support
 *   down: { high, hts, low, lts, range, levels:[{r,price}] } | null,  // short-side resistance
 * }
 * Each snapshot is emitted only when the up-leg or down-leg anchors change.
 *
 * Usage:
 *   node 01-build-mtf-fib-levels.js [--start 2024-09-01] [--end 2026-06-15]
 *     [--lookback 3] [--ratios 0.382,0.5,0.618,0.705,0.786]
 *     [--min15 12 --min60 25 --min240 50]
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');                 // backtest-engine/
const OHLCV = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1m.csv');
const OUT = path.join(__dirname, 'output/mtf-fib-active.json');

// ---------------- CLI ----------------
function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const START = arg('start', '2024-09-01');     // warmup before the 2025-01-13 trade window
const END = arg('end', '2026-06-15');
const LOOKBACK = +arg('lookback', '3');       // fractal strength (bars each side)
const RATIOS = arg('ratios', '0.382,0.5,0.618,0.705,0.786').split(',').map(Number);
const MIN_LEG = { '15m': +arg('min15', '12'), '1h': +arg('min60', '25'), '4h': +arg('min240', '50') };
const TF_MS = { '15m': 15 * 60000, '1h': 60 * 60000, '4h': 4 * 3600000 };
const TFS = Object.keys(TF_MS);

// ---------------- ET wall-clock (for 4h alignment at 00/04/08/12/16/20 ET) ----------------
function isDST(ms) { const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth(); if (m > 3 && m < 10) return true; if (m < 2 || m === 11) return false; if (m === 2) { const fd = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ms >= Date.UTC(y, 2, fd === 0 ? 8 : 15 - fd, 7); } if (m === 10) { const fd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ms < Date.UTC(y, 10, fd === 0 ? 1 : 8 - fd, 6); } return true; }
const etMs = ms => ms - (isDST(ms) ? 4 : 5) * 3600000;           // shift so flooring => ET buckets
const bucketStart = (ms, tf) => { const e = etMs(ms); const b = Math.floor(e / TF_MS[tf]) * TF_MS[tf]; return b + (isDST(ms) ? 4 : 5) * 3600000; }; // back to real ms (approx; DST edges negligible)

// ---------------- fib levels for a leg ----------------
function fibLevels(high, low) { const range = high - low; return RATIOS.map(r => ({ r, price: +(high - range * r).toFixed(2) })); }

// ---------------- per-TF causal pivot + leg tracker ----------------
class TFTracker {
  constructor(tf) {
    this.tf = tf; this.minLeg = MIN_LEG[tf];
    this.bars = [];              // confirmed CLOSED aggregated bars for current contract segment
    this.pivots = [];            // alternating confirmed pivots {type:'H'|'L', price, ts}
    this.snaps = [];             // emitted leg snapshots
    this.contract = null;
    this.lastSig = null;         // dedup signature of last emitted (up+down anchors)
    this.cur = null;             // current forming bucket
  }
  resetSegment(contract) { this.bars = []; this.pivots = []; this.contract = contract; this.cur = null; this.lastSig = null; }

  // feed one primary-contract 1m bar
  add1m(bar) {
    if (this.contract == null) this.contract = bar.symbol;
    if (bar.symbol !== this.contract) { this.resetSegment(bar.symbol); }   // rollover -> hard reset
    const bs = bucketStart(bar.ts, this.tf);
    if (this.cur == null) { this.cur = this._newBucket(bs, bar); return; }
    if (bs !== this.cur.bs) { this._closeBucket(); this.cur = this._newBucket(bs, bar); return; }
    // extend current bucket
    if (bar.symbol !== this.cur.symbol) { this.cur.mixed = true; }
    this.cur.high = Math.max(this.cur.high, bar.high);
    this.cur.low = Math.min(this.cur.low, bar.low);
    this.cur.close = bar.close;
  }
  _newBucket(bs, bar) { return { bs, symbol: bar.symbol, open: bar.open, high: bar.high, low: bar.low, close: bar.close, mixed: false }; }
  _closeBucket() {
    const b = this.cur; this.cur = null;
    if (b.mixed) return;                         // drop cross-contract bucket
    b.closeTs = b.bs + TF_MS[this.tf];           // when this bar becomes known
    this.bars.push(b);
    // try to confirm the pivot at index (len-1-LOOKBACK)
    const i = this.bars.length - 1 - LOOKBACK;
    if (i >= LOOKBACK) this._confirmPivot(i, b.closeTs);
  }
  _confirmPivot(i, knownTs) {
    const c = this.bars[i]; let isH = true, isL = true;
    for (let j = 1; j <= LOOKBACK; j++) {
      const l = this.bars[i - j], r = this.bars[i + j];
      if (l.high >= c.high || r.high > c.high) isH = false;
      if (l.low <= c.low || r.low < c.low) isL = false;
    }
    if (isH) this._pushPivot({ type: 'H', price: c.high, ts: c.bs }, knownTs);
    if (isL) this._pushPivot({ type: 'L', price: c.low, ts: c.bs }, knownTs);
  }
  _pushPivot(p, knownTs) {
    const last = this.pivots[this.pivots.length - 1];
    if (last && last.type === p.type) {
      // same type in a row: keep the more extreme, re-anchor
      if ((p.type === 'H' && p.price > last.price) || (p.type === 'L' && p.price < last.price)) this.pivots[this.pivots.length - 1] = p;
      else return;
    } else this.pivots.push(p);
    this._emit(knownTs);
  }
  // derive most-recent up-leg (L->H) and down-leg (H->L) from alternating pivots
  _legs() {
    const pv = this.pivots; let up = null, down = null;
    for (let k = pv.length - 1; k >= 1 && (!up || !down); k--) {
      const a = pv[k - 1], b = pv[k];
      if (!up && a.type === 'L' && b.type === 'H') up = { low: a.price, lts: a.ts, high: b.price, hts: b.ts };
      if (!down && a.type === 'H' && b.type === 'L') down = { high: a.price, hts: a.ts, low: b.price, lts: b.ts };
    }
    return { up, down };
  }
  _emit(knownTs) {
    const { up, down } = this._legs();
    const mk = leg => { if (!leg) return null; const range = +(leg.high - leg.low).toFixed(2); if (range < this.minLeg) return null; return { high: leg.high, hts: leg.hts, low: leg.low, lts: leg.lts, range, levels: fibLevels(leg.high, leg.low) }; };
    const u = mk(up), d = mk(down);
    if (!u && !d) return;
    const sig = `${u ? u.high + ':' + u.low : '-'}|${d ? d.high + ':' + d.low : '-'}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.snaps.push({ activeFrom: knownTs, contract: this.contract, up: u, down: d });
  }
}

// ---------------- stream NQ_ohlcv_1m.csv, primary-filter per hour, feed trackers ----------------
async function main() {
  const startMs = Date.parse(START + 'T00:00:00Z'), endMs = Date.parse(END + 'T23:59:59Z');
  const trackers = Object.fromEntries(TFS.map(tf => [tf, new TFTracker(tf)]));

  const rl = readline.createInterface({ input: fs.createReadStream(OHLCV), crlfDelay: Infinity });
  let header = null, idx = {};
  let hourKey = null, hourRows = [];      // buffer one hour to pick primary contract
  let nRows = 0, nPrimary = 0;

  const flushHour = () => {
    if (hourRows.length === 0) return;
    // pick highest-volume symbol this hour
    const vol = new Map();
    for (const r of hourRows) vol.set(r.symbol, (vol.get(r.symbol) || 0) + r.volume);
    let primary = null, mx = -1; for (const [s, v] of vol) if (v > mx) { mx = v; primary = s; }
    for (const r of hourRows) { if (r.symbol !== primary) continue; if (r.symbol.includes('-')) continue; nPrimary++; for (const tf of TFS) trackers[tf].add1m(r); }
    hourRows = [];
  };

  for await (const line of rl) {
    if (!header) { header = line.split(','); idx = { ts: header.indexOf('ts_event'), o: header.indexOf('open'), h: header.indexOf('high'), l: header.indexOf('low'), c: header.indexOf('close'), v: header.indexOf('volume'), s: header.indexOf('symbol') }; continue; }
    // fast date prefix gate (ISO sorts lexically)
    const tsStr = line.slice(0, line.indexOf(','));
    if (tsStr < START) continue; if (tsStr > END + 'T99') break;
    const p = line.split(','); const ts = Date.parse(p[idx.ts]); if (isNaN(ts) || ts < startMs || ts > endMs) continue;
    const sym = p[idx.s]; if (sym.includes('-')) continue;     // drop calendar spreads
    const row = { ts, symbol: sym, open: +p[idx.o], high: +p[idx.h], low: +p[idx.l], close: +p[idx.c], volume: +p[idx.v] || 0 };
    nRows++;
    const hk = Math.floor(ts / 3600000);
    if (hk !== hourKey) { flushHour(); hourKey = hk; }
    hourRows.push(row);
  }
  flushHour();
  // close trailing buckets (their pivots near the very end may stay unconfirmed -- fine)
  for (const tf of TFS) if (trackers[tf].cur) trackers[tf]._closeBucket();

  const out = {
    meta: { generated: new Date().toISOString(), start: START, end: END, lookback: LOOKBACK, ratios: RATIOS, minLeg: MIN_LEG, rowsScanned: nRows, primaryRows: nPrimary, priceSpace: 'raw-front-contract', note: 'activeFrom = confirmation-bar close time (causal). Match trades to legs of same contract.' },
    tf: Object.fromEntries(TFS.map(tf => [tf, trackers[tf].snaps])),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`Scanned ${nRows} window rows, ${nPrimary} primary 1m bars.`);
  for (const tf of TFS) console.log(`  ${tf}: ${trackers[tf].snaps.length} leg snapshots  (last contract ${trackers[tf].contract})`);
  console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}
main();
