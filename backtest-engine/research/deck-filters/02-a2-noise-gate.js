/**
 * THREAD A2 — Stop-vs-realized-vol "noise band" gate.
 *
 * Deck: `volregime` ("your stop didn't move, the range did"). A fixed point-stop is safe in a calm
 * regime and pure noise-bait in a storm. Feature: stopAtr = stopPts / atrNq (NQ 1m ATR-14 at entry).
 * Low stopAtr => the stop sits inside the current noise band => should be noise-stopped before the move.
 *
 * Scope note: from the realized trade log we can only test the SKIP arm (drop low-stopAtr trades).
 * The "widen the stop in high vol" arm would require re-backtesting each strategy with a vol-scaled
 * stop (exits are baked into the log) — out of scope here; flagged in SUMMARY if skip shows an edge.
 *
 * Usage: node research/deck-filters/02-a2-noise-gate.js
 */
import { loadAnnotated } from './lib/annotate.js';
import { runBook, report, verdict, fmtM } from './lib/engine.js';

const ALL = loadAnnotated();
const STRATS = ['lstb', 'gex-level-fade', 'gex-flip-ivpct', 'gex-lt-3m'];

// ---- diagnostic: per-strategy stopAtr quintiles → WR / PF / avgPnL ----
console.log('═══ stopAtr diagnostic (does a tight stop-vs-noise ratio predict losses?) ═══');
const pf = ts => { const w = ts.filter(t => t.netPnL > 0).reduce((s, t) => s + t.netPnL, 0), l = Math.abs(ts.filter(t => t.netPnL <= 0).reduce((s, t) => s + t.netPnL, 0)); return l ? w / l : Infinity; };
const qThresholds = {};
for (const k of STRATS) {
  const ts = ALL.filter(t => t.strategyKey === k && t.stopAtr != null).sort((a, b) => a.stopAtr - b.stopAtr);
  const n = ts.length, q = i => ts[Math.floor(i * n / 5)]?.stopAtr;
  const meanStop = ts[0]?.stopPts, atrMean = (ts.reduce((s, t) => s + t.atrNq, 0) / n).toFixed(1);
  console.log(`\n  ${k}  (stop≈${meanStop}pt, mean ATR ${atrMean}pt, n=${n})`);
  console.log('    quintile      stopAtr-range        n     WR%     PF    avg$    total$');
  qThresholds[k] = [];
  for (let i = 0; i < 5; i++) {
    const b = ts.slice(Math.floor(i * n / 5), Math.floor((i + 1) * n / 5));
    const wr = 100 * b.filter(t => t.netPnL > 0).length / b.length;
    const tot = b.reduce((s, t) => s + t.netPnL, 0);
    console.log(`    Q${i + 1} [${(i * 20)}-${(i + 1) * 20}%]  ${b[0].stopAtr.toFixed(2)}–${b[b.length - 1].stopAtr.toFixed(2)}`.padEnd(38) + `${b.length}`.padStart(5) + `${wr.toFixed(0)}`.padStart(8) + `${pf(b).toFixed(2)}`.padStart(7) + `$${Math.round(tot / b.length)}`.padStart(8) + `$${Math.round(tot).toLocaleString()}`.padStart(11));
    if (i === 0) qThresholds[k] = q(1); // Q1 upper edge = skip-below threshold candidate
  }
}

// ---- gate: skip per-strategy lowest-stopAtr trades, sweep threshold as a quantile ----
const base = runBook(ALL, () => 1);
report('\n═══ BASELINE ═══', base);

// per-strategy quantile thresholds
function pctThresh(k, p) { const ts = ALL.filter(t => t.strategyKey === k && t.stopAtr != null).map(t => t.stopAtr).sort((a, b) => a - b); return ts[Math.floor(p * ts.length)]; }

console.log('\n═══ A2 GATE: skip trades with stopAtr below per-strategy quantile ═══');
const results = [];
for (const p of [0.1, 0.2, 0.3, 0.4]) {
  const thr = {}; for (const k of STRATS) thr[k] = pctThresh(k, p);
  const decide = (k, t) => (t.stopAtr != null && t.stopAtr < thr[k]) ? 0 : 1;
  const r = runBook(ALL, decide); const v = verdict(base, r);
  results.push({ label: `skip bottom-${(p * 100).toFixed(0)}% stopAtr`, r, v });
  console.log(`\n── skip bottom ${(p * 100).toFixed(0)}% stopAtr per strategy ──`);
  console.log(`  full:  ${fmtM(r.full)}`);
  console.log(`  test:  ${fmtM(r.test)}   quarters PF: ${r.quarters.map(([n, m]) => m.profitFactor.toFixed(2)).join(' ')}`);
  console.log(`  verdict: ${v.yes ? 'YES ✓' : 'no'}  [pfUp=${v.pfUp} shUp=${v.shUp} ddOk=${v.ddOk} oosPF=${v.oosPF}]`);
}

// lstb-only gate (its stop is tightest vs noise → deck effect should be strongest here)
console.log('\n═══ A2 GATE (lstb-only, tightest stop): skip low stopAtr lstb trades ═══');
for (const p of [0.2, 0.3, 0.4]) {
  const thr = pctThresh('lstb', p);
  const decide = (k, t) => (k === 'lstb' && t.stopAtr != null && t.stopAtr < thr) ? 0 : 1;
  const r = runBook(ALL, decide); const v = verdict(base, r);
  results.push({ label: `lstb skip bottom-${(p * 100).toFixed(0)}% stopAtr`, r, v });
  console.log(`  lstb skip bottom ${(p * 100).toFixed(0)}%:  ${fmtM(r.full)}  | test PF ${r.test.profitFactor.toFixed(2)} | ${v.yes ? 'YES ✓' : 'no'} [pf=${v.pfUp} sh=${v.shUp} dd=${v.ddOk} oos=${v.oosPF}]`);
}

console.log('\n═══ A2 SUMMARY ═══');
console.log('config'.padEnd(34), 'PnL'.padStart(10), 'PF'.padStart(6), 'Sh'.padStart(6), 'DD'.padStart(9), 'testPF'.padStart(7), ' verdict');
console.log('baseline'.padEnd(34), `$${Math.round(base.full.totalPnL).toLocaleString()}`.padStart(10), base.full.profitFactor.toFixed(2).padStart(6), base.full.sharpe.toFixed(1).padStart(6), `$${Math.round(base.full.ddDollar).toLocaleString()}`.padStart(9), base.test.profitFactor.toFixed(2).padStart(7));
for (const { label, r, v } of results) console.log(label.padEnd(34), `$${Math.round(r.full.totalPnL).toLocaleString()}`.padStart(10), r.full.profitFactor.toFixed(2).padStart(6), r.full.sharpe.toFixed(1).padStart(6), `$${Math.round(r.full.ddDollar).toLocaleString()}`.padStart(9), r.test.profitFactor.toFixed(2).padStart(7), v.yes ? '  YES ✓' : '');
