/**
 * Phase 3 — Apply top filter rules and check H1/H2 stability
 *
 * For each strategy, take a curated short list of candidate entry-time
 * filter rules from Phase 2b, apply each to the full gold-standard trade
 * sequence (chronologically ordered), and compute:
 *   - Full-window: n, sumPnL, avg, WR, PF, MaxDD, MaxDD% of $100k acct
 *   - H1 (first half of date range) + H2 (second half): same metrics
 *   - Stability flag: do H1 and H2 both show net PnL > 0 and PF >= 1?
 *
 * For DD: walk the trades in chronological order, accumulate equity,
 * track running max-equity and running drawdown.
 *
 * Output:
 *   output/03-filter-sim.json — full per-rule results
 *   output/03-filter-sim.txt — readable comparison vs baseline
 *
 * Run: node research/ls-overlay/src/03-filter-sim.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STRATEGIES = ['gex-flip-ivpct', 'gex-lt-3m-crossover', 'gex-level-fade'];
const INITIAL_CAPITAL = 100000; // for DD % calc

const RULES = {
  'gex-flip-ivpct': [
    // KEEP rules (narrow to one cell)
    { name: 'KEEP all/1m/flips_in_prev_60m=6-10', test: t => bucket(t.flips_in_prev_60m_1m, 'fp') === '6-10' },
    { name: 'KEEP long/1m/flips_in_prev_60m=6-10', test: t => side(t) === 'long' && bucket(t.flips_in_prev_60m_1m, 'fp') === '6-10' ? true : side(t) !== 'long' },
    // Composite: keep flips=6-10 OR shorts with bars_since_last_flip_15m=60+
    { name: 'KEEP (flips_1m=6-10) OR (short & bars_since_flip_15m=60+)', test: t =>
        (bucket(t.flips_in_prev_60m_1m, 'fp') === '6-10') ||
        (side(t) === 'short' && bucket(t.bars_since_last_flip_15m, 'bs') === '60+')
    },
    // Same with all/3m as alternate TF
    { name: 'KEEP all/3m/flips_in_prev_60m=6-10', test: t => bucket(t.flips_in_prev_60m_3m, 'fp') === '6-10' },
    // Drop the worst cells (entry-only)
    { name: 'DROP all/1m/flips_in_prev_60m=11+',  test: t => bucket(t.flips_in_prev_60m_1m, 'fp') !== '11+' },
  ],
  'gex-lt-3m-crossover': [
    { name: 'DROP long/15m/state=0',                          test: t => !(side(t)==='long'  && t.ls_state_at_entry_15m === 0) },
    { name: 'KEEP long/15m/state=1 (only)',                   test: t => side(t)==='long' ? t.ls_state_at_entry_15m === 1 : true },
    { name: 'TREND-align both sides on 15m',                  test: t => trendAlignedLong(t, '15m') || trendAlignedShort(t, '15m') },
    { name: 'TREND-align both sides on 3m',                   test: t => trendAlignedLong(t, '3m')  || trendAlignedShort(t, '3m')  },
    { name: 'TREND-align (15m AND 3m)',                       test: t => (trendAlignedLong(t,'15m') && trendAlignedLong(t,'3m'))  || (trendAlignedShort(t,'15m') && trendAlignedShort(t,'3m')) },
  ],
  'gex-level-fade': [
    { name: 'KEEP short/15m/state=0 (only)',                  test: t => side(t)==='short' ? t.ls_state_at_entry_15m === 0 : true },
    { name: 'KEEP long/1m/state=1 + short/15m/state=0',       test: t => (side(t)==='long' && t.ls_state_at_entry_1m === 1) || (side(t)==='short' && t.ls_state_at_entry_15m === 0) },
    { name: 'TREND-align both sides on 15m',                  test: t => trendAlignedLong(t, '15m') || trendAlignedShort(t, '15m') },
    { name: 'TREND-align both sides on 3m',                   test: t => trendAlignedLong(t, '3m')  || trendAlignedShort(t, '3m')  },
    { name: 'TREND-align both sides on 1m',                   test: t => trendAlignedLong(t, '1m')  || trendAlignedShort(t, '1m')  },
    { name: 'TREND-align (15m AND 3m)',                       test: t => (trendAlignedLong(t,'15m') && trendAlignedLong(t,'3m'))  || (trendAlignedShort(t,'15m') && trendAlignedShort(t,'3m')) },
    { name: 'DROP long/3m/bars_since_last_flip=6-15',         test: t => !(side(t)==='long'  && bucket(t.bars_since_last_flip_3m, 'bs') === '6-15') },
    { name: 'DROP short/1m/flips_in_prev_60m=11+',            test: t => !(side(t)==='short' && bucket(t.flips_in_prev_60m_1m,    'fp') === '11+') },
    // Composite DROP: combine drop bad-LONGs + drop bad-SHORTs
    { name: 'DROP (long/3m/bars=6-15) + (short/1m/flips=11+)', test: t => !(side(t)==='long' && bucket(t.bars_since_last_flip_3m,'bs') === '6-15') && !(side(t)==='short' && bucket(t.flips_in_prev_60m_1m, 'fp') === '11+') },
  ],
};

function side(t) { return (t.side || '').toLowerCase(); }

function bucket(v, kind) {
  if (v == null) return 'na';
  if (kind === 'bs') {
    if (v === 0) return '0';
    if (v <= 5) return '1-5';
    if (v <= 15) return '6-15';
    if (v <= 60) return '16-60';
    return '60+';
  } else if (kind === 'fp') {
    if (v <= 2) return '0-2';
    if (v <= 5) return '3-5';
    if (v <= 10) return '6-10';
    return '11+';
  }
  return 'na';
}

// "Trend-aligned" = LONG with LS bullish, or SHORT with LS bearish.
function trendAlignedLong(t, tf) {
  return side(t) === 'long' && t[`ls_state_at_entry_${tf}`] === 1;
}
function trendAlignedShort(t, tf) {
  return side(t) === 'short' && t[`ls_state_at_entry_${tf}`] === 0;
}

function compute(trades) {
  if (!trades.length) return { n:0, sumPnL:0, avg:0, wr:0, pf:0, maxDD:0, maxDDpct:0 };
  // Order chronologically by entryTime
  const ordered = [...trades].sort((a,b) => a.entryTime - b.entryTime);
  const n = ordered.length;
  const pnls = ordered.map(t => t.netPnL ?? 0);
  const sumPnL = pnls.reduce((s,x) => s + x, 0);
  const wins = pnls.filter(x => x > 0).length;
  const grossW = pnls.filter(x => x > 0).reduce((s,x) => s + x, 0);
  const grossL = -pnls.filter(x => x < 0).reduce((s,x) => s + x, 0);
  const pf = grossL === 0 ? (grossW > 0 ? 99 : 0) : grossW / grossL;

  // DD walk
  let eq = 0, peak = 0, maxDD = 0;
  for (const p of pnls) {
    eq += p;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDDpct = INITIAL_CAPITAL > 0 ? 100 * maxDD / (INITIAL_CAPITAL + Math.max(0, peak)) : 0;

  return {
    n,
    sumPnL: +sumPnL.toFixed(2),
    avg: +(sumPnL/n).toFixed(2),
    wr: +(100*wins/n).toFixed(2),
    pf: +pf.toFixed(2),
    maxDD: +maxDD.toFixed(2),
    maxDDpct: +maxDDpct.toFixed(2),
  };
}

function splitH1H2(trades) {
  if (trades.length === 0) return { h1: [], h2: [] };
  const ts = trades.map(t => t.entryTime).sort((a,b) => a - b);
  const mid = ts[Math.floor(ts.length / 2)];
  const h1 = trades.filter(t => t.entryTime <  mid);
  const h2 = trades.filter(t => t.entryTime >= mid);
  return { h1, h2 };
}

(async () => {
  const results = {};
  const lines = [];
  lines.push('=== Phase 3 — Filter sim with H1/H2 stability + DD ===');
  lines.push('');

  for (const strat of STRATEGIES) {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname,'..','enriched',`${strat}.json`), 'utf-8'));
    const baseFull = compute(all);
    const { h1: baseH1, h2: baseH2 } = splitH1H2(all);
    const baseStatsH1 = compute(baseH1);
    const baseStatsH2 = compute(baseH2);

    results[strat] = { baseline: { full: baseFull, h1: baseStatsH1, h2: baseStatsH2 }, rules: {} };

    lines.push(`# ${strat}`);
    lines.push(`  BASELINE  full: n=${baseFull.n} PnL=$${baseFull.sumPnL} PF=${baseFull.pf} WR=${baseFull.wr}% DD=$${baseFull.maxDD} (${baseFull.maxDDpct}%)`);
    lines.push(`            H1:   n=${baseStatsH1.n} PnL=$${baseStatsH1.sumPnL} PF=${baseStatsH1.pf} WR=${baseStatsH1.wr}%`);
    lines.push(`            H2:   n=${baseStatsH2.n} PnL=$${baseStatsH2.sumPnL} PF=${baseStatsH2.pf} WR=${baseStatsH2.wr}%`);

    for (const rule of RULES[strat] || []) {
      const kept = all.filter(rule.test);
      const full = compute(kept);
      const { h1, h2 } = splitH1H2(kept);
      const statsH1 = compute(h1);
      const statsH2 = compute(h2);

      const stableH1 = statsH1.sumPnL > 0 && statsH1.pf >= 1;
      const stableH2 = statsH2.sumPnL > 0 && statsH2.pf >= 1;
      const stable = stableH1 && stableH2;

      results[strat].rules[rule.name] = { full, h1: statsH1, h2: statsH2, stable };

      const ddDelta = +(full.maxDDpct - baseFull.maxDDpct).toFixed(2);
      const pfDelta = +(full.pf - baseFull.pf).toFixed(2);
      const pnlDelta = +(full.sumPnL - baseFull.sumPnL).toFixed(0);
      const stbl = stable ? '✓' : (stableH1 ? 'H1' : (stableH2 ? 'H2' : '✗'));
      lines.push(`  RULE: ${rule.name}`);
      lines.push(`        full: n=${full.n} PnL=$${full.sumPnL} (Δ$${pnlDelta}) PF=${full.pf} (Δ${pfDelta}) WR=${full.wr}% DD=$${full.maxDD} (${full.maxDDpct}% Δ${ddDelta}pp)`);
      lines.push(`        H1:   n=${statsH1.n} PnL=$${statsH1.sumPnL} PF=${statsH1.pf} WR=${statsH1.wr}%   H2: n=${statsH2.n} PnL=$${statsH2.sumPnL} PF=${statsH2.pf} WR=${statsH2.wr}%   stability=${stbl}`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(__dirname,'..','output','03-filter-sim.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(__dirname,'..','output','03-filter-sim.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
