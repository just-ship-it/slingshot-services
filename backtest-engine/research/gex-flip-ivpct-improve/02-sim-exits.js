/**
 * Phase 2 — gfi exit-policy simulator (1s-honest, per-bar OHLC).
 *
 * Walk format (from 01): per trade, an array of [t_sec, hi, lo, c] tuples
 * (favorable-positive signed PnL offsets from entry).
 *
 * Single-strategy: ALL trades share one exit policy (no per-rule overrides
 * at the exit layer — gfi's existing per-rule defaults are baseline; we sweep
 * a single global policy on top).
 *
 * Supported exit mechanics (whichever fires first wins, in this priority):
 *   1. stop_loss     — bar's adverse MAE reaches stopPts → exit at -(stop+slip)
 *   2. target        — bar's favorable MFE reaches targetPts → exit at +target
 *   3. fib retrace   — once mfe>=fibActivationMFE, bar CLOSE drops below
 *                       mfe*(1-fibRetracePct) → exit at close
 *   4. BE (with lock)— once mfe>=beTrig, bar low drops to/below beOff → exit at beOff
 *   5. trail         — once mfe>=trTrig, bar low drops to/below (peak-trOff)
 *                       → exit at peak-trOff-slip
 *   6. market-aware:
 *       DR (double rejection): track MFE peak; on price retracing >=pullbackMin
 *         then returning within tolPts of peak, count as 2nd rejection. Action:
 *         drClose=true → close at current close; drTightenLockFrac >0 → tighten
 *         BE-style stop to (lockFrac × MFE).
 *       MFT (MFE-fraction TP): when mfe >= mftFracTp × targetPts, snap BE floor
 *         to (mftLockFrac × MFE). Caps loss at lockFrac × MFE if retraced.
 *       VR (velocity reversal): MFE plateau ≥ vrPlateauSec at peak AND adverse
 *         single-bar move ≥ vrAdvPts → close at current close.
 *   7. maxHoldMin    — time-based exit at the close at maxHold
 *   8. eod           — explicit EOD price if available
 *
 * Same-bar ambiguity: stop check first (conservative loss). Slip 0.25pt on stops
 * and trail exits. Target/BE/fib retrace fill exact at level.
 */

import fs from 'fs';

export const SLIP_PTS = 0.25;
export const POINT_VALUE = 20;
export const COMMISSION = 5;

/**
 * Simulate one trade walk under config cfg.
 *   { target, stop, beTrig, beOff, trTrig, trOff, maxHoldMin,
 *     fibRetracePct, fibActivationMFE,
 *     drFracTp, drPullbackMin, drTolPts, drClose, drTightenLockFrac,
 *     mftFracTp, mftLockFrac,
 *     vrMfeMin, vrPlateauSec, vrAdvPts }
 */
