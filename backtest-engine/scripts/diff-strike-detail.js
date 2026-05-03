#!/usr/bin/env node
/**
 * Drill into one specific strike for one snapshot — dump live and backtest
 * inputs (OI, IV, gamma, time-to-expiry, bid/ask) per expiration, side.
 *
 * Used to find why a single strike diverges in GEX between live and backtest.
 *
 * Usage:
 *   node scripts/diff-strike-detail.js --date 2026-04-29 --time 13:45 --strike 650
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import ExposureCalculator from '../../signal-generator/src/tradier/exposure-calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) out.date = args[++i];
    if (args[i] === '--time' && args[i + 1]) out.time = args[++i];
    if (args[i] === '--strike' && args[i + 1]) out.strike = parseFloat(args[++i]);
  }
  return out;
}

const { date, time, strike } = parseArgs();
if (!date || !time || strike == null) {
  console.error('Usage: --date YYYY-MM-DD --time HH:MM --strike <strike>');
  process.exit(1);
}

const targetMs = new Date(`${date}T${time}:00Z`).getTime();
console.log(`\n=== Strike ${strike} divergence analysis at ${date} ${time}Z ===\n`);

// ─── 1. Schwab snapshot (live side) ──────────────────────────────────
const snapDir = path.join(DATA, 'schwab-snapshots', date);
const files = fs.readdirSync(snapDir).filter((f) => f.startsWith('snapshot_'));
let nearest = null, nDiff = Infinity;
for (const f of files) {
  const t = f.slice(9, 17).replace(/-/g, ':');
  const ms = new Date(`${date}T${t}Z`).getTime();
  const dt = Math.abs(ms - targetMs);
  if (dt < nDiff) { nDiff = dt; nearest = f; }
}
const snap = JSON.parse(fs.readFileSync(path.join(snapDir, nearest), 'utf8'));
const qqqChains = snap.chains?.QQQ || [];
console.log(`Schwab snapshot: ${nearest}`);

// Pull all options at this strike across all expirations
const liveOpts = [];
for (const chain of qqqChains) {
  for (const o of chain.options || []) {
    if (o.strike === strike) liveOpts.push({ ...o, _exp: chain.expiration });
  }
}
liveOpts.sort((a, b) => a._exp.localeCompare(b._exp));

console.log(`Live: ${liveOpts.length} contracts at strike ${strike}\n`);

// Compute spot (parity)
function estimateSpot(chain, asOfMs, riskFreeRate = 0.05) {
  const byStrike = new Map();
  for (const o of chain.options || []) {
    if (!o.strike || !o.option_type || !(o.bid > 0) || !(o.ask > 0)) continue;
    if (!byStrike.has(o.strike)) byStrike.set(o.strike, {});
    const slot = byStrike.get(o.strike);
    if (o.option_type === 'call') slot.call = o; else slot.put = o;
  }
  const expDate = chain.expiration || chain.options[0]?.expiration_date;
  if (!expDate) return null;
  const expMs = new Date(expDate + 'T16:00:00-05:00').getTime();
  const T = Math.max((expMs - asOfMs) / (365 * 86400000), 1 / 365);
  const dfInv = Math.exp(riskFreeRate * T);
  let best = null, bestDelta = Infinity;
  for (const [K, slot] of byStrike) {
    if (!slot.call || !slot.put) continue;
    const cMid = (slot.call.bid + slot.call.ask) / 2;
    const pMid = (slot.put.bid + slot.put.ask) / 2;
    if (!(cMid > 0) || !(pMid > 0)) continue;
    const s = K + dfInv * (cMid - pMid);
    const delta = Math.abs(s - K);
    if (delta < bestDelta) { bestDelta = delta; best = s; }
  }
  return best;
}
const asOfMs = new Date(snap.timestamp).getTime();
const spot = estimateSpot(qqqChains[0], asOfMs);
console.log(`Spot (parity): ${spot.toFixed(4)}`);

const calc = new ExposureCalculator();

console.log('\n┌─ Live (Schwab) per-contract values at strike ' + strike + ' ─────');
console.log(`${'expiration'.padStart(12)} ${'type'.padStart(5)} ${'OI'.padStart(8)} ${'vol'.padStart(6)} ${'bid'.padStart(8)} ${'ask'.padStart(8)} ${'iv'.padStart(7)} ${'gamma'.padStart(11)} ${'gex (M)'.padStart(10)} ${'kept'.padStart(5)}`);
let liveGexTotal = 0;
for (const o of liveOpts) {
  const oi = o.open_interest || 0;
  const vol = o.volume || 0;
  const kept = (oi > 0 && vol > 0);
  const ivApprox = calc.bsApproxIV(o, spot);
  const tte = calc.calculateTimeToExpiry(new Date(o.expiration_date));
  const gamma = calc.calculateGamma(spot, strike, calc.riskFreeRate, ivApprox, tte, calc.dividendYield);
  const gex = kept ? calc.calculateGEX(o, spot) : 0;
  if (kept) liveGexTotal += gex;
  console.log(`${o._exp.padStart(12)} ${o.option_type.padStart(5)} ${String(oi).padStart(8)} ${String(vol).padStart(6)} ${String(o.bid).padStart(8)} ${String(o.ask).padStart(8)} ${ivApprox.toFixed(4).padStart(7)} ${gamma.toExponential(2).padStart(11)} ${(gex / 1e6).toFixed(2).padStart(10)} ${(kept ? '✓' : '×').padStart(5)}`);
}
console.log(`Live total GEX at strike ${strike}: ${(liveGexTotal / 1e6).toFixed(2)}M`);

// ─── 2. Backtest side ────────────────────────────────────────────────
console.log('\n┌─ Backtest per-contract values at strike ' + strike + ' ──────');

// Load statistics file for OI + close prices for all contracts at this strike
const statsPath = path.join(DATA, 'statistics', 'qqq', `opra-pillar-${date.replace(/-/g, '')}.statistics.csv`);
const statsLines = fs.readFileSync(statsPath, 'utf8').trim().split('\n');
const statsHdr = statsLines[0].split(',');
const stIdx = {};
for (let i = 0; i < statsHdr.length; i++) stIdx[statsHdr[i]] = i;
// Aggregate OI (stat 9) and close (stat 11) per symbol
const oiBySym = new Map(), closeBySym = new Map();
for (let i = 1; i < statsLines.length; i++) {
  const c = statsLines[i].split(',');
  const sym = c[stIdx.symbol];
  const stat = parseInt(c[stIdx.stat_type]);
  if (stat === 9) {
    const q = parseInt(c[stIdx.quantity]);
    oiBySym.set(sym, Math.max(oiBySym.get(sym) || 0, q));
  } else if (stat === 11) {
    const p = parseFloat(c[stIdx.price]);
    closeBySym.set(sym, Math.max(closeBySym.get(sym) || 0, p));
  }
}
// Filter symbols at this strike (parse strike from OCC sym format: "QQQ   YYMMDDTSSSSSSSS")
const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
const targetSymsAtStrike = [];
for (const sym of oiBySym.keys()) {
  const trimmed = sym.trim();
  const contract = trimmed.split(/\s+/).pop();
  if (contract.length < 15) continue;
  if (contract.slice(7) === strikeStr) {
    targetSymsAtStrike.push(sym);
  }
}
targetSymsAtStrike.sort();

// Now load cbbo bucket for this minute to override close_price
const minuteUtc = `${date}T${time}:00`;
const bucketStartMs = Math.floor(targetMs / (15 * 60 * 1000)) * (15 * 60 * 1000);
const bucketEndMs = bucketStartMs + 15 * 60 * 1000;
const bucketStartIso = new Date(bucketStartMs).toISOString();

console.log(`Bucket: ${bucketStartIso} (15-min ending here, contains target ${time}Z)`);

// Read cbbo file for this date — use streaming to avoid loading 580MB into memory
const cbboPath = path.join(DATA, 'cbbo-1m', 'qqq', `opra-pillar-${date.replace(/-/g, '')}.cbbo-1m.csv`);
const cbboMidBySym = new Map(); // last-seen mid in bucket per symbol
{
  const rl = readline.createInterface({ input: fs.createReadStream(cbboPath), crlfDelay: Infinity });
  let hdr = null, h = {};
  for await (const line of rl) {
    if (!hdr) {
      hdr = line.split(',');
      for (let i = 0; i < hdr.length; i++) h[hdr[i]] = i;
      continue;
    }
    // Quick string filter: rows for this strike contain the strike marker.
    // Contract is at the end after 7 spaces; we filter loosely first.
    if (!line.includes(strikeStr)) continue;
    const cols = line.split(',');
    const sym = cols[h.symbol];
    const trimmed = sym.trim();
    const contract = trimmed.split(/\s+/).pop();
    if (contract.length < 15 || contract.slice(7) !== strikeStr) continue;
    // Parse ts to check it's in bucket
    const tsEvent = cols[h.ts_event];
    if (!tsEvent) continue;
    const tsMs = new Date(tsEvent).getTime();
    if (tsMs < bucketStartMs || tsMs >= bucketEndMs) continue;
    const bid = parseFloat(cols[h.bid_px_00]);
    const ask = parseFloat(cols[h.ask_px_00]);
    if (!(bid > 0) || !(ask > 0)) continue;
    cbboMidBySym.set(sym, (bid + ask) / 2);
  }
}

// Calculate GEX for each contract using backtest formulas
const RISK_FREE_RATE = 0.05;
function bsTimeValue(price, S, K, type) {
  const intrinsic = type === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  return price - intrinsic;
}
function bsApproxIV(timeValue, S, T) {
  if (timeValue <= 0) return 0.05;
  const iv = (timeValue / S) * Math.sqrt(2 * Math.PI / T);
  return Math.max(0.05, Math.min(2.0, iv));
}
function pdf(x) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }
function bsGamma(S, K, r, sigma, T) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return pdf(d1) / (S * sigma * Math.sqrt(T));
}

console.log(`${'expiration'.padStart(10)} ${'type'.padStart(5)} ${'oi'.padStart(8)} ${'close_src'.padStart(10)} ${'price'.padStart(7)} ${'iv'.padStart(7)} ${'gamma'.padStart(11)} ${'gex (M)'.padStart(10)} ${'kept'.padStart(5)}`);

// Use backtest spot (futures-derived NQ spot / multiplier) — actually backtest uses qqq_spot from XNAS data
// For diff purposes use the same parity spot
const refDate = new Date(date + 'T00:00:00Z');
let btGexTotal = 0;
for (const sym of targetSymsAtStrike) {
  const trimmed = sym.trim();
  const contract = trimmed.split(/\s+/).pop();
  const yymmdd = contract.slice(0, 6);
  const optType = contract.slice(6, 7); // 'C' or 'P'
  const expYear = 2000 + parseInt(yymmdd.slice(0, 2));
  const expMonth = parseInt(yymmdd.slice(2, 4));
  const expDay = parseInt(yymmdd.slice(4, 6));
  const expDate = new Date(Date.UTC(expYear, expMonth - 1, expDay));
  const dte = Math.max(1, Math.floor((expDate.getTime() - refDate.getTime()) / 86400000));
  if (dte <= 0) continue;
  const oi = oiBySym.get(sym) || 0;
  if (oi <= 0) continue;
  const cbboMid = cbboMidBySym.get(sym);
  const closePrice = cbboMid != null ? cbboMid : closeBySym.get(sym);
  const closeSrc = cbboMid != null ? 'cbbo' : 'stat11';
  if (!(closePrice > 0)) continue;
  const T = Math.max(dte / 365.0, 0.001);
  const tv = bsTimeValue(closePrice, spot, strike, optType);
  const iv = bsApproxIV(tv, spot, T);
  const gamma = bsGamma(spot, strike, RISK_FREE_RATE, iv, T);
  const gex = (optType === 'P' ? -1 : 1) * gamma * oi * 100 * spot * spot * 0.01;
  btGexTotal += gex;
  const expStr = `${expYear}-${String(expMonth).padStart(2, '0')}-${String(expDay).padStart(2, '0')}`;
  console.log(`${expStr.padStart(10)} ${optType.padStart(5)} ${String(oi).padStart(8)} ${closeSrc.padStart(10)} ${closePrice.toFixed(2).padStart(7)} ${iv.toFixed(4).padStart(7)} ${gamma.toExponential(2).padStart(11)} ${(gex / 1e6).toFixed(2).padStart(10)} ${' '.padStart(5)}`);
}
console.log(`Backtest total GEX at strike ${strike}: ${(btGexTotal / 1e6).toFixed(2)}M`);

console.log(`\n=== Summary ===`);
console.log(`Live total GEX:     ${(liveGexTotal / 1e6).toFixed(2)}M`);
console.log(`Backtest total GEX: ${(btGexTotal / 1e6).toFixed(2)}M`);
console.log(`Diff:               ${((liveGexTotal - btGexTotal) / 1e6).toFixed(2)}M`);
