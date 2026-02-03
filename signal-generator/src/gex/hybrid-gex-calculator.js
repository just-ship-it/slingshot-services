// Hybrid GEX Calculator - Combines Tradier (fast, short-term) + CBOE (comprehensive, long-term)
import { createLogger } from '../../../shared/index.js';
import GexCalculator from './gex-calculator.js';
import TradierExposureService from '../tradier/tradier-exposure-service.js';
import { isOptionsRTH, isOptionsRTHCached, getCurrentSession, tradierMarketClock } from '../utils/session-utils.js';

const logger = createLogger('hybrid-gex-calculator');

class HybridGexCalculator {
  constructor(options = {}) {
    this.options = {
      // Tradier configuration (fast, actionable data)
      tradierEnabled: options.tradierEnabled ?? true,
      tradierRefreshMinutes: options.tradierRefreshMinutes ?? 3,
      tradierMaxExpirations: options.tradierMaxExpirations ?? 6, // 0-30 DTE

      // CBOE configuration (comprehensive data)
      cboeEnabled: options.cboeEnabled ?? true,
      cboeRefreshMinutes: options.cboeRefreshMinutes ?? 15,

      // Hybrid logic
      preferTradierWhenFresh: options.preferTradierWhenFresh ?? true,
      tradierFreshnessMinutes: options.tradierFreshnessMinutes ?? 5,

      // Fallback behavior
      fallbackToCBOE: options.fallbackToCBOE ?? true,
      fallbackToTradier: options.fallbackToTradier ?? true,

      ...options
    };

    // Initialize both calculators
    this.cboeCalculator = new GexCalculator(options.cboe || {});
    this.tradierService = options.tradierService || null;

    // Current data cache
    this.currentData = {
      tradier: { data: null, timestamp: 0, source: 'tradier' },
      cboe: { data: null, timestamp: 0, source: 'cboe' },
      hybrid: { data: null, timestamp: 0, source: 'hybrid' }
    };

    // RTH cache - stores last levels from Regular Trading Hours
    // Used to freeze GEX levels during off-hours when options don't trade
    this.rthCache = {
      levels: null,
      timestamp: null,
      source: null
    };

    // Refresh timers
    this.refreshTimers = {
      tradier: null,
      cboe: null
    };

    logger.info('Hybrid GEX calculator initialized', {
      tradierEnabled: this.options.tradierEnabled,
      cboeEnabled: this.options.cboeEnabled,
      tradierRefresh: this.options.tradierRefreshMinutes,
      cboeRefresh: this.options.cboeRefreshMinutes
    });
  }

  /**
   * Initialize the hybrid calculator
   */
  async initialize() {
    if (this.options.tradierEnabled && this.tradierService) {
      logger.info('Initializing Tradier service for hybrid calculator');
      // Tradier service should already be initialized by the main service

      // Pass Tradier's ratio to CBOE as a fallback for off-hours
      this.updateCBOEFallbackRatio();
    }

    if (this.options.cboeEnabled) {
      logger.info('CBOE calculator ready for hybrid mode');
    }

    // Start refresh timers
    this.startRefreshTimers();
  }

  /**
   * Update CBOE calculator's fallback ratio from Tradier
   * This ensures CBOE has a stable ratio during off-hours when it can't calculate its own
   */
  updateCBOEFallbackRatio() {
    if (!this.tradierService || !this.cboeCalculator) {
      return;
    }

    try {
      const tradierRatio = this.tradierService.getNQRatio();

      if (tradierRatio && tradierRatio.multiplier) {
        this.cboeCalculator.setFallbackRatio(
          tradierRatio.multiplier,
          tradierRatio.source,
          tradierRatio.timestamp
        );
        logger.debug(`Updated CBOE fallback ratio from Tradier: ${tradierRatio.multiplier.toFixed(4)} (${tradierRatio.source})`);
      }
    } catch (error) {
      logger.warn('Failed to update CBOE fallback ratio:', error.message);
    }
  }

