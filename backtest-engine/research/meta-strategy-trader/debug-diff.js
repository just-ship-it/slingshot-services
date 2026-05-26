#!/usr/bin/env node
// Side-by-side diff: meta-engine trades vs gold trades for lstb Jan 13-14.
// Goal: find the pattern of divergence (extra trades I take, exits I differ on).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SecondDataProvider } from '../../src/data/csv-loader.js';
import { MetaEngine, FCFS_RULE, DEFAULT_COOLDOWNS } from './meta-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

async function main() {
  const sdp = new SecondDataProvider(path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv'));
  await sdp.initialize();

  const signalsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'research/meta-strategy-trader/output/signals/lstb-jan13-feb13.json'), 'utf8'));
  // First 3 days only
  const cut = new Date('2025-01-16T00:00:00Z').getTime();
  const signals = signalsJson.signals.filter(s => s.ts < cut);
  console.log(`Filtered to ${signals.length} signals (first 3 days)`);

  const engine = new MetaEngine({
    signals,
    secondDataProvider: sdp,
    metaRule: FCFS_RULE,
    cooldownConfig: DEFAULT_COOLDOWNS,
    enabledStrategies: ['ls-flip-trigger-bar'],
    eodCutoffEt: '15:45',
    commission: 5,
    contractFilter: 'NQH5',
  });
  const result = await engine.run();

  // Pull gold trades in same window
  const gold = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gold-standard/ls-flip-trigger-bar-v3.json'), 'utf8'));
  const start = new Date('2025-01-13T00:00:00Z').getTime();
  const goldWin = gold.trades.filter(t => t.status === 'completed' && t.entryTime >= start && t.entryTime < cut);

  console.log(`\nMeta trades: ${result.trades.length}`);
  console.log(`Gold trades: ${goldWin.length}`);

  // Print first 15 of each, time-aligned for easy comparison
  console.log('\n--- META trades (first 15) ---');
  for (const t of result.trades.slice(0, 15)) {
    console.log(`${new Date(t.entryTs).toISOString()}  ${t.side.padEnd(5)} entry=${t.entryPrice}  stop=${t.stopLoss}  tgt=${t.takeProfit}  exit=${t.exitPrice} (${t.exitReason})  pnl=${t.netPnL}`);
  }
  console.log('\n--- GOLD trades (first 15) ---');
  for (const t of goldWin.slice(0, 15)) {
    console.log(`${new Date(t.entryTime).toISOString()}  ${t.side.padEnd(5)} entry=${t.actualEntry}  stop=${t.stopLoss}  tgt=${t.takeProfit}  exit=${t.actualExit} (${t.exitReason})  pnl=${t.netPnL}`);
  }

  // For each gold trade, find the META trade with the closest entryTs and report diffs
  console.log('\n--- per-gold-trade match ---');
  for (let i = 0; i < Math.min(20, goldWin.length); i++) {
    const g = goldWin[i];
    const closest = result.trades.reduce((best, t) => {
      const d = Math.abs(t.entryTs - g.entryTime);
      return (!best || d < best.d) ? { t, d } : best;
    }, null);
    const m = closest?.t;
    if (!m || closest.d > 5 * 60_000) {
      console.log(`GOLD ${new Date(g.entryTime).toISOString()} ${g.side} ${g.actualEntry} → ${g.netPnL} | META: <no match within 5min>`);
    } else {
      const dtMs = m.entryTs - g.entryTime;
      const dtTxt = (dtMs >= 0 ? '+' : '') + (dtMs / 1000).toFixed(1) + 's';
      console.log(`GOLD ${new Date(g.entryTime).toISOString()} ${g.side} e=${g.actualEntry} ex=${g.actualExit} (${g.exitReason}) pnl=${g.netPnL}`);
      console.log(`  META ${dtTxt}            ${m.side} e=${m.entryPrice} ex=${m.exitPrice} (${m.exitReason}) pnl=${m.netPnL}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
