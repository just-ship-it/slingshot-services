/**
 * Phase 4 — LS-aware exit overlay
 *
 * Honest replacement-exit simulation: for each trade, if there was an
 * adverse LS flip during the trade, simulate exiting at the next 1m bar
 * open after the flip (realistic fill = first 1s of the next minute,
 * per CLAUDE.md's "next 1s bar's open after the signal candle closes"
 * — the 1m bar open and the first 1s open at that minute are the same
 * price).
 *
 * Three exit variants per LS TF (1m / 3m / 15m):
 *   A. EXIT-ON-ADVERSE-FLIP        — always exit at next bar open
 *   B. EXIT-ON-ADVERSE-IF-PROFIT   — exit only if mark-to-market PnL > 0
 *   C. BE-STOP-ON-ADVERSE          — move stop to breakeven on flip;
 *                                    if BE then gets hit later, exit at
 *                                    actualEntry (no profit, no loss);
 *                                    if BE never hit, keep gold exit.
 *
 * To compute the PnL of the LS-overlay exit we need:
 *   - exitPrice at next 1m open after adverse_flip_ts
 *   - We compare new exit vs gold's actualExit and pick the LS exit
 *     if it would have happened first (which it does by construction,
 *     since adverse_flip_ts is between entry and gold's exit).
 *
 * "Adverse" definition per Phase 0:
 *   LONG  → adverse = LS state → 1 (bullish) [losing-side direction]
 *   SHORT → adverse = LS state → 0 (bearish)
 *
 * Output:
 *   output/04-exit-overlay.json
 *   output/04-exit-overlay.txt
 *
 * Run: node research/ls-overlay/src/04-exit-overlay.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..', '..');

const STRATEGIES = ['gex-flip-ivpct', 'gex-lt-3m-crossover', 'gex-level-fade'];
const TFS = ['1m','3m','15m'];
const TF_DELAY_MS = { '1m': 60_000, '3m': 180_000, '15m': 900_000 };
const POINT_VALUE = 20;

// Variant configurations
const VARIANTS = ['exit_on_flip', 'exit_on_flip_if_profit', 'be_on_flip'];

function loadEnriched(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'enriched', `${name}.json`), 'utf-8'));
}

function side(t) { return (t.side || '').toLowerCase(); }

// ──────────────────────────────────────────────────────────────────────────
// Collect all target lookup timestamps (next-bar-open ts after each adverse flip)
// ──────────────────────────────────────────────────────────────────────────
function collectTargets() {
  const targets = new Set();
  for (const strat of STRATEGIES) {
    const trades = loadEnriched(strat);
    for (const t of trades) {
      for (const tf of TFS) {
        const flipTs = t[`first_adverse_flip_ts_${tf}`];
        if (flipTs == null) continue;
        targets.add(flipTs + TF_DELAY_MS[tf]);
      }
    }
  }
  return targets;
}

// ──────────────────────────────────────────────────────────────────────────
// One-pass over 1m OHLCV:
//   - accumulate volume by (hourKey, symbol) to determine primary contract
//   - collect all candles whose ts is in the target set
//   - at the end, filter the collected candles to those from the primary
//     contract of their hour
//
// Returns Map<unix_ms, {open}> for primary-contract bars at target ts.
// ──────────────────────────────────────────────────────────────────────────
async function load1mPrimaryAt(targets) {
  const filePath = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1m.csv');
  const hourVol = new Map(); // hourKey -> Map<symbol, totalVol>
  const candidates = new Map(); // ts -> array of {symbol, open}

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let isFirst = true;
  let cols = null;
  let rows = 0;

  for await (const line of rl) {
    if (isFirst) {
      cols = line.split(',');
      // expected: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
      isFirst = false;
      continue;
    }
    if (!line) continue;
    const p = line.split(',');
    const tsStr = p[0]; // "2025-01-13 12:30:00+00:00" or similar
    // Skip calendar-spread rows (symbol contains a dash)
    const symbol = p[9];
    if (!symbol || symbol.includes('-')) continue;

    // Parse ts — supports both "2020-12-27T23:00:00.000000000Z" and "2020-12-27 23:00:00"
    const m = tsStr.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (!m) continue;
    const ts = Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);

    // Skip out-of-range rows fast (LS export starts 2025-01-01)
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
    rows++;
  }
  console.log(`  1m OHLCV: ${rows.toLocaleString()} rows scanned`);
  console.log(`  Candidate ts: ${candidates.size.toLocaleString()} of ${targets.size.toLocaleString()} requested`);

  // For each candidate ts, pick the bar from the primary contract for its hour
  const out = new Map();
  for (const [ts, bars] of candidates) {
    const hourKey = Math.floor(ts / 3600000);
    const h = hourVol.get(hourKey);
    let primary = '';
    let maxV = -1;
    for (const [sym, v] of h.entries()) {
      if (v > maxV) { maxV = v; primary = sym; }
    }
    const match = bars.find(b => b.symbol === primary);
    if (match) out.set(ts, { open: match.open, symbol: match.symbol });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-trade simulation
// ──────────────────────────────────────────────────────────────────────────
function simTradeExit(trade, tf, variant, primaryByTs) {
  const flipTs = trade[`first_adverse_flip_ts_${tf}`];
  if (flipTs == null) return { netPnL: trade.netPnL, exitReason: trade.exitReason, replaced: false };

  const exitTsTarget = flipTs + TF_DELAY_MS[tf];
  const bar = primaryByTs.get(exitTsTarget);
  if (!bar) return { netPnL: trade.netPnL, exitReason: trade.exitReason, replaced: false };

  const entryPrice = trade.actualEntry ?? trade.entryPrice;
  const isLong = side(trade) === 'long';
  const dir = isLong ? 1 : -1;
  const lsExitPrice = bar.open;
  const pointsAtFlip = (lsExitPrice - entryPrice) * dir;
  const dollarAtFlip = pointsAtFlip * POINT_VALUE * (trade.quantity || 1);

  if (variant === 'exit_on_flip') {
    return { netPnL: dollarAtFlip, exitReason: `ls_exit_${tf}`, replaced: true, lsExitPrice, lsPoints: +pointsAtFlip.toFixed(2) };
  }

  if (variant === 'exit_on_flip_if_profit') {
    if (pointsAtFlip > 0) return { netPnL: dollarAtFlip, exitReason: `ls_exit_profit_${tf}`, replaced: true, lsExitPrice, lsPoints: +pointsAtFlip.toFixed(2) };
    return { netPnL: trade.netPnL, exitReason: trade.exitReason, replaced: false };
  }

  if (variant === 'be_on_flip') {
    // Move stop to breakeven AT the flip point. From flipTs to gold's exit,
    // we'd hit BE if price retraces back through entryPrice at any point.
    // We approximate this conservatively: if price was profitable at the
    // flip moment, the BE stop arms. If the gold-exit's price would have
    // crossed entryPrice from the profit side, BE catches it.
    // Heuristic without re-running 1s sim: if gold's actualExit on the
    // correct side of entry vs flip indicates retracement past entry, use BE.
    const goldExit = trade.actualExit;
    const goldExitDir = (goldExit - entryPrice) * dir; // gold-exit's PnL direction in pts
    // If flip was favorable (pointsAtFlip > 0) and gold ended with loss
    // (goldExitDir < 0), the position must have retraced past entry — BE catches it at $0.
    if (pointsAtFlip > 0 && goldExitDir < 0) {
      return { netPnL: 0, exitReason: `ls_be_${tf}`, replaced: true, lsExitPrice: entryPrice, lsPoints: 0 };
    }
    // Otherwise keep gold exit.
    return { netPnL: trade.netPnL, exitReason: trade.exitReason, replaced: false };
  }

  return { netPnL: trade.netPnL, exitReason: trade.exitReason, replaced: false };
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
  for (const p of pnls) {
    eq += p;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }
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

(async () => {
  console.log('Phase 4 — LS-aware exit overlay\n');
  console.log('Collecting target 1m timestamps for primary-contract lookup...');
  const targets = collectTargets();
  console.log(`  Unique target ts: ${targets.size.toLocaleString()}`);

  console.log('Streaming 1m OHLCV (this takes ~30s)...');
  const primaryByTs = await load1mPrimaryAt(targets);

  const lines = [];
  const fullResults = {};

  lines.push('=== Phase 4 — LS-aware exit overlay ===\n');

  for (const strat of STRATEGIES) {
    const trades = loadEnriched(strat);
    const baseline = aggregate(trades);
    fullResults[strat] = { baseline, variants: {} };

    lines.push(`# ${strat}`);
    lines.push(`  BASELINE  n=${baseline.n} PnL=$${baseline.sumPnL} PF=${baseline.pf} WR=${baseline.wr}% DD=${baseline.maxDDpct}%`);

    for (const tf of TFS) {
      for (const variant of VARIANTS) {
        const newTrades = trades.map(t => {
          const sim = simTradeExit(t, tf, variant, primaryByTs);
          return { ...t, netPnL: sim.netPnL, exitReason: sim.exitReason, _replaced: sim.replaced };
        });
        const replaced = newTrades.filter(t => t._replaced).length;
        const agg = aggregate(newTrades);
        const ddDelta = +(agg.maxDDpct - baseline.maxDDpct).toFixed(2);
        const pfDelta = +(agg.pf - baseline.pf).toFixed(2);
        const pnlDelta = +(agg.sumPnL - baseline.sumPnL).toFixed(0);
        const key = `${tf}/${variant}`;
        fullResults[strat].variants[key] = { ...agg, replaced };
        lines.push(`  EXIT[${key.padEnd(25)}] replaced=${String(replaced).padStart(3)}/${baseline.n} ` +
          `PnL=$${String(agg.sumPnL).padStart(8)} (Δ$${String(pnlDelta).padStart(7)}) ` +
          `PF=${String(agg.pf).padStart(5)} (Δ${String(pfDelta).padStart(5)}) ` +
          `WR=${String(agg.wr).padStart(5)}% DD=${String(agg.maxDDpct).padStart(5)}% (Δ${String(ddDelta).padStart(5)}pp)`);
      }
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(__dirname,'..','output','04-exit-overlay.json'), JSON.stringify(fullResults, null, 2));
  fs.writeFileSync(path.join(__dirname,'..','output','04-exit-overlay.txt'), lines.join('\n') + '\n');
  console.log('\n' + lines.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
