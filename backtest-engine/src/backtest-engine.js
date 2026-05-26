/**
 * Backtesting Engine
 *
 * Main orchestrator for running backtests
 * Coordinates data loading, strategy execution, and result generation
 */

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { CSVLoader, SecondDataProvider } from './data/csv-loader.js';
import { CandleAggregator } from '../../shared/utils/candle-aggregator.js';
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
import { GexFlipIvpctStrategy } from '../../shared/strategies/gex-flip-ivpct.js';
import { GexLt3mCrossoverStrategy } from '../../shared/strategies/gex-lt-3m-crossover.js';
import { LsFlipTriggerBarStrategy } from '../../shared/strategies/ls-flip-trigger-bar.js';
import { GexTouchConfirmStrategy } from '../../shared/strategies/gex-touch-confirm.js';
import { GexTouchPatternsStrategy } from '../../shared/strategies/gex-touch-patterns.js';
import { GexStructuralResistStrategy } from '../../shared/strategies/gex-structural-resist.js';
import { GexLevelFadeStrategy } from '../../shared/strategies/gex-level-fade.js';
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
import { OvernightGexTouchStrategy } from '../../shared/strategies/overnight-gex-touch.js';
import { OvernightCharmVannaStrategy } from '../../shared/strategies/overnight-charm-vanna.js';
import { ESCrossSignalStrategy } from '../../shared/strategies/es-cross-signal.js';
import { ESMicroScalperStrategy } from '../../shared/strategies/es-micro-scalper.js';
import { EsStopHuntStrategy } from '../../shared/strategies/es-stop-hunt.js';
import { OHLCVAbsorptionStrategy } from '../../shared/strategies/ohlcv-absorption.js';
import { OHLCVLiquiditySweepStrategy } from '../../shared/strategies/ohlcv-liquidity-sweep.js';
import { OHLCVVPINStrategy } from '../../shared/strategies/ohlcv-vpin.js';
import { OHLCVMTFRejectionStrategy } from '../../shared/strategies/ohlcv-mtf-rejection.js';
import { MomentumMicrostructureStrategy } from '../../shared/strategies/momentum-microstructure.js';
import { MidnightOpenRetracementStrategy } from '../../shared/strategies/midnight-open-retracement.js';
import { InitialBalanceBreakoutStrategy } from '../../shared/strategies/initial-balance-breakout.js';
import { GapFillStrategy } from '../../shared/strategies/gap-fill.js';
import { DailyLevelSweepStrategy } from '../../shared/strategies/daily-level-sweep.js';
import { VWAPBounceStrategy } from '../../shared/strategies/vwap-bounce.js';
import { SessionTransitionStrategy } from '../../shared/strategies/session-transition.js';
import { ValueArea80Strategy } from '../../shared/strategies/value-area-80.js';
import { SwingReversalStrategy } from '../../shared/strategies/swing-reversal.js';
import { ICTSilverBulletStrategy } from '../../shared/strategies/ict-silver-bullet.js';
import { PriceActionExhaustionStrategy } from '../../shared/strategies/price-action-exhaustion.js';
import { ICTMTFSweepStrategy } from '../../shared/strategies/ict-mtf-sweep/index.js';
import { DCSt1Strategy } from '../../shared/strategies/dc-st1.js';
import { DCSt2Strategy, DCSt3Strategy, DCSt4Strategy, DCSt5Strategy, DCSt6Strategy, DCSt7Strategy, DCSt8Strategy } from '../../shared/strategies/dc-strategies.js';
import { DCMSTGAMStrategy } from '../../shared/strategies/dc-mstgam.js';
import { MnqAdaptiveScalperStrategy } from '../../shared/strategies/mnq-adaptive-scalper.js';
import { SweepReversalStrategy } from '../../shared/strategies/sweep-reversal.js';
import { NqLeadsEsStrategy } from '../../shared/strategies/nq-leads-es.js';
import { GexSupportBounceStrategy } from '../../shared/strategies/gex-support-bounce.js';
import { ImpulseFVGStrategy } from '../../shared/strategies/impulse-fvg.js';
import { ShortDTEIVStrategy } from '../../shared/strategies/short-dte-iv.js';
import { OvernightScoringStrategy } from '../../shared/strategies/overnight-scoring.js';
import { OvernightCompositeStrategy } from '../../shared/strategies/overnight-composite.js';
import { OvernightLTCrossingStrategy } from '../../shared/strategies/overnight-lt-crossing.js';
import { LTCrossoverStrategy } from '../../shared/strategies/lt-crossover.js';
import { LTStructureConfirmStrategy } from '../../shared/strategies/lt-structure-confirm.js';
import { LTCandleRegimeStrategy } from '../../shared/strategies/lt-candle-regime.js';
import { GammaRegimeDriftStrategy } from '../../shared/strategies/gamma-regime-drift.js';
import { SqueezeMomentumIndicator } from '../../shared/indicators/squeeze-momentum.js';
import { GexLoader } from './data-loaders/gex-loader.js';
import { IVLoader } from './data-loaders/iv-loader.js';
import { ShortDTEIVLoader } from './data-loaders/short-dte-iv-loader.js';
import { CBBOLoader } from './data-loaders/cbbo-loader.js';
import { CharmVannaLoader } from './data-loaders/charm-vanna-loader.js';
import { SwingPivotLoader } from './data-loaders/swing-pivot-loader.js';
import { DatabentoTradeLoader } from './data/databento-loader.js';
import { MBPLoader } from './data/mbp-loader.js';

export class BacktestEngine {
  constructor(config) {
    this.config = config;

    // Load default configuration
    const defaultConfigPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'config', 'default.json');
    this.defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

