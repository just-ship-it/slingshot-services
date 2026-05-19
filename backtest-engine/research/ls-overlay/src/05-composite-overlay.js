/**
 * Phase 5 — Composite overlay (entry filter + LS-aware BE exit)
 *
 * For each strategy, compose:
 *   (a) the best Phase 3 entry filter (or none, if none helped that strategy)
 *   (b) the best Phase 4 LS-BE exit (TF chosen per strategy)
 * Plus a few alternative combos for sensitivity. Re-aggregate metrics,
 * including H1/H2 stability and DD.
 *
 * Composition order:
 *   1. Apply entry filter — drop trades that fail the filter.
 *   2. For remaining trades, apply BE-on-LS-flip exit:
 *      - If pointsAtFlip > 0 and goldExitDir < 0 → BE catches at $0
 *      - Else keep gold's exit.
 *
 * Note: BE eval still uses the heuristic from Phase 4 (no 1s simulation).
 * The heuristic is exact in the special case it covers (gold ends with
 * loss after a profitable flip = price retraced through entry, BE catches).
 *
 * Output:
 *   output/05-composite.json
 *   output/05-composite.txt
 *
 * Run after Phase 4: depends on the 1m primary-by-ts lookup.
 *
 * Run: node research/ls-overlay/src/05-composite-overlay.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..', '..');

const STRATEGIES = ['gex-flip-ivpct', 'gex-lt-3m-crossover', 'gex-level-fade'];
const TF_DELAY_MS = { '1m': 60_000, '3m': 180_000, '15m': 900_000 };
const POINT_VALUE = 20;

const ENTRY_FILTERS = {
  'none': () => true,
  'flip_KEEP_long_1m_flips_6-10':       t => side(t) !== 'long' || bucket(t.flips_in_prev_60m_1m,'fp') === '6-10',
  'lt3m_DROP_long_15m_state_0':         t => !(side(t) === 'long' && t.ls_state_at_entry_15m === 0),
  'lt3m_TREND_align_15m':               t => trendAlignedLong(t,'15m') || trendAlignedShort(t,'15m'),
  'levelfade_DROP_long_3m_bars_6-15':   t => !(side(t) === 'long' && bucket(t.bars_since_last_flip_3m,'bs') === '6-15'),
  'levelfade_DROP_composite':           t => !(side(t)==='long' && bucket(t.bars_since_last_flip_3m,'bs') === '6-15') && !(side(t)==='short' && bucket(t.flips_in_prev_60m_1m,'fp') === '11+'),
  'levelfade_TREND_align_15m':          t => trendAlignedLong(t,'15m') || trendAlignedShort(t,'15m'),
};

const COMBOS = {
  'gex-flip-ivpct': [
    { name: 'BE_1m only',                          filter: 'none',                              exitTf: '1m' },
    { name: 'BE_3m only',                          filter: 'none',                              exitTf: '3m' },
    { name: 'KEEP_flips=6-10 + BE_1m',              filter: 'flip_KEEP_long_1m_flips_6-10',      exitTf: '1m' },
    { name: 'KEEP_flips=6-10 only (filter)',        filter: 'flip_KEEP_long_1m_flips_6-10',      exitTf: null },
  ],
  'gex-lt-3m-crossover': [
    { name: 'BE_1m only',                          filter: 'none',                              exitTf: '1m' },
    { name: 'BE_3m only',                          filter: 'none',                              exitTf: '3m' },
    { name: 'DROP_long_15m_state=0 + BE_1m',       filter: 'lt3m_DROP_long_15m_state_0',        exitTf: '1m' },
    { name: 'DROP_long_15m_state=0 + BE_3m',       filter: 'lt3m_DROP_long_15m_state_0',        exitTf: '3m' },
    { name: 'DROP_long_15m_state=0 only (filter)', filter: 'lt3m_DROP_long_15m_state_0',        exitTf: null },
    { name: 'TREND_align_15m + BE_1m',             filter: 'lt3m_TREND_align_15m',              exitTf: '1m' },
    { name: 'TREND_align_15m only (filter)',       filter: 'lt3m_TREND_align_15m',              exitTf: null },
  ],
  'gex-level-fade': [
    { name: 'BE_1m only',                          filter: 'none',                              exitTf: '1m' },
    { name: 'BE_3m only',                          filter: 'none',                              exitTf: '3m' },
    { name: 'DROP_composite + BE_1m',              filter: 'levelfade_DROP_composite',          exitTf: '1m' },
    { name: 'DROP_composite + BE_3m',              filter: 'levelfade_DROP_composite',          exitTf: '3m' },
    { name: 'DROP_composite only (filter)',        filter: 'levelfade_DROP_composite',          exitTf: null },
    { name: 'DROP_long_3m_bars=6-15 + BE_1m',      filter: 'levelfade_DROP_long_3m_bars_6-15',  exitTf: '1m' },
    { name: 'TREND_align_15m + BE_1m',             filter: 'levelfade_TREND_align_15m',         exitTf: '1m' },
    { name: 'TREND_align_15m only (filter)',       filter: 'levelfade_TREND_align_15m',         exitTf: null },
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
function trendAlignedLong(t, tf) { return side(t)==='long' && t[`ls_state_at_entry_${tf}`] === 1; }
function trendAlignedShort(t, tf) { return side(t)==='short' && t[`ls_state_at_entry_${tf}`] === 0; }

function loadEnriched(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'enriched', `${name}.json`), 'utf-8'));
}

function collectTargets() {
  const targets = new Set();
  for (const strat of STRATEGIES) {
    const trades = loadEnriched(strat);
    for (const t of trades) {
      for (const tf of ['1m','3m','15m']) {
        const flipTs = t[`first_adverse_flip_ts_${tf}`];
        if (flipTs == null) continue;
        targets.add(flipTs + TF_DELAY_MS[tf]);
      }
    }
  }
  return targets;
}

async function load1mPrimaryAt(targets) {
  const filePath = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1m.csv');
  const hourVol = new Map();
  const candidates = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let isFirst = true;
  for await (const line of rl) {
    if (isFirst) { isFirst = false; continue; }
    if (!line) continue;
    const p = line.split(',');
    const tsStr = p[0];
    const symbol = p[9];
    if (!symbol || symbol.includes('-')) continue;
    const m = tsStr.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (!m) continue;
    const ts = Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
    if (ts < 1735689600000) continue;
    const volume = +p[8] || 0;
    const hourKey = Math.floor(ts / 3600000);
    if (!hourVol.has(hourKey)) hourVol.set(hourKey, new Map());
    const h = hourVol.get(hourKey);
    h.set(symbol, (h.get(symbol) || 0) + volume);
    if (targets.has(ts)) {
      const open = +p[4];
      if (!candidates.has(ts)) candidates.set(ts, []);
      candidates.get(ts).push({ symbol, open, volume });
    }
  }
  const out = new Map();
  for (const [ts, bars] of candidates) {
    const hourKey = Math.floor(ts / 3600000);
    const h = hourVol.get(hourKey);
    let primary = '', maxV = -1;
    for (const [sym, v] of h.entries()) { if (v > maxV) { maxV = v; primary = sym; } }
    const match = bars.find(b => b.symbol === primary);
    if (match) out.set(ts, { open: match.open });
  }
  return out;
}

function applyBeOnFlip(trade, tf, primaryByTs) {
  if (!tf) return { netPnL: trade.netPnL, replaced: false };
  const flipTs = trade[`first_adverse_flip_ts_${tf}`];
  if (flipTs == null) return { netPnL: trade.netPnL, replaced: false };
  const exitTsTarget = flipTs + TF_DELAY_MS[tf];
  const bar = primaryByTs.get(exitTsTarget);
  if (!bar) return { netPnL: trade.netPnL, replaced: false };
  const entryPrice = trade.actualEntry ?? trade.entryPrice;
  const isLong = side(trade) === 'long';
  const dir = isLong ? 1 : -1;
  const lsExitPrice = bar.open;
  const pointsAtFlip = (lsExitPrice - entryPrice) * dir;
  const goldExit = trade.actualExit;
  const goldExitDir = (goldExit - entryPrice) * dir;
  if (pointsAtFlip > 0 && goldExitDir < 0) {
    return { netPnL: 0, replaced: true };
  }
  return { netPnL: trade.netPnL, replaced: false };
}

function aggregate(trades) {
  if (!trades.length) return { n:0, sumPnL:0, avg:0, wr:0, pf:0, maxDD:0, maxDDpct:0 };
  const ordered = [...trades].sort((a,b) => a.entryTime - b.entryTime);
  const pnls = ordered.map(t => t.netPnL ?? 0);
  const n = pnls.length;
  const sumPnL = pnls.reduce((s,x)=>s+x, 0);
  const wins = pnls.filter(x => x > 0).length;
  const grossW = pnls.filter(x => x > 0).reduce((s,x)=>s+x, 0);
  const grossL = -pnls.filter(x => x < 0).reduce((s,x)=>s+x, 0);
  const pf = grossL === 0 ? (grossW > 0 ? 99 : 0) : grossW / grossL;
  let eq = 0, peak = 0, maxDD = 0;
  for (const p of pnls) { eq += p; if (eq > peak) peak = eq; const dd = peak - eq; if (dd > maxDD) maxDD = dd; }
  return {
    n,
    sumPnL: +sumPnL.toFixed(2),
    avg: +(sumPnL/n).toFixed(2),
    wr: +(100*wins/n).toFixed(2),
    pf: +pf.toFixed(2),
    maxDD: +maxDD.toFixed(2),
    maxDDpct: +(100 * maxDD / (100000 + Math.max(0, peak))).toFixed(2),
  };
}

function splitH1H2(trades) {
  if (trades.length === 0) return { h1: [], h2: [] };
  const ts = trades.map(t => t.entryTime).sort((a,b) => a-b);
  const mid = ts[Math.floor(ts.length / 2)];
  return { h1: trades.filter(t => t.entryTime < mid), h2: trades.filter(t => t.entryTime >= mid) };
}

(async () => {
  console.log('Phase 5 — Composite overlay\n');
  const targets = collectTargets();
  console.log(`Loading 1m OHLCV (${targets.size.toLocaleString()} targets)...`);
  const primaryByTs = await load1mPrimaryAt(targets);

  const lines = [];
  const results = {};
  lines.push('=== Phase 5 — Composite overlay (entry filter + LS-BE exit) ===\n');

  for (const strat of STRATEGIES) {
    const trades = loadEnriched(strat);
    const baseline = aggregate(trades);
    results[strat] = { baseline, combos: {} };

    lines.push(`# ${strat}`);
    lines.push(`  BASELINE  n=${baseline.n} PnL=$${baseline.sumPnL} avg=$${baseline.avg} PF=${baseline.pf} WR=${baseline.wr}% DD=${baseline.maxDDpct}%`);

    for (const combo of COMBOS[strat]) {
      const filterFn = ENTRY_FILTERS[combo.filter];
      const filtered = trades.filter(filterFn);
      const newTrades = filtered.map(t => {
        const r = applyBeOnFlip(t, combo.exitTf, primaryByTs);
        return { ...t, netPnL: r.netPnL, _replaced: r.replaced };
      });
      const replaced = newTrades.filter(t => t._replaced).length;
      const full = aggregate(newTrades);
      const { h1, h2 } = splitH1H2(newTrades);
      const h1S = aggregate(h1);
      const h2S = aggregate(h2);
      const stable = (h1S.sumPnL > 0 && h2S.sumPnL > 0 && h1S.pf >= 1 && h2S.pf >= 1);

      const pnlDelta = +(full.sumPnL - baseline.sumPnL).toFixed(0);
      const pfDelta = +(full.pf - baseline.pf).toFixed(2);
      const ddDelta = +(full.maxDDpct - baseline.maxDDpct).toFixed(2);

      results[strat].combos[combo.name] = { full, h1: h1S, h2: h2S, stable, replaced, filtered_n: filtered.length };

      lines.push(`  COMBO: ${combo.name}`);
      lines.push(`    n_kept=${full.n}/${baseline.n}  be_repl=${replaced}  PnL=$${full.sumPnL} (Δ$${pnlDelta})  PF=${full.pf} (Δ${pfDelta})  WR=${full.wr}%  DD=${full.maxDDpct}% (Δ${ddDelta}pp)`);
      lines.push(`    H1: n=${h1S.n} PnL=$${h1S.sumPnL} PF=${h1S.pf}   H2: n=${h2S.n} PnL=$${h2S.sumPnL} PF=${h2S.pf}   stable=${stable ? '✓' : '✗'}`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(__dirname,'..','output','05-composite.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(__dirname,'..','output','05-composite.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
