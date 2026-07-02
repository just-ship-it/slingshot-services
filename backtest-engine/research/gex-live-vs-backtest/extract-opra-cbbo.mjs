// Faithful replica of generate-cbbo-gex.js loadCBBO: 15m buckets, last-quote-wins,
// gates bid>0/ask>0/ask>=bid/spread<=50%. Extract QQQ per-strike bid/ask per bucket.
// Output small per-day JSON: { bucketISO: { symbol: [bid,ask] } } for buckets matching nq-cbbo.
import fs from 'fs';
import readline from 'readline';
const day = process.argv[2];
const INTERVAL_MS = 15*60*1000;
const fp = `data/cbbo-1m/qqq/opra-pillar-${day.replace(/-/g,'')}.cbbo-1m.csv`;
if(!fs.existsSync(fp)){ console.log(JSON.stringify({day,error:'no cbbo file'})); process.exit(0); }
const buckets = new Map(); // bucketMs -> Map(sym->{bid,ask})
let header=null, tsIdx,bidIdx,askIdx,symIdx, lines=0;
const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
rl.on('line', line=>{
  if(!header){ header=line.split(','); tsIdx=header.indexOf('ts_event'); bidIdx=header.indexOf('bid_px_00'); askIdx=header.indexOf('ask_px_00'); symIdx=header.indexOf('symbol'); return; }
  lines++;
  const cols=line.split(',');
  if(cols.length<=symIdx) return;
  const sym=cols[symIdx];
  if(!sym.startsWith('QQQ')) return;
  const ts=new Date(cols[tsIdx]).getTime(); if(isNaN(ts)) return;
  const bid=parseFloat(cols[bidIdx]), ask=parseFloat(cols[askIdx]);
  if(!(bid>0)||!(ask>0)||ask<bid) return;
  if((ask-bid)/bid>0.5) return;
  const bucket=(Math.floor(ts/INTERVAL_MS)+1)*INTERVAL_MS;
  if(!buckets.has(bucket)) buckets.set(bucket,{});
  buckets.get(bucket)[sym]=[bid,ask]; // last wins
});
rl.on('close', ()=>{
  const out={};
  for(const [b,m] of buckets){ out[new Date(b).toISOString()]=m; }
  const outPath=`research/gex-live-vs-backtest/opra-cbbo-${day}.json`;
  fs.writeFileSync(outPath, JSON.stringify(out));
  const nb=Object.keys(out).length; const nsym=Object.values(out).reduce((s,m)=>s+Object.keys(m).length,0);
  console.log(JSON.stringify({day, linesScanned:lines, buckets:nb, totalSymQuotes:nsym, outKB:Math.round(fs.statSync(outPath).size/1024)}));
});
