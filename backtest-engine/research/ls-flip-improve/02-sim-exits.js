/**
 * Phase 2 — Exit-policy simulator (1s-honest, per-bar OHLC).
 *
 * Walk format (from 01): per trade, an array of [t_sec, hi, lo, c] tuples.
 *   hi = favorable PnL extreme this bar (signed, positive=favorable)
 *   lo = adverse PnL extreme this bar (signed; negative when adverse,
 *        positive when bar high+low both stayed on favorable side)
 *   c  = close PnL (signed)
 *   Note: for both LONG and SHORT, hi/lo/c are already side-flipped so
 *   favorable = positive. So mfe-from-this-bar = hi, mae-from-this-bar = -lo
 *   when lo < 0 (else mae contribution = 0).
 *
 * Exit policies (composable, 1s-honest):
 *   target   : fixed profit target (entry + tgtPts) — limit fill at exact price
 *   stop     : fixed stop loss (entry - stpPts) — stop fill with SLIP slippage
 *   beTrig   : break-even-stop activation MFE threshold
 *   beOff    : BE floor offset (positive = lock-in profit)
 *   trTrig   : trailing stop activation MFE threshold
 *   trOff    : trailing offset behind MFE peak
 *   maxHoldMin: time-based exit (default 60)
 *
 * Same-bar ambiguity: if a 1s bar shows BOTH target and stop hit, conservative
 * loss (stop fires first). With per-bar resolution this is very rare.
 *
 * Slippage: 0.25pt on stops and trail/BE stops. Targets fill exact.
 *
 * Usage:
 *   node 02-sim-exits.js --target 8 --stop 4 --trail-trigger 6 --trail-offset 3
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
function flag(name) { return process.argv.includes(`--${name}`); }

const WALK_PATH = arg('walk', path.join(__dirname, 'output', '01-trades-walk.json'));
const TARGET_PTS = arg('target', null);
const STOP_PTS = arg('stop', null);
const BE_TRIGGER = arg('be-trigger', null);
const BE_OFFSET = +arg('be-offset', '0');
const TRAIL_TRIGGER = arg('trail-trigger', null);
const TRAIL_OFFSET = arg('trail-offset', null);
const MAX_HOLD_MIN = +arg('max-hold', '60');
const SLIP_PTS = +arg('slip', '0.25');
const POINT_VALUE = +arg('point-value', '20');
const COMMISSION = +arg('commission', '5');
const QUIET = flag('quiet');
const OUT = arg('out', null);

const ttarget = TARGET_PTS == null ? null : +TARGET_PTS;
const tstop = STOP_PTS == null ? null : +STOP_PTS;
const betrig = BE_TRIGGER == null ? null : +BE_TRIGGER;
const trtrig = TRAIL_TRIGGER == null ? null : +TRAIL_TRIGGER;
const troff = TRAIL_OFFSET == null ? null : +TRAIL_OFFSET;
const maxHoldMs = MAX_HOLD_MIN * 60_000;

if (!QUIET) console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
if (!QUIET) console.log(`Trades: ${walks.length}`);

/**
 * Simulate one trade.
 *   walk:  [ [t_sec, hi_fav, lo_fav, c_fav] ... ] all favorable-positive
 *   origTgt: original take_profit distance (entry → tp, in pts)
 *   origStp: original stop_loss distance (entry → sl, in pts)
 *
 * For each bar:
 *   1. Update mfe_peak = max(mfe_peak, hi)
 *   2. Update mae_max  = max(mae_max, -lo) when lo < 0
 *   3. Activate BE/trail if mfe_peak crosses triggers
 *   4. Check stop: if mae_max >= stp → stop hit at -(stp + slip)
 *   5. Check target: if mfe_peak >= tgt → target hit at +tgt
 *   6. Check BE: if active and lo <= beOff → exit at beOff (assume limit-type fill)
 *      (this fires when the bar low dips to the BE floor)
 *   7. Check trail: if active and lo <= mfe_peak - trOff → exit at mfe_peak - trOff
 *      (trail stop = market on touch with slip; but mfe_peak - trOff is positive
 *       so we model exit at level - slip for the stop slippage cost)
 *
 * Same-bar resolution: stop check first (conservative loss).
 */
