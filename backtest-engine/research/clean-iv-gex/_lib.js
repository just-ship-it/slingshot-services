/**
 * Shared infrastructure for clean-IV/clean-GEX correlation hunt.
 *
 * Loaders, alignment, and statistical helpers used by every predictor script.
 * The only place that knows about timestamp alignment, lag, and rollover.
 *
 * Run `node _lib.js --selftest` to validate alignment before running predictors.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const OUTPUT_CSV = path.join(REPO_ROOT, 'research/output/clean-iv-gex-correlations.csv');
export const BRIEFS_DIR = path.join(REPO_ROOT, 'research/clean-iv-gex');

// Brief constraints: response data ends 2026-04-23 (last IV CSV regen).
const SAMPLE_START = '2025-01-13';
const SAMPLE_END   = '2026-04-23';
const SAMPLE_START_MS = Date.parse(SAMPLE_START + 'T00:00:00Z');
const SAMPLE_END_MS   = Date.parse(SAMPLE_END   + 'T23:59:59Z');

const ROLLOVER_BUFFER_DAYS = 2;
const MS_PER_DAY = 86_400_000;

// ───────────────────────────────────────────────────────────────────────────
// Rollover dates
// ───────────────────────────────────────────────────────────────────────────

let _rolloverCache = null;
export function loadRolloverDates() {
  if (_rolloverCache) return _rolloverCache;
  const fp = path.join(DATA_DIR, 'ohlcv/nq/NQ_rollover_log.csv');
  const lines = fs.readFileSync(fp, 'utf8').trim().split('\n').slice(1);
  _rolloverCache = lines.map(l => {
    const [date] = l.split(',');
    return Date.parse(date + 'T00:00:00Z');
  }).filter(t => t >= SAMPLE_START_MS - 30 * MS_PER_DAY);
  return _rolloverCache;
}

function isWithinRolloverBuffer(tsMs) {
  const rolls = loadRolloverDates();
  for (const r of rolls) {
    if (Math.abs(tsMs - r) <= ROLLOVER_BUFFER_DAYS * MS_PER_DAY) return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// NQ 1-min OHLCV — streaming load + calendar-spread + primary-contract filter
// ───────────────────────────────────────────────────────────────────────────

let _ohlcvCache = null;
let _ohlcvDailyAtrCache = null;

/**
 * Returns:
 *   byMinute: Map<isoMinuteUtc, {ts, open, high, low, close, volume, symbol}>
 *   sorted:   array of same, sorted by ts
 *   atr20ByDate: Map<'YYYY-MM-DD', atr20Pts>  -- ATR over prior 20 daily bars (no lookahead)
 */
