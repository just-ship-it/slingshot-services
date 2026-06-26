/**
 * THREAD A1 — Vol-regime sizing ladder (skip / 1x / 2x...) on the 4-strat FCFS book.
 *
 * From `volregime` deck ("constant risk not constant size", "size is a staircase") + the validated
 * binary vol-regime gate (research/vix-vol-es, per_strat_robust: $522,895 / PF 2.11 — CUTS PnL to
 * raise PF). Question A1 asks: does turning that binary gate into a 3-state SIZING ladder (lever up
 * favorable-regime trades instead of only skipping unfavorable ones) beat the baseline on a
 * PF-over-PnL basis — and does it add anything over just gating?
 *
 * Regime state per strategy (from the validated robust gates; null core feature => neutral):
 *   lstb           fav: ivPct>=.5 && ivChg>0   (high & rising vol)
 *   gex-level-fade fav: ivChg<0                 (falling vol)
 *   gex-flip-ivpct fav: ivPct>=.5               (elevated vol)
 *   gex-lt-3m      no robust vol edge -> always neutral (1x)
 *
 * Usage: node research/deck-filters/01-a1-sizing-ladder.js
 */
import { loadAnnotated } from './lib/annotate.js';
import { runBook, report, verdict, fmtM } from './lib/engine.js';

const ALL = loadAnnotated();

// regimeState: 'fav' | 'unfav' | 'neutral'
function regimeState(k, t) {
  if (k === 'lstb') { if (t.ivPct == null) return 'neutral'; return (t.ivPct >= 0.5 && t.ivChg > 0) ? 'fav' : 'unfav'; }
  if (k === 'gex-level-fade') { if (t.ivChg == null) return 'neutral'; return t.ivChg < 0 ? 'fav' : 'unfav'; }
  if (k === 'gex-flip-ivpct') { if (t.ivPct == null) return 'neutral'; return t.ivPct >= 0.5 ? 'fav' : 'unfav'; }
  return 'neutral'; // glx
}

// A ladder maps {fav,unfav,neutral} -> multiplier. neutral always 1x (can't read regime).
const mkDecide = (favM, unfavM) => (k, t) => {
  const s = regimeState(k, t);
  return s === 'fav' ? favM : s === 'unfav' ? unfavM : 1;
};

const base = runBook(ALL, () => 1);
report('═══ BASELINE ═══', base);

const CONFIGS = [
  ['GATE  (skip unfav, 1x else)     [control = binary gate]', mkDecide(1, 0)],
  ['LEVER1.5 (1.5x fav, 1x else, no skip)', mkDecide(1.5, 1)],
  ['LEVER2  (2x fav, 1x else, no skip)', mkDecide(2, 1)],
  ['LEVER3  (3x fav, 1x else, no skip)', mkDecide(3, 1)],
  ['SKIP+LEVER1.5 (1.5x fav, skip unfav)', mkDecide(1.5, 0)],
  ['SKIP+LEVER2  (2x fav, skip unfav)', mkDecide(2, 0)],
  ['SKIP+LEVER3  (3x fav, skip unfav)', mkDecide(3, 0)],
  ['DOWNSIZE (1x fav, 0.5x unfav, no skip)', mkDecide(1, 0.5)],
  // targeted: lever ONLY the low-variance high-Sharpe strategy (lstb), to test if that lifts
  // portfolio Sharpe where uniform/lumpy levering can't.
  ['LEVER-LSTB2 (2x lstb-fav only, 1x else)', (k, t) => (k === 'lstb' && regimeState(k, t) === 'fav') ? 2 : 1],
  ['LEVER-LSTB3 (3x lstb-fav only, 1x else)', (k, t) => (k === 'lstb' && regimeState(k, t) === 'fav') ? 3 : 1],
  ['LSTB2 + DOWNSIZE-lumpy-unfav', (k, t) => { const s = regimeState(k, t); if (k === 'lstb') return s === 'fav' ? 2 : 1; return s === 'unfav' ? 0.5 : 1; }],
  // CONTROLS: lever ALL lstb regardless of regime — is the edge the REGIME or just "more lstb"?
  ['CTRL LEVER-ALL-LSTB2 (2x every lstb)', (k) => k === 'lstb' ? 2 : 1],
  ['CTRL LEVER-ALL-LSTB3 (3x every lstb)', (k) => k === 'lstb' ? 3 : 1],
];

const results = [];
for (const [label, decide] of CONFIGS) {
  const r = runBook(ALL, decide);
  const v = verdict(base, r);
  results.push({ label, r, v });
  console.log(`\n── ${label} ──`);
  console.log(`  full:  ${fmtM(r.full)}`);
  console.log(`  test:  ${fmtM(r.test)}   quarters PF: ${r.quarters.map(([n, m]) => m.profitFactor.toFixed(2)).join(' ')}`);
  console.log(`  verdict vs baseline: ${v.yes ? 'YES ✓' : 'no'}  [pfUp=${v.pfUp} shUp=${v.shUp} ddOk=${v.ddOk} oosPF=${v.oosPF}]`);
}

// ── summary table ──
console.log('\n\n═══════════ A1 SUMMARY (vs baseline $614,730 / PF 1.77 / Sh 10.8 / DD $11,642) ═══════════');
console.log('config'.padEnd(42), 'PnL'.padStart(10), 'PF'.padStart(6), 'Sh'.padStart(6), 'DD'.padStart(9), 'testPF'.padStart(7), '  verdict');
const row = (lbl, m, tPF, y) => console.log(lbl.padEnd(42), `$${Math.round(m.totalPnL).toLocaleString()}`.padStart(10), m.profitFactor.toFixed(2).padStart(6), m.sharpe.toFixed(1).padStart(6), `$${Math.round(m.ddDollar).toLocaleString()}`.padStart(9), tPF.toFixed(2).padStart(7), y ? '  YES ✓' : '');
row('baseline', base.full, base.test.profitFactor, false);
for (const { label, r, v } of results) row(label.split('  ')[0].split(' [')[0], r.full, r.test.profitFactor, v.yes);
