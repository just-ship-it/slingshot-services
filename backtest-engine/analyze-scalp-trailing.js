#!/usr/bin/env node
/**
 * Test trailing stop effectiveness for scalps
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = '/home/drew/projects/slingshot-services/backtest-engine/data';

function loadData() {
  const csv = fs.readFileSync(path.join(DATA_DIR, 'ohlcv/NQ_ohlcv_1m.csv'), 'utf8');
  const lines = csv.split('\n').slice(1);
  const candles = new Map();
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const symbol = parts[9]?.trim();
    if (!symbol?.startsWith('NQ') || symbol.includes('-')) continue;
    const ts = new Date(parts[0]).getTime();
    if (!candles.has(ts) || candles.get(ts).volume < parseInt(parts[8])) {
      candles.set(ts, {
        timestamp: ts, open: parseFloat(parts[4]), high: parseFloat(parts[5]),
        low: parseFloat(parts[6]), close: parseFloat(parts[7]), volume: parseInt(parts[8])
      });
    }
  }
  
  const gexDir = path.join(DATA_DIR, 'gex');
  const files = fs.readdirSync(gexDir).filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'));
  const snapshots = [];
  for (const file of files) {
    const dateMatch = file.match(/nq_gex_(\d{4}-\d{2}-\d{2})\.json/);
    if (!dateMatch || dateMatch[1] < '2025-01-01') continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf8'));
      for (const snap of data.data || []) {
        snapshots.push({
          timestamp: new Date(snap.timestamp).getTime(),
          support: snap.support || [], resistance: snap.resistance || [], regime: snap.regime
        });
      }
    } catch (e) {}
  }
  
  return {
    candles: Array.from(candles.values()).sort((a, b) => a.timestamp - b.timestamp).filter(c => new Date(c.timestamp).getFullYear() === 2025),
    gex: snapshots.sort((a, b) => a.timestamp - b.timestamp)
  };
}

function getGEXLevels(timestamp, gex) {
  let latest = null;
  for (const s of gex) { if (s.timestamp <= timestamp) latest = s; else break; }
  return latest;
}

function simulateWithTrailing(entries, target, initialStop, trailTrigger, trailOffset, window) {
  let wins = 0, losses = 0, totalPnL = 0;
  let trailingExits = 0;
  
  for (const e of entries) {
    const { future, direction, price } = e;
    if (future.length < window) continue;
    
    let stop = initialStop;
    let highWaterMark = 0;
    let pnl = 0;
    let exited = false;
    
    for (let i = 0; i < window && !exited; i++) {
      const c = future[i];
      
      if (direction === 'long') {
        const currentProfit = c.high - price;
        if (currentProfit > highWaterMark) {
          highWaterMark = currentProfit;
          // Activate trailing if we've hit trigger
          if (highWaterMark >= trailTrigger) {
            const newStop = highWaterMark - trailOffset;
            if (newStop > -initialStop) stop = -newStop; // Stop is now in profit
          }
        }
        
        if (c.high >= price + target) { pnl = target; wins++; exited = true; }
        else if (c.low <= price + stop) { 
          pnl = -stop; 
          if (stop < initialStop) { wins++; trailingExits++; } 
          else losses++; 
          exited = true; 
        }
      } else {
        const currentProfit = price - c.low;
        if (currentProfit > highWaterMark) {
          highWaterMark = currentProfit;
          if (highWaterMark >= trailTrigger) {
            const newStop = highWaterMark - trailOffset;
            if (newStop > -initialStop) stop = -newStop;
          }
        }
        
        if (c.low <= price - target) { pnl = target; wins++; exited = true; }
        else if (c.high >= price - stop) { 
          pnl = stop; // stop is negative when trailing
          if (stop < initialStop) { wins++; trailingExits++; } 
          else losses++; 
          exited = true; 
        }
      }
    }
    
    if (!exited) {
      const exitPrice = future[window - 1].close;
      pnl = direction === 'long' ? exitPrice - price : price - exitPrice;
      if (pnl > 0) wins++; else losses++;
    }
    
    totalPnL += pnl;
  }
  
  return { wins, losses, winRate: wins / (wins + losses) * 100, totalPnL, avgPnL: totalPnL / (wins + losses), trailingExits };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('TRAILING STOP ANALYSIS FOR SCALPS');
  console.log('═'.repeat(70));
  
  const { candles, gex } = loadData();
  console.log(`Loaded ${candles.length.toLocaleString()} candles\n`);
  
  const entries = [];
  const TOUCH = 3, MAX_WINDOW = 15;
  
  for (let i = 0; i < candles.length - MAX_WINDOW; i++) {
    const candle = candles[i];
    const g = getGEXLevels(candle.timestamp, gex);
    if (!g) continue;
    const price = candle.close;
    const future = candles.slice(i + 1, i + 1 + MAX_WINDOW);
    
    if (g.support[0] && Math.abs(price - g.support[0]) <= TOUCH) {
      entries.push({ price, direction: 'long', future });
    }
    if (g.resistance[0] && Math.abs(price - g.resistance[0]) <= TOUCH) {
      entries.push({ price, direction: 'short', future });
    }
  }
  
  console.log(`Entry opportunities: ${entries.length.toLocaleString()}\n`);
  
  // Baseline without trailing
  console.log('BASELINE (no trailing):');
  console.log('| Target | Stop | Window | Win% | Total P&L | Avg P&L |');
  console.log('|--------|------|--------|------|-----------|---------|');
  
  const baselines = [
    [7, 3, 10],
    [5, 3, 5],
    [10, 5, 10]
  ];
  
  for (const [t, s, w] of baselines) {
    const r = simulateWithTrailing(entries, t, s, 999, 999, w); // No trailing
    console.log(`| ${t.toString().padStart(6)} | ${s.toString().padStart(4)} | ${w.toString().padStart(6)} | ${r.winRate.toFixed(1).padStart(4)}% | ${r.totalPnL.toFixed(0).padStart(9)} | ${r.avgPnL.toFixed(2).padStart(7)} |`);
  }
  
  // Test trailing configurations
  console.log('\nWITH TRAILING STOP (Target=7, Stop=3, Window=10):');
  console.log('| Trail Trigger | Trail Offset | Win% | Total P&L | Avg P&L | Trail Exits |');
  console.log('|---------------|--------------|------|-----------|---------|-------------|');
  
  const trailConfigs = [
    [3, 1], [3, 2],
    [4, 2], [4, 3],
    [5, 2], [5, 3],
    [6, 3], [6, 4]
  ];
  
  for (const [trigger, offset] of trailConfigs) {
    const r = simulateWithTrailing(entries, 7, 3, trigger, offset, 10);
    console.log(`| ${trigger.toString().padStart(13)} | ${offset.toString().padStart(12)} | ${r.winRate.toFixed(1).padStart(4)}% | ${r.totalPnL.toFixed(0).padStart(9)} | ${r.avgPnL.toFixed(2).padStart(7)} | ${r.trailingExits.toString().padStart(11)} |`);
  }
  
  // Best config comparison
  console.log('\n' + '═'.repeat(70));
  console.log('BEST TRAILING CONFIG VS BASELINE');
  console.log('═'.repeat(70));
  
  const baseline = simulateWithTrailing(entries, 7, 3, 999, 999, 10);
  const withTrail = simulateWithTrailing(entries, 7, 3, 4, 2, 10);
  
  console.log(`\nBaseline (T7/S3/W10, no trail):`);
  console.log(`  Win rate: ${baseline.winRate.toFixed(1)}%`);
  console.log(`  Total P&L: ${baseline.totalPnL.toFixed(0)} points`);
  console.log(`  Avg P&L: ${baseline.avgPnL.toFixed(3)} points/trade`);
  
  console.log(`\nWith trailing (Trigger=4, Offset=2):`);
  console.log(`  Win rate: ${withTrail.winRate.toFixed(1)}%`);
  console.log(`  Total P&L: ${withTrail.totalPnL.toFixed(0)} points`);
  console.log(`  Avg P&L: ${withTrail.avgPnL.toFixed(3)} points/trade`);
  console.log(`  Trailing exits: ${withTrail.trailingExits}`);
}

main().catch(console.error);
