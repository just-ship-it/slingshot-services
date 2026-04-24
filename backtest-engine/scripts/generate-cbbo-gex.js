#!/usr/bin/env node
/**
 * Generate GEX levels from CBBO intraday bid/ask data.
 *
 * Replicates the live exposure-calculator.js math so backtest GEX mirrors
 * what the live signal-generator sees. Key differences from the existing
 * generate-intraday-gex.py (statistics-based, 15m):
 *
 *   - IV: Brenner-Subrahmanyam from intraday CBBO mid price (not daily close)
 *   - Gamma: includes dividend yield factor (matching live)
 *   - TTE: 2.5-hour floor (matching live exposure-calculator.js:54-61)
 *   - Gamma flip: zero-crossing interpolation nearest to spot (matching live)
 *   - Walls: highest OI (matching live), not highest GEX magnitude
 *   - Configurable interval: 1m, 5m, 15m (live refreshes ~3m)
 *
 * Usage:
 *   node scripts/generate-cbbo-gex.js \
 *     --start 2026-04-20 --end 2026-04-22 \
 *     --interval 5 \
 *     --output-dir data/gex-cbbo/nq/
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, '..', 'data');

// Constants matching live exposure-calculator.js
const RISK_FREE_RATE = 0.05;
const DIVIDEND_YIELD = 0.01;
const MIN_TTE_HOURS = 2.5;
const MIN_TTE = MIN_TTE_HOURS / (24 * 365.25);

// ── Math helpers ────────────────────────────────────────────────────

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function calculateGamma(S, K, r, iv, T, q = DIVIDEND_YIELD) {
  if (T <= 0 || iv <= 0 || S <= 0 || K <= 0) return 0;
  const d1 = (Math.log(S / K) + (r - q + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
  return Math.exp(-q * T) * normalPDF(d1) / (S * iv * Math.sqrt(T));
}

function calculateVanna(S, K, r, iv, T, q = DIVIDEND_YIELD) {
  if (T <= 0 || iv <= 0 || S <= 0 || K <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * iv * iv) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  return -Math.exp(-q * T) * normalPDF(d1) * d2 / iv;
}

function calculateCharm(S, K, r, iv, T, q = DIVIDEND_YIELD) {
  if (T <= 0 || iv <= 0 || S <= 0 || K <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * iv * iv) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  return -Math.exp(-q * T) * normalPDF(d1) *
    (2 * (r - q) * T - d2 * iv * sqrtT) / (2 * T * iv * sqrtT);
}

/**
 * Brenner-Subrahmanyam IV approximation from option mid price.
 * Matches generate-intraday-gex.py:188-204.
 */
function approximateIV(mid, S, K, T, optionType) {
  const intrinsic = optionType === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  const timeValue = Math.max(mid - intrinsic, 0.01);
  let iv = (timeValue / S) * Math.sqrt(2 * Math.PI / T);
  return Math.max(0.05, Math.min(iv, 2.0));
}

// ── Option symbol parser ────────────────────────────────────────────

function parseOptionSymbol(sym) {
  const m = sym.match(/QQQ\s+(\d{6})([CP])(\d{8})/);
  if (!m) return null;
  const yy = parseInt(m[1].slice(0, 2));
  const mm = parseInt(m[1].slice(2, 4)) - 1;
  const dd = parseInt(m[1].slice(4, 6));
  return {
    expiration: new Date(2000 + yy, mm, dd, 16, 0, 0), // 4 PM ET
    optionType: m[2],
    strike: parseInt(m[3]) / 1000
  };
}

// ── Data loading ────────────────────────────────────────────────────

