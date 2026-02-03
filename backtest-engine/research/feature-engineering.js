#!/usr/bin/env node
/**
 * Feature Engineering - Phase 1.3
 *
 * Computes derived features from the unified dataset for correlation analysis:
 * - GEX Features: distance to levels, regime encoding, momentum
 * - IV Features: percentile rank, skew, rate of change
 * - Liquidity Features: spacing, momentum, spike detection
 * - Price Features: returns, volatility, trend
 *
 * Input: unified_15m_2025.csv
 * Output: unified_15m_2025_features.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_FILE = path.join(__dirname, 'output', 'unified_15m_2025.csv');
const OUTPUT_FILE = path.join(__dirname, 'output', 'unified_15m_2025_features.csv');

class FeatureEngineer {
  constructor() {
    this.data = [];
    this.ivHistory = [];  // For percentile calculation
    this.stats = {
      totalRecords: 0,
      rthRecords: 0,
      featuresComputed: 0
    };
  }

  async run() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Feature Engineering - Phase 1.3');
    console.log('═══════════════════════════════════════════════════════════════\n');

    await this.loadData();
    this.computeFeatures();
    await this.exportData();

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Feature Engineering Complete!');
    console.log('═══════════════════════════════════════════════════════════════');
  }

  async loadData() {
    console.log('📂 Loading unified dataset...');

    return new Promise((resolve, reject) => {
      fs.createReadStream(INPUT_FILE)
        .pipe(csv())
        .on('data', (row) => {
          // Parse numeric fields
          const record = {
            timestamp: row.timestamp,
            unix_timestamp: parseInt(row.unix_timestamp),
            // OHLCV
            open: this.parseFloat(row.open),
            high: this.parseFloat(row.high),
            low: this.parseFloat(row.low),
            close: this.parseFloat(row.close),
            volume: this.parseFloat(row.volume),
            candle_count: this.parseFloat(row.candle_count),
            // GEX
            nq_spot: this.parseFloat(row.nq_spot),
            qqq_spot: this.parseFloat(row.qqq_spot),
            gex_multiplier: this.parseFloat(row.gex_multiplier),
            gamma_flip: this.parseFloat(row.gamma_flip),
            call_wall: this.parseFloat(row.call_wall),
            put_wall: this.parseFloat(row.put_wall),
            total_gex: this.parseFloat(row.total_gex),
            total_vex: this.parseFloat(row.total_vex),
            total_cex: this.parseFloat(row.total_cex),
            gex_regime: row.gex_regime || null,
            options_count: this.parseFloat(row.options_count),
            resistance_1: this.parseFloat(row.resistance_1),
            resistance_2: this.parseFloat(row.resistance_2),
            resistance_3: this.parseFloat(row.resistance_3),
            resistance_4: this.parseFloat(row.resistance_4),
            resistance_5: this.parseFloat(row.resistance_5),
            support_1: this.parseFloat(row.support_1),
            support_2: this.parseFloat(row.support_2),
            support_3: this.parseFloat(row.support_3),
            support_4: this.parseFloat(row.support_4),
            support_5: this.parseFloat(row.support_5),
            // IV
            iv: this.parseFloat(row.iv),
            iv_spot_price: this.parseFloat(row.iv_spot_price),
            iv_atm_strike: this.parseFloat(row.iv_atm_strike),
            iv_call: this.parseFloat(row.iv_call),
            iv_put: this.parseFloat(row.iv_put),
            iv_dte: this.parseFloat(row.iv_dte),
            // Liquidity
            liq_sentiment: row.liq_sentiment || null,
            liq_level_1: this.parseFloat(row.liq_level_1),
            liq_level_2: this.parseFloat(row.liq_level_2),
            liq_level_3: this.parseFloat(row.liq_level_3),
            liq_level_4: this.parseFloat(row.liq_level_4),
            liq_level_5: this.parseFloat(row.liq_level_5)
          };

          this.data.push(record);
          this.stats.totalRecords++;

          if (record.iv !== null) {
            this.stats.rthRecords++;
          }
        })
        .on('end', () => {
          console.log(`   ✅ Loaded ${this.stats.totalRecords.toLocaleString()} records`);
          console.log(`   RTH records (with GEX/IV): ${this.stats.rthRecords.toLocaleString()}`);
          resolve();
        })
        .on('error', reject);
    });
  }

  parseFloat(value) {
    if (value === null || value === undefined || value === '' || value === 'null') {
      return null;
    }
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }

  computeFeatures() {
    console.log('\n🔧 Computing features...');

    // Build IV history for percentile calculation
    this.ivHistory = this.data
      .filter(r => r.iv !== null)
      .map(r => r.iv)
      .sort((a, b) => a - b);

    // Process each record
    for (let i = 0; i < this.data.length; i++) {
      const record = this.data[i];
      const prevRecords = this.data.slice(Math.max(0, i - 4), i);  // Last 4 records (1 hour)
      const prev = i > 0 ? this.data[i - 1] : null;

      // === Price Features ===
      record.price_return_15m = this.computeReturn(record.close, prev?.close);
      record.price_return_1h = this.computeReturnNBack(i, 4, 'close');
      record.price_return_4h = this.computeReturnNBack(i, 16, 'close');
      record.price_range_15m = record.high !== null && record.low !== null
        ? record.high - record.low : null;
      record.price_volatility_1h = this.computeVolatility(i, 4);
      record.price_volatility_4h = this.computeVolatility(i, 16);

      // === GEX Features ===
      if (record.close !== null && record.gamma_flip !== null) {
        record.gex_dist_gamma_flip = record.close - record.gamma_flip;
        record.gex_dist_gamma_flip_pct = (record.close - record.gamma_flip) / record.close * 100;
        record.gex_above_gamma_flip = record.close > record.gamma_flip ? 1 : 0;
      } else {
        record.gex_dist_gamma_flip = null;
        record.gex_dist_gamma_flip_pct = null;
        record.gex_above_gamma_flip = null;
      }

      if (record.close !== null && record.support_1 !== null) {
        record.gex_dist_support_1 = record.close - record.support_1;
      } else {
        record.gex_dist_support_1 = null;
      }

      if (record.close !== null && record.resistance_1 !== null) {
        record.gex_dist_resistance_1 = record.resistance_1 - record.close;
      } else {
        record.gex_dist_resistance_1 = null;
      }

      // Nearest GEX level
      record.gex_dist_nearest = this.computeNearestGexDistance(record);

      // GEX regime encoded
      record.gex_regime_encoded = this.encodeRegime(record.gex_regime);

      // GEX momentum (change in total_gex)
      record.gex_momentum = prev?.total_gex !== null && record.total_gex !== null
        ? record.total_gex - prev.total_gex : null;

      // === IV Features ===
      if (record.iv !== null) {
        record.iv_percentile_all = this.computePercentile(record.iv, this.ivHistory);
        record.iv_skew = record.iv_put !== null && record.iv_call !== null
          ? record.iv_put - record.iv_call : null;
        record.iv_change_15m = prev?.iv !== null ? record.iv - prev.iv : null;
        record.iv_change_1h = this.computeChangeNBack(i, 4, 'iv');
      } else {
        record.iv_percentile_all = null;
        record.iv_skew = null;
        record.iv_change_15m = null;
        record.iv_change_1h = null;
      }

      // === Liquidity Features ===
      if (record.liq_level_1 !== null) {
        // Liquidity spacing (average distance between levels)
        const levels = [
          record.liq_level_1, record.liq_level_2, record.liq_level_3,
          record.liq_level_4, record.liq_level_5
        ].filter(l => l !== null).sort((a, b) => a - b);

        if (levels.length >= 2) {
          let totalSpacing = 0;
          for (let j = 1; j < levels.length; j++) {
            totalSpacing += levels[j] - levels[j - 1];
          }
          record.liq_spacing_avg = totalSpacing / (levels.length - 1);
          record.liq_range = levels[levels.length - 1] - levels[0];
        } else {
          record.liq_spacing_avg = null;
          record.liq_range = null;
        }

        // Liquidity momentum (average change in levels)
        if (prev && prev.liq_level_1 !== null) {
          const levelChanges = [
            record.liq_level_1 - prev.liq_level_1,
            record.liq_level_2 - prev.liq_level_2,
            record.liq_level_3 - prev.liq_level_3,
            record.liq_level_4 - prev.liq_level_4,
            record.liq_level_5 - prev.liq_level_5
          ].filter(c => c !== null && !isNaN(c));

          record.liq_momentum = levelChanges.length > 0
            ? levelChanges.reduce((a, b) => a + b, 0) / levelChanges.length : null;

          // Max level change (for spike detection)
          record.liq_max_change = Math.max(...levelChanges.map(Math.abs));
        } else {
          record.liq_momentum = null;
          record.liq_max_change = null;
        }

        // Sentiment encoded
        record.liq_sentiment_encoded = record.liq_sentiment === 'BULLISH' ? 1
          : record.liq_sentiment === 'BEARISH' ? -1 : 0;

        // Sentiment change
        record.liq_sentiment_changed = prev && prev.liq_sentiment !== null &&
          record.liq_sentiment !== prev.liq_sentiment ? 1 : 0;

        // Distance to nearest liquidity level
        if (record.close !== null) {
          const distances = levels.map(l => Math.abs(record.close - l));
          record.liq_dist_nearest = Math.min(...distances);
        } else {
          record.liq_dist_nearest = null;
        }
      } else {
        record.liq_spacing_avg = null;
        record.liq_range = null;
        record.liq_momentum = null;
        record.liq_max_change = null;
        record.liq_sentiment_encoded = null;
        record.liq_sentiment_changed = null;
        record.liq_dist_nearest = null;
      }

      // === Session Features ===
      const hour = new Date(record.timestamp).getUTCHours();
      record.session = this.getSession(hour);
      record.is_rth = hour >= 14 && hour < 21 ? 1 : 0;  // 9:30 AM - 4 PM EST in UTC

      this.stats.featuresComputed++;

      if (this.stats.featuresComputed % 5000 === 0) {
        console.log(`   Processed ${this.stats.featuresComputed.toLocaleString()} records...`);
      }
    }

    console.log(`   ✅ Computed features for ${this.stats.featuresComputed.toLocaleString()} records`);
  }

  computeReturn(current, previous) {
    if (current === null || previous === null || previous === 0) return null;
    return (current - previous) / previous * 100;
  }

  computeReturnNBack(index, n, field) {
    if (index < n) return null;
    const current = this.data[index][field];
    const past = this.data[index - n][field];
    return this.computeReturn(current, past);
  }

  computeChangeNBack(index, n, field) {
    if (index < n) return null;
    const current = this.data[index][field];
    const past = this.data[index - n][field];
    if (current === null || past === null) return null;
    return current - past;
  }

  computeVolatility(index, lookback) {
    if (index < lookback) return null;

    const returns = [];
    for (let i = index - lookback + 1; i <= index; i++) {
      const ret = this.computeReturn(this.data[i].close, this.data[i - 1]?.close);
      if (ret !== null) returns.push(ret);
    }

    if (returns.length < 2) return null;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    return Math.sqrt(variance);
  }

  computePercentile(value, sortedArray) {
    if (sortedArray.length === 0) return null;
    let count = 0;
    for (const v of sortedArray) {
      if (v <= value) count++;
      else break;
    }
    return (count / sortedArray.length) * 100;
  }

  computeNearestGexDistance(record) {
    if (record.close === null) return null;

    const levels = [
      record.support_1, record.support_2, record.support_3,
      record.resistance_1, record.resistance_2, record.resistance_3,
      record.gamma_flip
    ].filter(l => l !== null);

    if (levels.length === 0) return null;

    const distances = levels.map(l => Math.abs(record.close - l));
    return Math.min(...distances);
  }

  encodeRegime(regime) {
    const mapping = {
      'strong_positive': 2,
      'positive': 1,
      'negative': -1,
      'strong_negative': -2
    };
    return mapping[regime] ?? null;
  }

  getSession(utcHour) {
    // Convert UTC to EST (UTC-5)
    const estHour = (utcHour - 5 + 24) % 24;

    if (estHour >= 4 && estHour < 9.5) return 'premarket';
    if (estHour >= 9.5 && estHour < 16) return 'rth';
    if (estHour >= 16 && estHour < 18) return 'afterhours';
    return 'overnight';
  }

  async exportData() {
    console.log('\n💾 Exporting featured dataset...');

    const headers = [
      // Original fields
      { id: 'timestamp', title: 'timestamp' },
      { id: 'unix_timestamp', title: 'unix_timestamp' },
      { id: 'open', title: 'open' },
      { id: 'high', title: 'high' },
      { id: 'low', title: 'low' },
      { id: 'close', title: 'close' },
      { id: 'volume', title: 'volume' },
      // GEX original
      { id: 'gamma_flip', title: 'gamma_flip' },
      { id: 'call_wall', title: 'call_wall' },
      { id: 'put_wall', title: 'put_wall' },
      { id: 'total_gex', title: 'total_gex' },
      { id: 'gex_regime', title: 'gex_regime' },
      { id: 'resistance_1', title: 'resistance_1' },
      { id: 'resistance_2', title: 'resistance_2' },
      { id: 'support_1', title: 'support_1' },
      { id: 'support_2', title: 'support_2' },
      // IV original
      { id: 'iv', title: 'iv' },
      { id: 'iv_call', title: 'iv_call' },
      { id: 'iv_put', title: 'iv_put' },
      { id: 'iv_dte', title: 'iv_dte' },
      // Liquidity original
      { id: 'liq_sentiment', title: 'liq_sentiment' },
      { id: 'liq_level_1', title: 'liq_level_1' },
      { id: 'liq_level_2', title: 'liq_level_2' },
      { id: 'liq_level_3', title: 'liq_level_3' },
      { id: 'liq_level_4', title: 'liq_level_4' },
      { id: 'liq_level_5', title: 'liq_level_5' },
      // Price features
      { id: 'price_return_15m', title: 'price_return_15m' },
      { id: 'price_return_1h', title: 'price_return_1h' },
      { id: 'price_return_4h', title: 'price_return_4h' },
      { id: 'price_range_15m', title: 'price_range_15m' },
      { id: 'price_volatility_1h', title: 'price_volatility_1h' },
      { id: 'price_volatility_4h', title: 'price_volatility_4h' },
      // GEX features
      { id: 'gex_dist_gamma_flip', title: 'gex_dist_gamma_flip' },
      { id: 'gex_dist_gamma_flip_pct', title: 'gex_dist_gamma_flip_pct' },
      { id: 'gex_above_gamma_flip', title: 'gex_above_gamma_flip' },
      { id: 'gex_dist_support_1', title: 'gex_dist_support_1' },
      { id: 'gex_dist_resistance_1', title: 'gex_dist_resistance_1' },
      { id: 'gex_dist_nearest', title: 'gex_dist_nearest' },
      { id: 'gex_regime_encoded', title: 'gex_regime_encoded' },
      { id: 'gex_momentum', title: 'gex_momentum' },
      // IV features
      { id: 'iv_percentile_all', title: 'iv_percentile_all' },
      { id: 'iv_skew', title: 'iv_skew' },
      { id: 'iv_change_15m', title: 'iv_change_15m' },
      { id: 'iv_change_1h', title: 'iv_change_1h' },
      // Liquidity features
      { id: 'liq_spacing_avg', title: 'liq_spacing_avg' },
      { id: 'liq_range', title: 'liq_range' },
      { id: 'liq_momentum', title: 'liq_momentum' },
      { id: 'liq_max_change', title: 'liq_max_change' },
      { id: 'liq_sentiment_encoded', title: 'liq_sentiment_encoded' },
      { id: 'liq_sentiment_changed', title: 'liq_sentiment_changed' },
      { id: 'liq_dist_nearest', title: 'liq_dist_nearest' },
      // Session features
      { id: 'session', title: 'session' },
      { id: 'is_rth', title: 'is_rth' }
    ];

    const csvWriter = createObjectCsvWriter({
      path: OUTPUT_FILE,
      header: headers
    });

    await csvWriter.writeRecords(this.data);

    const stats = fs.statSync(OUTPUT_FILE);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    console.log(`   ✅ Wrote ${this.data.length.toLocaleString()} records to ${OUTPUT_FILE}`);
    console.log(`   File size: ${sizeMB} MB`);
    console.log(`   Total features: ${headers.length} columns`);
  }
}

// Run
const engineer = new FeatureEngineer();
engineer.run().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
