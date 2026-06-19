// Phase 2 — 1s-honest verification of the Phase-1 "cap level" candidates.
//
// For each candidate (loss/BE trade whose engine-reported MFE peak stalled at a GEX
// level short of target), we re-walk the 1s OHLCV (filtered to the trade's actual
// contract via signalContract) to:
//   1. recompute the MFE peak magnitude AND its exact timestamp (engine doesn't store ts)
//   2. cross-check recomputed MFE vs the gold-JSON MFE (mandate #6 sanity)
//   3. re-find the nearest GEX cap level using ONLY snapshots KNOWN AT/BEFORE the peak
//      (getGexLevels returns the most-recent snapshot <= peak ts) -> kills the Phase-1
//      lookahead risk that a level formed AFTER the peak.
//
// Output: output/verified.json  (+ console table)

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { GexLoader } from '../../src/data-loaders/gex-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'output');
const ONE_S = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv');
const TOUCH = 12;

const cand = JSON.parse(fs.readFileSync(path.join(OUT, 'victims.json'), 'utf8')).victims;
// windows keyed for the 1s walk
const wins = cand.map(c => ({
  c,
  contract: c.contract,
  startMs: Date.parse(c.entryTime),
  endMs: Date.parse(c.exitTime),
  startIso: c.entryTime,
  endIso: c.exitTime,
  dir: c.side === 'long' ? 1 : -1,
  // running MFE state
  bestPrice: null, bestMs: null,
}));
const globalStartIso = wins.reduce((a, w) => w.startIso < a ? w.startIso : a, wins[0].startIso);
const globalEndIso = wins.reduce((a, w) => w.endIso > a ? w.endIso : a, wins[0].endIso);

console.log(`verifying ${wins.length} candidates; streaming 1s from ${globalStartIso} .. ${globalEndIso}`);

function walk1s() {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(ONE_S, { highWaterMark: 1 << 20 }) });
    let n = 0, used = 0, first = true;
    rl.on('line', (line) => {
      if (first) { first = false; return; } // header
      // cheap ts extract (fixed leading ISO field)
      const c1 = line.indexOf(',');
      const ts = line.slice(0, c1);
      if (ts < globalStartIso) return;
      if (ts > globalEndIso) { rl.close(); return; }
      n++;
      // symbol is last field
      const symbol = line.slice(line.lastIndexOf(',') + 1);
      // check against windows (sparse; break-friendly)
      for (const w of wins) {
        if (symbol !== w.contract) continue;
        if (ts < w.startIso || ts > w.endIso) continue;
        // parse high/low only when needed
        const f = line.split(',');
        const high = +f[5], low = +f[6];
        const fav = w.dir === 1 ? high : low;
        if (w.bestPrice === null || (w.dir === 1 ? fav > w.bestPrice : fav < w.bestPrice)) {
          w.bestPrice = fav;
          w.bestMs = Date.parse(ts);
        }
        used++;
      }
    });
    rl.on('close', () => { console.log(`  scanned ${n} in-range rows, ${used} matched window+contract`); resolve(); });
    rl.on('error', reject);
  });
}

function enumLevels(snap) {
  const out = [];
  if (snap.gamma_flip) out.push(['gamma_flip', snap.gamma_flip]);
  if (snap.call_wall) out.push(['call_wall', snap.call_wall]);
  if (snap.put_wall) out.push(['put_wall', snap.put_wall]);
  (snap.resistance || []).forEach((v, i) => { if (v) out.push([`R${i + 1}`, v]); });
  (snap.support || []).forEach((v, i) => { if (v) out.push([`S${i + 1}`, v]); });
  return out;
}

