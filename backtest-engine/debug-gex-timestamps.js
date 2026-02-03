#!/usr/bin/env node
/**
 * Debug GEX timestamp matching
 */

import { GexLoader } from './src/data-loaders/gex-loader.js';
import fs from 'fs';
import path from 'path';

const dataDir = './data';

async function debug() {
  console.log('Loading GEX data...');
  const gexLoader = new GexLoader(path.join(dataDir, 'gex'));
  await gexLoader.loadDateRange(new Date('2025-10-01'), new Date('2025-10-31'));

  console.log(`\nGEX data loaded: ${gexLoader.sortedTimestamps.length} timestamps`);
  console.log('First 10 GEX timestamps:');
  gexLoader.sortedTimestamps.slice(0, 10).forEach(ts => {
    const d = new Date(ts);
    console.log(`  ${d.toISOString()} | Hour: ${d.getUTCHours()}`);
  });

  // Load OHLCV manually
  console.log('\nLoading OHLCV data...');
  const ohlcvContent = fs.readFileSync(path.join(dataDir, 'ohlcv/NQ_ohlcv_1m.csv'), 'utf8');
  const lines = ohlcvContent.split('\n');

  // Aggregate to 15m and filter to October
  const candles15m = new Map();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 10) continue;

    const timestamp = new Date(cols[0]).getTime();
    const date = new Date(timestamp);

    // Filter to October 2025
    if (date < new Date('2025-10-01') || date > new Date('2025-10-31')) continue;

    // Skip spread symbols
    if (cols[9]?.includes('-')) continue;

    const interval15m = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

    if (!candles15m.has(interval15m)) {
      candles15m.set(interval15m, {
        timestamp: interval15m,
        open: parseFloat(cols[4]),
        high: parseFloat(cols[5]),
        low: parseFloat(cols[6]),
        close: parseFloat(cols[7]),
        volume: parseInt(cols[8])
      });
    } else {
      const c = candles15m.get(interval15m);
      c.high = Math.max(c.high, parseFloat(cols[5]));
      c.low = Math.min(c.low, parseFloat(cols[6]));
      c.close = parseFloat(cols[7]);
      c.volume += parseInt(cols[8]);
    }
  }

  const candles = Array.from(candles15m.values()).sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${candles.length} 15m candles`);

  // Test GEX lookup
  console.log('\n=== GEX Lookup Test ===');
  let found = 0;
  let notFound = 0;
  let belowFlip = 0;
  let aboveFlip = 0;

  const belowFlipCandles = [];

  for (const candle of candles) {
    const gex = gexLoader.getGexLevels(new Date(candle.timestamp));

    if (gex && gex.gamma_flip) {
      found++;
      if (candle.close < gex.gamma_flip) {
        belowFlip++;
        if (belowFlipCandles.length < 20) {
          belowFlipCandles.push({
            time: new Date(candle.timestamp).toISOString(),
            close: candle.close,
            gammaFlip: gex.gamma_flip,
            distance: gex.gamma_flip - candle.close,
            regime: gex.regime
          });
        }
      } else {
        aboveFlip++;
      }
    } else {
      notFound++;
    }
  }

  console.log(`\nResults (all October 2025 candles):`);
  console.log(`  Total 15m candles: ${candles.length}`);
  console.log(`  GEX found: ${found}`);
  console.log(`  GEX not found: ${notFound}`);
  console.log(`  Candles BELOW gamma flip: ${belowFlip} (${(belowFlip/found*100).toFixed(1)}%)`);
  console.log(`  Candles ABOVE gamma flip: ${aboveFlip} (${(aboveFlip/found*100).toFixed(1)}%)`);

  // Show samples below gamma flip
  console.log('\n=== Sample Candles BELOW Gamma Flip ===');
  belowFlipCandles.slice(0, 10).forEach(c => {
    console.log(`${c.time} | Close: ${c.close.toFixed(2)} | Flip: ${c.gammaFlip.toFixed(2)} | Dist: ${c.distance.toFixed(2)} | Regime: ${c.regime}`);
  });

  // Check what percentage of GEX snapshots have price below flip
  console.log('\n=== Analyzing GEX Snapshots ===');
  let gexBelowFlip = 0;
  let gexAboveFlip = 0;

  for (const ts of gexLoader.sortedTimestamps) {
    const gex = gexLoader.loadedData.get(ts);
    if (gex && gex.nq_spot && gex.gamma_flip) {
      if (gex.nq_spot < gex.gamma_flip) {
        gexBelowFlip++;
      } else {
        gexAboveFlip++;
      }
    }
  }

  console.log(`GEX snapshots where spot < gamma flip: ${gexBelowFlip}`);
  console.log(`GEX snapshots where spot >= gamma flip: ${gexAboveFlip}`);
}

debug().catch(console.error);
