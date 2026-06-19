/**
 * Fast in-memory sweep over the RTH 1s feature store (02-precompute output).
 * Recomputes bands per (lookback,mult) from days.json and replays rth1s.bin per variant.
 *
 * All intraday times are seconds-of-day from the 09:30 ET open (DST-invariant offsets):
 *   10:00=1800  15:30=21600  15:45=22500  16:00=23400.
 *
 * Variant knobs: lookback, mult, exit(hold|vwap|band|vwap-or-band), side(both|long|short),
 *   grid(min), firstCp(min, skip earlier checkpoints), noEntryAfter(min), eod(min),
 *   vwapArm(pts favorable before VWAP/band stop arms), minBreak(pts beyond band to enter),
 *   allowFlip.
 *
 * Usage: node 03-sweep.js            # runs the MATRIX below
 *        node 03-sweep.js --one '<json>'   # single config, prints detail
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'output');
const argv = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const TICKER = argv('ticker', 'ES').toUpperCase();
const RTH_MIN = 390;
const POINT_VALUE = TICKER === 'NQ' ? 20 : 50, COMMISSION = 5.0, STOP_SLIP = 1.5, MKT_SLIP = 1.0;
const OPEN_MIN = 9 * 60 + 30; // 570
const toSec = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return ((h * 60 + m) - OPEN_MIN) * 60; };

// ---- load store ----
console.log(`Loading feature store (${TICKER}) ...`);
const daysMeta = JSON.parse(fs.readFileSync(path.join(OUT, `days.${TICKER}.json`), 'utf8'));
const DAYS = daysMeta.days; // [{date, open, prevClose, mClose[390], rthOpenMs}]
const bin = fs.readFileSync(path.join(OUT, `rth1s.${TICKER}.bin`));
const ROW = 12, N = Math.floor(bin.length / ROW);
// typed views
const u16 = new Uint16Array(N * 2), f32 = new Float32Array(N * 2);
for (let i = 0; i < N; i++) {
  u16[i * 2] = bin.readUInt16LE(i * ROW);       // dayIdx
  u16[i * 2 + 1] = bin.readUInt16LE(i * ROW + 2); // secOfDay
  f32[i * 2] = bin.readFloatLE(i * ROW + 4);     // close
  f32[i * 2 + 1] = bin.readFloatLE(i * ROW + 8); // vwap
}
console.log(`  ${DAYS.length} days, ${N.toLocaleString()} RTH 1s bars\n`);

// roll-transition days (±1 calendar day) to test robustness against roll-spread contamination
const ROLL_DATES = ['2021-03-12','2021-06-11','2021-09-10','2021-12-10','2022-03-11','2022-06-12','2022-09-11','2022-12-11','2023-03-13','2023-06-11','2023-09-10','2023-12-11','2024-03-11','2024-06-16','2024-09-16','2024-12-16','2025-03-17','2025-06-16','2025-09-15','2025-12-15'];
const ROLL_EXCLUDE = new Set();
for (const d of ROLL_DATES) { const t = new Date(d + 'T12:00:00Z').getTime(); for (let k = -1; k <= 1; k++) ROLL_EXCLUDE.add(new Date(t + k * 86400000).toISOString().slice(0, 10)); }

// precompute mClose typed per day for fast sigma
const mCloseArr = DAYS.map(d => Float64Array.from(d.mClose));
const openArr = DAYS.map(d => d.open);
const prevCloseArr = DAYS.map(d => isNaN(d.prevClose) ? d.open : d.prevClose);

function buildBands(lookback, mult) {
  // returns {UB:Float32Array[day], LB:Float32Array[day], tradable:bool[]}
  const UB = new Array(DAYS.length), LB = new Array(DAYS.length), tradable = new Array(DAYS.length).fill(false);
  for (let i = 0; i < DAYS.length; i++) {
    if (i < lookback || isNaN(openArr[i])) continue;
    const sigma = new Float64Array(RTH_MIN); let valid = 0;
    for (let k = i - lookback; k < i; k++) {
      const ok = openArr[k]; if (isNaN(ok) || ok <= 0) continue; valid++;
      const mc = mCloseArr[k];
      for (let m = 0; m < RTH_MIN; m++) sigma[m] += Math.abs(mc[m] / ok - 1);
    }
    if (valid < Math.max(5, lookback >> 1)) continue;
    const O = openArr[i], pc = prevCloseArr[i];
    const hi = Math.max(O, pc), lo = Math.min(O, pc);
    const ub = new Float32Array(RTH_MIN), lb = new Float32Array(RTH_MIN);
    for (let m = 0; m < RTH_MIN; m++) { const mv = (sigma[m] / valid) * mult * O; ub[m] = hi + mv; lb[m] = lo - mv; }
    UB[i] = ub; LB[i] = lb; tradable[i] = true;
  }
  return { UB, LB, tradable };
}

function run(cfg) {
  const { lookback = 14, mult = 1.0, exit = 'vwap', side = 'both', grid = 30, firstCp = 30,
    noEntryAfter = '15:30', eod = '15:45', vwapArm = 0, minBreak = 0, allowFlip = true,
    stopPts = 0, trailArm = 0, trailPts = 0, regimeSma = 0, startDate = null, endDate = null,
    entryMode = 'checkpoint', allowReentry = false, maxEntries = 99, reentryGapPts = 0 } = cfg;
  const inRange = (di) => (!startDate || DAYS[di].date >= startDate) && (!endDate || DAYS[di].date <= endDate)
    && !(cfg.excludeRollDays && ROLL_EXCLUDE.has(DAYS[di].date));
  const { UB, LB, tradable } = buildBands(lookback, mult);
  // trend regime: SMA of last regimeSma daily closes; long only if open>=sma, short only if open<sma
  const smaArr = new Float64Array(DAYS.length).fill(NaN);
  if (regimeSma > 0) {
    const dc = mCloseArr.map(mc => mc[RTH_MIN - 1]);
    for (let i = regimeSma; i < DAYS.length; i++) {
      let s = 0; for (let k = i - regimeSma; k < i; k++) s += dc[k];
      smaArr[i] = s / regimeSma;
    }
  }
  const gridSec = grid * 60, firstCpMin = firstCp;
  const neaSec = toSec(noEntryAfter), eodSec = toSec(eod);
  const trades = [];
  let curDay = -1, pos = null, lastCp = -1, dayClosed = false, entriesToday = 0, lastExitPrice = NaN;

  for (let i = 0; i < N; i++) {
    const dayIdx = u16[i * 2], sec = u16[i * 2 + 1];
    const close = f32[i * 2], vwap = f32[i * 2 + 1];
    if (dayIdx !== curDay) { curDay = dayIdx; pos = null; lastCp = -1; dayClosed = false; entriesToday = 0; lastExitPrice = NaN; }
    if (dayClosed || !tradable[dayIdx]) continue;
    const m = (sec / 60) | 0;
    if (m >= RTH_MIN) continue;

    // EOD force-flat
    if (sec >= eodSec) {
      if (pos) { const px = close + (pos.side > 0 ? -MKT_SLIP : MKT_SLIP); closeTrade(trades, pos, dayIdx, sec, px, 'eod'); lastExitPrice = px; pos = null; }
      dayClosed = true; continue;
    }
    const ub = UB[dayIdx], lb = LB[dayIdx];

    // EXIT — composable: catastrophic hard stop, trailing stop, VWAP/band reversion, EOD.
    if (pos) {
      const fav = (close - pos.entryPrice) * pos.side;
      if (fav > pos.mfe) pos.mfe = fav; if (fav < pos.mae) pos.mae = fav;
      let doExit = false, reason = '', px = 0;
      // 1. catastrophic hard stop (fills at the stop level + slip, worst-case)
      if (!doExit && stopPts > 0) {
        const stopLvl = pos.entryPrice - pos.side * stopPts;
        const hit = pos.side > 0 ? close <= stopLvl : close >= stopLvl;
        if (hit) { doExit = true; reason = 'stop'; px = stopLvl - pos.side * STOP_SLIP; }
      }
      // 2. trailing stop (arms once mfe >= trailArm), trails trailPts off the peak close
      if (!doExit && trailPts > 0 && pos.mfe >= trailArm) {
        const trailLvl = pos.entryPrice + pos.side * (pos.mfe - trailPts);
        const hit = pos.side > 0 ? close <= trailLvl : close >= trailLvl;
        if (hit) { doExit = true; reason = 'trail'; px = close - pos.side * STOP_SLIP; }
      }
      // 3. VWAP / band reversion (arms once mfe >= vwapArm)
      if (!doExit && exit !== 'hold' && pos.mfe >= vwapArm) {
        const vBreak = pos.side > 0 ? close < vwap : close > vwap;
        const bReenter = pos.side > 0 ? close < ub[m] : close > lb[m];
        if (exit === 'vwap' && vBreak) { doExit = true; reason = 'vwap'; }
        else if (exit === 'band' && bReenter) { doExit = true; reason = 'band'; }
        else if (exit === 'vwap-or-band' && (vBreak || bReenter)) { doExit = true; reason = vBreak ? 'vwap' : 'band'; }
        if (doExit) px = close - pos.side * STOP_SLIP;
      }
      if (doExit) { closeTrade(trades, pos, dayIdx, sec, px, reason); lastExitPrice = px; pos = null; }
    }

    // ENTRY — checkpoint (discrete grid) or continuous (every 1s close-cross of band)
    const checkpointBar = (m % grid === 0) && m !== lastCp;
    const canEval = entryMode === 'continuous' ? true : checkpointBar;
    if (!pos && inRange(dayIdx) && sec < neaSec && m >= firstCpMin && canEval
        && entriesToday < maxEntries && (allowReentry || entriesToday === 0)) {
      if (entryMode !== 'continuous' && checkpointBar) lastCp = m;
      let want = 0;
      const sma = smaArr[dayIdx];
      const longOK = side !== 'short' && (regimeSma === 0 || isNaN(sma) || openArr[dayIdx] >= sma);
      const shortOK = side !== 'long' && (regimeSma === 0 || isNaN(sma) || openArr[dayIdx] < sma);
      if (close > ub[m] + minBreak && longOK) want = +1;
      else if (close < lb[m] - minBreak && shortOK) want = -1;
      // re-entry gap guard: require new breakout to clear last exit by reentryGapPts
      if (want !== 0 && allowReentry && !isNaN(lastExitPrice) && reentryGapPts > 0) {
        if (want > 0 && close < lastExitPrice + reentryGapPts) want = 0;
        if (want < 0 && close > lastExitPrice - reentryGapPts) want = 0;
      }
      if (want !== 0) {
        const px = close + (want > 0 ? STOP_SLIP : -STOP_SLIP);
        pos = { side: want, entrySec: sec, entryPrice: px, mfe: 0, mae: 0 };
        entriesToday++;
        if (!allowFlip && entryMode !== 'continuous') lastCp = RTH_MIN + 1;
      }
    }
  }
  return metrics(trades, tradable.filter(Boolean).length, cfg);
}

function closeTrade(trades, pos, dayIdx, sec, exitPrice, reason) {
  const pnl = (exitPrice - pos.entryPrice) * pos.side * POINT_VALUE - COMMISSION;
  trades.push({ dayIdx, side: pos.side, pnl, reason, mfe: pos.mfe, mae: pos.mae });
}

function metrics(trades, tradableDays, cfg) {
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = -losses.reduce((s, t) => s + t.pnl, 0);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const pf = gl > 0 ? gw / gl : Infinity, wr = n ? wins.length / n : 0;
  let eq = 0, peak = 0, mdd = 0;
  const byDay = new Map();
  for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; if (peak - eq > mdd) mdd = peak - eq; byDay.set(t.dayIdx, (byDay.get(t.dayIdx) || 0) + t.pnl); }
  const dv = Array.from(byDay.values()); const mean = dv.reduce((s, v) => s + v, 0) / (dv.length || 1);
  const sd = Math.sqrt(dv.reduce((s, v) => s + (v - mean) ** 2, 0) / (dv.length || 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const half = Math.floor(n / 2);
  const pfOf = (a) => { const w = a.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0); const l = -a.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0); return l > 0 ? w / l : Infinity; };
  return {
    cfg, n, tradableDays, pnl: Math.round(pnl), wr, pf, sharpe, mdd: Math.round(mdd),
    avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? gl / losses.length : 0,
    h1pf: pfOf(trades.slice(0, half)), h2pf: pfOf(trades.slice(half)),
    longPnl: Math.round(trades.filter(t => t.side > 0).reduce((s, t) => s + t.pnl, 0)),
    shortPnl: Math.round(trades.filter(t => t.side < 0).reduce((s, t) => s + t.pnl, 0)),
  };
}

// ---- single config ----
const oneIdx = process.argv.indexOf('--one');
if (oneIdx !== -1) {
  const cfg = JSON.parse(process.argv[oneIdx + 1]);
  const r = run(cfg);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

// ---- MATRIX (round 8: tail-loss disaster stops + entry-timing windows) ----
const MATRIX = [];
const base = { lookback: 14, mult: 1.5, side: 'long', exit: 'hold', entryMode: 'checkpoint', grid: 30, firstCp: 30, eod: '15:45', noEntryAfter: '15:30' };
// (a) wide disaster stops (April-9 winner had MAE -73pt → need >73pt to preserve it)
for (const stopPts of [0, 60, 80, 100, 120])
  MATRIX.push({ ...base, stopPts, _label: `${TICKER} disaster-stop ${stopPts || 'none'}pt` });
// (b) entry-timing windows (cut midday/afternoon chop; keep 10:00-10:30)
for (const noEntryAfter of ['10:30', '11:00', '12:00', '13:00', '15:30'])
  MATRIX.push({ ...base, noEntryAfter, _label: `${TICKER} no-entry-after ${noEntryAfter}` });

console.log(`Running ${MATRIX.length} variants ...\n`);
const results = MATRIX.map(run).sort((a, b) => b.sharpe - a.sharpe);
const pad = (s, w) => String(s).padStart(w);
console.log('lkbk mult exit         side  trades   pnl$     WR     PF    Shrp   maxDD$   H1pf  H2pf   long$    short$');
console.log('-'.repeat(108));
for (const r of results) {
  const c = r.cfg;
  console.log(
    `${pad(c.lookback, 4)} ${pad(c.mult, 4)} ${pad(c.exit, 12)} ${pad(c.side, 5)} ${pad(r.n, 6)} ${pad(r.pnl, 8)} ${pad((r.wr * 100).toFixed(1), 5)} ${pad(r.pf.toFixed(2), 6)} ${pad(r.sharpe.toFixed(2), 6)} ${pad(r.mdd, 8)} ${pad(r.h1pf.toFixed(2), 5)} ${pad(r.h2pf.toFixed(2), 5)} ${pad(r.longPnl, 8)} ${pad(r.shortPnl, 9)}`
  );
}
fs.writeFileSync(path.join(OUT, 'sweep-results.json'), JSON.stringify(results, null, 2));
console.log(`\nWrote ${path.join(OUT, 'sweep-results.json')}`);
