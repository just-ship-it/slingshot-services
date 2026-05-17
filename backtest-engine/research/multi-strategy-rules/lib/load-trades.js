// Loader + normalizer for the three gold-standard strategy trade JSONs.
// Stamps each trade with `strategyKey` and normalizes the few fields that
// vary across the three files (`signal.strategy` is undefined for lt-3m;
// `signal.ruleId` is undefined for level-fade; `exitPrice` does not exist
// anywhere — `actualExit` is the executed price).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

export const STRATEGIES = [
  {
    key: 'gex-flip-ivpct',
    label: 'GEX_FLIP_IVPCT',
    priority: 1, // best Sharpe / PF — wins ties
    file: 'data/gold-standard/gex-flip-ivpct-twolayer-be80p10-fib618-a40.json',
  },
  {
    key: 'gex-lt-3m',
    label: 'GEX_LT_3M_CROSSOVER',
    priority: 2,
    file: 'data/gold-standard/gex-lt-3m-crossover.json',
  },
  {
    key: 'gex-level-fade',
    label: 'GEX_LEVEL_FADE',
    priority: 3,
    file: 'data/gold-standard/gex-level-fade.json',
  },
];

export const POINT_VALUE_NQ = 20;
export const COMMISSION_NQ = 5; // round-trip, matches the JSON commission field

function normSide(s) {
  if (!s) return null;
  const l = String(s).toLowerCase();
  if (l === 'long' || l === 'buy') return 'long';
  if (l === 'short' || l === 'sell') return 'short';
  return null;
}

function normalize(trade, strategyKey) {
  const side = normSide(trade.side);
  const entryTime = trade.entryTime;
  const exitTime = trade.exitTime ?? (entryTime + (trade.duration ?? 0));
  return {
    id: `${strategyKey}:${trade.id}`,
    nativeId: trade.id,
    strategyKey,
    side,
    entryTime,
    exitTime,
    duration: trade.duration ?? (exitTime - entryTime),
    actualEntry: trade.actualEntry ?? trade.entryPrice,
    actualExit: trade.actualExit,
    entryPrice: trade.entryPrice,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    netPnL: trade.netPnL,
    grossPnL: trade.grossPnL,
    pointsPnL: trade.pointsPnL,
    mfePoints: trade.mfePoints,
    maePoints: trade.maePoints,
    profitGiveBack: trade.profitGiveBack,
    exitReason: trade.exitReason,
    ruleId: trade.signal?.ruleId ?? null,
    commission: trade.commission ?? COMMISSION_NQ,
    pointValue: trade.pointValue ?? POINT_VALUE_NQ,
    status: trade.status,
  };
}

export function loadOne(stratDef) {
  const fullPath = path.join(ROOT, stratDef.file);
  const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const trades = raw.trades
    .filter(t => t.status === 'completed')
    .filter(t => t.entryTime != null && t.exitTime != null)
    .filter(t => normSide(t.side) != null)
    .map(t => normalize(t, stratDef.key));
  return {
    meta: {
      ...stratDef,
      filePath: fullPath,
      reportedTotalPnL: raw.performance?.summary?.totalPnL ?? raw.performance?.basic?.totalPnL,
      reportedTrades: raw.performance?.summary?.totalTrades ?? raw.performance?.basic?.totalTrades,
      reportedPF: raw.performance?.summary?.profitFactor ?? raw.performance?.basic?.profitFactor,
      reportedSharpe: raw.performance?.summary?.sharpeRatio,
      reportedDD: raw.performance?.summary?.maxDrawdown,
      reportedWR: raw.performance?.summary?.winRate,
    },
    trades,
  };
}

export function loadAll() {
  const byKey = new Map();
  const allFlat = [];
  for (const def of STRATEGIES) {
    const loaded = loadOne(def);
    byKey.set(def.key, loaded);
    allFlat.push(...loaded.trades);
  }
  allFlat.sort((a, b) => a.entryTime - b.entryTime);
  return { byKey, allFlat };
}

export function dateRange(trades) {
  if (trades.length === 0) return { first: null, last: null };
  const first = trades.reduce((m, t) => Math.min(m, t.entryTime), Infinity);
  const last = trades.reduce((m, t) => Math.max(m, t.exitTime), -Infinity);
  return { first, last };
}

export function priorityFor(strategyKey) {
  const s = STRATEGIES.find(s => s.key === strategyKey);
  return s ? s.priority : 999;
}
