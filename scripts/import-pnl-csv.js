#!/usr/bin/env node

/**
 * import-pnl-csv.js - Import Tradovate P&L CSV export into Redis
 *
 * Usage:
 *   node scripts/import-pnl-csv.js /path/to/pnl.csv                    # Local Redis
 *   node scripts/import-pnl-csv.js /path/to/pnl.csv --redis-url <url>  # Remote Redis
 *   node scripts/import-pnl-csv.js /path/to/pnl.csv --dry-run          # Preview only
 */

import { readFileSync } from 'fs';
import { createClient } from '../shared/node_modules/redis/dist/index.js';

const args = process.argv.slice(2);
const csvPath = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const redisUrlIdx = args.indexOf('--redis-url');
const redisUrl = redisUrlIdx >= 0 ? args[redisUrlIdx + 1] : null;

if (!csvPath) {
  console.error('Usage: node scripts/import-pnl-csv.js <csv-path> [--redis-url <url>] [--dry-run]');
  process.exit(1);
}

const KNOWN_POINT_VALUES = { MNQ: 2, NQ: 20, MES: 5, ES: 50, M2K: 5, RTY: 50 };

function getProductRoot(name) {
  const match = name.match(/^([A-Z]+\d?[A-Z]*?)([FGHJKMNQUVXZ]\d+)$/i);
  return match ? match[1].toUpperCase() : name.toUpperCase();
}

function round2(n) { return Math.round(n * 100) / 100; }

function parsePnlDollars(str) {
  // "$7.00" or "$(47.50)" -> number
  const cleaned = str.replace(/[$(),]/g, '');
  const val = parseFloat(cleaned);
  return str.includes('(') ? -val : val;
}

function parseTimestamp(str) {
  // "03/22/2026 18:00:41" -> Date (ET timezone)
  const [datePart, timePart] = str.split(' ');
  const [month, day, year] = datePart.split('/');
  // Treat as ET (UTC-4 for EDT)
  return new Date(`${year}-${month}-${day}T${timePart}-04:00`);
}

function parseDurationMinutes(str) {
  let minutes = 0;
  const hMatch = str.match(/(\d+)h/);
  const mMatch = str.match(/(\d+)min/);
  const sMatch = str.match(/(\d+)sec/);
  if (hMatch) minutes += parseInt(hMatch[1]) * 60;
  if (mMatch) minutes += parseInt(mMatch[1]);
  if (sMatch) minutes += parseInt(sMatch[1]) / 60;
  return Math.round(minutes);
}

