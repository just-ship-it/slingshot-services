#!/usr/bin/env node

/**
 * Collects raw options chain snapshots from the live Schwab integration
 * via the monitoring service API. Saves timestamped JSON files locally
 * for later comparison against Databento backtest data.
 *
 * Usage:
 *   node collect-schwab-snapshots.js [--interval 120] [--symbol QQQ]
 *
 * Output: backtest-engine/data/schwab-snapshots/YYYY-MM-DD/snapshot_HH-MM-SS.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = path.join(__dirname, '..', 'data', 'schwab-snapshots');

// Config
const API_URL = process.env.API_URL || 'https://monitoring-service-7p2i9.sevalla.app';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'eec399951621c4957c48002a9022b786776f80e68bb51515587416aa3384c309';
const INTERVAL_SECONDS = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--interval') || '120');
const SYMBOL = process.argv.find((_, i, a) => a[i - 1] === '--symbol') || null;

const MARKET_OPEN_HOUR = 9;   // 9:30 AM ET
const MARKET_OPEN_MIN = 30;
const MARKET_CLOSE_HOUR = 16; // 4:15 PM ET
const MARKET_CLOSE_MIN = 15;

let running = true;
let snapshotCount = 0;

process.on('SIGINT', () => {
  console.log(`\nStopping... collected ${snapshotCount} snapshots.`);
  running = false;
});

function getETHours(date) {
  const et = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hour: et.getHours(), min: et.getMinutes(), day: et.getDay() };
}

function isMarketOpen() {
  const { hour, min, day } = getETHours(new Date());
  if (day === 0 || day === 6) return false; // weekend
  const t = hour * 60 + min;
  return t >= MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN && t <= MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;
}

function getOutputPath() {
  const now = new Date();
  const dateDir = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const time = now.toISOString().slice(11, 19).replace(/:/g, '-'); // HH-MM-SS
  const dir = path.join(SNAPSHOTS_DIR, dateDir);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `snapshot_${time}.json`);
}

async function fetchSnapshot() {
  const url = SYMBOL
    ? `${API_URL}/api/chains/snapshot?symbol=${SYMBOL}`
    : `${API_URL}/api/chains/snapshot`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

function countContracts(data) {
  let total = 0;
  for (const symbol of Object.keys(data.chains || {})) {
    for (const expiration of data.chains[symbol]) {
      total += expiration.options?.length || 0;
    }
  }
  return total;
}

async function collectOnce() {
  try {
    const data = await fetchSnapshot();
    const contracts = countContracts(data);
    const outPath = getOutputPath();
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    snapshotCount++;
    const symbols = Object.keys(data.chains || {}).join(', ');
    console.log(`[${new Date().toISOString()}] #${snapshotCount} saved: ${contracts} contracts (${symbols}) -> ${path.basename(outPath)}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error: ${error.message}`);
  }
}

async function main() {
  console.log(`Collecting Schwab chain snapshots every ${INTERVAL_SECONDS}s`);
  console.log(`Market hours: ${MARKET_OPEN_HOUR}:${String(MARKET_OPEN_MIN).padStart(2, '0')} - ${MARKET_CLOSE_HOUR}:${String(MARKET_CLOSE_MIN).padStart(2, '0')} ET (Mon-Fri)`);
  console.log(`API: ${API_URL}`);
  console.log(`Symbol filter: ${SYMBOL || 'all'}`);
  console.log(`Output: ${SNAPSHOTS_DIR}/`);
  console.log('Press Ctrl+C to stop.\n');

  while (running) {
    if (isMarketOpen()) {
      await collectOnce();
    } else {
      const { hour, min, day } = getETHours(new Date());
      console.log(`[${new Date().toISOString()}] Market closed (${hour}:${String(min).padStart(2, '0')} ET, day=${day}). Waiting...`);
    }
    await new Promise(resolve => setTimeout(resolve, INTERVAL_SECONDS * 1000));
  }
}

main();
