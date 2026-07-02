// Full-day live-vs-backtest GEX level comparison, apples-to-apples.
// Endpoint A = real ExposureCalculator on Schwab snapshot (same asOf + same spot as B).
// Endpoint B = committed nq-cbbo JSON (converted to QQQ space).
import fs from 'fs';
import ExposureCalculator from '../../../signal-generator/src/tradier/exposure-calculator.js';

const day = process.argv[2];
const excl0 = process.argv[3] === 'excl0dte';
const B = JSON.parse(fs.readFileSync(new URL(`../../data/gex/nq-cbbo/nq_gex_${day}.json`, import.meta.url),'utf8')).data;
const dir = new URL(`../../data/schwab-snapshots/${day}/`, import.meta.url);
let swFiles;
try { swFiles = fs.readdirSync(dir).filter(f=>f.startsWith('snapshot_')).sort(); }
catch { console.log(JSON.stringify({day, error:'no schwab snapshots'})); process.exit(0); }
// index schwab snapshots by epoch ms
const swSnaps = swFiles.map(f=>{ const s=JSON.parse(fs.readFileSync(new URL(f,dir),'utf8')); return {t:new Date(s.timestamp).getTime(), chains:s.chains.QQQ||[]}; });
const calc = new ExposureCalculator({ riskFreeRate: 0.05, excludeZeroDTE: excl0 });

function nearest(ts){ let best=null,bd=Infinity; for(const s of swSnaps){ const d=Math.abs(s.t-ts); if(s.t<=ts+90000 && d<bd){bd=d;best=s;} } return best; }
const absMed = arr => { const a=arr.filter(x=>x!=null).sort((x,y)=>x-y); return a.length? a[Math.floor(a.length/2)]:null; };

const rows=[];
for(const b of B){
  const ts=new Date(b.timestamp).getTime();
  const sw=nearest(ts); if(!sw) continue;
  const spot=b.qqq_spot, mult=b.multiplier;
  const res=calc.calculateExposures({QQQ:sw.chains},{QQQ:spot},{asOf:new Date(b.timestamp)});
  const A=res.QQQ.levels;
  // B levels to QQQ space
  const bCall=b.call_wall/mult, bPut=b.put_wall/mult, bFlip=b.gamma_flip?b.gamma_flip/mult:null;
  const bSup=(b.support||[]).map(x=>Math.round(x/mult));
  rows.push({
    hhmm: b.timestamp.slice(11,16),
    callWallDiff: A.callWall!=null&&bCall?Math.abs(A.callWall-bCall):null,
    putWallDiff: A.putWall!=null&&bPut?Math.abs(A.putWall-bPut):null,
    flipDiff: A.gammaFlip!=null&&bFlip!=null?Math.abs(A.gammaFlip-bFlip):null,
    // support ladder overlap: how many of B's top-5 support are in A's top-5
    supOverlap: A.support&&bSup.length?bSup.filter(x=>A.support.some(y=>Math.abs(x-y)<=1)).length:null,
    s4Diff: (A.support&&A.support[3]!=null&&bSup[3]!=null)?Math.abs(A.support[3]-bSup[3]):null,
    A_sup:A.support, B_sup:bSup, A_cw:A.callWall, B_cw:Math.round(bCall), A_pw:A.putWall, B_pw:Math.round(bPut),
    mult,
  });
}
const summ={
  day, snapshots: rows.length, excl0dte: excl0,
  medCallWallDiff_QQQ: absMed(rows.map(r=>r.callWallDiff)),
  medPutWallDiff_QQQ: absMed(rows.map(r=>r.putWallDiff)),
  medFlipDiff_QQQ: absMed(rows.map(r=>r.flipDiff)),
  medSupOverlap_of5: absMed(rows.map(r=>r.supOverlap)),
  medS4Diff_QQQ: absMed(rows.map(r=>r.s4Diff)),
  // in NQ pts too (×~41.6)
};
console.log(JSON.stringify(summ));
// dump per-snapshot for detail if requested
if(process.argv[4]==='detail') for(const r of rows) console.log(`  ${r.hhmm}  cwΔ=${r.callWallDiff} pwΔ=${r.putWallDiff} flipΔ=${r.flipDiff} supOv=${r.supOverlap}/5  A_pw=${r.A_pw} B_pw=${r.B_pw}  A_sup=[${r.A_sup}] B_sup=[${r.B_sup}]`);
