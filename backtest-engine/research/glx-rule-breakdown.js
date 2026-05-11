/**
 * Quick per-rule breakdown for gex-lt-3m-crossover backtest output.
 * Reads the trades JSON the engine writes and aggregates by rule_id.
 *
 * Usage: node research/glx-rule-breakdown.js <path-to-trades.json>
 */
import fs from 'fs';

const path = process.argv[2];
if (!path) { console.error('Usage: node glx-rule-breakdown.js <trades.json>'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
const trades = Array.isArray(raw) ? raw : (raw.trades || []);
console.log(`Total trades: ${trades.length}`);

const groups = new Map();
for (const t of trades) {
  const id = t.signal?.ruleId || t.signal?.rule_id || 'UNKNOWN';
  if (!groups.has(id)) groups.set(id, []);
  groups.get(id).push(t);
}

const rows = [];
for (const [rule, arr] of groups) {
  const pnl = arr.map(t => t.netPnL ?? t.netPnl ?? t.pnl ?? 0);
  const wins = pnl.filter(v => v > 0).length;
  const sumW = pnl.filter(v => v > 0).reduce((s, v) => s + v, 0);
  const sumL = pnl.filter(v => v < 0).reduce((s, v) => s + v, 0);
  const total = pnl.reduce((s, v) => s + v, 0);
  const tpHits = arr.filter(t => (t.exitReason || '').toLowerCase().includes('take')).length;
  const slHits = arr.filter(t => (t.exitReason || '').toLowerCase().includes('stop_loss') || (t.exitReason || '').toLowerCase().includes('stop loss')).length;
  const eodHits = arr.filter(t => (t.exitReason || '').toLowerCase().includes('eod') || (t.exitReason || '').toLowerCase().includes('market_close') || (t.exitReason || '').toLowerCase().includes('market close')).length;
  const maxHoldHits = arr.filter(t => (t.exitReason || '').toLowerCase().includes('max_hold') || (t.exitReason || '').toLowerCase().includes('max hold')).length;
  rows.push({
    rule, n: arr.length, total, mean: total / arr.length,
    win: wins / arr.length, pf: sumL < 0 ? sumW / Math.abs(sumL) : Infinity,
    tpHits, slHits, eodHits, maxHoldHits,
  });
}
rows.sort((a, b) => b.total - a.total);

console.log('rule'.padEnd(14), 'n'.padStart(5), 'total$'.padStart(10), 'mean$'.padStart(8),
  'win%'.padStart(6), 'pf'.padStart(6), 'tp'.padStart(4), 'sl'.padStart(4),
  'maxH'.padStart(5), 'eod'.padStart(4));
for (const r of rows) {
  console.log(r.rule.padEnd(14), String(r.n).padStart(5),
    r.total.toFixed(0).padStart(10), r.mean.toFixed(0).padStart(8),
    (100 * r.win).toFixed(1).padStart(6),
    (isFinite(r.pf) ? r.pf.toFixed(2) : '∞').padStart(6),
    String(r.tpHits).padStart(4), String(r.slHits).padStart(4),
    String(r.maxHoldHits).padStart(5), String(r.eodHits).padStart(4));
}
