#!/usr/bin/env node
/**
 * Pre-Signal IV Rate of Change Analysis
 *
 * For each trade, looks back at IV samples before the signal fired
 * and checks if the rate of IV change predicts trade outcome.
 */

import fs from 'fs';
import path from 'path';
import { IVLoader } from '../src/data-loaders/iv-loader.js';

const inputFile = process.argv[2] || 'iv-skew-gex-iv-analysis.json';
const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));

// Load full IV data
const loader = new IVLoader('./data', { resolution: '1m' });
await loader.load(new Date('2025-01-13'), new Date('2026-01-23'));
const stats = loader.getStats();
console.log('IV records loaded:', stats.count);

const trades = data.trades.filter(t => t.signal?.ivValue != null && t.signalTime);

function getIVHistory(loader, timestamp, lookbackBars) {
  const samples = [];
  for (let i = lookbackBars; i >= 0; i--) {
    const t = timestamp - (i * 60000);
    const iv = loader.getIVAtTime(t);
    if (iv) samples.push({ bar: -i, iv: iv.iv, skew: iv.skew });
  }
  return samples;
}

function ivMetrics(samples) {
  if (samples.length < 2) return null;
  const n = samples.length;

  const ivChange = samples[n - 1].iv - samples[0].iv;
  const skewChange = samples[n - 1].skew - samples[0].skew;

  const ivs = samples.map(s => s.iv);
  const mean = ivs.reduce((s, v) => s + v, 0) / ivs.length;
  const variance = ivs.reduce((s, v) => s + (v - mean) ** 2, 0) / ivs.length;

  let maxStep = 0;
  for (let i = 1; i < samples.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(samples[i].iv - samples[i - 1].iv));
  }

  return {
    ivRoC: ivChange,
    absIvRoC: Math.abs(ivChange),
    skewRoC: skewChange,
    ivVolatility: Math.sqrt(variance),
    maxStep,
  };
}

const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] || 0; };

function corr(xs, ys) {
  const n = xs.length; if (n < 3) return 0;
  const mx = avg(xs), my = avg(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  return num / Math.sqrt(dx2 * dy2) || 0;
}

for (const lookback of [5, 10, 15, 30]) {
  console.log('');
  console.log('='.repeat(60));
  console.log(`LOOKBACK: ${lookback} minutes before signal`);
  console.log('='.repeat(60));

  const enriched = trades.map(t => {
    const hist = getIVHistory(loader, t.signalTime, lookback);
    const m = ivMetrics(hist);
    if (!m) return null;
    return { ...m, pnl: t.netPnL, isWin: t.netPnL > 0, side: t.side };
  }).filter(Boolean);

  const winners = enriched.filter(t => t.isWin);
  const losers = enriched.filter(t => !t.isWin);

  console.log(`Trades analyzed: ${enriched.length}`);
  console.log('');

  console.log('|IV Rate of Change| over window:');
  console.log(`  Winners: mean=${(avg(winners.map(t => t.absIvRoC)) * 100).toFixed(3)}%  median=${(median(winners.map(t => t.absIvRoC)) * 100).toFixed(3)}%`);
  console.log(`  Losers:  mean=${(avg(losers.map(t => t.absIvRoC)) * 100).toFixed(3)}%  median=${(median(losers.map(t => t.absIvRoC)) * 100).toFixed(3)}%`);

  console.log('');
  console.log('IV Volatility (stddev over window):');
  console.log(`  Winners: mean=${(avg(winners.map(t => t.ivVolatility)) * 100).toFixed(3)}%`);
  console.log(`  Losers:  mean=${(avg(losers.map(t => t.ivVolatility)) * 100).toFixed(3)}%`);

  console.log('');
  console.log('Max 1-min IV step in window:');
  console.log(`  Winners: mean=${(avg(winners.map(t => t.maxStep)) * 100).toFixed(3)}%`);
  console.log(`  Losers:  mean=${(avg(losers.map(t => t.maxStep)) * 100).toFixed(3)}%`);

  // Bucket by absIvRoC
  console.log('');
  console.log('Win Rate by |IV RoC| bucket:');
  console.log(`  ${'Bucket'.padEnd(15)} ${'Count'.padStart(5)} ${'WR'.padStart(7)} ${'AvgPnL'.padStart(10)}`);
  console.log(`  ${'─'.repeat(37)}`);
  const buckets = [0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.10, 0.50];
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i], hi = buckets[i + 1];
    const bucket = enriched.filter(t => t.absIvRoC >= lo && t.absIvRoC < hi);
    if (bucket.length < 10) continue;
    const w = bucket.filter(t => t.isWin).length;
    const ap = avg(bucket.map(t => t.pnl));
    console.log(`  ${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}%`.padEnd(15) + `${bucket.length}`.padStart(5) + `${(w / bucket.length * 100).toFixed(1)}%`.padStart(7) + `$${ap.toFixed(0)}`.padStart(10));
  }

  // Bucket by IV volatility
  console.log('');
  console.log('Win Rate by IV Volatility bucket:');
  console.log(`  ${'Bucket'.padEnd(15)} ${'Count'.padStart(5)} ${'WR'.padStart(7)} ${'AvgPnL'.padStart(10)}`);
  console.log(`  ${'─'.repeat(37)}`);
  const volBuckets = [0, 0.002, 0.005, 0.01, 0.02, 0.05, 0.50];
  for (let i = 0; i < volBuckets.length - 1; i++) {
    const lo = volBuckets[i], hi = volBuckets[i + 1];
    const bucket = enriched.filter(t => t.ivVolatility >= lo && t.ivVolatility < hi);
    if (bucket.length < 10) continue;
    const w = bucket.filter(t => t.isWin).length;
    const ap = avg(bucket.map(t => t.pnl));
    console.log(`  ${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}%`.padEnd(15) + `${bucket.length}`.padStart(5) + `${(w / bucket.length * 100).toFixed(1)}%`.padStart(7) + `$${ap.toFixed(0)}`.padStart(10));
  }

  // Bucket by max step
  console.log('');
  console.log('Win Rate by Max IV Step bucket:');
  console.log(`  ${'Bucket'.padEnd(15)} ${'Count'.padStart(5)} ${'WR'.padStart(7)} ${'AvgPnL'.padStart(10)}`);
  console.log(`  ${'─'.repeat(37)}`);
  const stepBuckets = [0, 0.002, 0.005, 0.01, 0.02, 0.05, 0.50];
  for (let i = 0; i < stepBuckets.length - 1; i++) {
    const lo = stepBuckets[i], hi = stepBuckets[i + 1];
    const bucket = enriched.filter(t => t.maxStep >= lo && t.maxStep < hi);
    if (bucket.length < 10) continue;
    const w = bucket.filter(t => t.isWin).length;
    const ap = avg(bucket.map(t => t.pnl));
    console.log(`  ${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}%`.padEnd(15) + `${bucket.length}`.padStart(5) + `${(w / bucket.length * 100).toFixed(1)}%`.padStart(7) + `$${ap.toFixed(0)}`.padStart(10));
  }

  console.log('');
  console.log('Correlations with PnL:');
  console.log(`  |IV RoC| vs PnL:      r=${corr(enriched.map(t => t.absIvRoC), enriched.map(t => t.pnl)).toFixed(4)}`);
  console.log(`  IV Volatility vs PnL: r=${corr(enriched.map(t => t.ivVolatility), enriched.map(t => t.pnl)).toFixed(4)}`);
  console.log(`  Max IV Step vs PnL:   r=${corr(enriched.map(t => t.maxStep), enriched.map(t => t.pnl)).toFixed(4)}`);
}
