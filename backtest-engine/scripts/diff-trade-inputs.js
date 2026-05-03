#!/usr/bin/env node
/**
 * For each backtest trade entry on a given day, dump the strategy inputs
 * from BOTH sides:
 *   - Backtest side: cbbo-derived IV + cbbo-derived GEX walls at entry minute
 *   - Live side: Schwab-derived IV + Schwab-derived GEX walls at the
 *                nearest snapshot ≤ entry minute
 *
 * If the inputs match within tolerance, the strategy would produce the same
 * decision in live as in backtest. If they differ, this pinpoints whether
 * the divergence is in IV, GEX walls, regime, gamma_imbalance, or skew.
 *
 * Usage:
 *   node scripts/diff-trade-inputs.js --date 2026-04-29 --trades-json /tmp/v6-late-april.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExposureCalculator from '../../signal-generator/src/tradier/exposure-calculator.js';
import { calculateATMIVFromQuotes, BS_RISK_FREE_RATE } from '../../shared/utils/black-scholes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { negSkew: -0.015, posSkew: 0.0125 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) out.date = args[++i];
    if (args[i] === '--trades-json' && args[i + 1]) out.tradesJson = args[++i];
    if (args[i] === '--neg-skew' && args[i + 1]) out.negSkew = parseFloat(args[++i]);
    if (args[i] === '--pos-skew' && args[i + 1]) out.posSkew = parseFloat(args[++i]);
  }
  return out;
}

function estimateSpot(chain, asOfMs, r = 0.05) {
  const byStrike = new Map();
  for (const o of chain.options || []) {
    if (!o.strike || !o.option_type || !(o.bid > 0) || !(o.ask > 0)) continue;
    if (!byStrike.has(o.strike)) byStrike.set(o.strike, {});
    const slot = byStrike.get(o.strike);
    if (o.option_type === 'call') slot.call = o; else slot.put = o;
  }
  const expDate = chain.expiration || chain.options[0]?.expiration_date;
  const expMs = new Date(expDate + 'T16:00:00-05:00').getTime();
  const T = Math.max((expMs - asOfMs) / (365 * 86400000), 1 / 365);
  const dfInv = Math.exp(r * T);
  let best = null, bd = Infinity;
  for (const [K, slot] of byStrike) {
    if (!slot.call || !slot.put) continue;
    const cMid = (slot.call.bid + slot.call.ask) / 2;
    const pMid = (slot.put.bid + slot.put.ask) / 2;
    if (!(cMid > 0) || !(pMid > 0)) continue;
    const s = K + dfInv * (cMid - pMid);
    const d = Math.abs(s - K);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

// Black-Scholes ATM IV: simple bisection on call price for ATM strike
function bsCall(S, K, T, r, sigma) {
  if (T <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const N = (x) => 0.5 * (1 + erf(x / Math.sqrt(2)));
  return S * N(d1) - K * Math.exp(-r * T) * N(d2);
}
function bsPut(S, K, T, r, sigma) {
  return bsCall(S, K, T, r, sigma) + K * Math.exp(-r * T) - S;
}
function erf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function impliedVol(price, S, K, T, r, isCall) {
  let lo = 0.01, hi = 3.0;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const p = isCall ? bsCall(S, K, T, r, mid) : bsPut(S, K, T, r, mid);
    if (p > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// Flatten Schwab chains into the format calculateATMIVFromQuotes expects
function flattenChainsForATMIV(chains) {
  const flat = [];
  for (const chain of chains) {
    if (!chain?.options) continue;
    for (const o of chain.options) {
      if (!o || !o.strike || !o.option_type || !o.expiration_date) continue;
      const expMs = new Date(o.expiration_date + 'T16:00:00-05:00');
      flat.push({
        symbol: o.symbol,
        strike: o.strike,
        optionType: o.option_type === 'call' ? 'C' : 'P',
        expiration: expMs,
        bid: o.bid,
        ask: o.ask,
      });
    }
  }
  return flat;
}

// Compute ATM IV using the SAME shared function the live + backtest use.
// 7-45 DTE filter, ±2% moneyness, BS bisection — identical to precompute-iv.js.
function computeSchwabIV(chains, spot, asOfMs) {
  const flat = flattenChainsForATMIV(chains);
  const result = calculateATMIVFromQuotes(flat, spot, new Date(asOfMs), {
    minDTE: 7,
    maxDTE: 45,
    maxMoneyness: 0.02,
    riskFreeRate: BS_RISK_FREE_RATE,
  });
  if (!result || result.callIV == null || result.putIV == null) return null;
  return {
    iv: result.iv,
    callIV: result.callIV,
    putIV: result.putIV,
    skew: result.putIV - result.callIV,  // put-call (positive=fear)
    atmStrike: result.atmStrike,
    callDTE: result.callDTE,
    putDTE: result.putDTE,
  };
}

const { date, tradesJson, negSkew, posSkew } = parseArgs();
if (!date || !tradesJson) {
  console.error('Usage: --date YYYY-MM-DD --trades-json /path/to/trades.json');
  process.exit(1);
}

const allTrades = JSON.parse(fs.readFileSync(tradesJson, 'utf8')).trades;
const dayTrades = allTrades.filter((t) => {
  const d = new Date(t.entryTime);
  return d.toISOString().startsWith(date);
});

console.log(`Backtest trades on ${date}: ${dayTrades.length}\n`);

// Load Schwab snapshots for the day
const snapDir = path.join(DATA, 'schwab-snapshots', date);
const snapFiles = fs.readdirSync(snapDir).filter((f) => f.startsWith('snapshot_')).sort();
const snapshotsWithMs = snapFiles.map((f) => {
  const t = f.slice(9, 17).replace(/-/g, ':');
  const ms = new Date(`${date}T${t}Z`).getTime();
  return { f, ms };
});

// Load backtest GEX (cbbo-derived) snapshots for the day
const btGexFile = path.join(DATA, 'gex', 'nq-cbbo', `nq_gex_${date}.json`);
const btGex = JSON.parse(fs.readFileSync(btGexFile, 'utf8')).data;

// Load backtest 1m IV (cbbo-derived) — schema: timestamp,iv,spot_price,atm_strike,call_iv,put_iv,dte,call_iv_fwd,put_iv_fwd
const ivCsv = path.join(DATA, 'iv', 'qqq', 'qqq_atm_iv_1m.csv');
let btIvData = null;
if (fs.existsSync(ivCsv)) {
  btIvData = fs.readFileSync(ivCsv, 'utf8').trim().split('\n').slice(1)
    .filter((l) => l.startsWith(date))
    .map((line) => {
      const p = line.split(',');
      return { ts: p[0], iv: +p[1], spot: +p[2], atm: +p[3], callIV: +p[4], putIV: +p[5], skew: +p[5] - +p[4] };
    });
  console.log(`Loaded backtest IV for ${date}: ${btIvData.length} rows`);
}

const calc = new ExposureCalculator();

console.log('\n' + '='.repeat(120));
for (const trade of dayTrades) {
  const entryMs = trade.entryTime;
  const entryIso = new Date(entryMs).toISOString();
  // Strategy fires at signal/T-1 close, enters at T open. So inputs to the
  // decision are at the minute BEFORE entry.
  const signalMs = entryMs - 60_000;
  const signalIso = new Date(signalMs).toISOString();
  console.log(`\nTRADE ${trade.id}: ${trade.side}  entry @ ${entryIso}  px=${trade.entryPrice}  pnl=${trade.netPnL}  reason=${trade.exitReason}`);
  console.log(`  Signal evaluated at: ${signalIso} (T-1 close)`);
  console.log('-'.repeat(120));

  // Find nearest backtest GEX (15m bucket) ≤ signalMs
  const btGexCandidate = [...btGex].reverse().find((g) => new Date(g.timestamp).getTime() <= signalMs);
  if (btGexCandidate) {
    const m = btGexCandidate.multiplier;
    console.log(`  BT cbbo GEX @ ${btGexCandidate.timestamp.slice(11, 19)}:`);
    console.log(`    qqq_spot=${btGexCandidate.qqq_spot}  multiplier=${m.toFixed(4)}`);
    console.log(`    call_wall=${(btGexCandidate.call_wall/m).toFixed(2)} (NQ: ${btGexCandidate.call_wall})`);
    console.log(`    put_wall=${(btGexCandidate.put_wall/m).toFixed(2)} (NQ: ${btGexCandidate.put_wall})`);
    console.log(`    gamma_flip=${btGexCandidate.gamma_flip != null ? (btGexCandidate.gamma_flip/m).toFixed(2) : 'null'} (NQ: ${btGexCandidate.gamma_flip})`);
    console.log(`    total_gex=${(btGexCandidate.total_gex/1e9).toFixed(2)}B  regime=${btGexCandidate.regime}  imbalance=${btGexCandidate.gamma_imbalance?.toFixed(3)}`);
  } else {
    console.log('  BT cbbo GEX: NONE found ≤ entry');
  }

  // Find nearest Schwab snapshot ≤ signalMs
  const swSnap = [...snapshotsWithMs].reverse().find((s) => s.ms <= signalMs);
  if (swSnap) {
    const snap = JSON.parse(fs.readFileSync(path.join(snapDir, swSnap.f), 'utf8'));
    const qqqChains = snap.chains?.QQQ || [];
    const asOfMs = new Date(snap.timestamp).getTime();
    const spot = estimateSpot(qqqChains[0], asOfMs);
    if (spot) {
      const result = calc.calculateExposures({ QQQ: qqqChains }, { QQQ: spot }, { asOf: new Date(asOfMs) });
      const lvls = result.QQQ.levels || {};
      const ivData = computeSchwabIV(qqqChains, spot, asOfMs);
      console.log(`  SW Schwab GEX @ ${swSnap.f.slice(9, 17)}:`);
      console.log(`    qqq_spot=${spot.toFixed(2)}`);
      console.log(`    call_wall=${lvls.callWall}  put_wall=${lvls.putWall}  gamma_flip=${lvls.gammaFlip}`);
      console.log(`    total_gex=${(result.QQQ.totals.gex/1e9).toFixed(2)}B  regime=${result.QQQ.regime?.gex}`);
      if (ivData) {
        const trigger = ivData.skew < negSkew ? `✓ LONG trigger (skew<${(negSkew*100).toFixed(2)}%)` :
                        ivData.skew > posSkew ? `✓ SHORT trigger (skew>+${(posSkew*100).toFixed(2)}%)` :
                        '— no skew trigger';
        console.log(`  SW Schwab IV @ ATM ${ivData.atmStrike} (callDTE=${ivData.callDTE} putDTE=${ivData.putDTE}):`);
        console.log(`    iv=${(ivData.iv*100).toFixed(2)}%  callIV=${(ivData.callIV*100).toFixed(2)}%  putIV=${(ivData.putIV*100).toFixed(2)}%  skew(put-call)=${(ivData.skew*100).toFixed(3)}%  ${trigger}`);
      } else {
        console.log(`  SW Schwab IV: no ATM pair found in 7-45 DTE / 2% moneyness band`);
      }
    }
  } else {
    console.log('  SW Schwab snapshot: NONE found ≤ entry');
  }

  // Backtest IV at the signal minute (T-1, when strategy decided)
  if (btIvData) {
    const minute = signalIso.slice(0, 19);
    const btIv = btIvData.find((row) => row.ts.startsWith(minute) || row.ts === minute);
    if (btIv) {
      const trigger = btIv.skew < negSkew ? `✓ LONG trigger (skew<${(negSkew*100).toFixed(2)}%)` :
                      btIv.skew > posSkew ? `✓ SHORT trigger (skew>+${(posSkew*100).toFixed(2)}%)` :
                      '— no skew trigger';
      console.log(`  BT cbbo IV @ ${btIv.ts}:  iv=${(btIv.iv*100).toFixed(2)}%  callIV=${(btIv.callIV*100).toFixed(2)}%  putIV=${(btIv.putIV*100).toFixed(2)}%  skew(put-call)=${(btIv.skew*100).toFixed(3)}%  ${trigger}`);
    } else {
      console.log(`  BT cbbo IV @ ${minute}: not found in CSV`);
    }
  }
}

