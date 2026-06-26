/**
 * Tabulate all engine-run variants vs candJ baseline. Reads every *.json in
 * output/engine-runs and prints a comparison table (the FCFS-honest causal test
 * of each meta-label filter). PnL change is the real cost; PF/WR/Sharpe/DD the
 * quality gain.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'output/engine-runs');

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const rows = [];
for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const s = d.performance?.summary || {};
    const b = d.performance?.basic || {};
    rows.push({
      name: f.replace('.json', ''),
      trades: s.totalTrades, pnl: Math.round(s.totalPnL),
      wr: s.winRate, pf: b.profitFactor, sharpe: s.sharpeRatio, dd: s.maxDrawdown,
      avg: b.avgTrade != null ? +b.avgTrade.toFixed(1) : null,
    });
  } catch (e) { console.error('skip', f, e.message); }
}
// baseline first
const base = rows.find(r => r.name === 'baseline');
rows.sort((a, b) => (a.name === 'baseline' ? -1 : b.name === 'baseline' ? 1 : b.pnl - a.pnl));

const pct = (v, bv) => bv ? `${v >= bv ? '+' : ''}${((v - bv) / bv * 100).toFixed(0)}%` : '';
const H = ['variant', 'trades', 'PnL$', 'ΔPnL', 'WR%', 'PF', 'Sharpe', 'maxDD%', 'avg$'];
const W = [30, 7, 9, 6, 6, 6, 7, 7, 6];
const fmt = (cells) => cells.map((c, i) => String(c).padEnd(W[i])).join(' ');
console.log(fmt(H));
console.log('-'.repeat(W.reduce((a, b) => a + b + 1, 0)));
for (const r of rows) {
  console.log(fmt([
    r.name, r.trades, r.pnl != null ? r.pnl.toLocaleString() : '?',
    base ? pct(r.pnl, base.pnl) : '', r.wr?.toFixed(1), r.pf?.toFixed(2),
    r.sharpe?.toFixed(2), r.dd?.toFixed(2), r.avg,
  ]));
}
// write markdown
const md = ['| variant | trades | PnL | ΔPnL | WR% | PF | Sharpe | maxDD% | avg$ |',
            '|---|--:|--:|--:|--:|--:|--:|--:|--:|'];
for (const r of rows) md.push(`| ${r.name} | ${r.trades} | $${r.pnl?.toLocaleString()} | ${base ? pct(r.pnl, base.pnl) : ''} | ${r.wr?.toFixed(1)} | ${r.pf?.toFixed(2)} | ${r.sharpe?.toFixed(2)} | ${r.dd?.toFixed(2)} | ${r.avg} |`);
fs.writeFileSync(path.join(__dirname, 'output/04-variants-table.md'), md.join('\n'));
console.log('\n[wrote output/04-variants-table.md]');