function loadStatistics(dateStr) {
  const statsDir = path.join(BASE_DIR, 'statistics', 'qqq');
  const filename = `opra-pillar-${dateStr.replace(/-/g, '')}.statistics.csv`;
  const filepath = path.join(statsDir, filename);

  if (!fs.existsSync(filepath)) return null;

  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.split('\n');
  const header = lines[0].split(',');
  const statTypeIdx = header.indexOf('stat_type');
  const quantityIdx = header.indexOf('quantity');
  const priceIdx = header.indexOf('price');
  const symbolIdx = header.indexOf('symbol');

  // stat_type 9 = OI, stat_type 11 = close price
  const oiMap = new Map();  // symbol → OI
  const closeMap = new Map(); // symbol → close price

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length <= symbolIdx) continue;
    const statType = parseInt(cols[statTypeIdx]);
    const sym = cols[symbolIdx];
    if (statType === 9) {
      const qty = parseInt(cols[quantityIdx]) || 0;
      const existing = oiMap.get(sym) || 0;
      if (qty > existing) oiMap.set(sym, qty);
    } else if (statType === 11) {
      const price = parseFloat(cols[priceIdx]);
      if (price > 0) closeMap.set(sym, price);
    }
  }

  return { oiMap, closeMap };
}

/**
 * Load CBBO data for a date, bucketed by interval.
 * Returns Map<intervalTs, Map<symbol, {bid, ask}>>
 */
async function loadCBBO(dateStr, intervalMinutes) {
  const cbboDir = path.join(BASE_DIR, 'cbbo-1m', 'qqq');
  // Try both naming conventions
  const name1 = `opra-pillar-${dateStr.replace(/-/g, '')}.cbbo-1m.0000.csv`;
  const name2 = `opra-pillar-${dateStr.replace(/-/g, '')}.cbbo-1m.csv`;
  let filepath = path.join(cbboDir, name1);
  if (!fs.existsSync(filepath)) filepath = path.join(cbboDir, name2);
  if (!fs.existsSync(filepath)) return null;

  const intervalMs = intervalMinutes * 60 * 1000;
  const intervals = new Map();

  return new Promise((resolve, reject) => {
    let header = null;
    let tsIdx, bidIdx, askIdx, symIdx;

    const rl = readline.createInterface({
      input: fs.createReadStream(filepath),
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      if (!header) {
        header = line.split(',');
        tsIdx = header.indexOf('ts_event');
        bidIdx = header.indexOf('bid_px_00');
        askIdx = header.indexOf('ask_px_00');
        symIdx = header.indexOf('symbol');
        return;
      }

      const cols = line.split(',');
      if (cols.length <= symIdx) return;

      const ts = new Date(cols[tsIdx]).getTime();
      if (isNaN(ts)) return;

      const bid = parseFloat(cols[bidIdx]);
      const ask = parseFloat(cols[askIdx]);
      const sym = cols[symIdx];

      if (!(bid > 0) || !(ask > 0) || ask < bid) return;
      if ((ask - bid) / bid > 0.5) return; // Skip wide spreads

      const bucket = Math.floor(ts / intervalMs) * intervalMs;
      if (!intervals.has(bucket)) intervals.set(bucket, new Map());
      intervals.get(bucket).set(sym, { bid, ask });
    });

    rl.on('close', () => resolve(intervals));
    rl.on('error', reject);
  });
}

/**
 * Load QQQ and NQ spot prices for a date from OHLCV files.
 * Returns Map<intervalTs, { qqq, nq }>
 */
