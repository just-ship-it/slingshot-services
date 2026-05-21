/**
 * Phase 6 — Filter sweep under the top exit policies.
 *
 * Tests filter combinations (DOW, hour, level type, side-conditional) layered
 * onto the top Phase 5 exits (t=110/s=22 + BE 100/+10 and t=110/s=25 + BE 80/+10).
 *
 * Filters from Phase 3 candidate list:
 *   - block Thu/Fri (PF 1.22, 1.21)
 *   - block hour 10 short (PF 1.10)
 *   - block SHL level group long (PF 0.91, -$2300)
 *   - block GEX_long (put_wall longs, PF 0.90)
 *   - block S3, S5 (small but lossy levels)
 *   - block hour 10 entirely
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulateAll, stats, GOLD_POLICY } from './02-sim-exits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = path.join(__dirname, 'output', '01-trades-walk.json');
console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
console.log(`Trades: ${walks.length}\n`);

const records = [];
function run(label, cfg) {
  const r = simulateAll(walks, cfg);
  const st = stats(r);
  records.push({ label, cfg, st });
  return st;
}

function fmt(st) {
  return `n=${String(st.n).padStart(3)} $${st.pnl.toFixed(0).padStart(6)} WR=${st.wr.toFixed(0).padStart(2)}% PF=${st.pf.toFixed(2)} Sh=${st.sharpe.toFixed(2)} DD=$${st.maxDD.toFixed(0).padStart(5)}`;
}

// Top exit policies to test filters against:
const exits = {
  gold:    { target: 100, stop: 18, maxHoldMin: 180 },
  exit_t110s22_be: { target: 110, stop: 22, maxHoldMin: 180, beTrig: 100, beOff: 10 },
  exit_t110s25_be: { target: 110, stop: 25, maxHoldMin: 180, beTrig: 80,  beOff: 10 },
  exit_t140s25_be: { target: 140, stop: 25, maxHoldMin: 180, beTrig: 100, beOff: 20 },
  exit_t110s20_be: { target: 110, stop: 20, maxHoldMin: 180, beTrig: 80,  beOff: 10 },
};

// Individual filters
const filterSets = [
  { name: 'none',                    filters: {} },
  { name: 'block_Thu',               filters: { blockedDows: ['Thu'] } },
  { name: 'block_Fri',               filters: { blockedDows: ['Fri'] } },
  { name: 'block_ThuFri',            filters: { blockedDows: ['Thu', 'Fri'] } },
  { name: 'block_h10',               filters: { blockedHours: [10] } },
  { name: 'block_h10_short_only',    filters: { filterFn: w => !(w.hourEt === 10 && w.direction === 'short') } },
  { name: 'block_SHL',               filters: { blockedLevelGroups: ['SHL'] } },
  { name: 'block_SHL_long',          filters: { filterFn: w => !(w.levelType === 'SH' || w.levelType === 'SL') || w.direction !== 'long' } },
  { name: 'block_GEX',               filters: { blockedLevelGroups: ['GEX'] } },
  { name: 'block_put_wall_long',     filters: { filterFn: w => !(w.levelType === 'put_wall' && w.direction === 'long') } },
  { name: 'block_S3_S5',             filters: { blockedLevels: ['S3', 'S5'] } },
  { name: 'block_SHL+ThuFri',        filters: { blockedLevelGroups: ['SHL'], blockedDows: ['Thu','Fri'] } },
  { name: 'block_SHL+h10',           filters: { blockedLevelGroups: ['SHL'], blockedHours: [10] } },
  { name: 'block_SHL+h10short',      filters: { blockedLevelGroups: ['SHL'], filterFn: w => !(w.hourEt === 10 && w.direction === 'short') } },
  { name: 'block_SHL+ThuFri+h10short', filters: { blockedLevelGroups: ['SHL'], blockedDows: ['Thu','Fri'], filterFn: w => !(w.hourEt === 10 && w.direction === 'short') } },
  { name: 'block_SHL_long+ThuFri+GEX_long', filters: { blockedDows: ['Thu','Fri'], filterFn: w => !((['SH','SL','put_wall'].includes(w.levelType)) && w.direction === 'long') } },
];

for (const [exitName, exitCfg] of Object.entries(exits)) {
  console.log(`\n=== EXITS: ${exitName} — ${JSON.stringify(exitCfg)} ===`);
  for (const f of filterSets) {
    const cfg = { ...exitCfg, ...f.filters };
    const st = run(`${exitName}__${f.name}`, cfg);
    console.log(`  ${f.name.padEnd(35)} ${fmt(st)}`);
  }
}

// Train/test split (H1=Jan-Aug 2025 / H2=Sep 2025-Apr 2026)
const SPLIT_TS = new Date('2025-09-01T00:00:00Z').getTime();
console.log('\n\n=== TRAIN/TEST STABILITY (top exits + best filters) ===');

const stabilityCandidates = [
  { name: 'gold (no filters)',         cfg: { ...exits.gold } },
  { name: 't110s22_be100+10',          cfg: { ...exits.exit_t110s22_be } },
  { name: 't110s22_be+SHL',            cfg: { ...exits.exit_t110s22_be, blockedLevelGroups: ['SHL'] } },
  { name: 't110s22_be+ThuFri',         cfg: { ...exits.exit_t110s22_be, blockedDows: ['Thu','Fri'] } },
  { name: 't110s22_be+SHL+ThuFri',     cfg: { ...exits.exit_t110s22_be, blockedLevelGroups: ['SHL'], blockedDows: ['Thu','Fri'] } },
  { name: 't110s25_be80+10',           cfg: { ...exits.exit_t110s25_be } },
  { name: 't110s25_be80+10+SHL',       cfg: { ...exits.exit_t110s25_be, blockedLevelGroups: ['SHL'] } },
  { name: 't140s25_be100+20',          cfg: { ...exits.exit_t140s25_be } },
  { name: 't110s20_be80+10',           cfg: { ...exits.exit_t110s20_be } },
];

for (const c of stabilityCandidates) {
  const h1Walks = walks.filter(w => w.fillTs < SPLIT_TS);
  const h2Walks = walks.filter(w => w.fillTs >= SPLIT_TS);
  const allSt = stats(simulateAll(walks, c.cfg));
  const h1St  = stats(simulateAll(h1Walks, c.cfg));
  const h2St  = stats(simulateAll(h2Walks, c.cfg));
  console.log(`\n${c.name}`);
  console.log(`  ALL: ${fmt(allSt)}`);
  console.log(`  H1 : ${fmt(h1St)}`);
  console.log(`  H2 : ${fmt(h2St)}`);
}

fs.writeFileSync(path.join(__dirname, 'output', '06-sweep-filters.json'), JSON.stringify(records, null, 2));
console.log(`\nDone. ${records.length} configs. Wrote output/06-sweep-filters.json`);