async function main() {
  await walk1s();

  const gex = new GexLoader(path.join(ROOT, 'data/gex/nq-cbbo'), 'nq');
  await gex.loadDateRange(new Date(Date.parse(globalStartIso) - 2 * 86400000), new Date(Date.parse(globalEndIso) + 86400000));

  const rows = [];
  for (const w of wins) {
    const c = w.c;
    if (w.bestPrice === null) { rows.push({ id: c.id, note: 'NO 1s ROWS MATCHED' }); continue; }
    const recompMfe = w.dir === 1 ? w.bestPrice - c.entry : c.entry - w.bestPrice;
    const peakMs = w.bestMs;
    // GEX snapshot known AT/BEFORE the peak
    const snapAtPeak = gex.getGexLevels(new Date(peakMs));        // ts <= peakMs
    const snapAtEntry = gex.getGexLevels(new Date(w.startMs));
    let cap = null;
    if (snapAtPeak) {
      for (const [name, val] of enumLevels(snapAtPeak)) {
        const between = w.dir === 1 ? (val > c.entry && val < c.tp) : (val < c.entry && val > c.tp);
        if (!between) continue;
        const d = Math.abs(w.bestPrice - val);
        if (d > TOUCH) continue;
        if (!cap || d < cap.dist) cap = { name, val, dist: d, gapToTarget: Math.abs(c.tp - val) };
      }
    }
    const knownAtEntry = cap && snapAtEntry
      ? enumLevels(snapAtEntry).some(([, v]) => Math.abs(v - cap.val) <= TOUCH) : false;
    rows.push({
      id: c.id, strat: c.strat, side: c.side, outcome: c.outcome, exitReason: c.exitReason,
      entry: c.entry, tp: c.tp, targetDist: c.targetDist, netPnL: c.netPnL,
      jsonMfe: c.mfePoints, recompMfe: +recompMfe.toFixed(2),
      mfeMatch: +(Math.abs(recompMfe - c.mfePoints) <= Math.max(2, 0.1 * c.mfePoints)),
      peakTs: new Date(peakMs).toISOString(),
      capLevel: cap ? cap.name : null,
      capVal: cap ? +cap.val.toFixed(2) : null,
      capDistFromPeak: cap ? +cap.dist.toFixed(2) : null,
      capGapToTarget: cap ? +cap.gapToTarget.toFixed(2) : null,
      capKnownBeforePeak: cap ? 1 : 0,          // by construction snap ts <= peak
      capFormedDuringTrade: cap ? (knownAtEntry ? 0 : 1) : 0,
      confirmed: cap ? 1 : 0,                    // a level was known at/before peak within TOUCH
    });
  }

  // report
  const confirmed = rows.filter(r => r.confirmed);
  const mfeMismatch = rows.filter(r => r.recompMfe != null && !r.mfeMatch);
  console.log('\n=== 1s VERIFICATION ===');
  console.table(rows.map(r => ({
    id: r.id, side: r.side, out: r.outcome, jsonMfe: r.jsonMfe, recompMfe: r.recompMfe,
    tgt: r.targetDist, cap: r.capLevel, capDist: r.capDistFromPeak, gap2tgt: r.capGapToTarget,
    formedMid: r.capFormedDuringTrade, conf: r.confirmed, net$: r.netPnL,
  })));
  console.log(`confirmed (cap level known AT/BEFORE peak, within ${TOUCH}pt): ${confirmed.length}/${rows.length}`);
  console.log(`  of those, level formed DURING the trade (after entry): ${confirmed.filter(r => r.capFormedDuringTrade).length}`);
  console.log(`  net $ on confirmed: ${Math.round(confirmed.reduce((s, r) => s + r.netPnL, 0))}`);
  console.log(`  near-target (gap<=20pt): ${confirmed.filter(r => r.capGapToTarget <= 20).length}`);
  if (mfeMismatch.length) {
    console.log(`\n!! MFE mismatch (recomputed vs json >10%): ${mfeMismatch.length}`);
    for (const r of mfeMismatch) console.log(`   ${r.id}: json ${r.jsonMfe} vs 1s ${r.recompMfe}`);
  } else {
    console.log('\nMFE cross-check: all candidates match gold-JSON within tol (1s-honest confirmed).');
  }

  fs.writeFileSync(path.join(OUT, 'verified.json'), JSON.stringify({ TOUCH, rows }, null, 2));
  console.log(`\nwrote ${path.join(OUT, 'verified.json')}`);
}

main();
