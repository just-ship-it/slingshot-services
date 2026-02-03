#!/usr/bin/env node
/**
 * Deeper analysis: timing, velocity, first touch vs retests
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = '/home/drew/projects/slingshot-services/backtest-engine/data';

// Simplified data loaders (reused from previous)
function loadOHLCV() {
  const csv = fs.readFileSync(path.join(DATA_DIR, 'ohlcv/NQ_ohlcv_1m.csv'), 'utf8');
  const lines = csv.split('\n').slice(1);
  const candles = new Map();
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const symbol = parts[9]?.trim();
    if (!symbol?.startsWith('NQ') || symbol.includes('-')) continue;
    const ts = new Date(parts[0]).getTime();
    const candle = {
      timestamp: ts,
      open: parseFloat(parts[4]),
      high: parseFloat(parts[5]),
      low: parseFloat(parts[6]),
      close: parseFloat(parts[7]),
      volume: parseInt(parts[8])
    };
    if (!candles.has(ts) || candles.get(ts).volume < candle.volume) {
      candles.set(ts, candle);
    }
  }
  return Array.from(candles.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function loadGEXData(startDate, endDate) {
  const gexDir = path.join(DATA_DIR, 'gex');
  const files = fs.readdirSync(gexDir).filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'));
  const snapshots = [];
  for (const file of files) {
    const dateMatch = file.match(/nq_gex_(\d{4}-\d{2}-\d{2})\.json/);
    if (!dateMatch) continue;
    const fileDate = dateMatch[1];
    if (fileDate < startDate || fileDate > endDate) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf8'));
      for (const snap of data.data || []) {
        snapshots.push({
          timestamp: new Date(snap.timestamp).getTime(),
          gammaFlip: snap.gamma_flip,
          support: snap.support || [],
          resistance: snap.resistance || [],
          regime: snap.regime
        });
      }
    } catch (e) {}
  }
  return snapshots.sort((a, b) => a.timestamp - b.timestamp);
}

function getGEXLevels(timestamp, gexSnapshots) {
  let latest = null;
  for (const snap of gexSnapshots) {
    if (snap.timestamp <= timestamp) latest = snap;
    else break;
  }
  return latest;
}

// Load IV data
function loadIVData() {
  const ivPath = path.join(DATA_DIR, 'iv/qqq_atm_iv_15m.csv');
  if (!fs.existsSync(ivPath)) return new Map();
  
  const csv = fs.readFileSync(ivPath, 'utf8');
  const lines = csv.split('\n').slice(1);
  const ivMap = new Map();
  
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 7) continue;
    const ts = new Date(parts[0]).getTime();
    ivMap.set(ts, {
      iv: parseFloat(parts[1]),
      callIV: parseFloat(parts[4]),
      putIV: parseFloat(parts[5]),
      skew: parseFloat(parts[5]) - parseFloat(parts[4]) // Put IV - Call IV
    });
  }
  return ivMap;
}

async function main() {
  console.log('═'.repeat(70));
  console.log('GEX SCALPING - TIMING & VELOCITY ANALYSIS');
  console.log('═'.repeat(70));
  
  const candles = loadOHLCV();
  const gexSnapshots = loadGEXData('2025-01-01', '2025-12-31');
  const ivData = loadIVData();
  
  const candles2025 = candles.filter(c => new Date(c.timestamp).getFullYear() === 2025);
  console.log(`Analyzing ${candles2025.length.toLocaleString()} 1-minute candles`);
  console.log(`IV data points: ${ivData.size}`);
  
  const TOUCH_THRESHOLD = 5;
  const TARGET = 5;
  const STOP = 5;
  const LOOKFORWARD = 10; // 10 minute window for quick scalps
  const LOOKBACK = 5; // 5 candles to measure momentum
  
  // Track first touch of each GEX snapshot period
  const touchesByPeriod = new Map();
  
  const results = {
    byTimeOfDay: {},
    byMomentum: { withMomentum: [], againstMomentum: [] },
    byTouchOrder: { first: [], second: [], third: [] },
    byIVLevel: { highIV: [], lowIV: [] },
    byIVSkew: { putSkew: [], callSkew: [] }
  };
  
  for (let i = LOOKBACK; i < candles2025.length - LOOKFORWARD; i++) {
    const candle = candles2025[i];
    const gex = getGEXLevels(candle.timestamp, gexSnapshots);
    if (!gex) continue;
    
    const price = candle.close;
    const hour = new Date(candle.timestamp).getUTCHours();
    
    // Calculate momentum (price change over lookback)
    const momentumStart = candles2025[i - LOOKBACK].close;
    const momentum = price - momentumStart;
    
    // Get IV data (find nearest 15-min snapshot)
    const ivTs = Math.floor(candle.timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const iv = ivData.get(ivTs);
    
    // Check Support 1 touch (long scalp)
    if (gex.support[0] && Math.abs(price - gex.support[0]) <= TOUCH_THRESHOLD) {
      const future = candles2025.slice(i + 1, i + 1 + LOOKFORWARD);
      if (future.length < LOOKFORWARD) continue;
      
      const maxUp = Math.max(...future.map(c => c.high)) - price;
      const maxDown = price - Math.min(...future.map(c => c.low));
      const win = maxUp >= TARGET && maxDown < STOP;
      
      // Track touch order within GEX period
      const periodKey = `${gex.timestamp}_support1`;
      const touchOrder = (touchesByPeriod.get(periodKey) || 0) + 1;
      touchesByPeriod.set(periodKey, touchOrder);
      
      const entry = {
        timestamp: candle.timestamp,
        price,
        level: gex.support[0],
        regime: gex.regime,
        momentum,
        hour,
        iv: iv?.iv,
        ivSkew: iv?.skew,
        maxUp,
        maxDown,
        win,
        touchOrder
      };
      
      // Categorize
      const hourKey = `${hour.toString().padStart(2, '0')}:00`;
      if (!results.byTimeOfDay[hourKey]) results.byTimeOfDay[hourKey] = { long: [], short: [] };
      results.byTimeOfDay[hourKey].long.push(entry);
      
      if (momentum < -5) results.byMomentum.withMomentum.push(entry); // Dropping into support
      else if (momentum > 5) results.byMomentum.againstMomentum.push(entry);
      
      if (touchOrder === 1) results.byTouchOrder.first.push(entry);
      else if (touchOrder === 2) results.byTouchOrder.second.push(entry);
      else results.byTouchOrder.third.push(entry);
      
      if (iv) {
        if (iv.iv > 0.25) results.byIVLevel.highIV.push(entry);
        else results.byIVLevel.lowIV.push(entry);
        
        if (iv.skew > 0.01) results.byIVSkew.putSkew.push(entry);
        else if (iv.skew < -0.01) results.byIVSkew.callSkew.push(entry);
      }
    }
    
    // Check Resistance 1 touch (short scalp)
    if (gex.resistance[0] && Math.abs(price - gex.resistance[0]) <= TOUCH_THRESHOLD) {
      const future = candles2025.slice(i + 1, i + 1 + LOOKFORWARD);
      if (future.length < LOOKFORWARD) continue;
      
      const maxUp = Math.max(...future.map(c => c.high)) - price;
      const maxDown = price - Math.min(...future.map(c => c.low));
      const win = maxDown >= TARGET && maxUp < STOP;
      
      const periodKey = `${gex.timestamp}_resistance1`;
      const touchOrder = (touchesByPeriod.get(periodKey) || 0) + 1;
      touchesByPeriod.set(periodKey, touchOrder);
      
      const entry = {
        timestamp: candle.timestamp,
        price,
        level: gex.resistance[0],
        regime: gex.regime,
        momentum,
        hour,
        iv: iv?.iv,
        ivSkew: iv?.skew,
        maxUp,
        maxDown,
        win,
        touchOrder
      };
      
      const hourKey = `${hour.toString().padStart(2, '0')}:00`;
      if (!results.byTimeOfDay[hourKey]) results.byTimeOfDay[hourKey] = { long: [], short: [] };
      results.byTimeOfDay[hourKey].short.push(entry);
      
      if (momentum > 5) results.byMomentum.withMomentum.push(entry); // Rising into resistance
      else if (momentum < -5) results.byMomentum.againstMomentum.push(entry);
      
      if (touchOrder === 1) results.byTouchOrder.first.push(entry);
      else if (touchOrder === 2) results.byTouchOrder.second.push(entry);
      else results.byTouchOrder.third.push(entry);
      
      if (iv) {
        if (iv.iv > 0.25) results.byIVLevel.highIV.push(entry);
        else results.byIVLevel.lowIV.push(entry);
        
        if (iv.skew > 0.01) results.byIVSkew.putSkew.push(entry);
        else if (iv.skew < -0.01) results.byIVSkew.callSkew.push(entry);
      }
    }
  }
  
  // Print results
  console.log('\n' + '═'.repeat(70));
  console.log('TIME OF DAY ANALYSIS (5pt target/stop, 10-min window)');
  console.log('═'.repeat(70));
  console.log('| Hour (UTC) | Long Trades | Long Win% | Short Trades | Short Win% |');
  console.log('|------------|-------------|-----------|--------------|------------|');
  
  for (const hour of Object.keys(results.byTimeOfDay).sort()) {
    const data = results.byTimeOfDay[hour];
    const longWinRate = data.long.length > 0 ? (data.long.filter(e => e.win).length / data.long.length * 100).toFixed(1) : 'N/A';
    const shortWinRate = data.short.length > 0 ? (data.short.filter(e => e.win).length / data.short.length * 100).toFixed(1) : 'N/A';
    console.log(`| ${hour.padEnd(10)} | ${data.long.length.toString().padStart(11)} | ${longWinRate.padStart(9)}% | ${data.short.length.toString().padStart(12)} | ${shortWinRate.padStart(10)}% |`);
  }
  
  console.log('\n' + '═'.repeat(70));
  console.log('MOMENTUM FILTER (entry with/against 5-candle momentum)');
  console.log('═'.repeat(70));
  
  const withMom = results.byMomentum.withMomentum;
  const againstMom = results.byMomentum.againstMomentum;
  console.log(`With momentum (fade the move): ${withMom.length} trades, ${(withMom.filter(e => e.win).length / withMom.length * 100).toFixed(1)}% win rate`);
  console.log(`Against momentum: ${againstMom.length} trades, ${(againstMom.filter(e => e.win).length / againstMom.length * 100).toFixed(1)}% win rate`);
  
  console.log('\n' + '═'.repeat(70));
  console.log('TOUCH ORDER (first touch vs retests of same level)');
  console.log('═'.repeat(70));
  
  const first = results.byTouchOrder.first;
  const second = results.byTouchOrder.second;
  const third = results.byTouchOrder.third;
  console.log(`First touch: ${first.length} trades, ${(first.filter(e => e.win).length / first.length * 100).toFixed(1)}% win rate`);
  console.log(`Second touch: ${second.length} trades, ${(second.filter(e => e.win).length / second.length * 100).toFixed(1)}% win rate`);
  console.log(`Third+ touch: ${third.length} trades, ${(third.filter(e => e.win).length / third.length * 100).toFixed(1)}% win rate`);
  
  console.log('\n' + '═'.repeat(70));
  console.log('IV LEVEL ANALYSIS (High IV > 25%, Low IV < 25%)');
  console.log('═'.repeat(70));
  
  const highIV = results.byIVLevel.highIV;
  const lowIV = results.byIVLevel.lowIV;
  if (highIV.length > 0) console.log(`High IV (>25%): ${highIV.length} trades, ${(highIV.filter(e => e.win).length / highIV.length * 100).toFixed(1)}% win rate`);
  if (lowIV.length > 0) console.log(`Low IV (<25%): ${lowIV.length} trades, ${(lowIV.filter(e => e.win).length / lowIV.length * 100).toFixed(1)}% win rate`);
  
  console.log('\n' + '═'.repeat(70));
  console.log('IV SKEW ANALYSIS (Put IV vs Call IV)');
  console.log('═'.repeat(70));
  
  const putSkew = results.byIVSkew.putSkew;
  const callSkew = results.byIVSkew.callSkew;
  if (putSkew.length > 0) console.log(`Put skew (bearish fear): ${putSkew.length} trades, ${(putSkew.filter(e => e.win).length / putSkew.length * 100).toFixed(1)}% win rate`);
  if (callSkew.length > 0) console.log(`Call skew (bullish): ${callSkew.length} trades, ${(callSkew.filter(e => e.win).length / callSkew.length * 100).toFixed(1)}% win rate`);
  
  // Summary
  console.log('\n' + '═'.repeat(70));
  console.log('KEY FINDINGS FOR SCALPING STRATEGY');
  console.log('═'.repeat(70));
}

main().catch(console.error);
