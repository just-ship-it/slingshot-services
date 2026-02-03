/**
 * Backtesting Engine
 *
 * Main orchestrator for running backtests
 * Coordinates data loading, strategy execution, and result generation
 */

import fs from 'fs';
import path from 'path';
import { CSVLoader, SecondDataProvider } from './data/csv-loader.js';
import { CandleAggregator } from './data/candle-aggregator.js';
import { TradeSimulator } from './execution/trade-simulator.js';
import { PerformanceCalculator } from './analytics/performance-calculator.js';
import { LTLevelAnalyzer } from './analytics/lt-level-analyzer.js';
import { ConsoleReporter } from './reporting/console-reporter.js';
import { GexRecoilStrategy } from '../../shared/strategies/gex-recoil.js';
import { GexRecoilEnhancedStrategy } from '../../shared/strategies/gex-recoil-enhanced.js';
import { GexLdpmConfluenceStrategy } from '../../shared/strategies/gex-ldpm-confluence.js';
import { GexLdpmConfluencePullbackStrategy } from '../../shared/strategies/gex-ldpm-confluence-pullback.js';
import { ContrarianBounceStrategy } from '../../shared/strategies/contrarian-bounce.js';
import { GexScalpStrategy } from '../../shared/strategies/gex-scalp.js';
import { GexScalpConfirmedStrategy } from '../../shared/strategies/gex-scalp-confirmed.js';
import { ICTSMCStrategy } from '../../shared/strategies/ict-smc-strategy.js';
import { ICTOBStrategy } from '../../shared/strategies/ict-ob-strategy.js';
import { LdpmLevelSweepStrategy } from '../../shared/strategies/ldpm-level-sweep/index.js';
import { OrderFlowMomentumStrategy } from '../../shared/strategies/order-flow-momentum.js';
import { ContrarianOrderFlowStrategy } from '../../shared/strategies/contrarian-orderflow.js';
import { GexAbsorptionStrategy } from '../../shared/strategies/gex-absorption.js';
import { IVSkewGexStrategy } from '../../shared/strategies/iv-skew-gex.js';
import { CBBOLTVolatilityStrategy } from '../../shared/strategies/cbbo-lt-volatility.js';
import { GexMeanReversionStrategy } from '../strategies/gex-mean-reversion/strategy.js';
import { LTFailedBreakdownStrategy } from '../../shared/strategies/lt-failed-breakdown.js';
import { LTLevelCrossingStrategy } from '../../shared/strategies/lt-level-crossing.js';
import { LTLevelMigrationStrategy } from '../../shared/strategies/lt-level-migration.js';
import { RegimeScalpStrategy } from '../../shared/strategies/regime-scalp.js';
import { GexLevelSweepStrategy } from '../../shared/strategies/gex-level-sweep.js';
import { MicroStructureScalperStrategy } from '../../shared/strategies/micro-structure-scalper.js';
import { TrendScalpStrategy } from '../../shared/strategies/trend-scalp.js';
import { LevelBounceStrategy } from '../../shared/strategies/level-bounce.js';
import { SqueezeMomentumIndicator } from '../../shared/indicators/squeeze-momentum.js';
import { GexLoader } from './data-loaders/gex-loader.js';
import { IVLoader } from './data-loaders/iv-loader.js';
import { CBBOLoader } from './data-loaders/cbbo-loader.js';
import { DatabentoTradeLoader } from './data/databento-loader.js';
import { MBPLoader } from './data/mbp-loader.js';

export class BacktestEngine {
  constructor(config) {
    this.config = config;

    // Load default configuration
    const defaultConfigPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'config', 'default.json');
    this.defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

    // Initialize components
    this.csvLoader = new CSVLoader(config.dataDir, this.defaultConfig);
    this.aggregator = new CandleAggregator();
    this.tradeSimulator = new TradeSimulator({
      commission: config.commission,
      slippage: this.defaultConfig.backtesting.slippage,
      contractSpecs: this.defaultConfig.contracts,
      forceCloseAtMarketClose: this.defaultConfig.backtesting.forceCloseAtMarketClose,
      marketCloseTimeUTC: this.defaultConfig.backtesting.marketCloseTimeUTC,
      verbose: config.verbose,
      debugMode: config.debugMode,
      // Hybrid trailing stop configuration
      hybridTrailing: config.strategyParams?.hybridTrailing ? {
        enabled: true,
        structureThreshold: config.strategyParams.structureThreshold || 30,
        swingLookback: config.strategyParams.swingLookback || 5,
        swingBuffer: config.strategyParams.swingBuffer || 5,
        minSwingSize: config.strategyParams.minSwingSize || 3
      } : { enabled: false },
      // Time-based trailing stop configuration (progressive profit protection)
      timeBasedTrailing: config.strategyParams?.timeBasedTrailing ? {
        enabled: true,
        rules: config.strategyParams.timeBasedTrailingConfig?.rules || [
          // Default rules based on correlation analysis:
          // - 68% of losers that were profitable peaked in first 15 bars
          // - Breakeven after 15 bars if +20pts adds +$38,973 to P&L
          { afterBars: 15, ifMFE: 20, action: 'breakeven' },
          { afterBars: 30, ifMFE: 30, trailDistance: 20 },
          { afterBars: 45, ifMFE: 40, trailDistance: 10 },
        ]
      } : { enabled: false }
    });
    this.performanceCalculator = new PerformanceCalculator(
      config.initialCapital,
      this.defaultConfig.backtesting.riskFreeRate
    );
    this.consoleReporter = new ConsoleReporter({
      precision: this.defaultConfig.output.console.precision,
      showTrades: config.showTrades,
      showSummary: this.defaultConfig.output.console.showSummary
    });

    // Initialize GEX loader for 15-minute interval JSON files
    this.gexLoader = new GexLoader(path.join(config.dataDir, 'gex'), config.ticker);

    // 1-second data provider for accurate trade execution (initialized in loadData)
    this.secondDataProvider = null;
    this.useSecondResolution = config.useSecondResolution !== false; // Default to true

    // Initialize Databento trade loader for CVD calculation (Phase 3 Order Flow)
    const tickerLower = config.ticker.toLowerCase().substring(0, 2);
    const orderflowDir = path.join(config.dataDir, 'orderflow', tickerLower);
    this.databentoLoader = new DatabentoTradeLoader({
      dataDir: fs.existsSync(path.join(orderflowDir, 'trades'))
        ? path.join(orderflowDir, 'trades')
        : path.join(config.dataDir, 'orderflow', 'trades'),
      symbolFilter: config.ticker.toUpperCase().substring(0, 2) // 'NQ' from 'NQ' or 'NQH5'
    });
    this.cvdMap = null; // Will be populated in loadData if trade data exists