export async function loadNqOhlcv1m() {
  if (_ohlcvCache) return _ohlcvCache;

  const fp = path.join(DATA_DIR, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  const stream = fs.createReadStream(fp);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let header = null;
  let colTs, colOpen, colHigh, colLow, colClose, colVol, colSym;
  const raw = []; // {ts,open,high,low,close,volume,symbol}

  for await (const line of rl) {
    if (!header) {
      header = line.split(',');
      colTs = header.indexOf('ts_event');
      colOpen = header.indexOf('open');
      colHigh = header.indexOf('high');
      colLow = header.indexOf('low');
      colClose = header.indexOf('close');
      colVol = header.indexOf('volume');
      colSym = header.indexOf('symbol');
      continue;
    }
    if (!line) continue;

    // Cheap year filter before any allocation: 2025/2026 only
    if (line[0] !== '2' || (line[3] !== '5' && line[3] !== '6' && !(line[3] === '4' && line[2] === '2'))) {
      // Not perfect, but cuts ~80% of pre-2025 rows.  Strict check below.
    }
    const yearPrefix = line.substring(0, 4);
    if (yearPrefix !== '2025' && yearPrefix !== '2026') continue;

    const cols = line.split(',');
    const sym = cols[colSym];
    if (sym && sym.includes('-')) continue; // calendar spread

    const ts = Date.parse(cols[colTs]);
    if (Number.isNaN(ts)) continue;
    if (ts < SAMPLE_START_MS - 60 * MS_PER_DAY) continue;
    if (ts > SAMPLE_END_MS + 7 * MS_PER_DAY) continue;

    const open = +cols[colOpen];
    const high = +cols[colHigh];
    const low = +cols[colLow];
    const close = +cols[colClose];
    const volume = +cols[colVol];

    if (!Number.isFinite(close)) continue;
    // Drop synthetic single-tick artifacts
    if (open === high && high === low && low === close && volume <= 2) continue;

    raw.push({ ts, open, high, low, close, volume, symbol: sym });
  }

  // Primary-contract filter per hour (highest volume symbol per hour wins)
  const hourVol = new Map(); // hourBucket -> Map<symbol, vol>
  for (const c of raw) {
    const hr = Math.floor(c.ts / 3600_000);
    let m = hourVol.get(hr);
    if (!m) { m = new Map(); hourVol.set(hr, m); }
    m.set(c.symbol, (m.get(c.symbol) || 0) + (c.volume || 0));
  }
  const primaryByHour = new Map();
  for (const [hr, m] of hourVol) {
    let bestSym = '', bestVol = -1;
    for (const [s, v] of m) if (v > bestVol) { bestVol = v; bestSym = s; }
    primaryByHour.set(hr, bestSym);
  }

  const filtered = raw.filter(c => primaryByHour.get(Math.floor(c.ts / 3600_000)) === c.symbol);
  filtered.sort((a, b) => a.ts - b.ts);

  // Deduplicate same-minute rows (post-2026-01-29 fragmentation safeguard) —
  // keep the first occurrence per minute (after primary-contract filter).
  const byMinute = new Map();
  for (const c of filtered) {
    const isoMin = new Date(c.ts).toISOString().substring(0, 16); // YYYY-MM-DDTHH:MM
    if (!byMinute.has(isoMin)) byMinute.set(isoMin, c);
  }

  // Daily ATR(20) computed from primary-contract daily aggregates.
  const dailyAgg = new Map(); // 'YYYY-MM-DD' -> {high,low,close,prevClose}
  for (const c of byMinute.values()) {
    const day = new Date(c.ts).toISOString().substring(0, 10);
    let d = dailyAgg.get(day);
    if (!d) { d = { day, high: c.high, low: c.low, close: c.close, ts: c.ts }; dailyAgg.set(day, d); }
    else {
      if (c.high > d.high) d.high = c.high;
      if (c.low < d.low) d.low = c.low;
      if (c.ts > d.ts) { d.ts = c.ts; d.close = c.close; }
    }
  }
  const days = [...dailyAgg.values()].sort((a, b) => a.day.localeCompare(b.day));
  for (let i = 0; i < days.length; i++) {
    const prevClose = i > 0 ? days[i - 1].close : days[i].close;
    const tr = Math.max(
      days[i].high - days[i].low,
      Math.abs(days[i].high - prevClose),
      Math.abs(days[i].low - prevClose)
    );
    days[i].tr = tr;
  }
  const atr20ByDate = new Map();
  for (let i = 0; i < days.length; i++) {
    if (i < 20) { atr20ByDate.set(days[i].day, null); continue; }
    let s = 0;
    for (let j = i - 20; j < i; j++) s += days[j].tr;
    atr20ByDate.set(days[i].day, s / 20);
  }
  _ohlcvDailyAtrCache = atr20ByDate;

  _ohlcvCache = { byMinute, sorted: [...byMinute.values()].sort((a, b) => a.ts - b.ts), atr20ByDate };
  return _ohlcvCache;
}

// ───────────────────────────────────────────────────────────────────────────
// QQQ 7-DTE ATM IV (1-min)
// ───────────────────────────────────────────────────────────────────────────

let _atmIvCache = null;
export async function loadAtmIv1m() {
  if (_atmIvCache) return _atmIvCache;
  const fp = path.join(DATA_DIR, 'iv/qqq/qqq_atm_iv_1m.csv');
  const text = fs.readFileSync(fp, 'utf8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const tsStr = cols[idx.timestamp];
    const isoMin = tsStr.substring(0, 16);
    map.set(isoMin, {
      iv: +cols[idx.iv],
      spot_price: +cols[idx.spot_price],
      atm_strike: +cols[idx.atm_strike],
      call_iv: +cols[idx.call_iv],
      put_iv: +cols[idx.put_iv],
      dte: +cols[idx.dte],
    });
  }
  _atmIvCache = map;
  return map;
}

// ───────────────────────────────────────────────────────────────────────────
// QQQ 0-DTE / 1-DTE / 2-DTE 15-min IV
// ───────────────────────────────────────────────────────────────────────────

let _shortIvCache = null;
export async function loadShortDteIv15m() {
  if (_shortIvCache) return _shortIvCache;
  const fp = path.join(DATA_DIR, 'iv/qqq/qqq_short_dte_iv_15m.csv');
  const text = fs.readFileSync(fp, 'utf8');
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const tsStr = cols[idx.timestamp];
    const iso15 = tsStr.substring(0, 16);
    const r = (n) => { const v = +cols[idx[n]]; return Number.isFinite(v) ? v : null; };
    map.set(iso15, {
      spot_price: r('spot_price'),
      dte0_avg_iv: r('dte0_avg_iv'),
      dte0_skew: r('dte0_skew'),
      dte1_avg_iv: r('dte1_avg_iv'),
      dte1_skew: r('dte1_skew'),
      dte2_avg_iv: r('dte2_avg_iv'),
      term_slope: r('term_slope'),
      quality: +cols[idx.quality],
    });
  }
  _shortIvCache = map;
  return map;
}

