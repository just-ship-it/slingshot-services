#!/usr/bin/env node
/**
 * Cross-source IV validation.
 *
 * Compares ATM IV computed from a saved Schwab options-chain snapshot
 * against ATM IV computed from a Databento OPRA TCBBO file at the same
 * point in time. Both are passed through calculateATMIVFromQuotes so the
 * algorithm is held constant — any divergence reflects disagreement
 * between the two market-data sources, not the code.
 *
 * Why this exists:
 *   The same-source parity harness (verify-iv-parity.js) proves the live
 *   calculator and the backtest CSV pipeline emit identical output on
 *   identical inputs. It does NOT prove that the live data feed (Schwab)
 *   agrees with the data the backtest was originally built against (OPRA).
 *
 * Limitation:
 *   Saved Schwab snapshots in this repo were captured before the
 *   2026-04-15 chain-fetch fix and therefore contain only 3-5 expirations
 *   instead of the full ~30. This script intersects the two sources by
 *   (expiration, strike, type), so the comparison is restricted to
 *   whatever overlap survives. Capture a fresh snapshot after deploy for
 *   true end-to-end validation.
 *
 * Usage:
 *   node scripts/verify-iv-cross-source.js \
 *       --snapshot data/schwab-snapshots/2026-03-13/snapshot_13-30-51.json \
 *       --tcbbo    data/schwab-snapshots/opra-pillar-20260313.tcbbo.csv \
 *       [--symbol QQQ]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import { calculateATMIVFromQuotes, calculateIV, BS_RISK_FREE_RATE } from '../../shared/utils/black-scholes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { symbol: 'QQQ' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--snapshot' && args[i + 1]) { out.snapshot = args[++i]; continue; }
    if (args[i] === '--tcbbo' && args[i + 1]) { out.tcbbo = args[++i]; continue; }
    if (args[i] === '--symbol' && args[i + 1]) { out.symbol = args[++i]; continue; }
  }
  if (!out.snapshot || !out.tcbbo) {
    console.error('Usage: --snapshot <path> --tcbbo <path> [--symbol QQQ]');
    process.exit(2);
  }
  return out;
}

/**
 * Parse "QQQ   YYMMDDTSSSSSSSS" into { strike, expiration, optionType }.
 */
function parseOcc(symbol, ticker) {
  const re = new RegExp(`^${ticker}\\s+(\\d{6})([CP])(\\d{8})$`);
  const m = symbol.match(re);
  if (!m) return null;
  const yy = parseInt(m[1].slice(0, 2));
  const mm = parseInt(m[1].slice(2, 4)) - 1;
  const dd = parseInt(m[1].slice(4, 6));
  return {
    expiration: new Date(Date.UTC(2000 + yy, mm, dd, 21, 0, 0)), // 4PM ET ≈ 21Z
    optionType: m[2],
    strike: parseInt(m[3]) / 1000
  };
}

/**
 * Load the snapshot's chains and flatten to the shape calculateATMIVFromQuotes
 * accepts. Returns { ts, options }.
 */
function loadSnapshot(filepath, ticker) {
  const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  const ts = new Date(data.timestamp);
  const chains = data.chains?.[ticker] || [];
  const flat = [];
  for (const chain of chains) {
    for (const o of chain.options || []) {
      if (!o.strike || !o.option_type || !o.expiration_date) continue;
      flat.push({
        symbol: o.symbol,
        strike: o.strike,
        optionType: o.option_type === 'call' ? 'C' : 'P',
        expiration: new Date(o.expiration_date + 'T16:00:00-05:00'),
        bid: o.bid,
        ask: o.ask
      });
    }
  }
  return { ts, options: flat };
}

/**
 * Build a point-in-time NBBO snapshot from TCBBO: for every option, take
 * the most recent quote at or before `cutoffMs`. Returns flattened option
 * list in the same shape as loadSnapshot.
 */
