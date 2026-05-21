/**
 * Phase 2 — Market-aware exit simulator (1s-honest, per-bar OHLC).
 *
 * Layered on top of v3's per-rule (target, stop, BE, trail, maxHold) baseline.
 * Each market-aware mechanic checks at every 1s bar BEFORE the baseline
 * target/stop/BE/trail/maxHold checks — if it fires, it preempts the baseline
 * exit; otherwise the baseline runs as before.
 *
 * Mechanics:
 *
 * (1) DOUBLE_REJECTION
 *     Track running mfePeak. State machine:
 *       AT_PEAK   — price within `tolPts` of mfePeak (or new peak)
 *       PULLED   — price has retraced ≥ `pullbackMin`pt from mfePeak; awaiting
 *                  re-touch.
 *       REJECTED  — price returned to within `tolPts` of mfePeak after PULLED
 *                   state. This is "touch #2" / 2nd rejection. Trigger fires.
 *     Action on REJECTED:
 *       "close"   — exit at current close (favorable_signed).
 *       "tighten" — set BE-style floor at `mfePeak * lockFrac` (or absolute
 *                   `lockPts`). If subsequent `lo` ≤ floor, exit at floor.
 *     Gating: only arms when MFE has reached `mfeMin` (absolute pts) AND/OR
 *     `mfeFracTp` of the trade's target. Set null to disable that gate.
 *
 * (2) MFE_FRAC_TP (BE-style scaled by target)
 *     When mfePeak >= `fracTp` × targetPts, set BE floor at `lockFrac` × mfePeak.
 *     Exit if subsequent `lo` ≤ floor.
 *
 * (3) VELOCITY_REVERSAL (price-only proxy — no volume)
 *     Track time since last mfePeak update. When (a) mfePeak ≥ `mfeMin`, (b)
 *     plateau ≥ `plateauSec`, (c) a single 1s bar shows adverse move ≥
 *     `velPts` (i.e., bar's adverse extreme drops `velPts`+ vs the prior
 *     close), exit at current close.
 *
 * Walk format (from 01): [t_sec, hi_fav, lo_fav, c_fav], all favorable-positive.
 */

import fs from 'fs';

const SLIP_PTS = 0.25;
const POINT_VALUE = 20;
const COMMISSION = 5;

/**
 * Simulate one trade with v3 baseline + optional market-aware mechanics.
 *
 * cfg keys:
 *   Baseline:
 *     target, stop, beTrig, beOff, trTrig, trOff, maxHoldMin
 *   Mechanic 1 (DOUBLE_REJECTION):
 *     drEnabled (bool)
 *     drTolPts (pts, default 3)
 *     drPullbackMin (pts, default 5)
 *     drMfeMin (pts, default null) OR drMfeFracTp (frac, default null) — at least one
 *     drAction ("close" | "tighten", default "close")
 *     drLockFrac (frac, default 0.5)  -- used when action="tighten"
 *     drLockPts (pts, default null)   -- absolute floor; overrides drLockFrac
 *   Mechanic 2 (MFE_FRAC_TP):
 *     mftEnabled (bool)
 *     mftFracTp (frac, default 0.6)
 *     mftLockFrac (frac, default 0.5)
 *   Mechanic 3 (VELOCITY_REVERSAL):
 *     vrEnabled (bool)
 *     vrMfeMin (pts, default 20)
 *     vrPlateauSec (sec, default 60)
 *     vrAdversePts (pts of single-bar adverse move, default 5)
 */
