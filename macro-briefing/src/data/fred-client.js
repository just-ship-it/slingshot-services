import axios from 'axios';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('fred-client');

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

function getApiKey() {
  return process.env.FRED_API_KEY;
}

// All FRED series we need, grouped by category
const SERIES = {
  // Rates & Yield Curve
  DGS2: 'US 2Y Treasury',
  DGS5: 'US 5Y Treasury',
  DGS10: 'US 10Y Treasury',
  DGS30: 'US 30Y Treasury',
  DTB3: 'US 3M T-Bill',
  T10Y2Y: '10Y-2Y Spread',
  T10Y3M: '10Y-3M Spread',
  DFF: 'Fed Funds Rate',
  SOFR: 'SOFR',

  // Inflation & Breakevens
  T5YIE: '5Y Breakeven',
  T10YIE: '10Y Breakeven',
  T5YIFR: '5Y5Y Forward Inflation',
  DFII10: '10Y TIPS Real Yield',

  // Credit
  BAMLC0A0CM: 'IG OAS',
  BAMLH0A0HYM2: 'HY OAS',

  // Liquidity
  WALCL: 'Fed Balance Sheet',
  RRPONTSYD: 'Reverse Repo',
  WTREGEN: 'Treasury General Account',

  // Volatility & Conditions
  VIXCLS: 'VIX Close',
  NFCI: 'Chicago Fed NFCI',

  // Economy
  UNRATE: 'Unemployment Rate',
  ICSA: 'Initial Claims',
  CPIAUCSL: 'CPI All Items',
  PCEPILFE: 'Core PCE',
  CIVPART: 'Labor Force Participation',
  DTWEXBGS: 'USD Index (Broad)'
};

// In-memory cache with TTL
const cache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Fetch a single FRED series with caching
 */
export async function fetchSeries(seriesId, limit = 252) {
  if (!getApiKey()) {
    throw new Error('FRED_API_KEY not configured');
  }

  const cached = cache.get(seriesId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const response = await axios.get(FRED_BASE, {
    params: {
      series_id: seriesId,
      api_key: getApiKey(),
      file_type: 'json',
      sort_order: 'desc',
      limit
    },
    timeout: 15000
  });

  const observations = response.data.observations
    .filter(o => o.value !== '.')
    .map(o => ({
      date: o.date,
      value: parseFloat(o.value)
    }));

  if (observations.length === 0) {
    logger.warn(`No observations returned for ${seriesId}`);
    return null;
  }

  const latest = observations[0];
  const prior = observations.length > 1 ? observations[1] : null;

  const result = {
    seriesId,
    name: SERIES[seriesId] || seriesId,
    value: latest.value,
    date: latest.date,
    prior: prior ? prior.value : null,
    priorDate: prior ? prior.date : null,
    change: prior ? latest.value - prior.value : null,
    changePct: prior && prior.value !== 0 ? ((latest.value - prior.value) / prior.value) * 100 : null,
    history: observations.map(o => o.value)
  };

  cache.set(seriesId, { data: result, fetchedAt: Date.now() });
  return result;
}

/**
 * Fetch all configured FRED series in parallel batches
 */
export async function fetchAllSeries() {
  if (!getApiKey()) {
    logger.warn('FRED_API_KEY not configured — skipping FRED data');
    return new Map();
  }

  const seriesIds = Object.keys(SERIES);
  const results = new Map();

  // Fetch in batches of 10 to stay well under rate limits
  const BATCH_SIZE = 10;
  for (let i = 0; i < seriesIds.length; i += BATCH_SIZE) {
    const batch = seriesIds.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(id => fetchSeries(id))
    );

    batchResults.forEach((result, idx) => {
      const seriesId = batch[idx];
      if (result.status === 'fulfilled' && result.value) {
        results.set(seriesId, result.value);
      } else if (result.status === 'rejected') {
        logger.warn(`Failed to fetch ${seriesId}: ${result.reason?.message}`);
      }
    });

    // Small delay between batches
    if (i + BATCH_SIZE < seriesIds.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  logger.info(`Fetched ${results.size}/${seriesIds.length} FRED series`);
  return results;
}

export function getSeriesNames() {
  return { ...SERIES };
}
