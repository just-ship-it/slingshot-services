/**
 * 05-controls-sizing.js -- the decisive control. The glf FILTER's book lift was fungible
 * (random glf-drop matched it). Test whether confluence as a SIZING signal beats RANDOM sizing
 * of the same number of trades -- this is the non-fungible test (sizing keeps all trades, so the
 * shared-slot fungibility that defeated the filter does not apply).
 *
 * If confluence-size > random-size on PF AND test-PF, the per-trade confluence edge converts to a
 * real book-level lever. Focus on gfi (high-PF, rarely contends) and both.
 */
import { runBook, fmtM } from '../deck-filters/lib/engine.js';
import { loadBookWithFib, MR_KEYS } from './lib/book-with-fib.js';
import { confluenceCount } from './lib/fib-confluence.js';

const trades = loadBookWithFib();
const base = runBook(trades);
console.log('BASELINE full', fmtM(base.full), '| test PF', base.test.profitFactor.toFixed(2), '\n');

function meanStd(xs) { const m = xs.reduce((a, b) => a + b, 0) / xs.length; const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length; return [m, Math.sqrt(v)]; }

for (const [scopeLabel, inScope] of [['gfi', k => k === 'gex-flip-ivpct'], ['glf', k => k === 'gex-level-fade'], ['both', k => MR_KEYS.has(k)]]) {
  for (const prox of [3, 5]) for (const mult of [1.5, 2]) {
    const isC = t => confluenceCount(t.fib, prox, false) >= 1;
    const pool = trades.filter(t => inScope(t.strategyKey));
    const nC = pool.filter(isC).length;
    // confluence-size
    const cs = runBook(trades, (k, t) => (inScope(k) && isC(t)) ? mult : 1);
    // random-size: same count, 8 seeds
    const rsPF = [], rsTestPF = [], rsSh = [];
    let s = 4242 + prox * 7 + Math.round(mult * 10);
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let seed = 0; seed < 8; seed++) {
      const pick = new Set(pool.map(t => ({ id: t.id, k: rnd() })).sort((a, b) => a.k - b.k).slice(0, nC).map(x => x.id));
      const r = runBook(trades, (k, t) => pick.has(t.id) ? mult : 1);
      rsPF.push(r.full.profitFactor); rsTestPF.push(r.test.profitFactor); rsSh.push(r.full.sharpe);
    }
    const [mPF, sPF] = meanStd(rsPF), [mT, sT] = meanStd(rsTestPF), [mSh] = meanStd(rsSh);
    const edge = cs.full.profitFactor - mPF, edgeT = cs.test.profitFactor - mT;
    const verdict = (edge > 0.01 && edgeT > 0) ? 'REAL' : '~null';
    console.log(`${scopeLabel} x${mult} prox<=${prox} (n_conf=${nC}):`);
    console.log(`   CONF-size:   full PF ${cs.full.profitFactor.toFixed(3)} Sh ${cs.full.sharpe.toFixed(1)} DD $${Math.round(cs.full.ddDollar).toLocaleString()} | test PF ${cs.test.profitFactor.toFixed(3)} | PnL $${Math.round(cs.full.totalPnL).toLocaleString()}`);
    console.log(`   RAND-size:   full PF ${mPF.toFixed(3)}±${sPF.toFixed(3)} Sh ${mSh.toFixed(1)} | test PF ${mT.toFixed(3)}±${sT.toFixed(3)}`);
    console.log(`   => edge full +${edge.toFixed(3)} | test +${edgeT.toFixed(3)}  [${verdict}]\n`);
  }
}