async function loadTCBBOAtTime(filepath, cutoffMs, ticker) {
  return new Promise((resolve, reject) => {
    const latest = new Map(); // symbol -> {bid, ask, ts}
    let header = null;
    let tsIdx, bidIdx, askIdx, symIdx;
    const rl = readline.createInterface({ input: fs.createReadStream(filepath), crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!header) {
        header = line.split(',');
        tsIdx = header.indexOf('ts_event');
        bidIdx = header.indexOf('bid_px_00');
        askIdx = header.indexOf('ask_px_00');
        symIdx = header.indexOf('symbol');
        return;
      }
      const c = line.split(',');
      if (c.length < symIdx + 1) return;
      const ts = new Date(c[tsIdx]).getTime();
      if (!Number.isFinite(ts) || ts > cutoffMs) return;
      const bid = parseFloat(c[bidIdx]);
      const ask = parseFloat(c[askIdx]);
      const sym = c[symIdx];
      if (!sym?.startsWith(ticker)) return;
      if (!(bid > 0) || !(ask > 0) || ask < bid) return;
      const prior = latest.get(sym);
      if (!prior || prior.ts < ts) {
        latest.set(sym, { bid, ask, ts });
      }
    });

    rl.on('close', () => {
      const flat = [];
      for (const [sym, q] of latest) {
        const parsed = parseOcc(sym, ticker);
        if (!parsed) continue;
        flat.push({
          symbol: sym,
          strike: parsed.strike,
          optionType: parsed.optionType,
          expiration: parsed.expiration,
          bid: q.bid,
          ask: q.ask
        });
      }
      resolve(flat);
    });
    rl.on('error', reject);
  });
}

/**
 * Restrict TCBBO to the (expirationDate, strike, type) tuples present in
 * the snapshot. This makes the two sources directly comparable in the face
 * of the snapshot's missing-expirations bug.
 */
function intersectByContract(snapOptions, tcbboOptions) {
  const key = o => `${o.expiration.toISOString().slice(0, 10)}|${o.strike}|${o.optionType}`;
  const snapKeys = new Set(snapOptions.map(key));
  return tcbboOptions.filter(o => snapKeys.has(key(o)));
}

function summarize(label, opts, spotPrice, asOf) {
  const r = calculateATMIVFromQuotes(opts, spotPrice, asOf);
  if (!r) return `${label}: no result`;
  return `${label}: callIV=${(r.callIV * 100).toFixed(3)}% putIV=${(r.putIV * 100).toFixed(3)}% skew=${((r.putIV - r.callIV) * 100).toFixed(3)}% strike=${r.atmStrike} dte=${r.dte}`;
}

/**
 * Estimate spot from put-call parity at the closest-to-money strike of the
 * shortest expiration with both sides quoted.
 */
function estimateSpot(options, asOfMs, riskFreeRate = 0.05) {
  const byExpThenStrike = new Map();
  for (const o of options) {
    if (!o.bid || !o.ask) continue;
    const expKey = o.expiration.getTime();
    if (!byExpThenStrike.has(expKey)) byExpThenStrike.set(expKey, new Map());
    const byStrike = byExpThenStrike.get(expKey);
    if (!byStrike.has(o.strike)) byStrike.set(o.strike, {});
    const slot = byStrike.get(o.strike);
    if (o.optionType === 'C') slot.call = o; else slot.put = o;
  }
  const sortedExps = [...byExpThenStrike.keys()].filter(e => e > asOfMs).sort();
  for (const expKey of sortedExps) {
    const T = Math.max((expKey - asOfMs) / (365 * 86400000), 1 / 365);
    const dfInv = Math.exp(riskFreeRate * T);
    let best = null, bestDelta = Infinity;
    for (const [K, slot] of byExpThenStrike.get(expKey)) {
      if (!slot.call || !slot.put) continue;
      const cMid = (slot.call.bid + slot.call.ask) / 2;
      const pMid = (slot.put.bid + slot.put.ask) / 2;
      const s = K + dfInv * (cMid - pMid);
      const delta = Math.abs(s - K);
      if (delta < bestDelta) { bestDelta = delta; best = s; }
    }
    if (best) return best;
  }
  return null;
}