async function main() {
  const csv = readFileSync(csvPath, 'utf-8').replace(/\r/g, '');
  const lines = csv.split('\n').filter(l => l.trim());
  const header = lines[0].split(',');

  console.log(`Parsing ${lines.length - 1} rows from ${csvPath}`);

  const trades = [];
  for (let i = 1; i < lines.length; i++) {
    // Handle CSV fields (some might have commas in values, but this data is clean)
    const cols = lines[i].split(',');
    const row = {};
    header.forEach((h, idx) => row[h] = cols[idx]);

    const symbol = row.symbol;
    const root = getProductRoot(symbol);
    const vpp = KNOWN_POINT_VALUES[root];

    const buyTime = parseTimestamp(row.boughtTimestamp);
    const sellTime = parseTimestamp(row.soldTimestamp);
    const entryTime = buyTime < sellTime ? buyTime : sellTime;
    const exitTime = buyTime < sellTime ? sellTime : buyTime;
    const side = buyTime < sellTime ? 'Long' : 'Short';

    const buyPrice = parseFloat(row.buyPrice);
    const sellPrice = parseFloat(row.sellPrice);
    const qty = parseInt(row.qty);
    const pnlPoints = round2(sellPrice - buyPrice);
    const pnlDollars = parsePnlDollars(row.pnl);
    const durationMinutes = parseDurationMinutes(row.duration);

    // Use buyFillId + sellFillId as a unique composite ID
    const id = `${row.buyFillId}-${row.sellFillId}`;

    const tradeDate = entryTime.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

    trades.push({
      id,
      positionId: null,
      symbol,
      product: root,
      side,
      qty,
      entryPrice: side === 'Long' ? buyPrice : sellPrice,
      exitPrice: side === 'Long' ? sellPrice : buyPrice,
      entryTime: entryTime.toISOString(),
      exitTime: exitTime.toISOString(),
      tradeDate,
      durationMinutes,
      pnlPoints,
      pnlDollars: round2(pnlDollars),
      fees: 0, // CSV doesn't include fees, we'll use 0
      netPnl: round2(pnlDollars), // Without fee data, net = gross
    });
  }

  console.log(`Parsed ${trades.length} trades`);
  console.log(`Date range: ${trades[0].tradeDate} to ${trades[trades.length - 1].tradeDate}`);

  // Build daily summaries
  const dailyMap = new Map();
  for (const t of trades) {
    if (!dailyMap.has(t.tradeDate)) {
      dailyMap.set(t.tradeDate, { date: t.tradeDate, trades: 0, wins: 0, losses: 0, breakeven: 0,
        grossPnl: 0, fees: 0, netPnl: 0, maxWin: 0, maxLoss: 0, totalContracts: 0 });
    }
    const d = dailyMap.get(t.tradeDate);
    d.trades++; d.totalContracts += t.qty; d.fees += t.fees;
    d.grossPnl += t.pnlDollars; d.netPnl += t.netPnl;
    if (t.pnlDollars > 0) { d.wins++; d.maxWin = Math.max(d.maxWin, t.pnlDollars); }
    else if (t.pnlDollars < 0) { d.losses++; d.maxLoss = Math.min(d.maxLoss, t.pnlDollars); }
    else d.breakeven++;
  }

  // Overall summary
  const completed = trades.filter(t => t.pnlDollars !== null);
  const wins = completed.filter(t => t.pnlDollars > 0);
  const losses = completed.filter(t => t.pnlDollars < 0);
  let maxWS = 0, maxLS = 0, cWS = 0, cLS = 0;
  for (const t of completed) {
    if (t.pnlDollars > 0) { cWS++; cLS = 0; maxWS = Math.max(maxWS, cWS); }
    else if (t.pnlDollars < 0) { cLS++; cWS = 0; maxLS = Math.max(maxLS, cLS); }
  }
  const grossWins = wins.reduce((s, t) => s + t.pnlDollars, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnlDollars, 0));
  const totalNet = completed.reduce((s, t) => s + t.netPnl, 0);

  const summary = {
    totalTrades: completed.length, totalContracts: completed.reduce((s, t) => s + t.qty, 0),
    wins: wins.length, losses: losses.length, breakeven: completed.filter(t => t.pnlDollars === 0).length,
    winRate: completed.length > 0 ? round2((wins.length / completed.length) * 100) : 0,
    grossPnl: round2(completed.reduce((s, t) => s + t.pnlDollars, 0)),
    totalFees: 0, netPnl: round2(totalNet),
    avgWin: wins.length > 0 ? round2(grossWins / wins.length) : 0,
    avgLoss: losses.length > 0 ? round2(-grossLosses / losses.length) : 0,
    maxWin: wins.length > 0 ? round2(Math.max(...wins.map(t => t.pnlDollars))) : 0,
    maxLoss: losses.length > 0 ? round2(Math.min(...losses.map(t => t.pnlDollars))) : 0,
    avgTrade: completed.length > 0 ? round2(totalNet / completed.length) : 0,
    profitFactor: grossLosses > 0 ? round2(grossWins / grossLosses) : (grossWins > 0 ? Infinity : 0),
    maxWinStreak: maxWS, maxLossStreak: maxLS,
    avgDurationMinutes: completed.length > 0
      ? Math.round(completed.reduce((s, t) => s + t.durationMinutes, 0) / completed.length) : 0,
  };

  // Print summary
  console.log(`\n=== Summary ===`);
  console.log(`Trades: ${summary.totalTrades} (${summary.totalContracts} contracts)`);
  console.log(`Win rate: ${summary.winRate}% (${summary.wins}W / ${summary.losses}L)`);
  console.log(`Net P&L: $${summary.netPnl.toLocaleString()}`);
  console.log(`Avg trade: $${summary.avgTrade}`);
  console.log(`PF: ${summary.profitFactor} | Streaks: ${maxWS}W / ${maxLS}L`);

  console.log(`\n=== Daily ===`);
  for (const [date, d] of [...dailyMap].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sign = d.netPnl >= 0 ? '+' : '';
    console.log(`${date}: ${d.trades} trades, ${sign}$${round2(d.netPnl).toLocaleString()} (${d.wins}W/${d.losses}L)`);
  }

  if (dryRun) {
    console.log('\nDRY RUN - no data written');
    process.exit(0);
  }

  // Connect to Redis and push
  const url = redisUrl || 'redis://localhost:6379';
  console.log(`\nConnecting to Redis: ${url.replace(/:[^:@]+@/, ':***@')}`);
  const redis = createClient({ url });
  await redis.connect();

  // Store trades
  for (const trade of trades) {
    await redis.hSet('pnl:trades', String(trade.id), JSON.stringify(trade));
  }
  console.log(`Stored ${trades.length} trades`);

  // Store daily summaries
  for (const [date, d] of dailyMap) {
    d.grossPnl = round2(d.grossPnl); d.fees = round2(d.fees); d.netPnl = round2(d.netPnl);
    d.maxWin = round2(d.maxWin); d.maxLoss = round2(d.maxLoss);
    d.winRate = d.trades > 0 ? round2((d.wins / d.trades) * 100) : 0;
    await redis.set(`pnl:daily:${date}`, JSON.stringify(d));
  }
  console.log(`Stored ${dailyMap.size} daily summaries`);

  // Store overall summary
  await redis.set('pnl:summary', JSON.stringify(summary));
  await redis.set('pnl:last_sync', new Date().toISOString());
  console.log('Stored overall summary');

  await redis.quit();
  console.log('Done!');
  process.exit(0);
}

main().catch(err => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