// ───────────────────────────────────────────────────────────────────────────
// NQ-cbbo GEX snapshots
// ───────────────────────────────────────────────────────────────────────────

let _gexCache = null;
export function loadGexSnapshots(product = 'nq') {
  if (_gexCache && _gexCache._product === product) return _gexCache;
  const dir = path.join(DATA_DIR, `gex/${product}-cbbo`);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const all = [];
  for (const f of files) {
    const date = f.replace(/^[a-z]+_gex_/, '').replace('.json', '');
    if (date < SAMPLE_START.substring(0, 10) || date > SAMPLE_END.substring(0, 10)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!j.data) continue;
    for (const s of j.data) {
      const ts = Date.parse(s.timestamp);
      if (!Number.isFinite(ts)) continue;
      all.push({ ...s, ts, date });
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  all._product = product;
  _gexCache = all;
  return all;
}

// ───────────────────────────────────────────────────────────────────────────
// Alignment — join GEX snapshots with NQ forward returns
// ───────────────────────────────────────────────────────────────────────────

function isoMinuteAdd(isoMin, addMinutes) {
  const t = Date.parse(isoMin + ':00Z') + addMinutes * 60_000;
  return new Date(t).toISOString().substring(0, 16);
}

/**
 * For each GEX snapshot at boundary T:
 *   entry  = NQ close at minute T+1 (strictly after the snapshot bucket)
 *   ret15  = ln(price[T+16] / price[T+1])
 *   ret60  = ln(price[T+61] / price[T+1])
 *   high15, low15 = max/min close in [T+1 .. T+16]
 *   realized_vol_30 = stdev of 1-min log returns over [T+1 .. T+31]
 *
 * Skips snapshots within ±2 trading days of any rollover, and any sample
 * where the entry / +15m / +1h points are missing or cross a contract change.
 */
export async function buildAlignedSample(opts = {}) {
  const { entryLagMinutes = 1 } = opts;
  const { byMinute } = await loadNqOhlcv1m();
  const gex = loadGexSnapshots('nq');
  const out = [];
  let skipMissing = 0, skipRollover = 0, skipContractChange = 0;

  for (const s of gex) {
    if (s.ts < SAMPLE_START_MS || s.ts > SAMPLE_END_MS) continue;
    if (isWithinRolloverBuffer(s.ts)) { skipRollover++; continue; }

    const isoT = new Date(s.ts).toISOString().substring(0, 16);
    const isoEntry = isoMinuteAdd(isoT, entryLagMinutes);
    const iso15 = isoMinuteAdd(isoT, entryLagMinutes + 15);
    const iso60 = isoMinuteAdd(isoT, entryLagMinutes + 60);

    const entry = byMinute.get(isoEntry);
    const at15 = byMinute.get(iso15);
    const at60 = byMinute.get(iso60);
    if (!entry || !at15 || !at60) { skipMissing++; continue; }

    if (entry.symbol !== at15.symbol || entry.symbol !== at60.symbol) {
      skipContractChange++;
      continue;
    }

    // path within +15m
    let high15 = entry.close, low15 = entry.close;
    const ret1mSeries = [];
    let prev = entry.close;
    for (let m = 1; m <= 30; m++) {
      const k = isoMinuteAdd(isoT, entryLagMinutes + m);
      const c = byMinute.get(k);
      if (!c) break;
      if (m <= 15) {
        if (c.high > high15) high15 = c.high;
        if (c.low < low15) low15 = c.low;
      }
      ret1mSeries.push(Math.log(c.close / prev));
      prev = c.close;
    }
    let realizedVol30 = null;
    if (ret1mSeries.length >= 20) {
      const mean = ret1mSeries.reduce((a, b) => a + b, 0) / ret1mSeries.length;
      const variance = ret1mSeries.reduce((a, b) => a + (b - mean) ** 2, 0) / ret1mSeries.length;
      realizedVol30 = Math.sqrt(variance);
    }

    out.push({
      ts: s.ts,
      iso: isoT,
      date: s.date,
      snapshot: s,
      entry_price: entry.close,
      symbol: entry.symbol,
      price_15m: at15.close,
      price_60m: at60.close,
      fwd_ret_15m: Math.log(at15.close / entry.close),
      fwd_ret_60m: Math.log(at60.close / entry.close),
      fwd_high_15m_pts: high15 - entry.close,
      fwd_low_15m_pts: low15 - entry.close,
      fwd_realized_vol_30m: realizedVol30,
    });
  }

  return { samples: out, skipMissing, skipRollover, skipContractChange };
}

// ───────────────────────────────────────────────────────────────────────────
// Stats helpers
// ───────────────────────────────────────────────────────────────────────────

function rank(arr) {
  const idx = arr.map((v, i) => [v, i]);
  idx.sort((a, b) => a[0] - b[0]);
  const ranks = new Array(arr.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}

export function spearman(xs, ys) {
  if (xs.length !== ys.length) throw new Error('length mismatch');
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  const n = pairs.length;
  if (n < 10) return { r: NaN, p: NaN, n };
  const xr = rank(pairs.map(p => p[0]));
  const yr = rank(pairs.map(p => p[1]));
  const mx = xr.reduce((a, b) => a + b, 0) / n;
  const my = yr.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xr[i] - mx, b = yr[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const r = num / Math.sqrt(dx * dy);
  // Two-sided p via t-approx: t = r * sqrt(n-2) / sqrt(1-r^2)
  let p = NaN;
  if (Math.abs(r) < 1 && n > 2) {
    const t = r * Math.sqrt(n - 2) / Math.sqrt(1 - r * r);
    p = 2 * (1 - studentTCdf(Math.abs(t), n - 2));
  } else if (Math.abs(r) >= 1) {
    p = 0;
  }
  return { r, p, n };
}

// Student-t two-sided CDF via incomplete beta function (good enough for big df)
function studentTCdf(t, df) {
  // For df > 30, normal approximation is fine
  if (df > 30) return 0.5 * (1 + erf(t / Math.SQRT2));
  // Otherwise use beta
  const x = df / (df + t * t);
  return 1 - 0.5 * incBeta(df / 2, 0.5, x);
}
function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function incBeta(a, b, x) {
  // Continued fraction (df not used in our promotion gate; OK for indication)
  if (x === 0 || x === 1) return x;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1, c = 1, d = 0;
  for (let i = 0; i < 200; i++) {
    const m = i;
    let num;
    if (i === 0) num = 1;
    else if (i % 2 === 0) {
      const k = m / 2;
      num = (k * (b - k) * x) / ((a + 2 * k - 1) * (a + 2 * k));
    } else {
      const k = (m - 1) / 2;
      num = -((a + k) * (a + b + k) * x) / ((a + 2 * k) * (a + 2 * k + 1));
    }
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    f *= d * c;
  }
  return front * (f - 1);
}
function lgamma(z) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function decileAnalysis(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const n = pairs.length;
  if (n < 50) return { deciles: [], top: NaN, bottom: NaN, diff: NaN, hitRateTop: NaN, hitRateBot: NaN };
  const deciles = [];
  for (let d = 0; d < 10; d++) {
    const lo = Math.floor(n * d / 10);
    const hi = Math.floor(n * (d + 1) / 10);
    const slice = pairs.slice(lo, hi);
    const ys2 = slice.map(p => p[1]);
    const mean = ys2.reduce((a, b) => a + b, 0) / ys2.length;
    const hit = ys2.filter(v => v > 0).length / ys2.length;
    deciles.push({ d, n: ys2.length, mean, hit_rate: hit, x_lo: slice[0][0], x_hi: slice[slice.length - 1][0] });
  }
  const top = deciles[9].mean, bottom = deciles[0].mean;
  return { deciles, top, bottom, diff: top - bottom, hitRateTop: deciles[9].hit_rate, hitRateBot: deciles[0].hit_rate };
}

export function trainTestSplit(samples, frac = 0.7) {
  // chronological — samples are already sorted by ts
  const n = samples.length;
  const k = Math.floor(n * frac);
  return { train: samples.slice(0, k), test: samples.slice(k) };
}

/**
 * Promotion gate per the brief.
 *
 *  n  ≥ 500
 *  |r| ≥ 0.10
 *  effect: top-bottom decile mean diff in NQ pts ≥ 5  OR  hit-rate diff ≥ 5pp
 *  train/test stability: test effect / train effect ≥ 0.5 (sign must match)
 *
 * For NQ we approximate "5 NQ pts" as |log_return_diff * spot| ≥ 5; we measure
 * the predictor's effect column in NQ-pt-equivalent (already passed in).
 */
export function promotionGate({ n, r, effectPts, hitRatePpDiff, trainEffect, testEffect }) {
  const failed = [];
  if (!(n >= 500)) failed.push(`n<500 (${n})`);
  if (!(Math.abs(r) >= 0.10)) failed.push(`|r|<0.10 (${r?.toFixed(3)})`);
  const effectOK = (effectPts != null && Math.abs(effectPts) >= 5) || (hitRatePpDiff != null && Math.abs(hitRatePpDiff) >= 5);
  if (!effectOK) failed.push(`effect too small (pts=${effectPts?.toFixed(2)}, hitDiff=${hitRatePpDiff?.toFixed(2)}pp)`);
  if (trainEffect != null && testEffect != null) {
    const ratio = testEffect / trainEffect;
    if (!(ratio >= 0.5 && Math.sign(testEffect) === Math.sign(trainEffect))) {
      failed.push(`train/test unstable (train=${trainEffect.toFixed(3)}, test=${testEffect.toFixed(3)})`);
    }
  }
  return { promotable: failed.length === 0, failedBars: failed };
}

// ───────────────────────────────────────────────────────────────────────────
// Master CSV
// ───────────────────────────────────────────────────────────────────────────

const MASTER_HEADER = 'predictor_id,predictor_description,response,n,spearman_r,p_value,top_decile_effect,bottom_decile_effect,decile_diff,hit_rate_top,hit_rate_bot,train_diff,test_diff,promotable,notes';

export function appendMasterCsv(row) {
  fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });
  const exists = fs.existsSync(OUTPUT_CSV);
  if (!exists) fs.writeFileSync(OUTPUT_CSV, MASTER_HEADER + '\n');
  const cols = [
    row.predictor_id,
    `"${(row.predictor_description ?? '').replace(/"/g, '""')}"`,
    row.response,
    row.n,
    row.spearman_r?.toFixed(4) ?? '',
    row.p_value != null ? row.p_value.toExponential(2) : '',
    row.top_decile_effect?.toFixed(4) ?? '',
    row.bottom_decile_effect?.toFixed(4) ?? '',
    row.decile_diff?.toFixed(4) ?? '',
    row.hit_rate_top?.toFixed(4) ?? '',
    row.hit_rate_bot?.toFixed(4) ?? '',
    row.train_diff?.toFixed(4) ?? '',
    row.test_diff?.toFixed(4) ?? '',
    row.promotable ? 'true' : 'false',
    `"${(row.notes ?? '').replace(/"/g, '""')}"`,
  ];
  fs.appendFileSync(OUTPUT_CSV, cols.join(',') + '\n');
}

export function resetMasterCsv() {
  fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });
  fs.writeFileSync(OUTPUT_CSV, MASTER_HEADER + '\n');
}