  /**
   * Start automatic refresh timers
   */
  startRefreshTimers() {
    if (this.options.tradierEnabled && this.tradierService) {
      this.refreshTimers.tradier = setInterval(async () => {
        try {
          await this.refreshTradierData();
        } catch (error) {
          logger.error('Tradier refresh failed:', error.message);
        }
      }, this.options.tradierRefreshMinutes * 60 * 1000);

      // Initial fetch
      this.refreshTradierData().catch(error => {
        logger.error('Initial Tradier fetch failed:', error.message);
      });
    }

    if (this.options.cboeEnabled) {
      this.refreshTimers.cboe = setInterval(async () => {
        try {
          await this.refreshCBOEData();
        } catch (error) {
          logger.error('CBOE refresh failed:', error.message);
        }
      }, this.options.cboeRefreshMinutes * 60 * 1000);

      // Initial fetch with delay to avoid overwhelming APIs
      setTimeout(() => {
        this.refreshCBOEData().catch(error => {
          logger.error('Initial CBOE fetch failed:', error.message);
        });
      }, 5000);
    }
  }

  /**
   * Stop refresh timers
   */
  stopRefreshTimers() {
    Object.values(this.refreshTimers).forEach(timer => {
      if (timer) clearInterval(timer);
    });
    this.refreshTimers = { tradier: null, cboe: null };
  }

  /**
   * Refresh Tradier data
   * Skips refresh during off-hours (including holidays) since options data doesn't change
   * Uses Tradier market clock API for holiday awareness
   */
  async refreshTradierData() {
    if (!this.options.tradierEnabled || !this.tradierService) {
      return null;
    }

    // Use Tradier-aware RTH check (handles holidays)
    const inRTH = await isOptionsRTH();
    const session = getCurrentSession();
    const marketDesc = tradierMarketClock.getDescription();

    // Skip refresh during off-hours (or holidays) - options data is static
    if (!inRTH) {
      const reason = marketDesc || session;
      if (this.rthCache.levels) {
        logger.debug(`Options market closed (${reason}) - skipping Tradier refresh, using cached levels from ${this.rthCache.timestamp}`);
        return this.currentData.tradier.data;
      }
      logger.debug(`Options market closed (${reason}) - no cached levels available, will attempt refresh`);
    }

    try {
      logger.debug('Refreshing Tradier GEX data...');
      const exposures = await this.tradierService.calculateExposures(true);

      if (exposures && exposures.futures.NQ) {
        const tradierData = this.convertTradierToGexFormat(exposures.futures.NQ, exposures.timestamp);

        this.currentData.tradier = {
          data: tradierData,
          timestamp: Date.now(),
          source: 'tradier',
          dataTimestamp: exposures.timestamp
        };

        // Cache levels during RTH for use during off-hours
        if (inRTH) {
          this.cacheRTHLevels(tradierData, 'tradier');
        }

        // Update CBOE's fallback ratio from Tradier
        this.updateCBOEFallbackRatio();

        logger.debug('Tradier GEX data refreshed successfully' + (inRTH ? ' (RTH - cached)' : ''));
        this.updateHybridData();
        return tradierData;
      }

      return null;
    } catch (error) {
      logger.warn('Failed to refresh Tradier data:', error.message);
      return null;
    }
  }

  /**
   * Refresh CBOE data
   * Skips refresh during off-hours (including holidays) since options data doesn't change
   * Uses Tradier market clock API for holiday awareness
   */
  async refreshCBOEData() {
    if (!this.options.cboeEnabled) {
      return null;
    }

    // Use Tradier-aware RTH check (handles holidays)
    const inRTH = await isOptionsRTH();
    const session = getCurrentSession();
    const marketDesc = tradierMarketClock.getDescription();

    // Skip refresh during off-hours (or holidays) - options data is static
    if (!inRTH) {
      const reason = marketDesc || session;
      if (this.rthCache.levels) {
        logger.debug(`Options market closed (${reason}) - skipping CBOE refresh, using cached levels from ${this.rthCache.timestamp}`);
        return this.currentData.cboe.data;
      }
      logger.debug(`Options market closed (${reason}) - no cached levels available, will attempt refresh`);
    }

    try {
      logger.debug('Refreshing CBOE GEX data...');
      const cboeData = await this.cboeCalculator.calculateLevels(true);

      if (cboeData) {
        this.currentData.cboe = {
          data: cboeData,
          timestamp: Date.now(),
          source: 'cboe',
          dataTimestamp: cboeData.timestamp
        };

        // Cache levels during RTH for use during off-hours
        if (inRTH) {
          this.cacheRTHLevels(cboeData, 'cboe');
        }

        logger.debug('CBOE GEX data refreshed successfully' + (inRTH ? ' (RTH - cached)' : ''));
        this.updateHybridData();
        return cboeData;
      }

      return null;
    } catch (error) {
      logger.warn('Failed to refresh CBOE data:', error.message);
      return null;
    }
  }

