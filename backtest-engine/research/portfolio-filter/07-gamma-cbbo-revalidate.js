#!/usr/bin/env node
/**
 * Portfolio-filter step 07 — rebuild gamma context from nq-cbbo (full period, intraday as-of)
 * and re-validate the OOS-confirmed small-account filter on Feb-Apr 2026 = TRUE FUTURE HOLDOUT
 * (those months were absent from the stale daily CSV; the filter rules were chosen without them).
 *
 * Winning filter is gamma-only (drop shorts in +gamma + drop level-fade in -gamma), so LT is not
 * needed here. Gamma = sign(total_gex) from nq-cbbo 15-min snapshots (already lookahead-relabeled),
 * joined as-of (most recent snapshot with ts <= signal entry).
 *
 * node research/portfolio-filter/07-gamma-cbbo-revalidate.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics, fmtUsd, round } from '../multi-strategy-rules/lib/metrics.js';
import { evaluateGammaFilter } from '../../../shared/filters/gamma-filter.js';   // SAME module the live orchestrator uses → parity
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const STRATEGIES = [
  { key: 'lstb', file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m', file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];
const normSide = s => { const l = String(s ?? '').toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : (l === 'short' || l === 'sell') ? 'short' : null; };

// ── intraday gamma from nq-cbbo (as-of regime = sign of total_gex) ──
const dir = path.join(ROOT, 'data/gex/nq-cbbo');
const snaps = [];
for (const fn of fs.readdirSync(dir).filter(f => /nq_gex_\d{4}-\d{2}-\d{2}\.json/.test(f))) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8')); } catch { continue; }
  for (const s of (j.data || [])) { const ts = new Date(s.timestamp).getTime(); if (isNaN(ts) || s.total_gex == null) continue; snaps.push({ ts, reg: s.total_gex >= 0 ? 'positive' : 'negative' }); }
}
snaps.sort((a, b) => a.ts - b.ts);
const sTs = snaps.map(x => x.ts);
const gammaAt = t => { let lo = 0, hi = sTs.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (sTs[m] <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? snaps[a].reg : null; };
console.log(`nq-cbbo snapshots: ${snaps.length.toLocaleString()}  (${new Date(sTs[0]).toISOString().slice(0,10)} → ${new Date(sTs[sTs.length-1]).toISOString().slice(0,10)})`);

// ── pool (full period) with as-of gamma ──
const pool = [];
let cov = 0;
for (const def of STRATEGIES) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  for (const t of j.trades) {
    if (t.status !== 'completed' || t.entryTime == null || t.exitTime == null || !normSide(t.side)) continue;
    const entryTime = t.entryTime, exitTime = t.exitTime <= entryTime ? entryTime + 1 : t.exitTime;
    const gamma = gammaAt(entryTime); if (gamma) cov++;
    pool.push({ id: `${def.key}:${t.id}`, nativeId: t.id, strategyKey: def.key, side: normSide(t.side), entryTime, exitTime, netPnL: t.netPnL, pointsPnL: t.pointsPnL, exitReason: t.exitReason, gamma });
  }
}
pool.sort((a, b) => a.entryTime - b.entryTime);
console.log(`pool ${pool.length} signals, gamma coverage ${cov} (${(100*cov/pool.length).toFixed(1)}%)\n`);

const fiw = { name: 'fiw', onSignal(s, t) { if (s.position == null) open(s, t); else reject(s); }, onNativeExit(s, t) { if (s.position && s.position.trade.id === t.id) realizeNativeClose(s, t); } };
// Use the SHARED live filter module (one source of truth: backtest == production).
const STRAT_CONST = { 'gex-level-fade': 'GEX_LEVEL_FADE', lstb: 'LS_FLIP_TRIGGER_BAR', 'gex-lt-3m': 'GEX_LT_3M_CROSSOVER', 'gex-flip-ivpct': 'GEX_FLIP_IVPCT' };
const GCFG = { enabled: true, blockShortsInPositive: true, blockFadeInNegative: true };
const FILTER = t => !evaluateGammaFilter({ strategy: STRAT_CONST[t.strategyKey], side: t.side, action: 'place_limit' }, t.gamma, GCFG).allowed;

function extra(tr) { const L = tr.filter(t => t.netPnL <= 0); let st = 0, mx = 0; for (const t of [...tr].sort((a, b) => a.exitTime - b.exitTime)) { if (t.netPnL <= 0) { st++; mx = Math.max(mx, st); } else st = 0; } return { nLosers: L.length, maxStreak: mx }; }
function metr(realized, lo, hi) { const tr = realized.filter(t => (lo == null || t.entryTime >= lo) && (hi == null || t.entryTime < hi)); const m = calculateMetrics(tr); const e = extra(tr); return { ...m, ...e, n: tr.length }; }
function rowFor(label, realized, lo, hi) { const r = metr(realized, lo, hi); console.log(`  ${label.padEnd(22)} trades ${String(r.n).padStart(4)}  WR ${round(r.winRate,1).toString().padStart(5)}%  PF ${round(r.profitFactor,2)}  Sharpe ${round(r.sharpe,2).toString().padStart(6)}  DD ${round(r.maxDD_pct,2).toString().padStart(5)}%  losers ${String(r.nLosers).padStart(4)}  PnL ${fmtUsd(r.totalPnL)}`); return r; }

const HOLD = new Date('2026-02-01').getTime();   // true future holdout = Feb-Apr 2026 (was uncovered)
const baseRT = simulate(pool, fiw).realizedTrades;
const filtRT = simulate(pool.filter(t => !FILTER(t)), fiw).realizedTrades;

console.log('═══ FULL PERIOD 2025-01 → 2026-04 (gamma now full via nq-cbbo) ═══');
console.log(' baseline:'); rowFor('full', baseRT, null, null);
console.log(' filtered (drop shorts in +γ + level-fade in -γ):'); rowFor('full', filtRT, null, null);

console.log('\n═══ TRAIN 2025-01 → 2026-01 (was context-covered) ═══');
console.log(' baseline:'); rowFor('train', baseRT, null, HOLD);
console.log(' filtered:'); rowFor('train', filtRT, null, HOLD);

console.log('\n═══ TRUE FUTURE HOLDOUT: Feb-Apr 2026 (never seen when rules were chosen) ═══');
console.log(' baseline:'); const bh = rowFor('holdout', baseRT, HOLD, null);
console.log(' filtered:'); const fh = rowFor('holdout', filtRT, HOLD, null);
console.log(`\n  HOLDOUT verdict: WR ${round(bh.winRate,1)}→${round(fh.winRate,1)}%  DD ${round(bh.maxDD_pct,2)}→${round(fh.maxDD_pct,2)}%  losers ${bh.nLosers}→${fh.nLosers}  PnL ${fmtUsd(bh.totalPnL)}→${fmtUsd(fh.totalPnL)}`);
console.log('  If WR↑ and DD↓ on this unseen window, the filter generalizes to genuinely future data.');
