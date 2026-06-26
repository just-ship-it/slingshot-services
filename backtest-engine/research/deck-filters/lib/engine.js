/**
 * Generalized causal FCFS book engine for deck-filter research.
 *
 * Wraps the shared Model-B simulator (../multi-strategy-rules/rules/_base.js) with a per-signal
 * DECISION function: decide(strategyKey, feat) -> sizeMultiplier.
 *   m <= 0  -> SKIP: the trade never competes; the shared 1-NQ slot frees for the next strategy.
 *   m >= 1  -> TAKE at m contracts: netPnL & pointsPnL scale by m (both gross and the $5 commission
 *              are linear in contract count, so netPnL*m is exact). m need not be integer.
 * Skips change slot allocation causally (FCFS), so this must re-simulate — never post-filter a log.
 *
 * runBook(trades, decide) -> { full, train, test, quarters } each = metrics incl ddDollar.
 * Baseline = decide:()=>1 reproduces the $614,730 / PF 1.77 / Sh 10.8 / DD $11,642 book.
 */
import { simulate, open, reject, realizeNativeClose } from '../../multi-strategy-rules/rules/_base.js';
import { calculateMetrics } from '../../multi-strategy-rules/lib/metrics.js';
import { WIN_START, WIN_END, TRAIN_END } from './annotate.js';

const fiwRule = {
  name: 'fiw',
  onSignal(s, t) { if (s.position == null) open(s, t); else reject(s); },
  onNativeExit(s, t) { if (s.position && s.position.trade.id === t.id) realizeNativeClose(s, t); },
};

function runFCFS(trades) {
  const st = simulate(trades.slice().sort((a, b) => a.entryTime - b.entryTime), fiwRule);
  const m = calculateMetrics(st.realizedTrades);
  // peak-relative $ drawdown over exit-ordered realized trades (matches sweep convention)
  const rt = st.realizedTrades.slice().sort((a, b) => (a.exitTime || a.entryTime) - (b.exitTime || b.entryTime));
  let eq = 0, pk = 0, dd = 0; for (const t of rt) { eq += t.netPnL; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  return { ...m, ddDollar: dd, accepted: st.accepted, rejected: st.rejected };
}

const within = (tr, a, b) => tr.filter(t => t.etDate >= a && t.etDate <= b);

/**
 * Apply a decision function to produce the (skipped + scaled) trade list, then run FCFS.
 * decide may return: a number (multiplier), or {m} — anything <=0 (or null/false) skips.
 */
export function applyDecision(trades, decide) {
  const out = [];
  for (const t of trades) {
    let m = decide(t.strategyKey, t);
    if (m && typeof m === 'object') m = m.m;
    if (m == null || m === false) m = 1;          // default keep at 1x if decision is undefined
    if (!(m > 0)) continue;                        // skip -> frees slot
    out.push(m === 1 ? t : { ...t, netPnL: t.netPnL * m, pointsPnL: (t.pointsPnL ?? 0) * m, _mult: m });
  }
  return out;
}

export function runBook(trades, decide = () => 1) {
  const applied = applyDecision(trades, decide);
  const slice = (a, b) => runFCFS(within(applied, a, b));
  const quarters = [
    ['Q1', '2025-01-13', '2025-04-15'], ['Q2', '2025-04-16', '2025-07-15'], ['Q3', '2025-07-16', '2025-10-15'],
    ['Q4', '2025-10-16', '2026-01-15'], ['Q5', '2026-01-16', '2026-04-23'],
  ].map(([n, a, b]) => [n, slice(a, b)]);
  return {
    full: slice(WIN_START, WIN_END),
    train: slice(WIN_START, TRAIN_END),
    test: slice('2025-10-01', WIN_END),
    quarters,
  };
}

export const fmtM = m => `PnL=$${Math.round(m.totalPnL).toLocaleString()} PF=${m.profitFactor === Infinity ? 'Inf' : m.profitFactor.toFixed(2)} Sh=${m.sharpe.toFixed(1)} DD=$${Math.round(m.ddDollar).toLocaleString()} n=${m.trades} WR=${m.winRate.toFixed(0)}%`;

export function report(label, r) {
  console.log(`\n${label}`);
  console.log(`  full:  ${fmtM(r.full)}`);
  console.log(`  train: ${fmtM(r.train)}`);
  console.log(`  test:  ${fmtM(r.test)}`);
  console.log(`  quarters PF: ${r.quarters.map(([n, m]) => `${n} ${m.profitFactor === Infinity ? 'Inf' : m.profitFactor.toFixed(2)}`).join('  ')}`);
}

// Accept test vs baseline: PF-over-PnL. YES iff PF and Sharpe both up and DD not worse (full),
// AND test-half PF beats baseline test PF (out-of-sample stability).
export function verdict(base, cand) {
  const pfUp = cand.full.profitFactor > base.full.profitFactor + 0.01;
  const shUp = cand.full.sharpe >= base.full.sharpe - 0.2;          // not materially worse
  const ddOk = cand.full.ddDollar <= base.full.ddDollar * 1.02;
  const oosPF = cand.test.profitFactor > base.test.profitFactor;
  const yes = pfUp && shUp && ddOk && oosPF;
  return { yes, pfUp, shUp, ddOk, oosPF };
}