  /**
   * Cache RTH levels for use during off-hours
   */
  cacheRTHLevels(levels, source) {
    this.rthCache = {
      levels: { ...levels },
      timestamp: new Date().toISOString(),
      source
    };
    logger.info(`Cached RTH GEX levels from ${source} for off-hours use`, {
      support1: levels.support?.[0],
      resistance1: levels.resistance?.[0],
      gammaFlip: levels.gammaFlip
    });
  }

  /**
   * Convert Tradier exposure data to GEX format for compatibility
   */
  convertTradierToGexFormat(nqData, timestamp) {
    return {
      timestamp,
      nqSpot: nqData.futuresPrice,
      qqqSpot: nqData.originalSpotPrice,
      totalGex: nqData.totals.gex / 1e9, // Convert to billions
      regime: nqData.regime.gex,
      gammaFlip: nqData.levels.gammaFlip,
      callWall: nqData.levels.callWall,
      putWall: nqData.levels.putWall,
      resistance: nqData.levels.resistance,
      support: nqData.levels.support,
      fromCache: false,
      usedLivePrices: true,
      dataSource: 'tradier',

      // Additional Tradier-specific data
      totalVex: nqData.totals.vex / 1e9,
      totalCex: nqData.totals.cex / 1e9,
      overallRegime: nqData.regime.overall,
      vexRegime: nqData.regime.vex,
      cexRegime: nqData.regime.cex
    };
  }

  /**
   * Update hybrid data by intelligently combining sources
   */
  updateHybridData() {
    const now = Date.now();
    const tradierAge = this.currentData.tradier.timestamp ? now - this.currentData.tradier.timestamp : Infinity;
    const cboeAge = this.currentData.cboe.timestamp ? now - this.currentData.cboe.timestamp : Infinity;

    const tradierFresh = tradierAge < (this.options.tradierFreshnessMinutes * 60 * 1000);
    const tradierAvailable = this.currentData.tradier.data !== null;
    const cboeAvailable = this.currentData.cboe.data !== null;

    let hybridData = null;
    let primarySource = null;
    let secondarySource = null;

    // Decision logic for hybrid data
    if (this.options.preferTradierWhenFresh && tradierFresh && tradierAvailable) {
      // Use fresh Tradier data as primary
      hybridData = { ...this.currentData.tradier.data };
      primarySource = 'tradier';

      // Enhance with CBOE data if available
      if (cboeAvailable) {
        secondarySource = 'cboe';
        hybridData = this.enhanceWithCBOE(hybridData, this.currentData.cboe.data);
      }
    } else if (cboeAvailable) {
      // Use CBOE as primary
      hybridData = { ...this.currentData.cboe.data };
      primarySource = 'cboe';

      // Enhance with Tradier live prices if available
      if (tradierAvailable) {
        secondarySource = 'tradier';
        hybridData = this.enhanceWithTradier(hybridData, this.currentData.tradier.data);
      }
    } else if (tradierAvailable && this.options.fallbackToTradier) {
      // Fallback to stale Tradier data
      hybridData = { ...this.currentData.tradier.data };
      primarySource = 'tradier';
    }

    if (hybridData) {
      // Mark as hybrid data
      hybridData.dataSource = 'hybrid';
      hybridData.primarySource = primarySource;
      hybridData.secondarySource = secondarySource;
      hybridData.hybridTimestamp = new Date().toISOString();
      hybridData.freshness = {
        tradier: tradierFresh,
        tradierAge: Math.round(tradierAge / 1000),
        cboeAge: Math.round(cboeAge / 1000)
      };

      this.currentData.hybrid = {
        data: hybridData,
        timestamp: now,
        source: 'hybrid'
      };

      // Cache hybrid levels during RTH for off-hours use (uses cached Tradier state)
      if (isOptionsRTHCached()) {
        this.cacheRTHLevels(hybridData, 'hybrid');
      }

      logger.debug('Hybrid GEX data updated', {
        primary: primarySource,
        secondary: secondarySource,
        tradierFresh,
        tradierAge: Math.round(tradierAge / 1000),
        cboeAge: Math.round(cboeAge / 1000)
      });
    }

    return hybridData;
  }

