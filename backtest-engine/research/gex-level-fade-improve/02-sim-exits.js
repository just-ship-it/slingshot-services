/**
 * Phase 2 — Exit-policy simulator for gex-level-fade (1s-honest, per-bar OHLC).
 *
 * Single-policy (unlike glx, glf has no per-rule split). Supports:
 *   Baseline:   target, stop, maxHoldMin
 *   BE:         beTrig (MFE threshold to arm), beOff (locked PnL when armed)
 *   Trail:      trTrig (MFE threshold to arm), trOff (offset behind peak)
 *   Mechanic 1: DOUBLE_REJECTION  — see params docs in code
 *   Mechanic 2: MFE_FRAC_TP       — BE-style floor scaled by target
 *   Mechanic 3: VELOCITY_REVERSAL — MFE plateau + sudden adverse bar
 *
 * Filters at the simulator level (so we can sweep them):
 *   blockedHours  - array of ET hours to drop
 *   blockedDows   - array of weekday strings ('Mon'..'Sun') to drop
 *   blockedLevels - array of levelType strings to drop
 *   blockedSides  - array of sides ('long'|'short') to drop
 *   filterFn      - custom fn(w, cfg) => bool
 *
 * Same-bar ambiguity: stop check first (conservative loss).
 * Slippage: 0.25pt on stops/trail/BE-stop fills. Targets fill exact.
 */

import fs from 'fs';

export const SLIP_PTS = 0.25;
export const POINT_VALUE = 20;
export const COMMISSION = 5;

// Gold standard glf default policy
export const GOLD_POLICY = {
  target: 100,
  stop: 18,
  maxHoldMin: 180,
};

/**
 * Simulate one trade with baseline exits + optional market-aware mechanics.
 */
