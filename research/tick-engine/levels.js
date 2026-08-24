/**
 * Level registry — every externally-defined price level we can align to the 1s cache, with the
 * knowability rule applied at load time (a level may only be used at or after the instant it became
 * observable; all lookups are at-or-before with a staleness cap).
 *
 *   LT   backtest-engine/data/liquidity/<prod>/  — 15m cadence, level_1..5 (RAW contract prices)
 *   GEX  backtest-engine/data/gex/nq/ (causal)   — 15m snapshots: call_wall, put_wall, gamma_flip,
 *                                                  resistance[5], support[5], total_gex, regime
 *   IND  computed from the cache itself — EMA/WMA/ATR bands, session levels
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

/** LT levels → [{ts(sec), levels:[5], sentiment}] sorted. Knowable AT the stamp (live-captured). */
export function loadLT(product) {
  const p = path.join(ROOT, `backtest-engine/data/liquidity/${product.toLowerCase()}`,
                      product === 'NQ' ? 'NQ_liquidity_levels.csv' : 'ES_liquidity_levels_15m.csv');
  if (!fs.existsSync(p)) return [];
  const out = [];
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const hdr = lines[0].split(',');
  const iTs = hdr.indexOf('unix_timestamp');
  const iL = [1, 2, 3, 4, 5].map((k) => hdr.indexOf(`level_${k}`)).filter((x) => x >= 0);
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    if (f.length < 3) continue;
    const ts = Math.floor(+f[iTs] / 1000);
    const levels = iL.map((j) => +f[j]).filter((x) => Number.isFinite(x) && x > 0);
    if (ts && levels.length) out.push({ ts, levels });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** GEX snapshots → [{ts, spot, callWall, putWall, gammaFlip, resistance[], support[], totalGex,
 *   gammaImbalance, regime}] sorted. Files are the CAUSAL regeneration (prev-day close source). */
export function loadGEX(product) {
  const dir = path.join(ROOT, `backtest-engine/data/gex/${product.toLowerCase()}`);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const fn of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8')); } catch { continue; }
    for (const s of j.data || []) {
      const ts = Math.floor(Date.parse(s.timestamp) / 1000);
      if (!ts) continue;
      out.push({ ts, spot: s.nq_spot ?? s.es_spot ?? null, callWall: s.call_wall, putWall: s.put_wall,
                 gammaFlip: s.gamma_flip, resistance: s.resistance || [], support: s.support || [],
                 totalGex: s.total_gex, gammaImbalance: s.gamma_imbalance, regime: s.regime });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** at-or-before lookup with a staleness cap (knowability rule 1). */
export function asOf(rows, ts, maxStaleSec = 3600) {
  let lo = 0, hi = rows.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].ts <= ts) { best = m; lo = m + 1; } else hi = m - 1; }
  if (best < 0) return null;
  const r = rows[best];
  return ts - r.ts <= maxStaleSec ? r : null;
}