  /**
   * Enhance Tradier data with CBOE comprehensive data
   * IMPORTANT: Keep Tradier's support/resistance as primary (they're fresher and more actionable)
   * Store CBOE levels separately for reference/comparison
   */
  enhanceWithCBOE(tradierData, cboeData) {
    return {
      ...tradierData,

      // Keep Tradier's live/fast data for core metrics (including support/resistance)
      totalGex: tradierData.totalGex,
      gammaFlip: tradierData.gammaFlip,
      callWall: tradierData.callWall,
      putWall: tradierData.putWall,
      resistance: tradierData.resistance,  // Use Tradier's levels as primary
      support: tradierData.support,         // Use Tradier's levels as primary

      // Store CBOE data separately for broader market context/comparison
      cboeGex: cboeData.totalGex,
      cboeRegime: cboeData.regime,
      cboeGammaFlip: cboeData.gammaFlip,
      cboeCallWall: cboeData.callWall,
      cboePutWall: cboeData.putWall,
      cboeResistance: cboeData.resistance,  // CBOE levels for reference
      cboeSupport: cboeData.support,        // CBOE levels for reference

      enhancement: 'cboe'
    };
  }

  /**
   * Enhance CBOE data with Tradier live prices
   */
  enhanceWithTradier(cboeData, tradierData) {
    return {
      ...cboeData,

      // Use live Tradier prices
      nqSpot: tradierData.nqSpot,
      qqqSpot: tradierData.qqqSpot,
      usedLivePrices: true,

      // Add Tradier's additional exposure metrics
      totalVex: tradierData.totalVex,
      totalCex: tradierData.totalCex,
      overallRegime: tradierData.overallRegime,
      vexRegime: tradierData.vexRegime,
      cexRegime: tradierData.cexRegime,

      // Keep CBOE's comprehensive levels but note live prices
      enhancement: 'tradier'
    };
  }

  /**
   * Intelligently combine resistance levels from both sources
   */
  combineResistanceLevels(tradierLevels, cboeLevels) {
    const combined = [...(tradierLevels || []), ...(cboeLevels || [])]
      .filter((level, index, arr) => arr.indexOf(level) === index) // Remove duplicates
      .sort((a, b) => a - b);

    // Return top 5 unique levels
    return combined.slice(0, 5);
  }

  /**
   * Intelligently combine support levels from both sources
   */
  combineSupportLevels(tradierLevels, cboeLevels) {
    const combined = [...(tradierLevels || []), ...(cboeLevels || [])]
      .filter((level, index, arr) => arr.indexOf(level) === index) // Remove duplicates
      .sort((a, b) => b - a); // Descending for support

    // Return top 5 unique levels
    return combined.slice(0, 5);
  }

