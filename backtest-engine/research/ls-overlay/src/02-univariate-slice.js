/**
 * Phase 2 — Univariate slicing across (strategy, side, LS feature, TF)
 *
 * For each enriched strategy JSON, slice trades by every LS feature × TF
 * combination and report WR, PF, Sharpe-ish, avgPnL, sumPnL per cell.
 *
 * Filters tested (per TF in {1m, 3m, 15m}):
 *   1. ls_favorable_at_entry — Phase 0's contrarian alignment.
 *      Boolean cell. Subdivides by side automatically.
 *   2. ls_state_at_entry — raw state independent of side.
 *   3. bars_since_last_flip — buckets [0, 1-5, 6-15, 16-60, 60+]
 *   4. flips_in_prev_60m — buckets [0-2, 3-5, 6-10, 11+]
 *   5. flips_during_trade >= 1 — boolean (any LS flip during the trade)
 *   6. adverse_flips_during >= 1 — boolean
 *
 * Output:
 *   output/02-univariate.json          — full table of all cells
 *   output/02-univariate-leaderboard.txt — top 20 actionable "DROP THIS CELL"
 *                                          rules by sumPnL improvement
 *
 * Selection rule for the leaderboard:
 *   For a binary feature, identify the "bad" cell (lower avgPnL).
 *   The "drop bad" rule keeps trades NOT in the bad cell.
 *   We rank by abs(sumPnL_dropped) — bigger removed loss = better rule.
 *   Require n_dropped >= 30 for actionability.
 *
 * Run: node research/ls-overlay/src/02-univariate-slice.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STRATEGIES = ['gex-flip-ivpct', 'gex-lt-3m-crossover', 'gex-level-fade'];
const TFS = ['1m','3m','15m'];

function loadEnriched(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'enriched', `${name}.json`), 'utf-8'));
}

function stats(trades) {
  if (!trades.length) return { n: 0, sumPnL: 0, avg: 0, wr: 0, pf: 0, sharpe: 0 };
  const n = trades.length;
  const pnls = trades.map(t => t.netPnL ?? 0);
  const sumPnL = pnls.reduce((s, x) => s + x, 0);
  const avg = sumPnL / n;
  const wr = trades.filter(t => (t.netPnL ?? 0) > 0).length / n;
  const grossW = pnls.filter(x => x > 0).reduce((s,x) => s+x, 0);
  const grossL = -pnls.filter(x => x < 0).reduce((s,x) => s+x, 0);
  const pf = grossL === 0 ? (grossW > 0 ? 99 : 0) : grossW / grossL;
  const mean = avg;
  const variance = pnls.reduce((s,x) => s + (x - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? mean / sd : 0; // per-trade Sharpe-ish
  return { n, sumPnL: +sumPnL.toFixed(2), avg: +avg.toFixed(2), wr: +(100*wr).toFixed(2), pf: +pf.toFixed(2), sharpe: +sharpe.toFixed(3) };
}

function bucketBarsSinceFlip(v) {
  if (v == null) return 'na';
  if (v === 0) return '0';
  if (v <= 5) return '1-5';
  if (v <= 15) return '6-15';
  if (v <= 60) return '16-60';
  return '60+';
}

function bucketFlipsPrev(v) {
  if (v == null) return 'na';
  if (v <= 2) return '0-2';
  if (v <= 5) return '3-5';
  if (v <= 10) return '6-10';
  return '11+';
}

(async () => {
  const all = {};
  const leaderboard = [];

  for (const strat of STRATEGIES) {
    const trades = loadEnriched(strat);
    const baseLong  = stats(trades.filter(t => (t.side||'').toLowerCase() === 'long'));
    const baseShort = stats(trades.filter(t => (t.side||'').toLowerCase() === 'short'));
    const baseAll   = stats(trades);
    all[strat] = { baseAll, baseLong, baseShort, cells: {} };

    for (const side of ['all','long','short']) {
      const subset = side === 'all' ? trades : trades.filter(t => (t.side||'').toLowerCase() === side);
      if (subset.length === 0) continue;
      const baseSub = stats(subset);

      for (const tf of TFS) {
        // Feature 1: ls_favorable_at_entry (boolean)
        const favTrue  = stats(subset.filter(t => t[`ls_favorable_at_entry_${tf}`] === true));
        const favFalse = stats(subset.filter(t => t[`ls_favorable_at_entry_${tf}`] === false));
        all[strat].cells[`${side}/${tf}/favorable_at_entry`] = { true: favTrue, false: favFalse, base: baseSub };

        // Feature 2: ls_state_at_entry (0 or 1)
        const s0 = stats(subset.filter(t => t[`ls_state_at_entry_${tf}`] === 0));
        const s1 = stats(subset.filter(t => t[`ls_state_at_entry_${tf}`] === 1));
        all[strat].cells[`${side}/${tf}/state_at_entry`] = { 0: s0, 1: s1, base: baseSub };

        // Feature 3: bars_since_last_flip (bucketed)
        const buckets3 = {};
        for (const b of ['0','1-5','6-15','16-60','60+']) buckets3[b] = stats(subset.filter(t => bucketBarsSinceFlip(t[`bars_since_last_flip_${tf}`]) === b));
        all[strat].cells[`${side}/${tf}/bars_since_last_flip`] = { ...buckets3, base: baseSub };

        // Feature 4: flips_in_prev_60m (bucketed)
        const buckets4 = {};
        for (const b of ['0-2','3-5','6-10','11+']) buckets4[b] = stats(subset.filter(t => bucketFlipsPrev(t[`flips_in_prev_60m_${tf}`]) === b));
        all[strat].cells[`${side}/${tf}/flips_in_prev_60m`] = { ...buckets4, base: baseSub };

        // Feature 5: any flip during trade
        const fT = stats(subset.filter(t => (t[`flips_during_trade_${tf}`] ?? 0) > 0));
        const fF = stats(subset.filter(t => (t[`flips_during_trade_${tf}`] ?? 0) === 0));
        all[strat].cells[`${side}/${tf}/flipped_during_trade`] = { true: fT, false: fF, base: baseSub };

        // Feature 6: any adverse flip during trade
        const aT = stats(subset.filter(t => (t[`adverse_flips_during_${tf}`] ?? 0) > 0));
        const aF = stats(subset.filter(t => (t[`adverse_flips_during_${tf}`] ?? 0) === 0));
        all[strat].cells[`${side}/${tf}/adverse_flip_during_trade`] = { true: aT, false: aF, base: baseSub };
      }
    }

    // Build leaderboard candidates: "drop bad cell" for each binary feature
    for (const key of Object.keys(all[strat].cells)) {
      const cells = all[strat].cells[key];
      const base = cells.base;
      // Each binary or bucketed feature offers DROP rules: drop trades matching
      // any single cell value, see remaining stats.
      for (const cellVal of Object.keys(cells)) {
        if (cellVal === 'base') continue;
        const dropped = cells[cellVal];
        if (dropped.n < 30) continue;
        const kept = {
          n: base.n - dropped.n,
          sumPnL: +(base.sumPnL - dropped.sumPnL).toFixed(2),
        };
        if (kept.n < 30) continue;
        // PF and WR for kept require recomputing; cheaper: compute later only for top survivors.
        // For ranking: improvement = -dropped.sumPnL  (drop a loss → +). Best rules drop large losses.
        const improvement = -dropped.sumPnL;
        // Only consider rules where dropping helps (dropped.sumPnL < 0) OR
        // dropping doesn't hurt much but reshapes risk (small positive drop = give up little).
        leaderboard.push({
          strategy: strat,
          rule: `DROP ${key}=${cellVal}`,
          n_base: base.n,
          n_dropped: dropped.n,
          n_kept: kept.n,
          dropped_sumPnL: dropped.sumPnL,
          dropped_avg: dropped.avg,
          dropped_wr: dropped.wr,
          dropped_pf: dropped.pf,
          improvement_sumPnL: improvement,
          base_sumPnL: base.sumPnL,
          base_avg: base.avg,
          base_wr: base.wr,
          base_pf: base.pf,
        });
      }
    }
  }

  // Sort leaderboard: prioritize rules that drop a large net loss
  // (improvement > 0) by absolute improvement, then by PF degradation cost.
  leaderboard.sort((a, b) => b.improvement_sumPnL - a.improvement_sumPnL);

  fs.writeFileSync(path.join(__dirname, '..', 'output', '02-univariate.json'), JSON.stringify(all, null, 2));

  const top = leaderboard.slice(0, 30);
  const lines = [];
  lines.push('Phase 2 leaderboard — top 30 "DROP cell" rules ranked by sumPnL improvement');
  lines.push('(positive improvement = filter removes net-losing trades, so PnL goes up if we filter them)');
  lines.push('');
  lines.push(`${'strategy'.padEnd(22)} ${'rule'.padEnd(50)} ${'n_drop'.padStart(7)} ${'drop_avg'.padStart(10)} ${'drop_wr%'.padStart(9)} ${'drop_pf'.padStart(8)} ${'drop_sum'.padStart(10)} ${'improve'.padStart(10)} ${'base_pf'.padStart(8)}`);
  lines.push('-'.repeat(160));
  for (const r of top) {
    lines.push(`${r.strategy.padEnd(22)} ${r.rule.padEnd(50)} ${String(r.n_dropped).padStart(7)} ${String(r.dropped_avg).padStart(10)} ${String(r.dropped_wr).padStart(9)} ${String(r.dropped_pf).padStart(8)} ${String(r.dropped_sumPnL).padStart(10)} ${String(r.improvement_sumPnL).padStart(10)} ${String(r.base_pf).padStart(8)}`);
  }

  // Also dump per-strategy baseline + top picks
  lines.push('');
  lines.push('Baselines (no filter):');
  for (const s of STRATEGIES) {
    const b = all[s].baseAll;
    lines.push(`  ${s.padEnd(22)} n=${String(b.n).padStart(4)} sumPnL=$${String(b.sumPnL).padStart(8)}  avg=$${String(b.avg).padStart(7)}  WR=${b.wr}%  PF=${b.pf}  Sharpe(perTrade)=${b.sharpe}`);
  }
  lines.push('');
  lines.push('Per-strategy top-5 DROP rules:');
  for (const s of STRATEGIES) {
    lines.push(`-- ${s} --`);
    const rules = leaderboard.filter(r => r.strategy === s).slice(0, 5);
    for (const r of rules) {
      lines.push(`  ${r.rule.padEnd(50)} drop n=${r.n_dropped} avgPnL=$${r.dropped_avg} wr=${r.dropped_wr}% pf=${r.dropped_pf} sumPnL=$${r.dropped_sumPnL}  (improvement $${r.improvement_sumPnL})`);
    }
  }

  fs.writeFileSync(path.join(__dirname, '..', 'output', '02-univariate-leaderboard.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
