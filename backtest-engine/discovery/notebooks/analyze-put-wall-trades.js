/**
 * Analyze Put Wall Bounce trades by various factors
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load trades CSV
const csvPath = path.join(__dirname, '../../strategies/put-wall-bounce/results/trades_2023-04-01_2025-01-20.csv');
const content = fs.readFileSync(csvPath, 'utf-8');

const lines = content.trim().split('\n');
const headers = lines[0].split(',');
const trades = [];

for (let i = 1; i < lines.length; i++) {
  const values = lines[i].split(',');
  const trade = {};
  headers.forEach((h, idx) => {
    trade[h] = values[idx];
  });
  trade.pnl = parseFloat(trade.pnl);
  trade.risk = parseFloat(trade.risk);
  trades.push(trade);
}

console.log(`\n=== PUT WALL BOUNCE TRADE ANALYSIS ===`);
console.log(`Total trades: ${trades.length}`);

// Analyze by regime
console.log(`\n=== BY REGIME ===`);
const byRegime = {};
trades.forEach(t => {
  const regime = t.regime || 'unknown';
  if (!byRegime[regime]) byRegime[regime] = [];
  byRegime[regime].push(t);
});

Object.entries(byRegime).forEach(([regime, regimeTrades]) => {
  const totalPnL = regimeTrades.reduce((a, t) => a + t.pnl, 0);
  const wins = regimeTrades.filter(t => t.pnl > 0).length;
  const winRate = (wins / regimeTrades.length * 100).toFixed(1);
  const avgPnL = (totalPnL / regimeTrades.length).toFixed(2);
  console.log(`  ${regime.padEnd(20)}: n=${regimeTrades.length}, P&L=${totalPnL.toFixed(2)}, winRate=${winRate}%, avgPnL=${avgPnL}`);
});

// Analyze by session (extract from entryTime)
console.log(`\n=== BY SESSION ===`);
function getSession(timestamp) {
  const date = new Date(timestamp);
  const utcHour = date.getUTCHours();
  const estHour = (utcHour - 5 + 24) % 24;

  if (estHour >= 18 || estHour < 4) return 'overnight';
  if (estHour >= 4 && estHour < 9.5) return 'premarket';
  if (estHour >= 9.5 && estHour < 16) return 'rth';
  return 'afterhours';
}

const bySession = {};
trades.forEach(t => {
  const session = getSession(t.entryTime);
  if (!bySession[session]) bySession[session] = [];
  bySession[session].push(t);
});

Object.entries(bySession).forEach(([session, sessionTrades]) => {
  const totalPnL = sessionTrades.reduce((a, t) => a + t.pnl, 0);
  const wins = sessionTrades.filter(t => t.pnl > 0).length;
  const winRate = (wins / sessionTrades.length * 100).toFixed(1);
  const avgPnL = (totalPnL / sessionTrades.length).toFixed(2);
  console.log(`  ${session.padEnd(12)}: n=${sessionTrades.length}, P&L=${totalPnL.toFixed(2)}, winRate=${winRate}%, avgPnL=${avgPnL}`);
});

// Analyze by exit reason
console.log(`\n=== BY EXIT REASON ===`);
const byExit = {};
trades.forEach(t => {
  const exit = t.exitReason;
  if (!byExit[exit]) byExit[exit] = [];
  byExit[exit].push(t);
});

Object.entries(byExit).forEach(([exit, exitTrades]) => {
  const totalPnL = exitTrades.reduce((a, t) => a + t.pnl, 0);
  const avgPnL = (totalPnL / exitTrades.length).toFixed(2);
  console.log(`  ${exit.padEnd(15)}: n=${exitTrades.length}, P&L=${totalPnL.toFixed(2)}, avgPnL=${avgPnL}`);
});

// Analyze by risk level
console.log(`\n=== BY RISK LEVEL ===`);
const byRisk = {
  'low (0-8 pts)': [],
  'medium (8-12 pts)': [],
  'high (12+ pts)': []
};

trades.forEach(t => {
  if (t.risk <= 8) byRisk['low (0-8 pts)'].push(t);
  else if (t.risk <= 12) byRisk['medium (8-12 pts)'].push(t);
  else byRisk['high (12+ pts)'].push(t);
});

Object.entries(byRisk).forEach(([level, levelTrades]) => {
  if (levelTrades.length === 0) return;
  const totalPnL = levelTrades.reduce((a, t) => a + t.pnl, 0);
  const wins = levelTrades.filter(t => t.pnl > 0).length;
  const winRate = (wins / levelTrades.length * 100).toFixed(1);
  const avgPnL = (totalPnL / levelTrades.length).toFixed(2);
  console.log(`  ${level.padEnd(20)}: n=${levelTrades.length}, P&L=${totalPnL.toFixed(2)}, winRate=${winRate}%, avgPnL=${avgPnL}`);
});

// Analyze by year
console.log(`\n=== BY YEAR ===`);
const byYear = {};
trades.forEach(t => {
  const year = t.entryTime.slice(0, 4);
  if (!byYear[year]) byYear[year] = [];
  byYear[year].push(t);
});

Object.entries(byYear).forEach(([year, yearTrades]) => {
  const totalPnL = yearTrades.reduce((a, t) => a + t.pnl, 0);
  const wins = yearTrades.filter(t => t.pnl > 0).length;
  const winRate = (wins / yearTrades.length * 100).toFixed(1);
  const avgPnL = (totalPnL / yearTrades.length).toFixed(2);
  console.log(`  ${year}: n=${yearTrades.length}, P&L=${totalPnL.toFixed(2)}, winRate=${winRate}%, avgPnL=${avgPnL}`);
});

// Best performing segments
console.log(`\n=== BEST FILTER COMBINATIONS ===`);

// Strong negative regime
const strongNeg = trades.filter(t => t.regime === 'strong_negative');
if (strongNeg.length > 0) {
  const pnl = strongNeg.reduce((a, t) => a + t.pnl, 0);
  const wins = strongNeg.filter(t => t.pnl > 0).length;
  console.log(`  strong_negative only: n=${strongNeg.length}, P&L=${pnl.toFixed(2)}, winRate=${(wins/strongNeg.length*100).toFixed(1)}%`);
}

// Premarket only
const premarket = trades.filter(t => getSession(t.entryTime) === 'premarket');
if (premarket.length > 0) {
  const pnl = premarket.reduce((a, t) => a + t.pnl, 0);
  const wins = premarket.filter(t => t.pnl > 0).length;
  console.log(`  premarket only: n=${premarket.length}, P&L=${pnl.toFixed(2)}, winRate=${(wins/premarket.length*100).toFixed(1)}%`);
}

// Low risk only
const lowRisk = trades.filter(t => t.risk <= 8);
if (lowRisk.length > 0) {
  const pnl = lowRisk.reduce((a, t) => a + t.pnl, 0);
  const wins = lowRisk.filter(t => t.pnl > 0).length;
  console.log(`  low risk (<=8 pts) only: n=${lowRisk.length}, P&L=${pnl.toFixed(2)}, winRate=${(wins/lowRisk.length*100).toFixed(1)}%`);
}

// Combination: strong_negative + low risk
const combo = trades.filter(t => t.regime === 'strong_negative' && t.risk <= 10);
if (combo.length > 0) {
  const pnl = combo.reduce((a, t) => a + t.pnl, 0);
  const wins = combo.filter(t => t.pnl > 0).length;
  console.log(`  strong_negative + risk<=10: n=${combo.length}, P&L=${pnl.toFixed(2)}, winRate=${(wins/combo.length*100).toFixed(1)}%`);
}

console.log(`\n=== ANALYSIS COMPLETE ===`);
