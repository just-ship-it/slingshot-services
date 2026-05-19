/**
 * Phase 2b — Entry-time-only filter leaderboard
 *
 * Restricted to features observable AT entry:
 *   ls_state_at_entry_{tf}, ls_favorable_at_entry_{tf},
 *   bars_since_last_flip_{tf}, flips_in_prev_60m_{tf}
 *
 * Exit-time signals (flipped_during_trade, adverse_flips_during) are
 * deferred to Phase 4 where we'll simulate LS-aware early exits.
 *
 * For each (strategy, side, TF, feature, cell), we report:
 *   - DROP rule: filter out trades matching this cell, see lift
 *   - KEEP rule: filter to ONLY this cell, see if it beats baseline
 *
 * Output:
 *   output/02b-entry-filters.json — full table
 *   output/02b-entry-filters.txt — ranked leaderboard (drop + keep)
 *
 * Run: node research/ls-overlay/src/02b-entry-filters.js
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
  if (!trades.length) return { n:0, sumPnL:0, avg:0, wr:0, pf:0 };
  const n = trades.length;
  const pnls = trades.map(t => t.netPnL ?? 0);
  const sumPnL = pnls.reduce((s,x)=>s+x, 0);
  const wins = pnls.filter(x => x > 0).length;
  const grossW = pnls.filter(x => x > 0).reduce((s,x)=>s+x, 0);
  const grossL = -pnls.filter(x => x < 0).reduce((s,x)=>s+x, 0);
  return {
    n, sumPnL: +sumPnL.toFixed(2),
    avg: +(sumPnL/n).toFixed(2),
    wr: +(100*wins/n).toFixed(2),
    pf: grossL === 0 ? (grossW > 0 ? 99 : 0) : +(grossW/grossL).toFixed(2),
  };
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

const FEATURES = [
  { name: 'state_at_entry', vals: ['0','1'], get: (t,tf) => String(t[`ls_state_at_entry_${tf}`]) },
  { name: 'favorable_at_entry', vals: ['true','false'], get: (t,tf) => String(t[`ls_favorable_at_entry_${tf}`]) },
  { name: 'bars_since_last_flip', vals: ['0','1-5','6-15','16-60','60+'], get: (t,tf) => bucketBarsSinceFlip(t[`bars_since_last_flip_${tf}`]) },
  { name: 'flips_in_prev_60m', vals: ['0-2','3-5','6-10','11+'], get: (t,tf) => bucketFlipsPrev(t[`flips_in_prev_60m_${tf}`]) },
];

const MIN_DROP_N = 20;
const MIN_KEEP_N = 30;

(async () => {
  const all = {};
  const dropLeaderboard = [];
  const keepLeaderboard = [];

  for (const strat of STRATEGIES) {
    const trades = loadEnriched(strat);
    all[strat] = { base: stats(trades), cells: {} };

    for (const side of ['all','long','short']) {
      const subset = side === 'all' ? trades : trades.filter(t => (t.side||'').toLowerCase() === side);
      if (subset.length === 0) continue;
      const baseSub = stats(subset);

      for (const tf of TFS) {
        for (const feat of FEATURES) {
          const cellMap = {};
          for (const v of feat.vals) {
            cellMap[v] = stats(subset.filter(t => feat.get(t, tf) === v));
          }
          all[strat].cells[`${side}/${tf}/${feat.name}`] = { ...cellMap, base: baseSub };

          // DROP rules — for each cell, what does removing it do?
          for (const v of feat.vals) {
            const dropped = cellMap[v];
            if (dropped.n < MIN_DROP_N) continue;
            const kept_n = baseSub.n - dropped.n;
            const kept_sumPnL = +(baseSub.sumPnL - dropped.sumPnL).toFixed(2);
            if (kept_n < MIN_KEEP_N) continue;
            const improvement = -dropped.sumPnL; // dropping a loser = positive improvement
            dropLeaderboard.push({
              strategy: strat,
              rule: `DROP ${side}/${tf}/${feat.name}=${v}`,
              n_base: baseSub.n, n_dropped: dropped.n, n_kept: kept_n,
              dropped_avg: dropped.avg, dropped_wr: dropped.wr, dropped_pf: dropped.pf, dropped_sumPnL: dropped.sumPnL,
              kept_sumPnL,
              improvement_sumPnL: +improvement.toFixed(2),
              base_sumPnL: baseSub.sumPnL, base_avg: baseSub.avg, base_wr: baseSub.wr, base_pf: baseSub.pf,
            });
          }

          // KEEP rules — narrow to only this cell, must be at least 30 trades
          for (const v of feat.vals) {
            const kept = cellMap[v];
            if (kept.n < MIN_KEEP_N) continue;
            // Compare PF improvement
            const pf_delta = +(kept.pf - baseSub.pf).toFixed(2);
            const avg_delta = +(kept.avg - baseSub.avg).toFixed(2);
            keepLeaderboard.push({
              strategy: strat,
              rule: `KEEP ${side}/${tf}/${feat.name}=${v}`,
              n_base: baseSub.n, n_kept: kept.n,
              kept_avg: kept.avg, kept_wr: kept.wr, kept_pf: kept.pf, kept_sumPnL: kept.sumPnL,
              base_pf: baseSub.pf, base_avg: baseSub.avg, base_wr: baseSub.wr, base_sumPnL: baseSub.sumPnL,
              pf_delta, avg_delta,
            });
          }
        }
      }
    }
  }

  // Rank DROP rules: improvement_sumPnL is loss-removed.
  // Tiebreak: smaller n_dropped (more selective filter is preferred at same impact).
  dropLeaderboard.sort((a, b) => (b.improvement_sumPnL - a.improvement_sumPnL) || (a.n_dropped - b.n_dropped));

  // Rank KEEP rules by PF delta (positive = improvement). Tiebreak: kept_n large = more reliable.
  keepLeaderboard.sort((a, b) => (b.pf_delta - a.pf_delta) || (b.n_kept - a.n_kept));

  fs.writeFileSync(path.join(__dirname, '..', 'output', '02b-entry-filters.json'),
    JSON.stringify({ all, dropLeaderboard, keepLeaderboard }, null, 2));

  const lines = [];
  lines.push('=== Phase 2b — Entry-time-only filter leaderboard ===');
  lines.push('');
  lines.push('Baselines:');
  for (const s of STRATEGIES) {
    const b = all[s].base;
    lines.push(`  ${s.padEnd(22)} n=${String(b.n).padStart(4)} sumPnL=$${String(b.sumPnL).padStart(8)} avg=$${String(b.avg).padStart(7)} WR=${b.wr}% PF=${b.pf}`);
  }

  lines.push('');
  lines.push('-- TOP 15 DROP rules (drop trades matching cell; improvement = $$ loss removed) --');
  lines.push(`${'strategy'.padEnd(22)} ${'rule'.padEnd(52)} ${'n_drop'.padStart(7)} ${'drop_avg'.padStart(10)} ${'drop_wr'.padStart(8)} ${'drop_pf'.padStart(8)} ${'improve$'.padStart(10)}`);
  for (const r of dropLeaderboard.slice(0, 15)) {
    lines.push(`${r.strategy.padEnd(22)} ${r.rule.padEnd(52)} ${String(r.n_dropped).padStart(7)} ${String(r.dropped_avg).padStart(10)} ${String(r.dropped_wr).padStart(8)} ${String(r.dropped_pf).padStart(8)} ${String(r.improvement_sumPnL).padStart(10)}`);
  }

  lines.push('');
  lines.push('-- TOP 15 KEEP rules (filter to only this cell; PF delta vs side/strategy baseline) --');
  lines.push(`${'strategy'.padEnd(22)} ${'rule'.padEnd(52)} ${'n_kept'.padStart(7)} ${'kept_avg'.padStart(10)} ${'kept_wr'.padStart(8)} ${'kept_pf'.padStart(8)} ${'pf_Δ'.padStart(8)} ${'kept_sum$'.padStart(10)}`);
  for (const r of keepLeaderboard.slice(0, 15)) {
    lines.push(`${r.strategy.padEnd(22)} ${r.rule.padEnd(52)} ${String(r.n_kept).padStart(7)} ${String(r.kept_avg).padStart(10)} ${String(r.kept_wr).padStart(8)} ${String(r.kept_pf).padStart(8)} ${String(r.pf_delta).padStart(8)} ${String(r.kept_sumPnL).padStart(10)}`);
  }

  lines.push('');
  lines.push('-- Per-strategy top 3 DROP and 3 KEEP --');
  for (const s of STRATEGIES) {
    lines.push(`# ${s} (base sumPnL=$${all[s].base.sumPnL}, PF=${all[s].base.pf}, n=${all[s].base.n})`);
    lines.push('  DROP:');
    for (const r of dropLeaderboard.filter(r => r.strategy === s).slice(0, 3))
      lines.push(`    ${r.rule.padEnd(50)} drop n=${r.n_dropped} avg=$${r.dropped_avg} pf=${r.dropped_pf}  improvement=$${r.improvement_sumPnL}`);
    lines.push('  KEEP:');
    for (const r of keepLeaderboard.filter(r => r.strategy === s).slice(0, 3))
      lines.push(`    ${r.rule.padEnd(50)} keep n=${r.n_kept} avg=$${r.kept_avg} pf=${r.kept_pf}  pf_Δ=${r.pf_delta} sum=$${r.kept_sumPnL}`);
    lines.push('');
  }

  fs.writeFileSync(path.join(__dirname, '..', 'output', '02b-entry-filters.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
