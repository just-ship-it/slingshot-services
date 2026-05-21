/**
 * Phase 2 — Exit-policy simulator (1s-honest, per-bar OHLC).
 *
 * Walk format (from 01): per trade, an array of [t_sec, hi, lo, c] tuples
 * (favorable-positive signed PnL offsets from entry).
 *
 * Per-rule exit policy (target, stop, beTrig/beOff, trTrig/trOff, maxHoldMin).
 * Filters: blockedHours (array, applied per-rule or globally), filterFn.
 *
 * Same-bar ambiguity: stop check first (conservative loss).
 * Slippage: 0.25pt on stops and trail/BE-stop fills. Targets fill exact.
 */

import fs from 'fs';

const SLIP_PTS = 0.25;
const POINT_VALUE = 20;
const COMMISSION = 5;

/**
 * Simulate one trade. cfg = { target, stop, beTrig, beOff, trTrig, trOff, maxHoldMin }.
 * Defaults target/stop to the trade's `ruleTargetPts` / `ruleStopPts` (gold-standard).
 */
export function simulate(e, cfg) {
  const tgt = cfg.target != null ? cfg.target : e.ruleTargetPts;
  const stp = cfg.stop != null ? cfg.stop : e.ruleStopPts;
  const maxHoldMs = (cfg.maxHoldMin != null ? cfg.maxHoldMin : (e.ruleMaxHoldBars || 60)) * 60_000;

  let mfePeak = 0;
  let mae = 0;
  let beActive = false, trActive = false;
  const walk = e.walk;
  for (let i = 0; i < walk.length; i++) {
    const s = walk[i];
    const t = s[0] * 1000;
    const hi = s[1];   // favorable extreme
    const lo = s[2];   // adverse extreme (negative when adverse)
    const c  = s[3];

    if (hi > mfePeak) mfePeak = hi;
    if (lo < 0 && -lo > mae) mae = -lo;

    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) beActive = true;
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;

    // Stop (conservative loss first)
    if (stp != null && mae >= stp) {
      return { exit: 'stop', pnl: -(stp + SLIP_PTS), durationMs: t, mfe: mfePeak };
    }
    if (tgt != null && mfePeak >= tgt) {
      return { exit: 'target', pnl: tgt, durationMs: t, mfe: mfePeak };
    }
    // BE: bar low favorable drops to/below beOff
    if (beActive && lo <= cfg.beOff) {
      return { exit: 'be', pnl: cfg.beOff, durationMs: t, mfe: mfePeak };
    }
    // Trail: bar low drops to/below (peak - trOff)
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

/**
 * Per-rule policy. policyByRule = { ruleId: {target, stop, beTrig, beOff, trTrig, trOff, maxHoldMin, blockedHours: [hours]} }
 * Falls back to defaultPolicy if rule missing. Returns array of simulation results
 * with metadata. Trades dropped by blockedHours (or filterFn) are returned with `dropped:true`.
 */
export function simulateAll(walks, policyByRule, defaultPolicy = {}, options = {}) {
  const { filterFn = null } = options;
  const out = [];
  for (const w of walks) {
    const rule = w.ruleId;
    const cfg = { ...defaultPolicy, ...(policyByRule[rule] || {}) };
    if (filterFn && !filterFn(w, cfg)) {
      out.push({ id: w.id, tradeId: w.tradeId, ruleId: rule, side: w.side, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow, dropped: true, dropReason: 'filter' });
      continue;
    }
    if (cfg.blockedHours && cfg.blockedHours.includes(w.hourEt)) {
      out.push({ id: w.id, tradeId: w.tradeId, ruleId: rule, side: w.side, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow, dropped: true, dropReason: 'hour' });
      continue;
    }
    const r = simulate(w, cfg);
    out.push({
      id: w.id, tradeId: w.tradeId, ruleId: rule, side: w.side, fillTs: w.fillTs, hourEt: w.hourEt, dow: w.dow,
      exit: r.exit, pointsPnL: r.pnl, durationMs: r.durationMs, mfe: r.mfe, dropped: false,
    });
  }
  return out;
}

/** Compute aggregate stats from results. Drops `dropped:true` rows. */
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

/** Stats split by ruleId. */
export function statsByRule(results) {
  const buckets = {};
  for (const r of results) {
    if (r.dropped) continue;
    const k = r.ruleId || 'NONE';
    (buckets[k] = buckets[k] || []).push(r);
  }
  const out = {};
  for (const k of Object.keys(buckets)) out[k] = stats(buckets[k]);
  return out;
}

/** Stats split by hour. */
export function statsByHour(results) {
  const buckets = {};
  for (const r of results) {
    if (r.dropped) continue;
    (buckets[r.hourEt] = buckets[r.hourEt] || []).push(r);
  }
  const out = {};
  for (const k of Object.keys(buckets)) out[k] = stats(buckets[k]);
  return out;
}

// CLI mode: replay gold policy and print stats
if (import.meta.url === `file://${process.argv[1]}`) {
  const WALK_PATH = process.argv[2] || './output/01-trades-walk.json';
  console.log(`Loading ${WALK_PATH}...`);
  const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
  console.log(`Trades: ${walks.length}`);

  // Replay gold policy from rule defaults baked into walks
  const goldPolicy = {
    L_S4:      { target: 120, stop: 50, maxHoldMin: 90 },
    S_GF_SOLO: { target: 60,  stop: 50, maxHoldMin: 90 },
    S_CW:      { target: 120, stop: 50, maxHoldMin: 90, blockedHours: [14, 15] },
    S_R4:      { target: 80,  stop: 50, maxHoldMin: 60 },
  };
  const results = simulateAll(walks, goldPolicy);
  const st = stats(results);
  console.log('\n=== GOLD POLICY replay ===');
  console.log(`Trades : ${st.n}  (dropped: ${st.dropped})`);
  console.log(`PnL    : $${st.pnl.toFixed(0)}`);
  console.log(`WR     : ${st.wr.toFixed(1)}%`);
  console.log(`PF     : ${st.pf.toFixed(2)}`);
  console.log(`Sharpe : ${st.sharpe.toFixed(2)}`);
  console.log(`MaxDD  : $${st.maxDD.toFixed(0)}`);
  console.log(`avgMFE : ${st.avgMFE.toFixed(1)}pt`);
  console.log('Exits  :', st.exitReasons);
  console.log('\nBy rule:');
  const byR = statsByRule(results);
  for (const k of Object.keys(byR).sort()) {
    const b = byR[k];
    console.log(`  ${k.padEnd(12)} n=${b.n} PnL=$${b.pnl.toFixed(0).padStart(7)} WR=${b.wr.toFixed(0)}% PF=${b.pf.toFixed(2)} Sh=${b.sharpe.toFixed(2)} DD=$${b.maxDD.toFixed(0)} avgMFE=${b.avgMFE.toFixed(1)}pt`);
  }
}
