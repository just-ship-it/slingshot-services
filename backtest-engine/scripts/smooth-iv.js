#!/usr/bin/env node
/**
 * Apply rolling median smoothing to qqq_atm_iv_1m.csv to remove minute-level
 * noise. The corrected IV is honest but has 1-2pp call/put oscillations
 * minute-to-minute, causing skew sign flips and single-minute spikes that
 * trigger backtest signals not seen in live Schwab snapshots.
 *
 * See `memory/cbbo-iv-minute-noise.md` for the parity-divergence finding.
 *
 * Window: median over the prior N rows (default 5). Same-day boundary not
 * enforced — the first few rows of each trading day will mix with prior-day
 * trailing rows, but downstream filters (DTE, session) drop those minutes.
 *
 * Outputs: data/iv/qqq/qqq_atm_iv_1m_smoothed.csv
 *
 * Usage:
 *   node scripts/smooth-iv.js [--window 5]
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN_PATH = path.join(__dirname, '..', 'data', 'iv', 'qqq', 'qqq_atm_iv_1m.csv');
const OUT_PATH = path.join(__dirname, '..', 'data', 'iv', 'qqq', 'qqq_atm_iv_1m_smoothed.csv');

const args = process.argv.slice(2);
const winIdx = args.indexOf('--window');
const WINDOW = winIdx >= 0 ? parseInt(args[winIdx + 1]) : 5;

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

const rl = readline.createInterface({
  input: fs.createReadStream(IN_PATH),
});

const rows = [];
let header = null;
await new Promise((resolve) => {
  rl.on('line', (line) => {
    if (!header) {
      header = line;
      return;
    }
    rows.push(line);
  });
  rl.on('close', resolve);
});

console.log(`Loaded ${rows.length} rows from ${IN_PATH}`);
console.log(`Smoothing window: ${WINDOW} minutes (rolling median over prior ${WINDOW} rows including current)`);

// Schema: timestamp,iv,spot_price,atm_strike,call_iv,put_iv,dte,call_iv_fwd,put_iv_fwd
const out = [header];
const callBuf = [];
const putBuf = [];

for (const line of rows) {
  const cols = line.split(',');
  const ts = cols[0];
  const spot = cols[2];
  const atm = cols[3];
  const callIV = parseFloat(cols[4]);
  const putIV = parseFloat(cols[5]);
  const dte = cols[6];

  callBuf.push(callIV);
  putBuf.push(putIV);
  if (callBuf.length > WINDOW) callBuf.shift();
  if (putBuf.length > WINDOW) putBuf.shift();

  const smoothCall = median(callBuf);
  const smoothPut = median(putBuf);
  const smoothIv = (smoothCall + smoothPut) / 2;

  // Keep call_iv_fwd/put_iv_fwd as the smoothed values too (downstream readers
  // use _fwd for live-stream-mirror logic but here we treat both identically).
  out.push([
    ts,
    smoothIv.toFixed(4),
    spot,
    atm,
    smoothCall.toFixed(4),
    smoothPut.toFixed(4),
    dte,
    smoothIv.toFixed(4),
    smoothIv.toFixed(4),
  ].join(','));
}

fs.writeFileSync(OUT_PATH, out.join('\n'));
console.log(`Wrote ${rows.length} smoothed rows to ${OUT_PATH}`);

// Compare distribution before/after
const rawSkews = rows.map((l) => {
  const c = l.split(',');
  return parseFloat(c[5]) - parseFloat(c[4]);
});
const smoothSkews = out.slice(1).map((l) => {
  const c = l.split(',');
  return parseFloat(c[5]) - parseFloat(c[4]);
});

const stats = (arr, name) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  console.log(`${name}: stdev=${sd.toFixed(4)} mean=${mean.toFixed(4)} p10=${sorted[Math.floor(n*0.1)].toFixed(4)} p50=${sorted[Math.floor(n*0.5)].toFixed(4)} p90=${sorted[Math.floor(n*0.9)].toFixed(4)}`);
};

console.log('\n=== Skew distribution ===');
stats(rawSkews, 'Raw   ');
stats(smoothSkews, 'Smooth');

// Count cross-zero flips (consecutive minutes with opposite skew sign)
const flips = (arr) => {
  let n = 0;
  for (let i = 1; i < arr.length; i++) {
    if ((arr[i] > 0) !== (arr[i - 1] > 0)) n++;
  }
  return n;
};
console.log(`\nSkew sign flips:  raw=${flips(rawSkews)}  smoothed=${flips(smoothSkews)}`);

// Count threshold crossings (above ±1.25%)
const triggers = (arr) => {
  let longs = 0, shorts = 0;
  for (const s of arr) {
    if (s < -0.015) longs++;
    if (s > 0.0125) shorts++;
  }
  return { longs, shorts };
};
const rawT = triggers(rawSkews);
const smT = triggers(smoothSkews);
console.log(`\nThreshold hits (skew<-1.5% LONG, >+1.25% SHORT):`);
console.log(`  Raw    : LONG=${rawT.longs}  SHORT=${rawT.shorts}  total=${rawT.longs + rawT.shorts}`);
console.log(`  Smooth : LONG=${smT.longs}  SHORT=${smT.shorts}  total=${smT.longs + smT.shorts}`);
console.log(`  Reduction: ${(1 - (smT.longs + smT.shorts) / (rawT.longs + rawT.shorts)).toFixed(2) * 100}%`);
