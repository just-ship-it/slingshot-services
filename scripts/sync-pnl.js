#!/usr/bin/env node

/**
 * sync-pnl.js - End-of-day P&L sync from Tradovate → Redis
 *
 * Pulls fill pairs, fills, and fees from the Tradovate API,
 * enriches with contract details, and persists to Redis.
 * Merges with existing data so history accumulates over time.
 *
 * Uses TRADOVATE_USE_DEMO / TRADOVATE_DEFAULT_ACCOUNT_ID from shared/.env
 * (same config as all other services).
 *
 * Usage:
 *   node scripts/sync-pnl.js                    # Sync using .env config
 *   node scripts/sync-pnl.js --dry-run          # Preview without writing
 *   node scripts/sync-pnl.js --since 2026-03-24 # Only trades from this date
 *
 * Redis keys:
 *   pnl:trades        - Hash: fillPairId → JSON trade object
 *   pnl:daily:{date}  - String: JSON daily summary for that date
 *   pnl:summary       - String: JSON overall summary (recomputed each sync)
 *   pnl:last_sync     - String: ISO timestamp of last sync
 */

import { messageBus, createLogger, configManager } from '../shared/index.js';
import TradovateClient from '../tradovate-service/TradovateClient.js';

const logger = createLogger('sync-pnl');

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sinceIdx = args.indexOf('--since');
const sinceDate = sinceIdx >= 0 ? args[sinceIdx + 1] : null;

// Known product point values as fallback (Tradovate API is authoritative)
const KNOWN_POINT_VALUES = {
  'MNQ': 2,    // Micro E-mini Nasdaq: $2/point
  'NQ': 20,    // E-mini Nasdaq: $20/point
  'MES': 5,    // Micro E-mini S&P: $5/point
  'ES': 50,    // E-mini S&P: $50/point
  'M2K': 5,    // Micro Russell: $5/point
  'RTY': 50,   // E-mini Russell: $50/point
};

function getProductRoot(contractName) {
  const match = contractName.match(/^([A-Z]+\d?[A-Z]*?)([FGHJKMNQUVXZ]\d+)$/i);
  if (match) return match[1].toUpperCase();
  return contractName.toUpperCase();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function buildDailySummaries(trades) {
  const dailyMap = new Map();
  for (const t of trades) {
    if (!dailyMap.has(t.tradeDate)) {
      dailyMap.set(t.tradeDate, {
        date: t.tradeDate, trades: 0, wins: 0, losses: 0, breakeven: 0,
        grossPnl: 0, fees: 0, netPnl: 0, maxWin: 0, maxLoss: 0, totalContracts: 0,
      });
    }
    const day = dailyMap.get(t.tradeDate);
    day.trades++;
    day.totalContracts += t.qty;
    day.fees += t.fees;
    if (t.pnlDollars !== null) {
      day.grossPnl += t.pnlDollars;
      day.netPnl += t.netPnl;
      if (t.pnlDollars > 0) { day.wins++; day.maxWin = Math.max(day.maxWin, t.pnlDollars); }
      else if (t.pnlDollars < 0) { day.losses++; day.maxLoss = Math.min(day.maxLoss, t.pnlDollars); }
      else { day.breakeven++; }
    }
  }
  return Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({
      ...d,
      grossPnl: round2(d.grossPnl), fees: round2(d.fees), netPnl: round2(d.netPnl),
      maxWin: round2(d.maxWin), maxLoss: round2(d.maxLoss),
      winRate: d.trades > 0 ? round2((d.wins / d.trades) * 100) : 0,
    }));
}

function buildOverallSummary(trades) {
  const completed = trades.filter(t => t.pnlDollars !== null);
  const wins = completed.filter(t => t.pnlDollars > 0);
  const losses = completed.filter(t => t.pnlDollars < 0);

  let maxWS = 0, maxLS = 0, cWS = 0, cLS = 0;
  for (const t of completed) {
    if (t.pnlDollars > 0) { cWS++; cLS = 0; maxWS = Math.max(maxWS, cWS); }
    else if (t.pnlDollars < 0) { cLS++; cWS = 0; maxLS = Math.max(maxLS, cLS); }
  }

  const totalGross = completed.reduce((s, t) => s + t.pnlDollars, 0);
  const totalFees = completed.reduce((s, t) => s + t.fees, 0);
  const totalNet = completed.reduce((s, t) => s + t.netPnl, 0);
  const grossWins = wins.reduce((s, t) => s + t.pnlDollars, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnlDollars, 0));

  return {
    totalTrades: completed.length,
    totalContracts: completed.reduce((s, t) => s + t.qty, 0),
    wins: wins.length, losses: losses.length,
    breakeven: completed.filter(t => t.pnlDollars === 0).length,
    winRate: completed.length > 0 ? round2((wins.length / completed.length) * 100) : 0,
    grossPnl: round2(totalGross), totalFees: round2(totalFees), netPnl: round2(totalNet),
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
}

