// Performance metrics on a collection of trades (treated as a single portfolio book).
// Sharpe is annualized from daily PnL series (252 trading days), matching the convention
// the engine's own performance block reports.

import { fmtETDate } from './et-time.js';

// Engine reports `maxDrawdown` as % of $100k starting capital (matches its convention).
// We keep two interpretations: peak-relative AND $100k-notional, so comparisons against
// the gold-standard JSONs line up.
const NOTIONAL_CAPITAL = 100000;

export function calculateMetrics(trades) {
  if (!trades || trades.length === 0) {
    return {
      trades: 0, winRate: 0, totalPnL: 0, avgPnL: 0,
      winners: 0, losers: 0,
      avgWin: 0, avgLoss: 0,
      grossProfit: 0, grossLoss: 0, profitFactor: 0,
      largestWin: 0, largestLoss: 0,
      sharpe: 0,
      maxDD_usd: 0, maxDD_pct: 0,
      avgHoldMin: 0,
      equityCurve: [],
    };
  }

  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);

  const winners = sorted.filter(t => t.netPnL > 0);
  const losers = sorted.filter(t => t.netPnL <= 0);
  const grossProfit = winners.reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.netPnL, 0));
  const totalPnL = grossProfit - grossLoss;

  // Equity curve over exits (one point per closed trade), starting from $100k
  // notional capital — matches the engine's `performance-calculator.js` convention.
  let equity = NOTIONAL_CAPITAL;
  let peak = NOTIONAL_CAPITAL;
  let maxDD_pct = 0;   // engine: (peak - equity) / peak * 100, taken at peak
  let maxDD_usd = 0;
  const curve = [];
  for (const t of sorted) {
    equity += t.netPnL;
    if (equity > peak) peak = equity;
    const ddUsd = peak - equity;
    if (ddUsd > maxDD_usd) maxDD_usd = ddUsd;
    const ddPct = peak > 0 ? (ddUsd / peak) * 100 : 0;
    if (ddPct > maxDD_pct) maxDD_pct = ddPct;
    curve.push({ t: t.exitTime, equity });
  }

  // Daily PnL series → annualized Sharpe.
  const byDay = new Map();
  for (const t of sorted) {
    const day = fmtETDate(t.exitTime);
    byDay.set(day, (byDay.get(day) || 0) + t.netPnL);
  }
  const daily = [...byDay.values()];
  let sharpe = 0;
  if (daily.length > 1) {
    const mean = daily.reduce((s, x) => s + x, 0) / daily.length;
    const variance = daily.reduce((s, x) => s + (x - mean) ** 2, 0) / (daily.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std === 0 ? 0 : (mean / std) * Math.sqrt(252);
  }

  const avgHoldMin = sorted.reduce((s, t) => s + (t.duration || 0), 0) / sorted.length / 60000;

  return {
    trades: sorted.length,
    winRate: (winners.length / sorted.length) * 100,
    totalPnL,
    avgPnL: totalPnL / sorted.length,
    winners: winners.length,
    losers: losers.length,
    avgWin: winners.length ? grossProfit / winners.length : 0,
    avgLoss: losers.length ? grossLoss / losers.length : 0,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    largestWin: winners.length ? Math.max(...winners.map(t => t.netPnL)) : 0,
    largestLoss: losers.length ? Math.min(...losers.map(t => t.netPnL)) : 0,
    sharpe,
    maxDD_usd,
    maxDD_pct,
    avgHoldMin,
    equityCurve: curve,
  };
}

export function sampleCurve(curve, maxPoints = 1000) {
  if (curve.length <= maxPoints) return curve;
  const stride = Math.ceil(curve.length / maxPoints);
  const out = [];
  for (let i = 0; i < curve.length; i += stride) out.push(curve[i]);
  if (out[out.length - 1] !== curve[curve.length - 1]) out.push(curve[curve.length - 1]);
  return out;
}

// Two-proportion z-test for win-rate differences. Returns z and two-sided p (approx).
export function proportionZTest(wins1, n1, wins2, n2) {
  if (!n1 || !n2) return { z: 0, p: 1 };
  const p1 = wins1 / n1;
  const p2 = wins2 / n2;
  const pPool = (wins1 + wins2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  // Approximate two-sided p via complementary error function.
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, p };
}

function normalCdf(x) {
  // Abramowitz & Stegun approximation 7.1.26.
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function round(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return n;
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
}