export function simulate(e, cfg) {
  const tgt = cfg.target != null ? cfg.target : GOLD_POLICY.target;
  const stp = cfg.stop != null ? cfg.stop : GOLD_POLICY.stop;
  const maxHoldMs = (cfg.maxHoldMin != null ? cfg.maxHoldMin : GOLD_POLICY.maxHoldMin) * 60_000;

  let mfePeak = 0;
  let mae = 0;
  let beActive = false, trActive = false;

  // Mechanic 1 state (double rejection)
  let drState = 'AT_PEAK';
  let drFloor = null;
  // Mechanic 2 state
  let mftFloor = null;
  // Mechanic 3 state
  let mfePeakTs = 0;
  let prevClose = 0;

  const walk = e.walk;
  for (let i = 0; i < walk.length; i++) {
    const s = walk[i];
    const t = s[0] * 1000;
    const hi = s[1];   // favorable extreme
    const lo = s[2];   // adverse extreme (neg when adverse)
    const c  = s[3];

    if (hi > mfePeak) {
      mfePeak = hi;
      mfePeakTs = t;
    }
    if (lo < 0 && -lo > mae) mae = -lo;

    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) beActive = true;
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;

    // ─── Market-aware mechanics (preempt baseline) ───

    // (1) DOUBLE_REJECTION
    if (cfg.drEnabled) {
      const mfeOk =
        (cfg.drMfeMin != null && mfePeak >= cfg.drMfeMin) ||
        (cfg.drMfeFracTp != null && tgt != null && mfePeak >= cfg.drMfeFracTp * tgt);
      if (mfeOk) {
        const tol = cfg.drTolPts ?? 3;
        const pull = cfg.drPullbackMin ?? 5;
        if (drState === 'AT_PEAK') {
          if (mfePeak - hi >= pull) drState = 'PULLED';
        } else if (drState === 'PULLED') {
          if (hi >= mfePeak - tol && hi < mfePeak + tol + 0.01) {
            const action = cfg.drAction || 'close';
            if (action === 'close') {
              return { exit: 'dr_close', pnl: c, durationMs: t, mfe: mfePeak };
            } else {
              drFloor = cfg.drLockPts != null
                ? cfg.drLockPts
                : (cfg.drLockFrac ?? 0.5) * mfePeak;
              drState = 'AT_PEAK';
            }
          } else if (hi > mfePeak) {
            drState = 'AT_PEAK';
          }
        }
      }
      if (drFloor != null && lo <= drFloor) {
        return { exit: 'dr_tightened', pnl: drFloor - SLIP_PTS, durationMs: t, mfe: mfePeak };
      }
    }

    // (2) MFE_FRAC_TP
    if (cfg.mftEnabled && mftFloor == null && tgt != null) {
      const frac = cfg.mftFracTp ?? 0.6;
      if (mfePeak >= frac * tgt) {
        mftFloor = (cfg.mftLockFrac ?? 0.5) * mfePeak;
      }
    }
    if (mftFloor != null && lo <= mftFloor) {
      return { exit: 'mft_floor', pnl: mftFloor - SLIP_PTS, durationMs: t, mfe: mfePeak };
    }

    // (3) VELOCITY_REVERSAL
    if (cfg.vrEnabled && i > 0) {
      const mfeOk = mfePeak >= (cfg.vrMfeMin ?? 20);
      const plateauOk = (t - mfePeakTs) >= (cfg.vrPlateauSec ?? 60) * 1000;
      const advMove = prevClose - lo;
      if (mfeOk && plateauOk && advMove >= (cfg.vrAdversePts ?? 5)) {
        return { exit: 'vr_close', pnl: c, durationMs: t, mfe: mfePeak };
      }
    }
    prevClose = c;

    // ─── Baseline exits ───
    if (stp != null && mae >= stp) {
      return { exit: 'stop', pnl: -(stp + SLIP_PTS), durationMs: t, mfe: mfePeak };
    }
    if (tgt != null && mfePeak >= tgt) {
      return { exit: 'target', pnl: tgt, durationMs: t, mfe: mfePeak };
    }
    if (beActive && lo <= cfg.beOff) {
      return { exit: 'be', pnl: cfg.beOff, durationMs: t, mfe: mfePeak };
    }
    if (trActive) {
      const trailLevel = mfePeak - cfg.trOff;
      if (lo <= trailLevel) {
        return { exit: 'trail', pnl: trailLevel - SLIP_PTS, durationMs: t, mfe: mfePeak };
      }
    }
    if (t > maxHoldMs) {
      return { exit: 'maxhold', pnl: c, durationMs: maxHoldMs, mfe: mfePeak };
    }
  }

  // Walk exhausted before any exit fired — fall back to terminal
  if (e.terminal === 'eod' && e.eodPrice != null) {
    const pnl = e.direction === 'long' ? (e.eodPrice - e.entry) : (e.entry - e.eodPrice);
    return { exit: 'eod', pnl, durationMs: e.finalTs - e.fillTs, mfe: mfePeak };
  }
  if (walk.length > 0) {
    const last = walk[walk.length - 1];
    return { exit: e.terminal || 'final', pnl: last[3], durationMs: last[0] * 1000, mfe: mfePeak };
  }
  return { exit: 'no_data', pnl: 0, durationMs: 0, mfe: 0 };
}

function levelGroup(lt) {
  if (!lt) return 'NONE';
  if (lt === 'PRH' || lt === 'PRL') return 'PR';
  if (lt === 'SH' || lt === 'SL') return 'SHL';
  if (lt === 'put_wall' || lt === 'call_wall' || lt === 'gamma_flip') return 'GEX';
  if (/^[SR]\d+$/.test(lt)) return 'LT';
  return 'OTHER';
}

export function passesFilters(w, cfg) {
  if (cfg.blockedHours && cfg.blockedHours.includes(w.hourEt)) return false;
  if (cfg.blockedDows && cfg.blockedDows.includes(w.dow)) return false;
  if (cfg.blockedLevels && cfg.blockedLevels.includes(w.levelType)) return false;
  if (cfg.blockedLevelGroups && cfg.blockedLevelGroups.includes(levelGroup(w.levelType))) return false;
  if (cfg.blockedSides && cfg.blockedSides.includes(w.direction)) return false;
  if (cfg.filterFn && !cfg.filterFn(w, cfg)) return false;
  return true;
}

export function simulateAll(walks, cfg) {
  const out = [];
  for (const w of walks) {
    if (!passesFilters(w, cfg)) {
      out.push({
        id: w.id, tradeId: w.tradeId, levelType: w.levelType, side: w.side,
        direction: w.direction, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow,
        dropped: true, dropReason: 'filter',
      });
      continue;
    }
    const r = simulate(w, cfg);
    out.push({
      id: w.id, tradeId: w.tradeId, levelType: w.levelType, side: w.side,
      direction: w.direction, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow,
      levelGroup: levelGroup(w.levelType),
      exit: r.exit, pointsPnL: r.pnl, durationMs: r.durationMs, mfe: r.mfe, dropped: false,
    });
  }
  return out;
}