async function main() {
  logger.info('=== Tradovate P&L Sync ===');
  if (dryRun) logger.info('DRY RUN - no data will be written');
  if (sinceDate) logger.info(`Filtering trades since ${sinceDate}`);

  // Connect to Redis
  logger.info('Connecting to Redis...');
  await messageBus.connect();
  const redis = messageBus.publisher;

  // Load config and connect to Tradovate (uses .env: TRADOVATE_USE_DEMO, TRADOVATE_DEFAULT_ACCOUNT_ID, etc.)
  const config = configManager.loadConfig('sync-pnl', { defaultPort: 0 });
  const env = config.tradovate.useDemo ? 'DEMO' : 'LIVE';

  const client = new TradovateClient(config.tradovate, logger, null, null);
  logger.info(`Authenticating with Tradovate (${env})...`);
  await client.connect();
  await client.loadAccounts();

  const accountId = config.tradovate.defaultAccountId || client.accounts[0]?.id;
  if (!accountId) throw new Error('No account ID found');
  logger.info(`Using account ${accountId}`);

  // Fetch all data from Tradovate
  logger.info('Fetching fills...');
  const fills = await client.getFills(accountId);
  logger.info(`Got ${fills.length} fills`);

  logger.info('Fetching fill pairs...');
  const fillPairs = await client.getFillPairs();
  logger.info(`Got ${fillPairs.length} fill pairs`);

  logger.info('Fetching fill fees...');
  const fillFees = await client.getFillFees();
  logger.info(`Got ${fillFees.length} fill fee records`);

  // Index fills and fees by ID
  const fillById = new Map(fills.map(f => [f.id, f]));
  const feeByFillId = new Map(fillFees.map(f => [f.id, f]));

  // Contract resolver with cache
  const contractCache = new Map();
  async function resolveContract(contractId) {
    if (contractCache.has(contractId)) return contractCache.get(contractId);
    try {
      const contract = await client.getContractDetails(contractId);
      let valuePerPoint = null, productName = null;
      if (contract.contractMaturityId) {
        try {
          const maturity = await client.getContractMaturity(contract.contractMaturityId);
          if (maturity.productId) {
            const product = await client.getProduct(maturity.productId);
            valuePerPoint = product.valuePerPoint;
            productName = product.name;
          }
        } catch (e) {
          logger.warn(`Could not resolve product for contract ${contractId}: ${e.message}`);
        }
      }
      if (!valuePerPoint) {
        const root = getProductRoot(contract.name);
        valuePerPoint = KNOWN_POINT_VALUES[root];
      }
      const result = { name: contract.name, productName: productName || getProductRoot(contract.name), valuePerPoint: valuePerPoint || null };
      contractCache.set(contractId, result);
      return result;
    } catch (e) {
      logger.error(`Failed to resolve contract ${contractId}: ${e.message}`);
      const result = { name: `unknown-${contractId}`, productName: 'UNKNOWN', valuePerPoint: null };
      contractCache.set(contractId, result);
      return result;
    }
  }

  function sumFees(feeRecord) {
    if (!feeRecord) return 0;
    return (feeRecord.clearingFee || 0) + (feeRecord.exchangeFee || 0) + (feeRecord.nfaFee || 0) +
           (feeRecord.brokerageFee || 0) + (feeRecord.ipFee || 0) + (feeRecord.commission || 0) +
           (feeRecord.orderRoutingFee || 0);
  }

  // Build trades from fill pairs
  logger.info('Processing fill pairs into trades...');
  const newTrades = [];

  for (const pair of fillPairs) {
    const buyFill = fillById.get(pair.buyFillId);
    const sellFill = fillById.get(pair.sellFillId);
    if (!buyFill || !sellFill) {
      logger.warn(`Fill pair ${pair.id}: missing fill data (buy=${pair.buyFillId}, sell=${pair.sellFillId})`);
      continue;
    }

    const contract = await resolveContract(buyFill.contractId);
    const buyTime = new Date(buyFill.timestamp);
    const sellTime = new Date(sellFill.timestamp);
    const entryTime = buyTime < sellTime ? buyTime : sellTime;
    const exitTime = buyTime < sellTime ? sellTime : buyTime;
    const side = buyTime < sellTime ? 'Long' : 'Short';

    const pnlPoints = pair.sellPrice - pair.buyPrice;
    const pnlDollars = contract.valuePerPoint ? pnlPoints * pair.qty * contract.valuePerPoint : null;
    const entryFees = sumFees(feeByFillId.get(pair.buyFillId));
    const exitFees = sumFees(feeByFillId.get(pair.sellFillId));
    const totalFees = entryFees + exitFees;
    const netPnl = pnlDollars !== null ? pnlDollars - totalFees : null;
    const durationMinutes = Math.round((exitTime - entryTime) / 60000);

    const tradeDate = buyFill.tradeDate?.year && buyFill.tradeDate?.month && buyFill.tradeDate?.day
      ? `${buyFill.tradeDate.year}-${String(buyFill.tradeDate.month).padStart(2, '0')}-${String(buyFill.tradeDate.day).padStart(2, '0')}`
      : entryTime.toISOString().split('T')[0];

    if (sinceDate && tradeDate < sinceDate) continue;

    newTrades.push({
      id: pair.id,
      positionId: pair.positionId,
      symbol: contract.name,
      product: contract.productName,
      side, qty: pair.qty,
      entryPrice: side === 'Long' ? pair.buyPrice : pair.sellPrice,
      exitPrice: side === 'Long' ? pair.sellPrice : pair.buyPrice,
      entryTime: entryTime.toISOString(),
      exitTime: exitTime.toISOString(),
      tradeDate, durationMinutes,
      pnlPoints: round2(pnlPoints),
      pnlDollars: pnlDollars !== null ? round2(pnlDollars) : null,
      fees: round2(totalFees),
      netPnl: netPnl !== null ? round2(netPnl) : null,
    });
  }

  logger.info(`Processed ${newTrades.length} new trades from Tradovate`);

  if (!dryRun) {
    // Merge new trades into Redis (keyed by fillPair ID for idempotency)
    let stored = 0;
    for (const trade of newTrades) {
      await redis.hSet('pnl:trades', String(trade.id), JSON.stringify(trade));
      stored++;
    }
    logger.info(`Stored ${stored} trades in Redis (pnl:trades)`);

    // Load ALL trades from Redis to recompute summaries
    const allTradeData = await redis.hGetAll('pnl:trades');
    const allTrades = Object.values(allTradeData)
      .map(json => JSON.parse(json))
      .sort((a, b) => a.entryTime.localeCompare(b.entryTime));

    logger.info(`Total trades in Redis: ${allTrades.length}`);

    // Recompute and store daily summaries
    const dailySummaries = buildDailySummaries(allTrades);
    for (const day of dailySummaries) {
      await redis.set(`pnl:daily:${day.date}`, JSON.stringify(day));
    }
    logger.info(`Updated ${dailySummaries.length} daily summaries`);

    // Recompute and store overall summary
    const overallSummary = buildOverallSummary(allTrades);
    await redis.set('pnl:summary', JSON.stringify(overallSummary));
    await redis.set('pnl:last_sync', new Date().toISOString());

    // Print summary
    console.log('\n=== P&L Summary (all time) ===');
    console.log(`Total trades: ${overallSummary.totalTrades} (${overallSummary.totalContracts} contracts)`);
    console.log(`Win rate: ${overallSummary.winRate}% (${overallSummary.wins}W / ${overallSummary.losses}L)`);
    console.log(`Gross P&L: $${overallSummary.grossPnl.toLocaleString()}`);
    console.log(`Total fees: $${overallSummary.totalFees.toLocaleString()}`);
    console.log(`Net P&L: $${overallSummary.netPnl.toLocaleString()}`);
    console.log(`Avg win: $${overallSummary.avgWin} | Avg loss: $${overallSummary.avgLoss}`);
    console.log(`Max win: $${overallSummary.maxWin} | Max loss: $${overallSummary.maxLoss}`);
    console.log(`Profit factor: ${overallSummary.profitFactor}`);
    console.log(`Streaks: ${overallSummary.maxWinStreak}W / ${overallSummary.maxLossStreak}L`);
    console.log(`Avg duration: ${overallSummary.avgDurationMinutes} min`);

    console.log('\n=== Daily Breakdown ===');
    for (const day of dailySummaries) {
      const sign = day.netPnl >= 0 ? '+' : '';
      console.log(`${day.date}: ${day.trades} trades, ${sign}$${day.netPnl.toLocaleString()} net (${day.winRate}% WR)`);
    }
  } else {
    // Dry run - just print what we'd store
    const overallSummary = buildOverallSummary(newTrades);
    console.log('\n=== P&L Summary (this sync only, dry run) ===');
    console.log(`Trades: ${overallSummary.totalTrades}, Net P&L: $${overallSummary.netPnl}`);

    const dailySummaries = buildDailySummaries(newTrades);
    console.log('\n=== Daily Breakdown ===');
    for (const day of dailySummaries) {
      const sign = day.netPnl >= 0 ? '+' : '';
      console.log(`${day.date}: ${day.trades} trades, ${sign}$${day.netPnl.toLocaleString()} net (${day.winRate}% WR)`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  logger.error(`Sync failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
