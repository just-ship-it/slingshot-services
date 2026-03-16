/**
 * Overnight LT Crossing — Parameter Sweep
 *
 * Baseline: 20/20 symmetric, 55% WR, 473 trades
 *
 * Philosophy: Wide initial stops (50-100pt) to let the trade breathe on NQ,
 * then tighten/trail once 20-30pts of profit are reached.
 *
 * Sweep dimensions:
 *   - Score threshold: 3-6
 *   - Initial stop: 50, 70, 100, 150
 *   - Take profit: 30, 50, 70, 100, 150, None
 *   - Trailing: activate at 15-40pt profit, trail 10-30pt behind
 *   - MFE ratchet: lock progressively more profit at milestones
 *   - Breakeven stop: move to BE at 20-30pt profit
 *
 * Uses engine data pipeline (raw contracts).
 *
 * Usage: cd backtest-engine && node research/overnight-ltx-sweep.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../src/data/csv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));

// ============================================================================
// TIMEZONE
// ============================================================================
function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
function getESTHour(ts){const d=new Date(ts+(isDST(ts)?-4:-5)*3600000);return d.getUTCHours()+d.getUTCMinutes()/60;}
function getESTDateStr(ts){const d=new Date(ts+(isDST(ts)?-4:-5)*3600000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}
function getDayOfWeek(ds){return new Date(ds+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'long'});}

// ============================================================================
// DATA + SIGNAL BUILDING (same as research script)
// ============================================================================
async function loadAndBuildSignals() {
  console.log('Loading data...');
  const csvLoader = new CSVLoader(DATA_DIR, CONFIG, {noContinuous:true});
  const {candles:raw} = await csvLoader.loadOHLCVData('NQ', new Date('2023-03-28'), new Date('2025-12-25'));
  const candles = csvLoader.filterPrimaryContract(raw);
  const ltRecords = await csvLoader.loadLiquidityData('NQ', new Date('2023-03-28'), new Date('2025-12-25'));
  console.log(`  ${candles.length} candles, ${ltRecords.length} LT records`);

  const priceByTs = new Map();
  for (const c of candles) priceByTs.set(c.timestamp, c);
  function getPrice(ts) {
    if (priceByTs.has(ts)) return priceByTs.get(ts);
    for (let o=60000;o<=120000;o+=60000){if(priceByTs.has(ts-o))return priceByTs.get(ts-o);if(priceByTs.has(ts+o))return priceByTs.get(ts+o);}
    return null;
  }

  const ltByDate={};
  for(const lt of ltRecords){const d=getESTDateStr(lt.timestamp);if(!ltByDate[d])ltByDate[d]=[];ltByDate[d].push(lt);}
  const candlesByDate={};
  for(const c of candles){const d=getESTDateStr(c.timestamp);if(!candlesByDate[d])candlesByDate[d]=[];candlesByDate[d].push({...c,estHour:getESTHour(c.timestamp)});}

  const LEVELS=['level_1','level_2','level_3','level_4','level_5'];
  const FIB_WEIGHTS=[1,1,2,3,4];
  const dates=Object.keys(candlesByDate).sort();

  console.log('Building nightly signals...');
  const nights = [];

  for(let di=0;di<dates.length-1;di++){
    const today=dates[di],tomorrow=dates[di+1];
    if(['Friday','Saturday'].includes(getDayOfWeek(today)))continue;
    const tc=candlesByDate[today]||[],nc=candlesByDate[tomorrow]||[];
    const overnight=[...tc.filter(c=>c.estHour>=18),...nc.filter(c=>c.estHour<8)];
    if(overnight.length<60)continue;
    const ltOn=[...(ltByDate[today]||[]).filter(lt=>getESTHour(lt.timestamp)>=18),...(ltByDate[tomorrow]||[]).filter(lt=>getESTHour(lt.timestamp)<8)].sort((a,b)=>a.timestamp-b.timestamp);
    if(ltOn.length<4)continue;

    // Build score timeline
    let score=0;
    const timeline=[];
    for(let i=1;i<ltOn.length;i++){
      const prev=ltOn[i-1],curr=ltOn[i];
      const pP=getPrice(prev.timestamp),pC=getPrice(curr.timestamp);
      if(!pP||!pC)continue;
      const sP=(pP.high+pP.low)/2,sC=(pC.high+pC.low)/2;
      let batch=0;
      for(let l=0;l<5;l++){
        const lp=prev[LEVELS[l]],lc=curr[LEVELS[l]];
        if(lp==null||lc==null)continue;
        if((lp>sP)===(lc>sC))continue;
        batch+=((lp>sP&&!(lc>sC))?1:-1)*FIB_WEIGHTS[l];
      }
      if(batch!==0){
        score+=batch;
        const idx=overnight.findIndex(c=>c.timestamp>=curr.timestamp);
        if(idx>=0)timeline.push({barIdx:idx,score,estHour:getESTHour(curr.timestamp)});
      }
    }
    if(timeline.length>0) nights.push({date:today,dayOfWeek:getDayOfWeek(today),overnight,timeline,finalScore:score});
  }

  console.log(`  ${nights.length} nights with signals\n`);
  return nights;
}

// ============================================================================
// TRADE SIMULATOR — supports wide stop + ratcheting trail
// ============================================================================
function simulateTrade(candles, entryBar, side, params) {
  const {
    initialStop,     // Wide initial stop (e.g., 70pts)
    takeProfit,      // Fixed target (0 = no target, use trailing only)
    // Breakeven
    breakevenTrigger, // Move stop to breakeven at this profit level (0=disabled)
    breakevenOffset,  // Offset from entry for BE stop (0=exact entry, negative=allow small loss)
    // Trailing stop
    trailTrigger,    // Activate trailing at this profit (e.g., 20pts)
    trailOffset,     // Trail this far behind HWM (e.g., 15pts)
    // Ratchet tiers: array of {trigger, lockPct} e.g., [{trigger:20, lockPct:0.25}, {trigger:40, lockPct:0.5}]
    ratchetTiers,
    // Max hold
    maxBars,
    exitHour,
  } = params;

  const entry = candles[entryBar].close;
  const isLong = side === 'buy';
  let currentStop = initialStop > 0 ? (isLong ? entry - initialStop : entry + initialStop) : null;
  const target = takeProfit > 0 ? (isLong ? entry + takeProfit : entry - takeProfit) : null;

  let mfe = 0, mae = 0;
  let beTriggered = false;
  let trailActive = false;
  let currentRatchetTier = -1;

  for (let j = entryBar + 1; j < candles.length && j < entryBar + maxBars; j++) {
    const c = candles[j];

    // Time exit
    if (exitHour && c.estHour >= exitHour && c.estHour < 18) {
      const pnl = isLong ? c.open - entry : entry - c.open;
      return { pnl, mfe, mae, exit: 'time', bars: j - entryBar };
    }

    // MFE/MAE
    const highPnl = isLong ? c.high - entry : entry - c.low;
    const lowPnl = isLong ? c.low - entry : entry - c.high;
    if (highPnl > mfe) mfe = highPnl;
    const adverse = isLong ? entry - c.low : c.high - entry;
    if (adverse > mae) mae = adverse;

    // ── Stop management (check BEFORE target to be conservative) ──

    // 1. Ratchet tiers: at each profit milestone, lock a % of profit
    if (ratchetTiers && ratchetTiers.length > 0) {
      for (let t = ratchetTiers.length - 1; t > currentRatchetTier; t--) {
        const tier = ratchetTiers[t];
        if (mfe >= tier.trigger) {
          const lockedProfit = mfe * tier.lockPct;
          const newStop = isLong ? entry + lockedProfit : entry - lockedProfit;
          if (currentStop == null || (isLong && newStop > currentStop) || (!isLong && newStop < currentStop)) {
            currentStop = newStop;
          }
          currentRatchetTier = t;
          break;
        }
      }
    }

    // 2. Breakeven: move stop to entry once trigger hit
    if (breakevenTrigger > 0 && !beTriggered && mfe >= breakevenTrigger) {
      beTriggered = true;
      const beStop = isLong ? entry + (breakevenOffset || 0) : entry - (breakevenOffset || 0);
      if (currentStop == null || (isLong && beStop > currentStop) || (!isLong && beStop < currentStop)) {
        currentStop = beStop;
      }
    }

    // 3. Trailing: once activated, trail behind HWM
    if (trailTrigger > 0 && mfe >= trailTrigger) {
      trailActive = true;
      const hwm = isLong ? entry + mfe : entry - mfe;
      const newTrail = isLong ? hwm - trailOffset : hwm + trailOffset;
      if (currentStop == null || (isLong && newTrail > currentStop) || (!isLong && newTrail < currentStop)) {
        currentStop = newTrail;
      }
    }

    // Check stop
    if (currentStop != null) {
      if (isLong && c.low <= currentStop) {
        const exitP = Math.max(currentStop, c.low); // Can't fill better than low
        return { pnl: exitP - entry, mfe, mae, exit: beTriggered || trailActive || currentRatchetTier >= 0 ? 'managed' : 'stop', bars: j - entryBar };
      }
      if (!isLong && c.high >= currentStop) {
        const exitP = Math.min(currentStop, c.high);
        return { pnl: entry - exitP, mfe, mae, exit: beTriggered || trailActive || currentRatchetTier >= 0 ? 'managed' : 'stop', bars: j - entryBar };
      }
    }

    // Check target
    if (target) {
      if (isLong && c.high >= target) return { pnl: takeProfit, mfe, mae, exit: 'target', bars: j - entryBar };
      if (!isLong && c.low <= target) return { pnl: takeProfit, mfe, mae, exit: 'target', bars: j - entryBar };
    }
  }

  const last = candles[Math.min(entryBar + maxBars - 1, candles.length - 1)];
  return { pnl: isLong ? last.close - entry : entry - last.close, mfe, mae, exit: 'end', bars: maxBars };
}

// ============================================================================
// STRATEGY RUNNER
// ============================================================================
function runStrategy(nights, params) {
  const trades = [];
  for (const night of nights) {
    let entryEvent = null;
    for (const ev of night.timeline) {
      if (Math.abs(ev.score) >= params.scoreThreshold) { entryEvent = ev; break; }
    }
    if (!entryEvent || entryEvent.barIdx >= night.overnight.length - 30) continue;

    const side = entryEvent.score > 0 ? 'buy' : 'sell';
    const result = simulateTrade(night.overnight, entryEvent.barIdx, side, params);
    trades.push({ ...result, date: night.date, side, score: entryEvent.score, dayOfWeek: night.dayOfWeek, entryHour: entryEvent.estHour });
  }
  return trades;
}

// ============================================================================
// METRICS
// ============================================================================
function m(trades, label) {
  if (!trades.length) return null;
  const w=trades.filter(t=>t.pnl>0),l=trades.filter(t=>t.pnl<=0);
  const total=trades.reduce((s,t)=>s+t.pnl,0),avg=total/trades.length;
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
  const exits={};for(const t of trades)exits[t.exit]=(exits[t.exit]||0)+1;
  return {label,n:trades.length,wr,total,avg,avgW,avgL,pf,sharpe,std,mfe,mae,maxDD,eq,exits};
}

function row(r) {
  if(!r)return;
  const pfStr=r.pf>=99?'  Inf':r.pf.toFixed(1).padStart(6);
  const exStr=Object.entries(r.exits).map(([k,v])=>`${k[0]}${v}`).join('/');
  console.log(`  ${r.label.padEnd(50)} ${String(r.n).padStart(4)} ${r.wr.toFixed(1).padStart(6)}% ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${r.sharpe.toFixed(3).padStart(7)} ${pfStr} ${r.maxDD.toFixed(0).padStart(6)} ${r.mfe.toFixed(0).padStart(5)} ${r.mae.toFixed(0).padStart(5)} ${exStr.padStart(16)}`);
}

function printM(r) {
  if(!r){console.log('  No trades');return;}
  console.log(`\n  ═══ ${r.label} ═══`);
  console.log(`  Trades: ${r.n} | WR: ${r.wr.toFixed(1)}% | PF: ${r.pf===Infinity?'Inf':r.pf.toFixed(2)} | Sharpe: ${r.sharpe.toFixed(3)}`);
  console.log(`  Total: ${r.total.toFixed(0)}pts | Avg: ${r.avg.toFixed(1)} | AvgWin: ${r.avgW.toFixed(1)} | AvgLoss: ${r.avgL.toFixed(1)}`);
  console.log(`  MFE: ${r.mfe.toFixed(1)} | MAE: ${r.mae.toFixed(1)} | MaxDD: ${r.maxDD.toFixed(0)} | Equity: ${r.eq.toFixed(0)}`);
  console.log(`  Exits: ${Object.entries(r.exits).map(([k,v])=>`${k}=${v}`).join(', ')}`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT LT CROSSING — PARAMETER SWEEP');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const nights = await loadAndBuildSignals();

  const hdr = `  ${'Config'.padEnd(50)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'MFE'.padStart(5)} ${'MAE'.padStart(5)} ${'Exits'.padStart(16)}`;
  const div = `  ${'─'.repeat(50)} ${'─'.repeat(4)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(16)}`;

  // ════════════════════════════════════════════════
  // 1. BASELINES — symmetric stop/target
  // ════════════════════════════════════════════════
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  1. BASELINES (symmetric)                                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(hdr); console.log(div);
  for (const scr of [3,4,5]) {
    for (const pts of [15,20,25,30,40,50]) {
      const t = runStrategy(nights, {scoreThreshold:scr,initialStop:pts,takeProfit:pts,breakevenTrigger:0,trailTrigger:0,trailOffset:0,ratchetTiers:null,maxBars:840,exitHour:8});
      row(m(t, `Scr${scr} ${pts}/${pts}`));
    }
  }

  // ════════════════════════════════════════════════
  // 2. WIDE STOP + FIXED TARGET
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  2. WIDE STOP + FIXED TARGET                                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(hdr); console.log(div);
  for (const scr of [3,4,5]) {
    for (const sl of [50,70,100]) {
      for (const tp of [20,30,40,50,70,100]) {
        const t = runStrategy(nights, {scoreThreshold:scr,initialStop:sl,takeProfit:tp,breakevenTrigger:0,trailTrigger:0,trailOffset:0,ratchetTiers:null,maxBars:840,exitHour:8});
        if(t.length<30)continue;
        row(m(t, `Scr${scr} SL${sl}/TP${tp}`));
      }
    }
  }

  // ════════════════════════════════════════════════
  // 3. WIDE STOP + BREAKEVEN AT PROFIT
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  3. WIDE STOP + BREAKEVEN TRIGGER                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(hdr); console.log(div);
  for (const scr of [3,4,5]) {
    for (const sl of [50,70,100]) {
      for (const beTrigger of [15,20,25,30]) {
        for (const tp of [0,50,70,100]) {
          const t = runStrategy(nights, {scoreThreshold:scr,initialStop:sl,takeProfit:tp,breakevenTrigger:beTrigger,breakevenOffset:0,trailTrigger:0,trailOffset:0,ratchetTiers:null,maxBars:840,exitHour:8});
          if(t.length<30)continue;
          const tpStr = tp > 0 ? `TP${tp}` : 'NoTP';
          row(m(t, `Scr${scr} SL${sl} BE@${beTrigger} ${tpStr}`));
        }
      }
    }
  }

  // ════════════════════════════════════════════════
  // 4. WIDE STOP + TRAILING STOP
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  4. WIDE STOP + TRAILING STOP                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(hdr); console.log(div);
  for (const scr of [3,4,5]) {
    for (const sl of [50,70,100]) {
      for (const [tt,to] of [[15,10],[20,10],[20,15],[25,15],[30,15],[30,20],[40,20],[40,25],[50,25],[50,30]]) {
        const t = runStrategy(nights, {scoreThreshold:scr,initialStop:sl,takeProfit:0,breakevenTrigger:0,trailTrigger:tt,trailOffset:to,ratchetTiers:null,maxBars:840,exitHour:8});
        if(t.length<30)continue;
        row(m(t, `Scr${scr} SL${sl} Trail@${tt}/${to}`));
      }
    }
  }

  // ════════════════════════════════════════════════
  // 5. WIDE STOP + RATCHET TIERS
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  5. WIDE STOP + RATCHET TIERS                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(hdr); console.log(div);
  const ratchetConfigs = [
    {name:'BE20+Lock50@40', tiers:[{trigger:20,lockPct:0},{trigger:40,lockPct:0.5}]},
    {name:'BE20+Lock40@30+60@50', tiers:[{trigger:20,lockPct:0},{trigger:30,lockPct:0.4},{trigger:50,lockPct:0.6}]},
    {name:'Lock25@20+50@40+70@60', tiers:[{trigger:20,lockPct:0.25},{trigger:40,lockPct:0.5},{trigger:60,lockPct:0.7}]},
    {name:'BE15+Lock33@25+50@40', tiers:[{trigger:15,lockPct:0},{trigger:25,lockPct:0.33},{trigger:40,lockPct:0.5}]},
    {name:'Lock25@15+40@25+60@40', tiers:[{trigger:15,lockPct:0.25},{trigger:25,lockPct:0.4},{trigger:40,lockPct:0.6}]},
    {name:'BE20+Lock50@30+75@50', tiers:[{trigger:20,lockPct:0},{trigger:30,lockPct:0.5},{trigger:50,lockPct:0.75}]},
  ];
  for (const scr of [3,4,5]) {
    for (const sl of [50,70,100]) {
      for (const rc of ratchetConfigs) {
        const t = runStrategy(nights, {scoreThreshold:scr,initialStop:sl,takeProfit:0,breakevenTrigger:0,trailTrigger:0,trailOffset:0,ratchetTiers:rc.tiers,maxBars:840,exitHour:8});
        if(t.length<30)continue;
        row(m(t, `Scr${scr} SL${sl} ${rc.name}`));
      }
    }
  }

  // ════════════════════════════════════════════════
  // 6. WIDE STOP + TRAILING + RATCHET COMBO
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  6. COMBO: WIDE STOP + RATCHET + TRAIL                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(hdr); console.log(div);
  for (const scr of [3,4,5]) {
    for (const sl of [50,70,100]) {
      for (const [tt,to] of [[20,10],[25,15],[30,15],[30,20]]) {
        for (const rc of ratchetConfigs.slice(0,3)) {
          const t = runStrategy(nights, {scoreThreshold:scr,initialStop:sl,takeProfit:0,breakevenTrigger:0,trailTrigger:tt,trailOffset:to,ratchetTiers:rc.tiers,maxBars:840,exitHour:8});
          if(t.length<30)continue;
          row(m(t, `Scr${scr} SL${sl} T@${tt}/${to}+${rc.name.substring(0,15)}`));
        }
      }
    }
  }

  // ════════════════════════════════════════════════
  // LEADERBOARD
  // ════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('  LEADERBOARD');
  console.log('═'.repeat(70));

  // Collect all results
  const all = [];
  const collect = (params, label) => {
    const t = runStrategy(nights, params);
    if (t.length >= 30) { const met = m(t, label); if (met) all.push(met); }
  };

  // Re-run key configs
  for (const scr of [3,4,5]) {
    for (const sl of [50,70,100]) {
      // Fixed targets
      for (const tp of [30,50,70]) collect({scoreThreshold:scr,initialStop:sl,takeProfit:tp,breakevenTrigger:0,trailTrigger:0,trailOffset:0,ratchetTiers:null,maxBars:840,exitHour:8}, `Scr${scr} SL${sl}/TP${tp}`);
      // BE + target
      for (const be of [20,25]) for (const tp of [50,70,100]) collect({scoreThreshold:scr,initialStop:sl,takeProfit:tp,breakevenTrigger:be,breakevenOffset:0,trailTrigger:0,trailOffset:0,ratchetTiers:null,maxBars:840,exitHour:8}, `Scr${scr} SL${sl} BE@${be} TP${tp}`);
      // Trail only
      for (const [tt,to] of [[20,10],[25,15],[30,15],[30,20],[40,20]]) collect({scoreThreshold:scr,initialStop:sl,takeProfit:0,breakevenTrigger:0,trailTrigger:tt,trailOffset:to,ratchetTiers:null,maxBars:840,exitHour:8}, `Scr${scr} SL${sl} Trail@${tt}/${to}`);
      // Ratchet
      for (const rc of ratchetConfigs.slice(0,3)) collect({scoreThreshold:scr,initialStop:sl,takeProfit:0,breakevenTrigger:0,trailTrigger:0,trailOffset:0,ratchetTiers:rc.tiers,maxBars:840,exitHour:8}, `Scr${scr} SL${sl} ${rc.name}`);
    }
  }

  all.sort((a,b) => b.sharpe - a.sharpe);
  console.log(`\n  TOP 30 BY SHARPE [${all.length} configs]`);
  console.log(hdr); console.log(div);
  for (let i=0;i<Math.min(30,all.length);i++) row(all[i]);

  all.sort((a,b) => b.total - a.total);
  console.log(`\n  TOP 20 BY TOTAL PNL`);
  console.log(hdr); console.log(div);
  for (let i=0;i<Math.min(20,all.length);i++) row(all[i]);

  all.sort((a,b) => b.wr - a.wr);
  console.log(`\n  TOP 20 BY WIN RATE`);
  console.log(hdr); console.log(div);
  for (let i=0;i<Math.min(20,all.length);i++) row(all[i]);

  // Detailed on best Sharpe
  if (all.length > 0) {
    all.sort((a,b) => b.sharpe - a.sharpe);
    const best = all[0];
    printM(best);

    // Monthly
    const bestTrades = []; // Re-collect -- hack but works
    // Find the matching config (use label parsing)
    console.log('\n  (Run detailed analysis on the best config via engine for monthly breakdown)');
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SWEEP COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
