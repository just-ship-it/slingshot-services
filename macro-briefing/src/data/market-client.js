import axios from 'axios';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('market-client');

const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Symbols grouped by category
const INDICES = ['^GSPC', '^IXIC', '^RUT', '^DJI'];
const SECTORS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLC', 'XLI', 'XLY', 'XLP', 'XLB', 'XLRE', 'XLU'];
const FACTORS = ['MTUM', 'VLUE', 'QUAL', 'SIZE', 'USMV'];
const OTHER = ['GLD', 'USO', 'TLT', 'HYG', 'LQD'];

const SYMBOL_NAMES = {
  '^GSPC': 'S&P 500', '^IXIC': 'Nasdaq', '^RUT': 'Russell 2000', '^DJI': 'Dow Jones',
  XLK: 'Technology', XLF: 'Financials', XLE: 'Energy', XLV: 'Healthcare',
  XLC: 'Communication', XLI: 'Industrials', XLY: 'Cons. Disc.', XLP: 'Cons. Staples',
  XLB: 'Materials', XLRE: 'Real Estate', XLU: 'Utilities',
  MTUM: 'Momentum', VLUE: 'Value', QUAL: 'Quality', SIZE: 'Size', USMV: 'Min Vol',
  GLD: 'Gold', USO: 'Crude Oil', TLT: '20Y Treasury', HYG: 'High Yield', LQD: 'Inv Grade'
};

/**
 * Fetch quote data for a single symbol using Yahoo Finance v8 chart API
 */
async function fetchQuote(symbol) {
  const response = await axios.get(`${YAHOO_QUOTE_URL}/${encodeURIComponent(symbol)}`, {
    params: {
      interval: '1d',
      range: '5d'
    },
    headers: {
      'User-Agent': 'Mozilla/5.0'
    },
    timeout: 15000
  });

  const result = response.data.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta;
  const quotes = result.indicators?.quote?.[0];
  const timestamps = result.timestamp;

  if (!meta || !quotes || !timestamps || timestamps.length === 0) return null;

  const lastIdx = timestamps.length - 1;
  const prevIdx = lastIdx > 0 ? lastIdx - 1 : 0;

  const price = meta.regularMarketPrice || quotes.close?.[lastIdx];
  const prevClose = quotes.close?.[prevIdx] || meta.chartPreviousClose;
  const change = price && prevClose ? price - prevClose : null;
  const changePct = change && prevClose ? (change / prevClose) * 100 : null;

  // Build 5d close history for rolling stats
  const closes = [];
  for (let i = 0; i <= lastIdx; i++) {
    if (quotes.close?.[i] != null) closes.push(quotes.close[i]);
  }

  return {
    symbol,
    name: SYMBOL_NAMES[symbol] || symbol,
    price: price ? +price.toFixed(2) : null,
    change: change ? +change.toFixed(2) : null,
    changePct: changePct ? +changePct.toFixed(2) : null,
    high: meta.regularMarketDayHigh || quotes.high?.[lastIdx] || null,
    low: meta.regularMarketDayLow || quotes.low?.[lastIdx] || null,
    volume: quotes.volume?.[lastIdx] || null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
    closes
  };
}

/**
 * Fetch historical daily data for rolling statistics
 */
export async function fetchHistorical(symbol, range = '1y') {
  try {
    const response = await axios.get(`${YAHOO_QUOTE_URL}/${encodeURIComponent(symbol)}`, {
      params: {
        interval: '1d',
        range
      },
      headers: {
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 20000
    });

    const result = response.data.chart?.result?.[0];
    if (!result?.indicators?.quote?.[0]) return [];

    const quotes = result.indicators.quote[0];
    return (quotes.close || []).filter(v => v != null);
  } catch (error) {
    logger.warn(`Historical fetch failed for ${symbol}: ${error.message}`);
    return [];
  }
}

/**
 * Fetch quotes for all configured symbols
 */
export async function fetchAllQuotes() {
  const allSymbols = [...INDICES, ...SECTORS, ...FACTORS, ...OTHER];
  const results = { indices: {}, sectors: {}, factors: {}, other: {} };

  // Fetch in parallel batches of 8
  const BATCH_SIZE = 8;
  const allResults = new Map();

  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    const batch = allSymbols.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(sym => fetchQuote(sym))
    );

    batchResults.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) {
        allResults.set(batch[idx], result.value);
      } else if (result.status === 'rejected') {
        logger.warn(`Quote fetch failed for ${batch[idx]}: ${result.reason?.message}`);
      }
    });

    if (i + BATCH_SIZE < allSymbols.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Categorize results
  for (const sym of INDICES) if (allResults.has(sym)) results.indices[sym] = allResults.get(sym);
  for (const sym of SECTORS) if (allResults.has(sym)) results.sectors[sym] = allResults.get(sym);
  for (const sym of FACTORS) if (allResults.has(sym)) results.factors[sym] = allResults.get(sym);
  for (const sym of OTHER) if (allResults.has(sym)) results.other[sym] = allResults.get(sym);

  logger.info(`Fetched ${allResults.size}/${allSymbols.length} market quotes`);
  return results;
}

export function getSymbolNames() {
  return { ...SYMBOL_NAMES };
}