export function simulate(e, cfg) {
  const tgt = cfg.target != null ? cfg.target : e.ruleTargetPts;
  const stp = cfg.stop != null ? cfg.stop : e.ruleStopPts;
  const maxHoldMs = (cfg.maxHoldMin != null ? cfg.maxHoldMin : 600) * 60_000;

  let mfePeak = 0;
  let mae = 0;
  let beActive = false, trActive = false;
  // dynamic floor (BE-style locked profit level, in favorable points)
  let lockFloor = null; // when set, any bar low <= lockFloor exits at lockFloor
  // DR state
  let drArmedAt = null;
  let drFracMfeThreshold = cfg.drFracTp != null && tgt != null ? cfg.drFracTp * tgt : null;
  let drRetracedBelow = false; // we observed a pullback >= drPullbackMin from peak
  // VR state
  let vrPeakAchievedAt = null;
  let prevHi = 0;
  const walk = e.walk;

  for (let i = 0; i < walk.length; i++) {
    const s = walk[i];
    const t = s[0] * 1000;
    const hi = s[1];   // favorable extreme (positive when favorable)
    const lo = s[2];   // adverse extreme (negative when adverse)
    const c  = s[3];   // signed close

    if (hi > mfePeak) {
      mfePeak = hi;
      vrPeakAchievedAt = t;
      drRetracedBelow = false; // new peak resets DR
    }
    if (lo < 0 && -lo > mae) mae = -lo;

    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) {
      beActive = true;
      // BE installs a lock floor at beOff (could be 0 for pure BE or positive for profit-lock)
      if (lockFloor == null || (cfg.beOff != null && cfg.beOff > lockFloor)) {
        lockFloor = cfg.beOff;
      }
    }
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;

    // MFT: when mfe crosses mftFracTp * target, snap floor at mftLockFrac * mfe
    if (cfg.mftFracTp != null && tgt != null) {
      const mftThreshold = cfg.mftFracTp * tgt;
      if (mfePeak >= mftThreshold) {
        const newFloor = cfg.mftLockFrac * mfePeak;
        if (lockFloor == null || newFloor > lockFloor) lockFloor = newFloor;
      }
    }

    // 1. Stop_loss (conservative loss first)
    if (stp != null && mae >= stp) {
      return { exit: 'stop', pnl: -(stp + SLIP_PTS), durationMs: t, mfe: mfePeak };
    }
    // 2. Target
    if (tgt != null && mfePeak >= tgt) {
      return { exit: 'target', pnl: tgt, durationMs: t, mfe: mfePeak };
    }
    // 3. Fib retrace exit (CLOSE-based; requires fib activation)
    if (cfg.fibActivationMFE != null && cfg.fibRetracePct != null
        && mfePeak >= cfg.fibActivationMFE) {
      const fibLevel = mfePeak * (1 - cfg.fibRetracePct);
      if (c <= fibLevel) {
        return { exit: 'fib', pnl: c, durationMs: t, mfe: mfePeak };
      }
    }
    // 4. BE / lock floor (bar low favorable drops to/below floor)
    if (lockFloor != null && lo <= lockFloor) {
      return { exit: 'be', pnl: lockFloor, durationMs: t, mfe: mfePeak };
    }
    // 5. Trail
    if (trActive) {
      const trailLevel = mfePeak - cfg.trOff;
      if (lo <= trailLevel) {
        return { exit: 'trail', pnl: trailLevel - SLIP_PTS, durationMs: t, mfe: mfePeak };
      }
    }
    // 6a. DR: track double-rejection
    if (cfg.drFracTp != null && cfg.drPullbackMin != null && cfg.drTolPts != null
        && tgt != null && mfePeak >= drFracMfeThreshold) {
      // If bar low pulled back from peak by >= drPullbackMin, mark
      if (mfePeak - lo >= cfg.drPullbackMin) drRetracedBelow = true;
      // After a pullback, if hi returns within tolPts of peak, count as 2nd rejection
      if (drRetracedBelow && mfePeak - hi <= cfg.drTolPts) {
        if (cfg.drClose) {
          return { exit: 'dr_close', pnl: c, durationMs: t, mfe: mfePeak };
        } else if (cfg.drTightenLockFrac != null) {
          const tightFloor = cfg.drTightenLockFrac * mfePeak;
          if (lockFloor == null || tightFloor > lockFloor) lockFloor = tightFloor;
        }
      }
    }
    // 6c. VR: velocity reversal — plateau at peak + adverse single-bar move
    if (cfg.vrMfeMin != null && cfg.vrPlateauSec != null && cfg.vrAdvPts != null
        && mfePeak >= cfg.vrMfeMin && vrPeakAchievedAt != null
        && (t - vrPeakAchievedAt) >= cfg.vrPlateauSec * 1000) {
      const adv = prevHi - lo; // adverse range in this bar from prev high
      if (adv >= cfg.vrAdvPts) {
        return { exit: 'vr', pnl: c, durationMs: t, mfe: mfePeak };
      }
    }
    prevHi = hi;

    // 7. maxHold
    if (t > maxHoldMs) {
      return { exit: 'maxhold', pnl: c, durationMs: maxHoldMs, mfe: mfePeak };
    }
  }

  // Terminal handling
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

/** policy: single global policy. filter: optional fn(w, cfg) → bool (true=keep). */
export function simulateAll(walks, policy = {}, options = {}) {
  const { filterFn = null, blockedHours = null, blockedDows = null,
          blockedRules = null, blockedRegimes = null } = options;
  const out = [];
  for (const w of walks) {
    if (blockedHours && blockedHours.includes(w.hourEt)) {
      out.push({ id: w.id, tradeId: w.tradeId, ruleId: w.ruleId, side: w.side, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow, regime: w.gexRegime, dropped: true, dropReason: 'hour' });
      continue;
    }
    if (blockedDows && blockedDows.includes(w.dow)) {
      out.push({ id: w.id, tradeId: w.tradeId, ruleId: w.ruleId, side: w.side, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow, regime: w.gexRegime, dropped: true, dropReason: 'dow' });
      continue;
    }
    if (blockedRules && blockedRules.includes(w.ruleId)) {
      out.push({ id: w.id, tradeId: w.tradeId, ruleId: w.ruleId, side: w.side, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow, regime: w.gexRegime, dropped: true, dropReason: 'rule' });
      continue;
    }
    if (blockedRegimes && blockedRegimes.includes(w.gexRegime)) {
      out.push({ id: w.id, tradeId: w.tradeId, ruleId: w.ruleId, side: w.side, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow, regime: w.gexRegime, dropped: true, dropReason: 'regime' });
      continue;
    }
    if (filterFn && !filterFn(w, policy)) {
      out.push({ id: w.id, tradeId: w.tradeId, ruleId: w.ruleId, side: w.side, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow, regime: w.gexRegime, dropped: true, dropReason: 'filter' });
      continue;
    }
    const r = simulate(w, policy);
    out.push({
      id: w.id, tradeId: w.tradeId, ruleId: w.ruleId, side: w.side, fillTs: w.fillTs,
      hourEt: w.hourEt, dow: w.dow, regime: w.gexRegime, ivPct: w.ivPercentile,
      exit: r.exit, pointsPnL: r.pnl, durationMs: r.durationMs, mfe: r.mfe, dropped: false,
    });
  }
  return out;
}

