import * as ss from 'simple-statistics';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('macro-statistics');

/**
 * Compute descriptive statistics for a series of values
 */
export function computeStats(values) {
  if (!values || values.length < 2) {
    return { mean: null, stdDev: null, zScore: null, percentile: null, min: null, max: null, trend5d: null };
  }

  const clean = values.filter(v => v != null && !isNaN(v));
  if (clean.length < 2) return { mean: null, stdDev: null, zScore: null, percentile: null, min: null, max: null, trend5d: null };

  const latest = clean[0]; // series is desc order (newest first)
  const mean = ss.mean(clean);
  const stdDev = ss.standardDeviation(clean);

  const zScore = stdDev > 0 ? (latest - mean) / stdDev : 0;
  const sorted = [...clean].sort((a, b) => a - b);
  const rank = sorted.filter(v => v <= latest).length;
  const percentile = Math.round((rank / sorted.length) * 100);

  // 5-day trend (if we have at least 5 data points)
  let trend5d = null;
  if (clean.length >= 5) {
    trend5d = clean[0] - clean[4]; // latest minus 5 days ago
  }

  return {
    mean: +mean.toFixed(4),
    stdDev: +stdDev.toFixed(4),
    zScore: +zScore.toFixed(2),
    percentile,
    min: +ss.min(clean).toFixed(4),
    max: +ss.max(clean).toFixed(4),
    trend5d: trend5d !== null ? +trend5d.toFixed(4) : null
  };
}

/**
 * Format a value with its statistical context
 */
export function formatContext(value, change, stats, unit = '') {
  if (value == null) return 'N/A';

  let formatted = `${value.toFixed(2)}${unit}`;

  if (change != null) {
    const sign = change >= 0 ? '+' : '';
    formatted += ` (${sign}${change.toFixed(2)}${unit})`;
  }

  if (stats && stats.percentile != null) {
    formatted += ` | ${stats.percentile}th %ile`;
  }
  if (stats && stats.zScore != null) {
    const zSign = stats.zScore >= 0 ? '+' : '';
    formatted += `, z=${zSign}${stats.zScore}`;
  }

  return formatted;
}

/**
 * Format a value as basis points change
 */
export function formatBps(value, change) {
  if (value == null) return 'N/A';
  let formatted = `${value.toFixed(2)}%`;
  if (change != null) {
    const bps = Math.round(change * 100);
    const sign = bps >= 0 ? '+' : '';
    formatted += ` (${sign}${bps}bps)`;
  }
  return formatted;
}

/**
 * Compute analytics across all FRED data
 */
export function computeAllAnalytics(fredData, marketData) {
  const analytics = {
    rates: {},
    credit: {},
    inflation: {},
    liquidity: {},
    volatility: {},
    economy: {},
    equities: {},
    sectors: {},
    factors: {}
  };

  // --- Rates ---
  const ratesSeries = ['DGS2', 'DGS5', 'DGS10', 'DGS30', 'DTB3', 'T10Y2Y', 'T10Y3M', 'DFF', 'SOFR'];
  for (const id of ratesSeries) {
    const data = fredData.get(id);
    if (!data) continue;
    const stats = computeStats(data.history);
    analytics.rates[id] = {
      name: data.name,
      value: data.value,
      change: data.change,
      formatted: formatBps(data.value, data.change),
      context: formatContext(data.value, data.change, stats, '%'),
      stats
    };
  }

  // --- Credit ---
  const creditSeries = ['BAMLC0A0CM', 'BAMLH0A0HYM2'];
  for (const id of creditSeries) {
    const data = fredData.get(id);
    if (!data) continue;
    const stats = computeStats(data.history);
    analytics.credit[id] = {
      name: data.name,
      value: data.value,
      change: data.change,
      formatted: formatBps(data.value, data.change),
      context: formatContext(data.value, data.change, stats, '%'),
      stats
    };
  }

  // --- Inflation ---
  const inflationSeries = ['T5YIE', 'T10YIE', 'T5YIFR', 'DFII10'];
  for (const id of inflationSeries) {
    const data = fredData.get(id);
    if (!data) continue;
    const stats = computeStats(data.history);
    analytics.inflation[id] = {
      name: data.name,
      value: data.value,
      change: data.change,
      formatted: formatBps(data.value, data.change),
      context: formatContext(data.value, data.change, stats, '%'),
      stats
    };
  }

  // --- Liquidity ---
  const liquiditySeries = ['WALCL', 'RRPONTSYD', 'WTREGEN'];
  for (const id of liquiditySeries) {
    const data = fredData.get(id);
    if (!data) continue;
    const stats = computeStats(data.history);
    // These are in millions/billions, format differently
    const valueFmt = data.value >= 1e6 ? `$${(data.value / 1e6).toFixed(1)}T` :
                     data.value >= 1e3 ? `$${(data.value / 1e3).toFixed(1)}B` :
                     `$${data.value.toFixed(1)}M`;
    analytics.liquidity[id] = {
      name: data.name,
      value: data.value,
      change: data.change,
      formatted: valueFmt,
      context: formatContext(data.value, data.change, stats),
      stats
    };
  }

  // --- Volatility ---
  const volSeries = ['VIXCLS', 'NFCI'];
  for (const id of volSeries) {
    const data = fredData.get(id);
    if (!data) continue;
    const stats = computeStats(data.history);
    analytics.volatility[id] = {
      name: data.name,
      value: data.value,
      change: data.change,
      formatted: formatContext(data.value, data.change, stats),
      stats
    };
  }

  // --- Economy ---
  const econSeries = ['UNRATE', 'ICSA', 'CPIAUCSL', 'PCEPILFE', 'CIVPART', 'DTWEXBGS'];
  for (const id of econSeries) {
    const data = fredData.get(id);
    if (!data) continue;
    const stats = computeStats(data.history);
    analytics.economy[id] = {
      name: data.name,
      value: data.value,
      change: data.change,
      formatted: formatContext(data.value, data.change, stats),
      stats
    };
  }

  // --- Equities (from market data) ---
  if (marketData.indices) {
    for (const [sym, quote] of Object.entries(marketData.indices)) {
      analytics.equities[sym] = {
        name: quote.name,
        price: quote.price,
        change: quote.change,
        changePct: quote.changePct,
        formatted: `${quote.price?.toLocaleString()} (${quote.changePct >= 0 ? '+' : ''}${quote.changePct}%)`
      };
    }
  }

  // --- Sectors ---
  if (marketData.sectors) {
    for (const [sym, quote] of Object.entries(marketData.sectors)) {
      analytics.sectors[sym] = {
        name: quote.name,
        price: quote.price,
        changePct: quote.changePct,
        formatted: `${quote.changePct >= 0 ? '+' : ''}${quote.changePct}%`
      };
    }
  }

  // --- Factors ---
  if (marketData.factors) {
    for (const [sym, quote] of Object.entries(marketData.factors)) {
      analytics.factors[sym] = {
        name: quote.name,
        price: quote.price,
        changePct: quote.changePct,
        formatted: `${quote.changePct >= 0 ? '+' : ''}${quote.changePct}%`
      };
    }
  }

  return analytics;
}