function loadSpotPrices(dateStr, intervalMinutes) {
  const intervalMs = intervalMinutes * 60 * 1000;
  const spots = new Map();

  // QQQ
  const qqqPath = path.join(BASE_DIR, 'ohlcv', 'qqq', 'QQQ_ohlcv_1m.csv');
  if (fs.existsSync(qqqPath)) {
    const content = fs.readFileSync(qqqPath, 'utf8');
    for (const line of content.split('\n').slice(1)) {
      if (!line.includes(dateStr.replace(/-/g, '').slice(2))) {
        // Quick filter: skip lines that don't contain the date
        if (!line.startsWith('20' + dateStr.slice(2, 4))) continue;
        if (!line.includes(dateStr)) continue;
      }
      const cols = line.split(',');
      const ts = new Date(cols[0]).getTime();
      if (isNaN(ts)) continue;
      const close = parseFloat(cols[7]); // close column
      if (isNaN(close)) continue;
      const bucket = Math.floor(ts / intervalMs) * intervalMs;
      if (!spots.has(bucket)) spots.set(bucket, {});
      spots.get(bucket).qqq = close;
    }
  }

  // NQ — need to find the primary contract for this date
  const nqPath = path.join(BASE_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
  if (fs.existsSync(nqPath)) {
    const content = fs.readFileSync(nqPath, 'utf8');
    // Collect all NQ candles for this date, group by symbol to find primary
    const nqCandles = new Map(); // symbol → [{ts, close, volume}]
    for (const line of content.split('\n').slice(1)) {
      if (!line.includes(dateStr)) continue;
      const cols = line.split(',');
      const sym = cols[9]; // symbol column
      if (!sym || sym.includes('-')) continue; // skip spreads
      const ts = new Date(cols[0]).getTime();
      const close = parseFloat(cols[7]);
      const volume = parseInt(cols[8]) || 0;
      if (isNaN(ts) || isNaN(close)) continue;
      if (!nqCandles.has(sym)) nqCandles.set(sym, []);
      nqCandles.get(sym).push({ ts, close, volume });
    }

    // Find primary contract (highest total volume)
    let primarySym = null, maxVol = 0;
    for (const [sym, candles] of nqCandles) {
      const totalVol = candles.reduce((s, c) => s + c.volume, 0);
      if (totalVol > maxVol) { maxVol = totalVol; primarySym = sym; }
    }

    if (primarySym && nqCandles.has(primarySym)) {
      for (const c of nqCandles.get(primarySym)) {
        const bucket = Math.floor(c.ts / intervalMs) * intervalMs;
        if (!spots.has(bucket)) spots.set(bucket, {});
        spots.get(bucket).nq = c.close;
        spots.get(bucket).nqSymbol = primarySym;
      }
    }
  }

  return spots;
}

// ── GEX calculation ─────────────────────────────────────────────────

function calculateGEXSnapshot(cbboQuotes, oiMap, spotPrice, refDate) {
  const exposuresByStrike = new Map();
  let totalGEX = 0, totalVEX = 0, totalCEX = 0;
  let gammaAbove = 0, gammaBelow = 0;
  let optionsCount = 0;

  for (const [sym, quote] of cbboQuotes) {
    const parsed = parseOptionSymbol(sym);
    if (!parsed) continue;

    const oi = oiMap.get(sym) || 0;
    if (oi === 0) continue;

    const { strike, optionType, expiration } = parsed;
    const mid = (quote.bid + quote.ask) / 2;

    // TTE with 2.5-hour floor (matching live exposure-calculator.js:54-61)
    let tte = Math.max(0, (expiration - refDate) / (1000 * 60 * 60 * 24 * 365.25));
    tte = Math.max(MIN_TTE, tte);

    // IV from CBBO mid price
    const iv = approximateIV(mid, spotPrice, strike, tte, optionType);

    // Gamma with dividend yield (matching live)
    const gamma = calculateGamma(spotPrice, strike, RISK_FREE_RATE, iv, tte, DIVIDEND_YIELD);
    const vanna = calculateVanna(spotPrice, strike, RISK_FREE_RATE, iv, tte, DIVIDEND_YIELD);
    const charm = calculateCharm(spotPrice, strike, RISK_FREE_RATE, iv, tte, DIVIDEND_YIELD);

    // Position sign: calls +1, puts -1 (market maker short calls, long puts)
    const sign = optionType === 'C' ? 1 : -1;

    const gex = sign * gamma * oi * 100 * spotPrice * spotPrice * 0.01;
    const vex = sign * vanna * oi * 100 * spotPrice;
    const cex = sign * charm * oi * 100 * spotPrice;

    if (!exposuresByStrike.has(strike)) {
      exposuresByStrike.set(strike, { gex: 0, vex: 0, cex: 0, callOI: 0, putOI: 0 });
    }
    const sd = exposuresByStrike.get(strike);
    sd.gex += gex;
    sd.vex += vex;
    sd.cex += cex;
    if (optionType === 'C') sd.callOI += oi;
    else sd.putOI += oi;

    totalGEX += gex;
    totalVEX += vex;
    totalCEX += cex;

    // Gamma above/below spot (for imbalance)
    if (strike > spotPrice) gammaAbove += Math.abs(gex);
    else gammaBelow += Math.abs(gex);

    optionsCount++;
  }

  if (optionsCount === 0) return null;

  // Find key levels (matching live exposure-calculator.js:354-465)
  const strikes = Array.from(exposuresByStrike.keys()).sort((a, b) => a - b);

  // Gamma flip: zero-crossing interpolation nearest to spot
  let gammaFlip = spotPrice;
  let bestDist = Infinity;
  for (let i = 0; i < strikes.length - 1; i++) {
    const s1 = strikes[i], s2 = strikes[i + 1];
    const g1 = exposuresByStrike.get(s1).gex;
    const g2 = exposuresByStrike.get(s2).gex;
    if ((g1 > 0 && g2 < 0) || (g1 < 0 && g2 > 0)) {
      const ratio = Math.abs(g1) / (Math.abs(g1) + Math.abs(g2));
      const crossing = s1 + (s2 - s1) * ratio;
      const dist = Math.abs(crossing - spotPrice);
      if (dist < bestDist) { bestDist = dist; gammaFlip = crossing; }
    }
  }

  // Call/put walls: highest OI (matching live, NOT highest GEX)
  let callWall = null, putWall = null, maxCallOI = 0, maxPutOI = 0;
  let callWallGex = 0, putWallGex = 0;
  for (const [strike, data] of exposuresByStrike) {
    if (data.callOI > maxCallOI) { maxCallOI = data.callOI; callWall = strike; callWallGex = data.gex; }
    if (data.putOI > maxPutOI) { maxPutOI = data.putOI; putWall = strike; putWallGex = data.gex; }
  }

  // Resistance: top 5 strikes above spot by callOI + |gex|/1e6 (matching live)
  const resistance = Array.from(exposuresByStrike.entries())
    .filter(([k]) => k > spotPrice)
    .map(([k, v]) => ({ strike: k, score: v.callOI + Math.abs(v.gex) / 1e6, gex: v.gex }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .sort((a, b) => a.strike - b.strike);

  // Support: top 5 strikes below spot
  const support = Array.from(exposuresByStrike.entries())
    .filter(([k]) => k < spotPrice)
    .map(([k, v]) => ({ strike: k, score: v.putOI + Math.abs(v.gex) / 1e6, gex: v.gex }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .sort((a, b) => b.strike - a.strike);

  // Gamma imbalance
  const gammaImbalance = (gammaAbove + gammaBelow) > 0
    ? (gammaAbove - gammaBelow) / (gammaAbove + gammaBelow) : 0;

  // Regime
  let regime = 'neutral';
  if (totalGEX > 5e9) regime = 'strong_positive';
  else if (totalGEX > 1e9) regime = 'positive';
  else if (totalGEX < -5e9) regime = 'strong_negative';
  else if (totalGEX < -1e9) regime = 'negative';

  return {
    gamma_flip: Math.round(gammaFlip * 100) / 100,
    call_wall: callWall,
    call_wall_gex: callWallGex,
    put_wall: putWall,
    put_wall_gex: putWallGex,
    total_gex: totalGEX,
    total_vex: totalVEX,
    total_cex: totalCEX,
    gamma_above_spot: gammaAbove,
    gamma_below_spot: gammaBelow,
    gamma_imbalance: gammaImbalance,
    resistance: resistance.map(r => r.strike),
    resistance_gex: resistance.map(r => r.gex),
    support: support.map(s => s.strike),
    support_gex: support.map(s => s.gex),
    regime,
    options_count: optionsCount
  };
}

// ── Main ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    start: null, end: null, interval: 5,
    outputDir: path.join(BASE_DIR, 'gex-cbbo', 'nq')
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) out.start = args[++i];
    else if (args[i] === '--end' && args[i + 1]) out.end = args[++i];
    else if (args[i] === '--interval' && args[i + 1]) out.interval = parseInt(args[++i]);
    else if (args[i] === '--output-dir' && args[i + 1]) out.outputDir = args[++i];
  }
  if (!out.start || !out.end) {
    console.log('Usage: node generate-cbbo-gex.js --start YYYY-MM-DD --end YYYY-MM-DD [--interval 5] [--output-dir path]');
    process.exit(1);
  }
  return out;
}

function tradingDays(startStr, endStr) {
  const dates = [];
  const current = new Date(startStr + 'T12:00:00Z');
  const end = new Date(endStr + 'T12:00:00Z');
  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) { // Skip weekends
      dates.push(current.toISOString().slice(0, 10));
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function processDate(dateStr, intervalMinutes, outputDir) {
  // Load data sources
  const stats = loadStatistics(dateStr);
  if (!stats) { process.stdout.write(` no statistics\n`); return 0; }

  const cbboIntervals = await loadCBBO(dateStr, intervalMinutes);
  if (!cbboIntervals) { process.stdout.write(` no CBBO\n`); return 0; }

  const spots = loadSpotPrices(dateStr, intervalMinutes);

  const snapshots = [];

  const sortedBuckets = Array.from(cbboIntervals.keys()).sort();
  for (const bucket of sortedBuckets) {
    const spotData = spots.get(bucket);
    if (!spotData?.qqq || !spotData?.nq) continue;

    const qqqSpot = spotData.qqq;
    const nqSpot = spotData.nq;
    const multiplier = nqSpot / qqqSpot;

    const cbboQuotes = cbboIntervals.get(bucket);
    const refDate = new Date(bucket);

    const result = calculateGEXSnapshot(cbboQuotes, stats.oiMap, qqqSpot, refDate);
    if (!result) continue;

    // Convert QQQ levels to NQ price space
    snapshots.push({
      timestamp: new Date(bucket).toISOString(),
      nq_spot: Math.round(nqSpot * 100) / 100,
      qqq_spot: Math.round(qqqSpot * 100) / 100,
      multiplier: Math.round(multiplier * 10000) / 10000,
      gamma_flip: Math.round(result.gamma_flip * multiplier * 100) / 100,
      call_wall: Math.round(result.call_wall * multiplier * 100) / 100,
      call_wall_gex: result.call_wall_gex,
      put_wall: Math.round(result.put_wall * multiplier * 100) / 100,
      put_wall_gex: result.put_wall_gex,
      total_gex: result.total_gex,
      total_vex: result.total_vex,
      total_cex: result.total_cex,
      gamma_above_spot: result.gamma_above_spot,
      gamma_below_spot: result.gamma_below_spot,
      gamma_imbalance: result.gamma_imbalance,
      resistance: result.resistance.map(s => Math.round(s * multiplier * 100) / 100),
      resistance_gex: result.resistance_gex,
      support: result.support.map(s => Math.round(s * multiplier * 100) / 100),
      support_gex: result.support_gex,
      regime: result.regime,
      options_count: result.options_count
    });
  }

  if (snapshots.length === 0) { process.stdout.write(` no valid snapshots\n`); return 0; }

  // Write JSON (same format as generate-intraday-gex.py output)
  const output = {
    metadata: {
      symbol: 'NQ',
      source_symbol: 'QQQ',
      date: dateStr,
      interval_minutes: intervalMinutes,
      method: 'cbbo',
      generated: new Date().toISOString(),
      snapshots: snapshots.length
    },
    data: snapshots
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `nq_gex_${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  return snapshots.length;
}

async function main() {
  const args = parseArgs();
  const dates = tradingDays(args.start, args.end);

  console.log(`\nGenerating CBBO-based GEX levels`);
  console.log(`  Period: ${args.start} → ${args.end} (${dates.length} trading days)`);
  console.log(`  Interval: ${args.interval}m`);
  console.log(`  Output: ${args.outputDir}\n`);

  let totalFiles = 0, totalSnapshots = 0;

  for (const dateStr of dates) {
    process.stdout.write(`Processing ${dateStr}...`);
    const count = await processDate(dateStr, args.interval, args.outputDir);
    if (count > 0) {
      process.stdout.write(` ${count} snapshots\n`);
      totalFiles++;
      totalSnapshots += count;
    }
  }

  console.log(`\nGenerated ${totalFiles} files, ${totalSnapshots} total snapshots`);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
