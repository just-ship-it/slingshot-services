/**
 * Phase 1b — LT level DYNAMICS (the user's "over→under spot" hypothesis).
 *
 * Phase 1 (static snapshot) was a dead end. This asks what the levels are DOING:
 * crossing spot, migrating, flipping resistance↔support — using 1m LT resolution.
 *
 * PRICE-SPACE SAFETY: the 1m LT file is BACK-ADJUSTED (was_backadjusted=true), so its
 * levels must NOT be compared to raw-contract trade entries. But the file carries its
 * own per-minute spot proxy `sentiment_raw` (verified: tracks continuous close at a
 * constant ~+208pt offset). So ALL dynamics are computed level-vs-sentiment_raw,
 * entirely INSIDE the LT file's price space. Trades only contribute (timestamp, label,
 * direction, atr) — no cross-space price comparison anywhere.
 *
 * Out: output/lt-dynamics-features.csv
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENG = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'output');
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ---- 1m LT series (back-adjusted; use internal spot=sentiment_raw) ----
log('loading 1m LT…');
const LT = [];
{
  const txt = fs.readFileSync(path.join(ENG, 'research/lt-extraction/output/nq_lt_1m_raw.csv'), 'utf8').split('\n');
  for (let i = 1; i < txt.length; i++) {
    const c = txt[i].split(',');
    if (!c[1]) continue;
    const spot = +c[2];
    const levels = [c[3], c[4], c[5], c[6], c[7]].map(Number).filter(x => Number.isFinite(x) && x > 0);
    if (!Number.isFinite(spot) || !levels.length) continue;
    LT.push({ ts: +c[1], spot, levels });
  }
  LT.sort((a, b) => a.ts - b.ts);
}
log(`LT 1m rows w/ levels: ${LT.length}`);
const ltIdx = new Map();
for (let i = 0; i < LT.length; i++) ltIdx.set(LT[i].ts, i);
function ltAsofIdx(ts) { let lo = 0, hi = LT.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (LT[m].ts <= ts) { a = m; lo = m + 1; } else hi = m - 1; } return a; }
const nAbove = (r) => r.levels.reduce((s, L) => s + (L > r.spot ? 1 : 0), 0);

// ---- 15m sentiment (for ltAlign interaction) ----
const SENT = [];
{
  const txt = fs.readFileSync(path.join(ENG, 'data/liquidity/nq/NQ_liquidity_levels.csv'), 'utf8').split('\n');
  for (let i = 1; i < txt.length; i++) { const c = txt[i].split(','); if (!c[1]) continue; SENT.push({ ts: +c[1], sentiment: c[2] }); }
  SENT.sort((a, b) => a.ts - b.ts);
}
function sentAsof(ts) { let lo = 0, hi = SENT.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (SENT[m].ts <= ts) { a = m; lo = m + 1; } else hi = m - 1; } return a >= 0 ? SENT[a].sentiment : null; }

// ---- trades ----
const goldRaw = JSON.parse(fs.readFileSync(path.join(ENG, 'data/gold-standard/ls-flip-trigger-bar-v3.json'), 'utf8'));
const trades = Array.isArray(goldRaw) ? goldRaw : (goldRaw.trades || []);

const rows = [];
let noLt = 0;
for (const t of trades) {
  const sig = t.signal || {}; const meta = sig.metadata || t.metadata || {};
  const dir = meta.direction || (t.side === 'buy' ? 'long' : 'short');
  const isLong = dir === 'long';
  const flipTs = meta.flipTs || (sig.timestamp ? sig.timestamp - 60000 : null);
  const atr = meta.atr20 || 1;
  const netPnL = t.netPnL ?? 0;
  if (!flipTs) continue;

  let idx = ltIdx.get(flipTs);
  if (idx == null) { const a = ltAsofIdx(flipTs); if (a >= 0 && flipTs - LT[a].ts <= 5 * 60000) idx = a; }
  if (idx == null || idx < 16) { noLt++; continue; }

  const cur = LT[idx];
  const A = atr || 1;
  const naNow = nAbove(cur);
  const na5 = nAbove(LT[idx - 5]);
  const na15 = nAbove(LT[idx - 15]);
  const dNA5 = naNow - na5;       // <0 = spot rose THROUGH levels (bullish migration)
  const dNA15 = naNow - na15;

  // nearest levels relative to internal spot
  const above = cur.levels.filter(L => L > cur.spot).sort((a, b) => a - b);
  const below = cur.levels.filter(L => L < cur.spot).sort((a, b) => b - a);
  const nearAbove = above.length ? (above[0] - cur.spot) / A : null;
  const nearBelow = below.length ? (cur.spot - below[0]) / A : null;

  // most-recent spot/level cross within 15 bars (via nAbove change sign), bars-since + dir
  let barsSinceCross = null, lastCrossDir = 0; // +1 spot up through a level, -1 down
  for (let k = idx; k > idx - 15 && k > 0; k--) {
    const d = nAbove(LT[k]) - nAbove(LT[k - 1]);
    if (d !== 0) { barsSinceCross = idx - k; lastCrossDir = d < 0 ? 1 : -1; break; }
  }
  // crossing intensity in last 15 bars (total level/spot crossings)
  let crossCount15 = 0;
  for (let k = idx; k > idx - 15 && k > 0; k--) crossCount15 += Math.abs(nAbove(LT[k]) - nAbove(LT[k - 1]));

  // slopes over 15 bars (ATR-normalized, per bar)
  const spotSlope = (cur.spot - LT[idx - 15].spot) / 15 / A;
  const meanLvl = (r) => r.levels.reduce((s, L) => s + L, 0) / r.levels.length;
  const lvlSlope = (meanLvl(cur) - meanLvl(LT[idx - 15])) / 15 / A;

  // cross direction aligned with flip? (long wants spot rising through levels)
  const crossAlign = lastCrossDir === 0 ? null : ((isLong && lastCrossDir > 0) || (!isLong && lastCrossDir < 0) ? 1 : 0);
  // spot inside level band vs outside
  const lo = Math.min(...cur.levels), hi = Math.max(...cur.levels);
  const insideBand = (cur.spot > lo && cur.spot < hi) ? 1 : 0;

  // ltAlign (15m sentiment) for interaction
  const s = sentAsof(flipTs);
  let ltAlign = null;
  if (s === 'BULLISH' || s === 'BEARISH') ltAlign = ((isLong && s === 'BULLISH') || (!isLong && s === 'BEARISH')) ? 1 : 0;

  rows.push({
    tradeId: t.id, isLong: isLong ? 1 : 0, ltAlign,
    naNow, dNA5, dNA15,
    nearAbove, nearBelow,
    barsSinceCross, lastCrossDir, crossAlign, crossCount15, insideBand,
    spotSlope: +spotSlope.toFixed(4), lvlSlope: +lvlSlope.toFixed(4),
    // migration aligned with flip: spot moving toward trade direction relative to levels
    migAlign: (isLong && dNA15 < 0) || (!isLong && dNA15 > 0) ? 1 : (dNA15 === 0 ? null : 0),
    netPnL, label: netPnL > 0 ? 1 : 0,
  });
}
log(`rows ${rows.length} (skipped ${noLt} no-LT)`);
const cols = Object.keys(rows[0]);
const csv = [cols.join(',')];
for (const r of rows) csv.push(cols.map(c => { const v = r[c]; return v == null ? '' : v; }).join(','));
fs.writeFileSync(path.join(OUT, 'lt-dynamics-features.csv'), csv.join('\n'));
log('wrote output/lt-dynamics-features.csv');
