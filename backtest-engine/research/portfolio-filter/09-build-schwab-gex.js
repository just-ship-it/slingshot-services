#!/usr/bin/env node
/**
 * Convert LIVE Schwab GEX (data/schwab-walls/, QQQ price space, ExposureCalculator output —
 * the source production actually publishes) into the exact nq-cbbo JSON schema (NQ price
 * space) so the backtest engine can load it via --gex-dir and run the real strategies on it.
 * QQQ→NQ via the same-day multiplier from nq-cbbo. Only days present in BOTH sources.
 * Output: data/gex/nq-schwab/nq_gex_YYYY-MM-DD.json
 *
 * node research/portfolio-filter/09-build-schwab-gex.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WALLS = path.join(ROOT, 'data/schwab-walls');
const CBBO = path.join(ROOT, 'data/gex/nq-cbbo');
const OUT = path.join(ROOT, 'data/gex/nq-schwab');
fs.mkdirSync(OUT, { recursive: true });

const wallsDates = fs.readdirSync(WALLS).map(f => (f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1]).filter(Boolean);
const cbboHas = d => fs.existsSync(path.join(CBBO, `nq_gex_${d}.json`));
const dates = [...new Set(wallsDates)].filter(cbboHas).sort();
console.log(`overlap days (walls ∩ cbbo): ${dates.length} — ${dates.join(' ')}\n`);

let wrote = 0;
for (const d of dates) {
  const walls = JSON.parse(fs.readFileSync(path.join(WALLS, `qqq_walls_${d}.json`), 'utf8'));
  const cbbo = JSON.parse(fs.readFileSync(path.join(CBBO, `nq_gex_${d}.json`), 'utf8'));
  // same-day multiplier (QQQ→NQ), constant per day; median of cbbo's
  const mults = cbbo.data.map(s => s.multiplier).filter(Number.isFinite).sort((a, b) => a - b);
  const mult = mults[Math.floor(mults.length / 2)] || (cbbo.data[0]?.nq_spot / cbbo.data[0]?.qqq_spot);
  const px = v => (Number.isFinite(v) ? +(v * mult).toFixed(2) : null);
  const data = walls.data.map(s => ({
    timestamp: s.timestamp,
    nq_spot: px(s.qqq_spot), qqq_spot: s.qqq_spot, multiplier: mult,
    gamma_flip: px(s.gamma_flip),
    call_wall: px(s.call_wall), call_wall_gex: null,
    put_wall: px(s.put_wall), put_wall_gex: null,
    total_gex: s.total_gex, total_vex: s.total_vex ?? null, total_cex: s.total_cex ?? null,
    gamma_above_spot: null, gamma_below_spot: null, gamma_imbalance: null,
    resistance: (s.resistance || []).map(px), resistance_gex: null,
    support: (s.support || []).map(px), support_gex: null,
    regime: s.regime, options_count: s.options_count ?? null,
  }));
  const out = { metadata: { symbol: 'NQ', source_symbol: 'QQQ', date: d, iv_source: 'schwab-live', multiplier: mult, snapshots: data.length, note: 'Converted from data/schwab-walls (live ExposureCalculator) for live-vs-backtest comparison' }, data };
  fs.writeFileSync(path.join(OUT, `nq_gex_${d}.json`), JSON.stringify(out));
  console.log(`  ${d}  mult ${mult.toFixed(2)}  ${data.length} snaps  regime mix ${data.filter(x=>x.total_gex>=0).length}+/${data.filter(x=>x.total_gex<0).length}-`);
  wrote++;
}
console.log(`\n✓ wrote ${wrote} Schwab-GEX files (nq-cbbo schema) → data/gex/nq-schwab/`);