/** Compute aggregate stats from results. Drops `dropped:true` rows. */
export function stats(results, opts = {}) {
  const { tradesPerYearDenom = (16 / 12) } = opts;
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
  const tradesPerYear = n / tradesPerYearDenom;
  const dropped = results.length - n;
  // single-trade worst loss
  let worstLoss = 0;
  for (const r of taken) {
    const d = r.pointsPnL * POINT_VALUE - COMMISSION;
    if (d < worstLoss) worstLoss = d;
  }
  return {
    n, dropped, pnl, wins, losses, wr, pf, maxDD,
    sharpePerTrade: perT, sharpe: perT * Math.sqrt(tradesPerYear),
    avgWin: wins ? sumW / wins : 0, avgLoss: losses ? sumL / losses : 0,
    avgMFE: n ? mfeSum / n : 0, exitReasons,
    worstLoss,
  };
}

export function statsByKey(results, keyFn) {
  const buckets = {};
  for (const r of results) {
    if (r.dropped) continue;
    const k = keyFn(r) ?? 'NONE';
    (buckets[k] = buckets[k] || []).push(r);
  }
  const out = {};
  for (const k of Object.keys(buckets)) out[k] = stats(buckets[k]);
  return out;
}

export const statsByRule = (r) => statsByKey(r, x => x.ruleId);
export const statsByHour = (r) => statsByKey(r, x => x.hourEt);
export const statsByDow  = (r) => statsByKey(r, x => x.dow);
export const statsByRegime = (r) => statsByKey(r, x => x.regime);

// CLI mode: replay the tight-stop gold policy and print stats
if (import.meta.url === `file://${process.argv[1]}`) {
  const WALK_PATH = process.argv[2] || './output/01-trades-walk.json';
  console.log(`Loading ${WALK_PATH}...`);
  const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
  console.log(`Trades: ${walks.length}`);

  // Replay tight-stop gold policy
  const goldPolicy = {
    target: 200, stop: 60,
    beTrig: 70, beOff: 5,
    maxHoldMin: 600,
  };
  const results = simulateAll(walks, goldPolicy);
  const st = stats(results);
  console.log('\n=== TIGHT-STOP GOLD POLICY replay ===');
  console.log(`Trades : ${st.n}  (dropped: ${st.dropped})`);
  console.log(`PnL    : $${st.pnl.toFixed(0)}`);
  console.log(`WR     : ${st.wr.toFixed(1)}%`);
  console.log(`PF     : ${st.pf.toFixed(2)}`);
  console.log(`Sharpe : ${st.sharpe.toFixed(2)}`);
  console.log(`MaxDD  : $${st.maxDD.toFixed(0)}`);
  console.log(`avgMFE : ${st.avgMFE.toFixed(1)}pt`);
  console.log(`worstL : $${st.worstLoss.toFixed(0)}`);
  console.log('Exits  :', st.exitReasons);
  console.log('\nBy rule:');
  const byR = statsByRule(results);
  for (const k of Object.keys(byR).sort()) {
    const b = byR[k];
    console.log(`  ${k.padEnd(4)} n=${b.n} PnL=$${b.pnl.toFixed(0).padStart(7)} WR=${b.wr.toFixed(0)}% PF=${b.pf.toFixed(2)} Sh=${b.sharpe.toFixed(2)} DD=$${b.maxDD.toFixed(0)} avgMFE=${b.avgMFE.toFixed(1)}pt`);
  }
  console.log('\nBy hour:');
  const byH = statsByHour(results);
  for (const k of Object.keys(byH).sort((a,b)=>+a-+b)) {
    const b = byH[k];
    console.log(`  ${k.padStart(2)} ET n=${b.n} PnL=$${b.pnl.toFixed(0).padStart(6)} WR=${b.wr.toFixed(0)}% PF=${b.pf.toFixed(2)}`);
  }
  console.log('\nBy DOW:');
  const byD = statsByDow(results);
  for (const k of Object.keys(byD).sort()) {
    const b = byD[k];
    console.log(`  ${k} n=${b.n} PnL=$${b.pnl.toFixed(0).padStart(6)} WR=${b.wr.toFixed(0)}% PF=${b.pf.toFixed(2)}`);
  }
  console.log('\nBy regime:');
  const byG = statsByRegime(results);
  for (const k of Object.keys(byG).sort()) {
    const b = byG[k];
    console.log(`  ${k.padEnd(16)} n=${b.n} PnL=$${b.pnl.toFixed(0).padStart(6)} WR=${b.wr.toFixed(0)}% PF=${b.pf.toFixed(2)}`);
  }
}
