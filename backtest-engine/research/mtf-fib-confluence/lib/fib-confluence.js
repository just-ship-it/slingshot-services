/**
 * lib/fib-confluence.js
 *
 * Causal lookup of the multi-TF structural-fib levels built by 01-build-mtf-fib-levels.js,
 * plus per-trade confluence features for mean-reversion (glf/gfi) trades.
 *
 * Causality: for a trade at entryTime we use the latest leg snapshot per TF with
 * activeFrom <= entryTime. Snapshots are time-ordered and contract-contiguous, so the
 * latest snapshot <= entryTime is authoritative; if its contract != the trade's contract
 * we're inside a rollover warmup gap -> that TF returns null (no comparable level).
 *
 * Side matching (JV/ICT): a LONG fade seeks an up-leg retracement (support); a SHORT fade
 * seeks a down-leg retracement (resistance).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGS_PATH = path.join(__dirname, '..', 'output', 'mtf-fib-active.json');

let _legs = null;
export function loadLegs() {
  if (_legs) return _legs;
  const raw = JSON.parse(fs.readFileSync(LEGS_PATH, 'utf8'));
  _legs = raw; _legs.tfList = Object.keys(raw.tf);
  // pre-extract activeFrom arrays for binary search
  _legs._af = {};
  for (const tf of _legs.tfList) _legs._af[tf] = raw.tf[tf].map(s => s.activeFrom);
  return _legs;
}

// latest snapshot index with activeFrom <= ts
function idxAsOf(af, ts) { let lo = 0, hi = af.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (af[m] <= ts) { r = m; lo = m + 1; } else hi = m - 1; } return r; }

export function legAsOf(tf, ts, contract) {
  const L = loadLegs(); const af = L._af[tf]; const i = idxAsOf(af, ts); if (i < 0) return null;
  const s = L.tf[tf][i];
  if (contract && s.contract !== contract) return null;   // rollover warmup gap
  return s;
}

/**
 * Per-trade fib confluence features.
 * @param trade {entryTime, side('long'|'short'), price (reference, e.g. actualEntry), contract}
 * Returns { d15,r15, d60,r60, d240,r240, dmin, legR:{...} } where dXX = abs points from price to
 * nearest matched-side fib level on that TF (null if no comparable leg), rXX = that fib ratio.
 */
export function fibFeatures(trade) {
  const L = loadLegs();
  const out = {};
  const px = trade.price;
  const tfKey = { '15m': '15', '1h': '60', '4h': '240' };
  for (const tf of L.tfList) {
    const k = tfKey[tf] || tf;
    const snap = legAsOf(tf, trade.entryTime, trade.contract);
    const leg = snap ? (trade.side === 'long' ? snap.up : snap.down) : null;
    if (!leg) { out['d' + k] = null; out['r' + k] = null; out['legR' + k] = null; continue; }
    let best = Infinity, bestR = null;
    for (const lv of leg.levels) { const d = Math.abs(lv.price - px); if (d < best) { best = d; bestR = lv.r; } }
    out['d' + k] = +best.toFixed(2); out['r' + k] = bestR; out['legR' + k] = leg.range;
  }
  const ds = ['15', '60', '240'].map(k => out['d' + k]).filter(v => v != null);
  out.dmin = ds.length ? Math.min(...ds) : null;
  return out;
}

/** count TFs whose matched-side nearest fib is within `prox` points; optionally OTE-only (r in [0.5,0.786]) */
export function confluenceCount(fib, prox, oteOnly = false) {
  let n = 0;
  for (const k of ['15', '60', '240']) {
    const d = fib['d' + k], r = fib['r' + k];
    if (d == null || d > prox) continue;
    if (oteOnly && !(r >= 0.5 && r <= 0.786)) continue;
    n++;
  }
  return n;
}