    // Initialize components
    this.csvLoader = new CSVLoader(config.dataDir, this.defaultConfig, { noContinuous: config.noContinuous });
    this.aggregator = new CandleAggregator();
    this.tradeSimulator = new TradeSimulator({
      commission: config.commission,
      slippage: this.defaultConfig.backtesting.slippage,
      contractSpecs: this.defaultConfig.contracts,
      forceCloseAtMarketClose: config.strategyParams?.forceCloseAtMarketClose ?? this.defaultConfig.backtesting.forceCloseAtMarketClose,
      marketCloseTimeUTC: config.strategyParams?.marketCloseTimeUTC ?? this.defaultConfig.backtesting.marketCloseTimeUTC,
      eodCutoffEt: config.eodCutoffEt ?? config.strategyParams?.eodCutoffEt ?? null,
      strictLimitFill: config.strictLimitFill ?? false,
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
      // MFE ratchet trailing stop configuration (lock % of peak profit at tier thresholds)
      mfeRatchet: config.strategyParams?.mfeRatchet ? {
        enabled: true,
        tiers: config.strategyParams.mfeRatchetTiers || undefined  // Falls back to defaults in TradeSimulator
      } : { enabled: false },
      // Fibonacci-retrace bar-close exit (additive — does NOT replace hard SL).
      fibRetrace: config.strategyParams?.fibRetrace ? {
        enabled: true,
        retracePct: config.strategyParams.fibRetracePct ?? 0.786,
        activationMFE: config.strategyParams.fibActivationMFE ?? 40,
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
      } : { enabled: false },
      // IV shift filter: cancel fills where IV shifted too much between signal and fill
      maxIVShiftAtFill: config.strategyParams?.maxIVShiftAtFill || 0
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

    // Initialize GEX loader — use custom directory if provided (e.g., CBBO-based GEX),
    // otherwise default to statistics-based 15m JSON files under data/gex/.
    //
    // Path resolution for --gex-dir tries (in order): absolute, dataDir-relative,
    // cwd-relative. If none of those resolve to an existing directory, error out
    // — silently falling back to the legacy daily CSV used to mask which dataset
    // was actually loaded (caused Phase 5 sweep to run on legacy data thinking
    // it was cbbo).
    let gexPath;
    if (config.gexDir) {
      const candidates = path.isAbsolute(config.gexDir)
        ? [config.gexDir]
        : [
            path.join(config.dataDir, config.gexDir),
            path.resolve(config.gexDir),
          ];
      gexPath = candidates.find((p) => fs.existsSync(p));
      if (!gexPath) {
        throw new Error(
          `--gex-dir="${config.gexDir}" did not resolve to an existing directory. Tried: ${candidates.join(', ')}`
        );
      }
      console.log(`📊 Using custom GEX directory: ${gexPath}`);
    } else {
      gexPath = path.join(config.dataDir, 'gex');
    }
    this.gexLoader = new GexLoader(gexPath, config.ticker);

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
    this.ivLoader = new IVLoader(config.dataDir, { resolution: config.ivResolution || '15m' });
    this.ivData = null; // Will be populated in loadData if IV data exists

    // Initialize Short-DTE IV loader for Short-DTE IV strategy
    this.shortDTEIVLoader = new ShortDTEIVLoader(config.dataDir);

    // Initialize CBBO loader for CBBO-LT Volatility strategy
    const cbboDir = config.cbboDataDir || path.join(config.dataDir, 'cbbo-1m', 'qqq');
    this.cbboLoader = new CBBOLoader(cbboDir);
    this.cbboDataLoaded = false;

    // Initialize Charm/Vanna loader for overnight ES strategy
    this.charmVannaLoader = new CharmVannaLoader(config.dataDir);
    this.charmVannaDataLoaded = false;

    // Initialize swing pivot loader (for magnet-aware MFE ratchet on gex-flip-ivpct).
    // Lazy: only loads if config.swingPivotFile is provided.
    this.swingPivotLoader = null;
    this.swingPivotsLoaded = false;

    // Capture mode: when set, every signal emitted by the strategy is recorded
    // and `tradeSimulator.processSignal()` is BYPASSED. The simulator stays
    // "always flat" so no internal position gate fires, and the strategy's
    // own per-strategy cooldown is force-zeroed below so every trigger event
    // emits a signal. Used by the meta-strategy-trader pipeline to capture
    // the full setup universe per strategy (see research/meta-strategy-trader/).
    this.captureSignalsMode = !!config.captureSignals;
    this.capturedSignals = [];
    if (this.captureSignalsMode) {
      // Disable any per-strategy cooldown so we see every trigger, not just
      // the post-cooldown subset. The meta-engine re-applies cooldown using
      // its own accept/exit timing.
      config.strategyParams = config.strategyParams || {};
      config.strategyParams.signalCooldownMs = 0;
    }

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

    // Optional 1m LT data (--lt-1m-file). Schema: timestamp_iso, unix_ms,
    // sentiment_raw, level_1..5, source_symbol, was_backadjusted, raw_contract.
    let liquidityData1m = [];
    if (this.config.lt1mFile) {
      liquidityData1m = await this._loadLt1mFile(this.config.lt1mFile,
        this.config.startDate, this.config.endDate);
      if (!this.config.quiet) {
        console.log(`✅ Loaded ${liquidityData1m.length} 1m LT records from ${this.config.lt1mFile}`);
      }
    }

    // Optional s1 VWAP feature data (--s1-vwap-file) for gex-touch-confirm.
    // Schema: timestamp,vwap_close_diff,vwap,close,n_bars
    let s1VwapData = [];
    if (this.config.s1VwapFile) {
      s1VwapData = await this._loadS1VwapFile(this.config.s1VwapFile,
        this.config.startDate, this.config.endDate);
      if (!this.config.quiet) {
        console.log(`✅ Loaded ${s1VwapData.length.toLocaleString()} s1 VWAP records from ${this.config.s1VwapFile}`);
      }
    }

    // Optional 1m LS state data (--ls-1m-file) for ls-flip-trigger-bar.
    // Schema: timestamp_iso, unix_ms, state (0|1), source_symbol.
    // Each row is a STATE CHANGE — Pine emits only on flip.
    let lsData1m = [];
    if (this.config.ls1mFile) {
      lsData1m = await this._loadLs1mFile(this.config.ls1mFile,
        this.config.startDate, this.config.endDate);
      if (!this.config.quiet) {
        console.log(`✅ Loaded ${lsData1m.length.toLocaleString()} 1m LS flip records from ${this.config.ls1mFile}`);
      }
    }

    // Load GEX data from 15-minute interval JSON files
    const gexLoaded = await this.gexLoader.loadDateRange(this.config.startDate, this.config.endDate);

    // Fall back to CSV if no JSON files found.
    // BUT: if the user explicitly set --gex-dir, no fallback — error instead.
    // The previous silent fallback caused Phase 5 sweep to use legacy daily CSV
    // (1 EOD snapshot/day) while believing it was using cbbo (56-60 intraday).
    let gexData = [];
    if (!gexLoaded || this.gexLoader.sortedTimestamps.length === 0) {
      if (this.config.gexDir) {
        throw new Error(
          `--gex-dir="${this.config.gexDir}" loaded 0 GEX records for ${this.config.startDate.toISOString().slice(0,10)} → ${this.config.endDate.toISOString().slice(0,10)}. ` +
          `Refusing to fall back to legacy CSV silently. Check the directory contains nq_gex_YYYY-MM-DD.json files for that range.`
        );
      }
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
    const ohlcvFilePath = this.csvLoader.getOHLCVFilePath(this.config.ticker);
    const isContinuousOHLCV = ohlcvFilePath.includes('_continuous');

    if (this.useSecondResolution) {
      const tickerLower = this.config.ticker.toLowerCase();
      const tickerUpper = this.config.ticker.toUpperCase();

      // When using continuous 1m data, ONLY use continuous 1s data — never fall back
      // to raw 1s, as mixing price spaces produces invalid results
      const secondFilePaths = isContinuousOHLCV
        ? [
            path.join(this.config.dataDir, 'ohlcv', tickerLower, `${tickerUpper}_ohlcv_1s_continuous.csv`),
          ]
        : [
            path.join(this.config.dataDir, 'ohlcv', tickerLower, `${tickerUpper}_ohlcv_1s.csv`),
            path.join(this.config.dataDir, 'ohlcv', `${tickerUpper}_ohlcv_1s.csv`),
          ];

      const secondFilePath = secondFilePaths.find(p => fs.existsSync(p));

      if (secondFilePath) {
        if (!this.config.quiet) {
          const label = isContinuousOHLCV ? ' (back-adjusted continuous)' : '';
          console.log(`🔬 Initializing 1-second data provider${label} for accurate trade execution...`);
        }
        this.secondDataProvider = new SecondDataProvider(secondFilePath);
        await this.secondDataProvider.initialize();
      } else {
        if (!this.config.quiet) {
          const reason = isContinuousOHLCV
            ? 'No continuous 1-second file found (run build-es-1s-continuous.py)'
            : 'No 1-second data file found';
          console.log(`⚠️  ${reason}, using 1-minute resolution for exits`);
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
    const marketDataLookup = this.createMarketDataLookup(gexData, liquidityData, liquidityData1m, s1VwapData, lsData1m);

    // Load IV data for IV-based strategies (iv-skew-gex, gex-flip-ivpct, gex-touch-confirm)
    const isIVSkewStrategy = this.config.strategy === 'iv-skew-gex' || this.config.strategy === 'iv-skew';
    const isGexFlipIvpctStrategy = this.config.strategy === 'gex-flip-ivpct' || this.config.strategy === 'gfi';
    const isGexTouchConfirm = this.config.strategy === 'gex-touch-confirm' || this.config.strategy === 'gex-touch' || this.config.strategy === 'gtc';
    if (isIVSkewStrategy || isGexFlipIvpctStrategy || isGexTouchConfirm) {
      await this.ivLoader.load(this.config.startDate, this.config.endDate);
      const ivStats = this.ivLoader.getStats();
      if (!this.config.quiet && ivStats.count > 0) {
        console.log(`📈 IV data: ${ivStats.count} records @ ${ivStats.resolution} (${ivStats.startDate?.split('T')[0]} to ${ivStats.endDate?.split('T')[0]})`);
        console.log(`   Avg IV: ${ivStats.avgIV?.toFixed(3)} | Avg Skew: ${ivStats.avgSkew?.toFixed(4)}`);
      } else if (!this.config.quiet && ivStats.count === 0) {
        console.warn('⚠️  No IV data found for date range - IV Skew strategy will have no signals');
      }
    }

    // Load Short-DTE IV data for Short-DTE IV strategy
    const isShortDTEIVStrategy = this.config.strategy === 'short-dte-iv' ||
                                  this.config.strategy === 'sdiv';
    if (isShortDTEIVStrategy) {
      await this.shortDTEIVLoader.load(this.config.startDate, this.config.endDate);
      const sdivStats = this.shortDTEIVLoader.getStats();
      if (!this.config.quiet && sdivStats.count > 0) {
        console.log(`📈 Short-DTE IV data: ${sdivStats.count} records (${sdivStats.startDate?.split('T')[0]} to ${sdivStats.endDate?.split('T')[0]})`);
        console.log(`   DTE0: ${sdivStats.dte0Count} readings, avg IV=${sdivStats.avgDTE0IV?.toFixed(3)} | DTE1: ${sdivStats.dte1Count} readings, avg IV=${sdivStats.avgDTE1IV?.toFixed(3)}`);
      } else if (!this.config.quiet && sdivStats.count === 0) {
        console.warn('⚠️  No Short-DTE IV data found - run scripts/precompute-short-dte-iv.js first');
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

    // Load swing pivot data for gex-flip-ivpct's magnet-aware MFE ratchet.
    // Strategy params signal whether to load (set magnetRatchet=true).
    const wantMagnetRatchet = isGexFlipIvpctStrategy && this.config.strategyParams?.magnetRatchet;
    if (wantMagnetRatchet) {
      const swingFile = this.config.swingPivotFile || path.join(this.config.dataDir, '..', 'research', 'swing-pivots', 'NQ_swings_1m_9_9.csv');
      this.swingPivotLoader = new SwingPivotLoader(swingFile);
      await this.swingPivotLoader.load(this.config.startDate, this.config.endDate);
      const stats = this.swingPivotLoader.getStats();
      if (!this.config.quiet && stats.count > 0) {
        console.log(`📍 Swing pivots: ${stats.count} (${stats.highs}H/${stats.lows}L) ${stats.startDate?.split('T')[0]} → ${stats.endDate?.split('T')[0]}`);
      } else if (!this.config.quiet) {
        console.warn(`⚠️  No swing pivots loaded — magnet ratchet will be inactive`);
      }
      this.swingPivotsLoaded = stats.count > 0;
    }

    // Load Charm/Vanna data for overnight ES strategy
    const isCharmVannaStrategy = this.config.strategy === 'overnight-charm-vanna' ||
                                  this.config.strategy === 'ocv';
    if (isCharmVannaStrategy) {
      await this.charmVannaLoader.loadDaily(this.config.startDate, this.config.endDate);
      const cvStats = this.charmVannaLoader.getStats();
      if (!this.config.quiet && cvStats.dailyCount > 0) {
        console.log(`📊 Charm/Vanna data: ${cvStats.dailyCount} daily records (${cvStats.startDate} to ${cvStats.endDate})`);
        console.log(`   Avg CEX: ${cvStats.avgCex?.toExponential(2)} | Avg VEX: ${cvStats.avgVex?.toExponential(2)}`);
      } else if (!this.config.quiet && cvStats.dailyCount === 0) {
        console.warn('⚠️  No Charm/Vanna data found - run scripts/precompute-charm-vanna.py first');
      }
      this.charmVannaDataLoaded = cvStats.dailyCount > 0;
    }

    return {
      candles: aggregatedCandles,        // For strategy entry signals
      originalCandles: ohlcvData,        // For 1m exit monitoring
      fvgCandles: fvgCandles,           // For FVG detection (15m timeframe)
      gexLevels: gexData,
      gexLoader: this.gexLoader,         // Pass loader for 15-min timestamp lookups
      liquidityLevels: liquidityData,
      liquidityLevels1m: liquidityData1m,
      lsState1m: lsData1m,
      calendarSpreads: calendarSpreads,  // For contract transition tracking
      marketDataLookup: marketDataLookup,
      cvdMap: this.cvdMap,               // CVD data aligned to candle timestamps (Phase 3)
      bookImbalanceMap: this.bookImbalanceMap,  // Book imbalance data (Phase 4)
      ivLoader: this.ivLoader,           // IV data for IV Skew GEX strategy
      shortDTEIVLoader: isShortDTEIVStrategy ? this.shortDTEIVLoader : null,  // Short-DTE IV data
      cbboLoader: this.cbboDataLoaded ? this.cbboLoader : null,  // CBBO data for volatility strategy
      charmVannaLoader: this.charmVannaDataLoaded ? this.charmVannaLoader : null,  // Charm/Vanna data
      swingPivotLoader: this.swingPivotsLoaded ? this.swingPivotLoader : null,     // Swing pivot data (gex-flip-ivpct magnet ratchet)
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
  async _loadLt1mFile(filePath, startDate, endDate) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      // Also try data dir relative
      const dataRelative = path.join(this.config.dataDir, filePath);
      if (fs.existsSync(dataRelative)) return this._loadLt1mFile(dataRelative, startDate, endDate);
      throw new Error(`--lt-1m-file path not found: ${filePath}`);
    }
    const startMs = startDate.getTime();
    const endMs = endDate.getTime() + 24 * 3600000;
    const records = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(absPath).pipe(csv())
        .on('data', (row) => {
          // Schema produced by research/lt-extraction/parse-lt-export.js
          let ts = parseInt(row.unix_ms, 10);
          if (isNaN(ts) && row.timestamp_iso) ts = new Date(row.timestamp_iso).getTime();
          if (isNaN(ts) || ts < startMs || ts > endMs) return;
          const levels = [
            parseFloat(row.level_1),
            parseFloat(row.level_2),
            parseFloat(row.level_3),
            parseFloat(row.level_4),
            parseFloat(row.level_5),
          ];
          // Drop warmup rows where any level is NaN
          if (levels.some(v => isNaN(v))) return;
          records.push({
            timestamp: ts,
            level_1: levels[0], level_2: levels[1], level_3: levels[2],
            level_4: levels[3], level_5: levels[4],
            sentiment: row.sentiment_raw || null,
          });
        })
        .on('end', resolve).on('error', reject);
    });
    records.sort((a, b) => a.timestamp - b.timestamp);
    return records;
  }

  /**
   * Load 1m LS (Liquidity Status) flip CSV (--ls-1m-file). Schema:
   *   timestamp_iso, unix_ms, state (0|1), source_symbol
   * Each row is a state-change event (Pine emits only on flip).
   * Returns [{ timestamp, state, sourceSymbol }] sorted ascending by ts.
   */
  async _loadLs1mFile(filePath, startDate, endDate) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      const dataRelative = path.join(this.config.dataDir, filePath);
      if (fs.existsSync(dataRelative)) return this._loadLs1mFile(dataRelative, startDate, endDate);
      throw new Error(`--ls-1m-file path not found: ${filePath}`);
    }
    const startMs = startDate.getTime();
    const endMs = endDate.getTime() + 24 * 3600000;
    const records = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(absPath).pipe(csv())
        .on('data', (row) => {
          let ts = parseInt(row.unix_ms, 10);
          if (isNaN(ts) && row.timestamp_iso) ts = new Date(row.timestamp_iso).getTime();
          if (isNaN(ts) || ts < startMs || ts > endMs) return;
          const state = parseInt(row.state, 10);
          if (state !== 0 && state !== 1) return;
          records.push({
            timestamp: ts,
            state,
            sourceSymbol: row.source_symbol || null,
          });
        })
        .on('end', resolve).on('error', reject);
    });
    records.sort((a, b) => a.timestamp - b.timestamp);
    // Since each record IS a state change, the very next record in the series
    // is by definition an adverse (opposite-state) flip. Precompute it so the
    // strategy/engine can cancel pending limits when an adverse flip occurs
    // before fill. Last record has no adverse flip in-sample → null.
    for (let i = 0; i < records.length; i++) {
      records[i].adverseFlipTs = (i + 1 < records.length) ? records[i + 1].timestamp : null;
    }
    return records;
  }

  /**
   * Load s1 VWAP feature CSV (--s1-vwap-file). Schema:
   *   timestamp,vwap_close_diff,vwap,close,n_bars
   * Returns [{ timestamp_ms, vwap_close_diff, vwap, close, n_bars }] in range.
   */
  async _loadS1VwapFile(filePath, startDate, endDate) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      const dataRelative = path.join(this.config.dataDir, filePath);
      if (fs.existsSync(dataRelative)) return this._loadS1VwapFile(dataRelative, startDate, endDate);
      throw new Error(`--s1-vwap-file path not found: ${filePath}`);
    }
    const startMs = startDate.getTime();
    const endMs = endDate.getTime() + 24 * 3600000;
    const records = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(absPath).pipe(csv())
        .on('data', (row) => {
          const ts = new Date(row.timestamp).getTime();
          if (isNaN(ts) || ts < startMs || ts > endMs) return;
          const diff = parseFloat(row.vwap_close_diff);
          if (isNaN(diff)) return;
          records.push({
            timestamp: ts,
            vwap_close_diff: diff,
            vwap: parseFloat(row.vwap),
            close: parseFloat(row.close),
            n_bars: parseInt(row.n_bars, 10) || 0,
          });
        })
        .on('end', resolve).on('error', reject);
    });
    records.sort((a, b) => a.timestamp - b.timestamp);
    return records;
  }

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

    // Load swing pivots into strategy (gex-flip-ivpct magnet ratchet)
    if (data.swingPivotLoader && this.strategy.loadSwingPivots) {
      this.strategy.loadSwingPivots(data.swingPivotLoader);
    }

    // Load Short-DTE IV data into strategy if available
    if (data.shortDTEIVLoader && this.strategy.loadShortDTEIVData) {
      this.strategy.loadShortDTEIVData(data.shortDTEIVLoader);
      const stats = data.shortDTEIVLoader.getStats();
      if (!this.config.quiet && stats.count > 0) {
        console.log(`📈 Short-DTE IV data loaded into strategy (${stats.count} records)`);
      }
    }

    // Load LT data into strategy if available (LT Failed Breakdown strategy)
    if (data.liquidityLevels && this.strategy.loadLTData) {
      this.strategy.loadLTData(data.liquidityLevels);
      if (!this.config.quiet) {
        console.log(`📈 LT data loaded into strategy (${data.liquidityLevels.length} records)`);
      }
    }

    // Load Charm/Vanna data into strategy if available (Overnight Charm/Vanna strategy)
    if (data.charmVannaLoader && this.strategy.loadCharmVannaData) {
      this.strategy.loadCharmVannaData(data.charmVannaLoader);
      const stats = data.charmVannaLoader.getStats();
      if (!this.config.quiet) {
        console.log(`📊 Charm/Vanna data loaded into strategy (${stats.dailyCount} days)`);
      }
    }

    // Initialize trade simulator with calendar spread data
    if (data.calendarSpreads && data.calendarSpreads.length > 0) {
      this.tradeSimulator.initializeCalendarSpreads(data.calendarSpreads);
    }

    // Pass IV loader to trade simulator for per-trade IV tracking
    if (data.ivLoader) {
      this.tradeSimulator.setIVLoader(data.ivLoader);
      if (!this.config.quiet) {
        console.log('📊 IV tracking enabled: per-trade IV/skew at entry, during, and exit');
      }
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

      // Save start index for potential same-candle fill replay after signal generation
      const periodCandle1mStart = candleIndex1m;

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

              // Notify strategy of trade completion (for daily P&L tracking, loss limits, etc.)
              if (typeof this.strategy.onPositionClosed === 'function') {
                const entryPrice = update.actualEntry || update.entryPrice;
                const exitPrice = update.actualExit;
                const pnlPoints = update.side === 'buy' || update.side === 'long'
                  ? exitPrice - entryPrice
                  : entryPrice - exitPrice;
                this.strategy.onPositionClosed({
                  pnl: pnlPoints,
                  timestamp: update.exitTime,
                  metadata: update.metadata || {},
                });
              }

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
      const marketData = this.getMarketDataForTimestamp(candle.timestamp, data.marketDataLookup, data, candle.close);

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
      let signal = null;
      let order = null;
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

        // Pre-fetch 1-second candles for strategies that need intra-bar microstructure
        const dataReqs = this.strategy.constructor.getDataRequirements?.();
        if (this.secondDataProvider && dataReqs?.secondData) {
          const secondCandles = await this.secondDataProvider.getSecondsForMinute(candle.timestamp);
          marketData.secondCandles = secondCandles;
        }

        signal = this.strategy.evaluateSignal(candle, prevCandle, marketData, options);

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

          // Add MFE ratchet config to signal if enabled
          if (this.config.strategyParams?.mfeRatchet) {
            signal.mfeRatchet = true;
            if (this.config.strategyParams.mfeRatchetTiers) {
              signal.mfeRatchetConfig = { tiers: this.config.strategyParams.mfeRatchetTiers };
            }
          }

          // Add fibRetrace config to signal if enabled (additive bar-close exit).
          // If the strategy already emitted signal.fibRetrace (e.g. via
          // resolveConditionalFibConfig), respect what it produced — that path
          // may also have intentionally OMITTED fib for some signals (e.g. S2
          // rule under --gfi-fib-conditional). Only overwrite when the strategy
          // didn't touch the field at all.
          if (this.config.strategyParams?.fibRetrace && signal.fibRetrace === undefined) {
            signal.fibRetrace = true;
            signal.fibRetraceConfig = {
              retracePct: this.config.strategyParams.fibRetracePct ?? 0.786,
              activationMFE: this.config.strategyParams.fibActivationMFE ?? 40,
            };
          }

          // Add composite trailing config to signal if enabled via CLI
          // (only if signal doesn't already set it — strategies like ICT MTF Sweep set it directly)
          if (this.config.strategyParams?.useCompositeTrailing && !signal.compositeTrailing) {
            signal.compositeTrailing = true;
            signal.compositeConfig = {
              entryZone: signal.metadata?.entryZone || null,
              structuralEnabled: true,
              structuralThreshold: this.config.strategyParams.compositeStructuralThreshold ?? 5,
              swingLookback: this.config.strategyParams.compositeSwingLookback ?? 5,
              swingBuffer: this.config.strategyParams.compositeSwingBuffer ?? 5,
              minSwingSize: this.config.strategyParams.compositeMinSwingSize ?? 3,
              aggressiveThreshold: this.config.strategyParams.compositeAggressiveThreshold ?? 30,
              aggressiveTiers: [
                { mfe: 30, trailDistance: 20 },
                { mfe: 50, trailDistance: 15 },
                { mfe: 80, trailDistance: 10 },
              ],
              targetProximity: true,
              proximityPct: this.config.strategyParams.compositeProximityPct ?? 0.20,
              proximityTrailDistance: this.config.strategyParams.compositeProximityTrailDistance ?? 5,
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

          if (this.captureSignalsMode) {
            // Capture-only branch: record the signal and SKIP the simulator.
            // Engine stays always-flat so every trigger fires (no position gate).
            // We strip the bulky `availableLTLevels` payload — it's the full
            // session LT history attached for analysis. Sub-rule metadata
            // (ruleId/Description/Priority, stop/target pts) stays on `metadata`.
            const { availableLTLevels, ...slim } = signal;
            this.capturedSignals.push({
              ts: signalTime,
              strategy: this.config.strategy,
              symbol: signal.symbol,
              signalContract: signal.signalContract,
              side: signal.side,
              action: signal.action || (signal.price ? 'place_limit' : 'place_market'),
              entryPrice: signal.price || signal.entryPrice,
              stopLoss: signal.stop_loss || signal.stopLoss,
              takeProfit: signal.take_profit || signal.takeProfit,
              stopPoints: signal.stopPoints,
              targetPoints: signal.targetPoints,
              // CRITICAL for re-anchoring SL/TP from actualEntry. Strategies
              // like ls-flip-trigger-bar and gex-level-fade set these, and
              // trade-simulator.checkOrderFill recalculates stopLoss/takeProfit
              // from actualEntry ± distance whenever present. Without these
              // fields the meta-engine can't reproduce gold-standard exits
              // on price-improvement fills.
              stopDistance: signal.stopDistance,
              targetDistance: signal.targetDistance,
              // lstb sets this to the next LS flip's ts so a flip in the
              // opposite direction cancels the pending limit before fill.
              // Without this, the meta-engine fills limits that the original
              // engine would have killed via 'pre_fill_adverse_flip'.
              adverseFlipCancelTs: signal.adverseFlipCancelTs,
              maxHoldBars: signal.maxHoldBars || signal.max_hold_bars,
              timeoutCandles: signal.timeoutCandles,
              cancelOnPreFillExtreme: signal.cancelOnPreFillExtreme,
              trailingTrigger: signal.trailingTrigger || signal.trailing_trigger,
              trailingOffset: signal.trailingOffset || signal.trailing_offset,
              breakevenStop: signal.breakevenStop || signal.breakeven_stop,
              breakevenTrigger: signal.breakevenTrigger || signal.breakeven_trigger,
              breakevenOffset: signal.breakevenOffset || signal.breakeven_offset,
              fibRetrace: signal.fibRetrace,
              fibRetraceConfig: signal.fibRetraceConfig,
              mfeRatchet: signal.mfeRatchet,
              mfeRatchetConfig: signal.mfeRatchetConfig,
              ruleId: signal.ruleId ?? slim.metadata?.ruleId ?? null,
              ruleDescription: signal.ruleDescription ?? slim.metadata?.ruleDescription ?? null,
              rulePriority: signal.rulePriority ?? slim.metadata?.rulePriority ?? null,
              metadata: slim.metadata || null,
            });
          } else {
            // Process signal through trade simulator with correct signal time
            order = this.tradeSimulator.processSignal(signal, signalTime);
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
      }

      // Same-candle fill: replay 1-second data to fill limit orders on the signal candle.
      // This enables strategies that detect events (e.g., GEX level touch) on a higher
      // timeframe candle, then fill the limit order at exact 1s resolution within that candle.
      if (signal && signal.sameCandleFill && this.secondDataProvider && this.tradeSimulator.hasActiveTrades()) {
        const pendingOrders = this.tradeSimulator.getPendingOrders();
        if (pendingOrders.length > 0) {
          for (let j = periodCandle1mStart; j < candleIndex1m; j++) {
            const replayCandle1m = data.originalCandles[j];
            if (replayCandle1m.timestamp < candleStartTime) continue;

            if (!this.tradeSimulator.hasActiveTrades()) break;

            const secondCandles = await this.secondDataProvider.getSecondsForMinute(replayCandle1m.timestamp);
            const replayUpdates = this.tradeSimulator.updateActiveTradesWithSeconds(secondCandles, replayCandle1m);

            // Track LT level hits during replay
            this.tradeSimulator.getActiveTrades().forEach(activeTrade => {
              ltAnalyzer.updateLevelHits(activeTrade.id, replayCandle1m);
            });

            replayUpdates.forEach(update => {
              if (update.status === 'completed') {
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
                  console.log(`\n${pnlColor} Trade ${update.id} completed (same-candle): ${update.exitReason} | P&L: $${update.netPnL.toFixed(2)}`);
                }
              }
            });
          }

          // Cancel any pending orders that didn't fill during replay
          const stillPending = this.tradeSimulator.getPendingOrders();
          for (const pending of stillPending) {
            if (pending.signal?.sameCandleFill) {
              this.tradeSimulator.cancelPendingOrder(pending.id, 'same_candle_no_fill');
              if (!this.config.quiet && this.config.verbose) {
                console.log(`\n⏸️  Same-candle limit at ${pending.entryPrice} did not fill on 1s data — cancelled`);
              }
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
  createMarketDataLookup(gexData, liquidityData, liquidityData1m = null, s1VwapData = null, lsData1m = null) {
    const lookup = {
      gex: new Map(),
      liquidity: new Map(),
      liquidity1m: null,        // direct ts → record (exact-match fast path)
      liquidity1mSorted: null,  // sorted ts array for at-or-before fallback
      s1Vwap: null,             // ts → vwap_close_diff (gex-touch-confirm)
      lsState1m: null,          // ts → {timestamp, state} (ls-flip-trigger-bar)
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

    // Index 1m LT data: hashmap for direct lookup + sorted array for fallback
    if (liquidityData1m && liquidityData1m.length) {
      lookup.liquidity1m = new Map();
      const sortedTs = [];
      for (const lt of liquidityData1m) {
        const t = lt.timestamp;
        lookup.liquidity1m.set(t, lt);
        sortedTs.push(t);
      }
      sortedTs.sort((a, b) => a - b);
      lookup.liquidity1mSorted = sortedTs;
    }

    // Index s1 VWAP feature data: hashmap for direct lookup by minute timestamp
    if (s1VwapData && s1VwapData.length) {
      lookup.s1Vwap = new Map();
      for (const r of s1VwapData) {
        lookup.s1Vwap.set(r.timestamp, r.vwap_close_diff);
      }
    }

    // Index 1m LS state changes (flips): hashmap by bar-start timestamp.
    // Each record IS a flip — Pine emits only on state change.
    if (lsData1m && lsData1m.length) {
      lookup.lsState1m = new Map();
      for (const r of lsData1m) {
        lookup.lsState1m.set(r.timestamp, r);
      }
    }

    return lookup;
  }

  /**
   * Get market data for a specific timestamp
   *
   * @param {number} timestamp - Target timestamp
   * @param {Object} lookup - Market data lookup
   * @param {Object} data - Full data object (for gexLoader access)
   * @param {number} actualPrice - Actual candle close price for GEX level correction
   * @returns {Object} Market data object
   */
  getMarketDataForTimestamp(timestamp, lookup, data = null, actualPrice = null) {
    let gexLevels = null;

    // Get 15-minute GEX levels from JSON loader (primary source)
    if (data && data.gexLoader && data.gexLoader.sortedTimestamps.length > 0) {
      gexLevels = data.gexLoader.getGexLevels(new Date(timestamp));
    }

    // Correct GEX levels for price space mismatch.
    // The GEX JSON files store futures_spot from raw OHLCV without primary contract filtering,
    // which can differ from the backtest engine's filtered OHLCV by up to ~1.6%.
    // Re-translate all levels using: corrected = original * (actualPrice / stored_futures_spot)
    // Only apply for continuous (back-adjusted) data — raw contracts are already in the same price space.
    const isContinuous = !this.config.noContinuous;
    if (isContinuous && gexLevels && actualPrice && gexLevels.futures_spot && gexLevels.futures_spot > 0) {
      const correction = actualPrice / gexLevels.futures_spot;
      // Only correct if there's a meaningful difference (> 0.01%)
      if (Math.abs(correction - 1.0) > 0.0001) {
        const correctLevel = (level) => level != null ? Math.round(level * correction * 100) / 100 : level;
        gexLevels = {
          ...gexLevels,
          gamma_flip: correctLevel(gexLevels.gamma_flip),
          call_wall: correctLevel(gexLevels.call_wall),
          put_wall: correctLevel(gexLevels.put_wall),
          support: (gexLevels.support || []).map(correctLevel),
          resistance: (gexLevels.resistance || []).map(correctLevel),
          // Update compatibility aliases
          nq_gamma_flip: correctLevel(gexLevels.nq_gamma_flip),
          nq_put_wall_1: correctLevel(gexLevels.nq_put_wall_1),
          nq_put_wall_2: correctLevel(gexLevels.nq_put_wall_2),
          nq_put_wall_3: correctLevel(gexLevels.nq_put_wall_3),
          nq_call_wall_1: correctLevel(gexLevels.nq_call_wall_1),
          nq_call_wall_2: correctLevel(gexLevels.nq_call_wall_2),
          nq_call_wall_3: correctLevel(gexLevels.nq_call_wall_3),
          spot_price: actualPrice,
          futures_spot: actualPrice,
          _priceSpaceCorrected: true,
          _correctionFactor: correction,
        };
      }
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

    // 1m LT lookup: direct hashmap + binary-search fallback for nearest
    // at-or-before record within a small window. Used by strategies that
    // need 1m-cadence LT (e.g. gex-lt-3m-crossover).
    let liquidityLevels1m = null;
    if (lookup && lookup.liquidity1m) {
      liquidityLevels1m = lookup.liquidity1m.get(timestamp);
      if (!liquidityLevels1m && lookup.liquidity1mSorted) {
        const arr = lookup.liquidity1mSorted;
        // Binary search for largest ts <= timestamp
        let lo = 0, hi = arr.length - 1, idx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          if (arr[mid] <= timestamp) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (idx >= 0) {
          // Only accept if within 5 min (avoids stale fills near gaps)
          if (timestamp - arr[idx] <= 5 * 60 * 1000) {
            liquidityLevels1m = lookup.liquidity1m.get(arr[idx]);
          }
        }
      }
    }

    // s1 VWAP feature lookup (gex-touch-confirm strategy). Keyed by 1m timestamp.
    let s1Features = null;
    if (lookup && lookup.s1Vwap) {
      const minuteTs = Math.floor(timestamp / 60000) * 60000;
      const diff = lookup.s1Vwap.get(minuteTs);
      if (diff != null) s1Features = { vwap_close_diff: diff };
    }

    // 1m LS state lookup (ls-flip-trigger-bar). Exact-match only — flips occur
    // on bar boundaries and stale records do not represent the current bar.
    let lsState1m = null;
    if (lookup && lookup.lsState1m) {
      lsState1m = lookup.lsState1m.get(timestamp) || null;
    }

    return {
      gexLevels: gexLevels,
      ltLevels: liquidityLevels,
      ltLevels1m: liquidityLevels1m,       // 1m LT for gex-lt-3m-crossover
      s1Features: s1Features,              // s1 VWAP features for gex-touch-confirm
      lsState1m: lsState1m,                // 1m LS flip record for ls-flip-trigger-bar
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
      case 'gex-flip-ivpct':
      case 'gfi':
        return new GexFlipIvpctStrategy(params);
      case 'gex-lt-3m-crossover':
      case 'gex-lt-cross':
      case 'glx':
        return new GexLt3mCrossoverStrategy(params);
      case 'ls-flip-trigger-bar':
      case 'ls-flip':
      case 'lstb':
        return new LsFlipTriggerBarStrategy(params);
      case 'gex-touch-confirm':
      case 'gex-touch':
      case 'gtc':
        return new GexTouchConfirmStrategy(params);
      case 'gex-touch-patterns':
      case 'gtp':
        return new GexTouchPatternsStrategy(params);
      case 'gex-structural-resist':
      case 'gsr':
        return new GexStructuralResistStrategy(params);
      case 'gex-level-fade':
      case 'glf':
        return new GexLevelFadeStrategy(params);
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
      case 'overnight-gex-touch':
      case 'overnight-gex':
      case 'ogt':
        return new OvernightGexTouchStrategy(params);
      case 'overnight-charm-vanna':
      case 'ocv':
        return new OvernightCharmVannaStrategy(params);
      case 'es-cross-signal':
      case 'es-cross':
      case 'ecs':
        return new ESCrossSignalStrategy(params);
      case 'es-micro-scalper':
      case 'es-micro':
      case 'esms':
        return new ESMicroScalperStrategy(params);
      case 'es-stop-hunt':
      case 'es-hunt':
      case 'esh':
        return new EsStopHuntStrategy(params);
      case 'ohlcv-absorption':
      case 'absorption-detect':
      case 'abs':
        return new OHLCVAbsorptionStrategy(params);
      case 'ohlcv-liquidity-sweep':
      case 'liquidity-sweep':
      case 'lsweep':
        return new OHLCVLiquiditySweepStrategy(params);
      case 'ohlcv-vpin':
      case 'vpin':
        return new OHLCVVPINStrategy(params);
      case 'ohlcv-mtf-rejection':
      case 'mtf-rejection':
      case 'mtfr':
        return new OHLCVMTFRejectionStrategy(params);
      case 'momentum-microstructure':
      case 'momentum-micro':
      case 'mm':
        console.warn('Warning: momentum-microstructure evaluates on 1s ticks. Use the standalone runner for accurate results:');
        console.warn('  node scripts/run-momentum-microstructure-backtest.js');
        return new MomentumMicrostructureStrategy(params);
      case 'midnight-open-retracement':
      case 'midnight-open':
      case 'mor':
        return new MidnightOpenRetracementStrategy(params);
      case 'initial-balance-breakout':
      case 'ib-breakout':
      case 'ibb':
        return new InitialBalanceBreakoutStrategy(params);
      case 'gap-fill':
      case 'gap':
        return new GapFillStrategy(params);
      case 'daily-level-sweep':
      case 'daily-sweep':
      case 'dls':
        return new DailyLevelSweepStrategy(params);
      case 'vwap-bounce':
      case 'vwap':
        return new VWAPBounceStrategy(params);
      case 'session-transition':
      case 'session':
      case 'st':
        return new SessionTransitionStrategy(params);
      case 'value-area-80':
      case 'va80':
        return new ValueArea80Strategy(params);
      case 'swing-reversal':
      case 'sr':
        return new SwingReversalStrategy(params);
      case 'ict-silver-bullet':
      case 'silver-bullet':
      case 'isb':
        return new ICTSilverBulletStrategy(params);
      case 'price-action-exhaustion':
      case 'pa-exhaust':
      case 'pae':
        return new PriceActionExhaustionStrategy(params);
      case 'ict-mtf-sweep':
      case 'mtf-sweep':
      case 'jv':
        return new ICTMTFSweepStrategy(params);
      case 'dc-st1':
      case 'dc1':
        return new DCSt1Strategy(params);
      case 'dc-st2':
      case 'dc2':
        return new DCSt2Strategy(params);
      case 'dc-st3':
      case 'dc3':
        return new DCSt3Strategy(params);
      case 'dc-st4':
      case 'dc4':
        return new DCSt4Strategy(params);
      case 'dc-st5':
      case 'dc5':
        return new DCSt5Strategy(params);
      case 'dc-st6':
      case 'dc6':
        return new DCSt6Strategy(params);
      case 'dc-st7':
      case 'dc7':
        return new DCSt7Strategy(params);
      case 'dc-st8':
      case 'dc8':
        return new DCSt8Strategy(params);
      case 'dc-mstgam':
      case 'mstgam':
        return new DCMSTGAMStrategy(params);
      case 'mnq-adaptive-scalper':
      case 'mnq-scalper':
      case 'mnq':
        return new MnqAdaptiveScalperStrategy(params);
      case 'sweep-reversal':
      case 'sweep-rev':
        return new SweepReversalStrategy(params);
      case 'nq-leads-es':
      case 'nq-lead':
      case 'nle':
        return new NqLeadsEsStrategy(params);
      case 'gex-support-bounce':
      case 'gex-bounce':
      case 'gsb':
        return new GexSupportBounceStrategy(params);
      case 'impulse-fvg':
      case 'impulse':
      case 'ifvg':
        return new ImpulseFVGStrategy(params);
      case 'short-dte-iv':
      case 'sdiv':
        return new ShortDTEIVStrategy(params);
      case 'overnight-scoring':
      case 'overnight-score':
      case 'ons':
        return new OvernightScoringStrategy(params);
      case 'overnight-composite':
      case 'overnight-comp':
      case 'onc':
        return new OvernightCompositeStrategy(params);
      case 'overnight-lt-crossing':
      case 'overnight-ltx':
      case 'oltx':
        return new OvernightLTCrossingStrategy(params);
      case 'lt-crossover':
      case 'ltx':
        return new LTCrossoverStrategy(params);
      case 'lt-structure-confirm':
      case 'ltsc':
      case 'lt-struct':
        return new LTStructureConfirmStrategy(params);
      case 'lt-candle-regime':
      case 'lt-regime':
      case 'lcr':
        return new LTCandleRegimeStrategy(params);
      case 'gamma-regime-drift':
      case 'grd':
        return new GammaRegimeDriftStrategy(params);
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
  /**
   * Export captured signals (capture mode only) to a JSON file.
   * Output shape: { strategy, startDate, endDate, count, signals: [...] }.
   * Used by the meta-strategy-trader pipeline to consume the full
   * per-strategy setup universe (see research/meta-strategy-trader/).
   */
  exportCapturedSignalsToJSON(filePath) {
    if (!this.captureSignalsMode) {
      console.log('⚠️  exportCapturedSignalsToJSON called outside capture mode — nothing to write');
      return;
    }
    const payload = {
      strategy: this.config.strategy,
      startDate: this.config.startDate,
      endDate: this.config.endDate,
      timeframe: this.config.timeframe,
      strategyParams: this.config.strategyParams || {},
      count: this.capturedSignals.length,
      signals: this.capturedSignals,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    console.log(`📡 Captured ${this.capturedSignals.length} signals → ${filePath}`);
  }

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
      'LTSentiment', 'LTOrdering', 'LTSpacing', 'LTLdmpType', 'LTAvgSpacing', 'FilterReason',
      // Trade execution details
      'StopLoss', 'TakeProfit', 'MFEPoints', 'MAEPoints', 'ProfitGiveBack',
      // Strategy-specific metadata (JSON)
      'StrategyMetadata'
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
        m.filter_reason || '',
        // Trade execution details
        trade.stopLoss ?? '',
        trade.takeProfit ?? '',
        trade.mfePoints ?? '',
        trade.maePoints ?? '',
        trade.profitGiveBack ?? '',
        // Strategy-specific metadata as JSON (quote to avoid CSV delimiter issues)
        m && Object.keys(m).length > 0 ? `"${JSON.stringify(m).replace(/"/g, '""')}"` : ''
      ];
      csvRows.push(row.join(','));
    });

    fs.writeFileSync(filePath, csvRows.join('\n'));
  }
}