/**
 * Phase 7 — BE-offset sensitivity sweep
 *
 * The Phase 5 winner uses BE+0 (exit at entry on adverse LS flip). For
 * gex-flip-ivpct, the existing structural BE rule uses BE+5. Quick sweep
 * of LS-BE offset values to see if locking a few points of profit changes
 * the picture.
 *
 * BE+offset heuristic (conservative): we say BE+offset catches iff
 *   pointsAtFlip > offset AND goldExitDir < offset
 * — i.e., the BE stop was armed (we were above the lock level) and the
 * gold exit ended below the lock level, so price must have crossed the
 * lock level on its way down.
 *
 * Output:
 *   output/07-be-offset.txt
 *
 * Run: node research/ls-overlay/src/07-be-offset-sweep.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..', '..');

const STRATEGIES = ['gex-flip-ivpct', 'gex-lt-3m-crossover', 'gex-level-fade'];
const TF_DELAY_MS = { '1m': 60_000 };
const POINT_VALUE = 20;
const OFFSETS = [0, 5, 10, 20, 30];

function side(t) { return (t.side || '').toLowerCase(); }
function loadEnriched(name) { return JSON.parse(fs.readFileSync(path.join(__dirname,'..','enriched',`${name}.json`), 'utf-8')); }

function collectTargets() {
  const targets = new Set();
  for (const strat of STRATEGIES) {
    for (const t of loadEnriched(strat)) {
      const flipTs = t.first_adverse_flip_ts_1m;
      if (flipTs == null) continue;
      targets.add(flipTs + TF_DELAY_MS['1m']);
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
    const tsStr = p[0]; const symbol = p[9];
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

function applyBeWithOffset(trade, primaryByTs, offset) {
  const flipTs = trade.first_adverse_flip_ts_1m;
  if (flipTs == null) return { netPnL: trade.netPnL, replaced: false };
  const exitTsTarget = flipTs + TF_DELAY_MS['1m'];
  const bar = primaryByTs.get(exitTsTarget);
  if (!bar) return { netPnL: trade.netPnL, replaced: false };
  const entryPrice = trade.actualEntry ?? trade.entryPrice;
  const isLong = side(trade) === 'long';
  const dir = isLong ? 1 : -1;
  const lsExitPrice = bar.open;
  const pointsAtFlip = (lsExitPrice - entryPrice) * dir;
  const goldExit = trade.actualExit;
  const goldExitDir = (goldExit - entryPrice) * dir;
  // BE armed when pointsAtFlip > offset. BE caught iff goldExitDir < offset.
  if (pointsAtFlip > offset && goldExitDir < offset) {
    return { netPnL: offset * POINT_VALUE * (trade.quantity || 1), replaced: true };
  }
  return { netPnL: trade.netPnL, replaced: false };
}

function aggregate(trades) {
  if (!trades.length) return { n:0, sumPnL:0, pf:0, maxDDpct:0 };
  const ordered = [...trades].sort((a,b) => a.entryTime - b.entryTime);
  const pnls = ordered.map(t => t.netPnL ?? 0);
  const sumPnL = pnls.reduce((s,x)=>s+x, 0);
  const grossW = pnls.filter(x => x > 0).reduce((s,x)=>s+x, 0);
  const grossL = -pnls.filter(x => x < 0).reduce((s,x)=>s+x, 0);
  const pf = grossL === 0 ? (grossW > 0 ? 99 : 0) : grossW / grossL;
  let eq = 0, peak = 0, maxDD = 0;
  for (const p of pnls) { eq += p; if (eq > peak) peak = eq; const dd = peak - eq; if (dd > maxDD) maxDD = dd; }
  return { n: pnls.length, sumPnL: +sumPnL.toFixed(2), pf: +pf.toFixed(2), maxDDpct: +(100 * maxDD / (100000 + Math.max(0, peak))).toFixed(2) };
}

(async () => {
  console.log('Phase 7 — BE offset sensitivity sweep (LS_1m flip)\n');
  const targets = collectTargets();
  const primaryByTs = await load1mPrimaryAt(targets);

  const lines = [];
  lines.push('=== Phase 7 — BE+offset sensitivity (LS_1m flip) ===\n');
  lines.push(`${'strategy'.padEnd(22)} ${'offset'.padStart(6)} ${'replaced'.padStart(8)} ${'sumPnL'.padStart(10)} ${'PF'.padStart(6)} ${'DD%'.padStart(6)}`);

  for (const strat of STRATEGIES) {
    const trades = loadEnriched(strat);
    const base = aggregate(trades);
    lines.push(`${strat.padEnd(22)} ${'gold'.padStart(6)} ${String('—').padStart(8)} ${String(base.sumPnL).padStart(10)} ${String(base.pf).padStart(6)} ${String(base.maxDDpct).padStart(6)}`);
    for (const off of OFFSETS) {
      const sim = trades.map(t => {
        const r = applyBeWithOffset(t, primaryByTs, off);
        return { ...t, netPnL: r.netPnL, _replaced: r.replaced };
      });
      const replaced = sim.filter(t => t._replaced).length;
      const agg = aggregate(sim);
      lines.push(`${strat.padEnd(22)} ${String('+'+off).padStart(6)} ${String(replaced).padStart(8)} ${String(agg.sumPnL).padStart(10)} ${String(agg.pf).padStart(6)} ${String(agg.maxDDpct).padStart(6)}`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(__dirname,'..','output','07-be-offset.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
