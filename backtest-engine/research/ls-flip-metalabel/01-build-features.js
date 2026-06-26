/**
 * LS-Flip Meta-Labeling — Feature Builder
 *
 * Goal: for each candJ (v3) trade, compute features known AT THE FLIP INSTANT
 * (no look-ahead) plus the realized outcome, so we can ask "what is genuinely
 * predictive of whether this LS-flip signal works out".
 *
 * Label: win = netPnL > 0 (candJ exits: tgt15/stop12/BE 8/+2).
 *
 * Sources:
 *   - data/gold-standard/ls-flip-trigger-bar-v3.json  (candJ trades + outcome + flip meta)
 *   - research/lt-extraction/output/nq_ls_1m_raw.csv   (every LS flip → flip-timing/chop)
 *   - data/ohlcv/nq/NQ_ohlcv_1m.csv                    (primary-contract swing/trend/volume)
 *   - data/liquidity/nq/NQ_liquidity_levels.csv        (LT level confluence + sentiment)
 *   - data/gex/nq/NQ_gex_levels.csv                    (daily gamma flip / walls / regime)
 *
 * Output: research/ls-flip-metalabel/output/features.csv
 *
 * 1s-honesty note: features use ONLY data at/before the flip bar; the outcome
 * label comes from the engine's candJ run which is itself 1s-resolved. No
 * forward-looking feature touches the post-fill walk.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENG = path.resolve(__dirname, '../..');           // backtest-engine root
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

const GOLD = path.join(ENG, 'data/gold-standard/ls-flip-trigger-bar-v3.json');
const LS   = path.join(ENG, 'research/lt-extraction/output/nq_ls_1m_raw.csv');
const M1   = path.join(ENG, 'data/ohlcv/nq/NQ_ohlcv_1m.csv');
const LT   = path.join(ENG, 'data/liquidity/nq/NQ_liquidity_levels.csv');
const GEX  = path.join(ENG, 'data/gex/nq/NQ_gex_levels.csv');

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ---------- helpers ----------
function etDateStr(ms) {
  // YYYY-MM-DD in America/New_York
  const d = new Date(ms);
  const p = d.toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [mm, dd, yy] = p.split(',')[0].split('/');
  return `${yy}-${mm}-${dd}`;
}
function etHour(ms) {
  return parseInt(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
}
function etDow(ms) {
  // 0=Sun..6=Sat in ET
  const s = new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(s);
}
// asof: last index i with arr[i].ts <= ts (arr sorted asc by .ts). -1 if none.
function asof(arr, ts) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// ---------- 1. gold trades ----------
log('loading gold trades…');
const goldRaw = JSON.parse(fs.readFileSync(GOLD, 'utf8'));
const trades = Array.isArray(goldRaw) ? goldRaw : (goldRaw.trades || []);
log(`trades: ${trades.length}`);

// ---------- 2. LS flips ----------
log('loading LS flips…');
const lsRows = [];
{
  const txt = fs.readFileSync(LS, 'utf8').split('\n');
  for (let i = 1; i < txt.length; i++) {
    const line = txt[i].trim();
    if (!line) continue;
    const c = line.split(',');
    // timestamp_iso, unix_ms, state, source_symbol
    lsRows.push({ ts: +c[1], state: +c[2] });
  }
  lsRows.sort((a, b) => a.ts - b.ts);
}
log(`LS flips: ${lsRows.length}`);

// ---------- 3. LT levels ----------
log('loading LT levels…');
const ltRows = [];
{
  const txt = fs.readFileSync(LT, 'utf8').split('\n');
  for (let i = 1; i < txt.length; i++) {
    const line = txt[i].trim();
    if (!line) continue;
    const c = line.split(',');
    // datetime, unix_timestamp, sentiment, level_1..5
    const lv = [c[3], c[4], c[5], c[6], c[7]].map(Number).filter(x => Number.isFinite(x) && x > 0);
    ltRows.push({ ts: +c[2], sentiment: (c[3] && isNaN(+c[3])) ? null : null, sent: c[2] ? c[2] : null, levels: lv, raw: c });
  }
  // sentiment is column index 2 in the file? header: datetime,unix_timestamp,sentiment,level_1..  => idx2=sentiment
  for (const r of ltRows) { r.sentiment = r.raw[2]; r.ts = +r.raw[1]; r.levels = [r.raw[3],r.raw[4],r.raw[5],r.raw[6],r.raw[7]].map(Number).filter(x=>Number.isFinite(x)&&x>0); }
  ltRows.sort((a, b) => a.ts - b.ts);
}
log(`LT rows: ${ltRows.length}`);

// ---------- 4. GEX daily ----------
log('loading GEX daily…');
const gexByDate = new Map();
{
  const txt = fs.readFileSync(GEX, 'utf8').split('\n');
  const hdr = txt[0].split(',');
  const ix = (name) => hdr.indexOf(name);
  for (let i = 1; i < txt.length; i++) {
    const line = txt[i].trim();
    if (!line) continue;
    const c = line.split(',');
    gexByDate.set(c[ix('date')], {
      gammaFlip: +c[ix('nq_gamma_flip')],
      putWall: [+c[ix('nq_put_wall_1')], +c[ix('nq_put_wall_2')], +c[ix('nq_put_wall_3')]],
      callWall: [+c[ix('nq_call_wall_1')], +c[ix('nq_call_wall_2')], +c[ix('nq_call_wall_3')]],
      regime: c[ix('regime')],
    });
  }
}
log(`GEX days: ${gexByDate.size}`);

// ---------- 5. primary 1m series (stream + filterPrimaryContract on 2024-12..2026-05) ----------
log('streaming 1m raw (this is the slow step)…');
const FRONT = /^NQ[FGHJKMNQUVXZ]\d$/;   // front-month root, no calendar spreads
const WIN_LO = Date.parse('2024-12-01T00:00:00Z');
const WIN_HI = Date.parse('2026-05-15T00:00:00Z');

async function loadPrimary() {
  const rl = readline.createInterface({ input: fs.createReadStream(M1), crlfDelay: Infinity });
  // header: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
  const rows = [];           // {ts,o,h,l,c,v,sym}
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; }
    if (!line) continue;
    const c = line.split(',');
    const sym = c[9];
    if (!FRONT.test(sym)) continue;
    const ts = Date.parse(c[0]);
    if (!(ts >= WIN_LO && ts < WIN_HI)) continue;
    rows.push({ ts, o:+c[4], h:+c[5], l:+c[6], cl:+c[7], v:+c[8], sym });
  }
  log(`  raw front-month rows in window: ${rows.length}`);
  // filterPrimaryContract: per hour, keep only highest-volume symbol
  const hourVol = new Map();
  for (const r of rows) {
    const hk = Math.floor(r.ts / 3600000);
    let m = hourVol.get(hk); if (!m) { m = new Map(); hourVol.set(hk, m); }
    m.set(r.sym, (m.get(r.sym) || 0) + (r.v || 0));
  }
  const primOfHour = new Map();
  for (const [hk, m] of hourVol) {
    let best = '', bv = -1;
    for (const [s, v] of m) if (v > bv) { bv = v; best = s; }
    primOfHour.set(hk, best);
  }
  const prim = rows.filter(r => primOfHour.get(Math.floor(r.ts / 3600000)) === r.sym);
  prim.sort((a, b) => a.ts - b.ts);
  log(`  primary bars: ${prim.length}`);
  return prim;
}

const prim = await loadPrimary();
const tsIdx = new Map();
for (let i = 0; i < prim.length; i++) tsIdx.set(prim[i].ts, i);

// rolling EMA helper computed lazily per index via prefix is overkill; compute on the fly
function emaSlope(idx, period) {
  // EMA at idx and idx-period, return (ema_now - ema_prev)/period
  if (idx - period * 2 < 0) return null;
  const k = 2 / (period + 1);
  let ema = prim[idx - period * 2].cl;
  let emaPrev = null;
  for (let i = idx - period * 2 + 1; i <= idx; i++) {
    ema = prim[i].cl * k + ema * (1 - k);
    if (i === idx - period) emaPrev = ema;
  }
  if (emaPrev == null) return { ema, slope: null };
  return { ema, slope: (ema - emaPrev) / period };
}

// ---------- 6. LS flip-timing precompute ----------
const lsTsIdx = new Map();
for (let i = 0; i < lsRows.length; i++) lsTsIdx.set(lsRows[i].ts, i);
function flipTiming(flipTs) {
  const i = lsTsIdx.get(flipTs);
  let secsSinceLast = null, flips1h = 0, flips2h = 0;
  if (i != null && i > 0) secsSinceLast = (flipTs - lsRows[i - 1].ts) / 1000;
  // count flips in prior 1h/2h
  const lo1 = flipTs - 3600000, lo2 = flipTs - 7200000;
  let j = (i != null ? i : asof(lsRows, flipTs)) - 1;
  while (j >= 0 && lsRows[j].ts >= lo2) { if (lsRows[j].ts >= lo1) flips1h++; flips2h++; j--; }
  return { secsSinceLast, flips1h, flips2h };
}

// ---------- 7. build feature rows ----------
log('building feature rows…');
const FEATS = [];
let miss = 0;
for (const t of trades) {
  const sig = t.signal || {};
  const meta = sig.metadata || t.metadata || {};
  const dir = meta.direction || (t.side === 'buy' ? 'long' : 'short');
  const isLong = dir === 'long';
  const flipTs = meta.flipTs || (sig.timestamp ? sig.timestamp - 60000 : null);
  const entry = t.actualEntry ?? t.entryPrice ?? sig.price;
  const atr = meta.atr20 || t.metadata?.atr20 || null;
  const tb = meta.triggerBar || {};
  const netPnL = t.netPnL ?? 0;
  const label = netPnL > 0 ? 1 : 0;

  if (!flipTs || !entry || !atr || !tb.high) { miss++; continue; }
  const A = atr || 1;

  // --- trigger-bar shape ---
  const rng = tb.range || (tb.high - tb.low);
  const closePos = rng > 0 ? (tb.close - tb.low) / rng : 0.5;     // 0=at low,1=at high
  const bodyFrac = rng > 0 ? Math.abs(tb.close - tb.open) / rng : 0;
  const upperWick = rng > 0 ? (tb.high - Math.max(tb.open, tb.close)) / rng : 0;
  const lowerWick = rng > 0 ? (Math.min(tb.open, tb.close) - tb.low) / rng : 0;
  // directional "retrace already underway": for long, close near low = deeper retrace toward entry
  const retraceDepth = isLong ? (1 - closePos) : closePos;

  // --- flip timing / chop ---
  const ft = flipTiming(flipTs);

  // --- primary-series context ---
  let f = {
    distHi20: null, distLo20: null, posInRange60: null, distHi60: null, distLo60: null,
    ret20: null, ret60: null, emaSlope20: null, entryVsEma20: null,
    counterTrend: null, volRatio: null, volZ: null,
  };
  let idx = tsIdx.get(flipTs);
  if (idx == null) {
    // nearest within 2 min
    for (const d of [60000, -60000, 120000, -120000]) { if (tsIdx.has(flipTs + d)) { idx = tsIdx.get(flipTs + d); break; } }
  }
  if (idx != null && idx >= 60) {
    const w20 = prim.slice(idx - 20, idx);    // prior 20 bars (excl trigger)
    const w60 = prim.slice(idx - 60, idx);
    const hi20 = Math.max(...w20.map(b => b.h)), lo20 = Math.min(...w20.map(b => b.l));
    const hi60 = Math.max(...w60.map(b => b.h)), lo60 = Math.min(...w60.map(b => b.l));
    f.distHi20 = (hi20 - entry) / A;          // >0 entry below recent high
    f.distLo20 = (entry - lo20) / A;          // >0 entry above recent low
    f.distHi60 = (hi60 - entry) / A;
    f.distLo60 = (entry - lo60) / A;
    f.posInRange60 = (hi60 - lo60) > 0 ? (entry - lo60) / (hi60 - lo60) : 0.5;  // 0..1
    f.ret20 = (prim[idx].cl - prim[idx - 20].cl) / A;
    f.ret60 = (prim[idx].cl - prim[idx - 60].cl) / A;
    const es = emaSlope(idx, 20);
    if (es) { f.emaSlope20 = es.slope == null ? null : es.slope / A * 20; f.entryVsEma20 = (entry - es.ema) / A; }
    // counter-trend: drift = ret20 sign; flip dir opposes drift?  (fade = counter)
    const drift = f.ret20;
    f.counterTrend = (isLong && drift < 0) || (!isLong && drift > 0) ? 1 : 0;
    const avgVol = w20.reduce((s, b) => s + b.v, 0) / 20;
    const sdVol = Math.sqrt(w20.reduce((s, b) => s + (b.v - avgVol) ** 2, 0) / 20) || 1;
    const tbVol = prim[idx].v;
    f.volRatio = avgVol > 0 ? tbVol / avgVol : null;
    f.volZ = (tbVol - avgVol) / sdVol;
  }

  // --- LT confluence ---
  let ltDist = null, ltAlign = null;
  {
    const li = asof(ltRows, flipTs);
    if (li >= 0) {
      const r = ltRows[li];
      if (r.levels.length) {
        let md = Infinity; for (const lv of r.levels) md = Math.min(md, Math.abs(entry - lv));
        ltDist = md / A;
      }
      if (r.sentiment === 'BULLISH' || r.sentiment === 'BEARISH') {
        const bull = r.sentiment === 'BULLISH';
        ltAlign = (isLong && bull) || (!isLong && !bull) ? 1 : 0;
      }
    }
  }

  // --- GEX confluence ---
  let gexDistFlip = null, gexAboveFlip = null, gexDistWall = null, gexRegimePos = null;
  {
    const g = gexByDate.get(etDateStr(flipTs));
    if (g && Number.isFinite(g.gammaFlip)) {
      gexDistFlip = (entry - g.gammaFlip) / A;       // signed
      gexAboveFlip = entry > g.gammaFlip ? 1 : 0;
      const walls = [...g.putWall, ...g.callWall].filter(Number.isFinite);
      if (walls.length) { let md = Infinity; for (const w of walls) md = Math.min(md, Math.abs(entry - w)); gexDistWall = md / A; }
      gexRegimePos = g.regime === 'positive' ? 1 : (g.regime === 'negative' ? 0 : null);
    }
  }

  // --- fill dynamics ---
  const fillDelay = t.fillDelay ?? null;              // bars/ms? engine-defined
  const barsToFill = (t.entryTime && flipTs) ? Math.round((t.entryTime - flipTs) / 60000) : null;

  FEATS.push({
    tradeId: t.id, flipTs, entryTime: t.entryTime || null, dir, isLong: isLong ? 1 : 0,
    hourEt: etHour(flipTs), dowEt: etDow(flipTs),
    // trigger-bar shape
    range: rng, cbAtr: meta.cbAtr, rangeRatio: A ? rng / A : null,
    closePos, retraceDepth, bodyFrac, upperWick, lowerWick,
    // flip timing
    secsSinceLast: ft.secsSinceLast, flips1h: ft.flips1h, flips2h: ft.flips2h,
    // price context
    distHi20: f.distHi20, distLo20: f.distLo20, distHi60: f.distHi60, distLo60: f.distLo60,
    posInRange60: f.posInRange60, ret20: f.ret20, ret60: f.ret60,
    emaSlope20: f.emaSlope20, entryVsEma20: f.entryVsEma20, counterTrend: f.counterTrend,
    volRatio: f.volRatio, volZ: f.volZ,
    // LT
    ltDist, ltAlign,
    // GEX
    gexDistFlip, gexAboveFlip, gexDistWall, gexRegimePos,
    // fill
    fillDelay, barsToFill,
    // outcome
    netPnL, exitReason: t.exitReason, mfePoints: t.mfePoints ?? null, maePoints: t.maePoints ?? null,
    label,
  });
}
log(`feature rows: ${FEATS.length} (skipped ${miss} missing-meta)`);

// ---------- 8. write CSV ----------
const cols = Object.keys(FEATS[0]);
const csv = [cols.join(',')];
for (const r of FEATS) csv.push(cols.map(c => { const v = r[c]; return v == null ? '' : (typeof v === 'number' ? (Number.isInteger(v) ? v : +v.toFixed(6)) : v); }).join(','));
const outFile = path.join(OUT, 'features.csv');
fs.writeFileSync(outFile, csv.join('\n'));
log(`wrote ${outFile}`);

// quick label balance + coverage sanity
const nLab = FEATS.reduce((s, r) => s + r.label, 0);
const cov = (k) => (FEATS.filter(r => r[k] != null).length / FEATS.length * 100).toFixed(0) + '%';
log(`label balance: ${nLab} win / ${FEATS.length - nLab} loss (WR ${(nLab / FEATS.length * 100).toFixed(1)}%)`);
log(`coverage: primCtx(distHi20)=${cov('distHi20')} LT=${cov('ltDist')} LTalign=${cov('ltAlign')} GEX=${cov('gexDistFlip')} vol=${cov('volRatio')} barsToFill=${cov('barsToFill')}`);
