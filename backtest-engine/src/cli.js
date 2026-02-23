/**
 * CLI Interface for Backtesting Engine
 *
 * Handles command-line argument parsing and coordinates the backtesting process
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

import { BacktestEngine } from './backtest-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class CLI {
  constructor() {
    this.configPath = join(__dirname, 'config', 'default.json');
    this.defaultConfig = this.loadConfig();
  }

  loadConfig() {
    try {
      const configData = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      console.error(chalk.red('❌ Failed to load configuration:'), error.message);
      process.exit(1);
    }
  }

  async run(argv) {
    const args = await this.parseArguments(argv);
    await this.executeBacktest(args);
  }

  async parseArguments(argv) {
    return yargs(hideBin(argv))
      .usage('Usage: $0 [options]')
      .example('$0 --ticker NQ --start 2023-03-01 --end 2025-12-25', 'Basic backtest')
      .example('$0 --ticker NQ --start 2023-03-01 --end 2025-12-25 --strategy gex-recoil --timeframe 15m', 'Full configuration')

      .option('ticker', {
        alias: 't',
        type: 'string',
        description: 'Ticker symbol to backtest (e.g., NQ, ES)',
        demandOption: true
      })

      .option('start', {
        alias: 's',
        type: 'string',
        description: 'Start date (YYYY-MM-DD)',
        demandOption: true
      })

      .option('end', {
        alias: 'e',
        type: 'string',
        description: 'End date (YYYY-MM-DD)',
        demandOption: true
      })

      .option('strategy', {
        type: 'string',
        description: 'Strategy to backtest',
        default: 'gex-recoil',
        choices: ['gex-recoil', 'gex-recoil-enhanced', 'gex-ldpm-confluence', 'gex-ldpm-confluence-pullback', 'contrarian-bounce', 'gex-scalp', 'gex-scalp-confirmed', 'ict-smc', 'ict-ob', 'ldpm-level-sweep', 'order-flow-momentum', 'ofm', 'contrarian-orderflow', 'cof', 'gex-absorption', 'absorption', 'iv-skew-gex', 'iv-skew', 'cbbo-lt-volatility', 'cbbo-lt', 'gex-mean-reversion', 'gex-mr', 'lt-failed-breakdown', 'lt-fb', 'lt-level-crossing', 'lt-cross', 'lt-level-migration', 'lt-mig', 'regime-scalp', 'rs', 'gex-level-sweep', 'gex-sweep', 'sweep', 'micro-structure-scalper', 'micro-scalper', 'mss', 'trend-scalp', 'ts', 'level-bounce', 'lb', 'overnight-gex-touch', 'overnight-gex', 'ogt', 'overnight-charm-vanna', 'ocv', 'es-cross-signal', 'es-cross', 'ecs', 'es-micro-scalper', 'es-micro', 'esms', 'es-stop-hunt', 'es-hunt', 'esh', 'ohlcv-absorption', 'absorption-detect', 'abs', 'ohlcv-liquidity-sweep', 'liquidity-sweep', 'lsweep', 'ohlcv-vpin', 'vpin', 'ohlcv-mtf-rejection', 'mtf-rejection', 'mtfr', 'momentum-microstructure', 'momentum-micro', 'mm', 'midnight-open-retracement', 'midnight-open', 'mor', 'initial-balance-breakout', 'ib-breakout', 'ibb', 'gap-fill', 'gap', 'daily-level-sweep', 'daily-sweep', 'dls', 'vwap-bounce', 'vwap', 'session-transition', 'session', 'st', 'value-area-80', 'va80', 'swing-reversal', 'sr', 'ict-silver-bullet', 'silver-bullet', 'isb', 'price-action-exhaustion', 'pa-exhaust', 'pae', 'ict-mtf-sweep', 'mtf-sweep', 'jv']
      })

      .option('timeframe', {
        alias: 'tf',
        type: 'string',
        description: 'Chart timeframe',
        default: this.defaultConfig.backtesting.defaultTimeframe,
        choices: ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d']
      })

      .option('commission', {
        alias: 'c',
        type: 'number',
        description: 'Round-trip commission per contract',
        default: this.defaultConfig.backtesting.commission
      })

      .option('capital', {
        type: 'number',
        description: 'Initial capital',
        default: this.defaultConfig.backtesting.initialCapital
      })

      .option('data-dir', {
        type: 'string',
        description: 'Custom data directory path',
        default: join(__dirname, '..', 'data')
      })

      .option('output-json', {
        alias: 'o',
        type: 'string',
        description: 'Output JSON file path'
      })

      .option('output', {
        type: 'string',
        description: 'Output JSON file path (alias for --output-json)'
      })

      .option('output-csv', {
        type: 'string',
        description: 'Output trades CSV file path'
      })

      .option('verbose', {
        alias: 'v',
        type: 'boolean',
        description: 'Verbose output',
        default: false
      })

      .option('quiet', {
        alias: 'q',
        type: 'boolean',
        description: 'Suppress console output',
        default: false
      })

      .option('show-trades', {
        type: 'boolean',
        description: 'Show individual trades in console output',
        default: false
      })

      .option('minute-resolution', {
        type: 'boolean',
        description: 'Disable 1-second data for trade execution (use 1-minute instead)',
        default: false
      })

      .option('raw-contracts', {
        type: 'boolean',
        description: 'Use raw contract data instead of back-adjusted continuous (required when GEX levels are in absolute price space)',
        default: false
      })

      // Strategy-specific parameters
      .group(['target-points', 'stop-buffer', 'stop-loss-points', 'max-risk', 'max-bars-after-sweep', 'use-liquidity-filter', 'use-structural-stops'], 'Strategy Parameters:')

      .option('target-points', {
        type: 'number',
        description: 'Target profit in points (defaults to strategy config)'
      })

      .option('stop-buffer', {
        type: 'number',
        description: 'Stop loss buffer in points (defaults to strategy config)'
      })

      .option('stop-loss-points', {
        type: 'number',
        description: 'Stop loss distance in points (defaults to strategy config)'
      })

      .option('max-risk', {
        type: 'number',
        description: 'Maximum risk per trade in points (defaults to strategy config)'
      })

      .option('max-bars-after-sweep', {
        type: 'number',
        description: 'Maximum bars to wait for momentum alignment after GEX level sweep (defaults to strategy config)'
      })

      .option('use-liquidity-filter', {
        type: 'boolean',
        description: 'Enable liquidity trigger filter (defaults to strategy config)'
      })

      .option('use-structural-stops', {
        type: 'boolean',
        description: 'Use structural sweep stops instead of fixed stops (defaults to strategy config)'
      })

      // GEX Scalp Confirmed Parameters
      .group(['use-fixed-stops', 'zone-size', 'level-buffer', 'confirmation-timeout', 'max-stop-points', 'min-wick-ratio'], 'GEX Scalp Confirmed Parameters:')

      .option('use-fixed-stops', {
        type: 'boolean',
        description: 'Use fixed stops instead of dynamic confirmation-based stops (GEX Scalp Confirmed)',
        default: false
      })

      .option('zone-size', {
        type: 'number',
        description: 'Points above/below GEX level to define entry zone (GEX Scalp Confirmed)'
      })

      .option('level-buffer', {
        type: 'number',
        description: 'Price must get within this distance of level to trigger watching (GEX Scalp Confirmed)'
      })

      .option('confirmation-timeout', {
        type: 'number',
        description: 'Max candles to wait for confirmation pattern (GEX Scalp Confirmed)'
      })

      .option('max-stop-points', {
        type: 'number',
        description: 'Maximum allowed stop distance in points (GEX Scalp Confirmed)'
      })

      .option('min-wick-ratio', {
        type: 'number',
        description: 'Minimum wick-to-body ratio for hammer/shooting star detection (GEX Scalp Confirmed)'
      })

      // Trailing Stop Parameters
      .group(['use-trailing-stop', 'trailing-trigger', 'trailing-offset'], 'Trailing Stop:')

      .option('use-trailing-stop', {
        type: 'boolean',
        description: 'Enable trailing stop (profit protection)'
      })

      .option('trailing-trigger', {
        type: 'number',
        description: 'Points in profit before trailing stop activates'
      })

      .option('trailing-offset', {
        type: 'number',
        description: 'Points behind high water mark for trailing stop'
      })

      .option('breakeven-stop', {
        type: 'boolean',
        description: 'Enable breakeven stop (move stop to entry at trigger, keep target, no further trailing)',
        default: false
      })

      .option('breakeven-trigger', {
        type: 'number',
        description: 'Points in profit before stop moves to breakeven (defaults to trailing-trigger)'
      })

      .option('breakeven-offset', {
        type: 'number',
        description: 'Where to move stop: 0=breakeven, -30=allow 30pt loss (default: 0)',
        default: 0
      })

      // Zero Gamma Early Exit
      .group(['gf-early-exit', 'gf-breakeven-threshold', 'gf-exit-threshold'], 'Zero Gamma Early Exit:')

      .option('gf-early-exit', {
        type: 'boolean',
        description: 'Enable early exit based on consecutive adverse Zero Gamma movement',
        default: false
      })

      .option('gf-breakeven-threshold', {
        type: 'number',
        description: 'Consecutive adverse GF moves to trigger breakeven stop',
        default: 2
      })

      .option('gf-exit-threshold', {
        type: 'number',
        description: 'Consecutive adverse GF moves to force immediate exit',
        default: 3
      })

      // Hybrid Trailing Stop (Structure-Based Runner Capture)
      .group(['hybrid-trailing', 'structure-threshold', 'swing-lookback', 'swing-buffer', 'min-swing-size'], 'Hybrid Trailing Stop:')

      .option('hybrid-trailing', {
        type: 'boolean',
        description: 'Enable hybrid trailing stop (switches to swing-based trailing after threshold)',
        default: false
      })

      .option('structure-threshold', {
        type: 'number',
        description: 'Points profit before switching to structure-based trailing',
        default: 30
      })

      .option('swing-lookback', {
        type: 'number',
        description: 'Bars on each side to confirm swing low/high (with 1s data)',
        default: 5
      })

      .option('swing-buffer', {
        type: 'number',
        description: 'Points below swing low for stop placement',
        default: 5
      })

      .option('min-swing-size', {
        type: 'number',
        description: 'Minimum swing depth in points to be valid',
        default: 3
      })

      // Time-Based Trailing Stop (Progressive profit protection based on time + MFE)
      .group(['time-based-trailing', 'tb-rule-1', 'tb-rule-2', 'tb-rule-3'], 'Time-Based Trailing Stop:')

      .option('time-based-trailing', {
        type: 'boolean',
        description: 'Enable time-based trailing stop (progressive tightening based on bars held + profit level)',
        default: false
      })

      .option('tb-rule-1', {
        type: 'string',
        description: 'Rule 1: "bars,mfe,action" e.g. "15,20,breakeven" or "15,20,trail:10" (bars>=15, mfe>=20, breakeven or trail 10pts)',
        default: ''
      })

      .option('tb-rule-2', {
        type: 'string',
        description: 'Rule 2: "bars,mfe,action" e.g. "30,30,trail:20" (bars>=30, mfe>=30, trail 20pts behind)',
        default: ''
      })

      .option('tb-rule-3', {
        type: 'string',
        description: 'Rule 3: "bars,mfe,action" e.g. "45,40,trail:10" (bars>=45, mfe>=40, trail 10pts behind)',
        default: ''
      })

      // Composite Multi-Phase Trailing Stop (ICT methodology)
      .group(['composite-trailing', 'composite-activation-threshold', 'composite-zone-be', 'composite-structural-threshold', 'composite-aggressive-threshold', 'composite-proximity-pct'], 'Composite Trailing Stop:')

      .option('composite-trailing', {
        type: 'boolean',
        description: 'Enable composite multi-phase trailing stop'
      })

      .option('composite-activation-threshold', {
        type: 'number',
        description: 'MFE points before composite trailing engages (trade runs original stop until then)',
        default: 20
      })

      .option('composite-zone-be', {
        type: 'boolean',
        description: 'Enable zone breakeven (Phase 1) — moves stop to BE when price clears entry zone',
        default: false
      })

      .option('composite-structural-threshold', {
        type: 'number',
        description: 'MFE points to activate structural swing-based trailing (Phase 2)',
        default: 20
      })

      .option('composite-aggressive-threshold', {
        type: 'number',
        description: 'MFE points to activate aggressive progressive tightening (Phase 3)',
        default: 30
      })

      .option('composite-proximity-pct', {
        type: 'number',
        description: 'Within this % of target distance, activate tight trailing (Phase 4, 0-1)',
        default: 0.20
      })

      .option('longs-only', {
        type: 'boolean',
        description: 'Only trade long entries (support levels)'
      })

      .option('shorts-only', {
        type: 'boolean',
        description: 'Only trade short entries (resistance levels)'
      })

      .option('inverse-shorts', {
        type: 'boolean',
        description: 'Flip short signals to long (fade bearish signals)'
      })

      // LT Configuration Filtering
      .group(['filter-by-lt-config', 'lt-filter-profile', 'blocked-lt-orderings', 'blocked-ldmp-types', 'required-lt-sentiment'], 'LT Configuration Filters:')

      .option('filter-by-lt-config', {
        type: 'boolean',
        description: 'Enable LT configuration filtering based on performance analysis (defaults to strategy config)'
      })

      .option('lt-filter-profile', {
        type: 'string',
        description: 'LT filter profile: conservative (higher quality) or aggressive (more trades)',
        choices: ['conservative', 'aggressive', 'custom']
      })

      .option('blocked-lt-orderings', {
        type: 'string',
        description: 'Comma-separated LT orderings to block (ASCENDING, DESCENDING, MIXED)'
      })

      .option('blocked-ldmp-types', {
        type: 'string',
        description: 'Comma-separated LDMP types to block (e.g., BULLISH_REVERSAL,BEARISH_REVERSAL)'
      })

      .option('required-lt-sentiment', {
        type: 'string',
        description: 'Require specific LT sentiment (BULLISH performs 2x better than BEARISH)',
        choices: ['BULLISH', 'BEARISH']
      })

      .option('min-lt-spacing', {
        type: 'string',
        description: 'Minimum LT spacing (WIDE > MEDIUM > TIGHT performance)',
        choices: ['TIGHT', 'MEDIUM', 'WIDE']
      })

      // Session-based filtering
      .group(['use-session-filter', 'blocked-sessions'], 'Session Filtering:')

      .option('use-session-filter', {
        type: 'boolean',
        description: 'Enable session-based trade filtering (defaults to strategy config)'
      })

      .option('blocked-sessions', {
        type: 'string',
        description: 'Comma-separated sessions to block: overnight,premarket,afterhours,rth',
        default: ''
      })

      // Regime Filtering
      .group(['blocked-regimes'], 'Regime Filtering:')

      .option('blocked-regimes', {
        type: 'string',
        description: 'Comma-separated GEX regimes to block (e.g., strong_negative,negative)'
      })

      // SELL Time Filtering
      .group(['sell-start-hour-utc'], 'SELL Time Filtering:')

      .option('sell-start-hour-utc', {
        type: 'number',
        description: 'Only allow SELL trades after this hour (UTC). Default 13 = 8 AM EST. Set to 0 to disable.'
      })

      // ICT SMC Strategy Parameters
      .group(['signal-types', 'structure-timeframe', 'entry-timeframe', 'target-method', 'default-rr'], 'ICT SMC Strategy Parameters:')

      .option('signal-types', {
        type: 'string',
        description: 'Comma-separated ICT signal types to trade (M_PATTERN,W_PATTERN,OB_BOUNCE,MOMENTUM_CONTINUATION)'
      })

      .option('structure-timeframe', {
        type: 'string',
        description: 'Higher timeframe for structure analysis (ICT-SMC)',
        choices: ['15m', '30m', '1h', '4h', '1d'],
        default: '4h'
      })

      .option('entry-timeframe', {
        type: 'string',
        description: 'Lower timeframe for entry triggers (ICT-SMC)',
        choices: ['1m', '5m', '15m'],
        default: '5m'
      })

      .option('target-method', {
        type: 'string',
        description: 'Target calculation method (ICT-SMC)',
        choices: ['structure', 'rr_ratio', 'liquidity'],
        default: 'structure'
      })

      .option('default-rr', {
        type: 'number',
        description: 'Default risk:reward ratio for rr_ratio method (ICT-SMC)',
        default: 2.0
      })

      // Order Block Entry Filters (ICT-SMC)
      .group(['ob-time-in-zone-filter', 'time-in-zone-threshold', 'ob-range-filter', 'range-exclusion-zone'], 'Order Block Entry Filters (ICT-SMC):')

      .option('ob-time-in-zone-filter', {
        type: 'boolean',
        description: 'Invalidate OBs where price spent too much time consolidating inside the zone',
        default: false
      })

      .option('time-in-zone-threshold', {
        type: 'number',
        description: 'Percentage threshold (0-1) - if price spent more than this % of candles inside OB, invalidate it',
        default: 0.33
      })

      .option('ob-range-filter', {
        type: 'boolean',
        description: 'Filter OB entries by range context - avoid countertrend entries at range extremes',
        default: false
      })

      .option('range-exclusion-zone', {
        type: 'number',
        description: 'Percentage of range to exclude (0-1) - e.g., 0.20 means no shorts in bottom 20%, no longs in top 20%',
        default: 0.20
      })

      // GEX Proximity Filter (ICT-SMC)
      .group(['gex-proximity-filter', 'gex-proximity-threshold'], 'GEX Proximity Filter (ICT-SMC):')

      .option('gex-proximity-filter', {
        type: 'boolean',
        description: 'Filter trades by proximity to GEX levels (longs near support, shorts near resistance)',
        default: false
      })

      .option('gex-proximity-threshold', {
        type: 'number',
        description: 'Max distance in points to GEX level for trade to qualify (default: 20)',
        default: 20
      })

      // LTF Confirmation Parameters
      .group(['ltf-confirmation', 'ltf-timeout', 'ltf-wick-ratio'], 'LTF Confirmation (ICT-SMC):')

      .option('ltf-confirmation', {
        type: 'boolean',
        description: 'Enable LTF confirmation for OB entries - wait for sweep or pattern before entering',
        default: true
      })

      .option('ltf-timeout', {
        type: 'number',
        description: 'Max 1m candles to wait for LTF confirmation',
        default: 15
      })

      .option('ltf-wick-ratio', {
        type: 'number',
        description: 'Minimum wick-to-body ratio for hammer pattern detection',
        default: 2.0
      })

      // GEX Level Selection
      .group(['gex-levels', 'blocked-level-types'], 'GEX Level Configuration:')

      .option('gex-levels', {
        type: 'string',
        description: 'Comma-separated GEX levels to trade (e.g., "1" for S1/R1, "2" for S2/R2, "1,2" for both)',
        default: '1'
      })

      .option('blocked-level-types', {
        type: 'string',
        description: 'Comma-separated GEX level types to block (e.g., resistance_2,resistance_3)'
      })

      // LT Level Ordering Filters
      .group(['use-lt-ordering-filter', 'require-lt4-below-lt5', 'require-lt1-above-lt2', 'require-lt2-above-lt3'], 'LT Level Ordering Filters:')

      .option('use-lt-ordering-filter', {
        type: 'boolean',
        description: 'Enable LT level ordering-based trade filtering',
        default: false
      })

      .option('require-lt4-below-lt5', {
        type: 'boolean',
        description: 'Require LT4 < LT5 (42.5% vs 40.2% win rate improvement)',
        default: true
      })

      .option('require-lt1-above-lt2', {
        type: 'boolean',
        description: 'Require LT1 > LT2 (optional enhancement filter)',
        default: false
      })

      .option('require-lt2-above-lt3', {
        type: 'boolean',
        description: 'Require LT2 > LT3 (optional enhancement filter)',
        default: false
      })

      // Volume Filters (Phase 1 Order Flow)
      .group(['volume-delta-filter', 'volume-trend-filter', 'volume-spike-filter', 'volume-profile-filter'], 'Volume Filters (Order Flow Phase 1):')

      .option('volume-delta-filter', {
        type: 'boolean',
        description: 'Filter trades by volume delta proxy direction alignment',
        default: false
      })

      .option('volume-delta-lookback', {
        type: 'number',
        description: 'Lookback periods for volume delta slope calculation',
        default: 5
      })

      .option('volume-trend-filter', {
        type: 'boolean',
        description: 'Only enter when volume is trending up (increasing interest)',
        default: false
      })

      .option('volume-trend-period', {
        type: 'number',
        description: 'Period for volume trend SMA calculation',
        default: 5
      })

      .option('volume-spike-filter', {
        type: 'boolean',
        description: 'Require volume spike (above average) for entry confirmation',
        default: false
      })

      .option('volume-spike-threshold', {
        type: 'number',
        description: 'Volume spike threshold multiplier (1.5 = 50% above average)',
        default: 1.5
      })

      .option('volume-spike-period', {
        type: 'number',
        description: 'Lookback period for average volume calculation',
        default: 20
      })

      .option('volume-profile-filter', {
        type: 'boolean',
        description: 'Filter entries based on volume profile (near POC = good, in LVN = bad)',
        default: false
      })

      .option('volume-profile-poc-threshold', {
        type: 'number',
        description: 'Max distance in points from POC for entry to qualify',
        default: 10
      })

      // CVD Filters (Phase 3 Order Flow - True CVD from Databento)
      .group(['cvd-direction-filter', 'cvd-divergence-filter', 'cvd-zero-cross-filter'], 'CVD Filters (Order Flow Phase 3 - True CVD):')

      .option('cvd-direction-filter', {
        type: 'boolean',
        description: 'Filter trades by true CVD slope direction alignment (requires Databento trade data)',
        default: false
      })

      .option('cvd-slope-lookback', {
        type: 'number',
        description: 'Lookback periods for CVD slope calculation',
        default: 5
      })

      .option('cvd-min-slope', {
        type: 'number',
        description: 'Minimum CVD slope magnitude to consider significant',
        default: 0
      })

      .option('cvd-divergence-filter', {
        type: 'boolean',
        description: 'Block entries when price/CVD divergence detected (exhaustion signal)',
        default: false
      })

      .option('cvd-divergence-lookback', {
        type: 'number',
        description: 'Lookback periods for CVD divergence detection',
        default: 20
      })

      .option('cvd-zero-cross-filter', {
        type: 'boolean',
        description: 'Require recent CVD zero-line cross in trade direction',
        default: false
      })

      .option('cvd-zero-cross-lookback', {
        type: 'number',
        description: 'Max bars back to look for CVD zero-line cross',
        default: 10
      })

      // LDPM Level Sweep Strategy Parameters
      .group(['ldpm-lookback', 'ldpm-slope-threshold', 'sweep-buffer', 'stop-points', 'include-gex-levels', 'include-session-levels'], 'LDPM Level Sweep Parameters:')

      .option('ldpm-lookback', {
        type: 'number',
        description: 'LDPM lookback periods (1 period = 15 min)',
        default: 4
      })

      .option('ldpm-slope-threshold', {
        type: 'number',
        description: 'Minimum slope in points per period to classify as rising/falling',
        default: 3
      })

      .option('sweep-buffer', {
        type: 'number',
        description: 'Minimum points beyond level to detect sweep',
        default: 2
      })

      .option('stop-points', {
        type: 'number',
        description: 'Stop loss distance in points (for symmetric stop/target strategies)'
      })

      .option('include-gex-levels', {
        type: 'boolean',
        description: 'Include GEX levels in sweep detection',
        default: true
      })

      .option('include-session-levels', {
        type: 'boolean',
        description: 'Include session levels (PDH/PDL/ONH/ONL) in sweep detection',
        default: true
      })

      // Book Imbalance Filters (Phase 4 Order Flow - MBP-1 from Databento)
      .group(['book-imbalance-filter', 'book-imbalance-momentum-filter', 'book-imbalance-block-contrary'], 'Book Imbalance Filters (Order Flow Phase 4):')

      .option('book-imbalance-filter', {
        type: 'boolean',
        description: 'Filter trades by order book imbalance alignment (requires MBP-1 data)',
        default: false
      })

      .option('book-imbalance-threshold', {
        type: 'number',
        description: 'Minimum imbalance magnitude to consider significant (-1 to 1)',
        default: 0.1
      })

      .option('book-imbalance-momentum-filter', {
        type: 'boolean',
        description: 'Require book imbalance momentum improving in trade direction',
        default: false
      })

      .option('book-imbalance-momentum-lookback', {
        type: 'number',
        description: 'Lookback periods for book imbalance momentum',
        default: 5
      })

      .option('book-imbalance-block-contrary', {
        type: 'boolean',
        description: 'Block entries when strong contrary book imbalance detected',
        default: false
      })

      // Order Flow Momentum Strategy Options
      .group(['signal-mode', 'cvd-slope-threshold', 'cvd-slope-lookback', 'require-imbalance-confirm'], 'Order Flow Momentum Strategy:')

      .option('signal-mode', {
        type: 'string',
        description: 'Signal generation mode for order-flow-momentum strategy',
        choices: ['cvd_reversal', 'cvd_momentum', 'imbalance_shift', 'combined'],
        default: 'cvd_reversal'
      })

      .option('cvd-slope-threshold', {
        type: 'number',
        description: 'Minimum CVD slope magnitude for signal',
        default: 0.5
      })

      .option('cvd-slope-lookback', {
        type: 'number',
        description: 'Bars for CVD slope calculation',
        default: 5
      })

      .option('require-imbalance-confirm', {
        type: 'boolean',
        description: 'Require book imbalance confirmation for CVD signals',
        default: true
      })

      // CBBO-LT Volatility Strategy Options
      .group(['use-cbbo', 'cbbo-data-dir', 'spread-threshold', 'cbbo-lookback-minutes', 'min-spread-increase'], 'CBBO-LT Volatility Strategy:')

      .option('use-cbbo', {
        type: 'boolean',
        description: 'Enable CBBO data loading for volatility analysis',
        default: false
      })

      .option('cbbo-data-dir', {
        type: 'string',
        description: 'CBBO data directory path (relative to data-dir or absolute)'
      })

      .option('spread-threshold', {
        type: 'number',
        description: 'CBBO spread increase threshold for volatility alert (0-1)',
        default: 0.15
      })

      .option('cbbo-lookback-minutes', {
        type: 'number',
        description: 'Lookback window for spread change calculation (minutes)',
        default: 30
      })

      .option('min-spread-increase', {
        type: 'number',
        description: 'Minimum spread increase to consider (0-1)',
        default: 0.10
      })

      .option('cbbo-gex-proximity', {
        type: 'number',
        description: 'Max distance from GEX level for entry (points)',
        default: 15
      })

      // Micro-Structure Scalper Strategy Options
      .group(['active-patterns', 'swing-lookback', 'sweep-max-bars', 'rejection-wick-pct', 'volume-multiplier', 'fvg-min-points', 'use-gex-levels', 'gex-proximity-points', 'no-target', 'trailing-only', 'order-timeout-bars', 'max-stop-loss', 'use-fixed-stops'], 'Micro-Structure Scalper Strategy:')

      .option('active-patterns', {
        type: 'string',
        description: 'Comma-separated pattern names to use (e.g., bullish_engulfing,swing_low_sweep)',
        default: ''
      })

      .option('swing-lookback', {
        type: 'number',
        description: 'Candles for swing high/low detection',
        default: 8
      })

      .option('sweep-max-bars', {
        type: 'number',
        description: 'Max candles for sweep duration',
        default: 2
      })

      .option('rejection-wick-pct', {
        type: 'number',
        description: 'Min wick percentage of range for reversal patterns (0-1)',
        default: 0.3
      })

      .option('volume-multiplier', {
        type: 'number',
        description: 'Volume multiplier for confirmation (e.g., 1.5 = 150% of avg)',
        default: 1.5
      })

      .option('fvg-min-points', {
        type: 'number',
        description: 'Minimum FVG size in points',
        default: 0.5
      })

      .option('use-gex-levels', {
        type: 'boolean',
        description: 'Use GEX levels for confluence in micro-structure strategy',
        default: false
      })

      .option('gex-proximity-points', {
        type: 'number',
        description: 'Points from GEX level to add confluence',
        default: 5
      })

      .option('no-target', {
        type: 'boolean',
        description: 'Disable fixed profit target - use trailing stop only for exits',
        default: false
      })

      .option('trailing-only', {
        type: 'boolean',
        description: 'Alias for --no-target: use trailing stop only (no fixed target)',
        default: false
      })

      .option('order-timeout-bars', {
        type: 'number',
        description: 'Cancel unfilled limit orders after N bars (0 = no timeout)',
        default: 3
      })

      .option('max-stop-loss', {
        type: 'number',
        description: 'Max stop loss in points - skip trade if structural stop exceeds this'
      })

      .option('use-fixed-stops', {
        type: 'boolean',
        description: 'Use fixed stop loss (stop-loss-points) instead of pattern-specific structural stops',
        default: false
      })

      .option('invert-signals', {
        type: 'boolean',
        description: 'Flip signal direction (test if inverse is profitable)',
        default: false
      })

      // ES Cross-Signal Entry Filters
      .option('filter-regime-side', {
        type: 'string',
        description: 'Comma-separated regime_side combos to block (e.g. "strong_positive_buy,strong_negative_buy")'
      })

      .option('filter-lt-spacing-max', {
        type: 'number',
        description: 'Block signals when LT avg level spacing exceeds this (points)'
      })

      // Overnight Charm/Vanna Strategy Parameters
      .group(['entry-hour-et', 'exit-hour-et', 'min-cex-percentile', 'require-vex-confirmation', 'use-vix-filter', 'max-vix', 'use-day-filter', 'blocked-days'], 'Overnight Charm/Vanna Strategy:')

      .option('entry-hour-et', {
        type: 'number',
        description: 'Entry hour in ET (16 = 4pm EOD, 18 = 6pm futures open)'
      })

      .option('exit-hour-et', {
        type: 'number',
        description: 'Exit hour in ET (9.5 = 9:30am RTH open, 2 = 2am early exit)'
      })

      .option('min-cex-percentile', {
        type: 'number',
        description: 'Minimum CEX magnitude percentile to trade (0-100, higher = stronger signals only)'
      })

      .option('require-vex-confirmation', {
        type: 'boolean',
        description: 'Require VEX (vanna) to agree with CEX direction'
      })

      .option('use-vix-filter', {
        type: 'boolean',
        description: 'Filter by VIX regime (skip extremes)'
      })

      .option('max-vix', {
        type: 'number',
        description: 'Max VIX level (above = crisis, skip trade)'
      })

      .option('use-day-filter', {
        type: 'boolean',
        description: 'Enable day-of-week filter'
      })

      .option('blocked-days', {
        type: 'string',
        description: 'Comma-separated days to skip (e.g., Friday,Monday)'
      })

      // ES Micro-Scalper Strategy Parameters
      .group(['esms-active-patterns', 'esms-composite-mode', 'esms-min-concurrent', 'esms-rsi3-oversold', 'esms-rsi3-overbought', 'esms-consecutive-min', 'esms-ema20-deviation', 'esms-gex-proximity', 'esms-lt-proximity', 'esms-volume-spike'], 'ES Micro-Scalper Strategy:')

      .option('esms-active-patterns', {
        type: 'string',
        description: 'Comma-separated active patterns (rsi3_extreme,rsi6_extreme,consecutive_candles,bb_touch,ema20_deviation,large_candle_fade,gex_proximity,lt_proximity,volume_spike_rejection)'
      })

      .option('esms-composite-mode', {
        type: 'boolean',
        description: 'Require multiple concurrent patterns for signal'
      })

      .option('esms-min-concurrent', {
        type: 'number',
        description: 'Minimum concurrent patterns in composite mode (default: 2)'
      })

      .option('esms-rsi3-oversold', {
        type: 'number',
        description: 'RSI(3) oversold threshold (default: 10)'
      })

      .option('esms-rsi3-overbought', {
        type: 'number',
        description: 'RSI(3) overbought threshold (default: 90)'
      })

      .option('esms-consecutive-min', {
        type: 'number',
        description: 'Min consecutive candles to trigger fade (default: 3)'
      })

      .option('esms-ema20-deviation', {
        type: 'number',
        description: 'EMA(20) deviation threshold in points (default: 3)'
      })

      .option('esms-gex-proximity', {
        type: 'number',
        description: 'GEX S1/R1 proximity threshold in points (default: 2)'
      })

      .option('esms-lt-proximity', {
        type: 'number',
        description: 'LT level proximity threshold in points (default: 2)'
      })

      .option('esms-volume-spike', {
        type: 'number',
        description: 'Volume spike multiplier (default: 2.0)'
      })

      // ICT MTF Sweep Strategy Parameters
      .group(['priority-mode', 'require-killzone', 'require-tf-alignment', 'active-timeframes', 'sweep-min-wick', 'fvg-entry-mode', 'ob-entry', 'max-concurrent-setups', 'equal-level-tolerance', 'min-rr'], 'ICT MTF Sweep Strategy:')

      .option('priority-mode', {
        type: 'string',
        description: 'Setup priority mode when multiple setups are ready',
        choices: ['highest_tf', 'best_rr', 'most_recent', 'killzone_first'],
        default: 'highest_tf'
      })

      .option('require-killzone', {
        type: 'boolean',
        description: 'Only allow entries during killzones (all TFs)',
        default: false
      })

      .option('require-tf-alignment', {
        type: 'boolean',
        description: 'Require HTF trend agreement for entries',
        default: false
      })

      .option('active-timeframes', {
        type: 'string',
        description: 'Comma-separated TFs to analyze (default: 5m,15m,1h,4h)',
        default: '5m,15m,1h,4h'
      })

      .option('sweep-min-wick', {
        type: 'number',
        description: 'Min wick beyond level for sweep detection (points)',
        default: 2
      })

      .option('fvg-entry-mode', {
        type: 'string',
        description: 'FVG entry mode: ce (consequent encroachment/midpoint) or edge',
        choices: ['ce', 'edge'],
        default: 'ce'
      })

      .option('ob-entry', {
        type: 'boolean',
        description: 'Enable Order Block entries',
        default: true
      })

      .option('max-concurrent-setups', {
        type: 'number',
        description: 'Max parallel setups tracked',
        default: 10
      })

      .option('equal-level-tolerance', {
        type: 'number',
        description: 'Points tolerance for equal high/low detection',
        default: 3
      })

      .option('min-rr', {
        type: 'number',
        description: 'Minimum risk:reward ratio for entry',
        default: 1.5
      })

      // Swing Reversal Strategy Parameters
      .group(['stop-distance', 'limit-buffer', 'max-hold-bars', 'allow-overnight-holds', 'limit-timeout'], 'Swing Reversal Strategy:')

      .option('stop-distance', {
        type: 'number',
        description: 'Fixed stop distance in points from fill price (default: 30)'
      })

      .option('max-hold-bars', {
        type: 'number',
        description: 'Force exit after N bars in trade (default: 240)'
      })

      .option('allow-overnight-holds', {
        type: 'boolean',
        description: 'Disable force-close at market close (allow positions to hold overnight)',
        default: false
      })

      .option('limit-buffer', {
        type: 'number',
        description: 'Points beyond close for limit entry — buy below, sell above (default: 0)'
      })

      .option('limit-timeout', {
        type: 'number',
        description: 'Cancel unfilled limit orders after N candles (default: 3)'
      })

      .help('h')
      .alias('h', 'help')
      .version('1.0.0')
      .wrap(120)
      .parse();
  }

  async executeBacktest(args) {
    // Print header
    if (!args.quiet) {
      console.log(chalk.blue.bold('🚀 Slingshot Backtesting Engine'));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white(`📊 Strategy: ${args.strategy.toUpperCase()}`));
      console.log(chalk.white(`📈 Ticker: ${args.ticker.toUpperCase()}`));
      console.log(chalk.white(`📅 Period: ${args.start} → ${args.end}`));
      console.log(chalk.white(`⏱️  Timeframe: ${args.timeframe}`));
      console.log(chalk.white(`💰 Commission: $${args.commission} per round-trip`));

      // Show contract specifications
      const contractSpec = this.defaultConfig.contracts[args.ticker.toUpperCase()];
      if (contractSpec) {
        console.log(chalk.white(`📋 Contract: $${contractSpec.pointValue}/point | $${contractSpec.tickValue}/tick`));
      }

      console.log(chalk.gray('─'.repeat(50)));
    }

    // Validate date range
    const startDate = new Date(args.start);
    const endDate = new Date(args.end);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new Error('Invalid date format. Use YYYY-MM-DD format.');
    }

    if (startDate >= endDate) {
      throw new Error('Start date must be before end date.');
    }

    // Build strategy parameters - only include defined values
    const strategyParams = {
      ...this.defaultConfig.strategies[args.strategy],
      tradingSymbol: args.ticker.toUpperCase()
    };

    // If strategy config specifies a timeframe and user didn't explicitly override, use it
    const rawArgs = process.argv.slice(2);
    const userSetTimeframe = rawArgs.some(a => a.startsWith('--timeframe') || a.startsWith('--tf'));
    if (strategyParams.timeframe && !userSetTimeframe) {
      args.timeframe = strategyParams.timeframe;
    }

    // Only add parameters that are actually defined
    if (args.targetPoints !== undefined) {
      strategyParams.targetPoints = args.targetPoints;
      strategyParams.takeProfitPoints = args.targetPoints;  // For iv-skew-gex strategy
    }
    if (args.stopBuffer !== undefined) {
      strategyParams.stopBuffer = args.stopBuffer;
      strategyParams.stopLossPoints = args.stopBuffer;  // For CBBO-LT and other strategies
    }
    if (args.stopLossPoints !== undefined) strategyParams.stopLossPoints = args.stopLossPoints;
    if (args.maxRisk !== undefined) strategyParams.maxRisk = args.maxRisk; // Fix: level monitor expects maxRisk, not maxRiskPoints
    if (args.maxBarsAfterSweep !== undefined) strategyParams.maxBarsAfterSweep = args.maxBarsAfterSweep;
    if (args.useLiquidityFilter !== undefined) strategyParams.useLiquidityFilter = args.useLiquidityFilter;
    if (args.useStructuralStops !== undefined) strategyParams.useStructuralStops = args.useStructuralStops;

    // Trailing stop parameters
    if (args.useTrailingStop !== undefined) strategyParams.useTrailingStop = args.useTrailingStop;
    if (args.trailingTrigger !== undefined) strategyParams.trailingTrigger = args.trailingTrigger;
    if (args.trailingOffset !== undefined) strategyParams.trailingOffset = args.trailingOffset;

    // Breakeven stop parameters (move stop to entry, keep target)
    if (args.breakevenStop !== undefined) strategyParams.breakevenStop = args.breakevenStop;
    if (args.breakevenTrigger !== undefined) strategyParams.breakevenTrigger = args.breakevenTrigger;
    if (args.breakevenOffset !== undefined) strategyParams.breakevenOffset = args.breakevenOffset;

    // Zero Gamma early exit parameters
    if (args.gfEarlyExit !== undefined) strategyParams.gfEarlyExit = args.gfEarlyExit;
    if (args.gfBreakevenThreshold !== undefined) strategyParams.gfBreakevenThreshold = args.gfBreakevenThreshold;
    if (args.gfExitThreshold !== undefined) strategyParams.gfExitThreshold = args.gfExitThreshold;

    // Hybrid trailing stop parameters (structure-based runner capture)
    if (args.hybridTrailing !== undefined) strategyParams.hybridTrailing = args.hybridTrailing;
    if (args.structureThreshold !== undefined) strategyParams.structureThreshold = args.structureThreshold;
    if (args.swingLookback !== undefined) strategyParams.swingLookback = args.swingLookback;
    if (args.swingBuffer !== undefined) strategyParams.swingBuffer = args.swingBuffer;
    if (args.minSwingSize !== undefined) strategyParams.minSwingSize = args.minSwingSize;

    // Swing Reversal Strategy parameters
    if (args.stopDistance !== undefined) strategyParams.stopDistance = args.stopDistance;
    if (args.limitBuffer !== undefined) strategyParams.limitBuffer = args.limitBuffer;
    if (args.maxHoldBars !== undefined) strategyParams.maxHoldBars = args.maxHoldBars;
    if (args.limitTimeout !== undefined) strategyParams.limitOrderTimeout = args.limitTimeout;

    // Allow overnight holds (disable force-close at market close)
    if (args.allowOvernightHolds) strategyParams.forceCloseAtMarketClose = false;

    // Time-based trailing stop parameters (progressive profit protection)
    if (args.timeBasedTrailing !== undefined) strategyParams.timeBasedTrailing = args.timeBasedTrailing;

    // Parse time-based trailing rules from CLI format: "bars,mfe,action"
    // action can be "breakeven" or "trail:N" where N is the trailing distance
    const parseTimeBasedRule = (ruleStr) => {
      if (!ruleStr) return null;
      const parts = ruleStr.split(',').map(s => s.trim());
      if (parts.length !== 3) return null;

      const rule = {
        afterBars: parseInt(parts[0], 10),
        ifMFE: parseFloat(parts[1])
      };

      if (parts[2] === 'breakeven') {
        rule.action = 'breakeven';
      } else if (parts[2].startsWith('trail:')) {
        rule.trailDistance = parseFloat(parts[2].replace('trail:', ''));
      } else {
        return null;
      }

      return rule;
    };

    // Build rules array from CLI options
    const timeBasedRules = [];
    const rule1 = parseTimeBasedRule(args.tbRule1);
    const rule2 = parseTimeBasedRule(args.tbRule2);
    const rule3 = parseTimeBasedRule(args.tbRule3);
    if (rule1) timeBasedRules.push(rule1);
    if (rule2) timeBasedRules.push(rule2);
    if (rule3) timeBasedRules.push(rule3);

    if (timeBasedRules.length > 0) {
      strategyParams.timeBasedTrailingConfig = { rules: timeBasedRules };
    }

    // Strategy-specific parameters
    if (args.confluenceThreshold !== undefined) strategyParams.confluenceThreshold = args.confluenceThreshold;
    if (args.entryDistance !== undefined) strategyParams.entryDistance = args.entryDistance;

    // Session filtering parameters
    if (args.useSessionFilter !== undefined) strategyParams.useSessionFilter = args.useSessionFilter;
    if (args.blockedSessions) strategyParams.blockedSessions = args.blockedSessions.split(',').map(s => s.trim());

    // Long/Short filtering
    if (args.longsOnly) {
      strategyParams.useLongEntries = true;
      strategyParams.useShortEntries = false;
    }
    if (args.shortsOnly) {
      strategyParams.useLongEntries = false;
      strategyParams.useShortEntries = true;
    }

    // Inverse shorts (fade bearish signals)
    if (args.inverseShorts) {
      strategyParams.inverseShorts = true;
    }

    // Long only (for LT-MIG strategy)
    if (args.longsOnly) {
      strategyParams.longOnly = true;
    }

    // GEX level selection — only override if strategy doesn't already use string-based level names
    if (args.gexLevels && (!Array.isArray(strategyParams.tradeLevels) || typeof strategyParams.tradeLevels[0] !== 'string')) {
      strategyParams.tradeLevels = args.gexLevels.split(',').map(s => parseInt(s.trim(), 10));
    }

    // Level type filtering parameters
    if (args.blockedLevelTypes) strategyParams.blockedLevelTypes = args.blockedLevelTypes.split(',').map(s => s.trim());

    // Regime filtering parameters
    if (args.blockedRegimes) strategyParams.blockedRegimes = args.blockedRegimes.split(',').map(s => s.trim());

    // SELL time filtering parameters
    if (args.sellStartHourUtc !== undefined) strategyParams.sellStartHourUTC = args.sellStartHourUtc;

    // LT ordering filtering parameters
    if (args.useLtOrderingFilter !== undefined) strategyParams.useLTOrderingFilter = args.useLtOrderingFilter;
    if (args.requireLt4BelowLt5 !== undefined) strategyParams.requireLT4BelowLT5 = args.requireLt4BelowLt5;
    if (args.requireLt1AboveLt2 !== undefined) strategyParams.requireLT1AboveLT2 = args.requireLt1AboveLt2;
    if (args.requireLt2AboveLt3 !== undefined) strategyParams.requireLT2AboveLT3 = args.requireLt2AboveLt3;

    // LT Configuration Filtering Parameters
    if (args.filterByLtConfig !== undefined) strategyParams.filterByLtConfiguration = args.filterByLtConfig;
    if (args.ltFilterProfile !== undefined) strategyParams.ltFilterProfile = args.ltFilterProfile;
    if (args.blockedLtOrderings) strategyParams.blockedLtOrderings = args.blockedLtOrderings.split(',').map(s => s.trim());
    if (args.blockedLdmpTypes) strategyParams.blockedLdmpTypes = args.blockedLdmpTypes.split(',').map(s => s.trim());
    if (args.requiredLtSentiment !== undefined) strategyParams.requiredLtSentiment = args.requiredLtSentiment;
    if (args.minLtSpacing !== undefined) strategyParams.minLtSpacing = args.minLtSpacing;

    // GEX Scalp Confirmed Parameters
    if (args.useFixedStops !== undefined) strategyParams.useFixedStops = args.useFixedStops;
    if (args.zoneSize !== undefined) strategyParams.zoneSize = args.zoneSize;
    if (args.levelBuffer !== undefined) strategyParams.levelBuffer = args.levelBuffer;
    if (args.confirmationTimeout !== undefined) strategyParams.confirmationTimeout = args.confirmationTimeout;
    if (args.maxStopPoints !== undefined) strategyParams.maxStopPoints = args.maxStopPoints;
    if (args.minWickRatio !== undefined) strategyParams.minWickToBodyRatio = args.minWickRatio;

    // ICT SMC Strategy Parameters
    if (args.signalTypes) strategyParams.signalTypes = args.signalTypes.split(',').map(s => s.trim());
    if (args.structureTimeframe !== undefined) strategyParams.structureTimeframe = args.structureTimeframe;
    if (args.entryTimeframe !== undefined) strategyParams.entryTimeframe = args.entryTimeframe;
    if (args.targetMethod !== undefined) strategyParams.targetMethod = args.targetMethod;
    if (args.defaultRr !== undefined) strategyParams.defaultRR = args.defaultRr;
    if (args.verbose) strategyParams.verbose = args.verbose;
    if (args.debug) strategyParams.debug = true;

    // LTF Confirmation Parameters
    if (args.ltfConfirmation !== undefined || args.ltfTimeout !== undefined || args.ltfWickRatio !== undefined) {
      strategyParams.ltfConfirmation = {
        enabled: args.ltfConfirmation !== false,
        timeoutCandles: args.ltfTimeout || 15,
        minWickToBodyRatio: args.ltfWickRatio || 2.0
      };
    }

    // GEX Proximity Filter Parameters
    if (args.gexProximityFilter !== undefined) strategyParams.gexProximityFilter = args.gexProximityFilter;
    if (args.gexProximityThreshold !== undefined) strategyParams.gexProximityThreshold = args.gexProximityThreshold;

    // Order Block Entry Filter Parameters
    if (args.obTimeInZoneFilter !== undefined) strategyParams.timeInZoneFilterEnabled = args.obTimeInZoneFilter;
    if (args.timeInZoneThreshold !== undefined) strategyParams.timeInZoneThreshold = args.timeInZoneThreshold;
    if (args.obRangeFilter !== undefined) strategyParams.rangeFilterEnabled = args.obRangeFilter;
    if (args.rangeExclusionZone !== undefined) strategyParams.rangeExclusionZone = args.rangeExclusionZone;

    // Volume Filter Parameters (Phase 1 Order Flow)
    if (args.volumeDeltaFilter !== undefined) strategyParams.volumeDeltaFilter = args.volumeDeltaFilter;
    if (args.volumeDeltaLookback !== undefined) strategyParams.volumeDeltaLookback = args.volumeDeltaLookback;
    if (args.volumeTrendFilter !== undefined) strategyParams.volumeTrendFilter = args.volumeTrendFilter;
    if (args.volumeTrendPeriod !== undefined) strategyParams.volumeTrendPeriod = args.volumeTrendPeriod;
    if (args.volumeSpikeFilter !== undefined) strategyParams.volumeSpikeFilter = args.volumeSpikeFilter;
    if (args.volumeSpikeThreshold !== undefined) strategyParams.volumeSpikeThreshold = args.volumeSpikeThreshold;
    if (args.volumeSpikePeriod !== undefined) strategyParams.volumeSpikePeriod = args.volumeSpikePeriod;
    if (args.volumeProfileFilter !== undefined) strategyParams.volumeProfileFilter = args.volumeProfileFilter;
    if (args.volumeProfilePocThreshold !== undefined) strategyParams.volumeProfilePocThreshold = args.volumeProfilePocThreshold;

    // CVD Filter Parameters (Phase 3 Order Flow - True CVD from Databento)
    if (args.cvdDirectionFilter !== undefined) strategyParams.cvdDirectionFilter = args.cvdDirectionFilter;
    if (args.cvdSlopeLookback !== undefined) strategyParams.cvdSlopeLookback = args.cvdSlopeLookback;
    if (args.cvdMinSlope !== undefined) strategyParams.cvdMinSlope = args.cvdMinSlope;
    if (args.cvdDivergenceFilter !== undefined) strategyParams.cvdDivergenceFilter = args.cvdDivergenceFilter;
    if (args.cvdDivergenceLookback !== undefined) strategyParams.cvdDivergenceLookback = args.cvdDivergenceLookback;
    if (args.cvdZeroCrossFilter !== undefined) strategyParams.cvdZeroCrossFilter = args.cvdZeroCrossFilter;
    if (args.cvdZeroCrossLookback !== undefined) strategyParams.cvdZeroCrossLookback = args.cvdZeroCrossLookback;

    // Book Imbalance Filter Parameters (Phase 4 Order Flow - MBP-1 from Databento)
    if (args.bookImbalanceFilter !== undefined) strategyParams.bookImbalanceFilter = args.bookImbalanceFilter;
    if (args.bookImbalanceThreshold !== undefined) strategyParams.bookImbalanceThreshold = args.bookImbalanceThreshold;
    if (args.bookImbalanceMomentumFilter !== undefined) strategyParams.bookImbalanceMomentumFilter = args.bookImbalanceMomentumFilter;
    if (args.bookImbalanceMomentumLookback !== undefined) strategyParams.bookImbalanceMomentumLookback = args.bookImbalanceMomentumLookback;
    if (args.bookImbalanceBlockContrary !== undefined) strategyParams.bookImbalanceBlockContrary = args.bookImbalanceBlockContrary;

    // LDPM Level Sweep Strategy Parameters
    if (args.ldpmLookback !== undefined) strategyParams.ldpmLookbackPeriods = args.ldpmLookback;
    if (args.ldpmSlopeThreshold !== undefined) strategyParams.ldpmSlopeThreshold = args.ldpmSlopeThreshold;
    if (args.sweepBuffer !== undefined) strategyParams.sweepBuffer = args.sweepBuffer;
    if (args.stopPoints !== undefined) strategyParams.stopPoints = args.stopPoints;
    if (args.includeGexLevels !== undefined) strategyParams.includeGexLevels = args.includeGexLevels;
    if (args.includeSessionLevels !== undefined) strategyParams.includeSessionLevels = args.includeSessionLevels;

    // Order Flow Momentum Strategy Parameters
    if (args.signalMode !== undefined) strategyParams.signalMode = args.signalMode;
    if (args.cvdSlopeThreshold !== undefined) strategyParams.cvdSlopeThreshold = args.cvdSlopeThreshold;
    if (args.cvdSlopeLookback !== undefined) strategyParams.cvdSlopeLookback = args.cvdSlopeLookback;
    if (args.requireImbalanceConfirm !== undefined) strategyParams.requireImbalanceConfirm = args.requireImbalanceConfirm;

    // CBBO-LT Volatility Strategy Parameters
    if (args.spreadThreshold !== undefined) strategyParams.spreadThreshold = args.spreadThreshold;
    if (args.cbboLookbackMinutes !== undefined) strategyParams.lookbackMinutes = args.cbboLookbackMinutes;
    if (args.minSpreadIncrease !== undefined) strategyParams.minSpreadIncrease = args.minSpreadIncrease;
    if (args.cbboGexProximity !== undefined) strategyParams.gexProximityPoints = args.cbboGexProximity;

    // Micro-Structure Scalper Strategy Parameters
    if (args.activePatterns) {
      strategyParams.activePatterns = args.activePatterns.split(',').map(s => s.trim());
    }
    if (args.swingLookback !== undefined) strategyParams.swingLookback = args.swingLookback;
    if (args.sweepMaxBars !== undefined) strategyParams.sweepMaxBars = args.sweepMaxBars;
    if (args.rejectionWickPct !== undefined) strategyParams.rejectionWickPct = args.rejectionWickPct;
    if (args.volumeMultiplier !== undefined) strategyParams.volumeMultiplier = args.volumeMultiplier;
    if (args.fvgMinPoints !== undefined) strategyParams.fvgMinPoints = args.fvgMinPoints;
    if (args.useGexLevels !== undefined) strategyParams.useGexLevels = args.useGexLevels;
    if (args.gexProximityPoints !== undefined) strategyParams.gexProximityPoints = args.gexProximityPoints;

    // Trailing stop only mode (no fixed target)
    if (args.noTarget || args.trailingOnly) {
      strategyParams.useTargetExit = false;
      strategyParams.targetPoints = null;
    }

    // Order timeout for unfilled limit orders
    if (args.orderTimeoutBars !== undefined) {
      strategyParams.orderTimeoutBars = args.orderTimeoutBars;
    }

    // Max stop loss - skip trades where structural stop exceeds this
    if (args.maxStopLoss !== undefined) {
      strategyParams.maxStopLoss = args.maxStopLoss;
    }

    // Use fixed stops instead of pattern-specific structural stops
    if (args.useFixedStops !== undefined) {
      strategyParams.useFixedStops = args.useFixedStops;
    }

    // Invert signals (test inverse strategy)
    if (args.invertSignals !== undefined) {
      strategyParams.invertSignals = args.invertSignals;
    }

    // ES Cross-Signal entry filters
    if (args.filterRegimeSide) {
      strategyParams.filterRegimeSide = args.filterRegimeSide.split(',').map(s => s.trim());
    }
    if (args.filterLtSpacingMax !== undefined) {
      strategyParams.filterLtSpacingMax = args.filterLtSpacingMax;
    }

    // Overnight Charm/Vanna Strategy Parameters
    if (args.entryHourEt !== undefined) strategyParams.entryHourET = args.entryHourEt;
    if (args.exitHourEt !== undefined) strategyParams.exitHourET = args.exitHourEt;
    if (args.minCexPercentile !== undefined) strategyParams.minCexPercentile = args.minCexPercentile;
    if (args.requireVexConfirmation !== undefined) strategyParams.requireVexConfirmation = args.requireVexConfirmation;
    if (args.useVixFilter !== undefined) strategyParams.useVixFilter = args.useVixFilter;
    if (args.maxVix !== undefined) strategyParams.maxVix = args.maxVix;
    if (args.useDayFilter !== undefined) strategyParams.useDayFilter = args.useDayFilter;
    if (args.blockedDays && typeof args.blockedDays === 'string') {
      strategyParams.blockedDays = args.blockedDays.split(',').map(s => s.trim());
    }

    // Composite trailing stop parameters (multi-phase ICT trailing)
    if (args.compositeTrailing !== undefined) strategyParams.useCompositeTrailing = args.compositeTrailing;
    if (args.compositeActivationThreshold !== undefined) strategyParams.compositeActivationThreshold = args.compositeActivationThreshold;
    if (args.compositeZoneBe !== undefined) strategyParams.compositeZoneBreakevenEnabled = args.compositeZoneBe;
    if (args.compositeStructuralThreshold !== undefined) strategyParams.compositeStructuralThreshold = args.compositeStructuralThreshold;
    if (args.compositeAggressiveThreshold !== undefined) strategyParams.compositeAggressiveThreshold = args.compositeAggressiveThreshold;
    if (args.compositeProximityPct !== undefined) strategyParams.compositeProximityPct = args.compositeProximityPct;

    // ICT MTF Sweep Strategy Parameters
    if (args.priorityMode !== undefined) strategyParams.priorityMode = args.priorityMode;
    if (args.requireKillzone !== undefined) strategyParams.requireKillzone = args.requireKillzone;
    if (args.requireTfAlignment !== undefined) strategyParams.requireTFAlignment = args.requireTfAlignment;
    if (args.activeTimeframes !== undefined) strategyParams.activeTimeframes = args.activeTimeframes;
    if (args.sweepMinWick !== undefined) strategyParams.sweepMinWick = args.sweepMinWick;
    if (args.fvgEntryMode !== undefined) strategyParams.fvgEntryMode = args.fvgEntryMode;
    if (args.obEntry !== undefined) strategyParams.useOBEntry = args.obEntry;
    if (args.maxConcurrentSetups !== undefined) strategyParams.maxConcurrentSetups = args.maxConcurrentSetups;
    if (args.equalLevelTolerance !== undefined) strategyParams.equalLevelTolerance = args.equalLevelTolerance;
    if (args.minRr !== undefined) strategyParams.minRR = args.minRr;

    // ES Micro-Scalper Strategy Parameters
    if (args.esmsActivePatterns) {
      strategyParams.activePatterns = args.esmsActivePatterns.split(',').map(s => s.trim());
    }
    if (args.esmsCompositeMode !== undefined) strategyParams.compositeMode = args.esmsCompositeMode;
    if (args.esmsMinConcurrent !== undefined) strategyParams.minConcurrentPatterns = args.esmsMinConcurrent;
    if (args.esmsRsi3Oversold !== undefined) strategyParams.rsi3OversoldThreshold = args.esmsRsi3Oversold;
    if (args.esmsRsi3Overbought !== undefined) strategyParams.rsi3OverboughtThreshold = args.esmsRsi3Overbought;
    if (args.esmsConsecutiveMin !== undefined) strategyParams.consecutiveCandleMin = args.esmsConsecutiveMin;
    if (args.esmsEma20Deviation !== undefined) strategyParams.ema20DeviationPoints = args.esmsEma20Deviation;
    if (args.esmsGexProximity !== undefined) strategyParams.gexProximityPoints = args.esmsGexProximity;
    if (args.esmsLtProximity !== undefined) strategyParams.ltProximityPoints = args.esmsLtProximity;
    if (args.esmsVolumeSpike !== undefined) strategyParams.volumeSpikeMultiplier = args.esmsVolumeSpike;

    // Create backtest configuration
    const backtestConfig = {
      ticker: args.ticker.toUpperCase(),
      startDate: startDate,
      endDate: endDate,
      timeframe: args.timeframe,
      strategy: args.strategy,
      strategyParams: strategyParams,
      commission: args.commission,
      initialCapital: args.capital,
      dataDir: args.dataDir,
      verbose: args.verbose,
      quiet: args.quiet,
      showTrades: args.showTrades,
      useSecondResolution: !args.minuteResolution,
      noContinuous: args.rawContracts,
      useCBBO: args.useCbbo || args.strategy === 'cbbo-lt-volatility' || args.strategy === 'cbbo-lt',
      cbboDataDir: args.cbboDataDir || null, // null means use default: dataDir/cbbo-1m/qqq
      outputFiles: {
        json: args.outputJson || args.output,
        csv: args.outputCsv
      }
    };

    // Create the backtest engine
    const engine = new BacktestEngine(backtestConfig);

    // Display strategy configuration before running
    if (!args.quiet) {
      const reporter = engine.consoleReporter;
      reporter.displayStrategyConfiguration(
        strategyParams,
        backtestConfig,
        this.defaultConfig.contracts
      );
    }

    // Run the backtest
    const results = await engine.run();

    // Output results
    const outputJsonFile = args.outputJson || args.output;
    if (outputJsonFile) {
      fs.writeFileSync(outputJsonFile, JSON.stringify(results, null, 2));
      if (!args.quiet) {
        console.log(chalk.green(`📄 Results saved to ${outputJsonFile}`));
      }
    }

    if (args.outputCsv) {
      engine.exportTradesToCSV(args.outputCsv);
      if (!args.quiet) {
        console.log(chalk.green(`📊 Trade log saved to ${args.outputCsv}`));
      }
    }

    return results;
  }
}