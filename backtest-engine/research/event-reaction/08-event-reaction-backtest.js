/**
 * Event-Reaction Backtest — 1s-honest, book-calibrated slippage, NQ or ES.
 *
 * Consolidates the research (Phases 0-5) into one parameterized backtest that
 * runs the fast post-release momentum strategy over the full 1s history.
 *
 * DATA: event-windows-1s-<PRODUCT>.csv (Phase 0 extraction) — primary-contract 1s
 * OHLCV in [release-30m, +90m] for every FRED release. 1s OHLCV is all that's
 * needed for the price path; the ONE thing it can't carry is bid/ask, so entry
 * slippage is a CALIBRATED charge from the mbp-1 book study (06):
 *   +3s ≈ 4.0pt, +5s ≈ 2.25pt, +10s ≈ 0.5pt (NQ). ES scaled ~0.45× (ESTIMATE —
 *   not yet book-calibrated; ES mbp-1 calibration is a TODO).
 *
 * ENTRY (per release, tradeable types CPI/NFP/PCE/PPI):
 *   P_ref = close of the 1s bar at rel=-1 (last pre-release price).
 *   impulse = close@ENTRY_SEC - P_ref;  dir = sign(impulse).
 *   PERSISTENCE sweep-guard: require sign@PERSIST_SEC == dir, else SKIP (a down-
 *   sweep-then-up shows as disagreement and is skipped — see 07-sweep-analysis).
 *   MAGNITUDE gate: skip if |impulse| < MIN_IMPULSE.
 *   SIDE filter: both | long | short.
 *   Fill = close@ENTRY_SEC ± ENTRY_SLIP (market, minimal-latency assumption).
 *
 * EXIT (1s-honest walk from the fill bar forward — CLAUDE.md fill rules):
 *   target = passive limit, fills at exact tgt price (no slippage).
 *   stop   = market, fills at stop price ± STOP_SLIP.
 *   time-stop at MAX_HOLD → exit at that bar's close.
 *   stop checked before target within a bar (conservative).
 *
 * Usage:
 *   node research/event-reaction/08-event-reaction-backtest.js --product NQ \
 *     [--entry 5] [--persist 3] [--no-persist] [--min-impulse 0] \
 *     [--tgt 60] [--stop 30] [--maxhold 300] [--side both] \
 *     [--entry-slip <pts>] [--stop-slip 1.5] [--types CPI,NFP,PCE,PPI]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');

function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; }
function flag(n) { return process.argv.includes(`--${n}`); }

const PRODUCT = arg('product', 'NQ').toUpperCase();
const ENTRY_SEC = parseFloat(arg('entry', '5'));
const PERSIST_SEC = parseFloat(arg('persist', '3'));
const USE_PERSIST = !flag('no-persist');
const MIN_IMPULSE = parseFloat(arg('min-impulse', '0'));
const SIDE = arg('side', 'both');
const MAX_HOLD = parseInt(arg('maxhold', '300'), 10);
const TYPES = new Set(arg('types', 'CPI,NFP,PCE,PPI').split(','));

const POINT_VALUE = PRODUCT === 'ES' ? 50 : 20;
// product-aware default target/stop (ES ~price-ratio scaled from NQ 60/30)
const TGT = parseFloat(arg('tgt', PRODUCT === 'ES' ? '18' : '60'));
const STOP = parseFloat(arg('stop', PRODUCT === 'ES' ? '9' : '30'));
// book-calibrated entry slippage by entry time (NQ); ES scaled ~0.45×
const NQ_SLIP = { 3: 4.0, 5: 2.25, 10: 0.5 };
const baseSlip = NQ_SLIP[ENTRY_SEC] ?? 2.0;
const ENTRY_SLIP = parseFloat(arg('entry-slip', String((PRODUCT === 'ES' ? 0.45 : 1) * baseSlip)));
const STOP_SLIP = parseFloat(arg('stop-slip', PRODUCT === 'ES' ? '0.75' : '1.5'));
const COMMISSION = parseFloat(arg('commission', '0.2'));

const BARS_FILE = path.join(OUT_DIR, `event-windows-1s-${PRODUCT}.csv`);

function load() {
  const lines = fs.readFileSync(BARS_FILE, 'utf8').trim().split('\n');
  const col = {}; lines[0].split(',').forEach((h, i) => (col[h] = i));
  const ev = new Map();
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    if (!TYPES.has(c[col.event_type])) continue;
    const id = c[col.event_id];
    if (!ev.has(id)) ev.set(id, { id, type: c[col.event_type], date: id.split('_')[0], bars: [] });
    ev.get(id).bars.push({ rel: +c[col.rel_sec], h: +c[col.high], l: +c[col.low], c: +c[col.close] });
  }
  const arr = [...ev.values()];
  for (const e of arr) e.bars.sort((a, b) => a.rel - b.rel);
  arr.sort((a, b) => (a.date < b.date ? -1 : 1)); // chronological
  return arr;
}
const priceAt = (bars, r) => { let p = null; for (const b of bars) { if (b.rel <= r) p = b.c; else break; } return p; };

function simEvent(e) {
  const pRef = priceAt(e.bars, -1);
  const pEntry = priceAt(e.bars, ENTRY_SEC);
  if (pRef == null || pEntry == null) return null;
  const dir = Math.sign(pEntry - pRef);
  if (dir === 0) return null;
  if (USE_PERSIST) {
    const dChk = Math.sign(priceAt(e.bars, PERSIST_SEC) - pRef);
    if (dChk !== dir) return { skipped: 'sweep' };
  }
  if (Math.abs(pEntry - pRef) < MIN_IMPULSE) return { skipped: 'gate' };
  if (SIDE === 'long' && dir < 0) return { skipped: 'side' };
  if (SIDE === 'short' && dir > 0) return { skipped: 'side' };

  const entryFill = pEntry + dir * ENTRY_SLIP;           // market entry slippage
  const tgtPx = dir > 0 ? entryFill + TGT : entryFill - TGT;
  const stopPx = dir > 0 ? entryFill - STOP : entryFill + STOP;
  let gross = null;
  for (const b of e.bars) {
    if (b.rel <= ENTRY_SEC) continue;
    if (b.rel > ENTRY_SEC + MAX_HOLD) break;
    const hitStop = dir > 0 ? b.l <= stopPx : b.h >= stopPx;
    const hitTgt = dir > 0 ? b.h >= tgtPx : b.l <= tgtPx;
    if (hitStop) { gross = -STOP - STOP_SLIP; break; }    // stop before target (conservative)
    if (hitTgt) { gross = TGT; break; }                   // passive limit, exact
  }
  if (gross == null) { const last = priceAt(e.bars, ENTRY_SEC + MAX_HOLD); gross = dir * (last - entryFill); }
  return { type: e.type, date: e.date, dir, net: gross - COMMISSION };
}

function metrics(trades) {
  const f = trades.filter((t) => t && t.net != null && !t.skipped);
  let wins = 0, gp = 0, gl = 0, tot = 0;
  let peak = 0, cum = 0, maxDD = 0;
  const rets = [];
  for (const t of f) {
    tot += t.net; cum += t.net * POINT_VALUE; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
    rets.push(t.net);
    if (t.net > 0) { wins++; gp += t.net; } else gl += -t.net;
  }
  const n = f.length;
  const mean = n ? tot / n : 0;
  const sd = n > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, wr: n ? wins / n * 100 : 0, pf: gl ? gp / gl : (gp > 0 ? Infinity : 0),
           avg: mean, tot, totUsd: tot * POINT_VALUE, maxDDUsd: maxDD, sharpe: sd ? mean / sd : 0 };
}
const pf = (m) => (m.pf === Infinity ? '∞' : m.pf.toFixed(2));
const row = (lbl, m) => [lbl, m.n, m.wr.toFixed(0) + '%', pf(m), m.avg.toFixed(1), `$${m.totUsd.toFixed(0)}`, `$${m.maxDDUsd.toFixed(0)}`, m.sharpe.toFixed(2)].join('\t');

const EVENTS = load();
const results = EVENTS.map(simEvent);
const traded = results.filter((r) => r && !r.skipped);
const skips = results.filter((r) => r && r.skipped);
const skipMix = skips.reduce((m, r) => ((m[r.skipped] = (m[r.skipped] || 0) + 1), m), {});

console.log(`\n=== EVENT-REACTION BACKTEST — ${PRODUCT} ===`);
console.log(`entry +${ENTRY_SEC}s | persist@${PERSIST_SEC}s ${USE_PERSIST ? 'ON' : 'off'} | minImpulse ${MIN_IMPULSE} | side ${SIDE}`);
console.log(`tgt ${TGT} / stop ${STOP} / maxhold ${MAX_HOLD}s | entrySlip ${ENTRY_SLIP} | stopSlip ${STOP_SLIP} | comm ${COMMISSION} | $${POINT_VALUE}/pt`);
console.log(`events(${[...TYPES].join('/')}): ${EVENTS.length} | traded ${traded.length} | skipped ${skips.length} ${JSON.stringify(skipMix)}\n`);

console.log(['group', 'n', 'WR', 'PF', 'avgPt', '$total', '$maxDD', 'Sharpe'].join('\t'));
console.log(row('ALL', metrics(traded)));
for (const t of [...TYPES]) { const m = metrics(traded.filter((r) => r.type === t)); if (m.n) console.log(row(t, m)); }
console.log(row('LONG', metrics(traded.filter((r) => r.dir > 0))));
console.log(row('SHORT', metrics(traded.filter((r) => r.dir < 0))));

const mid = Math.floor(traded.length / 2);
console.log('\ntrain/test (chronological halves):');
console.log(row('H1', metrics(traded.slice(0, mid))));
console.log(row('H2', metrics(traded.slice(mid))));
console.log('\nNOTE: entry slippage is book-calibrated for NQ (mbp-1 study, 06); ES slippage is an');
console.log('ESTIMATE (~0.45× NQ) pending ES mbp-1 calibration. target=passive limit, stop=market.');
