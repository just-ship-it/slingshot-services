/**
 * Build sub-minute (1s) OFI for the touch minutes of our events.
 *
 * The user's "fake-out" hypothesis: in the final 10-20s of a 1m bar,
 * volume comes in AGAINST the prior direction, signaling the reversal.
 * E.g.: first 40s of minute sells off → last 15s aggressive buying → next
 * bar opens up sharply.
 *
 * For each touch event:
 *   1. Locate the touch minute in the day's trades file
 *   2. Bin all trades into 1s buckets [t+0..t+59]
 *   3. Compute aggressor sign per trade (side='A' = buy aggressor, 'B' = sell aggressor)
 *      Note: we mirror the precomputed OFI sign convention (which was reversed
 *      vs the column name) — so signedFlow = -(buyVol - sellVol_per_columns).
 *      To stay consistent, we'll use semantic convention: positive = real
 *      buy aggression. Then for the FILTER, use semantic flow signs.
 *   4. Extract: 1s flow array, first-half vs second-half flow, biggest 1s
 *      flow spike + its timestamp within minute, "fake-out" detection
 *
 * Output: per-event sub-minute OFI features that we can join to the existing
 * t+60s walk dataset and test if "fake-out" → high WR.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const DATA_DIR = `${ROOT}/data`;
const OUT_DIR = `${ROOT}/research/output`;

// Load original t+60s touch dataset (has walks)
console.log('Loading touch dataset (t+60s walks)...');
const t60 = JSON.parse(fs.readFileSync(`${OUT_DIR}/gex-touch-flow-2026-05-14T05-52-19-372Z.json`));
const touches = t60.touches;
console.log(`Loaded ${touches.length.toLocaleString()} touches`);

// Index touches by date + touch minute
const touchesByDateMin = new Map();  // key: date|minuteTs → [event_index]
for (let i = 0; i < touches.length; i++) {
  const t = touches[i];
  const minTs = Math.floor(t.ts / 60000) * 60000;
  const key = `${t.date}|${minTs}`;
  if (!touchesByDateMin.has(key)) touchesByDateMin.set(key, []);
  touchesByDateMin.get(key).push(i);
}
console.log(`Unique (date,minute) keys with touches: ${touchesByDateMin.size.toLocaleString()}`);

// Group keys by date for batch processing
const datesNeeded = new Set();
for (const k of touchesByDateMin.keys()) datesNeeded.add(k.split('|')[0]);
const sortedDates = [...datesNeeded].sort();
console.log(`Dates to process: ${sortedDates.length}`);

// For each event, we'll compute sub-minute features
// Initialize feature placeholders
for (const t of touches) {
  t.s1ofi = null;
}

const STAT_FIRST_HALF = 30;   // first 30 seconds
const STAT_LAST_15 = 45;      // start of "last 15 sec" within 60s minute
const STAT_LAST_10 = 50;

// Pre-allocate buffers
function processDayTrades(dateStr, dateMinKeys) {
  // dateMinKeys: Map<minTs_int, [event_idx]>
  // Determine min/max minute we care about
  const minutes = [...dateMinKeys.keys()];
  if (minutes.length === 0) return;
  const minMinute = Math.min(...minutes);
  const maxMinute = Math.max(...minutes);

  const filePath = `${DATA_DIR}/orderflow/nq/trades/glbx-mdp3-${dateStr.replace(/-/g, '')}.trades.csv`;
  if (!fs.existsSync(filePath)) {
    // Check alternate path format
    return false;
  }

  // 1s OFI buckets per minute we care about
  // Map<minTs, Map<offsetSec, {buyVol, sellVol, buyTrades, sellTrades}>>
  const bins = new Map();
  for (const m of minutes) bins.set(m, new Map());

  // Stream trades
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let header = null;
  let scanned = 0, matched = 0;
  return new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      if (!header) { header = line; return; }
      scanned++;
      // ts_recv,ts_event,rtype,publisher_id,instrument_id,action,side,depth,price,size,flags,ts_in_delta,sequence,symbol
      const c0 = line.indexOf(',');
      const c1 = line.indexOf(',', c0 + 1);
      const tsRecvStr = line.slice(0, c0);
      // Parse only what we need
      const parts = line.split(',');
      if (parts.length < 14) return;
      if (parts[5] !== 'T') return;  // action must be 'T' (trade)
      const symbol = parts[13];
      if (symbol.includes('-')) return;
      const side = parts[6];
      const price = +parts[8];
      const size = +parts[9];
      if (isNaN(price) || isNaN(size)) return;
      // Trade time
      const ts = new Date(parts[1]).getTime();  // ts_event
      const minTs = Math.floor(ts / 60000) * 60000;
      if (minTs < minMinute || minTs > maxMinute) return;
      const minuteBin = bins.get(minTs);
      if (!minuteBin) return;
      // Aggressor classification:
      // Convention: side='A' = trade matched at ask side = aggressor bought from ask = BUY AGGRESSOR (real semantic)
      //             side='B' = trade matched at bid side = aggressor sold into bid = SELL AGGRESSOR
      // To match precomputed OFI sign convention (which had signedFlow = -netVolume),
      // we'll use REAL semantic: positive flow = buy aggression.
      const isBuy = side === 'A';
      const isSell = side === 'B';
      if (!isBuy && !isSell) return;
      matched++;
      const offsetSec = Math.floor((ts - minTs) / 1000);  // 0..59
      let cell = minuteBin.get(offsetSec);
      if (!cell) { cell = { buyVol: 0, sellVol: 0, buyTrades: 0, sellTrades: 0, price: price, symbol }; minuteBin.set(offsetSec, cell); }
      if (isBuy) { cell.buyVol += size; cell.buyTrades++; }
      else { cell.sellVol += size; cell.sellTrades++; }
      cell.price = price;  // last price
    });
    rl.on('close', () => {
      // Per touch event, compute features
      for (const [minTs, evIdxs] of dateMinKeys.entries()) {
        const bin = bins.get(minTs);
        if (!bin) continue;
        // Build dense 60s array
        const flow = new Array(60).fill(0);  // signed: buyVol - sellVol
        const buyVol = new Array(60).fill(0);
        const sellVol = new Array(60).fill(0);
        const totalVol = new Array(60).fill(0);
        const tradeCount = new Array(60).fill(0);
        for (let s = 0; s < 60; s++) {
          const c = bin.get(s);
          if (c) {
            flow[s] = c.buyVol - c.sellVol;
            buyVol[s] = c.buyVol;
            sellVol[s] = c.sellVol;
            totalVol[s] = c.buyVol + c.sellVol;
            tradeCount[s] = c.buyTrades + c.sellTrades;
          }
        }
        // Aggregates
        const firstHalfFlow = flow.slice(0, 30).reduce((s, v) => s + v, 0);
        const secondHalfFlow = flow.slice(30, 60).reduce((s, v) => s + v, 0);
        const last15Flow = flow.slice(45, 60).reduce((s, v) => s + v, 0);
        const last10Flow = flow.slice(50, 60).reduce((s, v) => s + v, 0);
        const last5Flow = flow.slice(55, 60).reduce((s, v) => s + v, 0);
        const totalFlow = flow.reduce((s, v) => s + v, 0);
        const firstHalfVol = totalVol.slice(0, 30).reduce((s, v) => s + v, 0);
        const secondHalfVol = totalVol.slice(30, 60).reduce((s, v) => s + v, 0);
        const last15Vol = totalVol.slice(45, 60).reduce((s, v) => s + v, 0);
        const last10Vol = totalVol.slice(50, 60).reduce((s, v) => s + v, 0);
        const totalVolMin = totalVol.reduce((s, v) => s + v, 0);
        // Largest 1s flow spike
        let maxAbsFlow = 0, maxAbsFlowAt = -1, maxAbsFlowSign = 0;
        for (let s = 0; s < 60; s++) {
          if (Math.abs(flow[s]) > maxAbsFlow) {
            maxAbsFlow = Math.abs(flow[s]); maxAbsFlowAt = s; maxAbsFlowSign = Math.sign(flow[s]);
          }
        }
        // Reversal flag: first-half flow and second-half flow have different signs
        // AND second-half flow magnitude is significant
        const firstHalfSign = Math.sign(firstHalfFlow);
        const secondHalfSign = Math.sign(secondHalfFlow);
        const reversalFlag = firstHalfSign !== 0 && secondHalfSign !== 0 && firstHalfSign !== secondHalfSign;

        const features = {
          totalFlow, totalVolMin, tradeCount: tradeCount.reduce((s, v) => s + v, 0),
          firstHalfFlow, secondHalfFlow, last15Flow, last10Flow, last5Flow,
          firstHalfVol, secondHalfVol, last15Vol, last10Vol,
          maxAbsFlow, maxAbsFlowAt, maxAbsFlowSign,
          firstHalfSign, secondHalfSign,
          reversalFlag,
          // ratio: second half volume vs first half
          volAccelRatio: firstHalfVol > 0 ? secondHalfVol / firstHalfVol : null,
          last15VolPct: totalVolMin > 0 ? last15Vol / totalVolMin : 0,
          last10VolPct: totalVolMin > 0 ? last10Vol / totalVolMin : 0,
        };
        for (const evIdx of evIdxs) touches[evIdx].s1ofi = features;
      }
      console.log(`  ${dateStr}: scanned=${scanned.toLocaleString()} matched=${matched.toLocaleString()} events_enriched=${[...dateMinKeys.values()].reduce((s, a) => s + a.length, 0)}`);
      resolve(true);
    });
    rl.on('error', reject);
  });
}

// Build per-date key map
const keysByDate = new Map();
for (const [k, evIdxs] of touchesByDateMin.entries()) {
  const [date, minTsStr] = k.split('|');
  const minTs = +minTsStr;
  if (!keysByDate.has(date)) keysByDate.set(date, new Map());
  keysByDate.get(date).set(minTs, evIdxs);
}

let dayIdx = 0;
const tStart = Date.now();
for (const date of sortedDates) {
  dayIdx++;
  const dmk = keysByDate.get(date);
  await processDayTrades(date, dmk);
  if (dayIdx % 20 === 0) {
    const enriched = touches.filter(t => t.s1ofi).length;
    console.log(`  ${dayIdx}/${sortedDates.length} (${((Date.now() - tStart)/1000).toFixed(0)}s) enriched=${enriched.toLocaleString()}`);
  }
}

const enriched = touches.filter(t => t.s1ofi).length;
console.log(`\nTotal enriched: ${enriched.toLocaleString()} / ${touches.length.toLocaleString()}`);

// Save (only the s1ofi field plus identifiers)
const out = touches.map(t => ({
  touch_id: t.touch_id,
  ts: t.ts,
  date: t.date,
  time_et: t.time_et,
  level_type: t.level_type,
  level_price: t.level_price,
  approach: t.approach,
  bounce: t.bounce,
  brk: t.brk,
  s1ofi: t.s1ofi,
}));
fs.writeFileSync(`${OUT_DIR}/touches-with-s1ofi.json`, JSON.stringify(out));
console.log(`Saved touches-with-s1ofi.json (${(fs.statSync(`${OUT_DIR}/touches-with-s1ofi.json`).size / 1e6).toFixed(0)}MB)`);
