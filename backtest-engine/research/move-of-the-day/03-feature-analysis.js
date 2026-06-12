// Phase 2a — Univariate feature analysis: which decision-time features predict
// a signal's realized pointsPnL? Edge tables (mean pts, WR, n) per feature bucket.
// Split H1/H2 by date to check stability (no model fit here, just signal hunting).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, 'output');
const signals = JSON.parse(fs.readFileSync(path.join(OUT, 'signals.json'), 'utf8'))
  .filter(s => s.inRTH);

// chronological split
const sorted = [...signals].sort((a, b) => a.entryTs - b.entryTs);
const mid = sorted[Math.floor(sorted.length / 2)].sessionDateET;
const H1 = sorted.filter(s => s.sessionDateET < mid);
const H2 = sorted.filter(s => s.sessionDateET >= mid);
console.log(`Signals: ${signals.length}  split @ ${mid}  H1=${H1.length} H2=${H2.length}\n`);

function table(set, keyFn, label) {
  const g = new Map();
  for (const s of set) {
    const k = keyFn(s);
    if (k == null || k === undefined || (typeof k === 'number' && !isFinite(k))) continue;
    let b = g.get(k); if (!b) { b = []; g.set(k, b); }
    b.push(s.outcome.pointsPnL);
  }
  const rows = [...g.entries()].map(([k, arr]) => {
    const n = arr.length, sum = arr.reduce((a, b) => a + b, 0);
    const wins = arr.filter(x => x > 0).length;
    return { k, n, mean: sum / n, total: sum, wr: wins / n * 100 };
  }).filter(r => r.n >= 15).sort((a, b) => b.mean - a.mean);
  console.log(`--- ${label} (n>=15, sorted by mean pts) ---`);
  for (const r of rows) {
    console.log(`  ${String(r.k).padEnd(22)} mean ${r.mean.toFixed(1).padStart(7)}pt  WR ${r.wr.toFixed(0).padStart(3)}%  n ${String(r.n).padStart(4)}  tot ${r.total.toFixed(0).padStart(7)}`);
  }
  return g;
}

// helper bucket fns
const hourBucket = s => s.entryHourET;
const sideKey = s => s.side;
const stratKey = s => s.strategy;
const stratSide = s => `${s.strategy}/${s.side}`;
const stratHour = s => `${s.strategy}@${s.entryHourET}`;
const dow = s => s.dowName;

console.log('===== FULL SET =====\n');
table(signals, stratKey, 'strategy');
table(signals, sideKey, 'side');
table(signals, hourBucket, 'entry hour ET');
table(signals, stratSide, 'strategy/side');
table(signals, dow, 'day of week');
table(signals, stratHour, 'strategy@hour');

// strategy-specific feature edges
console.log('\n===== STRATEGY-SPECIFIC FEATURES =====\n');
table(signals.filter(s => s.strategy === 'glx'), s => s.features.ruleId, 'glx ruleId');
table(signals.filter(s => s.strategy === 'glx'), s => `lt${s.features.ltIdx}`, 'glx ltIdx');
table(signals.filter(s => s.strategy === 'gfi'), s => s.features.gexRegime, 'gfi gexRegime');
table(signals.filter(s => s.strategy === 'gfi'), s => s.features.ruleId, 'gfi ruleId');
table(signals.filter(s => s.strategy === 'gfi'), s => `ivPct${Math.floor((s.features.ivPercentile ?? 0) / 20) * 20}`, 'gfi ivPercentile bucket');
table(signals.filter(s => s.strategy === 'glf'), s => s.features.levelType, 'glf levelType');

// stability check: strategy/side mean in H1 vs H2
console.log('\n===== STABILITY: strategy mean pts H1 vs H2 =====');
for (const st of ['glx', 'glf', 'gfi', 'lstb']) {
  const h1 = H1.filter(s => s.strategy === st).map(s => s.outcome.pointsPnL);
  const h2 = H2.filter(s => s.strategy === st).map(s => s.outcome.pointsPnL);
  const m = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 'na';
  console.log(`  ${st.padEnd(5)} H1 ${String(m(h1)).padStart(7)}pt (n${h1.length})   H2 ${String(m(h2)).padStart(7)}pt (n${h2.length})`);
}
