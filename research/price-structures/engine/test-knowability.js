#!/usr/bin/env node
/**
 * Knowability replay test (phase-1 gate).
 *   1. Run the engine over a window → E_full.
 *   2. For K random cut instants T: run the engine over only bars closed by T → E_cut.
 *      Assert E_cut === E_full filtered to ts <= T (exact JSON equality, same order).
 *   3. For every event: every anchor.confirmedAt <= ts and anchor.ts <= ts.
 * Any dependence on future bars (repainting pivots, boundary values, features) breaks (2).
 *
 *   node test-knowability.js --product NQ --start 2024-03-04 --end 2024-03-08 --cuts 8 [--tfs ...] [--detectors ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PatternEngine } from '../../../shared/pattern-engine/engine.js';
import { loadDetectors } from '../../../shared/pattern-engine/patterns/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const product = (args.product || 'NQ').toUpperCase();
const start = args.start || '2024-03-04', end = args.end || '2024-03-08';
const tfs = (args.tfs || '1m,3m,5m,15m,30m,1h,4h,1d').split(',');
const K = +(args.cuts || 6);
const detectors = await loadDetectors(args.detectors || 'all');

// load bars
const bars = [];
const csv = path.join(ROOT, `backtest-engine/greenfield/explore/cache/${product}_1m_primary.csv`);
const rl = readline.createInterface({ input: fs.createReadStream(csv), crlfDelay: Infinity });
const s0 = Date.parse(start + 'T00:00:00Z') - 3 * 86400000, e0 = Date.parse(end + 'T23:59:59Z') + 86400000;
let header = true;
for await (const line of rl) {
  if (header) { header = false; continue; }
  if (!line) continue;
  const c = line.indexOf(','); const ts = Date.parse(line.slice(0, c));
  if (ts < s0) continue; if (ts > e0) break;
  const f = line.split(',');
  bars.push({ ts, open: +f[4], high: +f[5], low: +f[6], close: +f[7], volume: +f[8], symbol: f[9] });
}
console.log(`bars: ${bars.length}  detectors: ${detectors.map((d) => d.id).join(',')}  tfs: ${tfs.join(',')}`);

function run(upToTs) {
  const eng = new PatternEngine({ product, timeframes: tfs, detectors });
  const out = [];
  for (const b of bars) { if (upToTs != null && b.ts + 60000 > upToTs) break; for (const e of eng.onBar1m(b)) out.push(JSON.stringify(e)); }
  return out;
}
const t0 = Date.now();
const full = run(null);
console.log(`full run: ${full.length} events in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// (3) anchor knowability
let bad = 0;
for (const s of full) {
  const e = JSON.parse(s); const ts = Date.parse(e.ts);
  for (const a of e.anchors) if (a.confirmedAt > ts || a.ts > ts) { bad++; if (bad < 5) console.log('ANCHOR LOOKAHEAD', e.instanceId, e.state, a); }
}
console.log(`anchor check: ${bad === 0 ? 'PASS' : 'FAIL ' + bad}`);

// (2) truncation replay
let fails = 0;
const seed = 12345; let r = seed; const rnd = () => (r = (r * 1103515245 + 12345) % 2147483648) / 2147483648;
const lo = Date.parse(start + 'T00:00:00Z') + 86400000, hi = Date.parse(end + 'T00:00:00Z');
for (let i = 0; i < K; i++) {
  const T = lo + Math.floor(rnd() * (hi - lo) / 60000) * 60000;
  const cut = run(T);
  const expect = full.filter((s) => Date.parse(JSON.parse(s).ts) <= T);
  let ok = cut.length === expect.length;
  let firstDiff = -1;
  if (ok) for (let j = 0; j < cut.length; j++) if (cut[j] !== expect[j]) { ok = false; firstDiff = j; break; }
  console.log(`cut ${new Date(T).toISOString()}  cut=${cut.length} expect=${expect.length}  ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) {
    fails++;
    if (firstDiff >= 0) { console.log('  cut   :', cut[firstDiff].slice(0, 300)); console.log('  expect:', expect[firstDiff].slice(0, 300)); }
    else { const a = new Set(expect); const b = new Set(cut); const onlyCut = cut.filter((x) => !a.has(x)); const onlyExp = expect.filter((x) => !b.has(x)); console.log('  only in cut:', onlyCut.slice(0, 2).map((x) => x.slice(0, 200))); console.log('  only in expect:', onlyExp.slice(0, 2).map((x) => x.slice(0, 200))); }
  }
}
console.log(fails === 0 && bad === 0 ? 'KNOWABILITY: PASS' : `KNOWABILITY: FAIL (${fails} cuts, ${bad} anchors)`);
process.exit(fails === 0 && bad === 0 ? 0 : 1);