  /**
   * Get current hybrid GEX levels
   * Returns cached RTH levels during off-hours (including holidays) to prevent artificial drift
   */
  getCurrentLevels() {
    // Use cached Tradier state for sync method (handles holidays)
    const inRTH = isOptionsRTHCached();
    const session = getCurrentSession();
    const marketDesc = tradierMarketClock.getDescription();

    // During off-hours or holidays, prefer cached RTH levels to prevent drift
    if (!inRTH && this.rthCache.levels) {
      const cachedLevels = {
        ...this.rthCache.levels,
        fromRTHCache: true,
        rthCacheTimestamp: this.rthCache.timestamp,
        rthCacheSource: this.rthCache.source,
        currentSession: session,
        marketDescription: marketDesc
      };
      return cachedLevels;
    }

    if (this.currentData.hybrid.data) {
      return {
        ...this.currentData.hybrid.data,
        fromRTHCache: false,
        currentSession: session
      };
    }

    // Fallback logic
    if (this.currentData.tradier.data && this.options.fallbackToTradier) {
      return {
        ...this.currentData.tradier.data,
        fromRTHCache: false,
        currentSession: session
      };
    }

    if (this.currentData.cboe.data && this.options.fallbackToCBOE) {
      return {
        ...this.currentData.cboe.data,
        fromRTHCache: false,
        currentSession: session
      };
    }

    return null;
  }

  /**
   * Force refresh of all data sources
   * Note: During off-hours (including holidays), refresh is skipped and cached RTH levels are returned
   */
  async calculateLevels(force = false) {
    // Use Tradier-aware RTH check (handles holidays)
    const inRTH = await isOptionsRTH();
    const session = getCurrentSession();
    const marketDesc = tradierMarketClock.getDescription();

    if (force) {
      if (!inRTH && this.rthCache.levels) {
        const reason = marketDesc || session;
        logger.info(`Force refresh requested while options market closed (${reason}) - returning cached levels from ${this.rthCache.timestamp}`);
      } else {
        logger.info('Force refreshing all GEX data sources...');

        const [tradierData, cboeData] = await Promise.allSettled([
          this.refreshTradierData(),
          this.refreshCBOEData()
        ]);

        if (tradierData.status === 'rejected') {
          logger.warn('Tradier force refresh failed:', tradierData.reason?.message);
        }

        if (cboeData.status === 'rejected') {
          logger.warn('CBOE force refresh failed:', cboeData.reason?.message);
        }

        this.updateHybridData();
      }
    }

    return this.getCurrentLevels();
  }

  /**
   * Get health status of both data sources
   */
  getHealthStatus() {
    const now = Date.now();
    // Use cached Tradier state for sync method (handles holidays)
    const inRTH = isOptionsRTHCached();
    const session = getCurrentSession();
    const marketDesc = tradierMarketClock.getDescription();

    return {
      session: {
        isOptionsOpen: inRTH,
        current: session,
        marketDescription: marketDesc,
        usingRTHCache: !inRTH && !!this.rthCache.levels
      },
      rthCache: {
        hasData: !!this.rthCache.levels,
        timestamp: this.rthCache.timestamp,
        source: this.rthCache.source,
        support1: this.rthCache.levels?.support?.[0],
        resistance1: this.rthCache.levels?.resistance?.[0]
      },
      hybrid: {
        enabled: true,
        lastUpdate: this.currentData.hybrid.timestamp,
        hasData: !!this.currentData.hybrid.data,
        primarySource: this.currentData.hybrid.data?.primarySource,
        secondarySource: this.currentData.hybrid.data?.secondarySource
      },
      tradier: {
        enabled: this.options.tradierEnabled,
        lastUpdate: this.currentData.tradier.timestamp,
        hasData: !!this.currentData.tradier.data,
        ageMinutes: this.currentData.tradier.timestamp ?
          Math.round((now - this.currentData.tradier.timestamp) / 60000) : null,
        refreshInterval: this.options.tradierRefreshMinutes
      },
      cboe: {
        enabled: this.options.cboeEnabled,
        lastUpdate: this.currentData.cboe.timestamp,
        hasData: !!this.currentData.cboe.data,
        ageMinutes: this.currentData.cboe.timestamp ?
          Math.round((now - this.currentData.cboe.timestamp) / 60000) : null,
        refreshInterval: this.options.cboeRefreshMinutes
      }
    };
  }

  /**
   * Set update callback for when hybrid data changes
   */
  setUpdateCallback(callback) {
    this.updateCallback = callback;

    // Also set callbacks on individual calculators
    if (this.cboeCalculator) {
      this.cboeCalculator.setUpdateCallback(() => {
        this.refreshCBOEData();
      });
    }
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this.stopRefreshTimers();
  }
}

export default HybridGexCalculator;