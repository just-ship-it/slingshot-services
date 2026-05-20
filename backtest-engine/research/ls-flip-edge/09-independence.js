/**
 * Phase F — Independence check vs production trio.
 *
 * For each candidate, check temporal overlap with the three production gold
 * standards: gex-flip-ivpct (tight), gex-lt-3m-crossover, gex-level-fade.
 *
 * Two overlap metrics:
 *   1. Entry-overlap: % of candidate trades whose entry falls inside ANY
 *      production trade's [entryTime, exitTime] window.
 *   2. Concurrent: % of candidate trades that share at least 1 minute of
 *      hold time with a production trade.
 *
 * Goal: a "genuinely new" strategy should have <30% entry overlap and the
 * remaining trades should make most of the candidate's PnL.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GS_DIR = path.resolve(__dirname, '../..', 'data', 'gold-standard');
const CAND_DIR = path.join(__dirname, 'output');
const OUT = path.join(__dirname, 'output', '09-independence.txt');

const GOLD_FILES = [
  { name: 'gex-flip-ivpct-tight', path: path.join(GS_DIR, 'gex-flip-ivpct-tight-s60t200be70.json') },
  { name: 'gex-lt-3m-crossover',   path: path.join(GS_DIR, 'gex-lt-3m-crossover.json') },
  { name: 'gex-level-fade',        path: path.join(GS_DIR, 'gex-level-fade.json') },
  { name: 'iv-skew-gex-cbbo-gold', path: path.join(GS_DIR, 'iv-skew-gex-cbbo-gold-standard.json') },
];

const CANDIDATES = [
  'candidate-B-s40-t120.json',
  'candidate-B-s40-t60.json',
  'candidate-B-s25-t60.json',
  'candidate-B-s25-t30.json',
];

function loadGold(p) {
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const trades = Array.isArray(data) ? data : (data.trades || []);
  return trades
    .map(t => ({
      entry: t.entryTime || t.actualEntry?.timestamp || t.timestamp,
      exit: t.exitTime || t.actualExit?.timestamp || t.timestamp,
      side: t.side,
      symbol: t.symbol,
      strategy: t.strategy,
      pnl: t.pointsPnL ?? t.netPnL ?? 0,
    }))
    .filter(t => t.entry && t.exit);
}

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

emit(`\n=== Phase F — Independence check vs production trio ===\n`);

const golds = {};
for (const g of GOLD_FILES) {
  if (!fs.existsSync(g.path)) {
    emit(`  WARN: missing ${g.name} (${g.path})`);
    continue;
  }
  golds[g.name] = loadGold(g.path);
  emit(`  loaded ${g.name}: ${golds[g.name].length} trades`);
}

for (const candFile of CANDIDATES) {
  const candPath = path.join(CAND_DIR, candFile);
  if (!fs.existsSync(candPath)) continue;
  const candTrades = JSON.parse(fs.readFileSync(candPath, 'utf-8'));

  emit(`\n--- ${candFile} (${candTrades.length} trades) ---`);

  let totalOverlap = 0;
  let perStrategyOverlap = {};
  let nonOverlapTrades = [...candTrades];
  let overlappedTrades = new Set();

  for (const gName in golds) {
    const gTrades = golds[gName];
    let overlap = 0;
    let overlapPnL = 0;
    let sideAgree = 0;
    let sideDisagree = 0;
    for (let i = 0; i < candTrades.length; i++) {
      const c = candTrades[i];
      // Check overlap: candidate entry within any production trade's window
      // OR candidate hold spans any production entry
      const candEntry = c.ts;
      const candExit = c.ts + 60 * 60 * 1000; // approximate — 60 min max hold
      for (const g of gTrades) {
        const overlaps = !(candExit < g.entry || candEntry > g.exit);
        if (overlaps) {
          overlap++;
          overlapPnL += c.pnl_pts;
          overlappedTrades.add(i);
          if (c.side === g.side) sideAgree++; else sideDisagree++;
          break; // only count once per candidate
        }
      }
    }
    perStrategyOverlap[gName] = { overlap, overlapPnL, sideAgree, sideDisagree };
    emit(`  vs ${gName.padEnd(28)}  overlap=${overlap}/${candTrades.length} (${(overlap / candTrades.length * 100).toFixed(1)}%)  same-side=${sideAgree}  opposite=${sideDisagree}  overlap_pnl=${overlapPnL.toFixed(0)}pts`);
  }

  // Total unique overlap
  emit(`  Unique overlap (any production strategy): ${overlappedTrades.size}/${candTrades.length} (${(overlappedTrades.size / candTrades.length * 100).toFixed(1)}%)`);

  // Standalone PnL: only candidate trades that do NOT overlap any production trade
  let standaloneN = 0, standalonePnL = 0, standaloneWins = 0, sgp = 0, sgl = 0;
  for (let i = 0; i < candTrades.length; i++) {
    if (overlappedTrades.has(i)) continue;
    standaloneN++;
    const p = candTrades[i].pnl_pts;
    standalonePnL += p;
    if (p > 0) { standaloneWins++; sgp += p; }
    else if (p < 0) { sgl += -p; }
  }
  const sPF = sgl > 0 ? sgp / sgl : (sgp > 0 ? Infinity : 0);
  const sWR = standaloneN > 0 ? standaloneWins / standaloneN * 100 : 0;
  emit(`  STANDALONE (no overlap w/ any production): n=${standaloneN}  PF=${sPF.toFixed(2)}  WR=${sWR.toFixed(1)}%  sumPnL=${standalonePnL.toFixed(0)}pts ($${(standalonePnL * 20 / 1000).toFixed(1)}k)`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
