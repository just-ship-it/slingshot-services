/**
 * 07-retest-sharp-inbook.js -- does the SHARP, larger-sample confluence slice survive in the FCFS
 * book, and does it add INCREMENTALLY to the already-known glf gamma-sign gate
 * (gamma-clock/deck-filters: drop glf neg-gamma ~ PF 1.77->1.80)?
 *
 * Decisive control for each candidate: random-drop the SAME number of glf trades (8 seeds). A
 * candidate only "survives" if it beats the random band on full PF AND test PF.
 */
import { runBook, fmtM } from '../deck-filters/lib/engine.js';
import { loadBookWithFib } from './lib/book-with-fib.js';

const trades = loadBookWithFib();
const base = runBook(trades);
const glf = trades.filter(t => t.strategyKey === 'gex-level-fade');
const anyC = (t, prox) => ['15', '60', '240'].some(k => t.fib['d' + k] != null && t.fib['d' + k] <= prox);
const conf1h15 = (t, prox) => ['15', '60'].some(k => t.fib['d' + k] != null && t.fib['d' + k] <= prox);  // drop 4h (adds nothing)
const binding = t => { let bk = null, bd = Infinity; for (const k of ['15', '60', '240']) { const d = t.fib['d' + k]; if (d != null && d < bd) { bd = d; bk = k; } } return bk ? { r: t.fib['r' + bk], legR: t.fib['legR' + bk] } : null; };

const meanStd = xs => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return [m, Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)]; };

function evalRule(label, keepGlf) {
  const r = runBook(trades, (k, t) => (k === 'gex-level-fade' && !keepGlf(t)) ? 0 : 1);
  const nKept = glf.filter(keepGlf).length, nDrop = glf.length - nKept;
  // matched random-drop control, 8 seeds
  const pf = [], tpf = [];
  let s = 71 + nDrop;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let seed = 0; seed < 8; seed++) {
    const drop = new Set(glf.map(t => ({ id: t.id, k: rnd() })).sort((a, b) => a.k - b.k).slice(0, nDrop).map(x => x.id));
    const rr = runBook(trades, (k, t) => drop.has(t.id) ? 0 : 1);
    pf.push(rr.full.profitFactor); tpf.push(rr.test.profitFactor);
  }
  const [mPF, sPF] = meanStd(pf), [mT, sT] = meanStd(tpf);
  const survive = (r.full.profitFactor > mPF + sPF) && (r.test.profitFactor > mT);
  console.log(`${label}  (keep ${nKept}/${glf.length} glf)`);
  console.log(`   RULE:   full ${fmtM(r.full)} | test PF ${r.test.profitFactor.toFixed(3)}`);
  console.log(`   RANDOM: full PF ${mPF.toFixed(3)}±${sPF.toFixed(3)} | test PF ${mT.toFixed(3)}±${sT.toFixed(3)}`);
  console.log(`   => ${survive ? 'SURVIVES (beats random band)' : 'fungible (within random band)'}\n`);
}

console.log('BASELINE full', fmtM(base.full), '| test PF', base.test.profitFactor.toFixed(3), '\n');

evalRule('A) gamma-only: keep glf POS-gamma', t => t.gammaSign === 1);
evalRule('B) conf-only: keep glf confluent (any TF prox<=5)', t => anyC(t, 5));
evalRule('C) gamma + conf(any): keep POS-gamma AND confluent<=5', t => t.gammaSign === 1 && anyC(t, 5));
evalRule('D) SHARP: POS-gamma AND 1h/15m conf<=5 AND 0.618 AND legR>=80', t => {
  if (t.gammaSign !== 1 || !conf1h15(t, 5)) return false; const b = binding(t); return b && b.r > 0.55 && b.r <= 0.66 && b.legR >= 80;
});
evalRule('E) MID-sharp: POS-gamma AND 1h/15m conf<=5 AND legR>=80', t => {
  if (t.gammaSign !== 1 || !conf1h15(t, 5)) return false; const b = binding(t); return b && b.legR >= 80;
});
