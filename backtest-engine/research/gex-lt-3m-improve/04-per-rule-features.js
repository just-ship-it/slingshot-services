/**
 * Phase 4 — Per-rule feature analysis.
 *
 * For each of the 4 active rules, slice the gold-standard P&L by:
 *   - hour of day (ET)
 *   - day of week
 *   - ltIdx (which LT level the GEX crossed against)
 *   - gexType (only varies for alias rules)
 *   - duration bucket (early/mid/late exit)
 *
 * Output: per-rule "filter levers" — hours / DOWs / ltIdx values that are
 * negative-expectancy under the gold exit policy.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = process.argv[2] || path.join(__dirname, 'output', '01-trades-walk.json');
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
console.log(`Loaded ${walks.length} trades.\n`);

function bucketize(items, keyFn) {
  const out = {};
  for (const it of items) {
    const k = keyFn(it);
    if (k == null || k === undefined) continue;
    (out[k] = out[k] || []).push(it);
  }
  return out;
}

function statify(items) {
  const POINT_VALUE = 20, COMMISSION = 5;
  let pnl = 0, wins = 0, losses = 0, sumW = 0, sumL = 0;
  for (const t of items) {
    const d = t.goldNetPnL; // already net (commission subtracted)
    pnl += d;
    if (d > 0) { wins++; sumW += d; }
    else if (d < 0) { losses++; sumL += d; }
  }
  const wr = (wins + losses) ? wins / (wins + losses) * 100 : 0;
  const pf = sumL !== 0 ? Math.abs(sumW / sumL) : (sumW > 0 ? Infinity : 0);
  return { n: items.length, pnl, wins, losses, wr, pf, avgPnL: items.length ? pnl / items.length : 0 };
}

for (const rule of ['L_S4', 'S_CW', 'S_GF_SOLO', 'S_R4']) {
  const tr = walks.filter(w => w.ruleId === rule);
  console.log(`\n=== ${rule} (n=${tr.length}) ===`);
  const tot = statify(tr);
  console.log(`  Total: $${tot.pnl.toFixed(0)} WR=${tot.wr.toFixed(0)}% PF=${tot.pf.toFixed(2)} avg=$${tot.avgPnL.toFixed(0)}`);

  // By ET hour
  console.log(`  by ET hour:`);
  const byHr = bucketize(tr, t => t.hourEt);
  const hours = Object.keys(byHr).map(Number).sort((a,b) => a-b);
  for (const h of hours) {
    const s = statify(byHr[h]);
    const flag = s.avgPnL < 0 ? ' ⚠️ LOSING' : (s.avgPnL > 200 ? ' ⭐' : '');
    console.log(`    ${String(h).padStart(2)} | n=${String(s.n).padStart(3)} | $${s.pnl.toFixed(0).padStart(7)} | WR=${s.wr.toFixed(0)}% | PF=${s.pf.toFixed(2)} | avg=$${s.avgPnL.toFixed(0).padStart(5)}${flag}`);
  }

  // By DOW
  console.log(`  by DOW:`);
  const byDow = bucketize(tr, t => t.dow);
  for (const dow of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
    const items = byDow[dow] || [];
    if (items.length === 0) continue;
    const s = statify(items);
    const flag = s.avgPnL < 0 ? ' ⚠️' : (s.avgPnL > 300 ? ' ⭐' : '');
    console.log(`    ${dow} | n=${String(s.n).padStart(3)} | $${s.pnl.toFixed(0).padStart(7)} | WR=${s.wr.toFixed(0)}% | PF=${s.pf.toFixed(2)} | avg=$${s.avgPnL.toFixed(0).padStart(5)}${flag}`);
  }

  // By ltIdx
  console.log(`  by ltIdx:`);
  const byLt = bucketize(tr, t => t.ltIdx);
  const lts = Object.keys(byLt).map(Number).sort((a,b) => a-b);
  for (const li of lts) {
    const s = statify(byLt[li]);
    const flag = s.avgPnL < 0 ? ' ⚠️' : (s.avgPnL > 300 ? ' ⭐' : '');
    console.log(`    L${li + 1} | n=${String(s.n).padStart(3)} | $${s.pnl.toFixed(0).padStart(7)} | WR=${s.wr.toFixed(0)}% | PF=${s.pf.toFixed(2)} | avg=$${s.avgPnL.toFixed(0).padStart(5)}${flag}`);
  }

  // By gexType (relevant for L_S4 / S_R4 since some have aliases)
  const byGex = bucketize(tr, t => t.gexType);
  if (Object.keys(byGex).length > 1) {
    console.log(`  by gexType:`);
    for (const g of Object.keys(byGex).sort()) {
      const s = statify(byGex[g]);
      console.log(`    ${g.padEnd(11)} | n=${String(s.n).padStart(3)} | $${s.pnl.toFixed(0).padStart(7)} | WR=${s.wr.toFixed(0)}% | PF=${s.pf.toFixed(2)} | avg=$${s.avgPnL.toFixed(0).padStart(5)}`);
    }
  }

  // MFE/MAE distribution for this rule
  const mfe = tr.map(t => t.goldMfePoints || 0).sort((a, b) => a - b);
  const mae = tr.map(t => t.goldMaePoints || 0).sort((a, b) => a - b);
  function pct(arr, p) { return arr.length ? arr[Math.floor(arr.length * p)] : 0; }
  console.log(`  MFE distribution (pts): p25=${pct(mfe,0.25).toFixed(1)} med=${pct(mfe,0.5).toFixed(1)} p75=${pct(mfe,0.75).toFixed(1)} p90=${pct(mfe,0.9).toFixed(1)} p99=${pct(mfe,0.99).toFixed(1)} max=${mfe[mfe.length-1]?.toFixed(1)}`);
  console.log(`  MAE distribution (pts): p25=${pct(mae,0.25).toFixed(1)} med=${pct(mae,0.5).toFixed(1)} p75=${pct(mae,0.75).toFixed(1)} p90=${pct(mae,0.9).toFixed(1)} p99=${pct(mae,0.99).toFixed(1)} max=${mae[mae.length-1]?.toFixed(1)}`);
  const wins = tr.filter(t => t.goldNetPnL > 0);
  const losses = tr.filter(t => t.goldNetPnL < 0);
  if (wins.length) {
    const winMfe = wins.map(t => t.goldMfePoints || 0).sort((a, b) => a - b);
    console.log(`  Winner MFE: med=${pct(winMfe,0.5).toFixed(1)} p90=${pct(winMfe,0.9).toFixed(1)} (n=${wins.length})`);
  }
  if (losses.length) {
    const lossMfe = losses.map(t => t.goldMfePoints || 0).sort((a, b) => a - b);
    console.log(`  Loser MFE:  med=${pct(lossMfe,0.5).toFixed(1)} p90=${pct(lossMfe,0.9).toFixed(1)} (n=${losses.length})`);
  }
  // Duration distribution
  const dur = tr.map(t => (t.goldDurationMs || 0) / 60000).sort((a, b) => a - b);
  console.log(`  Duration (min): med=${pct(dur,0.5).toFixed(0)} p75=${pct(dur,0.75).toFixed(0)} p90=${pct(dur,0.9).toFixed(0)} max=${dur[dur.length-1]?.toFixed(0)}`);
}