export function stats(results) {
  const taken = results.filter(r => !r.dropped);
  let pnl = 0, wins = 0, losses = 0, sumW = 0, sumL = 0;
  const equity = []; let cum = 0;
  const exitReasons = {};
  let mfeSum = 0;
  for (const r of taken) {
    const d = r.pointsPnL * POINT_VALUE - COMMISSION;
    pnl += d; cum += d; equity.push(cum);
    if (d > 0) { wins++; sumW += d; }
    else if (d < 0) { losses++; sumL += d; }
    exitReasons[r.exit] = (exitReasons[r.exit] || 0) + 1;
    mfeSum += r.mfe;
  }
  const n = taken.length;
  const wr = (wins + losses) ? wins / (wins + losses) * 100 : 0;
  const pf = sumL !== 0 ? Math.abs(sumW / sumL) : (sumW > 0 ? Infinity : 0);
  let peak = -Infinity, maxDD = 0;
  for (const v of equity) { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; }
  const mean = n ? pnl / n : 0;
  let varSum = 0;
  for (const r of taken) { const d = r.pointsPnL * POINT_VALUE - COMMISSION; varSum += (d - mean) ** 2; }
  const sd = n ? Math.sqrt(varSum / n) : 0;
  const perT = sd > 0 ? mean / sd : 0;
  const tradesPerYear = n / (16 / 12);
  const dropped = results.length - n;
  return {
    n, dropped, pnl, wins, losses, wr, pf, maxDD,
    sharpePerTrade: perT, sharpe: perT * Math.sqrt(tradesPerYear),
    avgWin: wins ? sumW / wins : 0, avgLoss: losses ? sumL / losses : 0,
    avgMFE: n ? mfeSum / n : 0, exitReasons,
  };
}

export function bucketize(results, keyFn) {
  const buckets = {};
  for (const r of results) {
    if (r.dropped) continue;
    const k = keyFn(r);
    if (k == null) continue;
    (buckets[k] = buckets[k] || []).push(r);
  }
  const out = {};
  for (const k of Object.keys(buckets)) out[k] = stats(buckets[k]);
  return out;
}

export function statsByHour(results)  { return bucketize(results, r => r.hourEt); }
export function statsByDow(results)   { return bucketize(results, r => r.dow); }
export function statsByLevel(results) { return bucketize(results, r => r.levelType); }
export function statsByGroup(results) { return bucketize(results, r => r.levelGroup); }
export function statsBySide(results)  { return bucketize(results, r => r.direction); }

// CLI: replay gold policy
if (import.meta.url === `file://${process.argv[1]}`) {
  const WALK_PATH = process.argv[2] || './output/01-trades-walk.json';
  console.log(`Loading ${WALK_PATH}...`);
  const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
  console.log(`Trades: ${walks.length}`);

  const results = simulateAll(walks, GOLD_POLICY);
  const st = stats(results);
  console.log('\n=== GOLD POLICY replay (target=100, stop=18, maxHold=180min) ===');
  console.log(`Trades : ${st.n}  (dropped: ${st.dropped})`);
  console.log(`PnL    : $${st.pnl.toFixed(0)}`);
  console.log(`WR     : ${st.wr.toFixed(1)}%`);
  console.log(`PF     : ${st.pf.toFixed(2)}`);
  console.log(`Sharpe : ${st.sharpe.toFixed(2)}`);
  console.log(`MaxDD  : $${st.maxDD.toFixed(0)}`);
  console.log(`avgWin : $${st.avgWin.toFixed(0)}  avgLoss: $${st.avgLoss.toFixed(0)}`);
  console.log(`avgMFE : ${st.avgMFE.toFixed(1)}pt`);
  console.log('Exits  :', st.exitReasons);

  console.log(`\nEngine gold: 889 trades / $104,771 / WR 21.15% / PF 1.38 / Sharpe 4.21 / MaxDD 7.04%`);
}
