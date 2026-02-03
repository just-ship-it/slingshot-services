#!/usr/bin/env node
/**
 * Verify scalp P&L with detailed trade-by-trade tracking
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
          support: snap.support || [], resistance: snap.resistance || []
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

async function main() {
  const { candles, gex } = loadData();
  console.log('Loaded', candles.length, 'candles\n');
  
  const TARGET = 7, STOP = 3, TRAIL_TRIGGER = 3, TRAIL_OFFSET = 1, WINDOW = 10;
  const TOUCH = 3;
  const POINT_VALUE = 20, COMMISSION = 5;
  
  const outcomes = {
    targetHit: { count: 0, pnl: 0 },
    trailingStop: { count: 0, pnl: 0 },
    initialStop: { count: 0, pnl: 0 },
    windowExit: { count: 0, pnl: 0 }
  };
  
  let totalTrades = 0;
  
  for (let i = 0; i < candles.length - WINDOW; i++) {
    const candle = candles[i];
    const g = getGEXLevels(candle.timestamp, gex);
    if (!g) continue;
    
    const price = candle.close;
    const future = candles.slice(i + 1, i + 1 + WINDOW);
    if (future.length < WINDOW) continue;
    
    // Check for entry signals
    const entries = [];
    if (g.support[0] && Math.abs(price - g.support[0]) <= TOUCH) {
      entries.push('long');
    }
    if (g.resistance[0] && Math.abs(price - g.resistance[0]) <= TOUCH) {
      entries.push('short');
    }
    
    for (const direction of entries) {
      totalTrades++;
      
      let currentStop = STOP;
      let highWaterMark = 0;
      let exitPnl = null;
      let exitReason = null;
      
      for (let j = 0; j < WINDOW; j++) {
        const c = future[j];
        
        if (direction === 'long') {
          const profit = c.high - price;
          if (profit > highWaterMark) {
            highWaterMark = profit;
            if (highWaterMark >= TRAIL_TRIGGER) {
              const trailStop = highWaterMark - TRAIL_OFFSET;
              if (trailStop > 0) currentStop = -trailStop; // Negative = in profit
            }
          }
          
          // Check exits in order: target, then stop
          if (c.high >= price + TARGET) {
            exitPnl = TARGET;
            exitReason = 'targetHit';
            break;
          }
          if (currentStop > 0 && c.low <= price - currentStop) {
            exitPnl = -currentStop;
            exitReason = 'initialStop';
            break;
          }
          if (currentStop < 0 && c.low <= price + currentStop) {
            exitPnl = -currentStop; // Positive, it's profit
            exitReason = 'trailingStop';
            break;
          }
        } else { // short
          const profit = price - c.low;
          if (profit > highWaterMark) {
            highWaterMark = profit;
            if (highWaterMark >= TRAIL_TRIGGER) {
              const trailStop = highWaterMark - TRAIL_OFFSET;
              if (trailStop > 0) currentStop = -trailStop;
            }
          }
          
          if (c.low <= price - TARGET) {
            exitPnl = TARGET;
            exitReason = 'targetHit';
            break;
          }
          if (currentStop > 0 && c.high >= price + currentStop) {
            exitPnl = -currentStop;
            exitReason = 'initialStop';
            break;
          }
          if (currentStop < 0 && c.high >= price - currentStop) {
            exitPnl = -currentStop;
            exitReason = 'trailingStop';
            break;
          }
        }
      }
      
      if (exitPnl === null) {
        // Window exit
        const exitPrice = future[WINDOW - 1].close;
        exitPnl = direction === 'long' ? exitPrice - price : price - exitPrice;
        exitReason = 'windowExit';
      }
      
      outcomes[exitReason].count++;
      outcomes[exitReason].pnl += exitPnl;
    }
  }
  
  console.log('═'.repeat(60));
  console.log('VERIFIED SCALP PERFORMANCE');
  console.log('═'.repeat(60));
  console.log('\nParameters: Target=' + TARGET + ', Stop=' + STOP + ', Trail=' + TRAIL_TRIGGER + '/' + TRAIL_OFFSET + ', Window=' + WINDOW + 'min\n');
  
  console.log('Exit Type Breakdown:');
  console.log('─'.repeat(60));
  let totalPts = 0;
  for (const [type, data] of Object.entries(outcomes)) {
    const avgPnl = data.count > 0 ? (data.pnl / data.count).toFixed(2) : 0;
    console.log(`  ${type.padEnd(15)}: ${data.count.toString().padStart(6)} trades, ${data.pnl.toFixed(0).padStart(8)} pts (avg: ${avgPnl} pts)`);
    totalPts += data.pnl;
  }
  
  console.log('─'.repeat(60));
  console.log(`  TOTAL: ${totalTrades} trades, ${totalPts.toFixed(0)} pts\n`);
  
  const wins = outcomes.targetHit.count + outcomes.trailingStop.count + 
               (outcomes.windowExit.pnl > 0 ? Math.round(outcomes.windowExit.count * 0.5) : 0);
  
  console.log('Dollar Performance (1 NQ contract):');
  console.log('─'.repeat(60));
  const gross = totalPts * POINT_VALUE;
  const comm = totalTrades * COMMISSION;
  const slippage = totalTrades * 0.5 * POINT_VALUE; // 0.5 pt slippage per trade
  const net = gross - comm - slippage;
  
  console.log(`  Gross P&L:    $${gross.toLocaleString()}`);
  console.log(`  Commission:   -$${comm.toLocaleString()} (${totalTrades} × $5)`);
  console.log(`  Slippage:     -$${slippage.toLocaleString()} (0.5 pt/trade)`);
  console.log(`  ─────────────────────`);
  console.log(`  NET P&L:      $${net.toLocaleString()}`);
  console.log(`  Per trade:    $${(net / totalTrades).toFixed(2)}`);
  
  console.log('\nTrade Frequency:');
  console.log(`  Trades/year:  ${totalTrades.toLocaleString()}`);
  console.log(`  Trades/day:   ~${(totalTrades / 250).toFixed(1)}`);
}

main().catch(console.error);
