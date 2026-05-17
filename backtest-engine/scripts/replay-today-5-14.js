#!/usr/bin/env node
/**
 * Replay today's (2026-05-14) five gex-flip-ivpct signals through any number
 * of MFE-ratchet tier configurations and report the simulated day P&L.
 *
 * We can do this analytically (no OHLCV needed) because:
 *   - Each ratchet stop is a deterministic function of peak MFE and the tiers.
 *   - User provided per-trade MFE peaks and post-MFE direction:
 *       T1: short 29665.5, MFE 138.75 @ 09:59, rallied to 29725.5 @ 10:50  → BE/ratchet exit on rally
 *       T2: short 29677.5, MFE ~10, SL 29737.5 @ 11:14                     → -60 (SL)
 *       T3: short 29733,   MFE 138   @ 13:26, returned to entry @ 13:46    → BE/ratchet exit on rally
 *       T4: short 29754.75 @ 11:55                                          → blocked by T3 open
 *       T5: short 29731.75 @ 12:50                                          → blocked by T3 open
 *
 * Under "flat-then-reenter", a new same-side signal is blocked while a position
 * is open. T3 fired at 11:15 and exits no earlier than 13:26 under any ratchet
 * config (stop trails the low water mark, exit comes after the MFE peak), so
 * T4 (11:55) and T5 (12:50) are always blocked under any ratchet variant.
 *
 * Default tiers (engine fallback when --mfe-ratchet is on but no custom tiers):
 *   [{minMFE:100,lockPct:0.60}, {minMFE:60,lockPct:0.50},
 *    {minMFE:40,lockPct:0.40},  {minMFE:20,lockPct:0.25}]
 */

import fs from 'fs';
import path from 'path';

const OUT_DIR = path.resolve(new URL('.', import.meta.url).pathname, '..', 'research', 'mfe-ratchet-gfi');
const OUT_PATH = path.join(OUT_DIR, 'today-replay.md');

const trades = [
  { id: 'T1', time: '09:50', side: 'short', entry: 29665.5, mfePts: 138.75, postMFE: 'rallied through original SL' },
  { id: 'T2', time: '10:40', side: 'short', entry: 29677.5, mfePts: 10,     postMFE: 'hit original SL' },
  { id: 'T3', time: '11:15', side: 'short', entry: 29733,   mfePts: 138,    postMFE: 'rallied back to entry' },
  { id: 'T4', time: '11:55', side: 'short', entry: 29754.75, blocked: true, blockedBy: 'T3 still open' },
  { id: 'T5', time: '12:50', side: 'short', entry: 29731.75, blocked: true, blockedBy: 'T3 still open' },
];

// Drew's listed active 1m 9/9 swing lows from the screenshot, by entry time.
// Both T1 (09:50) and T3 (11:15) had the same set of magnets visible in their
// profit regions: 29664, 29595.25, 29533. Used by the structural-magnet replay.
const TODAY_MAGNETS_SHORT = {
  T1: [29664, 29595.25, 29533],
  T3: [29664, 29595.25, 29533],
};

const ORIG_SL = 60;    // pts adverse
const ORIG_TP = 200;   // pts favorable
const PT_VALUE_NQ = 20;

// Parse "minMFE:lockPct,..." into a sorted (highest-first) tier list.
function parseTiers(str) {
  return str.split(',').map(s => s.trim()).map(t => {
    const [m, l] = t.split(':').map(Number);
    return { minMFE: m, lockPct: l };
  }).sort((a, b) => b.minMFE - a.minMFE);
}

// Compute ratchet stop AT THE PEAK MFE for a trade. Engine evaluates tiers
// highest-first and uses the lockPct of the highest tier whose minMFE is
// reached. The stop is entry - mfePeak * lockPct (for shorts; symmetric long).
function ratchetStopAtPeak(entry, mfePts, side, tiers) {
  let lockPct = 0;
  for (const t of tiers) {
    if (mfePts >= t.minMFE) {
      lockPct = t.lockPct;
      break;
    }
  }
  if (lockPct === 0) return null; // ratchet never engages
  const locked = mfePts * lockPct;
  return side === 'short' ? entry - locked : entry + locked;
}

