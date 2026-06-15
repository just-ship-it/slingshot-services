// Phase 6 — Partial scale-out overlay on the FCFS portfolio, traded as 10 MNQ (= 1 NQ
// notional, $20/pt) so a fraction can be peeled off.
//
// Model: at a scale trigger T (favorable pts from entry), sell fraction X of the position
// via a limit at entry±T; the runner (1-X) rides the UNCHANGED native plan (same stop, BE,
// target). No slot-mechanics change → reuse baseline FCFS accepted book; no 1s re-sim needed.
//   blended_pts = (mfe >= T) ? X*T + (1-X)*native : native
// (limit scale-out fills at T with no slippage; mfe is the 1s-honest peak from the gold JSON.)
//
// Trigger family: T = f * breakevenTrigger(strategy), sweeping f from "scale early" (rescues
// losers) to f=1 ("scale when stop moves to BE"). Tested on all-4 and on big-3 (excl lstb).
// Commission is identical for baseline vs scale-out (same 10 contracts round-tripped) so the
// comparison is commission-invariant; we use $1.20 RT/MNQ = $12/trade.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics } from '../multi-strategy-rules/lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PV = 20, COMM = 12; // 10 MNQ @ $20/pt, ~$1.20 RT/MNQ

const STRATEGIES = [
  { key: 'lstb',           file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m',      file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];
const normSide = s => { const l = String(s).toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : (l === 'short' || l === 'sell') ? 'short' : null; };
const beTrig = t => t.breakevenTrigger ?? t.signal?.breakevenTrigger ?? t.signal?.breakeven_trigger ?? null;

const all = [];
const meta = new Map(); // `${key}:${id}` -> { mfe, be, native, strat }
for (const def of STRATEGIES) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  for (const t of raw.trades) {
    if (t.status !== 'completed' || t.entryTime == null || t.exitTime == null) continue;
    const side = normSide(t.side); if (!side) continue;
    const entryTime = t.entryTime, exitTime = t.exitTime <= entryTime ? entryTime + 1 : t.exitTime;
    const id = `${def.key}:${t.id}`;
    all.push({ id, nativeId: t.id, strategyKey: def.key, side, entryTime, exitTime,
      duration: t.duration ?? (exitTime - entryTime), actualEntry: t.actualEntry ?? t.entryPrice,
      actualExit: t.actualExit, netPnL: t.netPnL, pointsPnL: t.pointsPnL, exitReason: t.exitReason });
    meta.set(id, { mfe: t.mfePoints ?? 0, be: beTrig(t), native: t.pointsPnL, strat: def.key });
  }
}
all.sort((a, b) => a.entryTime - b.entryTime);

const firstInWins = {
  name: 'fcfs',
  onSignal(s, t) { if (s.position == null) open(s, t); else reject(s); },
  onNativeExit(s, t) { if (s.position && s.position.trade.id === t.id) realizeNativeClose(s, t); },
};
const book = simulate(all, firstInWins).realizedTrades; // accepted set (identical under scale-out)

// build blended trades for a (fraction X, triggerFactor f, applyTo set)
function variant(X, f, applyTo) {
  let rescued = 0, capped = 0, dPnLpts = 0;
  const trades = book.map(rt => {
    const m = meta.get(`${rt.strategyKey}:${rt.nativeId}`);
    let pts = m.native;
    const apply = applyTo.has(rt.strategyKey) && m.be != null && f > 0;
    if (apply) {
      const T = f * m.be;
      if (m.mfe >= T) {
        const blended = X * T + (1 - X) * m.native;
        if (blended > m.native + 1e-9) rescued++; else if (blended < m.native - 1e-9) capped++;
        dPnLpts += (blended - m.native);
        pts = blended;
      }
    }
    return { ...rt, pointsPnL: pts, netPnL: pts * PV - COMM };
  });
  return { trades, rescued, capped, dPnLpts };
}

function row(label, m, extra = '') {
  return `${label.padEnd(26)} ${('$' + Math.round(m.totalPnL).toLocaleString()).padStart(11)}  PF ${m.profitFactor.toFixed(2).padStart(5)}  Sh ${m.sharpe.toFixed(2).padStart(6)}  DD ${(m.maxDD_pct.toFixed(2) + '%').padStart(7)} ($${Math.round(m.maxDD_usd).toLocaleString()})  WR ${m.winRate.toFixed(1)}%  ${extra}`;
}

const ALL4 = new Set(['lstb', 'gex-lt-3m', 'gex-flip-ivpct', 'gex-level-fade']);
const BIG3 = new Set(['gex-lt-3m', 'gex-flip-ivpct', 'gex-level-fade']);

// baseline as 10 MNQ
const base = variant(0, 0, ALL4);
const mBase = calculateMetrics(base.trades);
console.log('═══════════════════════════════════════════════════════════════════════════════════════');
console.log('  SCALE-OUT OVERLAY (10 MNQ = 1 NQ notional), partial peel at T = f × BE-trigger');
console.log('  blended = X·T + (1−X)·native for trades reaching T; runner keeps native plan');
console.log('═══════════════════════════════════════════════════════════════════════════════════════\n');
console.log(' ', row('BASELINE (10 MNQ, no scale)', mBase), `[6128 trades; vs $614,730 gold @ $5 NQ comm]`);

for (const [name, applyTo] of [['ALL 4 strategies', ALL4], ['BIG 3 (excl lstb)', BIG3]]) {
  console.log(`\n  ── scale-out applied to: ${name} ──`);
  console.log('  X    f     ' + 'totalPnL'.padStart(11) + '   PF     Sharpe   DD%        rescued/capped');
  const grid = [];
  for (const X of [0.3, 0.5, 0.7]) {
    for (const f of [0.25, 0.5, 0.75, 1.0]) {
      const v = variant(X, f, applyTo);
      const m = calculateMetrics(v.trades);
      grid.push({ X, f, m, v });
      console.log(`  ${X.toFixed(1)}  ${f.toFixed(2)}  ${('$' + Math.round(m.totalPnL).toLocaleString()).padStart(11)}   ${m.profitFactor.toFixed(2)}   ${m.sharpe.toFixed(2).padStart(5)}   ${(m.maxDD_pct.toFixed(2) + '%').padStart(7)}   ${v.rescued}/${v.capped}`);
    }
  }
  // best by Sharpe
  grid.sort((a, b) => b.m.sharpe - a.m.sharpe);
  const best = grid[0];
  console.log(`  → best Sharpe: X=${best.X} f=${best.f}  Sh ${best.m.sharpe.toFixed(2)} (base ${mBase.sharpe.toFixed(2)}), DD ${best.m.maxDD_pct.toFixed(2)}% (base ${mBase.maxDD_pct.toFixed(2)}%), PnL $${Math.round(best.m.totalPnL).toLocaleString()} (base $${Math.round(mBase.totalPnL).toLocaleString()})`);
}
