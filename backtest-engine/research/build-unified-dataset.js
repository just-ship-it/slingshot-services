#!/usr/bin/env node
/**
 * Unified Dataset Builder
 *
 * Phase 1.1: Build unified time series aligning all data sources to 15-minute intervals
 *
 * Data Sources:
 * - NQ OHLCV (1-minute) → Resampled to 15-minute
 * - GEX Intraday (15-minute JSON snapshots)
 * - QQQ ATM IV (15-minute)
 * - Liquidity Trigger Levels (15-minute)
 *
 * Output: unified_15m_2025.csv
 *
 * Usage:
 *   node build-unified-dataset.js [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--output filename.csv]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Default date range (IV data constraint: 2025-01-13 to 2025-12-24)
const DEFAULT_START = '2025-01-13';
const DEFAULT_END = '2025-12-24';

class UnifiedDatasetBuilder {
  constructor(options = {}) {
    this.startDate = new Date(options.start || DEFAULT_START);
    this.endDate = new Date(options.end || DEFAULT_END);
    this.outputFile = options.output || 'unified_15m_2025.csv';

    // Data storage
    this.ohlcvData = new Map();  // timestamp -> OHLCV
    this.gexData = new Map();    // timestamp -> GEX
    this.ivData = new Map();     // timestamp -> IV
    this.liqData = new Map();    // timestamp -> Liquidity

    // Stats
    this.stats = {
      ohlcv: { loaded: 0, filtered: 0 },
      gex: { files: 0, snapshots: 0 },
      iv: { loaded: 0 },
      liquidity: { loaded: 0 }
    };
  }

  /**
   * Main entry point - build the unified dataset
   */
  async build() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Unified Dataset Builder - Phase 1.1');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Date Range: ${this.startDate.toISOString().split('T')[0]} to ${this.endDate.toISOString().split('T')[0]}`);
    console.log(`  Output: ${this.outputFile}`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Load all data sources
    await this.loadOHLCVData();
    await this.loadGEXData();
    await this.loadIVData();
    await this.loadLiquidityData();

    // Join and export
    await this.joinAndExport();

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Build Complete!');
    console.log('═══════════════════════════════════════════════════════════════');
  }

  /**
   * Load NQ 1-minute OHLCV data and resample to 15-minute
   */
  async loadOHLCVData() {
    console.log('📊 Loading NQ OHLCV data...');
    const filePath = path.join(DATA_DIR, 'ohlcv', 'NQ_ohlcv_1m.csv');

    if (!fs.existsSync(filePath)) {
      throw new Error(`OHLCV file not found: ${filePath}`);
    }

    const candles1m = [];

    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          // Skip calendar spreads (contain dash in symbol)
          if (row.symbol && row.symbol.includes('-')) return;

          const timestamp = new Date(row.ts_event).getTime();
          if (isNaN(timestamp)) return;

          // Filter to date range
          if (timestamp < this.startDate.getTime() || timestamp > this.endDate.getTime()) return;

          const candle = {
            timestamp,
            open: parseFloat(row.open),
            high: parseFloat(row.high),
            low: parseFloat(row.low),
            close: parseFloat(row.close),
            volume: parseFloat(row.volume),
            symbol: row.symbol
          };

          // Skip invalid candles
          if (isNaN(candle.open) || isNaN(candle.close)) return;

          // Skip flat candles (likely bad data)
          if (candle.open === candle.high && candle.high === candle.low &&
              candle.low === candle.close && candle.volume <= 2) return;

          candles1m.push(candle);
          this.stats.ohlcv.loaded++;
        })
        .on('end', resolve)
        .on('error', reject);
    });

    console.log(`   Loaded ${this.stats.ohlcv.loaded.toLocaleString()} 1-minute candles`);

    // Resample to 15-minute
    console.log('   Resampling to 15-minute bars...');
    this.resampleTo15Min(candles1m);
    console.log(`   ✅ Created ${this.ohlcvData.size.toLocaleString()} 15-minute bars`);
  }

  /**
   * Resample 1-minute candles to 15-minute OHLCV bars
   */
  resampleTo15Min(candles1m) {
    // Sort by timestamp
    candles1m.sort((a, b) => a.timestamp - b.timestamp);

    // Group by 15-minute period
    const groups = new Map();

    for (const candle of candles1m) {
      // Round down to 15-minute boundary
      const periodStart = Math.floor(candle.timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

      if (!groups.has(periodStart)) {
        groups.set(periodStart, []);
      }
      groups.get(periodStart).push(candle);
    }

    // Aggregate each group
    for (const [periodStart, groupCandles] of groups) {
      if (groupCandles.length === 0) continue;

      // Sort by timestamp within group
      groupCandles.sort((a, b) => a.timestamp - b.timestamp);

      const aggregated = {
        timestamp: periodStart,
        open: groupCandles[0].open,
        high: Math.max(...groupCandles.map(c => c.high)),
        low: Math.min(...groupCandles.map(c => c.low)),
        close: groupCandles[groupCandles.length - 1].close,
        volume: groupCandles.reduce((sum, c) => sum + c.volume, 0),
        candle_count: groupCandles.length
      };

      this.ohlcvData.set(periodStart, aggregated);
    }
  }

  /**
   * Load GEX intraday JSON files
   */
  async loadGEXData() {
    console.log('\n📈 Loading GEX intraday data...');
    const gexDir = path.join(DATA_DIR, 'gex');

    // Find all JSON files in the date range
    const files = fs.readdirSync(gexDir)
      .filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'))
      .filter(f => {
        const dateMatch = f.match(/nq_gex_(\d{4}-\d{2}-\d{2})\.json/);
        if (!dateMatch) return false;
        const fileDate = new Date(dateMatch[1]);
        return fileDate >= this.startDate && fileDate <= this.endDate;
      })
      .sort();

    console.log(`   Found ${files.length} GEX files in date range`);

    for (const file of files) {
      const filePath = path.join(gexDir, file);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      this.stats.gex.files++;

      for (const snapshot of content.data) {
        const timestamp = new Date(snapshot.timestamp).getTime();

        // Round to 15-minute boundary (should already be aligned)
        const periodStart = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

        const gexRecord = {
          timestamp: periodStart,
          nq_spot: snapshot.nq_spot,
          qqq_spot: snapshot.qqq_spot,
          multiplier: snapshot.multiplier,
          gamma_flip: snapshot.gamma_flip,
          call_wall: snapshot.call_wall,
          put_wall: snapshot.put_wall,
          total_gex: snapshot.total_gex,
          total_vex: snapshot.total_vex,
          total_cex: snapshot.total_cex,
          regime: snapshot.regime,
          options_count: snapshot.options_count,
          // Support and resistance levels
          resistance_1: snapshot.resistance?.[0] || null,
          resistance_2: snapshot.resistance?.[1] || null,
          resistance_3: snapshot.resistance?.[2] || null,
          resistance_4: snapshot.resistance?.[3] || null,
          resistance_5: snapshot.resistance?.[4] || null,
          support_1: snapshot.support?.[0] || null,
          support_2: snapshot.support?.[1] || null,
          support_3: snapshot.support?.[2] || null,
          support_4: snapshot.support?.[3] || null,
          support_5: snapshot.support?.[4] || null
        };

        this.gexData.set(periodStart, gexRecord);
        this.stats.gex.snapshots++;
      }
    }

    console.log(`   ✅ Loaded ${this.stats.gex.snapshots.toLocaleString()} GEX snapshots from ${this.stats.gex.files} files`);
  }

  /**
   * Load QQQ ATM IV data
   */
  async loadIVData() {
    console.log('\n📉 Loading IV data...');
    const filePath = path.join(DATA_DIR, 'iv', 'qqq_atm_iv_15m.csv');

    if (!fs.existsSync(filePath)) {
      console.log('   ⚠️  IV file not found, skipping');
      return;
    }

    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          const timestamp = new Date(row.timestamp).getTime();
          if (isNaN(timestamp)) return;

          // Filter to date range
          if (timestamp < this.startDate.getTime() || timestamp > this.endDate.getTime()) return;

          // Round to 15-minute boundary
          const periodStart = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

          const ivRecord = {
            timestamp: periodStart,
            iv: parseFloat(row.iv),
            iv_spot_price: parseFloat(row.spot_price),
            iv_atm_strike: parseFloat(row.atm_strike),
            iv_call: parseFloat(row.call_iv),
            iv_put: parseFloat(row.put_iv),
            iv_dte: parseInt(row.dte)
          };

          this.ivData.set(periodStart, ivRecord);
          this.stats.iv.loaded++;
        })
        .on('end', resolve)
        .on('error', reject);
    });

    console.log(`   ✅ Loaded ${this.stats.iv.loaded.toLocaleString()} IV records`);
  }

  /**
   * Load Liquidity Trigger data
   */
  async loadLiquidityData() {
    console.log('\n💧 Loading Liquidity Trigger data...');
    const filePath = path.join(DATA_DIR, 'liquidity', 'NQ_liquidity_levels.csv');

    if (!fs.existsSync(filePath)) {
      console.log('   ⚠️  Liquidity file not found, skipping');
      return;
    }

    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          const timestamp = parseInt(row.unix_timestamp);
          if (isNaN(timestamp)) return;

          // Filter to date range
          if (timestamp < this.startDate.getTime() || timestamp > this.endDate.getTime()) return;

          // Round to 15-minute boundary
          const periodStart = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

          const liqRecord = {
            timestamp: periodStart,
            liq_sentiment: row.sentiment,
            liq_level_1: parseFloat(row.level_1),
            liq_level_2: parseFloat(row.level_2),
            liq_level_3: parseFloat(row.level_3),
            liq_level_4: parseFloat(row.level_4),
            liq_level_5: parseFloat(row.level_5)
          };

          this.liqData.set(periodStart, liqRecord);
          this.stats.liquidity.loaded++;
        })
        .on('end', resolve)
        .on('error', reject);
    });

    console.log(`   ✅ Loaded ${this.stats.liquidity.loaded.toLocaleString()} Liquidity records`);
  }

  /**
   * Join all datasets and export to CSV
   */
  async joinAndExport() {
    console.log('\n🔗 Joining datasets...');

    // Get all unique timestamps from all sources
    const allTimestamps = new Set([
      ...this.ohlcvData.keys(),
      ...this.gexData.keys(),
      ...this.ivData.keys(),
      ...this.liqData.keys()
    ]);

    // Sort timestamps
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);
    console.log(`   Total unique timestamps: ${sortedTimestamps.length.toLocaleString()}`);

    // Count coverage
    let ohlcvCoverage = 0, gexCoverage = 0, ivCoverage = 0, liqCoverage = 0;
    let fullCoverage = 0;

    // Build unified records
    const unifiedRecords = [];

    for (const ts of sortedTimestamps) {
      const ohlcv = this.ohlcvData.get(ts);
      const gex = this.gexData.get(ts);
      const iv = this.ivData.get(ts);
      const liq = this.liqData.get(ts);

      if (ohlcv) ohlcvCoverage++;
      if (gex) gexCoverage++;
      if (iv) ivCoverage++;
      if (liq) liqCoverage++;
      if (ohlcv && gex && iv && liq) fullCoverage++;

      // Create unified record
      const record = {
        timestamp: new Date(ts).toISOString(),
        unix_timestamp: ts,

        // OHLCV fields
        open: ohlcv?.open ?? null,
        high: ohlcv?.high ?? null,
        low: ohlcv?.low ?? null,
        close: ohlcv?.close ?? null,
        volume: ohlcv?.volume ?? null,
        candle_count: ohlcv?.candle_count ?? null,

        // GEX fields
        nq_spot: gex?.nq_spot ?? null,
        qqq_spot: gex?.qqq_spot ?? null,
        gex_multiplier: gex?.multiplier ?? null,
        gamma_flip: gex?.gamma_flip ?? null,
        call_wall: gex?.call_wall ?? null,
        put_wall: gex?.put_wall ?? null,
        total_gex: gex?.total_gex ?? null,
        total_vex: gex?.total_vex ?? null,
        total_cex: gex?.total_cex ?? null,
        gex_regime: gex?.regime ?? null,
        options_count: gex?.options_count ?? null,
        resistance_1: gex?.resistance_1 ?? null,
        resistance_2: gex?.resistance_2 ?? null,
        resistance_3: gex?.resistance_3 ?? null,
        resistance_4: gex?.resistance_4 ?? null,
        resistance_5: gex?.resistance_5 ?? null,
        support_1: gex?.support_1 ?? null,
        support_2: gex?.support_2 ?? null,
        support_3: gex?.support_3 ?? null,
        support_4: gex?.support_4 ?? null,
        support_5: gex?.support_5 ?? null,

        // IV fields
        iv: iv?.iv ?? null,
        iv_spot_price: iv?.iv_spot_price ?? null,
        iv_atm_strike: iv?.iv_atm_strike ?? null,
        iv_call: iv?.iv_call ?? null,
        iv_put: iv?.iv_put ?? null,
        iv_dte: iv?.iv_dte ?? null,

        // Liquidity fields
        liq_sentiment: liq?.liq_sentiment ?? null,
        liq_level_1: liq?.liq_level_1 ?? null,
        liq_level_2: liq?.liq_level_2 ?? null,
        liq_level_3: liq?.liq_level_3 ?? null,
        liq_level_4: liq?.liq_level_4 ?? null,
        liq_level_5: liq?.liq_level_5 ?? null
      };

      unifiedRecords.push(record);
    }

    // Report coverage
    console.log('\n📊 Data Coverage:');
    console.log(`   OHLCV:     ${ohlcvCoverage.toLocaleString()} / ${sortedTimestamps.length.toLocaleString()} (${(ohlcvCoverage/sortedTimestamps.length*100).toFixed(1)}%)`);
    console.log(`   GEX:       ${gexCoverage.toLocaleString()} / ${sortedTimestamps.length.toLocaleString()} (${(gexCoverage/sortedTimestamps.length*100).toFixed(1)}%)`);
    console.log(`   IV:        ${ivCoverage.toLocaleString()} / ${sortedTimestamps.length.toLocaleString()} (${(ivCoverage/sortedTimestamps.length*100).toFixed(1)}%)`);
    console.log(`   Liquidity: ${liqCoverage.toLocaleString()} / ${sortedTimestamps.length.toLocaleString()} (${(liqCoverage/sortedTimestamps.length*100).toFixed(1)}%)`);
    console.log(`   Full (all 4): ${fullCoverage.toLocaleString()} (${(fullCoverage/sortedTimestamps.length*100).toFixed(1)}%)`);

    // Export to CSV
    console.log('\n💾 Writing unified dataset...');
    const outputPath = path.join(OUTPUT_DIR, this.outputFile);

    const csvWriter = createObjectCsvWriter({
      path: outputPath,
      header: [
        { id: 'timestamp', title: 'timestamp' },
        { id: 'unix_timestamp', title: 'unix_timestamp' },
        // OHLCV
        { id: 'open', title: 'open' },
        { id: 'high', title: 'high' },
        { id: 'low', title: 'low' },
        { id: 'close', title: 'close' },
        { id: 'volume', title: 'volume' },
        { id: 'candle_count', title: 'candle_count' },
        // GEX
        { id: 'nq_spot', title: 'nq_spot' },
        { id: 'qqq_spot', title: 'qqq_spot' },
        { id: 'gex_multiplier', title: 'gex_multiplier' },
        { id: 'gamma_flip', title: 'gamma_flip' },
        { id: 'call_wall', title: 'call_wall' },
        { id: 'put_wall', title: 'put_wall' },
        { id: 'total_gex', title: 'total_gex' },
        { id: 'total_vex', title: 'total_vex' },
        { id: 'total_cex', title: 'total_cex' },
        { id: 'gex_regime', title: 'gex_regime' },
        { id: 'options_count', title: 'options_count' },
        { id: 'resistance_1', title: 'resistance_1' },
        { id: 'resistance_2', title: 'resistance_2' },
        { id: 'resistance_3', title: 'resistance_3' },
        { id: 'resistance_4', title: 'resistance_4' },
        { id: 'resistance_5', title: 'resistance_5' },
        { id: 'support_1', title: 'support_1' },
        { id: 'support_2', title: 'support_2' },
        { id: 'support_3', title: 'support_3' },
        { id: 'support_4', title: 'support_4' },
        { id: 'support_5', title: 'support_5' },
        // IV
        { id: 'iv', title: 'iv' },
        { id: 'iv_spot_price', title: 'iv_spot_price' },
        { id: 'iv_atm_strike', title: 'iv_atm_strike' },
        { id: 'iv_call', title: 'iv_call' },
        { id: 'iv_put', title: 'iv_put' },
        { id: 'iv_dte', title: 'iv_dte' },
        // Liquidity
        { id: 'liq_sentiment', title: 'liq_sentiment' },
        { id: 'liq_level_1', title: 'liq_level_1' },
        { id: 'liq_level_2', title: 'liq_level_2' },
        { id: 'liq_level_3', title: 'liq_level_3' },
        { id: 'liq_level_4', title: 'liq_level_4' },
        { id: 'liq_level_5', title: 'liq_level_5' }
      ]
    });

    await csvWriter.writeRecords(unifiedRecords);

    // Get file size
    const stats = fs.statSync(outputPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    console.log(`   ✅ Wrote ${unifiedRecords.length.toLocaleString()} records to ${outputPath}`);
    console.log(`   File size: ${sizeMB} MB`);
  }
}

// CLI handling
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) {
      options.start = args[++i];
    } else if (args[i] === '--end' && args[i + 1]) {
      options.end = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Unified Dataset Builder - Phase 1.1

Usage:
  node build-unified-dataset.js [options]

Options:
  --start YYYY-MM-DD   Start date (default: ${DEFAULT_START})
  --end YYYY-MM-DD     End date (default: ${DEFAULT_END})
  --output filename    Output filename (default: unified_15m_2025.csv)
  --help, -h           Show this help message

Examples:
  node build-unified-dataset.js
  node build-unified-dataset.js --start 2025-03-01 --end 2025-06-30
  node build-unified-dataset.js --output my_dataset.csv
`);
      process.exit(0);
    }
  }

  return options;
}

// Main execution
const options = parseArgs();
const builder = new UnifiedDatasetBuilder(options);

builder.build().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