function simulateTrade(trade, tiers) {
  if (trade.blocked) return { id: trade.id, exitPts: 0, pnlDollars: 0, exitReason: `blocked (${trade.blockedBy})` };

  // Special case: MFE peak < lowest tier minMFE → ratchet never engages, original SL holds
  const stop = ratchetStopAtPeak(trade.entry, trade.mfePts, trade.side, tiers);

  // T2-like case: small MFE, original SL hit. Determined by trade.postMFE.
  if (trade.postMFE.includes('hit original SL')) {
    return { id: trade.id, exitPts: -ORIG_SL, pnlDollars: -ORIG_SL * PT_VALUE_NQ, exitReason: 'original SL (ratchet never engaged)' };
  }

  // For T1, T3: ratchet engaged. Stop is somewhere between entry and the favorable extreme.
  // After MFE peak, price rallied. Three outcomes possible in order:
  //   (a) Ratchet stop is BELOW the favorable extreme (price would not return
  //       there at all) and is also below the realized post-MFE level → ratchet exits.
  //   (b) Ratchet stop is ABOVE the original SL → impossible by construction
  //       (lockPct <= 1 keeps stop on the favorable side of entry for partial lock,
  //        but a 100% lock could exceed entry; clamp).
  //   (c) MFE peak doesn't engage any tier → original SL fires (handled above).
  // Under our config space (lockPct <= 0.70, mfePts > minMFE), the ratchet
  // stop is always inside the [entry, MFE-extreme] band, so the trade exits
  // at the ratchet stop on the rally.
  if (stop === null) {
    // Ratchet didn't engage but trade is winning per the user's narrative — shouldn't happen.
    return { id: trade.id, exitPts: 0, pnlDollars: 0, exitReason: 'ratchet did not engage (unexpected for winning trade)' };
  }
  const exitPts = trade.side === 'short' ? trade.entry - stop : stop - trade.entry;
  return {
    id: trade.id,
    exitPts: Math.round(exitPts * 100) / 100,
    pnlDollars: Math.round(exitPts * PT_VALUE_NQ * 100) / 100,
    exitReason: `ratchet @ MFE peak (${trade.mfePts}pt) locked ${Math.round((exitPts / trade.mfePts) * 100)}%`,
  };
}

function simulateDay(label, tiers) {
  const perTrade = trades.map(t => simulateTrade(t, tiers));
  const totalPts = perTrade.reduce((s, x) => s + x.exitPts, 0);
  const totalDollars = perTrade.reduce((s, x) => s + x.pnlDollars, 0);
  return { label, tiers: tiers.map(t => `${t.minMFE}:${t.lockPct}`).join(','), perTrade, totalPts, totalDollars };
}

// Structural-magnet replay: per-trade tiers built from the trade's profit-region
// swing lows (using TODAY_MAGNETS_SHORT). Each magnet → tier with the same lockPct.
function simulateDayWithMagnets(label, lockPct) {
  const perTrade = trades.map(t => {
    if (t.blocked) return { id: t.id, exitPts: 0, pnlDollars: 0, exitReason: `blocked (${t.blockedBy})` };
    if (t.postMFE.includes('hit original SL')) {
      return { id: t.id, exitPts: -ORIG_SL, pnlDollars: -ORIG_SL * PT_VALUE_NQ, exitReason: 'original SL (no magnet touched, MFE too small)' };
    }
    const magnets = TODAY_MAGNETS_SHORT[t.id] || [];
    // Filter to profit region for short: entry - TP <= magnet < entry
    const inRegion = magnets.filter(m => m > t.entry - ORIG_TP && m < t.entry);
    if (inRegion.length === 0) {
      // No magnets → rides original SL (per v1 design — no fallback)
      return { id: t.id, exitPts: -ORIG_SL, pnlDollars: -ORIG_SL * PT_VALUE_NQ, exitReason: 'no magnets in profit region — original SL' };
    }
    // Tiers: each magnet → minMFE = entry − magnet
    const tiers = inRegion.map(m => ({ minMFE: t.entry - m, lockPct })).sort((a, b) => b.minMFE - a.minMFE);
    const tieredLock = ratchetStopAtPeak(t.entry, t.mfePts, t.side, tiers);
    const exitPts = t.entry - tieredLock;
    return {
      id: t.id,
      exitPts: Math.round(exitPts * 100) / 100,
      pnlDollars: Math.round(exitPts * PT_VALUE_NQ * 100) / 100,
      exitReason: `magnet ratchet (highest tier MFE>=${tiers.find(tier => t.mfePts >= tier.minMFE)?.minMFE.toFixed(1)}, lock ${(lockPct * 100).toFixed(0)}%)`,
    };
  });
  const totalPts = perTrade.reduce((s, x) => s + x.exitPts, 0);
  const totalDollars = perTrade.reduce((s, x) => s + x.pnlDollars, 0);
  return { label, tiers: `magnets@${lockPct}`, perTrade, totalPts, totalDollars };
}

// --- Load top-3 candidates --------------------------------------------------

const candidatesPath = path.join(OUT_DIR, 'top-candidates-for-replay.json');
const ENGINE_DEFAULT_TIERS = '100:0.6,60:0.5,40:0.4,20:0.25';
const replayConfigs = [
  { id: 'engine-default', tiers: ENGINE_DEFAULT_TIERS, source: 'engine-default-reference' },
];
if (fs.existsSync(candidatesPath)) {
  const top = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
  replayConfigs.push(...top);
} else {
  console.warn(`No ${candidatesPath} yet — running engine-default + a few hand-picked options.`);
  replayConfigs.push(
    { id: 'single-70-0.50', tiers: '70:0.50', source: 'hand-picked' },
    { id: 'single-50-0.50', tiers: '50:0.50', source: 'hand-picked' },
    { id: 'single-100-0.60', tiers: '100:0.60', source: 'hand-picked' },
    { id: 'two-150-0.70-70-0.50', tiers: '150:0.70,70:0.50', source: 'hand-picked' },
    { id: 'two-120-0.60-50-0.40', tiers: '120:0.60,50:0.40', source: 'hand-picked' },
  );
}