function simulate(e, cfg) {
  const origTgt = e.side === 'buy' ? (e.tp - e.entry) : (e.entry - e.tp);
  const origStp = e.side === 'buy' ? (e.entry - e.sl) : (e.sl - e.entry);
  const tgt = cfg.target == null ? origTgt : cfg.target;
  const stp = cfg.stop == null ? origStp : cfg.stop;

  let mfePeak = 0;
  let mae = 0;
  let beActive = false, trActive = false;
  const walk = e.walk;
  for (let i = 0; i < walk.length; i++) {
    const s = walk[i];
    const t = s[0] * 1000;
    const hi = s[1];      // bar high favorable
    const lo = s[2];      // bar low favorable (negative if adverse)
    const c = s[3];

    if (hi > mfePeak) mfePeak = hi;
    if (lo < 0 && -lo > mae) mae = -lo;

    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) beActive = true;
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;

    // Stop check (1m-style ambiguous → loss). mae cross stop threshold.
    if (mae >= stp) {
      return { exit: 'stop', pnl: -(stp + SLIP_PTS), durationMs: t, mfe: mfePeak };
    }
    // Target check
    if (mfePeak >= tgt) {
      return { exit: 'target', pnl: tgt, durationMs: t, mfe: mfePeak };
    }
    // BE check: when bar low favorable drops to/below beOff
    if (beActive && lo <= cfg.beOff) {
      return { exit: 'be', pnl: cfg.beOff, durationMs: t, mfe: mfePeak };
    }
    // Trail check: bar low drops to/below (peak - trOff)
    if (trActive) {
      const trailLevel = mfePeak - cfg.trOff;
      if (lo <= trailLevel) {
        return { exit: 'trail', pnl: trailLevel - SLIP_PTS, durationMs: t, mfe: mfePeak };
      }
    }
    // Time-based maxhold (use the next sample's close if past maxhold)
    if (t > maxHoldMs) {
      return { exit: 'maxhold', pnl: c, durationMs: maxHoldMs, mfe: mfePeak };
    }
  }

  // No early exit — use terminal
  if (e.terminal === 'eod' && e.eodPrice != null) {
    const pnl = e.side === 'buy' ? (e.eodPrice - e.entry) : (e.entry - e.eodPrice);
    return { exit: 'eod', pnl, durationMs: e.finalTs - e.fillTs, mfe: mfePeak };
  }
  // Final bar's close as fallback
  if (walk.length > 0) {
    const last = walk[walk.length - 1];
    return { exit: e.terminal || 'final', pnl: last[3], durationMs: last[0] * 1000, mfe: mfePeak };
  }
  return { exit: 'no_data', pnl: 0, durationMs: 0, mfe: 0 };
}

function statsFor(results) {
  let pnl = 0, wins = 0, losses = 0, sumW = 0, sumL = 0;
  const equity = []; let cum = 0;
  const exitReasons = {};
  for (const r of results) {
    const d = r.pnl * POINT_VALUE - COMMISSION;
    pnl += d; cum += d; equity.push(cum);
    if (d > 0) { wins++; sumW += d; }
    else if (d < 0) { losses++; sumL += d; }
    exitReasons[r.exit] = (exitReasons[r.exit] || 0) + 1;
  }
  const wr = (wins + losses) ? wins / (wins + losses) * 100 : 0;
  const pf = sumL !== 0 ? Math.abs(sumW / sumL) : (sumW > 0 ? Infinity : 0);
  let peak = -Infinity, maxDD = 0;
  for (const v of equity) { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; }
  const mean = pnl / results.length;
  let varSum = 0;
  for (const r of results) { const d = r.pnl * POINT_VALUE - COMMISSION; varSum += (d - mean) ** 2; }
  const sd = Math.sqrt(varSum / results.length);
  const perT = sd > 0 ? mean / sd : 0;
  const tradesPerYear = results.length / (16 / 12);
  return { pnl, wins, losses, wr, pf, maxDD, sharpe: perT * Math.sqrt(tradesPerYear), n: results.length, exitReasons };
}

if (!QUIET) {
  console.log(`Policy: tgt=${ttarget ?? 'orig'}pt  stop=${tstop ?? 'orig'}pt  be=${betrig ?? '-'}/+${BE_OFFSET}  trail=${trtrig ?? '-'}/${troff ?? '-'}  maxHold=${MAX_HOLD_MIN}min`);
}

const cfg = { target: ttarget, stop: tstop, beTrig: betrig, beOff: BE_OFFSET, trTrig: trtrig, trOff: troff };
const results = walks.map(w => ({ ...simulate(w, cfg), id: w.id, side: w.side, fillTs: w.fillTs, hourEt: w.hourEt, rangeRatio: w.rangeRatio, cbAtr: w.cbAtr, triggerBarRange: w.triggerBarRange }));
const st = statsFor(results);

if (!QUIET) {
  console.log('');
  console.log(`Trades : ${st.n}`);
  console.log(`Net PnL: $${st.pnl.toFixed(0)}`);
  console.log(`W/L    : ${st.wins}/${st.losses} (WR ${st.wr.toFixed(2)}%)`);
  console.log(`PF     : ${st.pf.toFixed(2)}`);
  console.log(`MaxDD  : $${st.maxDD.toFixed(0)}`);
  console.log(`Sharpe : ${st.sharpe.toFixed(2)}`);
  console.log(`Avg W/L: $${(st.sumW||0).toFixed(0)} / $${(st.sumL||0).toFixed(0)}`);
  console.log(`Exits  :`); for (const [k,v] of Object.entries(st.exitReasons).sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(12)} ${v}`);
}

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ stats: st, results }, null, 2));
  if (!QUIET) console.log(`\nWrote ${OUT}`);
}

export { walks, simulate, statsFor };
