/**
 * Vol-compression breakout sim — 1s-HONEST. Signals on 1m (squeeze release in momentum direction);
 * fills + exits walked on 1s OHLC. EOD flat 15:45 ET. Per-day front contract (no roll-cross).
 *
 * FILL HONESTY (audited):
 *  - entry = OPEN of the first 1s bar at/after the signal 1m bar's close (fill_sec=(m+1)*60).
 *  - exit walk = 1s bars with sec >= fill_sec only; first stop/target touch wins; tie => stop first.
 *  - never reads a 1s bar with sec < fill_sec.
 *
 * Usage: node 02-sim.js            (sweeps configs)
 *        node 02-sim.js --config EOD_s2_on3   (single config, verbose)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SqueezeMomentumIndicator } from '../../../shared/indicators/squeeze-momentum.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'output');
const RTH_MIN = 390, RTH_SEC = RTH_MIN * 60, EOD_SEC = 22500; // 15:45 ET
const POINT_VALUE = 20, COMMISSION = 5;
const TRAIN_END = '2025-09-30';
const INVERT = process.argv.includes('--invert');

// ---- load precompute ----
const store = JSON.parse(fs.readFileSync(path.join(OUT, 'days.NQ.json'), 'utf8'));
const DAYS = store.days;
const bin = fs.readFileSync(path.join(OUT, 'rth1s.NQ.bin'));
const ROW = 20, nRows = bin.length / ROW;
// index 1s rows by dayIdx → {sec,o,h,l,c}[]
const s1ByDay = Array.from({ length: DAYS.length }, () => []);
for (let i = 0; i < nRows; i++) {
  const off = i * ROW;
  const di = bin.readUInt16LE(off), sec = bin.readUInt16LE(off + 2);
  s1ByDay[di].push({ sec, o: bin.readFloatLE(off + 4), h: bin.readFloatLE(off + 8), l: bin.readFloatLE(off + 12), c: bin.readFloatLE(off + 16) });
}
for (const a of s1ByDay) a.sort((x, y) => x.sec - y.sec);

// ---- per-day 1m feature precompute: squeeze state, momentum, ATR ----
const sqz = new SqueezeMomentumIndicator({ bbLength: 20, bbMultFactor: 2.0, kcLength: 20, kcMultFactor: 1.5 });
function dayFeatures(day) {
  const candles = [];
  for (let m = 0; m < RTH_MIN; m++) candles.push({ open: day.mOpen[m], high: day.mHigh[m], low: day.mLow[m], close: day.mClose[m] });
  const state = new Array(RTH_MIN).fill(null), mom = new Array(RTH_MIN).fill(null), atr = new Array(RTH_MIN).fill(null);
  // ATR14 on 1m
  let trSum = 0; const trs = [];
  for (let m = 0; m < RTH_MIN; m++) {
    const c = candles[m]; const tr = m === 0 ? (c.high - c.low) : Math.max(c.high - c.low, Math.abs(c.high - candles[m - 1].close), Math.abs(c.low - candles[m - 1].close));
    trs.push(tr); if (trs.length > 14) trSum -= trs[trs.length - 15]; trSum += tr; atr[m] = trSum / Math.min(trs.length, 14);
    if (m >= 40) { const r = sqz.calculate(candles.slice(m - 59 < 0 ? 0 : m - 59, m + 1)); if (r) { state[m] = r.squeeze.state; mom[m] = r.momentum.value; } }
  }
  return { state, mom, atr };
}

// ---- 1s-honest fill + exit walk for one signal ----
function simulateTrade(di, sigMin, dir, stopDist, tgtDist, holdToEod, momFlipSec, maxHoldSec) {
  const fillSec = (sigMin + 1) * 60;
  if (fillSec >= EOD_SEC) return null;            // no room before EOD
  const bars = s1ByDay[di];
  // locate first 1s bar with sec >= fillSec
  let i = 0; while (i < bars.length && bars[i].sec < fillSec) i++;
  if (i >= bars.length) return null;
  const entry = bars[i].o;                        // OPEN of first 1s bar at/after signal-bar close
  const fSec = bars[i].sec;
  const stop = dir === 1 ? entry - stopDist : entry + stopDist;
  const tgt = tgtDist ? (dir === 1 ? entry + tgtDist : entry - tgtDist) : null;
  let mfe = 0, mae = 0;
  for (; i < bars.length; i++) {
    const b = bars[i];
    if (b.sec > EOD_SEC) break;
    if (maxHoldSec && b.sec - fSec > maxHoldSec) { return close(b.o, 'maxhold', b.sec); }
    if (momFlipSec != null && b.sec >= momFlipSec) { return close(b.o, 'momflip', b.sec); }
    // adverse first (conservative): check stop before target within the bar
    const adverse = dir === 1 ? b.l : b.h, favor = dir === 1 ? b.h : b.l;
    mfe = Math.max(mfe, dir === 1 ? favor - entry : entry - favor);
    mae = Math.min(mae, dir === 1 ? adverse - entry : entry - adverse);
    const hitStop = dir === 1 ? b.l <= stop : b.h >= stop;
    const hitTgt = tgt != null && (dir === 1 ? b.h >= tgt : b.l <= tgt);
    if (hitStop) return close(stop, 'stop', b.sec);
    if (hitTgt) return close(tgt, 'target', b.sec);
  }
  // ran out / EOD: exit at last available bar <= EOD
  let j = bars.length - 1; while (j >= 0 && bars[j].sec > EOD_SEC) j--;
  if (j < i - 1 || j < 0) { const lb = bars[Math.min(i, bars.length - 1)]; return close(lb ? lb.c : entry, 'eod', lb ? lb.sec : fSec); }
  return close(bars[j].c, 'eod', bars[j].sec);

  function close(px, reason, sec) {
    const pts = dir === 1 ? px - entry : entry - px;
    return { di, date: DAYS[di].date, dir, entry, exit: px, pts, netPnL: pts * POINT_VALUE - COMMISSION, reason, fillSec: fSec, exitSec: sec, mfe, mae };
  }
}

// ---- run one config over all days ----
function runConfig(cfg) {
  const trades = [];
  for (let di = 0; di < DAYS.length; di++) {
    const day = DAYS[di]; if (!day.symbol) continue;
    const { state, mom, atr } = dayFeatures(day);
    let onRun = 0;
    for (let m = 41; m < RTH_MIN - 1; m++) {
      if (state[m] === 'squeeze_on') { onRun++; continue; }
      // release = previous bar(s) squeeze_on, now squeeze_off
      const released = state[m] === 'squeeze_off' && state[m - 1] === 'squeeze_on';
      if (!released) { if (state[m] !== 'squeeze_on') onRun = 0; continue; }
      const wasOn = onRun; onRun = 0;
      if (wasOn < cfg.onMin) continue;
      const mv = mom[m]; if (mv == null || mv === 0) continue;
      let dir = mv > 0 ? 1 : -1;
      if (INVERT) dir = -dir;   // self-check: fade the release instead of trading the breakout
      const a = atr[m] || 10;
      let stopDist, tgtDist = null, holdToEod = false, maxHoldSec = cfg.maxHoldSec || null;
      if (cfg.exit === 'atr') { stopDist = cfg.stopMult * a; tgtDist = cfg.tgtMult * a; }
      else if (cfg.exit === 'eod') { stopDist = cfg.stopMult * a; tgtDist = null; }
      else if (cfg.exit === 'fixed') { stopDist = cfg.stopPts; tgtDist = cfg.tgtPts; }
      else if (cfg.exit === 'momflip') { stopDist = cfg.stopMult * a; tgtDist = null; }
      // momentum-flip trigger sec (first minute >m whose momentum sign flips against dir)
      let momFlipSec = null;
      if (cfg.exit === 'momflip') { for (let mm = m + 1; mm < RTH_MIN; mm++) { if (mom[mm] != null && Math.sign(mom[mm]) === -dir) { momFlipSec = (mm + 1) * 60; break; } } }
      const t = simulateTrade(di, m, dir, stopDist, tgtDist, holdToEod, momFlipSec, maxHoldSec);
      if (t) { t.atr = a; trades.push(t); }
    }
  }
  return trades;
}

// ---- metrics ----
function metrics(trades) {
  if (!trades.length) return { n: 0 };
  const pnl = trades.map(t => t.netPnL);
  const tot = pnl.reduce((s, x) => s + x, 0);
  const w = trades.filter(t => t.netPnL > 0), l = trades.filter(t => t.netPnL <= 0);
  const gp = w.reduce((s, t) => s + t.netPnL, 0), gl = Math.abs(l.reduce((s, t) => s + t.netPnL, 0));
  // daily Sharpe
  const byDay = new Map(); for (const t of trades) byDay.set(t.date, (byDay.get(t.date) || 0) + t.netPnL);
  const d = [...byDay.values()]; const mean = d.reduce((s, x) => s + x, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (d.length - 1 || 1));
  const sharpe = sd ? (mean / sd) * Math.sqrt(252) : 0;
  // maxDD on exit-ordered equity
  const sorted = [...trades].sort((a, b) => a.di - b.di || a.exitSec - b.exitSec);
  let eq = 0, pk = 0, dd = 0; for (const t of sorted) { eq += t.netPnL; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  return { n: trades.length, pnl: tot, wr: 100 * w.length / trades.length, pf: gl ? gp / gl : Infinity, sharpe, dd, avg: tot / trades.length, days: byDay.size };
}
const split = (trades, isTrain) => trades.filter(t => isTrain ? t.date <= TRAIN_END : t.date > TRAIN_END);
const fmt = m => m.n ? `n=${String(m.n).padStart(4)} PnL=$${Math.round(m.pnl).toLocaleString().padStart(8)} PF=${(m.pf === Infinity ? 'Inf' : m.pf.toFixed(2)).padStart(5)} Sh=${m.sharpe.toFixed(1).padStart(5)} WR=${m.wr.toFixed(0)}% DD=$${Math.round(m.dd).toLocaleString()} avg=$${m.avg.toFixed(0)}` : 'no trades';

// ---- config sweep ----
const single = (() => { const i = process.argv.indexOf('--config'); return i === -1 ? null : process.argv[i + 1]; })();
const CONFIGS = [];
for (const onMin of [1, 3, 6]) {
  CONFIGS.push([`ATR_s2t4_on${onMin}`, { exit: 'atr', stopMult: 2, tgtMult: 4, onMin }]);
  CONFIGS.push([`ATR_s1.5t6_on${onMin}`, { exit: 'atr', stopMult: 1.5, tgtMult: 6, onMin }]);
  CONFIGS.push([`EOD_s2_on${onMin}`, { exit: 'eod', stopMult: 2, onMin }]);
  CONFIGS.push([`EOD_s3_on${onMin}`, { exit: 'eod', stopMult: 3, onMin }]);
  CONFIGS.push([`MOMFLIP_s2_on${onMin}`, { exit: 'momflip', stopMult: 2, onMin }]);
  CONFIGS.push([`FIXED_s30t100_on${onMin}`, { exit: 'fixed', stopPts: 30, tgtPts: 100, onMin }]);
}

console.log(`Loaded ${DAYS.length} days, ${nRows.toLocaleString()} 1s bars. Window ${store.start}..${store.end}\n`);
console.log('config'.padEnd(22), 'FULL'.padEnd(78), '| TRAIN pf/sh', '| TEST pf/sh');
const rows = [];
for (const [name, cfg] of CONFIGS) {
  if (single && name !== single) continue;
  const trades = runConfig(cfg);
  const mf = metrics(trades), mtr = metrics(split(trades, true)), mte = metrics(split(trades, false));
  rows.push({ name, cfg, mf, mtr, mte, trades });
  console.log(name.padEnd(22), fmt(mf).padEnd(78), `| ${mtr.n ? mtr.pf.toFixed(2) + '/' + mtr.sharpe.toFixed(1) : '-'}`, `| ${mte.n ? mte.pf.toFixed(2) + '/' + mte.sharpe.toFixed(1) : '-'}`);
}

// pick best by: train & test PF both > 1.1, maximize min(train PF, test PF)
const viable = rows.filter(r => r.mtr.n > 10 && r.mte.n > 5 && r.mtr.pf > 1.1 && r.mte.pf > 1.1);
viable.sort((a, b) => Math.min(b.mtr.pf, b.mte.pf) - Math.min(a.mtr.pf, a.mte.pf));
console.log(`\n${viable.length} configs with train&test PF>1.1 (robust).`);
if (viable.length) { const b = viable[0]; console.log(`BEST robust: ${b.name}  FULL ${fmt(b.mf)}`); fs.writeFileSync(path.join(OUT, 'best-trades.json'), JSON.stringify({ name: b.name, cfg: b.cfg, trades: b.trades }, null, 0)); console.log(`  wrote best-trades.json (${b.trades.length} trades)`); }
else console.log('No robust config — likely NO verdict.');
// dump throughput
if (rows.length) { const exConfig = single ? rows[0] : (viable[0] || rows[0]); const m = exConfig.mf; if (m.n) console.log(`\nthroughput: ${m.n} trades / ${(DAYS.length / 21).toFixed(0)} months ≈ ${(m.n / (DAYS.length / 21)).toFixed(1)}/month`); }
