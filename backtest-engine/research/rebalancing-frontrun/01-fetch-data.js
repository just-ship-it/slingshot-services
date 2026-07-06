#!/usr/bin/env node
/**
 * 01-fetch-data.js — Download daily data for the Harvey/Mazzoleni/Melone
 * rebalancing front-run replication (NBER w33554).
 *
 * Sources (all free, no API key):
 *   - Yahoo Finance chart API: SPY (equity leg, 1993→), IEF (bond leg, 2002→),
 *     VFITX (bond leg pre-IEF, 1991→), ES=F / ZN=F (futures cross-check, ~2000→)
 *   - FRED CSV: DGS10 (10Y constant-maturity yield, for the par-bond
 *     total-return construction), DTB3 (3M bill, diagnostics only)
 *
 * Output: data/<symbol>.csv with date,close,adjclose
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function fetchYahoo(symbol, outName) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=9999999999&interval=1d&events=div%2Csplit`;
  const raw = await fetchUrl(url);
  const json = JSON.parse(raw);
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`No chart result for ${symbol}: ${raw.slice(0, 200)}`);
  const ts = result.timestamp || [];
  const quote = result.indicators.quote[0];
  const adj = result.indicators.adjclose?.[0]?.adjclose || quote.close;
  const rows = ['date,close,adjclose'];
  for (let i = 0; i < ts.length; i++) {
    if (quote.close[i] == null || adj[i] == null) continue;
    // Yahoo timestamps are session-start epoch seconds (e.g. 13:30/14:30 UTC for
    // NYSE 09:30 ET open) — the UTC calendar date IS the session date for equities.
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    rows.push(`${d},${quote.close[i]},${adj[i]}`);
  }
  fs.writeFileSync(path.join(DATA_DIR, `${outName}.csv`), rows.join('\n') + '\n');
  console.log(`${symbol} → ${outName}.csv: ${rows.length - 1} rows (${rows[1]?.slice(0, 10)} → ${rows[rows.length - 1]?.slice(0, 10)})`);
}

async function fetchFred(series) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`;
  const raw = await fetchUrl(url);
  fs.writeFileSync(path.join(DATA_DIR, `${series}.csv`), raw);
  const lines = raw.trim().split('\n');
  console.log(`FRED ${series}: ${lines.length - 1} rows (${lines[1]?.slice(0, 10)} → ${lines[lines.length - 1]?.slice(0, 10)})`);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await fetchYahoo('SPY', 'SPY');
  await fetchYahoo('IEF', 'IEF');
  await fetchYahoo('VFITX', 'VFITX');
  await fetchYahoo('ES=F', 'ES_F');
  await fetchYahoo('ZN=F', 'ZN_F');
  await fetchFred('DGS10');
  await fetchFred('DTB3');
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
