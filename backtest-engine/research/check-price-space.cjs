#!/usr/bin/env node
/**
 * Check GEX nq_spot vs raw OHLCV price space alignment.
 * Compares the nq_spot field in GEX JSON (from generate-intraday-gex.py)
 * against the actual NQ close price in the raw OHLCV file at the same timestamp.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Dates to check across the full range
const dates = [
  '2023-04-03', '2023-06-01', '2023-09-15', '2023-12-01',
  '2024-01-15', '2024-03-15', '2024-06-03', '2024-09-16', '2024-12-02',
  '2025-03-03', '2025-06-02', '2025-09-15', '2025-12-01'
];

// Load raw OHLCV into a map: "YYYY-MM-DD HH:MM" -> [{symbol, close, volume}]
console.log('Loading raw NQ OHLCV...');
const nqCsv = fs.readFileSync(path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv'), 'utf-8');
const lines = nqCsv.split('\n');

// Build lookup: we only need the target dates
const targetDateSet = new Set(dates);
const ohlcvByKey = new Map();

for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split(',');
  if (parts.length < 8) continue;
  const ts = parts[0];
  const dateStr = ts.substring(0, 10);
  if (!targetDateSet.has(dateStr)) continue;

  const symbol = (parts[parts.length - 2] || parts[6] || '').trim();
  // Skip calendar spreads
  if (symbol.includes('-')) continue;

  const key = ts.substring(0, 16); // "YYYY-MM-DDTHH:MM"
  if (!ohlcvByKey.has(key)) ohlcvByKey.set(key, []);
  ohlcvByKey.get(key).push({
    symbol,
    close: parseFloat(parts[4]),
    volume: parseInt(parts[5]) || 0,
  });
}
console.log(`Loaded ${ohlcvByKey.size} timestamp keys from raw OHLCV\n`);

// Now check each date
console.log('Date       | GEX nq_spot | OHLCV close (primary) | Symbol  | Diff    | Diff %  | GEX gamma_flip | GEX put_wall');
console.log('-'.repeat(120));

for (const date of dates) {
  const gexFile = path.join(DATA_DIR, 'gex', 'nq', `nq_gex_${date}.json`);
  if (!fs.existsSync(gexFile)) {
    console.log(`${date} | no GEX file`);
    continue;
  }

  const gex = JSON.parse(fs.readFileSync(gexFile));
  if (!gex.data || gex.data.length === 0) {
    console.log(`${date} | empty GEX data`);
    continue;
  }

  // Find a midday snapshot (14:30 UTC = 9:30 ET or 10:30 ET depending on DST)
  let snap = gex.data.find(s => s.timestamp && s.timestamp.includes('14:30'));
  if (!snap) snap = gex.data.find(s => s.timestamp && s.timestamp.includes('15:30'));
  if (!snap) snap = gex.data[Math.floor(gex.data.length / 2)];

  const gexTs = snap.timestamp;
  const nqSpot = snap.nq_spot || snap.es_spot;

  // Find the matching OHLCV timestamp
  // GEX timestamps may be like "2024-06-03T14:30:00Z" or similar
  const gexKey = gexTs.substring(0, 16);
  const ohlcvEntries = ohlcvByKey.get(gexKey);

  if (!ohlcvEntries || ohlcvEntries.length === 0) {
    // Try nearby minutes
    console.log(`${date} | ${nqSpot?.toFixed(2) || 'N/A'} | no OHLCV match for ${gexKey}`);
    continue;
  }

  // Find primary contract (highest volume)
  let primary = ohlcvEntries[0];
  for (const e of ohlcvEntries) {
    if (e.volume > primary.volume) primary = e;
  }

  const diff = nqSpot - primary.close;
  const diffPct = (diff / primary.close * 100);

  console.log(
    `${date} | ${nqSpot.toFixed(2).padStart(11)} | ${primary.close.toFixed(2).padStart(21)} | ${primary.symbol.padEnd(7)} | ${diff.toFixed(2).padStart(7)} | ${diffPct.toFixed(3).padStart(6)}% | ${(snap.gamma_flip || 0).toFixed(2).padStart(14)} | ${(snap.put_wall || 0).toFixed(2).padStart(12)}`
  );
}

console.log('\n--- Additional check: What is nq_spot sourced from? ---');
// Check one GEX file in detail
const sampleDate = '2024-06-03';
const sampleGex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'gex', 'nq', `nq_gex_${sampleDate}.json`)));
const sampleSnap = sampleGex.data.find(s => s.timestamp && s.timestamp.includes('14:30'));
if (sampleSnap) {
  console.log(`\nSample GEX snapshot (${sampleDate} 14:30):`);
  console.log(`  nq_spot: ${sampleSnap.nq_spot}`);
  console.log(`  qqq_spot: ${sampleSnap.qqq_spot}`);
  console.log(`  multiplier: ${sampleSnap.multiplier}`);
  console.log(`  multiplier calc: nq_spot/qqq_spot = ${(sampleSnap.nq_spot / sampleSnap.qqq_spot).toFixed(6)}`);
  console.log(`  gamma_flip: ${sampleSnap.gamma_flip}`);
  console.log(`  put_wall: ${sampleSnap.put_wall}`);
  console.log(`  support[0]: ${sampleSnap.support ? sampleSnap.support[0] : 'N/A'}`);
  console.log(`  resistance[0]: ${sampleSnap.resistance ? sampleSnap.resistance[0] : 'N/A'}`);
}
