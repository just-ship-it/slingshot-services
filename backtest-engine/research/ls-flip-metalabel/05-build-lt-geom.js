/**
 * Phase 1 — directional LT-level GEOMETRY features (15m LT levels we already have).
 *
 * Earlier `ltDist` (min distance to any level, side-agnostic) was null (corr 0.004).
 * This mines the DIRECTION-AWARE geometry the user flagged: support backstopping the
 * stop, resistance blocking the target, flip-at-level confluence, position in the stack.
 *
 * Levels (level_1..5) are clustered S/R that straddle spot, ordered by significance
 * (level_1 = primary), NOT price-sorted. So we compute above/below relative to entry.
 *
 * No 1m streaming needed — gold trades + LT CSV only. Out: output/lt-geom-features.csv
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENG = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'output');

const GOLD = path.join(ENG, 'data/gold-standard/ls-flip-trigger-bar-v3.json');
const LT = path.join(ENG, 'data/liquidity/nq/NQ_liquidity_levels.csv');
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// LT rows
const ltRows = [];
{
  const txt = fs.readFileSync(LT, 'utf8').split('\n');
  for (let i = 1; i < txt.length; i++) {
    const line = txt[i].trim(); if (!line) continue;
    const c = line.split(',');
    const levels = [c[3], c[4], c[5], c[6], c[7]].map(Number).filter(x => Number.isFinite(x) && x > 0);
    ltRows.push({ ts: +c[2] || Date.parse(c[0]), sentiment: c[2], level1: +c[3], levels });
  }
  ltRows.sort((a, b) => a.ts - b.ts);
}
log(`LT rows ${ltRows.length}`);
function asof(ts) { let lo = 0, hi = ltRows.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ltRows[m].ts <= ts) { ans = m; lo = m + 1; } else hi = m - 1; } return ans >= 0 ? ltRows[ans] : null; }

const goldRaw = JSON.parse(fs.readFileSync(GOLD, 'utf8'));
const trades = Array.isArray(goldRaw) ? goldRaw : (goldRaw.trades || []);

const rows = [];
let noLt = 0;
for (const t of trades) {
  const sig = t.signal || {}; const meta = sig.metadata || t.metadata || {};
  const dir = meta.direction || (t.side === 'buy' ? 'long' : 'short');
  const isLong = dir === 'long';
  const flipTs = meta.flipTs || (sig.timestamp ? sig.timestamp - 60000 : null);
  const entry = t.actualEntry ?? t.entryPrice ?? sig.price;
  const atr = meta.atr20 || 1;
  const tp = t.takeProfit ?? sig.takeProfit;
  const targetDist = tp != null ? Math.abs(tp - entry) : 15;   // candJ target ~15
  const range = (meta.triggerBar?.range) || null;
  const netPnL = t.netPnL ?? 0;
  if (!flipTs || !entry) { continue; }
  const rec = asof(flipTs);
  if (!rec || !rec.levels.length) { noLt++; continue; }
  const A = atr || 1;
  const L = rec.levels;

  // sentiment alignment (the proven gate, for interaction analysis)
  let ltAlign = null;
  if (rec.sentiment === 'BULLISH' || rec.sentiment === 'BEARISH') {
    const bull = rec.sentiment === 'BULLISH';
    ltAlign = (isLong && bull) || (!isLong && !bull) ? 1 : 0;
  }

  const above = L.filter(x => x > entry).sort((a, b) => a - b);   // ascending: above[0]=nearest above
  const below = L.filter(x => x < entry).sort((a, b) => b - a);   // descending: below[0]=nearest below
  const nearestAbove = above.length ? above[0] - entry : null;    // >0
  const nearestBelow = below.length ? entry - below[0] : null;    // >0

  // direction-aware: stop side vs target side
  // LONG: stop is below (support backstop = nearestBelow), target above (headroom = nearestAbove)
  // SHORT: stop above (resistance backstop = nearestAbove), target below (headroom = nearestBelow)
  const stopBackstop = isLong ? nearestBelow : nearestAbove;      // dist to level guarding the stop
  const targetHeadroom = isLong ? nearestAbove : nearestBelow;    // dist to first level in profit path
  const targetBlocked = (targetHeadroom != null && targetHeadroom < targetDist) ? 1 : 0;
  const nearestAny = Math.min(...L.map(x => Math.abs(entry - x)));
  // primary level (level_1) geometry
  const l1 = rec.level1;
  const l1Dist = Number.isFinite(l1) ? Math.abs(entry - l1) / A : null;
  // is level_1 on the trade's "with" side (above for long target / below for short target)?
  const l1Side = Number.isFinite(l1) ? (l1 > entry ? 'above' : 'below') : null;

  rows.push({
    tradeId: t.id, dir, isLong: isLong ? 1 : 0, ltAlign,
    nAbove: above.length, nBelow: below.length,
    stackPos: L.length ? below.length / L.length : null,         // 0..1, 1=entry above all levels
    stopBackstopAtr: stopBackstop != null ? stopBackstop / A : null,
    targetHeadroomAtr: targetHeadroom != null ? targetHeadroom / A : null,
    targetBlocked,
    nearestLevelAtr: nearestAny / A,
    flipAtLevel_05: nearestAny / A < 0.5 ? 1 : 0,
    flipAtLevel_10: nearestAny / A < 1.0 ? 1 : 0,
    flipAtLevel_3pt: nearestAny < 3 ? 1 : 0,
    l1DistAtr: l1Dist,
    l1OnTargetSide: l1Side ? ((isLong && l1Side === 'above') || (!isLong && l1Side === 'below') ? 1 : 0) : null,
    range, atr: +A.toFixed(2), targetDist,
    netPnL, label: netPnL > 0 ? 1 : 0,
  });
}
log(`rows ${rows.length} (skipped ${noLt} no-LT)`);
const cols = Object.keys(rows[0]);
const csv = [cols.join(',')];
for (const r of rows) csv.push(cols.map(c => { const v = r[c]; return v == null ? '' : (typeof v === 'number' ? (Number.isInteger(v) ? v : +v.toFixed(5)) : v); }).join(','));
fs.writeFileSync(path.join(OUT, 'lt-geom-features.csv'), csv.join('\n'));
log(`wrote output/lt-geom-features.csv`);