    // Initialize MBP loader for book imbalance calculation (Phase 4 Order Flow)
    this.mbpLoader = new MBPLoader({
      dataDir: fs.existsSync(path.join(orderflowDir, 'mbp-1'))
        ? path.join(orderflowDir, 'mbp-1')
        : path.join(config.dataDir, 'orderflow', 'mbp-1'),
      symbolFilter: config.ticker.toUpperCase().substring(0, 2)
    });
    this.bookImbalanceMap = null; // Will be populated in loadData if MBP data exists

    // Initialize IV loader for IV Skew GEX strategy
    this.ivLoader = new IVLoader(config.dataDir);
    this.ivData = null; // Will be populated in loadData if IV data exists

    // Initialize CBBO loader for CBBO-LT Volatility strategy
    const cbboDir = config.cbboDataDir || path.join(config.dataDir, 'cbbo-1m', 'qqq');
    this.cbboLoader = new CBBOLoader(cbboDir);
    this.cbboDataLoaded = false;

    // Initialize strategy
    this.strategy = this.createStrategy(config.strategy, config.strategyParams);

    // Initialize squeeze momentum indicator if strategy needs it
    this.squeezeIndicator = null;
    this.previousMomentum = null;
  }

  /**
   * Run the complete backtest
   *
   * @returns {Object} Backtest results
   */
  async run() {
    const startTime = Date.now();

    try {
      // Validate configuration
      this.validateConfiguration();

      // Load data
      const data = await this.loadData();

      // Run backtest simulation
      const simulation = await this.runSimulation(data);

      // Record trades to strategy's performance tracker (for adaptive mode)
      if (simulation.strategy && typeof simulation.strategy.recordTradeResult === 'function') {
        for (const trade of simulation.trades) {
          simulation.strategy.recordTradeResult({
            levelName: trade.metadata?.level_name,
            session: trade.metadata?.session || this.getSessionFromTimestamp(trade.entryTime),
            pnl: trade.netPnL,
            entryPrice: trade.actualEntry || trade.entryPrice,
            exitPrice: trade.actualExit,
            side: trade.side,
            timestamp: trade.entryTime,
            entryTime: trade.entryTime,
            exitTime: trade.exitTime,
            metadata: trade.metadata,
          });
        }
      }

      // Calculate performance metrics
      const performance = this.calculatePerformance(simulation, data);

      // Generate results object
      const results = {
        config: this.config,
        data: {
          candleCount: data.candles.length,
          gexLevelCount: data.gexLevels.length,
          liquidityLevelCount: data.liquidityLevels.length
        },
        trades: simulation.trades,
        performance: performance,
        simulation: {
          totalSignals: simulation.signals.length,
          rejectedSignals: simulation.rejectedSignals.length,
          executedTrades: simulation.trades.length,
          activeTrades: simulation.activeTrades.length
        },
        ltAnalysis: simulation.ltAnalysis,
        executionTimeMs: Date.now() - startTime
      };

      // Display results if not quiet
      if (!this.config.quiet) {
        this.consoleReporter.displayResults(results, this.config);
      }

      return results;

    } catch (error) {
      if (!this.config.quiet) {
        this.consoleReporter.displayError('Backtest execution failed', error);
      }
      throw error;
    }
  }

  /**
   * Validate backtesting configuration
   */
  validateConfiguration() {
    const errors = [];

    // Validate dates
    if (this.config.startDate >= this.config.endDate) {
      errors.push('Start date must be before end date');
    }

    // Validate timeframe
    if (!this.aggregator.isValidTimeframe(this.config.timeframe)) {
      errors.push(`Invalid timeframe: ${this.config.timeframe}`);
    }

    // Validate data directory
    const validation = this.csvLoader.validateDataDirectory();
    if (!validation.valid) {
      errors.push(...validation.errors);
    }

    // Display warnings
    if (validation.warnings.length > 0 && !this.config.quiet) {
      validation.warnings.forEach(warning => {
        this.consoleReporter.displayWarning(warning);
      });
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
  }

  /**
   * Load and prepare all data
   *
   * @returns {Object} Loaded and processed data
   */
  async loadData() {
    if (!this.config.quiet) {
      console.log('🔄 Loading and processing data...');
    }

    // Load raw OHLCV and liquidity data
    const [ohlcvResult, liquidityData] = await Promise.all([
      this.csvLoader.loadOHLCVData(this.config.ticker, this.config.startDate, this.config.endDate),
      this.csvLoader.loadLiquidityData(this.config.ticker, this.config.startDate, this.config.endDate)
    ]);

    // Load GEX data from 15-minute interval JSON files
    const gexLoaded = await this.gexLoader.loadDateRange(this.config.startDate, this.config.endDate);

    // Fall back to CSV if no JSON files found
    let gexData = [];
    if (!gexLoaded || this.gexLoader.sortedTimestamps.length === 0) {
      if (!this.config.quiet) {
        console.log('⚠️  No GEX JSON files found, falling back to CSV loader...');
      }
      gexData = await this.csvLoader.loadGEXData(this.config.ticker, this.config.startDate, this.config.endDate);
    } else {
      // For compatibility, populate gexData array from loader
      const gexRange = this.gexLoader.getDataRange();
      if (!this.config.quiet) {
        console.log(`📊 Loaded GEX data: ${gexRange.totalRecords} 15-min snapshots (${gexRange.start?.toISOString().split('T')[0]} to ${gexRange.end?.toISOString().split('T')[0]})`);
      }
      gexData = Array.from(this.gexLoader.loadedData.values());
    }

    // Extract candles and calendar spreads from the OHLCV result
    const ohlcvData = ohlcvResult.candles;
    const calendarSpreads = ohlcvResult.calendarSpreads;

    // Initialize 1-second data provider if available and enabled
    if (this.useSecondResolution) {
      const tickerLower = this.config.ticker.toLowerCase();
      const tickerUpper = this.config.ticker.toUpperCase();

      // Check multiple path patterns (subdirectory structure and legacy flat structure)
      const secondFilePaths = [
        path.join(this.config.dataDir, 'ohlcv', tickerLower, `${tickerUpper}_ohlcv_1s.csv`),
        path.join(this.config.dataDir, 'ohlcv', `${tickerUpper}_ohlcv_1s.csv`),
      ];

      const secondFilePath = secondFilePaths.find(p => fs.existsSync(p));

      if (secondFilePath) {
        if (!this.config.quiet) {
          console.log(`🔬 Initializing 1-second data provider for accurate trade execution...`);
        }
        this.secondDataProvider = new SecondDataProvider(secondFilePath);
        await this.secondDataProvider.initialize();
      } else {
        if (!this.config.quiet) {
          console.log('⚠️  No 1-second data file found, using 1-minute resolution for exits');
        }
      }
    }

    // Load Databento trade data for CVD calculation (Phase 3 Order Flow)
    // Also load for order-flow-momentum and contrarian-orderflow strategies which use CVD as primary signal
    const isOrderFlowStrategy = this.config.strategy === 'order-flow-momentum' ||
                                this.config.strategy === 'ofm' ||
                                this.config.strategy === 'contrarian-orderflow' ||
                                this.config.strategy === 'cof' ||
                                this.config.strategy === 'gex-absorption' ||
                                this.config.strategy === 'absorption';
    const cvdFilterEnabled = this.config.strategyParams?.cvdDirectionFilter ||
                             this.config.strategyParams?.cvdDivergenceFilter ||
                             this.config.strategyParams?.cvdZeroCrossFilter ||
                             isOrderFlowStrategy;
    if (cvdFilterEnabled) {
      const tradeFiles = this.databentoLoader.getAvailableFiles();
      if (tradeFiles.length > 0) {
        if (!this.config.quiet) {
          console.log(`📊 Computing CVD from Databento trade data (${tradeFiles.length} files available)...`);
        }

        // Use streaming method for memory efficiency
        let lastProgressLog = Date.now();
        const progressCallback = (daysProcessed, totalTrades) => {
          if (!this.config.quiet && Date.now() - lastProgressLog > 2000) {
            process.stdout.write(`\r   Processing day ${daysProcessed}... ${totalTrades.toLocaleString()} trades`);
            lastProgressLog = Date.now();
          }
        };

        this.cvdMap = await this.databentoLoader.computeCVDForCandlesStreaming(
          this.config.startDate,
          this.config.endDate,
          ohlcvData,
          progressCallback
        );

        if (!this.config.quiet) {
          process.stdout.write('\r' + ' '.repeat(80) + '\r'); // Clear progress line
          console.log(`✅ CVD computed for ${this.cvdMap.size.toLocaleString()} candles`);
        }
      } else if (!this.config.quiet) {
        console.log('⚠️  No Databento trade files found - CVD filters will be skipped');
      }
    }

    // Load MBP-1 data for book imbalance calculation (Phase 4 Order Flow)
    // Also load for order-flow-momentum strategy which uses book imbalance as confirmation
    const bookImbalanceFilterEnabled = this.config.strategyParams?.bookImbalanceFilter ||
                                        this.config.strategyParams?.bookImbalanceMomentumFilter ||
                                        this.config.strategyParams?.bookImbalanceBlockContrary ||
                                        isOrderFlowStrategy;
    if (bookImbalanceFilterEnabled) {
      // Try precomputed data first (instant loading)
      const precomputedPath = this.mbpLoader.getPrecomputedFilePath();

      if (precomputedPath) {
        // Use precomputed data - instant loading
        await this.mbpLoader.loadPrecomputedData();
        this.bookImbalanceMap = this.mbpLoader.getPrecomputedImbalanceForCandles(ohlcvData);

        if (!this.config.quiet) {
          const withData = [...this.bookImbalanceMap.values()].filter(d => d.updates > 0).length;
          console.log(`✅ Book imbalance loaded for ${withData.toLocaleString()} candles (precomputed)`);
        }
      } else {
        // Fall back to raw MBP-1 processing (slow)
        const mbpFiles = this.mbpLoader.getAvailableFiles();
        if (mbpFiles.length > 0) {
          if (!this.config.quiet) {
            console.log(`📊 Computing book imbalance from MBP-1 data (${mbpFiles.length} files available)...`);
            console.log(`   ⚠️  Run 'node precompute-book-imbalance.js' to speed up future backtests`);
          }

          let lastProgressLog = Date.now();
          const progressCallback = (daysProcessed, totalUpdates) => {
            if (!this.config.quiet && Date.now() - lastProgressLog > 2000) {
              process.stdout.write(`\r   Processing day ${daysProcessed}... ${totalUpdates.toLocaleString()} updates`);
              lastProgressLog = Date.now();
            }
          };

          this.bookImbalanceMap = await this.mbpLoader.computeImbalanceForDateRange(
            this.config.startDate,
            this.config.endDate,
            ohlcvData,
            progressCallback
          );

          if (!this.config.quiet) {
            process.stdout.write('\r' + ' '.repeat(80) + '\r'); // Clear progress line
            const withData = [...this.bookImbalanceMap.values()].filter(d => d.updates > 0).length;
            console.log(`✅ Book imbalance computed for ${withData.toLocaleString()} candles`);
          }
        } else if (!this.config.quiet) {
          console.log('⚠️  No MBP-1 files found - book imbalance filters will be skipped');
        }
      }
    }

    // Aggregate candles to target timeframe for strategy evaluation
    const aggregatedCandles = this.aggregator.aggregate(ohlcvData, this.config.timeframe);

    // Generate 15-minute candles for FVG detection (if strategy uses FVG entries)
    let fvgCandles = null;
    if (this.strategy && this.strategy.params && this.strategy.params.useFVGEntries) {
      fvgCandles = this.aggregator.aggregate(ohlcvData, '15m');

      if (!this.config.quiet) {
        console.log(`📈 Generated ${fvgCandles.length} 15m candles for FVG detection`);
      }
    }

    // Create market data lookup for efficient access (for legacy compatibility)
    const marketDataLookup = this.createMarketDataLookup(gexData, liquidityData);

    // Load IV data for IV Skew GEX strategy
    const isIVSkewStrategy = this.config.strategy === 'iv-skew-gex' || this.config.strategy === 'iv-skew';
    if (isIVSkewStrategy) {
      await this.ivLoader.load(this.config.startDate, this.config.endDate);
      const ivStats = this.ivLoader.getStats();
      if (!this.config.quiet && ivStats.count > 0) {
        console.log(`📈 IV data: ${ivStats.count} records (${ivStats.startDate?.split('T')[0]} to ${ivStats.endDate?.split('T')[0]})`);
        console.log(`   Avg IV: ${ivStats.avgIV?.toFixed(3)} | Avg Skew: ${ivStats.avgSkew?.toFixed(4)}`);
      } else if (!this.config.quiet && ivStats.count === 0) {
        console.warn('⚠️  No IV data found for date range - IV Skew strategy will have no signals');
      }
    }

    // Load CBBO data for CBBO-LT Volatility strategy
    const isCBBOStrategy = this.config.strategy === 'cbbo-lt-volatility' ||
                           this.config.strategy === 'cbbo-lt' ||
                           this.config.useCBBO;
    if (isCBBOStrategy) {
      const cbboAvailable = this.cbboLoader.getAvailableFiles();
      if (cbboAvailable.length > 0) {
        if (!this.config.quiet) {
          console.log(`📊 Loading CBBO data for volatility analysis (${cbboAvailable.length} files available)...`);
        }

        let lastProgressLog = Date.now();
        const progressCallback = (daysProcessed, totalMinutes) => {
          if (!this.config.quiet && Date.now() - lastProgressLog > 2000) {
            process.stdout.write(`\r   Processing day ${daysProcessed}... ${totalMinutes.toLocaleString()} minute records`);
            lastProgressLog = Date.now();
          }
        };

        const cbboLoaded = await this.cbboLoader.loadDateRange(
          this.config.startDate,
          this.config.endDate,
          progressCallback
        );

        if (!this.config.quiet) {
          process.stdout.write('\r' + ' '.repeat(80) + '\r'); // Clear progress line
          if (cbboLoaded) {
            const cbboRange = this.cbboLoader.getDataRange();
            console.log(`✅ CBBO data loaded: ${cbboRange.minuteCount.toLocaleString()} minute records`);
          } else {
            console.warn('⚠️  No CBBO data found in date range - CBBO strategy will have limited signals');
          }
        }
        this.cbboDataLoaded = cbboLoaded;
      } else if (!this.config.quiet) {
        console.log('⚠️  No CBBO files found - CBBO-LT Volatility strategy will have no signals');
      }
    }

    return {
      candles: aggregatedCandles,        // For strategy entry signals
      originalCandles: ohlcvData,        // For 1m exit monitoring
      fvgCandles: fvgCandles,           // For FVG detection (15m timeframe)
      gexLevels: gexData,
      gexLoader: this.gexLoader,         // Pass loader for 15-min timestamp lookups
      liquidityLevels: liquidityData,
      calendarSpreads: calendarSpreads,  // For contract transition tracking
      marketDataLookup: marketDataLookup,
      cvdMap: this.cvdMap,               // CVD data aligned to candle timestamps (Phase 3)
      bookImbalanceMap: this.bookImbalanceMap,  // Book imbalance data (Phase 4)
      ivLoader: this.ivLoader,           // IV data for IV Skew GEX strategy
      cbboLoader: this.cbboDataLoaded ? this.cbboLoader : null  // CBBO data for volatility strategy
    };
  }

  /**
   * Run the trading simulation with hybrid resolution:
   * - Entry signals: Generated on timeframe candle closes (15m)
   * - Exit monitoring: Processed on 1-minute resolution for accuracy
   *
   * @param {Object} data - Processed data
   * @returns {Object} Simulation results
   */
  async runSimulation(data) {
    if (!this.config.quiet) {
      const exitResolution = this.secondDataProvider ? '1-second' : '1-minute';
      console.log(`🎯 Running hybrid simulation (entry: ${this.config.timeframe}, exits: ${exitResolution})...`);
      console.log(`📊 Strategy evaluation: ${data.candles.length} ${this.config.timeframe} candles`);
      console.log(`📈 Exit monitoring: ${data.originalCandles.length} 1-minute candles` +
        (this.secondDataProvider ? ` with 1s precision (${this.secondDataProvider.getMinuteCount().toLocaleString()} minutes indexed)` : ''));
    }

    const signals = [];
    const rejectedSignals = [];
    const trades = [];
    const equityCurve = [{ timestamp: this.config.startDate.getTime(), equity: this.config.initialCapital }];

    // Initialize LT level analyzer for historical analysis
    const ltAnalyzer = new LTLevelAnalyzer();

    // Load CVD data into strategy if available (Phase 3 Order Flow)
    if (data.cvdMap && data.cvdMap.size > 0 && this.strategy.loadCVDData) {
      this.strategy.loadCVDData(data.cvdMap);
      if (!this.config.quiet) {
        console.log(`📈 CVD data loaded into strategy (${data.cvdMap.size} candles)`);
      }
    }

    // Load book imbalance data into strategy if available (Phase 4 Order Flow)
    if (data.bookImbalanceMap && data.bookImbalanceMap.size > 0 && this.strategy.loadBookImbalanceData) {
      this.strategy.loadBookImbalanceData(data.bookImbalanceMap);
      const withData = [...data.bookImbalanceMap.values()].filter(d => d.updates > 0).length;
      if (!this.config.quiet) {
        console.log(`📊 Book imbalance data loaded into strategy (${withData} candles)`);
      }
    }

    // Load IV data into strategy if available (IV Skew GEX strategy)
    if (data.ivLoader && this.strategy.loadIVData) {
      this.strategy.loadIVData(data.ivLoader);
      const stats = data.ivLoader.getStats();
      if (!this.config.quiet && stats.count > 0) {
        console.log(`📈 IV data loaded into strategy (${stats.count} records)`);
      }
    }

    // Load LT data into strategy if available (LT Failed Breakdown strategy)
    if (data.liquidityLevels && this.strategy.loadLTData) {
      this.strategy.loadLTData(data.liquidityLevels);
      if (!this.config.quiet) {
        console.log(`📈 LT data loaded into strategy (${data.liquidityLevels.length} records)`);
      }
    }

    // Initialize trade simulator with calendar spread data
    if (data.calendarSpreads && data.calendarSpreads.length > 0) {
      this.tradeSimulator.initializeCalendarSpreads(data.calendarSpreads);
    }

    // Initialize GF early exit if enabled in strategy params
    if (this.config.strategyParams?.gfEarlyExit && data.gexLoader) {
      this.tradeSimulator.setGexLoader(data.gexLoader);
      this.tradeSimulator.enableGFEarlyExit({
        breakevenThreshold: this.config.strategyParams.gfBreakevenThreshold ?? 2,
        exitThreshold: this.config.strategyParams.gfExitThreshold ?? 3,
        checkIntervalMs: this.config.strategyParams.gfCheckIntervalMs ?? 15 * 60 * 1000
      });

      if (!this.config.quiet) {
        console.log(`📊 GF Early Exit enabled: breakeven @ ${this.config.strategyParams.gfBreakevenThreshold ?? 2} adverse, exit @ ${this.config.strategyParams.gfExitThreshold ?? 3} adverse`);
      }
    }

    let currentEquity = this.config.initialCapital;
    let prevCandle = null;
    let lastProgressUpdate = Date.now();
    const progressInterval = 1000; // Update progress every second
    let candleIndex1m = 0; // Track position in 1-minute candles

    const startTime = Date.now();

    for (let i = 0; i < data.candles.length; i++) {
      const candle = data.candles[i]; // 15-minute candle
      const timeframeMs = this.getTimeframeMs(this.config.timeframe);

      // CRITICAL FIX: Process 1m candles from the CURRENT period start to NEXT period start
      // candle.timestamp is the period START (e.g., 08:30 for 08:30-08:45 period)
      // We process candles from 08:30 to 08:44:59 (exclusive of next period)
      // This ensures signals generated at 08:45 (end of this period) can only fill on 08:45+ candles
      const candleStartTime = candle.timestamp; // Period start (not shifted back 14 minutes)
      const candleEndTime = candle.timestamp + timeframeMs; // Period end (exclusive)

      // Process all 1-minute candles within this 15-minute period for exit monitoring
      while (candleIndex1m < data.originalCandles.length) {
        const candle1m = data.originalCandles[candleIndex1m];

        // Stop when we reach candles at or beyond the next 15m period
        if (candle1m.timestamp >= candleEndTime) {
          break;
        }

        // Only process 1m candles that are within the current 15m period
        if (candle1m.timestamp >= candleStartTime) {
          // Update active trades - use 1-second resolution if available
          let tradeUpdates;
          if (this.secondDataProvider && this.tradeSimulator.hasActiveTrades()) {
            const secondCandles = await this.secondDataProvider.getSecondsForMinute(candle1m.timestamp);
            tradeUpdates = this.tradeSimulator.updateActiveTradesWithSeconds(secondCandles, candle1m);
          } else {
            tradeUpdates = this.tradeSimulator.updateActiveTrades(candle1m);
          }

          // Track LT level hits for active trades
          this.tradeSimulator.getActiveTrades().forEach(activeTrade => {
            ltAnalyzer.updateLevelHits(activeTrade.id, candle1m);
          });

          tradeUpdates.forEach(update => {
            if (update.status === 'completed') {
              // Complete LT level analysis for finished trade
              ltAnalyzer.completeTradeAnalysis(update.id, update);

              trades.push(update);
              currentEquity += update.netPnL;

              // Add equity curve point
              equityCurve.push({
                timestamp: update.exitTime,
                equity: currentEquity,
                trade: update
              });

              // Show trade completion in verbose mode
              if (!this.config.quiet && this.config.verbose) {
                const pnlColor = update.netPnL >= 0 ? '✅' : '❌';
                console.log(`\n${pnlColor} Trade ${update.id} completed: ${update.exitReason} | P&L: $${update.netPnL.toFixed(2)}`);
              }
            }
          });
        }

        candleIndex1m++;
      }

      // Get market data for this timestamp
      const marketData = this.getMarketDataForTimestamp(candle.timestamp, data.marketDataLookup, data);

      // Calculate squeeze momentum if strategy needs it
      if (this.squeezeIndicator && i >= 25) { // Need enough candles for calculation
        try {
          const recentCandles = data.candles.slice(Math.max(0, i - 25), i + 1);
          const squeezeData = this.squeezeIndicator.calculate(recentCandles, this.previousMomentum);

          if (squeezeData) {
            marketData.squeezeData = squeezeData;
            this.previousMomentum = squeezeData.momentum.value;

            // Log squeeze data occasionally for debugging
            if (i % 100 === 0 && this.config.verbose) {
              const dateStr = new Date(candle.timestamp).toISOString().split('T')[0];
              console.log(`📊 ${dateStr}: Momentum=${squeezeData.momentum.value.toFixed(4)}, State=${squeezeData.squeeze.state}`);
            }
          }
        } catch (error) {
          if (this.config.verbose) {
            console.log(`Warning: Squeeze calculation failed for candle ${i}: ${error.message}`);
          }
        }
      }

      // Detect Fair Value Gaps if strategy uses FVG entries
      if (data.fvgCandles && this.strategy.imbalanceDetector) {
        // Find the current position in FVG candles
        const currentFVGIndex = data.fvgCandles.findIndex(fvgCandle =>
          fvgCandle.timestamp >= candle.timestamp
        );

        if (currentFVGIndex > 0) {
          // Get slice of FVG candles up to current time for analysis
          const fvgCandlesUpToCurrent = data.fvgCandles.slice(0, currentFVGIndex + 1);

          // Detect FVGs using the last N candles for context
          const lookbackCandles = Math.min(this.strategy.params.fvgLookback || 100, fvgCandlesUpToCurrent.length);
          const startIndex = Math.max(0, fvgCandlesUpToCurrent.length - lookbackCandles);
          const candlesForAnalysis = fvgCandlesUpToCurrent.slice(startIndex);

          const detectedFVGs = this.strategy.imbalanceDetector.detectFairValueGaps(
            candlesForAnalysis,
            lookbackCandles,
            candle.timestamp
          );

          // Update fill status with recent price action
          const recentCandles = candlesForAnalysis.slice(-20); // Last 20 candles for fill detection
          const activeFVGs = this.strategy.imbalanceDetector.updateFillStatus(detectedFVGs, recentCandles);

          marketData.fvgData = activeFVGs;

          if (activeFVGs.length > 0 && !this.config.quiet && this.config.verbose) {
            const stats = this.strategy.imbalanceDetector.getGapStatistics(activeFVGs);
            console.log(`📊 FVG Analysis: ${stats.total} total, ${stats.active} active (${stats.bullish} bullish, ${stats.bearish} bearish)`);
          }
        }
      }

      // Generate trading signal if we have previous candle (only at candle closes)
      // IMPORTANT: Signal is generated at candle CLOSE time, not START time
      // The candle.timestamp is the period START, so close time = timestamp + timeframeMs
      // NOTE: GEX levels check removed to allow non-GEX strategies (e.g., LT Failed Breakdown)
      if (prevCandle) {
        // Prepare historical candles for momentum calculation (need enough for squeeze indicator)
        const historicalCandles = data.candles.slice(Math.max(0, i - 49), i + 1); // 50 candles for proper momentum calculation
        const options = { historicalCandles };

        // Check if any pending orders should be invalidated (e.g., regime change)
        // This allows strategies to cancel unfilled limit orders when conditions change
        if (typeof this.strategy.shouldInvalidatePendingOrder === 'function') {
          const pendingOrders = this.tradeSimulator.getPendingOrders();
          for (const pendingOrder of pendingOrders) {
            const invalidation = this.strategy.shouldInvalidatePendingOrder(
              pendingOrder.signal,
              candle,
              historicalCandles
            );
            if (invalidation && invalidation.shouldCancel) {
              const cancelledOrder = this.tradeSimulator.cancelPendingOrder(
                pendingOrder.id,
                invalidation.reason
              );
              if (cancelledOrder && !this.config.quiet && this.config.verbose) {
                console.log(`\n⚠️  Pending order invalidated: ${invalidation.reason}`);
              }
            }
          }
        }

        const signal = this.strategy.evaluateSignal(candle, prevCandle, marketData, options);

        if (signal) {
          // Track the contract symbol for rollover handling
          signal.signalContract = candle.symbol;

          // Add trailing stop config to signal if enabled
          if (this.config.strategyParams?.useTrailingStop) {
            signal.trailingTrigger = this.config.strategyParams.trailingTrigger;
            signal.trailingOffset = this.config.strategyParams.trailingOffset;
          }

          // Add hybrid trailing config to signal if enabled
          if (this.config.strategyParams?.hybridTrailing) {
            signal.hybridTrailing = true;
            signal.hybridConfig = {
              structureThreshold: this.config.strategyParams.structureThreshold || 30,
              swingLookback: this.config.strategyParams.swingLookback || 5,
              swingBuffer: this.config.strategyParams.swingBuffer || 5,
              minSwingSize: this.config.strategyParams.minSwingSize || 3
            };
          }

          // Add breakeven stop config to signal if enabled
          if (this.config.strategyParams?.breakevenStop) {
            signal.breakevenStop = true;
            signal.breakevenTrigger = this.config.strategyParams.breakevenTrigger ||
                                       this.config.strategyParams.trailingTrigger || 20;
            signal.breakevenOffset = this.config.strategyParams.breakevenOffset || 0;
          }

          // Add time-based trailing config to signal if enabled
          // This mode progressively tightens stops based on bars held + profit level
          if (this.config.strategyParams?.timeBasedTrailing) {
            signal.timeBasedTrailing = true;
            signal.timeBasedConfig = {
              rules: this.config.strategyParams.timeBasedTrailingConfig?.rules || [
                // Default rules based on correlation analysis of 385 trades
                { afterBars: 15, ifMFE: 20, action: 'breakeven' },
                { afterBars: 30, ifMFE: 30, trailDistance: 20 },
                { afterBars: 45, ifMFE: 40, trailDistance: 10 },
              ]
            };
          }

          // CRITICAL FIX: Signal time is at candle CLOSE, not START
          // candle.timestamp is the period start, close happens at start + timeframe
          const timeframeMs = this.getTimeframeMs(this.config.timeframe);
          const signalTime = candle.timestamp + timeframeMs;

          signals.push(signal);

          // Start LT level analysis for this signal if it has LT data
          if (signal.availableLTLevels) {
            ltAnalyzer.startTradeAnalysis(signal, signalTime);
          }

          // Process signal through trade simulator with correct signal time
          const order = this.tradeSimulator.processSignal(signal, signalTime);
          if (order && !this.config.quiet && this.config.verbose) {
            const signalDate = new Date(signalTime).toISOString();
            console.log(`\n📊 Signal generated: ${signal.side.toUpperCase()} ${signal.symbol} @ ${signal.price || signal.entryPrice} (${signalDate})`);
          } else if (!order) {
            // Signal was generated but rejected due to existing position
            rejectedSignals.push({ ...signal, timestamp: signalTime, reason: 'position_already_active' });
            if (!this.config.quiet && this.config.verbose) {
              const signalDate = new Date(signalTime).toISOString();
              console.log(`\n⏸️  Signal rejected: ${signal.side.toUpperCase()} ${signal.symbol} @ ${signal.price || signal.entryPrice} (${signalDate}) - Position already active`);
            }
          }
        }
      }

      prevCandle = candle;

      // Enhanced progress indicator with timing and performance info
      if (!this.config.quiet && Date.now() - lastProgressUpdate > progressInterval) {
        const progress = ((i + 1) / data.candles.length) * 100;
        const elapsed = (Date.now() - startTime) / 1000;
        const eta = elapsed > 0 ? ((elapsed / (i + 1)) * (data.candles.length - i - 1)) : 0;
        const candlesPerSec = elapsed > 0 ? Math.round((i + 1) / elapsed) : 0;

        const currentEquityStr = `$${currentEquity.toLocaleString()}`;
        const tradesStr = trades.length > 0 ? ` | ${trades.length} trades` : '';
        const activeStr = this.tradeSimulator.getActiveTrades().length > 0 ? ` | ${this.tradeSimulator.getActiveTrades().length} active` : '';

        process.stdout.write(`\r⏳ ${progress.toFixed(1)}% | ${candlesPerSec}/s | ETA: ${eta.toFixed(0)}s | Equity: ${currentEquityStr}${tradesStr}${activeStr}`);
        lastProgressUpdate = Date.now();
      }
    }

    // Process any remaining 1-minute candles after the last 15-minute candle
    while (candleIndex1m < data.originalCandles.length) {
      const candle1m = data.originalCandles[candleIndex1m];

      // Track LT level hits for active trades
      this.tradeSimulator.getActiveTrades().forEach(activeTrade => {
        ltAnalyzer.updateLevelHits(activeTrade.id, candle1m);
      });

      // Update active trades - use 1-second resolution if available
      let tradeUpdates;
      if (this.secondDataProvider && this.tradeSimulator.hasActiveTrades()) {
        const secondCandles = await this.secondDataProvider.getSecondsForMinute(candle1m.timestamp);
        tradeUpdates = this.tradeSimulator.updateActiveTradesWithSeconds(secondCandles, candle1m);
      } else {
        tradeUpdates = this.tradeSimulator.updateActiveTrades(candle1m);
      }
      tradeUpdates.forEach(update => {
        if (update.status === 'completed') {
          // Complete LT level analysis for finished trade
          ltAnalyzer.completeTradeAnalysis(update.id, update);

          trades.push(update);
          currentEquity += update.netPnL;

          equityCurve.push({
            timestamp: update.exitTime,
            equity: currentEquity,
            trade: update
          });

          if (!this.config.quiet && this.config.verbose) {
            const pnlColor = update.netPnL >= 0 ? '✅' : '❌';
            console.log(`\n${pnlColor} Trade ${update.id} completed: ${update.exitReason} | P&L: $${update.netPnL.toFixed(2)}`);
          }
        }
      });

      candleIndex1m++;
    }

    // Clear progress line and show completion summary
    if (!this.config.quiet) {
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
      const avgCandlesPerSec = Math.round(data.candles.length / (totalTime || 1));
      process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear line
      console.log(`✅ Simulation completed in ${totalTime}s (${avgCandlesPerSec} candles/sec)`);
      console.log(`📈 Final equity: $${currentEquity.toLocaleString()} | Total trades: ${trades.length}`);
    }

    // Close any remaining active trades at the end
    const activeTrades = this.tradeSimulator.getActiveTrades();
    if (activeTrades.length > 0 && !this.config.quiet) {
      console.log(`⚠️  ${activeTrades.length} trades still active at end of backtest (will not be included in results)`);
    }

    // Generate LT level analysis results
    const ltAnalysisResults = ltAnalyzer.getAnalysisResults();

    return {
      signals: signals,
      rejectedSignals: rejectedSignals,
      trades: trades,
      activeTrades: activeTrades,
      equityCurve: equityCurve,
      finalEquity: currentEquity,
      ltAnalysis: ltAnalysisResults,
      strategy: this.strategy, // Include strategy for performance tracking
      processingStats: {
        totalCandles: data.candles.length,
        originalCandles: data.originalCandles.length,
        processingTimeSeconds: (Date.now() - startTime) / 1000,
        candlesPerSecond: Math.round(data.candles.length / ((Date.now() - startTime) / 1000 || 1))
      }
    };
  }

  /**
   * Calculate performance metrics
   *
   * @param {Object} simulation - Simulation results
   * @param {Object} data - Original data
   * @returns {Object} Performance metrics
   */
  calculatePerformance(simulation, data) {
    return this.performanceCalculator.calculateMetrics(
      simulation.trades,
      simulation.equityCurve,
      this.config.startDate,
      this.config.endDate
    );
  }

  /**
   * Create market data lookup for efficient access
   *
   * @param {Object[]} gexData - GEX levels data
   * @param {Object[]} liquidityData - Liquidity levels data
   * @returns {Object} Market data lookup
   */
  createMarketDataLookup(gexData, liquidityData) {
    const lookup = {
      gex: new Map(),
      liquidity: new Map()
    };

    // Index GEX data by date
    gexData.forEach(gex => {
      const dateKey = new Date(gex.date).toDateString();
      lookup.gex.set(dateKey, gex);
    });

    // Index liquidity data by closest timestamp
    liquidityData.forEach(lt => {
      const timestamp = new Date(lt.timestamp).getTime();
      lookup.liquidity.set(timestamp, lt);
    });

    return lookup;
  }

  /**
   * Get market data for a specific timestamp
   *
   * @param {number} timestamp - Target timestamp
   * @param {Object} lookup - Market data lookup
   * @param {Object} data - Full data object (for gexLoader access)
   * @returns {Object} Market data object
   */
  getMarketDataForTimestamp(timestamp, lookup, data = null) {
    let gexLevels = null;

    // Get 15-minute GEX levels from JSON loader (primary source)
    if (data && data.gexLoader && data.gexLoader.sortedTimestamps.length > 0) {
      gexLevels = data.gexLoader.getGexLevels(new Date(timestamp));
    }

    // Fall back to date-indexed lookup if no 15-min data
    if (!gexLevels && lookup) {
      const date = new Date(timestamp);
      const dateKey = date.toDateString();
      const rawGexLevels = lookup.gex.get(dateKey) || null;
      gexLevels = this.transformGexLevels(rawGexLevels);
    }

    // Find closest liquidity levels (within reasonable time window)
    let liquidityLevels = null;
    const maxTimeDiff = 15 * 60 * 1000; // 15 minutes

    if (lookup && lookup.liquidity) {
      for (const [ltTimestamp, ltData] of lookup.liquidity) {
        const timeDiff = Math.abs(timestamp - ltTimestamp);
        if (timeDiff <= maxTimeDiff) {
          if (!liquidityLevels || timeDiff < Math.abs(timestamp - liquidityLevels.timestamp)) {
            liquidityLevels = ltData;
          }
        }
      }
    }

    // Get CBBO metrics if loader is available
    let cbboMetrics = null;
    let cbboSpreadChange = null;
    if (data && data.cbboLoader) {
      cbboMetrics = data.cbboLoader.getCBBOMetrics(timestamp);
      cbboSpreadChange = data.cbboLoader.getSpreadChange(
        timestamp,
        this.config.strategyParams?.lookbackMinutes || 30
      );
    }

    return {
      gexLevels: gexLevels,
      ltLevels: liquidityLevels,
      gexLoader: data?.gexLoader || null,  // Pass loader for strategy use
      cbbo: cbboMetrics,                   // CBBO metrics for current timestamp
      cbboSpreadChange: cbboSpreadChange   // Spread change over lookback window
    };
  }

  /**
   * Transform raw GEX levels into strategy format
   *
   * @param {Object} rawGexLevels - Raw GEX data with individual fields
   * @returns {Object|null} Transformed GEX levels with resistance/support arrays
   */
  transformGexLevels(rawGexLevels) {
    if (!rawGexLevels) return null;

    // Put walls become support levels, Call walls become resistance levels
    const support = [
      rawGexLevels.nq_put_wall_1,
      rawGexLevels.nq_put_wall_2,
      rawGexLevels.nq_put_wall_3
    ].filter(level => level != null && !isNaN(level));

    const resistance = [
      rawGexLevels.nq_call_wall_1,
      rawGexLevels.nq_call_wall_2,
      rawGexLevels.nq_call_wall_3
    ].filter(level => level != null && !isNaN(level));

    return {
      ...rawGexLevels, // Preserve original fields
      support: support,
      resistance: resistance,
      gammaFlip: rawGexLevels.nq_gamma_flip
    };
  }

  /**
   * Create strategy instance
   *
   * @param {string} strategyName - Strategy name
   * @param {Object} params - Strategy parameters
   * @returns {Object} Strategy instance
   */
  createStrategy(strategyName, params) {
    switch (strategyName.toLowerCase()) {
      case 'gex-recoil':
        return new GexRecoilStrategy(params);
      case 'gex-recoil-enhanced':
        return new GexRecoilEnhancedStrategy(params);
      case 'gex-ldpm-confluence':
        return new GexLdpmConfluenceStrategy(params);
      case 'gex-ldpm-confluence-pullback':
        return new GexLdpmConfluencePullbackStrategy(params);
      case 'contrarian-bounce':
        return new ContrarianBounceStrategy(params);
      case 'gex-scalp':
        return new GexScalpStrategy(params);
      case 'gex-scalp-confirmed':
        return new GexScalpConfirmedStrategy(params);
      case 'ict-smc':
        return new ICTSMCStrategy(params);
      case 'ict-ob':
        return new ICTOBStrategy(params);
      case 'ldpm-level-sweep':
        return new LdpmLevelSweepStrategy(params);
      case 'order-flow-momentum':
      case 'ofm':
        return new OrderFlowMomentumStrategy(params);
      case 'contrarian-orderflow':
      case 'cof':
        return new ContrarianOrderFlowStrategy(params);
      case 'gex-absorption':
      case 'absorption':
        return new GexAbsorptionStrategy(params);
      case 'iv-skew-gex':
      case 'iv-skew':
        return new IVSkewGexStrategy(params);
      case 'cbbo-lt-volatility':
      case 'cbbo-lt':
        return new CBBOLTVolatilityStrategy(params);
      case 'gex-mean-reversion':
      case 'gex-mr':
        return new GexMeanReversionStrategy(params);
      case 'lt-failed-breakdown':
      case 'lt-fb':
        return new LTFailedBreakdownStrategy(params);
      case 'lt-level-crossing':
      case 'lt-cross':
        return new LTLevelCrossingStrategy(params);
      case 'lt-level-migration':
      case 'lt-mig':
        return new LTLevelMigrationStrategy(params);
      case 'regime-scalp':
      case 'rs':
        return new RegimeScalpStrategy(params);
      case 'gex-level-sweep':
      case 'gex-sweep':
      case 'sweep':
        return new GexLevelSweepStrategy(params);
      case 'micro-structure-scalper':
      case 'micro-scalper':
      case 'mss':
        return new MicroStructureScalperStrategy(params);
      case 'trend-scalp':
      case 'ts':
        return new TrendScalpStrategy(params);
      case 'level-bounce':
      case 'lb':
        return new LevelBounceStrategy(params);
      default:
        throw new Error(`Unknown strategy: ${strategyName}`);
    }
  }

  /**
   * Get timeframe in milliseconds
   *
   * @param {string} timeframe - Timeframe string (e.g., '15m', '1h')
   * @returns {number} Timeframe in milliseconds
   */
  getTimeframeMs(timeframe) {
    const unit = timeframe.slice(-1);
    const value = parseInt(timeframe.slice(0, -1));

    switch (unit) {
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      default:
        throw new Error(`Unknown timeframe unit: ${unit}`);
    }
  }

  /**
   * Get session name from timestamp
   * @param {number|string|Date} timestamp
   * @returns {string} 'overnight', 'premarket', 'rth', or 'afterhours'
   */
  getSessionFromTimestamp(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;

    if (timeDecimal >= 9.5 && timeDecimal < 16) {
      return 'rth';
    } else if (timeDecimal >= 4 && timeDecimal < 9.5) {
      return 'premarket';
    } else if (timeDecimal >= 16 && timeDecimal < 18) {
      return 'afterhours';
    } else {
      return 'overnight';
    }
  }

  /**
   * Export trades to CSV
   *
   * @param {string} filePath - Output file path
   */
  exportTradesToCSV(filePath) {
    const trades = this.tradeSimulator.getCompletedTrades();

    if (trades.length === 0) {
      console.log('⚠️  No trades to export');
      return;
    }

    const headers = [
      'TradeID', 'Strategy', 'Symbol', 'Side', 'Quantity',
      'SignalTime', 'EntryTime', 'FillDelayMs', 'EntryPrice', 'ExitTime', 'ExitPrice', 'ExitReason',
      'GrossPnL', 'NetPnL', 'Commission', 'PointsPnL', 'PercentPnL',
      'Duration', 'SignalType', 'HTFBias', 'Trigger', 'Confidence', 'RiskReward',
      // ICT-specific columns
      'OB_High', 'OB_Low', 'OB_Time', 'OB_Type',
      'CHoCH_Level', 'CHoCH_Time', 'MSS_Level', 'MSS_Time',
      'SwingHigh', 'SwingHigh_Time', 'SwingLow', 'SwingLow_Time',
      'FVG_Top', 'FVG_Bottom', 'FVG_Time', 'FibLevel', 'FibPrice',
      // Original columns
      'GEXLevel', 'GEXLevelType', 'LTLevelsBelow',
      'LTSentiment', 'LTOrdering', 'LTSpacing', 'LTLdmpType', 'LTAvgSpacing', 'FilterReason'
    ];

    const csvRows = [headers.join(',')];

    trades.forEach(trade => {
      const m = trade.metadata || {};
      const ob = m.orderBlock || {};
      const fvg = m.fvg || {};

      const row = [
        trade.id,
        trade.strategy || '',
        trade.symbol,
        trade.side,
        trade.quantity,
        trade.signalTime ? new Date(trade.signalTime).toISOString() : '',
        trade.entryTime ? new Date(trade.entryTime).toISOString() : '',
        trade.fillDelay || 0,
        trade.actualEntry || trade.entryPrice,
        new Date(trade.exitTime).toISOString(),
        trade.actualExit,
        trade.exitReason,
        trade.grossPnL,
        trade.netPnL,
        trade.commission,
        trade.pointsPnL,
        trade.percentPnL,
        trade.duration,
        m.signalType || '',
        m.htfBias || '',
        m.trigger || '',
        m.confidence || '',
        m.riskReward || '',
        // ICT-specific: Order Block
        ob.high || '',
        ob.low || '',
        ob.timestamp ? new Date(ob.timestamp).toISOString() : '',
        ob.type || '',
        // ICT-specific: CHoCH
        m.chochLevel || '',
        m.chochTime ? new Date(m.chochTime).toISOString() : '',
        // ICT-specific: MSS
        m.mssLevel || '',
        m.mssTime ? new Date(m.mssTime).toISOString() : '',
        // ICT-specific: Swing Points
        m.swingHigh || '',
        m.swingHighTime ? new Date(m.swingHighTime).toISOString() : '',
        m.swingLow || '',
        m.swingLowTime ? new Date(m.swingLowTime).toISOString() : '',
        // ICT-specific: FVG
        fvg.top || '',
        fvg.bottom || '',
        fvg.timestamp ? new Date(fvg.timestamp).toISOString() : '',
        // ICT-specific: Fibonacci
        m.fibLevel || '',
        m.fibPrice || '',
        // Original columns
        m.gex_level || '',
        m.gex_level_type || '',
        m.lt_levels_below || '',
        m.lt_sentiment || '',
        m.lt_ordering || '',
        m.lt_spacing || '',
        m.lt_ldmp_type || '',
        m.lt_avg_spacing || '',
        m.filter_reason || ''
      ];
      csvRows.push(row.join(','));
    });

    fs.writeFileSync(filePath, csvRows.join('\n'));
  }
}