export function simulate(e, cfg) {
  const tgt = cfg.target != null ? cfg.target : e.ruleTargetPts;
  const stp = cfg.stop != null ? cfg.stop : e.ruleStopPts;
  const maxHoldMs = (cfg.maxHoldMin != null ? cfg.maxHoldMin : (e.ruleMaxHoldBars || 60)) * 60_000;

  let mfePeak = 0;
  let mae = 0;
  let beActive = false, trActive = false;

  // Mechanic 1 state
  let drState = 'AT_PEAK'; // 'AT_PEAK' | 'PULLED'
  let drTouches = 0;        // count of times we re-entered AT_PEAK from PULLED
  let drFloor = null;       // set when action='tighten' fires
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

    const prevPeak = mfePeak;
    if (hi > mfePeak) {
      mfePeak = hi;
      mfePeakTs = t;
    }
    if (lo < 0 && -lo > mae) mae = -lo;

    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) beActive = true;
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;

    // ─────────────────────────────────────────────────────────────
    // Market-aware mechanics — checked BEFORE baseline exits, so they
    // can preempt with their own exit prices.
    // ─────────────────────────────────────────────────────────────

    // (1) DOUBLE_REJECTION state machine
    if (cfg.drEnabled) {
      const mfeOk =
        (cfg.drMfeMin != null && mfePeak >= cfg.drMfeMin) ||
        (cfg.drMfeFracTp != null && tgt != null && mfePeak >= cfg.drMfeFracTp * tgt);

      if (mfeOk) {
        const tol = cfg.drTolPts ?? 3;
        const pull = cfg.drPullbackMin ?? 5;

        if (drState === 'AT_PEAK') {
          // Did price retrace from peak by ≥ pull?
          // Use the bar's adverse extreme: peak - hi covers the case where this
          // bar's high is below peak; peak - lo covers the case where this bar
          // went past mfePeak into a deeper pullback.
          if (mfePeak - hi >= pull) {
            drState = 'PULLED';
          }
        } else if (drState === 'PULLED') {
          // Did price recover to within tol of mfePeak?
          if (hi >= mfePeak - tol && hi < mfePeak + tol + 0.01) {
            drTouches++;
            // 2nd touch = rejection — fire.
            const action = cfg.drAction || 'close';
            if (action === 'close') {
              return { exit: 'dr_close', pnl: c, durationMs: t, mfe: mfePeak };
            } else {
              // 'tighten' — set a floor below the current MFE peak
              const floor = cfg.drLockPts != null
                ? cfg.drLockPts
                : (cfg.drLockFrac ?? 0.5) * mfePeak;
              drFloor = floor;
              drState = 'AT_PEAK'; // reset; if it retraces below floor, we exit
            }
          } else if (hi > mfePeak) {
            // New high broke past peak, reset to AT_PEAK
            drState = 'AT_PEAK';
          }
        }
      }

      // Check drFloor (if 'tighten' fired earlier)
      if (drFloor != null && lo <= drFloor) {
        return { exit: 'dr_tightened', pnl: drFloor - SLIP_PTS, durationMs: t, mfe: mfePeak };
      }
    }

    // (2) MFE_FRAC_TP BE-style
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
      // Single-bar adverse move: prev close → this lo. Both are favorable-signed,
      // so a drop is c[i-1] - lo[i] in favorable space.
      const advMove = prevClose - lo;
      if (mfeOk && plateauOk && advMove >= (cfg.vrAdversePts ?? 5)) {
        return { exit: 'vr_close', pnl: c, durationMs: t, mfe: mfePeak };
      }
    }
    prevClose = c;

    // ─────────────────────────────────────────────────────────────
    // Baseline exits
    // ─────────────────────────────────────────────────────────────
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

// v3 baseline policy (mirrors backtest-engine/src/cli.js GLX_PRESETS.v3)
export const V3_POLICY = {
  L_S4:      { target: 100, stop: 70, maxHoldMin: 120, beTrig: 70, beOff: 20 },
  S_GF_SOLO: { target: 180, stop: 70, maxHoldMin: 120, beTrig: 80, beOff: 20 },
  S_CW:      { target: 200, stop: 70, maxHoldMin: 120, beTrig: 80, beOff: 20 },
  S_R4:      { target: 80,  stop: 40, maxHoldMin: 60,  trTrig: 70, trOff: 25 },
};

export function simulateAll(walks, baseByRule, mawConfig = {}) {
  const out = [];
  for (const w of walks) {
    const base = baseByRule[w.ruleId];
    if (!base) {
      out.push({ id: w.id, tradeId: w.tradeId, ruleId: w.ruleId, side: w.side, fillTs: w.fillTs, dropped: true, dropReason: 'no_rule' });
      continue;
    }
    const cfg = { ...base, ...mawConfig };
    const r = simulate(w, cfg);
    out.push({
      id: w.id, tradeId: w.tradeId, ruleId: w.ruleId, side: w.side, fillTs: w.fillTs,
      exit: r.exit, pointsPnL: r.pnl, durationMs: r.durationMs, mfe: r.mfe, dropped: false,
      v3PointsPnL: w.v3PointsPnL, v3NetPnL: w.v3NetPnL, v3ExitReason: w.v3ExitReason,
    });
  }
  return out;
}

export function stats(results) {
  const taken = results.filter(r => !r.dropped);
  let pnl = 0, wins = 0, losses = 0, sumW = 0, sumL = 0;
  const equity = []; let cum = 0;
  const exitReasons = {};
  for (const r of taken) {
    const d = r.pointsPnL * POINT_VALUE - COMMISSION;
    pnl += d; cum += d; equity.push(cum);
    if (d > 0) { wins++; sumW += d; }
    else if (d < 0) { losses++; sumL += d; }
    exitReasons[r.exit] = (exitReasons[r.exit] || 0) + 1;
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
  return {
    n, pnl, wins, losses, wr, pf, maxDD,
    sharpe: perT * Math.sqrt(tradesPerYear), exitReasons,
  };
}

// CLI: replay v3 baseline (no mechanics) and verify it matches engine v3
if (import.meta.url === `file://${process.argv[1]}`) {
  const WALK_PATH = process.argv[2] || './output/01-trades-walk-v3.json';
  console.log(`Loading ${WALK_PATH}...`);
  const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
  console.log(`Trades: ${walks.length}`);

  console.log('\n=== V3 BASELINE replay (no market-aware) ===');
  const results = simulateAll(walks, V3_POLICY, {});
  const st = stats(results);
  console.log(`Trades : ${st.n}`);
  console.log(`PnL    : $${st.pnl.toFixed(0)}`);
  console.log(`WR     : ${st.wr.toFixed(1)}%`);
  console.log(`PF     : ${st.pf.toFixed(2)}`);
  console.log(`Sharpe : ${st.sharpe.toFixed(2)}`);
  console.log(`MaxDD  : $${st.maxDD.toFixed(0)}`);
  console.log(`Exits  :`, st.exitReasons);
  console.log(`\nEngine v3: 553 trades / $217,864 / WR 60% / PF 1.90 / Sharpe 8.73 / MaxDD 5.56%`);
}
