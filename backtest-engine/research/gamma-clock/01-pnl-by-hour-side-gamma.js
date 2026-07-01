#!/usr/bin/env node
/**
 * gamma-clock thread, Phase 1 (DESCRIPTIVE — no filter, just look).
 *
 * Question from the mathandmarkets "0DTE: What the Pros Are Really Doing" piece:
 *   - mornings = positive-gamma dampening = mean-reversion
 *   - afternoons (post ~2pm ET) = gamma collapses = momentum/trend
 *   => do OUR longs/shorts get "run over" in the afternoon, and is it gamma-conditioned?
 *
 * This script makes NO claim and applies NO filter. It just slices the 4 gold-standard
 * strategies' OWN trades (standalone, 1s-honest fills already baked in) by:
 *      ET entry hour  ×  side (long/short)  ×  gammaSign (+1 / -1 / na)
 * and reports n, winRate, avg net$, total$, PF, avg pts, stop-out rate, avg MFE.
 *
 * "Run over" proxy: high stop-out rate + large negative avg pts + low WR.
 * Standalone (not FCFS) is intentional here — we want the cleanest read on the
 * directional/time/gamma behavior with the most trades, before slot censoring.
 *
 * Usage: node 01-pnl-by-hour-side-gamma.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAnnotated, TRAIN_END } from '../deck-filters/lib/annotate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'output');

// ET hour from epoch ms (same DST logic as annotate.js etDate).
function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
const etHour = ms => new Date(ms-(isDST(ms)?4:5)*3600000).getUTCHours();

const gKey = g => g === 1 ? 'pos' : g === -1 ? 'neg' : 'na';
const isStop = r => /stop/i.test(String(r || ''));

function agg(trades){
  const n = trades.length;
  if (!n) return null;
  let wins=0, gw=0, gl=0, net=0, pts=0, stops=0, mfe=0, mfeN=0;
  for (const t of trades){
    if (t.netPnL > 0) wins++;
    if (t.netPnL > 0) gw += t.netPnL; else gl += -t.netPnL;
    net += t.netPnL; pts += (t.pointsPnL ?? 0);
    if (isStop(t.exitReason)) stops++;
    if (Number.isFinite(t.mfePoints)) { mfe += t.mfePoints; mfeN++; }
  }
  return {
    n, wr: wins/n*100, pf: gl > 0 ? gw/gl : Infinity,
    avgNet: net/n, total: net, avgPts: pts/n,
    stopRate: stops/n*100, avgMfe: mfeN ? mfe/mfeN : null,
  };
}

const fmt = a => a ? `n=${String(a.n).padStart(4)}  WR=${a.wr.toFixed(0).padStart(3)}%  PF=${(a.pf===Infinity?'inf':a.pf.toFixed(2)).padStart(5)}  avg$=${a.avgNet.toFixed(0).padStart(6)}  tot$=${a.total.toFixed(0).padStart(8)}  avgPts=${a.avgPts.toFixed(1).padStart(6)}  stop%=${a.stopRate.toFixed(0).padStart(3)}  MFE=${a.avgMfe==null?'  -':a.avgMfe.toFixed(1).padStart(5)}` : '(none)';

function table(title, trades, keyFn){
  const groups = new Map();
  for (const t of trades){ const k = keyFn(t); if (k==null) continue; if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(t); }
  const keys = [...groups.keys()].sort();
  const lines = [`\n=== ${title} (${trades.length} trades) ===`];
  for (const k of keys) lines.push(`  ${String(k).padEnd(22)} ${fmt(agg(groups.get(k)))}`);
  return lines.join('\n');
}

const all = loadAnnotated();
console.log(`Loaded ${all.length} completed trades across 4 strategies.`);
const trainEnd = TRAIN_END;
const out = [];
const splits = [
  ['ALL', all],
  ['TRAIN (≤'+trainEnd+')', all.filter(t => t.etDate <= trainEnd)],
  ['TEST  (>'+trainEnd+')', all.filter(t => t.etDate > trainEnd)],
];

for (const [splitName, S] of splits){
  out.push(`\n\n############################################################`);
  out.push(`#  SPLIT: ${splitName}   (${S.length} trades)`);
  out.push(`############################################################`);

  // 1) by ET hour only
  out.push(table('By ET entry hour', S, t => String(etHour(t.entryTime)).padStart(2,'0')));
  // 2) by ET hour x side
  out.push(table('By ET hour × side', S, t => `${String(etHour(t.entryTime)).padStart(2,'0')} ${t.side}`));
  // 3) by ET hour x gammaSign
  out.push(table('By ET hour × gamma', S, t => `${String(etHour(t.entryTime)).padStart(2,'0')} g=${gKey(t.gammaSign)}`));
  // 4) morning vs afternoon x side x gamma  (AM<12, MID 12-13:59, PM>=14 ET)
  const ampm = ms => { const h = etHour(ms); return h < 12 ? 'AM(<12)' : h < 14 ? 'MID(12-13)' : 'PM(>=14)'; };
  out.push(table('By session × side × gamma', S, t => `${ampm(t.entryTime)} ${t.side.padEnd(5)} g=${gKey(t.gammaSign)}`));
  // 5) per strategy: session x side
  for (const sk of ['lstb','gex-lt-3m','gex-flip-ivpct','gex-level-fade']){
    out.push(table(`[${sk}] session × side × gamma`, S.filter(t=>t.strategyKey===sk),
      t => `${ampm(t.entryTime)} ${t.side.padEnd(5)} g=${gKey(t.gammaSign)}`));
  }
}

const text = out.join('\n');
console.log(text);
fs.writeFileSync(path.join(OUT, '01-pnl-by-hour-side-gamma.txt'), text);
console.log(`\n✓ wrote ${path.join(OUT,'01-pnl-by-hour-side-gamma.txt')}`);
