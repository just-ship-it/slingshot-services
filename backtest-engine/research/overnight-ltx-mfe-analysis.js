/**
 * Overnight LT Crossing — MFE/MAE Deep Dive
 *
 * Problem: Winners avg 34pt MFE but we only capture 3pts.
 * Goal: Understand trade lifecycle to design better exits.
 *
 * Analyzes:
 *   - MFE/MAE distributions for winners vs losers
 *   - Time to MFE (how fast do winners move?)
 *   - MAE before MFE (how much pain before profit?)
 *   - Profit trajectory at 15m/30m/1hr/2hr/4hr marks
 *   - Entry hour impact on MFE/MAE
 *   - Score magnitude impact on MFE
 *   - Optimal fixed exit timing
 *   - What % of trades reach 20/30/40/50pt profit before hitting various stops
 *
 * Usage: cd backtest-engine && node research/overnight-ltx-mfe-analysis.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../src/data/csv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));

function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
function getESTHour(ts){const d=new Date(ts+(isDST(ts)?-4:-5)*3600000);return d.getUTCHours()+d.getUTCMinutes()/60;}
function getESTDateStr(ts){const d=new Date(ts+(isDST(ts)?-4:-5)*3600000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}
function getDayOfWeek(ds){return new Date(ds+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'long'});}

async function loadAndBuildSignals() {
  console.log('Loading data...');
  const csvLoader = new CSVLoader(DATA_DIR, CONFIG, {noContinuous:true});
  const {candles:raw} = await csvLoader.loadOHLCVData('NQ', new Date('2023-03-28'), new Date('2025-12-25'));
  const candles = csvLoader.filterPrimaryContract(raw);
  const ltRecords = await csvLoader.loadLiquidityData('NQ', new Date('2023-03-28'), new Date('2025-12-25'));

  const priceByTs = new Map();
  for (const c of candles) priceByTs.set(c.timestamp, c);
  function getPrice(ts) {
    if(priceByTs.has(ts))return priceByTs.get(ts);
    for(let o=60000;o<=120000;o+=60000){if(priceByTs.has(ts-o))return priceByTs.get(ts-o);if(priceByTs.has(ts+o))return priceByTs.get(ts+o);}
    return null;
  }

  const ltByDate={},candlesByDate={};
  for(const lt of ltRecords){const d=getESTDateStr(lt.timestamp);if(!ltByDate[d])ltByDate[d]=[];ltByDate[d].push(lt);}
  for(const c of candles){const d=getESTDateStr(c.timestamp);if(!candlesByDate[d])candlesByDate[d]=[];candlesByDate[d].push({...c,estHour:getESTHour(c.timestamp)});}

  const LEVELS=['level_1','level_2','level_3','level_4','level_5'];
  const FIB_WEIGHTS=[1,1,2,3,4];
  const dates=Object.keys(candlesByDate).sort();
  const trades = [];

  for(let di=0;di<dates.length-1;di++){
    const today=dates[di],tomorrow=dates[di+1];
    if(['Friday','Saturday'].includes(getDayOfWeek(today)))continue;
    const tc=candlesByDate[today]||[],nc=candlesByDate[tomorrow]||[];
    const overnight=[...tc.filter(c=>c.estHour>=18),...nc.filter(c=>c.estHour<8)];
    if(overnight.length<60)continue;
    const ltOn=[...(ltByDate[today]||[]).filter(lt=>getESTHour(lt.timestamp)>=18),...(ltByDate[tomorrow]||[]).filter(lt=>getESTHour(lt.timestamp)<8)].sort((a,b)=>a.timestamp-b.timestamp);
    if(ltOn.length<4)continue;

    let score=0;let entryBar=null,entrySide=null,entryScore=0;
    for(let i=1;i<ltOn.length;i++){
      const prev=ltOn[i-1],curr=ltOn[i];
      const pP=getPrice(prev.timestamp),pC=getPrice(curr.timestamp);
      if(!pP||!pC)continue;
      const sP=(pP.high+pP.low)/2,sC=(pC.high+pC.low)/2;
      for(let l=0;l<5;l++){
        const lp=prev[LEVELS[l]],lc=curr[LEVELS[l]];
        if(lp==null||lc==null)continue;
        if((lp>sP)===(lc>sC))continue;
        score+=((lp>sP&&!(lc>sC))?1:-1)*FIB_WEIGHTS[l];
      }
      if(Math.abs(score)>=4&&entryBar==null){
        const idx=overnight.findIndex(c=>c.timestamp>=curr.timestamp);
        if(idx>=0&&idx<overnight.length-30){entryBar=idx;entrySide=score>0?'buy':'sell';entryScore=score;break;}
      }
    }
    if(entryBar==null)continue;

    const entry=overnight[entryBar].close;
    const isLong=entrySide==='buy';
    const entryHour=getESTHour(overnight[entryBar].timestamp);

    // Track full profit/loss trajectory
    const trajectory = []; // {bar, pnl, mfe, mae, estHour}
    let mfe=0, mae=0, mfeBar=0, maeBeforeMfe=0;
    let reached20=false, reached30=false, reached40=false, reached50=false;
    let barsTo20=null, barsTo30=null, barsTo40=null, barsTo50=null;
    let maeAt20=null, maeAt30=null;

    for(let j=entryBar+1;j<overnight.length;j++){
      const c=overnight[j];
      const bar=j-entryBar;
      const pnl=isLong?c.close-entry:entry-c.close;
      const highPnl=isLong?c.high-entry:entry-c.low;
      const lowPnl=isLong?c.low-entry:entry-c.high;
      const adverse=isLong?entry-c.low:c.high-entry;

      if(highPnl>mfe){mfe=highPnl;mfeBar=bar;maeBeforeMfe=mae;}
      if(adverse>mae)mae=adverse;

      if(!reached20&&mfe>=20){reached20=true;barsTo20=bar;maeAt20=mae;}
      if(!reached30&&mfe>=30){reached30=true;barsTo30=bar;maeAt30=mae;}
      if(!reached40&&mfe>=40){reached40=true;barsTo40=bar;}
      if(!reached50&&mfe>=50){reached50=true;barsTo50=bar;}

      // Sample trajectory at key intervals
      if(bar===15||bar===30||bar===60||bar===120||bar===240||bar===480||bar===overnight.length-entryBar-1){
        trajectory.push({bar,pnl,mfe,mae,estHour:c.estHour});
      }
    }

    const finalPnl=isLong?overnight[overnight.length-1].close-entry:entry-overnight[overnight.length-1].close;

    trades.push({
      date:today, side:entrySide, score:entryScore, entryHour,
      entry, mfe, mae, mfeBar, maeBeforeMfe, finalPnl,
      reached20, reached30, reached40, reached50,
      barsTo20, barsTo30, barsTo40, barsTo50,
      maeAt20, maeAt30,
      trajectory,
      totalBars: overnight.length - entryBar,
    });
  }

  console.log(`  ${trades.length} trades analyzed\n`);
  return trades;
}

function pct(n, total) { return (n / total * 100).toFixed(1); }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function p(arr, pctile) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * pctile)]; }

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT LT CROSSING — MFE/MAE DEEP DIVE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const trades = await loadAndBuildSignals();

  // ════════════════════════════════════════════════
  // MFE/MAE DISTRIBUTIONS
  // ════════════════════════════════════════════════
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  MFE / MAE DISTRIBUTIONS                                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const mfes = trades.map(t => t.mfe).sort((a, b) => a - b);
  const maes = trades.map(t => t.mae).sort((a, b) => a - b);

  console.log('  MFE (Max Favorable Excursion):');
  console.log(`    P10=${p(mfes,0.1).toFixed(0)}  P25=${p(mfes,0.25).toFixed(0)}  P50=${p(mfes,0.5).toFixed(0)}  P75=${p(mfes,0.75).toFixed(0)}  P90=${p(mfes,0.9).toFixed(0)}  Avg=${avg(mfes).toFixed(1)}`);
  console.log('  MAE (Max Adverse Excursion):');
  console.log(`    P10=${p(maes,0.1).toFixed(0)}  P25=${p(maes,0.25).toFixed(0)}  P50=${p(maes,0.5).toFixed(0)}  P75=${p(maes,0.75).toFixed(0)}  P90=${p(maes,0.9).toFixed(0)}  Avg=${avg(maes).toFixed(1)}`);

  // MFE histogram
  console.log('\n  MFE Distribution:');
  for (const [lo, hi] of [[0,10],[10,20],[20,30],[30,50],[50,70],[70,100],[100,150],[150,999]]) {
    const count = trades.filter(t => t.mfe >= lo && t.mfe < hi).length;
    const bar = '█'.repeat(Math.round(count / trades.length * 100));
    console.log(`    ${String(lo).padStart(4)}-${String(hi).padStart(4)}: ${String(count).padStart(4)} (${pct(count, trades.length).padStart(5)}%) ${bar}`);
  }

  // ════════════════════════════════════════════════
  // PROFIT MILESTONE ANALYSIS
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  PROFIT MILESTONES — What % of trades reach each level?      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (const target of [10, 15, 20, 25, 30, 40, 50, 70, 100]) {
    const reached = trades.filter(t => t.mfe >= target).length;
    console.log(`  MFE >= ${String(target).padStart(3)}pts: ${String(reached).padStart(4)} / ${trades.length} (${pct(reached, trades.length)}%)`);
  }

  // ════════════════════════════════════════════════
  // STOP vs TARGET RACE
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  STOP vs TARGET RACE — Which hits first?                     ║');
  console.log('║  For each stop/target combo: what % hit target before stop?  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('         Target →  20pt    30pt    40pt    50pt    70pt   100pt');
  console.log('  Stop ↓         ────── ─────── ─────── ─────── ─────── ───────');

  for (const sl of [30, 40, 50, 70, 100]) {
    let line = `  ${String(sl).padStart(4)}pt       `;
    for (const tp of [20, 30, 40, 50, 70, 100]) {
      // For each trade, did it reach +tp before -sl?
      let wins = 0, losses = 0, neither = 0;
      for (const t of trades) {
        if (t.mfe >= tp && (t.mae < sl || t.mfe >= tp)) {
          // Check ordering: did MFE reach tp before MAE reached sl?
          // Use maeBeforeMfe as proxy — if mae before reaching mfe was < sl, target hit first
          // This is approximate; for exact we'd need candle-by-candle
          if (t.maeBeforeMfe < sl) wins++;
          else losses++;
        } else if (t.mae >= sl) {
          losses++;
        } else {
          neither++;
        }
      }
      const total = wins + losses;
      const wr = total > 0 ? (wins / total * 100) : 0;
      line += `${wr.toFixed(1).padStart(6)}% `;
    }
    console.log(line);
  }

  // ════════════════════════════════════════════════
  // TIME TO MFE
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  TIME TO PROFIT MILESTONES                                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (const [label, field] of [['20pt', 'barsTo20'], ['30pt', 'barsTo30'], ['40pt', 'barsTo40'], ['50pt', 'barsTo50']]) {
    const reached = trades.filter(t => t[field] != null);
    if (reached.length < 10) continue;
    const bars = reached.map(t => t[field]);
    console.log(`  Time to ${label} (${reached.length} trades that reached it):`);
    console.log(`    Avg: ${avg(bars).toFixed(0)} bars (${(avg(bars)/60).toFixed(1)}hr)  Median: ${median(bars)} bars  P25: ${p(bars,0.25)} bars  P75: ${p(bars,0.75)} bars`);
  }

  // MAE suffered before reaching profit milestones
  console.log('\n  MAE suffered BEFORE reaching profit milestone:');
  for (const [label, maeField, reachedField] of [['20pt', 'maeAt20', 'reached20'], ['30pt', 'maeAt30', 'reached30']]) {
    const reached = trades.filter(t => t[reachedField] && t[maeField] != null);
    if (reached.length < 10) continue;
    const maes = reached.map(t => t[maeField]);
    console.log(`  Before hitting ${label} profit: Avg MAE=${avg(maes).toFixed(1)}pts  Median=${median(maes).toFixed(0)}  P75=${p(maes,0.75).toFixed(0)}  P90=${p(maes,0.9).toFixed(0)}`);
  }

  // ════════════════════════════════════════════════
  // BAR-BY-BAR MFE
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  TIME TO MFE (when does peak profit occur?)                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const mfeBars = trades.map(t => t.mfeBar);
  console.log(`  MFE Bar: Avg=${avg(mfeBars).toFixed(0)}  Median=${median(mfeBars)}  P25=${p(mfeBars,0.25)}  P75=${p(mfeBars,0.75)}`);
  console.log(`  MFE Time: Avg=${(avg(mfeBars)/60).toFixed(1)}hr  Median=${(median(mfeBars)/60).toFixed(1)}hr`);

  // MFE bar distribution
  console.log('\n  When does MFE occur?');
  for (const [lo, hi, label] of [[0,30,'0-30m'],[30,60,'30m-1hr'],[60,120,'1-2hr'],[120,240,'2-4hr'],[240,480,'4-8hr'],[480,999,'8hr+']]) {
    const count = trades.filter(t => t.mfeBar >= lo && t.mfeBar < hi).length;
    console.log(`    ${label.padEnd(10)}: ${String(count).padStart(4)} (${pct(count, trades.length).padStart(5)}%)`);
  }

  // ════════════════════════════════════════════════
  // PROFIT TRAJECTORY (unrealized P&L over time)
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  PROFIT TRAJECTORY (avg unrealized P&L at each time mark)    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (const barMark of [15, 30, 60, 120, 240, 480]) {
    const atMark = trades.filter(t => t.trajectory.some(p => p.bar === barMark)).map(t => t.trajectory.find(p => p.bar === barMark));
    if (atMark.length < 20) continue;
    const avgPnl = avg(atMark.map(p => p.pnl));
    const avgMfe = avg(atMark.map(p => p.mfe));
    const avgMae = avg(atMark.map(p => p.mae));
    const wr = atMark.filter(p => p.pnl > 0).length / atMark.length * 100;
    const label = barMark < 60 ? `${barMark}min` : `${barMark/60}hr`;
    console.log(`  At ${label.padEnd(6)}: avgPnL=${avgPnl.toFixed(1).padStart(6)}  avgMFE=${avgMfe.toFixed(0).padStart(4)}  avgMAE=${avgMae.toFixed(0).padStart(4)}  WR=${wr.toFixed(1)}%  (n=${atMark.length})`);
  }

  // ════════════════════════════════════════════════
  // ENTRY HOUR ANALYSIS
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  ENTRY HOUR IMPACT                                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (let h = 18; h <= 23; h++) {
    const sub = trades.filter(t => Math.floor(t.entryHour) === h);
    if (sub.length < 10) continue;
    console.log(`  ${h}:00 EST: ${String(sub.length).padStart(4)} trades  MFE=${avg(sub.map(t=>t.mfe)).toFixed(0).padStart(4)}  MAE=${avg(sub.map(t=>t.mae)).toFixed(0).padStart(4)}  MFE/MAE=${(avg(sub.map(t=>t.mfe))/avg(sub.map(t=>t.mae))).toFixed(2)}  finalPnL=${avg(sub.map(t=>t.finalPnl)).toFixed(1).padStart(6)}  reach20=${pct(sub.filter(t=>t.reached20).length,sub.length)}%`);
  }
  for (let h = 0; h <= 7; h++) {
    const sub = trades.filter(t => Math.floor(t.entryHour) === h);
    if (sub.length < 10) continue;
    console.log(`  ${String(h).padStart(2)}:00 EST: ${String(sub.length).padStart(4)} trades  MFE=${avg(sub.map(t=>t.mfe)).toFixed(0).padStart(4)}  MAE=${avg(sub.map(t=>t.mae)).toFixed(0).padStart(4)}  MFE/MAE=${(avg(sub.map(t=>t.mfe))/avg(sub.map(t=>t.mae))).toFixed(2)}  finalPnL=${avg(sub.map(t=>t.finalPnl)).toFixed(1).padStart(6)}  reach20=${pct(sub.filter(t=>t.reached20).length,sub.length)}%`);
  }

  // ════════════════════════════════════════════════
  // SCORE MAGNITUDE IMPACT
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  SCORE MAGNITUDE IMPACT                                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (const [lo, hi] of [[4,5],[5,6],[6,8],[8,99]]) {
    const sub = trades.filter(t => Math.abs(t.score) >= lo && Math.abs(t.score) < hi);
    if (sub.length < 10) continue;
    console.log(`  Score ${lo}-${hi >= 99 ? '+' : hi}: ${String(sub.length).padStart(4)} trades  MFE=${avg(sub.map(t=>t.mfe)).toFixed(0).padStart(4)}  MAE=${avg(sub.map(t=>t.mae)).toFixed(0).padStart(4)}  MFE/MAE=${(avg(sub.map(t=>t.mfe))/avg(sub.map(t=>t.mae))).toFixed(2)}  finalPnL=${avg(sub.map(t=>t.finalPnl)).toFixed(1).padStart(6)}  reach30=${pct(sub.filter(t=>t.reached30).length,sub.length)}%`);
  }

  // ════════════════════════════════════════════════
  // MAE BEFORE MFE (the key question for stop placement)
  // ════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  MAE BEFORE MFE (how much pain before peak profit?)          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const maeBeforeMfes = trades.map(t => t.maeBeforeMfe).sort((a, b) => a - b);
  console.log(`  All trades: Avg=${avg(maeBeforeMfes).toFixed(1)}  Median=${median(maeBeforeMfes).toFixed(0)}  P75=${p(maeBeforeMfes,0.75).toFixed(0)}  P90=${p(maeBeforeMfes,0.9).toFixed(0)}`);

  // Trades with MFE >= 30
  const goodTrades = trades.filter(t => t.mfe >= 30);
  const goodMaeBeforeMfe = goodTrades.map(t => t.maeBeforeMfe).sort((a, b) => a - b);
  console.log(`  Winners (MFE>=30): Avg=${avg(goodMaeBeforeMfe).toFixed(1)}  Median=${median(goodMaeBeforeMfe).toFixed(0)}  P75=${p(goodMaeBeforeMfe,0.75).toFixed(0)}  P90=${p(goodMaeBeforeMfe,0.9).toFixed(0)}  (n=${goodTrades.length})`);

  const greatTrades = trades.filter(t => t.mfe >= 50);
  const greatMaeBeforeMfe = greatTrades.map(t => t.maeBeforeMfe).sort((a, b) => a - b);
  console.log(`  Big winners (MFE>=50): Avg=${avg(greatMaeBeforeMfe).toFixed(1)}  Median=${median(greatMaeBeforeMfe).toFixed(0)}  P75=${p(greatMaeBeforeMfe,0.75).toFixed(0)}  P90=${p(greatMaeBeforeMfe,0.9).toFixed(0)}  (n=${greatTrades.length})`);

  // What % of 30pt+ winners had MAE > X before reaching peak?
  console.log('\n  Of trades with MFE >= 30pts, what MAE did they endure first?');
  for (const maeThresh of [5, 10, 15, 20, 25, 30, 40, 50]) {
    const survived = goodTrades.filter(t => t.maeBeforeMfe < maeThresh).length;
    console.log(`    MAE < ${String(maeThresh).padStart(2)}pt before MFE: ${String(survived).padStart(4)} / ${goodTrades.length} (${pct(survived, goodTrades.length)}%)`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  MFE/MAE ANALYSIS COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
