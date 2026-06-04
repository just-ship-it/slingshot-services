#!/usr/bin/env node
/**
 * Step 08 — Live vs backtest GAMMA REGIME agreement.
 * Live source  = data/schwab-walls/qqq_walls_*.json (the live ExposureCalculator's total_gex).
 * Backtest src = data/gex/nq-cbbo/nq_gex_*.json     (CBBO IV — what the filter was validated on).
 * Both are QQQ-derived net gamma; regime = sign(total_gex) (the filter's definition). The only
 * difference is the IV/exposure pipeline (Schwab vs CBBO) — exactly what we want to validate.
 *
 * For each overlapping day, align each cbbo snapshot to the nearest schwab-walls snapshot
 * (within TOL) and compare regime sign. Reports agreement % + disagreements.
 * node research/portfolio-filter/08-regime-source-agreement.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOL_MS = 10 * 60000;
const sign = g => (Number.isFinite(g) ? (g >= 0 ? 'positive' : 'negative') : null);

function loadWalls(date) {
  const f = path.join(ROOT, 'data/schwab-walls', `qqq_walls_${date}.json`);
  if (!fs.existsSync(f)) return null;
  return (JSON.parse(fs.readFileSync(f, 'utf8')).data || [])
    .map(s => ({ ts: new Date(s.timestamp).getTime(), reg: sign(s.total_gex) })).filter(x => x.reg && Number.isFinite(x.ts));
}
function loadCbbo(date) {
  const f = path.join(ROOT, 'data/gex/nq-cbbo', `nq_gex_${date}.json`);
  if (!fs.existsSync(f)) return null;
  return (JSON.parse(fs.readFileSync(f, 'utf8')).data || [])
    .map(s => ({ ts: new Date(s.timestamp).getTime(), reg: sign(s.total_gex) })).filter(x => x.reg && Number.isFinite(x.ts));
}
const nearest = (arr, t) => { let best = null, bd = Infinity; for (const x of arr) { const d = Math.abs(x.ts - t); if (d < bd) { bd = d; best = x; } } return bd <= TOL_MS ? best : null; };

// Auto-discover every date present in BOTH sources.
const wallsDates = new Set(fs.readdirSync(path.join(ROOT, 'data/schwab-walls')).map(f => (f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1]).filter(Boolean));
const cbboDates = new Set(fs.readdirSync(path.join(ROOT, 'data/gex/nq-cbbo')).map(f => (f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1]).filter(Boolean));
const DATES = [...wallsDates].filter(d => cbboDates.has(d)).sort();
const regMix = arr => { const p = arr.filter(x => x.reg === 'positive').length; return `${p}+/${arr.length - p}-`; };

let totMatch = 0, totN = 0, posM = 0, posN = 0, negM = 0, negN = 0;
console.log('Live (schwab-walls / ExposureCalculator) vs Backtest (nq-cbbo / CBBO) — regime = sign(total_gex)\n');
console.log('  date         pairs   agree%   bt-mix(live-mix)   disagreements');
for (const d of DATES) {
  const live = loadWalls(d), bt = loadCbbo(d);
  if (!live || !bt) continue;
  let n = 0, m = 0; const dis = [];
  for (const c of bt) {
    const l = nearest(live, c.ts); if (!l) continue; n++;
    const ok = l.reg === c.reg; if (ok) m++; else dis.push(`${new Date(c.ts).toISOString().slice(11,16)} bt=${c.reg[0]}/live=${l.reg[0]}`);
    if (c.reg === 'positive') { posN++; if (ok) posM++; } else { negN++; if (ok) negM++; }
  }
  if (!n) continue;
  totMatch += m; totN += n;
  console.log(`  ${d}   ${String(n).padStart(4)}   ${(100*m/n).toFixed(1).padStart(5)}%   ${regMix(bt).padStart(8)}(${regMix(live)})   ${dis.slice(0,4).join('  ')}${dis.length>4?` …(+${dis.length-4})`:''}`);
}
console.log(`\n  OVERALL agreement: ${(100*totMatch/totN).toFixed(1)}%  (${totMatch}/${totN} intraday snapshots, ${DATES.length} days)`);
console.log(`  by regime (backtest label): positive ${posN?(100*posM/posN).toFixed(1):'–'}% (${posN})   negative ${negN?(100*negM/negN).toFixed(1):'–'}% (${negN})`);
console.log(`  → BOTH regimes must be represented for this to be decisive (negative count > 0).`);
console.log('  High agreement → live ExposureCalculator regime ≈ backtest CBBO regime → filter behaves as validated.');
console.log('  (Only 4 days here; run scripts/calc-schwab-walls-day.js over data/schwab-snapshots/ for ~3-4 weeks.)');