async function main() {
  const { snapshot, tcbbo, symbol } = parseArgs();
  console.log(`\nCross-source IV validation`);
  console.log(`  snapshot: ${snapshot}`);
  console.log(`  tcbbo:    ${tcbbo}`);
  console.log(`  symbol:   ${symbol}\n`);

  const snap = loadSnapshot(snapshot, symbol);
  const cutoff = snap.ts.getTime();
  console.log(`Snapshot timestamp: ${snap.ts.toISOString()} (${snap.options.length} options)`);

  const snapExps = new Set(snap.options.map(o => o.expiration.toISOString().slice(0, 10)));
  console.log(`Snapshot expirations: ${[...snapExps].sort().join(', ')}`);

  console.log(`\nLoading TCBBO point-in-time NBBO @ snapshot ts...`);
  const tcbboFull = await loadTCBBOAtTime(tcbbo, cutoff, symbol);
  const tcbboExps = new Set(tcbboFull.map(o => o.expiration.toISOString().slice(0, 10)));
  console.log(`TCBBO expirations:    ${[...tcbboExps].sort().join(', ')}  (${tcbboFull.length} options)`);
  console.log(`Expirations in TCBBO but NOT in snapshot: ${[...tcbboExps].filter(e => !snapExps.has(e)).length}`);

  const tcbboIntersect = intersectByContract(snap.options, tcbboFull);
  console.log(`After intersecting by (exp, strike, type): ${tcbboIntersect.length} TCBBO options remain\n`);

  // Spot estimate from each source independently
  const snapSpot = estimateSpot(snap.options, cutoff);
  const tcbboSpot = estimateSpot(tcbboFull, cutoff);
  console.log(`Spot estimate — snapshot: ${snapSpot?.toFixed(2)}   TCBBO: ${tcbboSpot?.toFixed(2)}`);
  if (snapSpot && tcbboSpot) {
    console.log(`Spot agreement: |Δ|=${Math.abs(snapSpot - tcbboSpot).toFixed(4)}\n`);
  }

  // Use a shared spot for both sides so we're comparing IV not spot
  const spot = snapSpot ?? tcbboSpot;
  if (!spot) {
    console.error('Could not estimate spot from either source');
    process.exit(2);
  }

  const asOf = snap.ts;
  console.log('═══ ATM IV from each source (constrained to overlapping contracts) ═══');
  console.log(summarize('  SNAPSHOT  ', snap.options, spot, asOf));
  console.log(summarize('  TCBBO ∩   ', tcbboIntersect, spot, asOf));
  console.log('\n═══ ATM IV from each source (full chain — shows the bug magnitude) ═══');
  console.log(summarize('  SNAPSHOT  ', snap.options, spot, asOf));
  console.log(summarize('  TCBBO FULL', tcbboFull, spot, asOf));

  // Per-contract IV diff for transparency
  console.log('\n═══ Per-contract BS IV diff (overlap only) ═══');
  const snapByKey = new Map();
  for (const o of snap.options) {
    const k = `${o.expiration.toISOString().slice(0, 10)}|${o.strike}|${o.optionType}`;
    snapByKey.set(k, o);
  }
  const diffs = [];
  for (const t of tcbboIntersect) {
    const k = `${t.expiration.toISOString().slice(0, 10)}|${t.strike}|${t.optionType}`;
    const s = snapByKey.get(k);
    if (!s) continue;
    if (Math.abs(t.strike - spot) / spot > 0.02) continue;
    const T = Math.max((t.expiration.getTime() - cutoff) / (365 * 86400000), 1 / 365);
    const sMid = (s.bid + s.ask) / 2;
    const tMid = (t.bid + t.ask) / 2;
    if (sMid <= 0 || tMid <= 0) continue;
    const sIV = calculateIV(sMid, spot, t.strike, T, BS_RISK_FREE_RATE, t.optionType);
    const tIV = calculateIV(tMid, spot, t.strike, T, BS_RISK_FREE_RATE, t.optionType);
    if (sIV == null || tIV == null) continue;
    diffs.push({
      contract: `${t.expiration.toISOString().slice(0, 10)} ${t.strike}${t.optionType}`,
      snapBid: s.bid, snapAsk: s.ask, tcbboBid: t.bid, tcbboAsk: t.ask,
      snapIV: sIV, tcbboIV: tIV, ivDiff: sIV - tIV
    });
  }
  diffs.sort((a, b) => Math.abs(b.ivDiff) - Math.abs(a.ivDiff));
  for (const d of diffs.slice(0, 15)) {
    console.log(
      `  ${d.contract.padEnd(22)} ` +
      `snap ${d.snapBid.toFixed(2)}/${d.snapAsk.toFixed(2)} (IV ${(d.snapIV * 100).toFixed(2)}%)  ` +
      `tcbbo ${d.tcbboBid.toFixed(2)}/${d.tcbboAsk.toFixed(2)} (IV ${(d.tcbboIV * 100).toFixed(2)}%)  ` +
      `Δ=${(d.ivDiff * 100).toFixed(3)}%`
    );
  }
  if (diffs.length > 15) console.log(`  ... ${diffs.length - 15} more`);
  if (diffs.length) {
    const meanAbs = diffs.reduce((s, d) => s + Math.abs(d.ivDiff), 0) / diffs.length;
    console.log(`\n  Mean |IV diff| across ${diffs.length} contracts: ${(meanAbs * 100).toFixed(3)}%`);
  }
}

main().catch(err => { console.error('Error:', err); process.exit(2); });
