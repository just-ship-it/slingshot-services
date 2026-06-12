// Risk-adjusted metrics for a one-trade-per-day points series.
// Inputs are arrays of per-trade points PnL (NQ points, 1 contract). $ = points * 20.

const POINT_VALUE = 20;

export function metrics(pointsArr, { tradesPerYear = 252 } = {}) {
  const n = pointsArr.length;
  if (n === 0) return { trades: 0 };
  const wins = pointsArr.filter(p => p > 0);
  const losses = pointsArr.filter(p => p < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const totalPts = pointsArr.reduce((a, b) => a + b, 0);
  const mean = totalPts / n;
  const variance = pointsArr.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);

  // equity curve + max drawdown in $
  let eq = 0, peak = 0, maxDD = 0;
  for (const p of pointsArr) {
    eq += p * POINT_VALUE;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades: n,
    totalPts: +totalPts.toFixed(1),
    totalPnL: +(totalPts * POINT_VALUE).toFixed(0),
    winRate: +(wins.length / n * 100).toFixed(1),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : Infinity,
    avgPts: +mean.toFixed(2),
    avgWin: wins.length ? +(grossWin / wins.length).toFixed(1) : 0,
    avgLoss: losses.length ? +(grossLoss / losses.length).toFixed(1) : 0,
    // annualized Sharpe assuming ~1 trade/day
    sharpe: std > 0 ? +((mean / std) * Math.sqrt(tradesPerYear)).toFixed(2) : 0,
    maxDD: +maxDD.toFixed(0),
    maxDDpct: peak > 0 ? +(maxDD / peak * 100).toFixed(2) : 0,
  };
}

export function fmt(m) {
  if (!m.trades) return '(no trades)';
  return `$${m.totalPnL.toLocaleString().padStart(9)} | PF ${String(m.profitFactor).padStart(5)} | Sh ${String(m.sharpe).padStart(6)} | DD $${m.maxDD.toLocaleString().padStart(7)} (${m.maxDDpct}%) | WR ${m.winRate}% | n=${m.trades} | avg ${m.avgPts}pt`;
}
