import { createLogger } from '../../../shared/index.js';
import TradierClient from './tradier-client.js';

const logger = createLogger('options-chain-manager');

class OptionsChainManager {
  constructor(options = {}) {
    this.tradierClient = options.tradierClient;
    this.symbols = options.symbols || ['SPY', 'QQQ'];
    this.maxExpirations = options.maxExpirations || 6;
    this.pollIntervalMs = (options.pollIntervalMinutes || 2) * 60 * 1000;

    // Cache for options chain data
    this.chainCache = new Map(); // key: symbol:expiration, value: { data, timestamp }
    this.expirationCache = new Map(); // key: symbol, value: { expirations, timestamp }
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes

    // Polling state
    this.isPolling = false;
    this.pollTimer = null;
    this.lastPollTime = 0;

    // Strategy for selecting expirations
    this.expirationStrategy = {
      include0DTE: true,
      weeklyCount: 2,
      includeMonthly: true
    };

    if (!this.tradierClient) {
      throw new Error('TradierClient instance is required');
    }
  }

  /**
   * Start polling options chains
   */
  start() {
    if (this.isPolling) {
      logger.warn('Options chain manager is already running');
      return;
    }

    this.isPolling = true;
    logger.info(`Starting options chain polling every ${this.pollIntervalMs / 1000 / 60} minutes for symbols: ${this.symbols.join(', ')}`);

    // Initial fetch
    this.pollChains().catch(error => {
      logger.error('Initial options chain poll failed:', error.message, error.stack);
      logger.error('Initial poll error details:', error);
    });

    // Set up recurring polling
    this.pollTimer = setInterval(() => {
      this.pollChains().catch(error => {
        logger.error('Scheduled options chain poll failed:', error.message, error.stack);
        logger.error('Scheduled poll error details:', error);
      });
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stop() {
    if (!this.isPolling) {
      return;
    }

    this.isPolling = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    logger.info('Stopped options chain polling');
  }

  /**
   * Poll all options chains
   */
  async pollChains() {
    const startTime = Date.now();
    logger.info('Starting options chain poll...');

    try {
      const results = await Promise.allSettled(
        this.symbols.map(symbol => this.pollSymbol(symbol))
      );

      let successCount = 0;
      let errorCount = 0;

      results.forEach((result, index) => {
        const symbol = this.symbols[index];
        if (result.status === 'fulfilled') {
          successCount++;
          const chainData = this.getSymbolChains(symbol);
          const chainCount = chainData.length;
          logger.info(`✅ Successfully polled ${symbol}: ${chainCount} options retrieved`);
          if (chainCount === 0) {
            logger.warn(`⚠️  ${symbol} returned 0 options - possible market hours, rate limiting, or data availability issue`);
          }
        } else {
          errorCount++;
          logger.error(`❌ Failed to poll options chains for ${symbol}:`, result.reason?.message);
        }
      });

      this.lastPollTime = startTime;
      const duration = Date.now() - startTime;

      logger.info(`Options chain poll completed: ${successCount} success, ${errorCount} errors in ${duration}ms`);

    } catch (error) {
      logger.error('Options chain poll failed:', error.message, error.stack);
      logger.error('Full error object:', error);
    }
  }

  /**
   * Poll options chains for a single symbol
   */
  async pollSymbol(symbol) {
    try {
      // Get available expirations
      const expirations = await this.getExpirations(symbol);

      // Select which expirations to fetch
      const selectedExpirations = this.selectExpirations(expirations, symbol);

      // Fetch options chains for selected expirations
      const chainPromises = selectedExpirations.map(exp =>
        this.getOptionsChain(symbol, exp)
      );

      await Promise.allSettled(chainPromises);

    } catch (error) {
      logger.error(`Failed to poll symbol ${symbol}:`, error.message);
      throw error;
    }
  }

  /**
   * Get expirations for a symbol (cached)
   */
  async getExpirations(symbol, forceRefresh = false) {
    const cacheKey = symbol;
    const cached = this.expirationCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
      return cached.expirations;
    }

    try {
      const response = await this.tradierClient.getExpirations(symbol);
      const expirations = response.expirations?.date || [];

      logger.info(`📅 ${symbol} expirations API response: found ${expirations.length} expirations`);
      if (expirations.length === 0) {
        logger.warn(`⚠️  ${symbol} returned no expirations. Raw response:`, JSON.stringify(response).substring(0, 200));
      }

      // Cache the result
      this.expirationCache.set(cacheKey, {
        expirations,
        timestamp: Date.now()
      });

      logger.debug(`Fetched ${expirations.length} expirations for ${symbol}`);
      return expirations;

    } catch (error) {
      logger.error(`Failed to get expirations for ${symbol}:`, error.message);

      // Return cached data if available, even if expired
      if (cached) {
        logger.info(`Using cached expirations for ${symbol} due to error`);
        return cached.expirations;
      }

      throw error;
    }
  }

  /**
   * Get options chain for symbol and expiration (cached)
   */
  async getOptionsChain(symbol, expiration, forceRefresh = false) {
    const cacheKey = `${symbol}:${expiration}`;
    const cached = this.chainCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
      return cached.data;
    }

    try {
      const response = await this.tradierClient.getOptionsChain(symbol, expiration);
      const options = response.options?.option || [];

      const chainData = {
        symbol,
        expiration,
        options,
        timestamp: Date.now(),
        count: options.length
      };

      // Cache the result
      this.chainCache.set(cacheKey, {
        data: chainData,
        timestamp: Date.now()
      });

      logger.info(`📊 ${symbol} ${expiration}: fetched ${options.length} options from Tradier`);
      if (options.length === 0) {
        logger.warn(`⚠️  ${symbol} ${expiration} returned 0 options. Raw response:`, JSON.stringify(response).substring(0, 300));
      }
      return chainData;

    } catch (error) {
      logger.error(`Failed to get options chain for ${symbol} ${expiration}:`, error.message);

      // Return cached data if available, even if expired
      if (cached) {
        logger.info(`Using cached options chain for ${symbol} ${expiration} due to error`);
        return cached.data;
      }

      throw error;
    }
  }

  /**
   * Select which expirations to fetch based on strategy
   */
  selectExpirations(allExpirations, symbol) {
    if (!allExpirations || allExpirations.length === 0) {
      return [];
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const selected = [];
    const sortedExpirations = allExpirations
      .map(exp => ({
        date: exp,
        dateObj: new Date(exp + 'T16:00:00-05:00'), // 4PM ET expiry
        daysToExpiry: Math.ceil((new Date(exp + 'T16:00:00-05:00') - today) / (1000 * 60 * 60 * 24))
      }))
      .sort((a, b) => a.dateObj - b.dateObj);

    // 0DTE (same day expiration)
    if (this.expirationStrategy.include0DTE) {
      const dte0 = sortedExpirations.find(exp => exp.daysToExpiry === 0);
      if (dte0) {
        selected.push(dte0.date);
      }
    }

    // Weekly expirations (within next few weeks, excluding 0DTE)
    const weeklyExpirations = sortedExpirations
      .filter(exp => exp.daysToExpiry > 0 && exp.daysToExpiry <= 30)
      .slice(0, this.expirationStrategy.weeklyCount);

    weeklyExpirations.forEach(exp => {
      if (!selected.includes(exp.date)) {
        selected.push(exp.date);
      }
    });

    // Monthly expiration (third Friday of the month)
    if (this.expirationStrategy.includeMonthly) {
      const monthlyExp = sortedExpirations.find(exp => {
        const date = exp.dateObj;
        const friday = date.getDay() === 5; // Friday
        const dayOfMonth = date.getDate();
        // Third Friday is typically between 15th-21st
        return friday && dayOfMonth >= 15 && dayOfMonth <= 21 && exp.daysToExpiry > 7;
      });

      if (monthlyExp && !selected.includes(monthlyExp.date)) {
        selected.push(monthlyExp.date);
      }
    }

    // Limit to maxExpirations
    const finalSelected = selected.slice(0, this.maxExpirations);

    logger.info(`🎯 ${symbol}: selected ${finalSelected.length}/${allExpirations.length} expirations: [${finalSelected.join(', ')}]`);
    if (finalSelected.length === 0) {
      logger.warn(`⚠️  ${symbol}: No expirations selected from ${allExpirations.length} available. Available: [${allExpirations.slice(0, 5).join(', ')}${allExpirations.length > 5 ? '...' : ''}]`);
    }
    return finalSelected;
  }

  /**
   * Get all cached options chains for a symbol
   */
  getSymbolChains(symbol) {
    const chains = [];

    for (const [key, cached] of this.chainCache) {
      if (key.startsWith(symbol + ':')) {
        chains.push(cached.data);
      }
    }

    return chains.sort((a, b) => new Date(a.expiration) - new Date(b.expiration));
  }

  /**
   * Get all cached options for processing
   */
  getAllCachedChains() {
    const allChains = {};

    for (const symbol of this.symbols) {
      allChains[symbol] = this.getSymbolChains(symbol);
    }

    return allChains;
  }

  /**
   * Clear cache for a symbol or all symbols
   */
  clearCache(symbol = null) {
    if (symbol) {
      // Clear specific symbol
      for (const key of this.chainCache.keys()) {
        if (key.startsWith(symbol + ':')) {
          this.chainCache.delete(key);
        }
      }
      this.expirationCache.delete(symbol);
      logger.info(`Cleared cache for symbol ${symbol}`);
    } else {
      // Clear all cache
      this.chainCache.clear();
      this.expirationCache.clear();
      logger.info('Cleared all cache');
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const now = Date.now();
    let validChains = 0;
    let expiredChains = 0;

    for (const cached of this.chainCache.values()) {
      if (now - cached.timestamp < this.cacheExpiry) {
        validChains++;
      } else {
        expiredChains++;
      }
    }

    return {
      totalChains: this.chainCache.size,
      validChains,
      expiredChains,
      expirations: this.expirationCache.size,
      lastPollTime: this.lastPollTime,
      isPolling: this.isPolling
    };
  }

  /**
   * Force refresh of all chains
   */
  async forceRefresh() {
    logger.info('Forcing refresh of all options chains...');
    this.clearCache();
    await this.pollChains();
  }
}

export default OptionsChainManager;