// --- Render ----------------------------------------------------------------

const baseline = {
  label: 'Live config: BE 70 / +5',
  perTrade: [
    { id: 'T1', exitPts: 5,   pnlDollars: 100,  exitReason: 'BE clip on rally (MFE 138.75)' },
    { id: 'T2', exitPts: -60, pnlDollars: -1200, exitReason: 'original SL' },
    { id: 'T3', exitPts: 5,   pnlDollars: 100,  exitReason: 'BE clip on rally (MFE 138)' },
    { id: 'T4', exitPts: 0,   pnlDollars: 0,    exitReason: 'blocked (T3 open)' },
    { id: 'T5', exitPts: 0,   pnlDollars: 0,    exitReason: 'blocked (T3 open)' },
  ],
  totalPts: -50,
  totalDollars: -1000,
};

const simulations = replayConfigs.map(c => simulateDay(c.id, parseTiers(c.tiers)));

// Append structural-magnet variants at the user-chosen 75% lock and a couple
// of bracket lock %'s for comparison.
const magnetSims = [
  simulateDayWithMagnets('magnet-ratchet-75pct', 0.75),
  simulateDayWithMagnets('magnet-ratchet-65pct', 0.65),
  simulateDayWithMagnets('magnet-ratchet-85pct', 0.85),
];

const lines = [
  '# Today Replay (2026-05-14) under MFE Ratchet Configurations',
  '',
  'Drew\'s five gex-flip-ivpct signals from today, replayed under each candidate config.',
  'T4 and T5 are blocked under flat-then-reenter (T3 is open the entire time).',
  '',
  '## Baseline: live config BE 70 / +5',
  '',
  '| Trade | Entry | MFE | Exit pts | $ NQ | Reason |',
  '|---|---:|---:|---:|---:|---|',
  ...baseline.perTrade.map((p, i) => `| ${p.id} (${trades[i].time}) | ${trades[i].entry} | ${trades[i].mfePts ?? '—'} | ${p.exitPts} | $${p.pnlDollars} | ${p.exitReason} |`),
  `| **TOTAL** |  |  | **${baseline.totalPts}** | **$${baseline.totalDollars}** |  |`,
  '',
];

// Magnet section first since it's the headline mechanic
lines.push('## Structural-magnet ratchet (new mechanic)');
lines.push('');
lines.push('Tiers are built per-trade from the visible 1m 9/9 swing lows in the profit region:');
lines.push('- T1 entry 29665.5: magnets 29664, 29595.25, 29533 (29664 has MFE=1.5, 29533 below TP)');
lines.push('- T3 entry 29733.0: magnets 29664 (MFE 69), 29595.25 (MFE 137.75), 29533 (MFE 200, ≥ TP, excluded)');
lines.push('');
for (const sim of magnetSims) {
  lines.push(`### Config: \`${sim.label}\``);
  lines.push('');
  lines.push('| Trade | Entry | MFE | Exit pts | $ NQ | Reason |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (let i = 0; i < sim.perTrade.length; i++) {
    const p = sim.perTrade[i];
    const t = trades[i];
    lines.push(`| ${p.id} (${t.time}) | ${t.entry} | ${t.mfePts ?? '—'} | ${p.exitPts} | $${p.pnlDollars} | ${p.exitReason} |`);
  }
  const dollarDelta = sim.totalDollars - baseline.totalDollars;
  const ptDelta = sim.totalPts - baseline.totalPts;
  lines.push(`| **TOTAL** |  |  | **${sim.totalPts.toFixed(1)}** | **$${sim.totalDollars.toFixed(0)}** | Δ vs baseline: ${ptDelta >= 0 ? '+' : ''}${ptDelta.toFixed(1)}pt / ${dollarDelta >= 0 ? '+' : ''}$${dollarDelta.toFixed(0)} |`);
  lines.push('');
}

lines.push('## Pure-MFE ratchet variants (from earlier sweep)');
lines.push('');
for (const sim of simulations) {
  lines.push(`### Config: \`${sim.label}\` — tiers \`${sim.tiers}\``);
  lines.push('');
  lines.push('| Trade | Entry | MFE | Exit pts | $ NQ | Reason |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (let i = 0; i < sim.perTrade.length; i++) {
    const p = sim.perTrade[i];
    const t = trades[i];
    lines.push(`| ${p.id} (${t.time}) | ${t.entry} | ${t.mfePts ?? '—'} | ${p.exitPts} | $${p.pnlDollars} | ${p.exitReason} |`);
  }
  const dollarDelta = sim.totalDollars - baseline.totalDollars;
  const ptDelta = sim.totalPts - baseline.totalPts;
  lines.push(`| **TOTAL** |  |  | **${sim.totalPts.toFixed(1)}** | **$${sim.totalDollars.toFixed(0)}** | Δ vs baseline: ${ptDelta >= 0 ? '+' : ''}${ptDelta.toFixed(1)}pt / ${dollarDelta >= 0 ? '+' : ''}$${dollarDelta.toFixed(0)} |`);
  lines.push('');
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_PATH, lines.join('\n'));
console.log(`Wrote ${OUT_PATH}`);
