/**
 * Analyze CBBO-LT Correlation to identify source of apparent predictive power
 *
 * Tests:
 * 1. Do spreads widen BEFORE or DURING large moves?
 * 2. Does LT sentiment at spread widening time predict subsequent direction?
 * 3. Is LT sentiment already reflecting the move (lookbehind bias)?
 * 4. What's the actual base rate of BULLISH vs BEARISH during spread events?
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..');

// Load precomputed CBBO metrics
function loadCBBOMetrics() {
  const file = path.join(dataDir, 'data', 'cbbo-1m', 'cbbo-metrics-1m.csv');
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
  const headers = lines[0].split(',');

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    records.push({
      timestamp: new Date(vals[0]).getTime(),
      avgSpread: parseFloat(vals[1]) || 0,
      spreadVolatility: parseFloat(vals[9]) || 0,
      quoteCount: parseInt(vals[10]) || 0,
    });
  }

  // Sort by time
  records.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`📊 Loaded ${records.length} CBBO minute records`);
  return records;
}

// Load LT levels
function loadLTLevels() {
  const file = path.join(dataDir, 'data', 'liquidity', 'nq', 'NQ_liquidity_levels.csv');
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    // Columns: datetime, unix_timestamp, sentiment, level_1...
    records.push({
      timestamp: parseInt(vals[1]),
      sentiment: vals[2]?.trim(),
    });
  }

  records.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`📊 Loaded ${records.length} LT level records`);
  return records;
}

// Load NQ 1m OHLCV (filtered for primary contract)
function loadNQCandles() {
  const file = path.join(dataDir, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.trim().split('\n');

  // Group by hour, keep highest volume symbol per hour
  const byHour = new Map();
  const allCandles = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const ts = new Date(vals[0]).getTime();

    // Filter out calendar spreads (symbol contains dash)
    const symbol = vals[7]?.trim();
    if (symbol && symbol.includes('-')) continue;

    const candle = {
      timestamp: ts,
      open: parseFloat(vals[1]),
      high: parseFloat(vals[2]),
      low: parseFloat(vals[3]),
      close: parseFloat(vals[4]),
      volume: parseInt(vals[5]) || 0,
      symbol: symbol,
    };

    // Group by hour for primary contract filtering
    const hourKey = Math.floor(ts / 3600000);
    if (!byHour.has(hourKey)) byHour.set(hourKey, []);
    byHour.get(hourKey).push(candle);
    allCandles.push(candle);
  }

  // Filter to primary contract per hour
  const primarySymbols = new Map();
  for (const [hourKey, hourCandles] of byHour) {
    const volBySymbol = new Map();
    for (const c of hourCandles) {
      volBySymbol.set(c.symbol, (volBySymbol.get(c.symbol) || 0) + c.volume);
    }
    let maxVol = 0, primarySym = null;
    for (const [sym, vol] of volBySymbol) {
      if (vol > maxVol) { maxVol = vol; primarySym = sym; }
    }
    primarySymbols.set(hourKey, primarySym);
  }

  const filtered = allCandles.filter(c => {
    const hourKey = Math.floor(c.timestamp / 3600000);
    return c.symbol === primarySymbols.get(hourKey);
  });

  filtered.sort((a, b) => a.timestamp - b.timestamp);

  // Filter to Jan 13-31, 2025
  const start = new Date('2025-01-13').getTime();
  const end = new Date('2025-02-01').getTime();
  const periodCandles = filtered.filter(c => c.timestamp >= start && c.timestamp < end);

  console.log(`📊 Loaded ${periodCandles.length} NQ candles (Jan 13-31 primary contract)`);
  return periodCandles;
}

// Get LT sentiment at a given timestamp
function getLTSentiment(ltLevels, timestamp) {
  // Find most recent LT record at or before this timestamp
  let best = null;
  for (const lt of ltLevels) {
    if (lt.timestamp <= timestamp) best = lt;
    else break;
  }
  return best?.sentiment || null;
}

// Detect spread widening events (same logic as strategy)
function detectSpreadWidenings(cbboMetrics, lookbackMinutes = 30, threshold = 0.15) {
  const events = [];
  const lookbackMs = lookbackMinutes * 60 * 1000;

  // Build a map for quick timestamp lookup
  const metricsByTs = new Map();
  for (const m of cbboMetrics) {
    metricsByTs.set(m.timestamp, m);
  }

  for (let i = 0; i < cbboMetrics.length; i++) {
    const current = cbboMetrics[i];
    const lookbackTime = current.timestamp - lookbackMs;

    // Find the metric closest to lookback time
    let pastMetric = null;
    for (let j = i - 1; j >= 0; j--) {
      if (cbboMetrics[j].timestamp <= lookbackTime) {
        pastMetric = cbboMetrics[j];
        break;
      }
    }

    if (!pastMetric || pastMetric.avgSpread === 0) continue;

    const percentChange = (current.avgSpread - pastMetric.avgSpread) / pastMetric.avgSpread;

    if (percentChange >= threshold) {
      events.push({
        timestamp: current.timestamp,
        currentSpread: current.avgSpread,
        pastSpread: pastMetric.avgSpread,
        percentChange: percentChange,
      });
    }
  }

  return events;
}

// Get price movement N minutes after an event
function getPriceMovement(candles, eventTimestamp, lookForwardMinutes) {
  const lookForwardMs = lookForwardMinutes * 60 * 1000;
  const targetTime = eventTimestamp + lookForwardMs;

  // Find candle at event time
  let entryCandle = null;
  let exitCandle = null;

  for (const c of candles) {
    if (!entryCandle && c.timestamp >= eventTimestamp) entryCandle = c;
    if (c.timestamp >= targetTime) { exitCandle = c; break; }
  }

  if (!entryCandle || !exitCandle) return null;

  return {
    entryPrice: entryCandle.close,
    exitPrice: exitCandle.close,
    change: exitCandle.close - entryCandle.close,
    changePercent: ((exitCandle.close - entryCandle.close) / entryCandle.close) * 100,
    direction: exitCandle.close > entryCandle.close ? 'UP' : 'DOWN',
  };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('🔍 CBBO-LT CORRELATION FORENSICS');
  console.log('   Diagnosing source of apparent predictive power');
  console.log('═'.repeat(70) + '\n');

  // Load data
  const cbbo = loadCBBOMetrics();
  const ltLevels = loadLTLevels();
  const candles = loadNQCandles();

  // Detect spread widening events
  console.log('\n🔄 Detecting spread widening events (threshold=15%, lookback=30m)...');
  const widenings = detectSpreadWidenings(cbbo, 30, 0.15);
  console.log(`   Found ${widenings.length} spread widening events`);

  // Deduplicate: only keep first event per 5-minute window (avoid counting same event multiple times)
  const deduped = [];
  let lastEventTime = -Infinity;
  for (const e of widenings) {
    if (e.timestamp - lastEventTime >= 5 * 60 * 1000) {
      deduped.push(e);
      lastEventTime = e.timestamp;
    }
  }
  console.log(`   After dedup (5min window): ${deduped.length} unique events`);

  // ============================================================
  // TEST 1: LT Sentiment distribution at spread widening events
  // ============================================================
  console.log('\n' + '─'.repeat(70));
  console.log('TEST 1: LT Sentiment Distribution at Spread Widening Events');
  console.log('─'.repeat(70));

  const sentimentAtWidening = { BULLISH: 0, BEARISH: 0, null: 0 };
  for (const event of deduped) {
    const sentiment = getLTSentiment(ltLevels, event.timestamp);
    sentimentAtWidening[sentiment || 'null']++;
  }

  const totalWithSentiment = sentimentAtWidening.BULLISH + sentimentAtWidening.BEARISH;
  console.log(`\n   BULLISH: ${sentimentAtWidening.BULLISH} (${totalWithSentiment > 0 ? (sentimentAtWidening.BULLISH / totalWithSentiment * 100).toFixed(1) : 0}%)`);
  console.log(`   BEARISH: ${sentimentAtWidening.BEARISH} (${totalWithSentiment > 0 ? (sentimentAtWidening.BEARISH / totalWithSentiment * 100).toFixed(1) : 0}%)`);
  console.log(`   No LT data: ${sentimentAtWidening['null']}`);

  // Also check: what's the BASE RATE of BULLISH vs BEARISH across ALL timestamps?
  console.log('\n   📊 BASE RATE comparison (LT sentiment across all available timestamps):');
  const baseSentiment = { BULLISH: 0, BEARISH: 0 };
  for (const lt of ltLevels) {
    if (lt.sentiment === 'BULLISH') baseSentiment.BULLISH++;
    else if (lt.sentiment === 'BEARISH') baseSentiment.BEARISH++;
  }
  const totalBase = baseSentiment.BULLISH + baseSentiment.BEARISH;
  console.log(`   BULLISH: ${baseSentiment.BULLISH} (${(baseSentiment.BULLISH / totalBase * 100).toFixed(1)}%)`);
  console.log(`   BEARISH: ${baseSentiment.BEARISH} (${(baseSentiment.BEARISH / totalBase * 100).toFixed(1)}%)`);

  // ============================================================
  // TEST 2: Does LT sentiment predict actual price direction?
  // ============================================================
  console.log('\n' + '─'.repeat(70));
  console.log('TEST 2: LT Sentiment vs Actual Price Direction (post-event)');
  console.log('─'.repeat(70));

  const lookForwards = [5, 10, 15, 30, 60];

  console.log('\n   Sentiment at event → Actual NQ move after event:');
  console.log('   ' + '─'.repeat(60));
  console.log('   Forward | BULL→UP | BULL→DN | BEAR→UP | BEAR→DN');
  console.log('   ' + '─'.repeat(60));

  for (const lf of lookForwards) {
    let bullUp = 0, bullDown = 0, bearUp = 0, bearDown = 0;
    let bullNoData = 0, bearNoData = 0;

    for (const event of deduped) {
      const sentiment = getLTSentiment(ltLevels, event.timestamp);
      const movement = getPriceMovement(candles, event.timestamp, lf);

      if (!movement) {
        if (sentiment === 'BULLISH') bullNoData++;
        else if (sentiment === 'BEARISH') bearNoData++;
        continue;
      }

      if (sentiment === 'BULLISH') {
        if (movement.direction === 'UP') bullUp++;
        else bullDown++;
      } else if (sentiment === 'BEARISH') {
        if (movement.direction === 'UP') bearUp++;
        else bearDown++;
      }
    }

    const bullTotal = bullUp + bullDown;
    const bearTotal = bearUp + bearDown;
    const bullAcc = bullTotal > 0 ? (bullUp / bullTotal * 100).toFixed(1) : '-';
    const bearAcc = bearTotal > 0 ? (bearDown / bearTotal * 100).toFixed(1) : '-';

    console.log(`   ${(lf + 'min').padStart(7)} | ${bullUp.toString().padStart(4)} (${bullAcc}%) | ${bullDown.toString().padStart(4)}        | ${bearUp.toString().padStart(4)}        | ${bearDown.toString().padStart(4)} (${bearAcc}%)`);
  }

  // ============================================================
  // TEST 3: LT sentiment BEFORE vs AT the spread widening
  // ============================================================
  console.log('\n' + '─'.repeat(70));
  console.log('TEST 3: Did LT Sentiment CHANGE during the spread widening?');
  console.log('        (Lookbehind bias test)');
  console.log('─'.repeat(70));

  const sentimentChanges = { same: 0, changed: 0, noData: 0 };
  const changeMatrix = {
    'BULL→BULL': 0, 'BULL→BEAR': 0,
    'BEAR→BEAR': 0, 'BEAR→BULL': 0,
    'null→BULL': 0, 'null→BEAR': 0,
  };

  for (const event of deduped) {
    const sentimentNow = getLTSentiment(ltLevels, event.timestamp);
    const sentimentBefore = getLTSentiment(ltLevels, event.timestamp - 60 * 60 * 1000); // 1hr before

    if (!sentimentNow || !sentimentBefore) {
      sentimentChanges.noData++;
      if (!sentimentBefore && sentimentNow) {
        changeMatrix[`null→${sentimentNow.slice(0, 4)}`]++;
      }
      continue;
    }

    if (sentimentNow === sentimentBefore) {
      sentimentChanges.same++;
      changeMatrix[`${sentimentBefore.slice(0, 4)}→${sentimentNow.slice(0, 4)}`]++;
    } else {
      sentimentChanges.changed++;
      changeMatrix[`${sentimentBefore.slice(0, 4)}→${sentimentNow.slice(0, 4)}`]++;
    }
  }

  console.log(`\n   Sentiment 1hr BEFORE vs AT spread widening:`);
  console.log(`   Unchanged: ${sentimentChanges.same} (${((sentimentChanges.same / (sentimentChanges.same + sentimentChanges.changed + sentimentChanges.noData)) * 100).toFixed(1)}%)`);
  console.log(`   Changed:   ${sentimentChanges.changed} (${((sentimentChanges.changed / (sentimentChanges.same + sentimentChanges.changed + sentimentChanges.noData)) * 100).toFixed(1)}%)`);
  console.log(`   No data:   ${sentimentChanges.noData}`);
  console.log(`\n   Transition matrix:`);
  for (const [key, val] of Object.entries(changeMatrix)) {
    if (val > 0) console.log(`      ${key}: ${val}`);
  }

  // ============================================================
  // TEST 4: Was price already moving when spread widened?
  // ============================================================
  console.log('\n' + '─'.repeat(70));
  console.log('TEST 4: Was Price Already Moving When Spread Widened?');
  console.log('        (Timing bias test)');
  console.log('─'.repeat(70));

  let priceAlreadyUp = 0, priceAlreadyDown = 0, priceFlatAtWidening = 0;
  let postMoveUp = 0, postMoveDown = 0, postMoveFlat = 0;

  for (const event of deduped) {
    // Check price movement in 30 min BEFORE the event
    const preBefore = getPriceMovement(candles, event.timestamp - 30 * 60 * 1000, 30);
    // Check price movement in 30 min AFTER the event
    const postAfter = getPriceMovement(candles, event.timestamp, 30);

    if (preBefore) {
      if (Math.abs(preBefore.change) < 5) priceFlatAtWidening++;
      else if (preBefore.direction === 'UP') priceAlreadyUp++;
      else priceAlreadyDown++;
    }

    if (postAfter) {
      if (Math.abs(postAfter.change) < 5) postMoveFlat++;
      else if (postAfter.direction === 'UP') postMoveUp++;
      else postMoveDown++;
    }
  }

  console.log(`\n   Price in 30min BEFORE spread widening:`);
  console.log(`      Already UP:   ${priceAlreadyUp} (${((priceAlreadyUp / deduped.length) * 100).toFixed(1)}%)`);
  console.log(`      Already DOWN: ${priceAlreadyDown} (${((priceAlreadyDown / deduped.length) * 100).toFixed(1)}%)`);
  console.log(`      Flat (<5pts): ${priceFlatAtWidening} (${((priceFlatAtWidening / deduped.length) * 100).toFixed(1)}%)`);

  console.log(`\n   Price in 30min AFTER spread widening:`);
  console.log(`      Moved UP:   ${postMoveUp} (${((postMoveUp / deduped.length) * 100).toFixed(1)}%)`);
  console.log(`      Moved DOWN: ${postMoveDown} (${((postMoveDown / deduped.length) * 100).toFixed(1)}%)`);
  console.log(`      Flat:       ${postMoveFlat} (${((postMoveFlat / deduped.length) * 100).toFixed(1)}%)`);

  // ============================================================
  // TEST 5: Continuation vs Reversal after spread widening
  // ============================================================
  console.log('\n' + '─'.repeat(70));
  console.log('TEST 5: Continuation vs Reversal After Spread Widening');
  console.log('─'.repeat(70));

  let continuation = 0, reversal = 0, noPattern = 0;

  for (const event of deduped) {
    const preBefore = getPriceMovement(candles, event.timestamp - 30 * 60 * 1000, 30);
    const postAfter = getPriceMovement(candles, event.timestamp, 30);

    if (!preBefore || !postAfter) { noPattern++; continue; }

    if (Math.abs(preBefore.change) < 5) { noPattern++; continue; }

    if (preBefore.direction === postAfter.direction) {
      continuation++;
    } else {
      reversal++;
    }
  }

  const totalPatterned = continuation + reversal;
  console.log(`\n   Pre-move direction → Post-move direction:`);
  console.log(`   Continuation: ${continuation} (${totalPatterned > 0 ? (continuation / totalPatterned * 100).toFixed(1) : 0}%)`);
  console.log(`   Reversal:     ${reversal} (${totalPatterned > 0 ? (reversal / totalPatterned * 100).toFixed(1) : 0}%)`);
  console.log(`   No pattern:   ${noPattern}`);

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n' + '═'.repeat(70));
  console.log('📋 FORENSIC SUMMARY');
  console.log('═'.repeat(70));

  const bullPct = totalWithSentiment > 0 ? (sentimentAtWidening.BULLISH / totalWithSentiment * 100).toFixed(1) : '0';
  const baseBullPct = (baseSentiment.BULLISH / totalBase * 100).toFixed(1);

  console.log(`\n   1. LT sentiment at widening events: ${bullPct}% BULLISH`);
  console.log(`      Base rate across all time:        ${baseBullPct}% BULLISH`);
  console.log(`      → ${Math.abs(parseFloat(bullPct) - parseFloat(baseBullPct)).toFixed(1)}pp ${parseFloat(bullPct) > parseFloat(baseBullPct) ? 'above' : 'below'} base rate`);

  console.log(`\n   2. Sentiment stability: ${sentimentChanges.same} unchanged, ${sentimentChanges.changed} changed (1hr window)`);
  console.log(`      → LT sentiment is ${sentimentChanges.changed > sentimentChanges.same * 0.3 ? 'VOLATILE' : 'STABLE'} around spread events`);

  console.log(`\n   3. Price direction at widening: ${priceAlreadyUp} UP, ${priceAlreadyDown} DOWN, ${priceFlatAtWidening} flat`);
  console.log(`      → Spreads widen ${(priceAlreadyUp + priceAlreadyDown) > priceFlatAtWidening ? 'DURING' : 'BEFORE'} price moves`);

  console.log(`\n   4. Post-widening pattern: ${continuation} continuation, ${reversal} reversal`);
  console.log(`      → Market tends to ${continuation > reversal ? 'CONTINUE' : 'REVERSE'} after spread widens`);

  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
