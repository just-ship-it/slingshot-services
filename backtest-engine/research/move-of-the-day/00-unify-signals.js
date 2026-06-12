// Phase 0 — Unify all four production strategies' signals into one causal dataset.
//
// Each gold-standard JSON holds COMPLETED trades (signal + realized exit under the
// strategy's own stop/target rules). We treat each completed trade as one candidate
// "move-of-the-day" signal. Because the exit reuses the strategy's own rule, the
// realized `pointsPnL` is the honest outcome of taking that signal — no re-simulation.
//
// Output: output/signals.json  (flat array, one record per candidate signal)
//         output/sessions.json (grouped by ET session date, RTH-only)
//
// Decision-time vs outcome fields are clearly separated so downstream selectors
// can enforce no-lookahead: only `features` + `decisionTs` are known at decision time;
// everything under `outcome` is hindsight.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { etParts, inRTHEntryWindow } from './lib/et.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GS = path.resolve(__dirname, '../../data/gold-standard');
const OUT = path.resolve(__dirname, 'output');

const SOURCES = {
  glx:  'gex-lt-3m-crossover-v3.json',
  glf:  'gex-level-fade-v2.json',
  gfi:  'gex-flip-ivpct-v2.json',
  lstb: 'ls-flip-trigger-bar-v3.json',
};

const POINT_VALUE = 20; // NQ $/point per contract

function normSide(s) {
  if (!s) return null;
  const v = String(s).toLowerCase();
  if (v === 'buy' || v === 'long') return 'long';
  if (v === 'sell' || v === 'short') return 'short';
  return v;
}

// Extract strategy-specific decision-time features. Only fields KNOWN at signal time.
function extractFeatures(strat, sig, trade) {
  const f = {};
  if (strat === 'glx') {
    f.ruleId = sig.ruleId; f.gexType = sig.gexType; f.ltIdx = sig.ltIdx;
    f.direction = sig.direction; f.ruleFilter = sig.ruleFilter;
    // proximity of price to the gex/lt level at signal (known now)
    if (sig.gexPrice != null) f.gexDist = sig.price - sig.gexPrice;
    if (sig.ltPrice != null) f.ltDist = sig.price - sig.ltPrice;
  } else if (strat === 'gfi') {
    f.ruleId = sig.ruleId; f.rulePriority = sig.rulePriority;
    f.ivValue = sig.ivValue; f.ivSkew = sig.ivSkew; f.ivPercentile = sig.ivPercentile;
    f.gexRegime = sig.gexRegime;
    if (sig.gammaFlip != null) f.gammaFlipDist = sig.price - sig.gammaFlip;
    if (sig.callWall != null) f.callWallDist = sig.callWall - sig.price;
    if (sig.putWall != null) f.putWallDist = sig.price - sig.putWall;
  } else if (strat === 'glf') {
    f.levelType = sig.levelType; f.episodeNum = sig.episodeNum;
    if (sig.levelPrice != null) f.levelDist = sig.price - sig.levelPrice;
  } else if (strat === 'lstb') {
    // minimal context; trigger-bar range is a proxy for setup quality
    if (trade.entryCandle) f.triggerRange = trade.entryCandle.high - trade.entryCandle.low;
  }
  // common: planned risk/reward at signal
  f.stopPoints = sig.stopPoints ?? sig.stopDistance ?? (sig.stopLoss != null ? Math.abs(sig.price - sig.stopLoss) : null);
  f.targetPoints = sig.targetPoints ?? sig.targetDistance ?? (sig.takeProfit != null ? Math.abs(sig.takeProfit - sig.price) : null);
  return f;
}

const all = [];
let counter = 0;

for (const [strat, file] of Object.entries(SOURCES)) {
  const j = JSON.parse(fs.readFileSync(path.join(GS, file), 'utf8'));
  const trades = j.trades || [];
  let kept = 0, skippedNoOutcome = 0;
  for (const t of trades) {
    const sig = t.signal || {};
    const side = normSide(t.side || sig.side);
    const pointsPnL = t.pointsPnL;
    if (pointsPnL == null) { skippedNoOutcome++; continue; }

    // decisionTs: when the strategy committed (signal candle time). Use signalTime if present.
    const decisionTs = sig.timestamp ?? t.signalTime ?? t.timestamp;
    // entryTs: actual fill time — used for session bucketing + RTH filter
    const entryTs = t.entryTime ?? decisionTs;

    const e = etParts(entryTs);
    const d = etParts(decisionTs);

    all.push({
      id: `${strat}-${String(++counter).padStart(5, '0')}`,
      strategy: strat,
      strategyConst: t.strategy || sig.strategy,
      side,
      // ---- decision-time (no-lookahead) ----
      decisionTs,
      entryTs,
      entryPrice: t.entryPrice ?? t.actualEntry ?? sig.price,
      sessionDateET: e.dateET,
      entryHourET: e.hour,
      entryMinET: e.minutesOfDay,
      decisionHourET: d.hour,
      dowName: e.dowName,
      inRTH: inRTHEntryWindow(entryTs),
      features: extractFeatures(strat, sig, t),
      // ---- outcome (hindsight) ----
      outcome: {
        pointsPnL,
        netPnL: t.netPnL,
        dollarPnL: pointsPnL * POINT_VALUE,
        mfePoints: t.mfePoints,
        maePoints: t.maePoints,
        exitReason: t.exitReason,
        exitTs: t.exitTime,
        holdMin: t.exitTime ? Math.round((t.exitTime - entryTs) / 60000) : null,
        win: pointsPnL > 0,
      },
    });
    kept++;
  }
  console.log(`${strat.padEnd(5)} ${file.padEnd(34)} kept=${kept} skippedNoOutcome=${skippedNoOutcome}`);
}

all.sort((a, b) => a.entryTs - b.entryTs);

// Group into RTH sessions
const sessions = {};
for (const s of all) {
  if (!s.inRTH) continue;
  (sessions[s.sessionDateET] ||= []).push(s);
}

fs.writeFileSync(path.join(OUT, 'signals.json'), JSON.stringify(all));
fs.writeFileSync(path.join(OUT, 'sessions.json'), JSON.stringify(sessions));

// Summary
const rthCount = all.filter(s => s.inRTH).length;
const days = Object.keys(sessions).sort();
const perStrat = {};
for (const s of all) { perStrat[s.strategy] = (perStrat[s.strategy] || 0) + (s.inRTH ? 1 : 0); }
const sigPerDay = days.map(d => sessions[d].length);
const avgPerDay = (sigPerDay.reduce((a, b) => a + b, 0) / days.length).toFixed(1);

console.log('\n========== UNIFIED SIGNAL DATASET ==========');
console.log(`Total candidate signals (all sessions): ${all.length}`);
console.log(`RTH-window signals:                      ${rthCount}`);
console.log(`RTH per strategy:`, perStrat);
console.log(`Distinct RTH session days:               ${days.length}`);
console.log(`Date range:                              ${days[0]} .. ${days[days.length - 1]}`);
console.log(`Avg signals/day:                         ${avgPerDay}  (min ${Math.min(...sigPerDay)}, max ${Math.max(...sigPerDay)})`);
console.log(`Days with only 1 signal:                 ${sigPerDay.filter(n => n === 1).length}`);
console.log('Wrote output/signals.json + output/sessions.json');
