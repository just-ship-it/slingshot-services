/**
 * Overnight High-Frequency Strategy Comparison
 *
 * Tests multiple overnight strategies targeting ~1 trade per night.
 * All strategies tested on the same data for direct comparison.
 *
 * Strategies:
 * 1. LT Directional Hold — enter at open, time-exit at 2am/4am/8am
 * 2. First-Hour Momentum — trade in direction of first 60min move
 * 3. Overnight Mean Reversion — fade moves > X pts from overnight open
 * 4. Two-Phase: momentum first half, mean-revert second half
 * 5. GEX Level Proximity — enter when price approaches GEX S1/R1 in LT direction
 * 6. Overnight Range Fade — after range develops, fade the extremes
 * 7. Momentum Continuation — if strong first move, ride it with trailing stop
 *
 * Usage: node backtest-engine/research/overnight-high-freq-strategies.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// ============================================================================
// TIMEZONE
// ============================================================================
function isDST(utcMs) {
  const d = new Date(utcMs), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (m >= 3 && m <= 9) return true;
  if (m === 0 || m === 1 || m === 11) return false;
  if (m === 2) { const fd = new Date(Date.UTC(y,2,1)).getUTCDay(); return utcMs >= Date.UTC(y,2,fd===0?8:15-fd,7); }
  if (m === 10) { const fd = new Date(Date.UTC(y,10,1)).getUTCDay(); return utcMs < Date.UTC(y,10,fd===0?1:8-fd,6); }
  return false;
}
function utcToEST(ms) { return ms + (isDST(ms) ? -4 : -5) * 3600000; }
function getESTHour(ts) { const d = new Date(utcToEST(ts)); return d.getUTCHours() + d.getUTCMinutes()/60; }
function getESTDateStr(ts) { const d = new Date(utcToEST(ts)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function getDayOfWeek(ds) { return new Date(ds+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'long'}); }

// ============================================================================
// DATA LOADING
// ============================================================================
function loadOHLCV() {
  console.log('Loading NQ OHLCV...');
  const raw = fs.readFileSync(path.join(DATA_DIR,'ohlcv/nq/NQ_ohlcv_1m_continuous.csv'),'utf-8');
  const lines = raw.split('\n').filter(l=>l.trim());
  const c = [];
  for (let i=1;i<lines.length;i++) {
    const p=lines[i].split(',');
    if(p.length<6)continue;
    c.push({timestamp:new Date(p[0]).getTime(),open:+p[1],high:+p[2],low:+p[3],close:+p[4],volume:+p[5]||0});
  }
  console.log(`  ${c.length} candles`);
  return c;
}

function loadGEX() {
  console.log('Loading GEX...');
  const dir = path.join(DATA_DIR,'gex/nq');
  const files = fs.readdirSync(dir).filter(f=>f.startsWith('nq_gex_')&&f.endsWith('.json'));
  const g = {};
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir,f),'utf-8'));
      if(!d.metadata?.date||!d.data?.length) continue;
      const last = d.data[d.data.length-1];
      g[d.metadata.date] = {
        regime: last.regime, totalGex: last.total_gex,
        support: last.support||[], resistance: last.resistance||[],
        gammaFlip: last.gamma_flip, callWall: last.call_wall, putWall: last.put_wall,
      };
    } catch(e){}
  }
  console.log(`  ${Object.keys(g).length} dates`);
  return g;
}

function loadLT() {
  console.log('Loading LT...');
  const raw = fs.readFileSync(path.join(DATA_DIR,'liquidity/nq/NQ_liquidity_levels.csv'),'utf-8');
  const lines = raw.split('\n').filter(l=>l.trim());
  const lt = {};
  for (let i=1;i<lines.length;i++) {
    const p=lines[i].split(',');
    if(p.length<8)continue;
    lt[p[0].split(' ')[0]] = { sentiment: p[2] };
  }
  console.log(`  ${Object.keys(lt).length} dates`);
  return lt;
}

// ============================================================================
// SESSION BUILDER
// ============================================================================
function buildSessions(candles) {
  console.log('Building overnight sessions...');
  const byDate = {};
  for (const c of candles) {
    const d = getESTDateStr(c.timestamp);
    if(!byDate[d]) byDate[d]=[];
    byDate[d].push({...c, estHour:getESTHour(c.timestamp)});
  }
  const dates = Object.keys(byDate).sort();
  const sessions = [];

  for (let i=0;i<dates.length-1;i++) {
    const today=dates[i], tomorrow=dates[i+1];
    const tc=byDate[today]||[], nc=byDate[tomorrow]||[];
    const rth = tc.filter(c=>c.estHour>=9.5&&c.estHour<16);
    if(rth.length<30)continue;
    const rthHigh=Math.max(...rth.map(c=>c.high));
    const rthLow=Math.min(...rth.map(c=>c.low));
    const rthClose=rth[rth.length-1].close;
    const rthOpen=rth[0].open;
    const ibs = rthHigh>rthLow ? (rthClose-rthLow)/(rthHigh-rthLow) : 0.5;
    const dayOfWeek = getDayOfWeek(today);
    if (dayOfWeek === 'Friday' || dayOfWeek === 'Saturday') continue; // Skip weekend overnights

    // Overnight candles: 6PM today through 8AM tomorrow
    const on = [...tc.filter(c=>c.estHour>=18), ...nc.filter(c=>c.estHour<8)];
    if(on.length<30)continue;

    sessions.push({
      date: today, nextDate: tomorrow, dayOfWeek,
      rthOpen, rthClose, rthHigh, rthLow, ibs,
      rthReturn: rthClose - rthOpen,
      overnightCandles: on,
      overnightOpen: on[0].open,
    });
  }
  console.log(`  ${sessions.length} sessions`);
  return sessions;
}

// ============================================================================
// TRADE HELPERS
// ============================================================================
function simulateFromCandle(candles, startIdx, side, sl, tp, maxBars, exitHour) {
  const entry = candles[startIdx].close;
  const isLong = side === 'buy';
  const stop = isLong ? entry - sl : entry + sl;
  const target = tp < 9000 ? (isLong ? entry + tp : entry - tp) : null;
  let mfe=0, mae=0;

  for (let j=startIdx+1; j<candles.length && j<startIdx+maxBars; j++) {
    const c = candles[j];
    // Time exit
    if (exitHour && c.estHour >= exitHour && c.estHour < 18) {
      const pnl = isLong ? c.open-entry : entry-c.open;
      return {pnl, mfe, mae, exit:'time_exit', bars:j-startIdx, entryPrice:entry, exitPrice:c.open};
    }
    // MFE/MAE
    if(isLong){mfe=Math.max(mfe,c.high-entry);mae=Math.max(mae,entry-c.low);}
    else{mfe=Math.max(mfe,entry-c.low);mae=Math.max(mae,c.high-entry);}
    // Stop
    if(isLong&&c.low<=stop) return {pnl:stop-entry,mfe,mae,exit:'stop',bars:j-startIdx,entryPrice:entry,exitPrice:stop};
    if(!isLong&&c.high>=stop) return {pnl:entry-stop,mfe,mae,exit:'stop',bars:j-startIdx,entryPrice:entry,exitPrice:stop};
    // Target
    if(target){
      if(isLong&&c.high>=target) return {pnl:target-entry,mfe,mae,exit:'target',bars:j-startIdx,entryPrice:entry,exitPrice:target};
      if(!isLong&&c.low<=target) return {pnl:entry-target,mfe,mae,exit:'target',bars:j-startIdx,entryPrice:entry,exitPrice:target};
    }
  }
  // Session end
  const last = candles[Math.min(startIdx+maxBars-1, candles.length-1)];
  const pnl = isLong ? last.close-entry : entry-last.close;
  return {pnl, mfe, mae, exit:'session_end', bars:maxBars, entryPrice:entry, exitPrice:last.close};
}

function metrics(trades, label) {
  if(!trades.length) return null;
  const w=trades.filter(t=>t.pnl>0), l=trades.filter(t=>t.pnl<=0);
  const total=trades.reduce((s,t)=>s+t.pnl,0);
  const avg=total/trades.length;
  const wr=w.length/trades.length*100;
  const avgW=w.length?w.reduce((s,t)=>s+t.pnl,0)/w.length:0;
  const avgL=l.length?l.reduce((s,t)=>s+t.pnl,0)/l.length:0;
  const pf=l.length?w.reduce((s,t)=>s+t.pnl,0)/Math.abs(l.reduce((s,t)=>s+t.pnl,0)):Infinity;
  const std=Math.sqrt(trades.reduce((s,t)=>s+Math.pow(t.pnl-avg,2),0)/trades.length);
  const sharpe=std>0?avg/std:0;
  const mfe=trades.reduce((s,t)=>s+t.mfe,0)/trades.length;
  const mae=trades.reduce((s,t)=>s+t.mae,0)/trades.length;
  let peak=0,maxDD=0,eq=0;
  for(const t of trades){eq+=t.pnl;if(eq>peak)peak=eq;maxDD=Math.max(maxDD,peak-eq);}
  return {label,n:trades.length,wr,total,avg,avgW,avgL,pf,sharpe,std,mfe,mae,maxDD,eq};
}

function printRow(m) {
  if(!m)return;
  const pfStr = m.pf>=99?'  Inf':m.pf.toFixed(1).padStart(6);
  console.log(`  ${m.label.padEnd(52)} ${String(m.n).padStart(5)} ${m.wr.toFixed(1).padStart(6)}% ${m.avg.toFixed(1).padStart(7)} ${m.total.toFixed(0).padStart(9)} ${m.sharpe.toFixed(3).padStart(7)} ${pfStr} ${m.maxDD.toFixed(0).padStart(7)} ${m.mfe.toFixed(0).padStart(5)} ${m.mae.toFixed(0).padStart(5)}`);
}

// ============================================================================
// STRATEGIES
// ============================================================================

// Strategy 1: LT Directional Hold
function stratLTHold(sessions, ltData, params) {
  const {sl, tp, exitHour, maxBars} = params;
  const trades = [];
  for (const s of sessions) {
    const lt = ltData[s.date];
    if (!lt?.sentiment) continue;
    const side = lt.sentiment === 'BULLISH' ? 'buy' : 'sell';
    const result = simulateFromCandle(s.overnightCandles, 0, side, sl, tp, maxBars, exitHour);
    trades.push({...result, date:s.date, side});
  }
  return trades;
}

// Strategy 2: First-Hour Momentum
function stratFirstHourMomentum(sessions, params) {
  const {sl, tp, exitHour, maxBars, lookbackBars, minMove} = params;
  const trades = [];
  for (const s of sessions) {
    const cn = s.overnightCandles;
    if (cn.length < lookbackBars + 10) continue;
    // Measure first N bars direction
    const firstHourReturn = cn[lookbackBars-1].close - cn[0].open;
    if (Math.abs(firstHourReturn) < minMove) continue;
    const side = firstHourReturn > 0 ? 'buy' : 'sell';
    const result = simulateFromCandle(cn, lookbackBars, side, sl, tp, maxBars, exitHour);
    trades.push({...result, date:s.date, side, firstHourReturn});
  }
  return trades;
}

// Strategy 3: Overnight Mean Reversion
function stratMeanReversion(sessions, params) {
  const {sl, tp, exitHour, maxBars, threshold} = params;
  const trades = [];
  for (const s of sessions) {
    const cn = s.overnightCandles;
    const openPrice = cn[0].open;
    for (let i=1; i<cn.length; i++) {
      const move = cn[i].close - openPrice;
      if (Math.abs(move) >= threshold) {
        // Fade the move
        const side = move > 0 ? 'sell' : 'buy';
        const result = simulateFromCandle(cn, i, side, sl, tp, maxBars, exitHour);
        trades.push({...result, date:s.date, side, triggerMove:move});
        break; // One trade per night
      }
    }
  }
  return trades;
}

// Strategy 4: Mean Reversion with LT filter (only fade against LT direction)
function stratFilteredMeanReversion(sessions, ltData, params) {
  const {sl, tp, exitHour, maxBars, threshold} = params;
  const trades = [];
  for (const s of sessions) {
    const lt = ltData[s.date];
    if (!lt?.sentiment) continue;
    const cn = s.overnightCandles;
    const openPrice = cn[0].open;
    for (let i=1; i<cn.length; i++) {
      const move = cn[i].close - openPrice;
      if (Math.abs(move) >= threshold) {
        // Only fade moves AGAINST LT direction (mean revert toward LT bias)
        const side = move > 0 ? 'sell' : 'buy';
        // Check: if LT is BULLISH and price moved down → buy the dip (aligned)
        // If LT is BULLISH and price moved up → don't fade (LT says up is right)
        if (lt.sentiment === 'BULLISH' && side === 'buy') {
          const result = simulateFromCandle(cn, i, side, sl, tp, maxBars, exitHour);
          trades.push({...result, date:s.date, side});
          break;
        }
        if (lt.sentiment === 'BEARISH' && side === 'sell') {
          const result = simulateFromCandle(cn, i, side, sl, tp, maxBars, exitHour);
          trades.push({...result, date:s.date, side});
          break;
        }
        break; // Move happened but wrong direction for LT
      }
    }
  }
  return trades;
}

// Strategy 5: GEX Level Bounce (overnight)
function stratGexBounce(sessions, gexData, ltData, params) {
  const {sl, tp, maxBars, proximity, useLT} = params;
  const trades = [];
  for (const s of sessions) {
    const gex = gexData[s.date];
    const lt = ltData[s.date];
    if (!gex) continue;
    const cn = s.overnightCandles;
    const levels = [];
    if (gex.support?.[0]) levels.push({price:gex.support[0], type:'support'});
    if (gex.support?.[1]) levels.push({price:gex.support[1], type:'support'});
    if (gex.resistance?.[0]) levels.push({price:gex.resistance[0], type:'resistance'});
    if (gex.resistance?.[1]) levels.push({price:gex.resistance[1], type:'resistance'});

    let traded = false;
    for (let i=1; i<cn.length && !traded; i++) {
      for (const level of levels) {
        if (cn[i].low <= level.price + proximity && cn[i].high >= level.price - proximity) {
          const side = level.type === 'support' ? 'buy' : 'sell';
          // LT filter: only trade in LT direction
          if (useLT && lt?.sentiment) {
            if (lt.sentiment === 'BULLISH' && side !== 'buy') continue;
            if (lt.sentiment === 'BEARISH' && side !== 'sell') continue;
          }
          const result = simulateFromCandle(cn, i, side, sl, tp, maxBars, null);
          trades.push({...result, date:s.date, side, level:level.price, levelType:level.type});
          traded = true;
          break;
        }
      }
    }
  }
  return trades;
}

// Strategy 6: Overnight Range Fade
function stratRangeFade(sessions, params) {
  const {sl, tp, exitHour, maxBars, rangeBars, fadeThresholdPct} = params;
  const trades = [];
  for (const s of sessions) {
    const cn = s.overnightCandles;
    if (cn.length < rangeBars + 20) continue;
    // Build range from first N bars
    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (let i=0; i<rangeBars; i++) {
      rangeHigh = Math.max(rangeHigh, cn[i].high);
      rangeLow = Math.min(rangeLow, cn[i].low);
    }
    const rangeSize = rangeHigh - rangeLow;
    if (rangeSize < 10) continue; // Skip tiny ranges
    const fadeLevel = rangeSize * fadeThresholdPct;

    // Look for price to reach extremes after range develops
    for (let i=rangeBars; i<cn.length; i++) {
      // Fade the top
      if (cn[i].high >= rangeHigh + fadeLevel) {
        const result = simulateFromCandle(cn, i, 'sell', sl, tp, maxBars, exitHour);
        trades.push({...result, date:s.date, side:'sell', rangeSize});
        break;
      }
      // Fade the bottom
      if (cn[i].low <= rangeLow - fadeLevel) {
        const result = simulateFromCandle(cn, i, 'buy', sl, tp, maxBars, exitHour);
        trades.push({...result, date:s.date, side:'buy', rangeSize});
        break;
      }
    }
  }
  return trades;
}

// Strategy 7: First Hour Momentum + LT Confirmation
function stratMomentumLT(sessions, ltData, params) {
  const {sl, tp, exitHour, maxBars, lookbackBars, minMove} = params;
  const trades = [];
  for (const s of sessions) {
    const lt = ltData[s.date];
    if (!lt?.sentiment) continue;
    const cn = s.overnightCandles;
    if (cn.length < lookbackBars + 10) continue;
    const firstHourReturn = cn[lookbackBars-1].close - cn[0].open;
    if (Math.abs(firstHourReturn) < minMove) continue;
    const momentumSide = firstHourReturn > 0 ? 'buy' : 'sell';
    // Only trade when momentum agrees with LT
    if (lt.sentiment === 'BULLISH' && momentumSide !== 'buy') continue;
    if (lt.sentiment === 'BEARISH' && momentumSide !== 'sell') continue;
    const result = simulateFromCandle(cn, lookbackBars, momentumSide, sl, tp, maxBars, exitHour);
    trades.push({...result, date:s.date, side:momentumSide, firstHourReturn});
  }
  return trades;
}

// Strategy 8: Pullback in LT direction
function stratLTPullback(sessions, ltData, params) {
  const {sl, tp, exitHour, maxBars, pullbackPts, maxWaitBars} = params;
  const trades = [];
  for (const s of sessions) {
    const lt = ltData[s.date];
    if (!lt?.sentiment) continue;
    const cn = s.overnightCandles;
    const openPrice = cn[0].open;
    const ltSide = lt.sentiment === 'BULLISH' ? 'buy' : 'sell';

    // Wait for a pullback against LT direction, then enter
    for (let i=1; i<cn.length && i<maxWaitBars; i++) {
      const move = cn[i].close - openPrice;
      // BULLISH: wait for price to drop pullbackPts from open, then buy
      if (ltSide === 'buy' && move <= -pullbackPts) {
        const result = simulateFromCandle(cn, i, 'buy', sl, tp, maxBars, exitHour);
        trades.push({...result, date:s.date, side:'buy', pullback:move});
        break;
      }
      // BEARISH: wait for price to rise pullbackPts from open, then sell
      if (ltSide === 'sell' && move >= pullbackPts) {
        const result = simulateFromCandle(cn, i, 'sell', sl, tp, maxBars, exitHour);
        trades.push({...result, date:s.date, side:'sell', pullback:move});
        break;
      }
    }
  }
  return trades;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT HIGH-FREQUENCY STRATEGY COMPARISON — NQ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const candles = loadOHLCV();
  const gexData = loadGEX();
  const ltData = loadLT();
  const sessions = buildSessions(candles);

  const header = `  ${'Strategy'.padEnd(52)} ${'N'.padStart(5)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(9)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(7)} ${'MFE'.padStart(5)} ${'MAE'.padStart(5)}`;
  const divider = `  ${'─'.repeat(52)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(9)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(5)} ${'─'.repeat(5)}`;

  // ══════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  1. LT DIRECTIONAL HOLD                                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  for (const exitHour of [2, 4, 8]) {
    for (const [sl,tp] of [[50,50],[50,70],[70,70],[70,100],[100,100],[100,150],[150,150],[200,200],[9999,9999]]) {
      const t = stratLTHold(sessions, ltData, {sl,tp,exitHour,maxBars:840});
      const sltp = sl>=9999?'None':`${sl}/${tp}`;
      printRow(metrics(t, `LT Hold exit=${exitHour}am SL/TP=${sltp}`));
    }
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  2. FIRST-HOUR MOMENTUM                                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  for (const lookbackBars of [30, 60, 120]) {
    for (const minMove of [10, 20, 30, 50]) {
      for (const [sl,tp] of [[30,30],[30,50],[50,50],[50,70],[70,100],[100,100]]) {
        const t = stratFirstHourMomentum(sessions, {sl,tp,exitHour:8,maxBars:600,lookbackBars,minMove});
        if(t.length<30) continue;
        printRow(metrics(t, `Momentum ${lookbackBars}bar min${minMove} SL${sl}/TP${tp}`));
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  3. OVERNIGHT MEAN REVERSION                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  for (const threshold of [20, 30, 40, 50, 70]) {
    for (const [sl,tp] of [[20,20],[20,30],[30,30],[30,50],[50,50],[50,70],[70,100]]) {
      for (const exitHour of [2, 4, 8]) {
        const t = stratMeanReversion(sessions, {sl,tp,exitHour,maxBars:600,threshold});
        if(t.length<30) continue;
        printRow(metrics(t, `MeanRev thr=${threshold} SL${sl}/TP${tp} exit=${exitHour}am`));
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  4. LT-FILTERED MEAN REVERSION (fade against LT bias)      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  for (const threshold of [15, 20, 30, 40, 50]) {
    for (const [sl,tp] of [[20,20],[20,30],[30,30],[30,50],[50,50],[50,70],[70,100]]) {
      for (const exitHour of [2, 4, 8]) {
        const t = stratFilteredMeanReversion(sessions, ltData, {sl,tp,exitHour,maxBars:600,threshold});
        if(t.length<30) continue;
        printRow(metrics(t, `LT+MeanRev thr=${threshold} SL${sl}/TP${tp} exit=${exitHour}am`));
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  5. GEX LEVEL BOUNCE (overnight)                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  for (const proximity of [5, 10, 15, 20]) {
    for (const [sl,tp] of [[10,10],[10,15],[15,15],[15,20],[20,20],[20,30],[30,30]]) {
      for (const useLT of [false, true]) {
        const t = stratGexBounce(sessions, gexData, ltData, {sl,tp,maxBars:120,proximity,useLT});
        if(t.length<20) continue;
        const ltStr = useLT ? '+LT' : '';
        printRow(metrics(t, `GexBounce${ltStr} prox=${proximity} SL${sl}/TP${tp}`));
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  6. OVERNIGHT RANGE FADE                                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  for (const rangeBars of [60, 120, 180]) {
    for (const fadeThresholdPct of [0, 0.25, 0.5]) {
      for (const [sl,tp] of [[20,20],[20,30],[30,30],[30,50],[50,50]]) {
        const t = stratRangeFade(sessions, {sl,tp,exitHour:8,maxBars:300,rangeBars,fadeThresholdPct});
        if(t.length<30) continue;
        printRow(metrics(t, `RangeFade ${rangeBars}bar fade=${fadeThresholdPct} SL${sl}/TP${tp}`));
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  7. FIRST-HOUR MOMENTUM + LT CONFIRMATION                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  for (const lookbackBars of [30, 60]) {
    for (const minMove of [10, 20, 30]) {
      for (const [sl,tp] of [[30,30],[30,50],[50,50],[50,70],[70,100],[100,100],[100,150]]) {
        for (const exitHour of [2, 4, 8]) {
          const t = stratMomentumLT(sessions, ltData, {sl,tp,exitHour,maxBars:600,lookbackBars,minMove});
          if(t.length<30) continue;
          printRow(metrics(t, `MomLT ${lookbackBars}bar min${minMove} SL${sl}/TP${tp} ex${exitHour}`));
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  8. LT PULLBACK ENTRY                                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  for (const pullbackPts of [10, 15, 20, 30, 40, 50]) {
    for (const maxWaitBars of [120, 240, 480]) {
      for (const [sl,tp] of [[30,30],[30,50],[50,50],[50,70],[70,100],[100,100],[100,150]]) {
        for (const exitHour of [2, 4, 8]) {
          const t = stratLTPullback(sessions, ltData, {sl,tp,exitHour,maxBars:600,pullbackPts,maxWaitBars});
          if(t.length<30) continue;
          printRow(metrics(t, `LTPull ${pullbackPts}pt wait${maxWaitBars} SL${sl}/TP${tp} ex${exitHour}`));
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // CROSS-STRATEGY LEADERBOARD
  // ══════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('  LEADERBOARD: TOP CONFIGS BY SHARPE (min 100 trades)');
  console.log('═'.repeat(70));

  // Re-run all strategies and collect results
  const allResults = [];
  const collectResults = (trades, label) => {
    const m = metrics(trades, label);
    if (m && m.n >= 100) allResults.push(m);
  };

  // LT Hold
  for (const exitHour of [2,4,8]) {
    for (const [sl,tp] of [[50,50],[50,70],[70,70],[70,100],[100,100],[100,150],[150,150],[200,200],[9999,9999]]) {
      collectResults(stratLTHold(sessions,ltData,{sl,tp,exitHour,maxBars:840}), `LT Hold ex${exitHour} ${sl>=9999?'None':sl+'/'+tp}`);
    }
  }
  // Momentum
  for (const lb of [30,60]) for (const mm of [10,20]) for (const [sl,tp] of [[30,50],[50,50],[50,70],[70,100],[100,100]]) {
    collectResults(stratFirstHourMomentum(sessions,{sl,tp,exitHour:8,maxBars:600,lookbackBars:lb,minMove:mm}), `Mom ${lb}b min${mm} ${sl}/${tp}`);
  }
  // Mean Rev
  for (const thr of [20,30,40,50]) for (const [sl,tp] of [[20,30],[30,30],[30,50],[50,50],[50,70]]) for (const ex of [2,4,8]) {
    collectResults(stratMeanReversion(sessions,{sl,tp,exitHour:ex,maxBars:600,threshold:thr}), `MR thr${thr} ${sl}/${tp} ex${ex}`);
  }
  // LT+MR
  for (const thr of [15,20,30,40]) for (const [sl,tp] of [[20,30],[30,30],[30,50],[50,50],[50,70]]) for (const ex of [2,4,8]) {
    collectResults(stratFilteredMeanReversion(sessions,ltData,{sl,tp,exitHour:ex,maxBars:600,threshold:thr}), `LT+MR thr${thr} ${sl}/${tp} ex${ex}`);
  }
  // Mom+LT
  for (const lb of [30,60]) for (const mm of [10,20]) for (const [sl,tp] of [[30,50],[50,50],[50,70],[70,100],[100,100]]) for (const ex of [2,4,8]) {
    collectResults(stratMomentumLT(sessions,ltData,{sl,tp,exitHour:ex,maxBars:600,lookbackBars:lb,minMove:mm}), `MomLT ${lb}b min${mm} ${sl}/${tp} ex${ex}`);
  }
  // LT Pullback
  for (const pb of [10,15,20,30]) for (const mw of [120,240]) for (const [sl,tp] of [[30,50],[50,50],[50,70],[70,100],[100,100]]) for (const ex of [2,4,8]) {
    collectResults(stratLTPullback(sessions,ltData,{sl,tp,exitHour:ex,maxBars:600,pullbackPts:pb,maxWaitBars:mw}), `Pull ${pb}pt w${mw} ${sl}/${tp} ex${ex}`);
  }

  allResults.sort((a,b) => b.sharpe - a.sharpe);
  console.log(header); console.log(divider);
  for (let i=0; i<Math.min(40, allResults.length); i++) printRow(allResults[i]);

  // Top by total PnL
  console.log('\n\n  TOP 20 BY TOTAL PNL (min 100 trades):');
  console.log(header); console.log(divider);
  allResults.sort((a,b) => b.total - a.total);
  for (let i=0; i<Math.min(20, allResults.length); i++) printRow(allResults[i]);

  // Top by WR (min 100 trades)
  console.log('\n\n  TOP 20 BY WIN RATE (min 100 trades):');
  console.log(header); console.log(divider);
  allResults.sort((a,b) => b.wr - a.wr);
  for (let i=0; i<Math.min(20, allResults.length); i++) printRow(allResults[i]);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  COMPARISON COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
