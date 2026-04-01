#!/usr/bin/env node

/**
 * import-pnl-csv.js - Import Tradovate P&L CSV export into Redis
 *
 * Groups fillPairs into logical trades (flat → position → flat = one trade).
 *
 * Usage:
 *   node scripts/import-pnl-csv.js <csv-path>                          # Local Redis
 *   node scripts/import-pnl-csv.js <csv-path> --redis-url <url>        # Remote Redis
 *   node scripts/import-pnl-csv.js <csv-path> --dry-run                # Preview only
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
// Tradovate "Free" tier all-in per-side rates (round trip = 2x)
const FEES_PER_RT = { MNQ: 1.90, NQ: 5.76, MES: 1.90, ES: 5.76, M2K: 1.90, RTY: 5.76 };

function getProductRoot(name) {
  const match = name.match(/^([A-Z]+\d?[A-Z]*?)([FGHJKMNQUVXZ]\d+)$/i);
  return match ? match[1].toUpperCase() : name.toUpperCase();
}

function round2(n) { return Math.round(n * 100) / 100; }

function parsePnlDollars(str) {
  const cleaned = str.replace(/[$(),]/g, '');
  const val = parseFloat(cleaned);
  return str.includes('(') ? -val : val;
}

function parseTimestamp(str) {
  const [datePart, timePart] = str.split(' ');
  const [month, day, year] = datePart.split('/');
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

  // Parse CSV rows into fillPair-like objects
  const fillPairs = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const row = {};
    header.forEach((h, idx) => row[h] = cols[idx]);

    fillPairs.push({
      symbol: row.symbol,
      buyFillId: row.buyFillId,
      sellFillId: row.sellFillId,
      qty: parseInt(row.qty),
      buyPrice: parseFloat(row.buyPrice),
      sellPrice: parseFloat(row.sellPrice),
      pnlDollars: parsePnlDollars(row.pnl),
      buyTime: parseTimestamp(row.boughtTimestamp),
      sellTime: parseTimestamp(row.soldTimestamp),
    });
  }

  // Reconstruct unique fills from fillPairs for position tracking
  const fillMap = new Map(); // fillId -> { id, time, action, qty }
  for (const fp of fillPairs) {
    if (!fillMap.has(fp.buyFillId)) {
      fillMap.set(fp.buyFillId, { id: fp.buyFillId, time: fp.buyTime, action: 'Buy', qty: 0 });
    }
    fillMap.get(fp.buyFillId).qty += fp.qty;

    if (!fillMap.has(fp.sellFillId)) {
      fillMap.set(fp.sellFillId, { id: fp.sellFillId, time: fp.sellTime, action: 'Sell', qty: 0 });
    }
    fillMap.get(fp.sellFillId).qty += fp.qty;
  }

  const allFills = [...fillMap.values()].sort((a, b) => a.time - b.time);

  // Group fillPairs into logical trades (flat → position → flat)
  let netPos = 0;
  let sessionFillIds = new Set();
  const groups = [];

  for (const fill of allFills) {
    sessionFillIds.add(fill.id);
    netPos += fill.action === 'Buy' ? fill.qty : -fill.qty;

    if (netPos === 0 && sessionFillIds.size > 0) {
      const sessionPairs = fillPairs.filter(fp =>
        sessionFillIds.has(fp.buyFillId) || sessionFillIds.has(fp.sellFillId)
      );
      if (sessionPairs.length > 0) groups.push(sessionPairs);
      sessionFillIds = new Set();
    }
  }
  // Unclosed session
  if (sessionFillIds.size > 0) {
    const sessionPairs = fillPairs.filter(fp =>
      sessionFillIds.has(fp.buyFillId) || sessionFillIds.has(fp.sellFillId)
    );
    if (sessionPairs.length > 0) groups.push(sessionPairs);
  }

  console.log(`${fillPairs.length} fill pairs grouped into ${groups.length} logical trades`);

  // Build logical trades from groups
  const trades = [];
  for (const group of groups) {
    let totalPnl = 0;
    let totalQty = 0;
    let earliestEntry = null;
    let latestExit = null;
    let maxPos = 0;
    let firstSide = null;
    const symbol = group[0].symbol;
    const root = getProductRoot(symbol);

    // Track max position
    const gFillIds = new Set();
    for (const fp of group) { gFillIds.add(fp.buyFillId); gFillIds.add(fp.sellFillId); }
    const gFills = allFills.filter(f => gFillIds.has(f.id));
    let rp = 0;
    for (const f of gFills) {
      rp += f.action === 'Buy' ? f.qty : -f.qty;
      maxPos = Math.max(maxPos, Math.abs(rp));
      if (firstSide === null && rp !== 0) firstSide = rp > 0 ? 'Long' : 'Short';
    }

    for (const fp of group) {
      const entryTime = fp.buyTime < fp.sellTime ? fp.buyTime : fp.sellTime;
      const exitTime = fp.buyTime < fp.sellTime ? fp.sellTime : fp.buyTime;
      if (!earliestEntry || entryTime < earliestEntry) earliestEntry = entryTime;
      if (!latestExit || exitTime > latestExit) latestExit = exitTime;
      totalPnl += fp.pnlDollars;
      totalQty += fp.qty;
    }

    const tradeDate = earliestEntry.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const id = `${group[0].buyFillId}-${group[0].sellFillId}`;

    const feeRate = FEES_PER_RT[root] || 1.90;
    const fees = round2(totalQty * feeRate);

    trades.push({
      id, symbol, product: root,
      side: firstSide || 'Long',
      qty: maxPos,
      totalContracts: totalQty,
      fillPairCount: group.length,
      entryTime: earliestEntry.toISOString(),
      exitTime: latestExit.toISOString(),
      tradeDate,
      durationMinutes: Math.round((latestExit - earliestEntry) / 60000),
      pnlDollars: round2(totalPnl),
      fees,
      netPnl: round2(totalPnl - fees),
    });
  }

  trades.sort((a, b) => a.entryTime.localeCompare(b.entryTime));
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
  const wins = trades.filter(t => t.pnlDollars > 0);
  const losses = trades.filter(t => t.pnlDollars < 0);
  let maxWS = 0, maxLS = 0, cWS = 0, cLS = 0;
  for (const t of trades) {
    if (t.pnlDollars > 0) { cWS++; cLS = 0; maxWS = Math.max(maxWS, cWS); }
    else if (t.pnlDollars < 0) { cLS++; cWS = 0; maxLS = Math.max(maxLS, cLS); }
  }
  const grossWins = wins.reduce((s, t) => s + t.pnlDollars, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnlDollars, 0));
  const totalNet = trades.reduce((s, t) => s + t.netPnl, 0);

  const summary = {
    totalTrades: trades.length, totalContracts: trades.reduce((s, t) => s + t.qty, 0),
    wins: wins.length, losses: losses.length, breakeven: trades.filter(t => t.pnlDollars === 0).length,
    winRate: trades.length > 0 ? round2((wins.length / trades.length) * 100) : 0,
    grossPnl: round2(trades.reduce((s, t) => s + t.pnlDollars, 0)),
    totalFees: 0, netPnl: round2(totalNet),
    avgWin: wins.length > 0 ? round2(grossWins / wins.length) : 0,
    avgLoss: losses.length > 0 ? round2(-grossLosses / losses.length) : 0,
    maxWin: wins.length > 0 ? round2(Math.max(...wins.map(t => t.pnlDollars))) : 0,
    maxLoss: losses.length > 0 ? round2(Math.min(...losses.map(t => t.pnlDollars))) : 0,
    avgTrade: trades.length > 0 ? round2(totalNet / trades.length) : 0,
    profitFactor: grossLosses > 0 ? round2(grossWins / grossLosses) : (grossWins > 0 ? Infinity : 0),
    maxWinStreak: maxWS, maxLossStreak: maxLS,
    avgDurationMinutes: trades.length > 0
      ? Math.round(trades.reduce((s, t) => s + t.durationMinutes, 0) / trades.length) : 0,
  };

  // Print summary
  console.log(`\n=== Summary ===`);
  console.log(`Trades: ${summary.totalTrades} (${summary.totalContracts} max contracts)`);
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

  // Store raw data (fillPairs + reconstructed fills) for recompute support
  for (const fp of fillPairs) {
    const rawPair = {
      id: `${fp.buyFillId}-${fp.sellFillId}`,
      buyFillId: parseInt(fp.buyFillId), sellFillId: parseInt(fp.sellFillId),
      qty: fp.qty, buyPrice: fp.buyPrice, sellPrice: fp.sellPrice, active: false,
    };
    await redis.hSet('pnl:raw:fillPairs', rawPair.id, JSON.stringify(rawPair));
  }
  for (const [id, fill] of fillMap) {
    const rawFill = {
      id: parseInt(id), contractId: 0, // unknown from CSV
      timestamp: fill.time.toISOString(), action: fill.action, qty: fill.qty,
      price: 0, active: false, finallyPaired: 1,
    };
    await redis.hSet('pnl:raw:fills', String(rawFill.id), JSON.stringify(rawFill));
  }
  console.log(`Stored ${fillPairs.length} raw fill pairs + ${fillMap.size} raw fills`);

  // Merge computed trades (don't clear - preserves existing data from other imports)
  for (const trade of trades) {
    await redis.hSet('pnl:trades', String(trade.id), JSON.stringify(trade));
  }
  console.log(`Merged ${trades.length} logical trades`);

  // Merge daily summaries (recalculate from all trades in Redis)
  const allRaw = await redis.hGetAll('pnl:trades');
  const allTrades = Object.values(allRaw).map(j => JSON.parse(j));
  const fullDailyMap = new Map();
  for (const t of allTrades) {
    if (!fullDailyMap.has(t.tradeDate)) {
      fullDailyMap.set(t.tradeDate, { date: t.tradeDate, trades: 0, wins: 0, losses: 0, breakeven: 0,
        grossPnl: 0, fees: 0, netPnl: 0, maxWin: 0, maxLoss: 0, totalContracts: 0 });
    }
    const d = fullDailyMap.get(t.tradeDate);
    d.trades++; d.totalContracts += t.qty; d.fees += t.fees;
    d.grossPnl += t.pnlDollars; d.netPnl += t.netPnl;
    if (t.pnlDollars > 0) { d.wins++; d.maxWin = Math.max(d.maxWin, t.pnlDollars); }
    else if (t.pnlDollars < 0) { d.losses++; d.maxLoss = Math.min(d.maxLoss, t.pnlDollars); }
    else d.breakeven++;
  }
  // Clear and rewrite all daily keys
  for await (const key of redis.scanIterator({ MATCH: 'pnl:daily:*', COUNT: 100 })) {
    await redis.del(key);
  }
  for (const [date, d] of fullDailyMap) {
    d.grossPnl = round2(d.grossPnl); d.fees = round2(d.fees); d.netPnl = round2(d.netPnl);
    d.maxWin = round2(d.maxWin); d.maxLoss = round2(d.maxLoss);
    d.winRate = d.trades > 0 ? round2((d.wins / d.trades) * 100) : 0;
    await redis.set(`pnl:daily:${date}`, JSON.stringify(d));
  }
  console.log(`Stored ${fullDailyMap.size} daily summaries (from ${allTrades.length} total trades)`);

  // Recompute overall summary from all trades
  const allWins = allTrades.filter(t => t.pnlDollars > 0);
  const allLosses = allTrades.filter(t => t.pnlDollars < 0);
  let mWS = 0, mLS = 0, cW = 0, cL = 0;
  for (const t of allTrades.sort((a, b) => a.entryTime.localeCompare(b.entryTime))) {
    if (t.pnlDollars > 0) { cW++; cL = 0; mWS = Math.max(mWS, cW); }
    else if (t.pnlDollars < 0) { cL++; cW = 0; mLS = Math.max(mLS, cL); }
  }
  const gW = allWins.reduce((s, t) => s + t.pnlDollars, 0);
  const gL = Math.abs(allLosses.reduce((s, t) => s + t.pnlDollars, 0));
  const tNet = allTrades.reduce((s, t) => s + t.netPnl, 0);
  const fullSummary = {
    totalTrades: allTrades.length, totalContracts: allTrades.reduce((s, t) => s + t.qty, 0),
    wins: allWins.length, losses: allLosses.length, breakeven: allTrades.filter(t => t.pnlDollars === 0).length,
    winRate: allTrades.length > 0 ? round2((allWins.length / allTrades.length) * 100) : 0,
    grossPnl: round2(allTrades.reduce((s, t) => s + t.pnlDollars, 0)),
    totalFees: round2(allTrades.reduce((s, t) => s + t.fees, 0)),
    netPnl: round2(tNet),
    avgWin: allWins.length > 0 ? round2(gW / allWins.length) : 0,
    avgLoss: allLosses.length > 0 ? round2(-gL / allLosses.length) : 0,
    maxWin: allWins.length > 0 ? round2(Math.max(...allWins.map(t => t.pnlDollars))) : 0,
    maxLoss: allLosses.length > 0 ? round2(Math.min(...allLosses.map(t => t.pnlDollars))) : 0,
    avgTrade: allTrades.length > 0 ? round2(tNet / allTrades.length) : 0,
    profitFactor: gL > 0 ? round2(gW / gL) : (gW > 0 ? Infinity : 0),
    maxWinStreak: mWS, maxLossStreak: mLS,
    avgDurationMinutes: allTrades.length > 0
      ? Math.round(allTrades.reduce((s, t) => s + t.durationMinutes, 0) / allTrades.length) : 0,
  };
  await redis.set('pnl:summary', JSON.stringify(fullSummary));
  await redis.set('pnl:last_sync', new Date().toISOString());
  console.log(`Stored overall summary (${allTrades.length} total trades, $${round2(tNet)} net)`);

  await redis.quit();
  console.log('Done!');
  process.exit(0);
}

main().catch(err => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
