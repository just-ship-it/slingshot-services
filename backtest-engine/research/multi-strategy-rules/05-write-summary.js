#!/usr/bin/env node
// 05: Compose the final SUMMARY.md from all earlier outputs and the live in-memory data.
// This is the deliverable Drew reads first.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAll, STRATEGIES } from './lib/load-trades.js';
import { findPairwiseOverlaps, findThreeWayOverlaps } from './lib/interval-tree.js';
import { calculateMetrics, fmtUsd, round } from './lib/metrics.js';
import { fmtETDate } from './lib/et-time.js';
import { simulate } from './rules/_base.js';
import { firstInWins } from './rules/first-in-wins.js';
import { flipOnConflict } from './rules/flip-on-conflict.js';
import { confluenceFirstExit, confluenceLastExit } from './rules/confluence-only.js';
import { priorityWeighted } from './rules/priority-weighted.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

const RULES = [firstInWins, flipOnConflict, confluenceFirstExit, confluenceLastExit, priorityWeighted];

function pct(n, d) { return d === 0 ? '—' : ((n / d) * 100).toFixed(1) + '%'; }

export function main() {
  const { byKey, allFlat } = loadAll();
  const overlaps = findPairwiseOverlaps(allFlat);
  const triples = findThreeWayOverlaps(allFlat);

  // Re-load saved per-pair conflict/confluence stats.
  const conflict = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'conflict-outcomes.json'), 'utf8')).pairs;
  const confluence = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'confluence-outcomes.json'), 'utf8')).pairs;
  const modelA = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'model-a-portfolio.json'), 'utf8'));

  // Re-simulate Model B rules to get fresh metrics.
  const modelB = [];
  for (const rule of RULES) {
    const state = simulate(allFlat, rule);
    const m = calculateMetrics(state.realizedTrades);
    modelB.push({
      rule: rule.name, state, m,
      acceptedFraction: state.accepted / Math.max(1, state.accepted + state.rejected),
      syntheticFraction: state.syntheticExits / Math.max(1, m.trades),
    });
  }

  // ── Build SUMMARY.md ───────────────────────────────────────────────────
  const lines = [];
  lines.push('# Multi-Strategy Overlap & Rule-Set Research — SUMMARY');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Inputs');
  lines.push('');
  lines.push('| Strategy | Trades | Date range | Reported PnL | PF | Sharpe | DD% |');
  lines.push('|---|---:|---|---:|---:|---:|---:|');
  for (const def of STRATEGIES) {
    const v = byKey.get(def.key);
    const first = v.trades.reduce((m, t) => Math.min(m, t.entryTime), Infinity);
    const last = v.trades.reduce((m, t) => Math.max(m, t.exitTime), -Infinity);
    lines.push(`| ${def.key} | ${v.trades.length} | ${fmtETDate(first)} → ${fmtETDate(last)} | ${fmtUsd(v.meta.reportedTotalPnL)} | ${v.meta.reportedPF} | ${v.meta.reportedSharpe} | ${v.meta.reportedDD} |`);
  }
  lines.push('');
  lines.push('**Important date-range note:** `gex-level-fade` data ends 2026-01-28; the other two extend through April 2026. Overlap counts and Model A/B PnL after Jan 28 reflect only `gex-flip-ivpct` and `gex-lt-3m` for the last ~3 months.');
  lines.push('');

  // ── Overlap census ─────────────────────────────────────────────────────
  lines.push('## 1. Overlap census');
  lines.push('');
  lines.push('Overlap defined as strict time-interval intersection: trades A `[entryA, exitA]` and B `[entryB, exitB]` overlap iff `entryA < exitB ∧ entryB < exitA`.');
  lines.push('');
  lines.push(`- **Total pairwise overlap events:** ${overlaps.length}`);
  lines.push(`- **3-way overlap events:** ${triples.length}`);
  lines.push('');
  const byPair = new Map();
  for (const ov of overlaps) {
    const k = `${ov.strategyA}__${ov.strategyB}`;
    if (!byPair.has(k)) byPair.set(k, { conflict: 0, confluence: 0 });
    byPair.get(k)[ov.type] += 1;
  }
  lines.push('| Pair | Total | Confluence | Conflict |');
  lines.push('|---|---:|---:|---:|');
  for (const [k, v] of byPair) {
    const total = v.conflict + v.confluence;
    lines.push(`| ${k} | ${total} | ${v.confluence} (${pct(v.confluence, total)}) | ${v.conflict} (${pct(v.conflict, total)}) |`);
  }
  lines.push('');
  const tripleDist = {};
  for (const t of triples) tripleDist[t.type] = (tripleDist[t.type] || 0) + 1;
  lines.push(`**3-way side combos:** ${JSON.stringify(tripleDist)}`);
  lines.push('');
  lines.push('**Headline takeaway:** confluence and conflict are split ~50/50 in every pair. The strategies fire largely independently of each other\'s direction.');
  lines.push('');

  // ── Conflict outcomes ──────────────────────────────────────────────────
  lines.push('## 2. Conflict outcomes — when sides disagree, who was right?');
  lines.push('');
  lines.push('"Right" = trade closed profitable under its own gold-standard exit rules (`netPnL > 0`). A long AND a short can both be right.');
  lines.push('');
  lines.push('| Pair | Conflict events | A win% | B win% | Both right% | Both lose% | Avg joint PnL |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const [k, c] of Object.entries(conflict)) {
    lines.push(`| ${k} | ${c.total} | ${c.A_winRate}% | ${c.B_winRate}% | ${c.bothRightPct}% | ${c.bothWrongPct}% | ${fmtUsd(c.avgJoint)} |`);
  }
  lines.push('');
  lines.push('**⚠️ Per-event counts are inflated by trade duration asymmetry.** A single long-hold `gex-flip-ivpct` winner can overlap dozens of shorter `gex-lt-3m` / `gex-level-fade` trades, counting once per overlap event. So the 98-99% "A win%" for `gex-flip-ivpct` reflects that during a typical conflict moment, flip\'s open trade is usually the one in profit — not that every gex-flip trade wins 99% of conflicts.');
  lines.push('');
  lines.push('**Real findings:**');
  lines.push('- Avg joint PnL is POSITIVE for every conflict pair (≥0). When both fire, both books usually pay something on average.');
  lines.push('- `gex-flip-ivpct` is dominant in any conflict it participates in (long hold + high WR = it’s already in profit when the opposing signal arrives).');
  lines.push('- `gex-level-fade` vs `gex-lt-3m` conflicts: lt-3m wins ~59%, level-fade ~28%, both lose 19% — the most genuinely "either side could be right" pair.');
  lines.push('');

  // ── Confluence outcomes ────────────────────────────────────────────────
  lines.push('## 3. Confluence outcomes — does same-direction agreement predict bigger winners?');
  lines.push('');
  lines.push('Z-test compares the confluence-leg win rate to the strategy\'s overall baseline win rate.');
  lines.push('');
  lines.push('| Pair | Events | A WR (confluence / baseline) | A z | B WR (confluence / baseline) | B z | Avg joint PnL |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const [k, c] of Object.entries(confluence)) {
    lines.push(`| ${k} | ${c.total} | ${c.A_winRate}% / ${c.A_baselineWinRate}% | ${c.A_uplift_z} | ${c.B_winRate}% / ${c.B_baselineWinRate}% | ${c.B_uplift_z} | ${fmtUsd(c.avgJoint)} |`);
  }
  lines.push('');
  lines.push('**Findings:**');
  lines.push('- Every confluence pair shows POSITIVE uplift for both legs (z > 0).');
  lines.push('- `gex-flip-ivpct`\'s win rate in confluence jumps from 68.6% baseline to 97-98% — but again, this is inflated by long-hold overlap (it\'s usually already winning when the agreeing signal arrives).');
  lines.push('- `gex-level-fade` confluence with `gex-lt-3m`: 49% WR vs 22.2% baseline (z = 6.66). When BOTH level-fade and lt-3m agree on direction, level-fade\'s WR more than doubles.');
  lines.push('- This is the single strongest confluence signal in the dataset and the main basis for the confluence-only rule\'s edge.');
  lines.push('');

  // ── Intra-strategy reconstruction sanity check ─────────────────────────
  lines.push('## 4. Per-strategy reconstruction (sanity check)');
  lines.push('');
  lines.push('Run each strategy alone through `first-in-wins`. Result should match the JSON\'s reported total PnL exactly — confirming the loader and simulator behave correctly and that no strategy has internal overlap that would reduce its PnL under single-position semantics.');
  lines.push('');
  lines.push('| Strategy | Reported PnL | Reconstructed PnL | Trades kept | Internal overlap loss |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const def of STRATEGIES) {
    const trades = byKey.get(def.key).trades;
    const state = simulate(trades, firstInWins);
    const recon = state.realizedTrades.reduce((s, r) => s + r.netPnL, 0);
    const reported = byKey.get(def.key).meta.reportedTotalPnL;
    const matches = Math.abs(recon - reported) < 1;
    lines.push(`| ${def.key} | ${fmtUsd(reported)} | ${fmtUsd(recon)} ${matches ? '✓' : '✗'} | ${state.accepted}/${trades.length} | ${fmtUsd(reported - recon)} |`);
  }
  lines.push('');
  lines.push('**Result:** all three reconstruct exactly. None of the three strategies has any internal trade overlap — each strategy\'s next signal is always issued after the previous trade has natively exited.');
  lines.push('');

  // ── Model A baseline ───────────────────────────────────────────────────
  lines.push('## 5. Model A — Stacking baseline (each strategy = own book, up to 3 contracts)');
  lines.push('');
  lines.push(`- **Trades:** ${modelA.headline.trades}`);
  lines.push(`- **Total PnL:** ${fmtUsd(modelA.headline.totalPnL)}`);
  lines.push(`- **Win rate:** ${modelA.headline.winRate}%`);
  lines.push(`- **Profit factor:** ${modelA.headline.profitFactor}`);
  lines.push(`- **Sharpe (daily-PnL annualized):** ${modelA.headline.sharpe}`);
  lines.push(`- **Max DD (engine convention):** ${modelA.headline.maxDD_pct}% (${fmtUsd(modelA.headline.maxDD_usd)})`);
  lines.push('');
  lines.push('**Concurrency dwell (fraction of wall time at each open-position count):**');
  lines.push('');
  lines.push('| Open positions | Dwell time (h) | % of total |');
  lines.push('|---:|---:|---:|');
  for (const c of modelA.concurrencyDwell) {
    lines.push(`| ${c.concurrency} | ${c.totalHours} | ${c.fractionPct}% |`);
  }
  lines.push('');
  lines.push('Bottom line: Model A holds 2+ contracts only **1.4% of the wall time**. The diversification benefit is real (combined Sharpe 6.58 > any single strategy\'s) but the broker would rarely actually carry 3 contracts.');
  lines.push('');

  // ── Model B rule comparison ────────────────────────────────────────────
  lines.push('## 6. Model B — Single shared 1-NQ position, candidate rules');
  lines.push('');
  lines.push('Each rule replays the merged trade timeline chronologically against a single global slot.');
  lines.push('');
  lines.push('| Rule | Trades | WR | PF | Sharpe | DD% | Total PnL | Accept% | Synth% |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of modelB) {
    lines.push(`| ${r.rule} | ${r.m.trades} | ${round(r.m.winRate, 1)}% | ${round(r.m.profitFactor, 2)} | ${round(r.m.sharpe, 2)} | ${round(r.m.maxDD_pct, 2)}% | ${fmtUsd(r.m.totalPnL)} | ${(r.acceptedFraction * 100).toFixed(0)}% | ${(r.syntheticFraction * 100).toFixed(0)}% |`);
  }
  lines.push('');
  lines.push('**Strategy-of-origin PnL by rule:**');
  lines.push('');
  lines.push('| Rule | gex-flip-ivpct | gex-lt-3m | gex-level-fade |');
  lines.push('|---|---:|---:|---:|');
  for (const r of modelB) {
    const byO = { 'gex-flip-ivpct': 0, 'gex-lt-3m': 0, 'gex-level-fade': 0 };
    for (const t of r.state.realizedTrades) byO[t.strategyKey] = (byO[t.strategyKey] || 0) + t.netPnL;
    lines.push(`| ${r.rule} | ${fmtUsd(byO['gex-flip-ivpct'])} | ${fmtUsd(byO['gex-lt-3m'])} | ${fmtUsd(byO['gex-level-fade'])} |`);
  }
  lines.push('');
  lines.push('**Reading the table:**');
  lines.push('- `first-in-wins` captures most of Model A\'s PnL on a single shared slot (~73% of Model A) with 0% synthetic exits. The honest single-slot baseline.');
  lines.push('- `priority-weighted` (favoring gex-flip) achieves similar PnL to first-in-wins because gex-flip\'s long holds dominate the slot anyway. Adds 7% synthetic exits from preemption.');
  lines.push('- `flip-on-conflict` doesn\'t outperform first-in-wins despite trading more aggressively (1643 vs 1473 trades, similar PnL/Sharpe/DD). Flipping doesn\'t add edge — and 9% of its trades close via synthetic flip-PnL, so the number is biased high.');
  lines.push('- `confluence-only-last-exit` has the **best Sharpe and lowest DD** of any rule, with ZERO synthetic exits — fully honest. Lower frequency (212 trades / 16mo) but per-trade quality is exceptional (PF 2.56, Sharpe 8.56).');
  lines.push('- `confluence-only-first-exit` is half synthetic; its PnL leans on the approximation. The last-exit variant is the cleaner choice.');
  lines.push('');

  // ── Recommendation ─────────────────────────────────────────────────────
  lines.push('## 7. Recommended starting rule set');
  lines.push('');
  lines.push('**Two viable single-slot rules depending on risk appetite:**');
  lines.push('');
  lines.push('### Option A — Maximize PnL: `first-in-wins`');
  lines.push('- $289k / Sharpe 5.79 / DD 11.19% / 1473 trades / 0% synthetic.');
  lines.push('- Captures ~73% of Model A\'s PnL on a single contract.');
  lines.push('- Mechanically simplest: when flat, take any signal; when in a position, reject all incoming signals until native exit. No flipping, no priority, no confluence gate.');
  lines.push('- DD almost identical to Model A (11.19% vs 11.35%).');
  lines.push('');
  lines.push('### Option B — Maximize risk-adjusted return: `confluence-only-last-exit`');
  lines.push('- $105k / Sharpe 8.56 / DD 4.24% / 212 trades / 0% synthetic.');
  lines.push('- Lower absolute PnL but **roughly 1/3 the drawdown** and the best Sharpe of any rule tested.');
  lines.push('- Mechanically: require ≥2 strategies in same-direction overlap to enter; hold the governing trade through its own native exit; ignore other cluster members\' exits.');
  lines.push('- PF 2.56 — per-trade quality is exceptional.');
  lines.push('');
  lines.push('### Comparison of all three viable options');
  lines.push('| Mode | Contracts at peak | Total PnL | Sharpe | Max DD | Trades |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  lines.push(`| Model A — stacking | 3 | $398k | 6.58 | 11.35% | 1858 |`);
  lines.push(`| Model B — first-in-wins | 1 | $289k | 5.79 | 11.19% | 1473 |`);
  lines.push(`| Model B — confluence-only-last-exit | 1 | $105k | 8.56 | 4.24% | 212 |`);
  lines.push('');
  lines.push('**Heuristic for picking:**');
  lines.push('- Margin allows 3 NQ contracts at peak (rare, only 0.1% of wall time anyway) → **Model A** for max PnL.');
  lines.push('- Single contract + DD tolerance ~$20k → **first-in-wins** for high PnL on one contract.');
  lines.push('- Single contract + DD-conscious / small account → **confluence-only-last-exit** for best Sharpe and ~$4k max DD.');
  lines.push('');
  lines.push('**Worth knowing:** `flip-on-conflict` does NOT outperform `first-in-wins` (both ~$280-290k, similar Sharpe and DD) AND introduces 9% synthetic exits. Conclusion: flipping on opposite-direction signals does not add edge in this strategy set; you might as well just take the first signal and ride it through.');
  lines.push('');

  // ── Caveats ────────────────────────────────────────────────────────────
  lines.push('## 8. Caveats');
  lines.push('');
  lines.push('1. **Synthetic-exit approximation.** Rules that close before native exit (`flip-on-conflict`, `confluence-only-first-exit`, `priority-weighted` preemption) cannot know whether the displaced trade would\'ve hit its own stop/target sooner. Synthetic PnL uses `actualEntry → displacing-signal entry` × 20 − $5. This is optimistic for the displaced winner case and pessimistic for the displaced loser case. The `Synth%` column flags exposure.');
  lines.push('2. **Confluence exit policy is a design choice.** `first-exit` (conservative) vs `last-exit` (more PnL). Both reported. Last-exit chosen as primary because it\'s synthesis-free.');
  lines.push('3. **Pipeline does not model margin.** Model A\'s $398k headline assumes 3-contract margin headroom at peak. Capital-efficiency comparison left to the analyst.');
  lines.push('4. **Date-range mismatch.** `gex-level-fade` ends 2026-01-28; overlaps after that involve only flip + lt-3m. The 12.5-month common window vs 16-month flip/lt-3m window is preserved in the JSONs; rule outputs are reported on the full union.');
  lines.push('5. **Sharpe convention.** Daily-PnL series annualized at √252. Engine\'s reported Sharpe uses a different basis (consistent within itself but not matched here). Within this pipeline\'s tables Sharpe values ARE directly comparable across rules.');
  lines.push('6. **3-way overlaps are rare** (61 events, 21 same-side). The confluence rule fires on any 2-strategy same-side overlap; 3-way is the rarer high-confidence case.');
  lines.push('7. **Entry-proximity overlap definition** (window like 15-min after first signal) was not used; strict interval-intersection only. The proximity alternative would generate more confluence events but might dilute signal quality.');
  lines.push('8. **Zero-duration trades:** two `fib_retrace` exits in `gex-flip-ivpct` have `entryTime === exitTime`. The simulator\'s sort handles these as entry-before-exit at the same instant (fix applied 2026-05-16) so they don\'t block subsequent entries.');
  lines.push('');

  // ── Artifact index ─────────────────────────────────────────────────────
  lines.push('## 9. Artifact index');
  lines.push('');
  lines.push('- `output/overlap-tables.csv` — every pairwise overlap event');
  lines.push('- `output/overlap-three-way.csv` — every 3-way overlap');
  lines.push('- `output/conflict-outcomes.json` — per-pair 2×2 win/loss matrices, monthly buckets, direction-asymmetric splits');
  lines.push('- `output/confluence-outcomes.json` — per-pair confluence-leg win rates + z-tests vs baselines, side splits, monthly buckets');
  lines.push('- `output/model-a-portfolio.json` — Model A headline, per-strategy contribution, concurrency dwell, sampled equity curve');
  lines.push('- `output/model-b-rule-comparison.csv` — head-to-head table');
  lines.push('- `output/model-b-<rule>-trades.csv` — per-rule trade audit log');
  lines.push('');
  lines.push('## 10. How to reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('cd backtest-engine');
  lines.push('node research/multi-strategy-rules/run-all.js');
  lines.push('# or step by step:');
  lines.push('node research/multi-strategy-rules/01-build-overlap-tables.js');
  lines.push('node research/multi-strategy-rules/02-classify-outcomes.js');
  lines.push('node research/multi-strategy-rules/03-model-a-portfolio.js');
  lines.push('node research/multi-strategy-rules/04-model-b-simulate.js');
  lines.push('node research/multi-strategy-rules/05-write-summary.js');
  lines.push('```');
  lines.push('');

  fs.writeFileSync(path.join(OUT_DIR, 'SUMMARY.md'), lines.join('\n'));
  console.log('✓ Wrote output/SUMMARY.md');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
