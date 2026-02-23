/**
 * NQ Price Action Analysis: October 13-17, 2025
 * Analyzes RTH price action to understand market conditions.
 */

import fs from 'fs';
import readline from 'readline';

const DATA_FILE = '/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv';

// Date range: Oct 13-17, 2025
const START_DATE = new Date('2025-10-13T00:00:00Z');
const END_DATE = new Date('2025-10-18T00:00:00Z'); // exclusive

// RTH hours in ET: 9:30 AM - 4:00 PM
// ET = UTC-4 during EDT (Oct is still EDT)
const RTH_START_HOUR = 13; // 9:30 AM ET = 13:30 UTC during EDT
const RTH_START_MIN = 30;
const RTH_END_HOUR = 20;   // 4:00 PM ET = 20:00 UTC during EDT
const RTH_END_MIN = 0;

function isRTH(date) {
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const timeVal = h * 60 + m;
  const rthStart = RTH_START_HOUR * 60 + RTH_START_MIN; // 13:30 UTC = 810
  const rthEnd = RTH_END_HOUR * 60 + RTH_END_MIN;       // 20:00 UTC = 1200
  return timeVal >= rthStart && timeVal < rthEnd;
}

function formatET(date) {
  // EDT offset: UTC-4
  const et = new Date(date.getTime() - 4 * 60 * 60 * 1000);
  const h = et.getUTCHours();
  const m = et.getUTCMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${m} ${ampm} ET`;
}

function getDateKey(date) {
  return date.toISOString().substring(0, 10);
}

async function loadData() {
  const candles = [];
  const fileStream = fs.createReadStream(DATA_FILE);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let isHeader = true;
  let lineCount = 0;
  let filteredIn = 0;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    lineCount++;

    const parts = line.split(',');
    if (parts.length < 10) continue;

    const [ts_event, rtype, publisher_id, instrument_id, open, high, low, close, volume, symbol] = parts;

    // Filter calendar spreads
    if (symbol && symbol.trim().includes('-')) continue;

    const date = new Date(ts_event);
    if (isNaN(date.getTime())) continue;

    // Only load our date range
    if (date < START_DATE || date >= END_DATE) continue;

    candles.push({
      ts: date,
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseInt(volume) || 0,
      symbol: symbol ? symbol.trim() : ''
    });
    filteredIn++;
  }

  console.log(`Loaded ${filteredIn} candles in date range (from ${lineCount} total lines scanned)\n`);
  return candles;
}

function filterPrimaryContract(candles) {
  // Group by hour, find highest-volume symbol per hour, keep only those candles
  const hourGroups = new Map();

  for (const c of candles) {
    const hourKey = `${getDateKey(c.ts)}-${c.ts.getUTCHours()}`;
    if (!hourGroups.has(hourKey)) hourGroups.set(hourKey, new Map());
    const symbolMap = hourGroups.get(hourKey);
    if (!symbolMap.has(c.symbol)) symbolMap.set(c.symbol, 0);
    symbolMap.set(c.symbol, symbolMap.get(c.symbol) + c.volume);
  }

  // Determine primary symbol per hour
  const primaryByHour = new Map();
  for (const [hourKey, symbolMap] of hourGroups) {
    let maxVol = -1, primary = '';
    for (const [sym, vol] of symbolMap) {
      if (vol > maxVol) { maxVol = vol; primary = sym; }
    }
    primaryByHour.set(hourKey, primary);
  }

  // Filter
  const filtered = candles.filter(c => {
    const hourKey = `${getDateKey(c.ts)}-${c.ts.getUTCHours()}`;
    return c.symbol === primaryByHour.get(hourKey);
  });

  console.log(`After primary contract filter: ${filtered.length} candles`);

  // Show which contracts were used
  const contracts = new Set(filtered.map(c => c.symbol));
  console.log(`Primary contracts: ${[...contracts].join(', ')}\n`);

  return filtered;
}

function aggregate5m(candles1m) {
  const groups = new Map();

  for (const c of candles1m) {
    const ts = new Date(c.ts);
    const mins = ts.getUTCMinutes();
    const floored = new Date(ts);
    floored.setUTCMinutes(Math.floor(mins / 5) * 5, 0, 0);
    const key = floored.toISOString();

    if (!groups.has(key)) {
      groups.set(key, {
        ts: floored,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      });
    } else {
      const bar = groups.get(key);
      bar.high = Math.max(bar.high, c.high);
      bar.low = Math.min(bar.low, c.low);
      bar.close = c.close;
      bar.volume += c.volume;
    }
  }

  return [...groups.values()].sort((a, b) => a.ts - b.ts);
}

function analyzeDays(candles) {
  // Group by date
  const dayMap = new Map();
  for (const c of candles) {
    const key = getDateKey(c.ts);
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(c);
  }

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (const [dateStr, allCandles] of [...dayMap.entries()].sort()) {
    const dayOfWeek = dayNames[new Date(dateStr + 'T12:00:00Z').getUTCDay()];
    
    // RTH candles only for main stats
    const rthCandles = allCandles.filter(c => isRTH(c.ts)).sort((a, b) => a.ts - b.ts);

    if (rthCandles.length === 0) {
      console.log(`=== ${dateStr} (${dayOfWeek}) ===`);
      console.log('  No RTH data available\n');
      continue;
    }

    const rthOpen = rthCandles[0].open;
    const rthClose = rthCandles[rthCandles.length - 1].close;

    let rthHigh = -Infinity, rthLow = Infinity;
    let highTime = null, lowTime = null;

    for (const c of rthCandles) {
      if (c.high > rthHigh) { rthHigh = c.high; highTime = c.ts; }
      if (c.low < rthLow) { rthLow = c.low; lowTime = c.ts; }
    }

    const rthRange = rthHigh - rthLow;
    const direction = rthClose > rthOpen ? 'UP' : rthClose < rthOpen ? 'DOWN' : 'FLAT';
    const changePoints = rthClose - rthOpen;

    // Check if high came before low or vice versa
    const highFirst = highTime < lowTime;
    const pattern = highFirst ? 'High then Low (sell-off pattern)' : 'Low then High (recovery pattern)';

    console.log(`${'='.repeat(70)}`);
    console.log(`  ${dateStr} (${dayOfWeek}) - ${direction} day (${changePoints > 0 ? '+' : ''}${changePoints.toFixed(2)} pts)`);
    console.log(`${'='.repeat(70)}`);
    console.log(`  RTH Open:   ${rthOpen.toFixed(2)}`);
    console.log(`  RTH Close:  ${rthClose.toFixed(2)}`);
    console.log(`  RTH High:   ${rthHigh.toFixed(2)}  at ${formatET(highTime)}`);
    console.log(`  RTH Low:    ${rthLow.toFixed(2)}  at ${formatET(lowTime)}`);
    console.log(`  RTH Range:  ${rthRange.toFixed(2)} pts`);
    console.log(`  Pattern:    ${pattern}`);

    // Overnight context
    const overnightCandles = allCandles.filter(c => !isRTH(c.ts) && c.ts < rthCandles[0].ts).sort((a, b) => a.ts - b.ts);
    if (overnightCandles.length > 0) {
      const onHigh = Math.max(...overnightCandles.map(c => c.high));
      const onLow = Math.min(...overnightCandles.map(c => c.low));
      const onOpen = overnightCandles[0].open;
      const onClose = overnightCandles[overnightCandles.length - 1].close;
      const gap = rthOpen - onClose;
      console.log(`  Overnight:  Open ${onOpen.toFixed(2)} -> Close ${onClose.toFixed(2)} (High ${onHigh.toFixed(2)} / Low ${onLow.toFixed(2)})`);
      console.log(`  ON->RTH Gap: ${gap > 0 ? '+' : ''}${gap.toFixed(2)} pts`);
    }

    // 5-minute bar analysis for large moves
    const bars5m = aggregate5m(rthCandles);
    const largeMoves = bars5m.filter(b => Math.abs(b.close - b.open) > 30);

    if (largeMoves.length > 0) {
      console.log(`\n  Large 5m moves (>30 pts body):`);
      for (const bar of largeMoves) {
        const move = bar.close - bar.open;
        const dir = move > 0 ? 'UP' : 'DOWN';
        const range = bar.high - bar.low;
        console.log(`    ${formatET(bar.ts).padEnd(14)} ${dir.padEnd(5)} ${Math.abs(move).toFixed(2).padStart(7)} pts body  (O:${bar.open.toFixed(2)} H:${bar.high.toFixed(2)} L:${bar.low.toFixed(2)} C:${bar.close.toFixed(2)}, range: ${range.toFixed(2)})`);
      }
    } else {
      console.log(`\n  Large 5m moves (>30 pts body): None`);
    }

    // Hourly breakdown
    console.log(`\n  Hourly RTH breakdown:`);
    const hourlyGroups = new Map();
    for (const c of rthCandles) {
      // Use a combined key for the 9:30 half-hour
      const h = c.ts.getUTCHours();
      const m = c.ts.getUTCMinutes();
      let hourKey;
      if (h === 13 && m >= 30) hourKey = '13:30'; // 9:30 AM ET
      else hourKey = `${h}:00`;
      
      if (!hourlyGroups.has(hourKey)) hourlyGroups.set(hourKey, []);
      hourlyGroups.get(hourKey).push(c);
    }

    for (const [hourKey, hCandles] of [...hourlyGroups.entries()].sort((a, b) => {
      const [ah] = a[0].split(':').map(Number);
      const [bh] = b[0].split(':').map(Number);
      return ah - bh || a[0].localeCompare(b[0]);
    })) {
      const hOpen = hCandles[0].open;
      const hClose = hCandles[hCandles.length - 1].close;
      const hHigh = Math.max(...hCandles.map(c => c.high));
      const hLow = Math.min(...hCandles.map(c => c.low));
      const hChange = hClose - hOpen;
      const hRange = hHigh - hLow;
      
      // Convert UTC hour to ET label
      const [utcH, utcM] = hourKey.split(':').map(Number);
      const etH = utcH - 4;
      const ampm = etH >= 12 ? 'PM' : 'AM';
      const h12 = etH > 12 ? etH - 12 : etH;
      const etLabel = `${h12}:${utcM.toString().padStart(2, '0')} ${ampm}`;
      
      const dir = hChange > 0 ? '+' : '';
      console.log(`    ${etLabel.padEnd(10)} O:${hOpen.toFixed(2)} C:${hClose.toFixed(2)} H:${hHigh.toFixed(2)} L:${hLow.toFixed(2)} (${dir}${hChange.toFixed(2)}, range:${hRange.toFixed(2)})`);
    }

    console.log('');
  }
}

async function main() {
  console.log('NQ Price Action Analysis: October 13-17, 2025');
  console.log('='.repeat(70));
  console.log('');

  const rawCandles = await loadData();
  const candles = filterPrimaryContract(rawCandles);
  analyzeDays(candles);

  // Week summary
  const rthAll = candles.filter(c => isRTH(c.ts)).sort((a, b) => a.ts - b.ts);
  if (rthAll.length > 0) {
    const weekOpen = rthAll[0].open;
    const weekClose = rthAll[rthAll.length - 1].close;
    const weekHigh = Math.max(...rthAll.map(c => c.high));
    const weekLow = Math.min(...rthAll.map(c => c.low));
    const weekChange = weekClose - weekOpen;
    const weekPct = ((weekClose - weekOpen) / weekOpen * 100).toFixed(2);

    console.log(`${'='.repeat(70)}`);
    console.log(`  WEEK SUMMARY (Oct 13-17, 2025)`);
    console.log(`${'='.repeat(70)}`);
    console.log(`  Week Open:  ${weekOpen.toFixed(2)}`);
    console.log(`  Week Close: ${weekClose.toFixed(2)}`);
    console.log(`  Week High:  ${weekHigh.toFixed(2)}`);
    console.log(`  Week Low:   ${weekLow.toFixed(2)}`);
    console.log(`  Week Range: ${(weekHigh - weekLow).toFixed(2)} pts`);
    console.log(`  Net Change: ${weekChange > 0 ? '+' : ''}${weekChange.toFixed(2)} pts (${weekPct}%)`);
    console.log('');
    
    // Characterize the week
    const avgDailyRange = [];
    const dayMap = new Map();
    for (const c of rthAll) {
      const key = getDateKey(c.ts);
      if (!dayMap.has(key)) dayMap.set(key, { high: -Infinity, low: Infinity });
      const d = dayMap.get(key);
      d.high = Math.max(d.high, c.high);
      d.low = Math.min(d.low, c.low);
    }
    for (const [, d] of dayMap) avgDailyRange.push(d.high - d.low);
    const avgRange = avgDailyRange.reduce((a, b) => a + b, 0) / avgDailyRange.length;
    console.log(`  Avg Daily RTH Range: ${avgRange.toFixed(2)} pts`);
  }
}

main().catch(console.error);
