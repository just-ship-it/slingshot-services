/**
 * Phase 1b CORRECTED — LT level dynamics in RAW price space.
 *
 * Bug in 07: used `sentiment_raw` (= continuous close + ~210, a DIFFERENT space) as
 * spot vs RAW levels → ~950pt offset → garbage (93% "levels below spot", phantom
 * nearAbove edge). VERIFIED: 1m LT levels are RAW contract (level_1 − raw close = −30,
 * raw_contract matches). Correct spot = RAW primary close (same space the trades use).
 *
 * Lookback dynamics restricted to a single raw_contract (no cross-rollover windows).
 * Out: output/lt-dynamics-raw-features.csv
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENG = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'output');
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ---- raw primary close map (filterPrimaryContract over window) ----
const FRONT = /^NQ[FGHJKMNQUVXZ]\d$/;
const WIN_LO = Date.parse('2024-12-01T00:00:00Z'), WIN_HI = Date.parse('2026-05-15T00:00:00Z');
log('streaming raw 1m for primary close…');
const rawRows = [];
{
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(ENG, 'data/ohlcv/nq/NQ_ohlcv_1m.csv')), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; }
    if (!line) continue;
    const c = line.split(',');
    const sym = c[9]; if (!FRONT.test(sym)) continue;
    const ts = Date.parse(c[0]); if (!(ts >= WIN_LO && ts < WIN_HI)) continue;
    rawRows.push({ ts, cl: +c[7], v: +c[8], sym });
  }
}
const hv = new Map();
for (const r of rawRows) { const h = Math.floor(r.ts / 3.6e6); let m = hv.get(h); if (!m) { m = new Map(); hv.set(h, m); } m.set(r.sym, (m.get(r.sym) || 0) + r.v); }
const primSym = new Map();
for (const [h, m] of hv) { let b = '', bv = -1; for (const [s, v] of m) if (v > bv) { bv = v; b = s; } primSym.set(h, b); }
const rawClose = new Map(); // ts -> {cl,sym}
for (const r of rawRows) if (primSym.get(Math.floor(r.ts / 3.6e6)) === r.sym) rawClose.set(r.ts, { cl: r.cl, sym: r.sym });
log(`raw primary closes: ${rawClose.size}`);

// ---- 1m LT levels (raw) ----
const LT = [];
{
  const txt = fs.readFileSync(path.join(ENG, 'research/lt-extraction/output/nq_lt_1m_raw.csv'), 'utf8').split('\n');
  for (let i = 1; i < txt.length; i++) {
    const c = txt[i].split(','); if (!c[1]) continue;
    const levels = [c[3], c[4], c[5], c[6], c[7]].map(Number).filter(x => Number.isFinite(x) && x > 0);
    if (!levels.length) continue;
    const rc = rawClose.get(+c[1]);
    if (!rc) continue;                       // need raw close at this minute
    LT.push({ ts: +c[1], levels, spot: rc.cl, contract: c[10] });
  }
  LT.sort((a, b) => a.ts - b.ts);
}
log(`LT rows w/ levels & raw close: ${LT.length}`);
const ltIdx = new Map(); for (let i = 0; i < LT.length; i++) ltIdx.set(LT[i].ts, i);
function asofIdx(ts) { let lo = 0, hi = LT.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (LT[m].ts <= ts) { a = m; lo = m + 1; } else hi = m - 1; } return a; }
const nAbove = (r) => r.levels.reduce((s, L) => s + (L > r.spot ? 1 : 0), 0);

// ---- 15m sentiment for ltAlign interaction ----
const SENT = [];
{ const txt = fs.readFileSync(path.join(ENG, 'data/liquidity/nq/NQ_liquidity_levels.csv'), 'utf8').split('\n');
  for (let i = 1; i < txt.length; i++) { const c = txt[i].split(','); if (!c[1]) continue; SENT.push({ ts: +c[1], s: c[2] }); } SENT.sort((a, b) => a.ts - b.ts); }
function sentAsof(ts) { let lo = 0, hi = SENT.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (SENT[m].ts <= ts) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? SENT[a].s : null; }

// ---- trades ----
const goldRaw = JSON.parse(fs.readFileSync(path.join(ENG, 'data/gold-standard/ls-flip-trigger-bar-v3.json'), 'utf8'));
const trades = Array.isArray(goldRaw) ? goldRaw : (goldRaw.trades || []);

const rows = []; let noLt = 0;
for (const t of trades) {
  const sig = t.signal || {}; const meta = sig.metadata || t.metadata || {};
  const isLong = (meta.direction || (t.side === 'buy' ? 'long' : 'short')) === 'long';
  const flipTs = meta.flipTs || (sig.timestamp ? sig.timestamp - 60000 : null);
  const atr = meta.atr20 || 1; const A = atr;
  const netPnL = t.netPnL ?? 0;
  if (!flipTs) continue;
  let idx = ltIdx.get(flipTs); if (idx == null) { const a = asofIdx(flipTs); if (a >= 0 && flipTs - LT[a].ts <= 5 * 60000) idx = a; }
  if (idx == null) { noLt++; continue; }
  const cur = LT[idx];
  // lookback only within same contract & contiguous (<=2min gaps)
  const back = (k) => { let j = idx; for (let s = 0; s < k; s++) { if (j - 1 < 0) return null; if (LT[j - 1].contract !== cur.contract) return null; if (LT[j].ts - LT[j - 1].ts > 3 * 60000) return null; j--; } return LT[j]; };
  const b5 = back(5), b15 = back(15);

  const above = cur.levels.filter(L => L > cur.spot).sort((a, b) => a - b);
  const below = cur.levels.filter(L => L < cur.spot).sort((a, b) => b - a);
  const nearAbove = above.length ? (above[0] - cur.spot) / A : null;
  const nearBelow = below.length ? (cur.spot - below[0]) / A : null;
  const nearEither = Math.min(...cur.levels.map(L => Math.abs(L - cur.spot))) / A;
  const naNow = nAbove(cur);
  const lo = Math.min(...cur.levels), hi = Math.max(...cur.levels);
  const insideBand = (cur.spot > lo && cur.spot < hi) ? 1 : 0;
  // direction-aware: nearest level on the TARGET side (long=above, short=below) and STOP side
  const targetSide = isLong ? nearAbove : nearBelow;
  const stopSide = isLong ? nearBelow : nearAbove;

  const dNA5 = b5 ? naNow - nAbove(b5) : null;
  const dNA15 = b15 ? naNow - nAbove(b15) : null;
  let barsSinceCross = null, lastCrossDir = 0;
  for (let k = idx; k > idx - 15 && k > 0; k--) { if (LT[k].contract !== cur.contract) break; const d = nAbove(LT[k]) - nAbove(LT[k - 1]); if (d !== 0) { barsSinceCross = idx - k; lastCrossDir = d < 0 ? 1 : -1; break; } }
  const crossAlign = lastCrossDir === 0 ? null : (((isLong && lastCrossDir > 0) || (!isLong && lastCrossDir < 0)) ? 1 : 0);
  const migAlign = dNA15 == null || dNA15 === 0 ? null : (((isLong && dNA15 < 0) || (!isLong && dNA15 > 0)) ? 1 : 0);

  const s = sentAsof(flipTs);
  let ltAlign = null; if (s === 'BULLISH' || s === 'BEARISH') ltAlign = ((isLong && s === 'BULLISH') || (!isLong && s === 'BEARISH')) ? 1 : 0;

  rows.push({ tradeId: t.id, isLong: isLong ? 1 : 0, ltAlign,
    naNow, nearAbove, nearBelow, nearEither, targetSide, stopSide, insideBand,
    dNA5, dNA15, barsSinceCross, lastCrossDir, crossAlign, migAlign,
    netPnL, label: netPnL > 0 ? 1 : 0 });
}
log(`rows ${rows.length} (skipped ${noLt} no-LT)`);
// sanity: nAbove balance (should be ~spread, NOT 93% one-sided now)
const naDist = {}; for (const r of rows) naDist[r.naNow] = (naDist[r.naNow] || 0) + 1;
log(`naNow distribution (0..5 levels above spot): ${JSON.stringify(naDist)}`);
log(`nearAbove present: ${(rows.filter(r => r.nearAbove != null).length / rows.length * 100).toFixed(0)}%  nearBelow present: ${(rows.filter(r => r.nearBelow != null).length / rows.length * 100).toFixed(0)}%`);
const cols = Object.keys(rows[0]);
fs.writeFileSync(path.join(OUT, 'lt-dynamics-raw-features.csv'), [cols.join(','), ...rows.map(r => cols.map(c => r[c] == null ? '' : r[c]).join(','))].join('\n'));
log('wrote output/lt-dynamics-raw-features.csv');
