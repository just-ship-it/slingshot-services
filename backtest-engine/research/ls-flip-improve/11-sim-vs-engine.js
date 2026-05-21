/**
 * Phase 11 — Calibrate simulator vs engine on candidate A.
 *
 * Re-runs simulator for tgt=15 stp=8 on the candA engine output's actual trade
 * IDs (subset of gold-standard trades that survived the noAsia filter), then
 * compares per-trade outcomes and aggregate PnL.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

const WALK = path.join(__dirname, 'output', '01-trades-walk.json');
const CAND = path.join(__dirname, 'output', 'engine-runs', 'candA_noAsia_tgt15_stp8.json');
const GOLD = path.join(ROOT, 'data', 'gold-standard', 'ls-flip-trigger-bar-v2.json');
const POINT_VALUE = 20, COMMISSION = 5, SLIP_PTS = 0.25;
const maxHoldMs = 60 * 60_000;

console.log('Loading walks...');
const walks = JSON.parse(fs.readFileSync(WALK, 'utf-8'));
const walksByTradeId = new Map(walks.map(w => [w.tradeId, w]));

console.log('Loading candA engine output...');
const cand = JSON.parse(fs.readFileSync(CAND, 'utf-8'));
const candTrades = cand.trades.filter(t => t.status === 'completed');
console.log(`candA trades: ${candTrades.length}`);

function simulate(e, cfg) {
  const tgt = cfg.target, stp = cfg.stop;
  let mfePeak = 0, mae = 0;
  for (let i = 0; i < e.walk.length; i++) {
    const s = e.walk[i]; const t = s[0] * 1000;
    const hi = s[1], lo = s[2], c = s[3];
    if (hi > mfePeak) mfePeak = hi;
    if (lo < 0 && -lo > mae) mae = -lo;
    if (mae >= stp) return { exit: 'stop', pnl: -(stp + SLIP_PTS), durationMs: t };
    if (mfePeak >= tgt) return { exit: 'target', pnl: tgt, durationMs: t };
    if (t > maxHoldMs) return { exit: 'maxhold', pnl: c, durationMs: maxHoldMs };
  }
  if (e.terminal === 'eod' && e.eodPrice != null) {
    return { exit: 'eod', pnl: e.side === 'buy' ? (e.eodPrice - e.entry) : (e.entry - e.eodPrice), durationMs: e.finalTs - e.fillTs };
  }
  const last = e.walk[e.walk.length - 1];
  return { exit: 'final', pnl: last ? last[3] : 0, durationMs: last ? last[0] * 1000 : 0 };
}

// candA didn't generate the same trade IDs as gold (signals differ slightly due to range filter & blocked hours).
// So we match by fillTs + side instead.
const candByFillTs = new Map();
for (const t of candTrades) {
  const k = `${t.entryTime}|${t.side}`;
  candByFillTs.set(k, t);
}
const walkByFillTs = new Map();
for (const w of walks) {
  const k = `${w.fillTs}|${w.side}`;
  walkByFillTs.set(k, w);
}

let matched = 0;
let unmatched = 0;
const matched_diffs = [];
const reasonDiff = {};
for (const t of candTrades) {
  const k = `${t.entryTime}|${t.side}`;
  const w = walkByFillTs.get(k);
  if (!w) { unmatched++; continue; }
  matched++;
  const sim = simulate(w, { target: 15, stop: 8 });
  const simNet = sim.pnl * POINT_VALUE - COMMISSION;
  const engNet = t.netPnL;
  matched_diffs.push({ id: t.id, sim: simNet, eng: engNet, simExit: sim.exit, engExit: t.exitReason, pts: sim.pnl - (t.pointsPnL || 0) });
  const k2 = `${sim.exit} vs ${t.exitReason}`;
  reasonDiff[k2] = (reasonDiff[k2] || 0) + 1;
}
console.log(`Matched: ${matched}  Unmatched: ${unmatched}`);

let simSum = 0, engSum = 0;
let agree = 0, disagree = 0;
let agreeNet = 0, disagreeNetSim = 0, disagreeNetEng = 0;
for (const d of matched_diffs) {
  simSum += d.sim;
  engSum += d.eng;
  if (d.simExit === 'target' && d.engExit === 'take_profit') agree++;
  else if (d.simExit === 'stop' && d.engExit === 'stop_loss') agree++;
  else if (d.simExit === 'eod' && d.engExit === 'eod_liquidation') agree++;
  else if (d.simExit === 'maxhold' && d.engExit === 'max_hold_time') agree++;
  else disagree++;
}
console.log(`\nSimulator sum:  $${simSum.toFixed(0)}`);
console.log(`Engine    sum:  $${engSum.toFixed(0)}`);
console.log(`Delta:          $${(simSum - engSum).toFixed(0)}`);
console.log(`Sim/Eng ratio:  ${(simSum / engSum).toFixed(2)}`);
console.log(`Exit agree:     ${agree}/${matched} (${(agree/matched*100).toFixed(1)}%)`);
console.log(`Exit disagree:  ${disagree}`);

console.log(`\nExit reason transitions (sim vs engine):`);
for (const [k, v] of Object.entries(reasonDiff).sort((a,b)=>b[1]-a[1]).slice(0, 12)) {
  console.log(`  ${k.padEnd(40)} ${v}`);
}

// Examples where simulator and engine differ
const big_diff = matched_diffs.filter(d => Math.abs(d.sim - d.eng) > 100).slice(0, 5);
console.log(`\n5 examples where sim and engine disagree on net PnL by >$100:`);
for (const d of big_diff) {
  console.log(`  ${d.id}  sim=$${d.sim.toFixed(0)} (${d.simExit}) | eng=$${d.eng.toFixed(0)} (${d.engExit})  diff=$${(d.sim-d.eng).toFixed(0)}`);
}