// ───────────────────────────────────────────────────────────────────────────
// NQ point conversion helper for log-returns (avg spot ≈ 22000 over period)
// ───────────────────────────────────────────────────────────────────────────
export function logReturnToPts(logRet, refSpot) {
  return (Math.exp(logRet) - 1) * refSpot;
}

// ───────────────────────────────────────────────────────────────────────────
// Self-test
// ───────────────────────────────────────────────────────────────────────────

if (process.argv.includes('--selftest')) {
  console.log('[lib] self-test starting');
  const t0 = Date.now();

  const { byMinute, sorted, atr20ByDate } = await loadNqOhlcv1m();
  console.log(`[ohlcv] minutes loaded: ${byMinute.size.toLocaleString()}`);
  console.log(`[ohlcv] first: ${sorted[0]?.symbol} @ ${new Date(sorted[0].ts).toISOString()}`);
  console.log(`[ohlcv] last:  ${sorted[sorted.length-1]?.symbol} @ ${new Date(sorted[sorted.length-1].ts).toISOString()}`);
  console.log(`[ohlcv] daily ATR20 sample 2025-06-15 = ${atr20ByDate.get('2025-06-15')?.toFixed(1)} pts`);

  const iv = await loadAtmIv1m();
  console.log(`[atm-iv-1m] minutes loaded: ${iv.size.toLocaleString()}`);

  const sdiv = await loadShortDteIv15m();
  console.log(`[short-dte-iv-15m] rows: ${sdiv.size.toLocaleString()}`);

  const gex = loadGexSnapshots('nq');
  console.log(`[gex] snapshots: ${gex.length.toLocaleString()}`);

  const aligned = await buildAlignedSample();
  console.log(`[aligned] samples: ${aligned.samples.length.toLocaleString()}`);
  console.log(`[aligned] skip-missing: ${aligned.skipMissing}, skip-rollover: ${aligned.skipRollover}, skip-contract-change: ${aligned.skipContractChange}`);
  console.log(`[aligned] first ts: ${aligned.samples[0]?.iso}`);
  console.log(`[aligned] last ts:  ${aligned.samples[aligned.samples.length-1]?.iso}`);
  const f = aligned.samples[0];
  if (f) {
    console.log(`[aligned] sample[0] entry=${f.entry_price} fwd_ret_15m=${f.fwd_ret_15m.toFixed(5)} fwd_ret_60m=${f.fwd_ret_60m.toFixed(5)}`);
  }

  console.log(`[lib] self-test complete in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
