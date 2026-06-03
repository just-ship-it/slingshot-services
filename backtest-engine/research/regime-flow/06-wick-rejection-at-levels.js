/**
 * Phase 3 (corrected) — Wick rejection at S/R levels, HIGH/LOW honest.
 *
 * Drew's correction: NQ 1m bars routinely span 20-70pt; the edge is in INTRABAR WICKS
 * that stab into a level and reject, not close-to-close. So we analyze the wick:
 *
 *   • A 1s bar "touches" a level L when low <= L <= high.
 *   • Classify by approach: price came from BELOW → L is RESISTANCE (fade SHORT);
 *     came from ABOVE → L is SUPPORT (fade LONG). Approach = sign(L - preClose),
 *     preClose = close ~LOOKBACK s before the touch (same contract).
 *   • Simulate a LIMIT entry AT L (honest: filled because the wick reached L).
 *   • Walk forward on 1s HIGH/LOW from the touch:
 *       REJECT (win): favorable excursion >= T   (short: L - low_j >= T; long: high_j - L >= T)
 *       BREAK  (loss): price pierces the level by S  (short: high_j - L >= S; long: L - low_j >= S)
 *     First to hit wins; else timeout. "Until it breaks" → S is a small beyond-level stop.
 *   • Dedupe: ignore re-touches of (≈)the same level until price moves >DEDUPE pt away.
 *
 * Optional flow confirmation: require BVC pressure pushing INTO the level at the touch
 * (exhaustion setup) — computed inline from a rolling signed-volume proxy.
 *
 * Window must lie within LT+GEX coverage (LT→2025-12-29, GEX→2026-01-28).
 *
 * Usage: node research/regime-flow/06-wick-rejection-at-levels.js \
 *          --start 2025-09-01 --end 2025-12-28 --hold 900
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(ROOT, 'data');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const START = arg('start', '2025-09-01');
const END = arg('end', '2025-12-28');
const HOLD = +arg('hold', 900);          // max-hold seconds
const TOUCH_EPS = +arg('touch-eps', 0.5);// wick within this of L also counts as touch
const LOOKBACK = +arg('lookback', 60);   // s before touch to read approach
const COOLDOWN = +arg('cooldown', 300);  // s before the SAME level re-arms (kills duplicate intrabar touches)
const PRODUCT = 'NQ';
const TARGETS = [5, 10];                  // rejection target pts
const STOPS = [3, 5, 8];                  // beyond-level break/stop pts

console.log(`\n=== Wick rejection at S/R levels (high/low honest) ===`);
console.log(`Window: ${START} → ${END}  hold=${HOLD}s touch-eps=${TOUCH_EPS} cooldown=${COOLDOWN}s\n`);

// --- levels ---
function loadLT() {
  const rows = fs.readFileSync(path.join(DATA, 'liquidity/nq/NQ_liquidity_levels.csv'), 'utf8').trim().split('\n');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i].split(',');
    const ts = +f[1]; const lv = [f[3], f[4], f[5], f[6], f[7]].map(Number).filter(Number.isFinite);
    if (Number.isFinite(ts)) out.push({ ts, lv });
  }
  out.sort((a, b) => a.ts - b.ts); return out;
}
function loadGEX() {
  const rows = fs.readFileSync(path.join(DATA, 'gex/nq/NQ_gex_levels.csv'), 'utf8').trim().split('\n');
  const m = new Map();
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i].split(',');
    m.set(f[0], { put: [f[2], f[3], f[4]].map(Number), call: [f[5], f[6], f[7]].map(Number), flip: +f[1] });
  }
  return m;
}
const LT = loadLT(), GEX = loadGEX();
function ltAt(t) { let lo = 0, hi = LT.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (LT[m].ts <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? LT[a].lv : null; }
console.log(`LT rows ${LT.length.toLocaleString()} (→${new Date(LT[LT.length-1].ts).toISOString().slice(0,10)}), GEX days ${GEX.size}\n`);

// --- primary-by-hour from 1m ---
async function loadOneMin() {
  const fp = path.join(DATA, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  const start = new Date(START).getTime(), end = new Date(END).getTime() + 864e5;
  const rows = [];
  await new Promise((res, rej) => fs.createReadStream(fp).pipe(csv())
    .on('data', r => { if (r.symbol && r.symbol.includes('-')) return; const ts = new Date(r.ts_event).getTime(); if (isNaN(ts) || ts < start || ts > end) return; rows.push({ ts, v: +r.volume || 0, s: r.symbol }); })
    .on('end', res).on('error', rej));
  return rows;
}
const oneMin = await loadOneMin();
const primaryByHour = new Map();
{ const hv = new Map(); for (const c of oneMin) { const h = Math.floor(c.ts / 36e5); if (!hv.has(h)) hv.set(h, new Map()); const m = hv.get(h); m.set(c.s, (m.get(c.s) || 0) + c.v); }
  for (const [h, m] of hv) { let bs = '', bv = -1; for (const [s, v] of m) if (v > bv) { bv = v; bs = s; } primaryByHour.set(h, bs); } }
console.log(`primary-by-hour: ${primaryByHour.size} hours\n`);

// --- stream 1s OHLC into arrays (primary only, rollover-aware) ---
const T = [], O = [], H = [], L = [], C = [], V = [], SY = [];
{
  const fp = path.join(DATA, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
  const sD = START.slice(0, 10), eD = END.slice(0, 10);
  const sTs = new Date(START).getTime(), eTs = new Date(END).getTime() + 864e5;
  const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
  let hdr = false;
  console.log(`Streaming 1s OHLC ...`);
  for await (const line of rl) {
    if (!hdr) { hdr = true; continue; }
    const dp = line.slice(0, 10);
    if (dp < sD) continue; if (dp > eD) break;
    const f = line.split(','); const sym = f[9];
    if (!sym || sym.includes('-')) continue;
    const ts = new Date(f[0]).getTime(); if (ts < sTs || ts > eTs) continue;
    if (primaryByHour.get(Math.floor(ts / 36e5)) !== sym) continue;
    T.push(ts); O.push(+f[4]); H.push(+f[5]); L.push(+f[6]); C.push(+f[7]); V.push(+f[8]); SY.push(sym);
  }
}
const N = T.length;
console.log(`  ${N.toLocaleString()} primary 1s bars\n`);

// --- inline BVC rolling signed-volume (for optional flow confirmation) ---
// sigma of dC over 300 bars; signed = V*(2*Φ(dC/σ)-1); ofi60 = Σsigned/Σvol over 60s
function normCdf(z){const t=1/(1+0.2316419*Math.abs(z)),d=0.3989422804014327*Math.exp(-z*z/2);let p=d*t*(0.31938153+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));return z>=0?1-p:p;}
const OFI = new Float64Array(N);
{
  let sym=null, prev=NaN, dpSum=0,dpSum2=0,dpN=0, sgn=new Float64Array(1024), vol=new Float64Array(1024), n=0, sSgn=0,sVol=0;
  for (let i=0;i<N;i++){
    if (SY[i]!==sym){sym=SY[i];prev=NaN;dpSum=dpSum2=dpN=0;n=0;sSgn=sVol=0;sgn.fill(0);vol.fill(0);}
    const c=C[i],v=V[i]; const dc=Number.isNaN(prev)?0:c-prev;
    const sig=dpN>=30?Math.sqrt(Math.max(1e-9,dpSum2/dpN-(dpSum/dpN)**2)):NaN;
    let sv=0; if(Number.isFinite(sig)&&sig>1e-6) sv=v*(2*normCdf(dc/sig)-1);
    const slot=n%1024; const oldS=n-60>=0?sgn[(n-60)%1024]:0, oldV=n-60>=0?vol[(n-60)%1024]:0;
    sgn[slot]=sv; vol[slot]=v; sSgn+=sv-oldS; sVol+=v-oldV;
    OFI[i]= sVol>0? sSgn/sVol : 0;
    dpSum+=dc;dpSum2+=dc*dc;dpN++; // σ over growing per-contract window — coarse confirmation proxy is fine
    prev=c; n++;
  }
}

// --- preClose: close ~LOOKBACK s before index i (same contract) ---
function preClose(i){ const target=T[i]-LOOKBACK*1000; for(let j=i-1;j>=0;j--){ if(SY[j]!==SY[i])return NaN; if(T[j]<=target)return C[j]; } return NaN; }

// candidate levels for bar i (LT + GEX), tagged by source
function levelsAt(i){
  const out=[]; const lt=ltAt(T[i]); if(lt)for(const l of lt)out.push({L:l,src:'LT'});
  const d=new Date(T[i]).toISOString().slice(0,10); const g=GEX.get(d);
  if(g){ for(const l of g.put)if(Number.isFinite(l))out.push({L:l,src:'GEX_PUT'}); for(const l of g.call)if(Number.isFinite(l))out.push({L:l,src:'GEX_CALL'}); if(Number.isFinite(g.flip))out.push({L:g.flip,src:'GEX_FLIP'}); }
  return out;
}

// forward wick walk from touch index i, limit entry at L, dir=+1 long(support)/-1 short(resistance)
function rejectOrBreak(i, L0, dir, Tgt, Stop){
  const holdMs=HOLD*1000, s=SY[i];
  for(let j=i;j<N;j++){
    if(SY[j]!==s||T[j]-T[i]>holdMs)return 'to';
    if(dir<0){ // short at resistance
      if(L0 - Ll(j) >= Tgt) return 'rej';      // dropped Tgt below level
      if(Hh(j) - L0 >= Stop) return 'brk';     // pierced Stop above level
    } else {   // long at support
      if(Hh(j) - L0 >= Tgt) return 'rej';
      if(L0 - Ll(j) >= Stop) return 'brk';
    }
  }
  return 'to';
}
const Hh=j=>H[j], Ll=j=>L[j];

// --- detect touches + evaluate, with per-level time cooldown (dedupe intrabar repeats) ---
const lastTouchTs = new Map(); // round(L) -> last touch ts
function key(L0){ return Math.round(L0); }

const stats = {}; // bucketName -> per-(T,S) tallies
function bucket(name){ if(!stats[name]){stats[name]={};for(const t of TARGETS)for(const s of STOPS)stats[name][`${t}/${s}`]={rej:0,brk:0,to:0,n:0};} return stats[name]; }

let touches=0;
for (let i=LOOKBACK; i<N; i++){
  const pc=preClose(i); if(!Number.isFinite(pc))continue;
  const lv=levelsAt(i); if(!lv.length)continue;
  for(const {L:L0,src} of lv){
    // wick touches level?
    if(!(L[i]-TOUCH_EPS <= L0 && L0 <= H[i]+TOUCH_EPS)) continue;
    // approach / dir: level above approach price => resistance => short
    const dir = Math.sign(pc - L0); if(dir===0)continue; // pc<L0 => dir<0 short(resistance); pc>L0 => long(support)
    // time cooldown: same level can't re-arm within COOLDOWN s (kills intrabar duplicate touches)
    const k=key(L0); const last=lastTouchTs.get(k);
    if(last!==undefined && (T[i]-last) < COOLDOWN*1000) continue;
    lastTouchTs.set(k, T[i]);
    touches++;
    const flowInto = Math.sign(OFI[i])===Math.sign(L0-pc) && Math.abs(OFI[i])>0.1; // pressure toward level = exhaustion
    for(const t of TARGETS)for(const s of STOPS){
      const o=rejectOrBreak(i,L0,dir,t,s);
      const tag=`${t}/${s}`;
      const all=bucket('ALL levels'); all[tag][o]++; all[tag].n++;
      const bySrc=bucket(src); bySrc[tag][o]++; bySrc[tag].n++;
      if(flowInto){ const fc=bucket('ALL + flow-into-level'); fc[tag][o]++; fc[tag].n++; }
    }
  }
}
console.log(`Total qualifying wick touches: ${touches.toLocaleString()}\n`);

function show(name){
  const b=stats[name]; if(!b)return;
  const total=b[`${TARGETS[0]}/${STOPS[0]}`].n;
  console.log(`\n${name}  (n=${total.toLocaleString()} touches)`);
  console.log(`  ${'tgt/stop'.padEnd(10)} P(reject)  P(break)  P(timeout)  expectancy(pt)`);
  for(const t of TARGETS)for(const s of STOPS){
    const r=b[`${t}/${s}`]; if(!r.n)continue;
    const pr=r.rej/r.n, pb=r.brk/r.n, pt=r.to/r.n;
    const exp=pr*t - pb*s; // timeout ~0
    console.log(`  +${t}/-${s}`.padEnd(12)+`  ${(pr*100).toFixed(1)}%     ${(pb*100).toFixed(1)}%     ${(pt*100).toFixed(1)}%      ${exp>=0?'+':''}${exp.toFixed(2)}`);
  }
}
for(const name of ['ALL levels','GEX_CALL','GEX_PUT','GEX_FLIP','LT','ALL + flow-into-level']) show(name);

console.log(`\nRead:`);
console.log(`  • P(reject) = wick fades the level by the target before piercing it by the stop.`);
console.log(`  • Tight stop (-3/-5) + 5-10pt target with P(reject) well above the implied`);
console.log(`    breakeven (stop/(target+stop)) = real wick-fade edge "until it breaks".`);
console.log(`  • If flow-into-level lifts P(reject), exhaustion confirmation is the regime gate.\n`);
