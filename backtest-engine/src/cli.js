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
        choices: ['gex-recoil', 'gex-recoil-enhanced', 'gex-ldpm-confluence', 'gex-ldpm-confluence-pullback', 'contrarian-bounce', 'gex-scalp', 'gex-scalp-confirmed', 'ict-smc', 'ict-ob', 'ldpm-level-sweep', 'order-flow-momentum', 'ofm', 'contrarian-orderflow', 'cof', 'gex-absorption', 'absorption', 'iv-skew-gex', 'iv-skew', 'gex-flip-ivpct', 'gfi', 'gex-lt-3m-crossover', 'gex-lt-cross', 'glx', 'ls-flip-trigger-bar', 'ls-flip', 'lstb', 'gex-touch-confirm', 'gex-touch', 'gtc', 'gex-touch-patterns', 'gtp', 'gex-structural-resist', 'gsr', 'gex-level-fade', 'glf', 'cbbo-lt-volatility', 'cbbo-lt', 'gex-mean-reversion', 'gex-mr', 'lt-failed-breakdown', 'lt-fb', 'lt-level-crossing', 'lt-cross', 'lt-level-migration', 'lt-mig', 'regime-scalp', 'rs', 'gex-level-sweep', 'gex-sweep', 'sweep', 'micro-structure-scalper', 'micro-scalper', 'mss', 'trend-scalp', 'ts', 'level-bounce', 'lb', 'overnight-gex-touch', 'overnight-gex', 'ogt', 'overnight-charm-vanna', 'ocv', 'es-cross-signal', 'es-cross', 'ecs', 'es-micro-scalper', 'es-micro', 'esms', 'es-stop-hunt', 'es-hunt', 'esh', 'ohlcv-absorption', 'absorption-detect', 'abs', 'ohlcv-liquidity-sweep', 'liquidity-sweep', 'lsweep', 'ohlcv-vpin', 'vpin', 'ohlcv-mtf-rejection', 'mtf-rejection', 'mtfr', 'momentum-microstructure', 'momentum-micro', 'mm', 'midnight-open-retracement', 'midnight-open', 'mor', 'initial-balance-breakout', 'ib-breakout', 'ibb', 'gap-fill', 'gap', 'daily-level-sweep', 'daily-sweep', 'dls', 'vwap-bounce', 'vwap', 'session-transition', 'session', 'st', 'value-area-80', 'va80', 'swing-reversal', 'sr', 'ict-silver-bullet', 'silver-bullet', 'isb', 'price-action-exhaustion', 'pa-exhaust', 'pae', 'ict-mtf-sweep', 'mtf-sweep', 'jv', 'dc-st1', 'dc1', 'dc-st2', 'dc2', 'dc-st3', 'dc3', 'dc-st4', 'dc4', 'dc-st5', 'dc5', 'dc-st6', 'dc6', 'dc-st7', 'dc7', 'dc-st8', 'dc8', 'dc-mstgam', 'mstgam', 'mnq-adaptive-scalper', 'mnq-scalper', 'mnq', 'sweep-reversal', 'sweep-rev', 'nq-leads-es', 'nq-lead', 'nle', 'gex-support-bounce', 'gex-bounce', 'gsb', 'impulse-fvg', 'impulse', 'ifvg', 'short-dte-iv', 'sdiv', 'overnight-scoring', 'overnight-score', 'ons', 'overnight-composite', 'overnight-comp', 'onc', 'overnight-lt-crossing', 'overnight-ltx', 'oltx', 'lt-crossover', 'ltx', 'lt-structure-confirm', 'ltsc', 'lt-struct', 'lt-candle-regime', 'lt-regime', 'lcr', 'gamma-regime-drift', 'grd']
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

      .option('iv-resolution', {
        type: 'string',
        description: 'IV data resolution for iv-skew-gex strategy (1m matches live 2-min refresh, 15m is original, 1m_smoothed is 5-min rolling median to remove minute-level noise)',
        default: '15m',
        choices: ['1m', '5m', '15m', '1m_smoothed']
      })

      .option('gex-dir', {
        type: 'string',
        description: 'Custom GEX data directory (e.g., data/gex-cbbo/nq/ for CBBO-based GEX). Overrides default statistics-based GEX.'
      })

      .option('lt-1m-file', {
        type: 'string',
        description: 'Path to a 1m LT levels CSV (gex-lt-3m-crossover strategy). Schema: timestamp_iso, unix_ms, sentiment_raw, level_1..5. Use research/lt-extraction/output/nq_lt_1m_raw.csv.'
      })

      .option('s1-vwap-file', {
        type: 'string',
        description: 'Path to per-minute s1 VWAP feature CSV (gex-touch-confirm strategy). Schema: timestamp,vwap_close_diff,vwap,close,n_bars. Use data/features/nq_s1_vwap_1m.csv (built by research/gex-touch-confirm/06-precompute-s1-vwap.js).'
      })

      .option('ls-1m-file', {
        type: 'string',
        description: 'Path to a 1m LS state flip CSV (ls-flip-trigger-bar strategy). Schema: timestamp_iso, unix_ms, state (0|1), source_symbol. Use research/lt-extraction/output/nq_ls_1m_raw.csv.'
      })

      .option('lstb-fib', {
        type: 'number',
        description: 'ls-flip-trigger-bar: fib retrace level for limit entry. Default 0.5.'
      })

      .option('lstb-cb-atr-max', {
        type: 'number',
        description: 'ls-flip-trigger-bar: max |close-open|/ATR(20) — reject big-body flips. Default 1.81.'
      })

      .option('lstb-atr-period', {
        type: 'number',
        description: 'ls-flip-trigger-bar: ATR period for the cb_atr filter. Default 20.'
      })

      .option('lstb-fill-timeout', {
        type: 'number',
        description: 'ls-flip-trigger-bar: 1m bars to wait for limit fill before cancelling. Default 10.'
      })

      .option('lstb-max-hold', {
        type: 'number',
        description: 'ls-flip-trigger-bar: max 1m bars after fill before forced exit. Default 60.'
      })

      .option('lstb-blocked-hours', {
        type: 'string',
        description: 'ls-flip-trigger-bar: comma-separated ET hours (0-23) to skip entries. E.g. "5,16,21" to skip the three negative-expectancy hours.'
      })
      .option('lstb-preset', {
        type: 'string',
        choices: ['v2', 'v3', 'v3-max', 'v3-balanced', 'v3-low-dd'],
        description: 'ls-flip-trigger-bar: load a named preset of params. v3=candJ recommended ($279k/+114%/Sh21.00/DD1.82%), v3-max=candK ($283k, looser DD), v3-balanced=candH (Sh22.12, $214k), v3-low-dd=candC ($152k, DD1.42%), v2=baseline ($130k). Individual --lstb-* flags below override preset values.'
      })

      .option('lstb-stop-pts', {
        type: 'number',
        description: 'ls-flip-trigger-bar: fixed stop loss in points from entry. Overrides bar-extreme default.'
      })
      .option('lstb-target-pts', {
        type: 'number',
        description: 'ls-flip-trigger-bar: fixed take-profit target in points from entry. Overrides bar-extreme default.'
      })
      .option('lstb-min-range', {
        type: 'number',
        description: 'ls-flip-trigger-bar: skip trigger bars whose range < this points. Filters tiny-bar low-expectancy flips.'
      })
      .option('lstb-breakeven-stop', {
        type: 'boolean',
        default: false,
        description: 'ls-flip-trigger-bar: enable break-even stop (paired with --lstb-be-trigger / --lstb-be-offset).'
      })
      .option('lstb-be-trigger', {
        type: 'number',
        description: 'ls-flip-trigger-bar: MFE in points to activate BE stop.'
      })
      .option('lstb-be-offset', {
        type: 'number',
        description: 'ls-flip-trigger-bar: BE floor offset in points (positive = lock in N pts profit).'
      })
      .option('lstb-trail-trigger', {
        type: 'number',
        description: 'ls-flip-trigger-bar: MFE in points to activate trailing stop.'
      })
      .option('lstb-trail-offset', {
        type: 'number',
        description: 'ls-flip-trigger-bar: trailing offset in points behind MFE peak.'
      })

      .option('eod-cutoff-et', {
        type: 'string',
        description: 'Force-flat any open position at this ET wall-clock time (HH:MM) on weekdays. Models day-trade-margin liquidation (e.g. "16:45").'
      })

      .option('strict-fill', {
        type: 'boolean',
        default: false,
        description: 'Limit orders require strict trade-through (low<entry / high>entry) instead of touch=fill. FIFO-conservative model for queue-position realism.'
      })

      .option('glx-preset', {
        type: 'string',
        choices: ['w12', 'v3', 'v3-max', 'v3-balanced', 'v3-low-dd'],
        description: 'gex-lt-3m-crossover: load a named preset of per-rule exits + filters. w12=current gold ($179k/PF 1.44/DD 8.26%). v3 / v3-max / v3-balanced / v3-low-dd are the post-research presets (see research/gex-lt-3m-improve/SUMMARY.md for metrics). Individual --glx-* flags below override preset values.'
      })

      .option('glx-disable-rules', {
        type: 'string',
        description: 'Comma-separated rule IDs to disable in gex-lt-3m-crossover (e.g. "L_PW,S_S2_SOLO").'
      })

      .option('glx-force-any', {
        type: 'boolean',
        default: false,
        description: 'Bypass solo/confirmed filter for all rules in gex-lt-3m-crossover (test core 3m crossover signal).'
      })

      .option('glx-rule-overrides', {
        type: 'string',
        description: 'JSON map of per-rule overrides for gex-lt-3m-crossover, e.g. \'{"L_PW":{"stopPts":20}}\''
      })

      .option('glx-cooldown-ms', {
        type: 'number',
        description: 'Override signalCooldownMs for gex-lt-3m-crossover (default 1800000 = 30 min).'
      })

      .option('glx-max-hold', {
        type: 'number',
        description: 'Override maxHoldBars (in MINUTES) for gex-lt-3m-crossover (default 60).'
      })

      .option('glx-limit-timeout', {
        type: 'number',
        description: 'How many 1m candles to wait for limit fill before cancelling for gex-lt-3m-crossover (default 5).'
      })

      .option('glx-no-entry-window', {
        type: 'boolean',
        default: false,
        description: 'Disable the RTH (9:30-16:00 ET) entry window for gex-lt-3m-crossover.'
      })

      .option('glx-entry-window', {
        type: 'string',
        description: 'Custom entry window for gex-lt-3m-crossover, format "HH:MM-HH:MM" (ET, half-open). E.g. "08:00-16:00". Overrides default 9:30-16:00.'
      })

      .option('glx-blocked-hours', {
        type: 'string',
        description: 'Comma-separated list of blocked ET hours (0-23) for gex-lt-3m-crossover. E.g. "13" to skip the lunch hour.'
      })

      .option('glx-trailing-trigger', {
        type: 'number',
        description: 'Universal trailing stop trigger (points of MFE) for gex-lt-3m-crossover. Pair with --glx-trailing-offset.'
      })

      .option('glx-trailing-offset', {
        type: 'number',
        description: 'Universal trailing stop offset (points back from MFE) for gex-lt-3m-crossover.'
      })

      .option('glx-breakeven-trigger', {
        type: 'number',
        description: 'Universal breakeven stop trigger (points of MFE) for gex-lt-3m-crossover.'
      })

      .option('glx-breakeven-offset', {
        type: 'number',
        description: 'Universal breakeven stop offset (points of profit locked at entry) for gex-lt-3m-crossover.'
      })

      .option('gtc-iv-skew-threshold', {
        type: 'number',
        description: 'gex-touch-confirm: qqq put_iv − call_iv max. Default 0.0173 (p10 of population — calm options skew).'
      })
      .option('gtc-no-pinbar', {
        type: 'boolean',
        default: false,
        description: 'gex-touch-confirm: disable the pinbar requirement.'
      })
      .option('gtc-no-positive-regime', {
        type: 'boolean',
        default: false,
        description: 'gex-touch-confirm: disable the positive-regime requirement.'
      })
      .option('gtc-min-dist-threshold', {
        type: 'number',
        description: 'gex-touch-confirm: optional min_dist_to_level threshold (pts). Default null (off).'
      })
      .option('gtc-atr-threshold', {
        type: 'number',
        description: 'gex-touch-confirm: ATR(14) threshold. Default 28.95 (p90 of population).'
      })
      .option('gtc-s1-threshold', {
        type: 'number',
        description: 'gex-touch-confirm: s1_vwap_close_diff threshold (signed by approach). Default null. Pair with --gtc-use-s1-filter.'
      })
      .option('gtc-use-s1-filter', {
        type: 'boolean',
        default: false,
        description: 'gex-touch-confirm: enable secondary s1 VWAP filter (requires --s1-vwap-file).'
      })
      .option('gtc-touch-distance', {
        type: 'number',
        description: 'gex-touch-confirm: pts within level to count as a touch. Default 10.'
      })
      .option('gtc-stop-distance', {
        type: 'number',
        description: 'gex-touch-confirm: stop distance past level in pts. Default 15. (20 = higher WR; 8/10/12 = tighter R:R)'
      })
      .option('gtc-target-points', {
        type: 'number',
        description: 'gex-touch-confirm: target distance past level in pts. Default 20.'
      })
      .option('gtc-limit-timeout', {
        type: 'number',
        description: 'gex-touch-confirm: 1m candles to wait for limit fill. Default 5.'
      })
      .option('gtc-max-hold', {
        type: 'number',
        description: 'gex-touch-confirm: max hold in MINUTES after signal. Default 120.'
      })
      .option('gtc-cooldown-ms', {
        type: 'number',
        description: 'gex-touch-confirm: signal cooldown in ms. Default 0.'
      })
      .option('gtc-entry-window', {
        type: 'string',
        description: 'gex-touch-confirm: entry window "HH:MM-HH:MM" ET. Default "09:30-16:00".'
      })
      .option('gtc-no-entry-window', {
        type: 'boolean',
        default: false,
        description: 'gex-touch-confirm: disable entry-window gating.'
      })
      .option('gtc-snap-lag-min', {
        type: 'number',
        description: 'gex-touch-confirm: minutes to lag the GEX snapshot lookup. Default 16 (matches research). 0 = use freshest available.'
      })
      .option('gtp-rulebook', {
        type: 'string',
        description: 'gex-touch-patterns: rulebook name (default | big_targets | w60).'
      })
      .option('gtp-trigger-window', {
        type: 'number',
        description: 'gex-touch-patterns: monitoring window minutes after touch (default 30, w60 rulebook needs 60).'
      })
      .option('gtp-entry-window', {
        type: 'string',
        description: 'gex-touch-patterns: entry window "HH:MM-HH:MM" ET. Default "09:30-16:00".'
      })
      .option('gtp-no-entry-window', {
        type: 'boolean',
        default: false,
        description: 'gex-touch-patterns: disable entry window — take touches any time of day (CME globex hours).'
      })

      .option('gfi-preset', {
        type: 'string',
        choices: ['tight', 'v2', 'v2-max', 'v2-low-dd'],
        description: 'gex-flip-ivpct: load a named preset of params. tight=2026-05-12 gold ($157k engine/PF 2.99/Sh 4.76/DD $14.6k). v2=2026-05-21 recommended (tgt=260 BE 160/+10: $209k engine/PF 3.39/Sh 5.31/DD $8.6k, +33% PnL with -41% DD). v2-max=widest target (tgt=320 BE 160/+10 mh=480: $218k/PF 3.49/Sh 5.14/DD $8.6k). v2-low-dd=selective filter (h11+Fri+S1 dropped: $168k/PF 3.70/Sh 4.92/DD $11.2k — fewer trades / higher PF). Individual --gfi-* flags below override preset values.'
      })

      .option('glf-preset', {
        type: 'string',
        choices: ['gold', 'v2', 'v2-max', 'v2-low-dd'],
        description: 'gex-level-fade: load a named preset of params (research/gex-level-fade-improve, 2026-05-21). gold=current live ($104k engine/PF 1.38/Sh 4.21/DD 7.04% — t=100 s=18). v2=recommended (t=110 s=22 BE 100/+10 + drop SH/SL: +28% PnL with -14% DD). v2-max=widest target (t=140 s=25 BE 100/+20: max PnL, higher DD). v2-low-dd=most conservative (t=110 s=20 BE 80/+10 + drop SH/SL: lowest DD in family). Individual --glf-* flags below override preset values.'
      })
      .option('gfi-blocked-dows', {
        type: 'string',
        description: 'gex-flip-ivpct: comma-separated ET DOW abbreviations to block, e.g. "Fri,Mon".'
      })
      .option('gfi-stop-pts', {
        type: 'number',
        description: 'gex-flip-ivpct: override stop in points for ALL rules.'
      })
      .option('gfi-target-pts', {
        type: 'number',
        description: 'gex-flip-ivpct: override target in points for ALL rules.'
      })
      .option('gfi-rule-overrides', {
        type: 'string',
        description: 'gex-flip-ivpct: JSON map of per-rule overrides, e.g. \'{"L3":{"stopPts":50,"targetPts":100}}\''
      })
      .option('gfi-disable-rules', {
        type: 'string',
        description: 'gex-flip-ivpct: comma-separated list of rules to disable, e.g. "L3,S1".'
      })
      .option('gfi-blocked-hours', {
        type: 'string',
        description: 'gex-flip-ivpct: comma-separated ET hours to block, e.g. "6,7,8".'
      })
      .option('gfi-breakeven-stop', {
        type: 'boolean',
        description: 'gex-flip-ivpct: enable breakeven stop (move stop to entry once trigger is hit).'
      })
      .option('gfi-breakeven-trigger', {
        type: 'number',
        description: 'gex-flip-ivpct: MFE points at which to move stop to BE.'
      })
      .option('gfi-breakeven-offset', {
        type: 'number',
        description: 'gex-flip-ivpct: where to move stop when BE triggers. 0=entry, negative=allow some loss.'
      })
      .option('gfi-trailing-trigger', {
        type: 'number',
        description: 'gex-flip-ivpct: MFE points at which trailing stop activates.'
      })
      .option('gfi-trailing-offset', {
        type: 'number',
        description: 'gex-flip-ivpct: trailing stop offset in points back from current MFE.'
      })
      .option('gfi-magnet-ratchet', {
        type: 'boolean',
        description: 'gex-flip-ivpct: enable structural-magnet MFE ratchet. Uses 1m 9/9 swing pivots in profit region as MFE tiers. Loads from research/swing-pivots/NQ_swings_1m_9_9.csv.',
        default: false
      })
      .option('gfi-magnet-lock-pct', {
        type: 'number',
        description: 'gex-flip-ivpct magnet ratchet: lock percentage at each magnet tier (default 0.75).',
        default: 0.75
      })
      .option('gfi-magnet-recency-hours', {
        type: 'number',
        description: 'gex-flip-ivpct magnet ratchet: lookback window for active magnets in hours (default 4).',
        default: 4
      })
      .option('gfi-magnet-fixed-per-tier', {
        type: 'boolean',
        description: 'gex-flip-ivpct magnet ratchet: fixed-per-tier lock semantics. Stop = entry − tier.minMFE × lockPct (held constant until next magnet), instead of entry − currentMFE × lockPct (continuous tightening). Lets trades reach deeper magnets.',
        default: false
      })
      .option('gfi-magnet-fallback-tiers', {
        type: 'string',
        description: 'gex-flip-ivpct magnet ratchet: pure-MFE tiers to use when a signal has no magnets in its profit region. Same format as --mfe-ratchet-tiers: "minMFE:lockPct,...". e.g. "70:0.4" matches the s1-m70l40 pure ratchet.'
      })
      .option('gfi-fib-retrace', {
        type: 'boolean',
        description: 'gex-flip-ivpct: enable Fibonacci-retracement bar-close exit. Tracks favorable extreme since fill; once MFE >= activation, exits on a 1m bar CLOSE through entry ± mfe × (1 − retracePct). Hard SL is preserved.',
        default: false
      })
      .option('gfi-fib-retrace-pct', {
        type: 'number',
        description: 'gex-flip-ivpct fib retrace: retracement percentage (default 0.786). 0.786 = 78.6% gives back, 0.618 = deeper, 0.886 = shallower.',
        default: 0.786
      })
      .option('gfi-fib-activation-mfe', {
        type: 'number',
        description: 'gex-flip-ivpct fib retrace: minimum MFE (pts) before the bar-close check engages (default 40). Below this, only the hard SL is in play.',
        default: 40
      })
      .option('gfi-fib-conditional', {
        type: 'boolean',
        description: 'gex-flip-ivpct fib retrace: enable regime-conditional per-signal config. See --gfi-fib-conditional-mode for variants. Requires --gfi-fib-retrace.',
        default: false
      })
      .option('gfi-fib-conditional-mode', {
        type: 'string',
        description: 'gex-flip-ivpct conditional fib mode: "full" (disable S2+mid-IV, tighten L4/S1/neg-GEX), "s2-only" (disable S2 only), "tighten-only" (no disables, tighten wave-prone to 0.55/35), "mild-tighten" (no disables, tighten wave-prone to 0.58/40). Default: full.',
        default: 'full',
        choices: ['full', 's2-only', 'tighten-only', 'mild-tighten']
      })

      .option('grd-hours', {
        type: 'string',
        description: 'gamma-regime-drift: comma-separated UTC hours allowed for entries (e.g. "10,11,12,15"). Default: 10,11,12,15.'
      })

      .option('grd-regimes', {
        type: 'string',
        description: 'gamma-regime-drift: comma-separated regime names that allow long entries (e.g. "positive,strong_positive"). Default: positive,strong_positive.'
      })

      .option('grd-enable-cross-down', {
        type: 'boolean',
        description: 'gamma-regime-drift: also fire SHORT signals when spot crosses below gamma_flip.',
        default: false
      })

      .option('grd-max-term-ratio', {
        type: 'number',
        description: 'gamma-regime-drift: skip entries when 0-DTE/7-DTE IV ratio exceeds this cap (e.g. 1.7).'
      })

      .option('level-proximity', {
        type: 'number',
        description: 'GEX level proximity in points for iv-skew-gex (default 25)',
      })

      .option('trade-support-levels', {
        type: 'string',
        description: 'Comma-separated list of support level types iv-skew-gex may trade (e.g. "S1,S2,S3,PutWall,GammaFlip"). Default: S1-S5,PutWall,GammaFlip.',
      })

      .option('trade-resistance-levels', {
        type: 'string',
        description: 'Comma-separated list of resistance level types iv-skew-gex may trade (e.g. "R1,R2,R3,CallWall,GammaFlip"). Default: R1-R5,CallWall,GammaFlip.',
      })

      .option('max-iv', {
        type: 'number',
        description: 'Maximum ATM IV for entry (e.g., 0.30 = 30%). Rejects entries in high-vol environments.',
      })

      .option('max-iv-shift-at-fill', {
        type: 'number',
        description: 'Max allowed IV change between signal and fill (e.g., 0.03 = 3%). Cancels fill if exceeded.',
      })

      .option('max-iv-volatility', {
        type: 'number',
        description: 'Max pre-signal IV volatility (stddev, e.g., 0.02 = 2%). Rejects signals when IV is too unstable.',
      })

      .option('iv-volatility-lookback', {
        type: 'number',
        description: 'Minutes to look back for IV volatility calculation (default: 15).',
      })

      .option('iv-dead-zone-min', {
        type: 'number',
        description: 'IV dead zone lower bound (e.g., 0.30). Blocks entries when IV is between min and max.',
      })

      .option('iv-dead-zone-max', {
        type: 'number',
        description: 'IV dead zone upper bound (e.g., 0.35). Blocks entries when IV is between min and max.',
      })

      .option('iv-dead-zone-side', {
        type: 'string',
        description: 'Which side the IV dead zone applies to.',
        choices: ['long', 'short', 'both'],
        default: 'both',
      })

      .option('skew-entry-filter', {
        type: 'boolean',
        description: 'Enable skew-trajectory entry filter (iv-skew-gex). Skips entries when 30m thesis-aligned skew widened too far OR 10m skew was in a dead zone.',
      })

      .option('fav-skew-30m-max-adverse', {
        type: 'number',
        description: 'Threshold for thesis-aligned 30m skew widening (default 0.0215 = 2.15%). Skip entry when fav_skew_chg_30m >= this.',
      })

      .option('skew-chg-10m-dead-zone', {
        type: 'number',
        description: 'Threshold for 10m skew dead zone (default 0.005 = 0.5%). Skip entry when |skew_chg_10m| < this.',
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

      .option('neg-skew-threshold', {
        type: 'number',
        description: 'iv-skew-gex: skew below this triggers LONG (e.g., -0.01 = -1%); negative number expected'
      })

      .option('pos-skew-threshold', {
        type: 'number',
        description: 'iv-skew-gex: skew above this triggers SHORT (e.g., 0.01 = +1%); positive number expected'
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

      // MFE Ratchet Trailing Stop (lock % of profit at tier thresholds)
      .group(['mfe-ratchet', 'mfe-ratchet-tiers'], 'MFE Ratchet Trailing Stop:')

      .option('mfe-ratchet', {
        type: 'boolean',
        description: 'Enable MFE ratchet trailing stop (lock % of profit at tier thresholds)',
        default: false
      })

      .option('mfe-ratchet-tiers', {
        type: 'string',
        description: 'Custom MFE ratchet tiers as "minMFE:lockPct,..." e.g. "60:0.90,50:0.85" (highest minMFE first)',
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

      // DC (Directional Changes) Strategy Parameters
      .group(['dc-theta', 'dc-use-points', 'dc-entry-mult', 'dc-extremum-stop', 'dc-extremum-buffer'], 'DC Strategy Parameters:')

      .option('dc-theta', {
        type: 'number',
        description: 'DC threshold (0.001 = 0.1% in pct mode, or absolute points if --dc-use-points)',
        default: 0.001
      })

      .option('dc-use-points', {
        type: 'boolean',
        description: 'Use absolute points instead of percentage for theta',
        default: false
      })

      .option('dc-entry-mult', {
        type: 'number',
        description: 'Entry at N*theta overshoot (paper default: 2.0)',
        default: 2.0
      })

      .option('dc-extremum-stop', {
        type: 'boolean',
        description: 'Place stop at extremum + buffer instead of fixed points',
        default: false
      })

      .option('dc-extremum-buffer', {
        type: 'number',
        description: 'Points beyond extremum for stop placement (with --dc-extremum-stop)',
        default: 5
      })

      .option('dc-duration-mult', {
        type: 'number',
        description: 'OS duration multiplier threshold for St2/St5 (default: 2.0)',
        default: 2.0
      })

      .option('dc-rd-threshold', {
        type: 'number',
        description: 'Duration ratio (T_OS/T_DC) threshold for St5 (default: 2.0)',
        default: 2.0
      })

      .option('dc-consecutive-count', {
        type: 'number',
        description: 'Consecutive OS count for St7/St8 pattern detection (default: 3)',
        default: 3
      })

      .option('mstgam-weights', {
        type: 'string',
        description: 'Path to MSTGAM trained weights JSON file (required for dc-mstgam strategy)'
      })

      // MNQ Adaptive Scalper Parameters
      .group(['soft-stop-points', 'daily-loss-limit', 'daily-target', 'proximity', 'signal-cooldown-ms', 'last-entry-time'], 'MNQ Adaptive Scalper Parameters:')

      .option('soft-stop-points', {
        type: 'number',
        description: 'Soft stop distance in points (0 = disabled, MNQ Adaptive Scalper)'
      })

      .option('daily-loss-limit', {
        type: 'number',
        description: 'Daily loss limit in points — halt trading for the day (MNQ Adaptive Scalper)'
      })

      .option('daily-target', {
        type: 'number',
        description: 'Daily profit target in points — halt trading for the day (MNQ Adaptive Scalper)'
      })

      .option('proximity', {
        type: 'number',
        description: 'Points from level to trigger signal (MNQ Adaptive Scalper)'
      })

      .option('signal-cooldown-ms', {
        type: 'number',
        description: 'Milliseconds between signals (MNQ Adaptive Scalper)'
      })

      .option('last-entry-time', {
        type: 'number',
        description: 'Last entry time as EST decimal, e.g. 15.917 = 3:55 PM (MNQ Adaptive Scalper)'
      })

      // NQ-Leads-ES Strategy Parameters
      .group(['nq-threshold', 'hold-bars', 'gex-regime', 'stop-points'], 'NQ-Leads-ES Strategy:')

      .option('nq-threshold', {
        type: 'number',
        description: 'NQ 1m return threshold to trigger (0.15 = 0.15%, nq-leads-es)'
      })

      .option('hold-bars', {
        type: 'number',
        description: 'Number of 1m bars to hold position (nq-leads-es)'
      })

      .option('gex-regime', {
        type: 'string',
        description: 'GEX regime filter: positive, negative, neutral, mixed, any, positive_or_neutral (nq-leads-es)',
        choices: ['positive', 'negative', 'neutral', 'mixed', 'any', 'positive_or_neutral']
      })

      .option('stop-points', {
        type: 'number',
        description: 'Stop loss in points (0 = time exit only, nq-leads-es / gex-support-bounce)'
      })

      // GEX Support Bounce Strategy Parameters
      .group(['proximity-pct', 'level-types', 'direction', 'require-es-free'], 'GEX Support Bounce Strategy:')

      .option('proximity-pct', {
        type: 'number',
        description: 'Max distance from GEX level as % of price (0.10 = 0.10%, gex-support-bounce)'
      })

      .option('level-types', {
        type: 'string',
        description: 'GEX level types: support_only, resistance_only, all (gex-support-bounce)',
        choices: ['support_only', 'resistance_only', 'all']
      })

      .option('direction', {
        type: 'string',
        description: 'Trade direction: long, short, both (gex-support-bounce)',
        choices: ['long', 'short', 'both']
      })

      .option('require-es-free', {
        type: 'boolean',
        description: 'Require ES to be far from GEX levels (cross-product filter, gex-support-bounce)'
      })

      // LT Structure Confirm Strategy Parameters
      .group(['entry-mode'], 'LT Structure Confirm Strategy:')

      .option('entry-mode', {
        type: 'string',
        description: 'Entry mode: limit (at swing level), market (at signal candle close), proximity (market if within N pts of swing)',
        choices: ['limit', 'market', 'proximity']
      })

      .option('proximity-pts', {
        type: 'number',
        description: 'Max distance from swing level for proximity entry mode (lt-structure-confirm)'
      })

      .option('pivot-lookback', {
        type: 'number',
        description: 'Bars on each side to confirm a swing pivot (lt-structure-confirm, default 9)'
      })

      .option('min-swing-size', {
        type: 'number',
        description: 'Minimum points a pivot must stand out from surrounding bars (lt-structure-confirm, default 15)'
      })

      // Impulse FVG Strategy Parameters
      .group(['min-body-points', 'impulse-mode', 'fvg-pullback-buffer', 'fvg-stop-buffer', 'fvg-target-points', 'fvg-max-wait-bars', 'no-fvg-stop-buffer', 'no-fvg-target-points', 'no-fvg-max-risk', 'signal-cooldown-ms', 'use-limit-entry', 'limit-retrace-pct', 'limit-timeout-bars'], 'Impulse FVG Strategy:')

      .option('min-body-points', {
        type: 'number',
        description: 'Minimum impulse candle body size in points (impulse-fvg)'
      })

      .option('impulse-mode', {
        type: 'string',
        description: 'Strategy mode: both, fvg-pullback, no-fvg-fade (impulse-fvg)',
        choices: ['both', 'fvg-pullback', 'no-fvg-fade']
      })

      .option('fvg-pullback-buffer', {
        type: 'number',
        description: 'Points inside FVG zone for limit entry (impulse-fvg)'
      })

      .option('fvg-stop-buffer', {
        type: 'number',
        description: 'Points beyond FVG opposite edge for stop (impulse-fvg)'
      })

      .option('fvg-target-points', {
        type: 'number',
        description: 'Take profit target for FVG pullback trades (impulse-fvg)'
      })

      .option('fvg-max-wait-bars', {
        type: 'number',
        description: 'Max bars to wait for pullback into FVG (impulse-fvg)'
      })

      .option('no-fvg-stop-buffer', {
        type: 'number',
        description: 'Points beyond impulse extreme for fade stop (impulse-fvg)'
      })

      .option('no-fvg-target-points', {
        type: 'number',
        description: 'Take profit target for no-FVG fade trades (impulse-fvg)'
      })

      .option('no-fvg-max-risk', {
        type: 'number',
        description: 'Max risk in points for fade trades (impulse-fvg)'
      })

      .option('signal-cooldown-ms', {
        type: 'number',
        description: 'Cooldown between signals in milliseconds (impulse-fvg)'
      })

      .option('use-limit-entry', {
        type: 'boolean',
        description: 'Use limit order entry instead of market order for no-FVG fade (impulse-fvg)'
      })

      .option('limit-retrace-pct', {
        type: 'number',
        description: 'Limit order retrace % into impulse body: 0=extreme, 50=midpoint, 100=origin (impulse-fvg)'
      })

      .option('limit-timeout-bars', {
        type: 'number',
        description: 'Cancel unfilled limit order after N bars (impulse-fvg)'
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

    // gex-lt-3m-crossover knobs
    // --glx-preset: named bundle of per-rule exit/filter params. Applied first;
    // individual --glx-* flags below override. See `glx-preset` option above for
    // the choice list and metrics. Presets bake in disabledRules + ruleOverrides;
    // they intentionally mirror the strategy's existing w12 defaults so a v3 run
    // with no other flags is a single-flag invocation.
    const GLX_PRESETS = {
      // w12 = current W12+SCW-PM-block gold (in-code defaults; here so users
      // can explicitly request the "old gold standard" by name).
      'w12': {
        disabledRules: ['L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO', 'S_R3', 'S_R5', 'S_PW_SOLO'],
        ruleOverrides: {
          L_S4:      { targetPts: 120, maxHoldBars: 90 },
          S_GF_SOLO: {                 maxHoldBars: 90 },
          S_CW:      { targetPts: 120, maxHoldBars: 90, blockedHoursEt: [14, 15] },
        },
      },
      // v3 = post-research recommended pick (best PnL × Sharpe balance).
      // Per-rule wider exits (stop=70 across) + per-rule BE + DOW/ltIdx loser-cut filters.
      // Initial engine validation (S_GF_SOLO @ gold params): $211k / PF 1.98 / 604 trades.
      // S_GF_SOLO and S_R4 now upgraded to sweep-best (within mh<=120) configs.
      'v3': {
        disabledRules: ['L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO', 'S_R3', 'S_R5', 'S_PW_SOLO'],
        ruleOverrides: {
          L_S4:      { targetPts: 100, stopPts: 70, maxHoldBars: 120, breakevenTrigger: 70, breakevenOffset: 20, blockedLtIdx: [2, 4], blockedDowsEt: ['Thu', 'Fri'] },
          S_GF_SOLO: { targetPts: 180, stopPts: 70, maxHoldBars: 120, breakevenTrigger: 80, breakevenOffset: 20, blockedHoursEt: [11] },
          S_CW:      { targetPts: 200, stopPts: 70, maxHoldBars: 120, breakevenTrigger: 80, breakevenOffset: 20, blockedHoursEt: [14, 15] },
          S_R4:      { targetPts: 80,  stopPts: 40, maxHoldBars: 60,  trailingTrigger: 70, trailingOffset: 25, blockedLtIdx: [2, 4], blockedDowsEt: ['Fri'], blockedHoursEt: [11, 15] },
        },
      },
      // v3-max = max-PnL variant. Wider L_S4 target + longer max-hold; pays in
      // tied DD vs gold but doubles PnL.
      // Initial engine (S_GF_SOLO @ gold): $264k / PF 2.18 / 547 trades.
      // S_GF_SOLO and S_R4 now upgraded; expected engine ~$300k.
      'v3-max': {
        disabledRules: ['L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO', 'S_R3', 'S_R5', 'S_PW_SOLO'],
        ruleOverrides: {
          L_S4:      { targetPts: 140, stopPts: 70, maxHoldBars: 150, blockedLtIdx: [2, 4], blockedDowsEt: ['Thu', 'Fri'] },
          S_GF_SOLO: { targetPts: 180, stopPts: 70, maxHoldBars: 150, breakevenTrigger: 80, breakevenOffset: 20, blockedHoursEt: [11] },
          S_CW:      { targetPts: 200, stopPts: 70, maxHoldBars: 150, blockedHoursEt: [14, 15] },
          S_R4:      { targetPts: 80,  stopPts: 40, maxHoldBars: 60,  trailingTrigger: 70, trailingOffset: 25, blockedLtIdx: [2, 4], blockedDowsEt: ['Fri'], blockedHoursEt: [11, 15] },
        },
      },
      // v3-balanced = high-Sharpe pick with tighter L_S4 target+BE (more wins,
      // less DD).  Sim: TBD via engine.
      'v3-balanced': {
        disabledRules: ['L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO', 'S_R3', 'S_R5', 'S_PW_SOLO'],
        ruleOverrides: {
          L_S4:      { targetPts: 100, stopPts: 70, maxHoldBars: 120, breakevenTrigger: 70, breakevenOffset: 20, blockedLtIdx: [2, 4], blockedDowsEt: ['Thu', 'Fri'] },
          S_GF_SOLO: { targetPts: 50,  stopPts: 40, maxHoldBars: 60,  breakevenTrigger: 25, breakevenOffset: 5,  blockedHoursEt: [11] },
          S_CW:      { targetPts: 140, stopPts: 50, maxHoldBars: 90,  breakevenTrigger: 60, breakevenOffset: 10, blockedHoursEt: [14, 15] },
          S_R4:      { targetPts: 70,  stopPts: 40, maxHoldBars: 60,  breakevenTrigger: 35, breakevenOffset: 5,  blockedLtIdx: [2, 4], blockedDowsEt: ['Fri'], blockedHoursEt: [11, 15] },
        },
      },
      // v3-low-dd = filter-only at gold exits — smallest DD that still beats gold.
      // Sim: $210k / +14% / PF 1.98 / Sharpe 6.05 / DD $6.7k.
      'v3-low-dd': {
        disabledRules: ['L_S3', 'L_S5_SOLO', 'L_PW', 'S_S2_SOLO', 'S_R3', 'S_R5', 'S_PW_SOLO'],
        ruleOverrides: {
          L_S4:      { targetPts: 120, stopPts: 50, maxHoldBars: 90, blockedLtIdx: [2, 4], blockedDowsEt: ['Thu', 'Fri'] },
          S_GF_SOLO: { targetPts: 60,  stopPts: 50, maxHoldBars: 90, blockedHoursEt: [11] },
          S_CW:      { targetPts: 120, stopPts: 50, maxHoldBars: 90, blockedHoursEt: [14, 15] },
          S_R4:      { targetPts: 80,  stopPts: 50, maxHoldBars: 60, blockedLtIdx: [2, 4], blockedDowsEt: ['Fri'], blockedHoursEt: [11, 15] },
        },
      },
    };
    const glxPreset = args['glx-preset'] ? GLX_PRESETS[args['glx-preset']] : null;
    if (glxPreset) {
      strategyParams.disabledRules = glxPreset.disabledRules;
      strategyParams.ruleOverrides = glxPreset.ruleOverrides;
    }

    if (args['glx-disable-rules']) {
      strategyParams.disabledRules = args['glx-disable-rules']
        .split(',').map(s => s.trim()).filter(Boolean);
    }
    if (args['glx-force-any']) {
      strategyParams.forceFilterAny = true;
    }
    if (args['glx-rule-overrides']) {
      try {
        strategyParams.ruleOverrides = JSON.parse(args['glx-rule-overrides']);
      } catch (e) {
        console.error('❌ --glx-rule-overrides must be valid JSON:', e.message);
        process.exit(1);
      }
    }
    if (args['glx-cooldown-ms'] !== undefined) {
      strategyParams.signalCooldownMs = args['glx-cooldown-ms'];
    }
    if (args['glx-max-hold'] !== undefined) {
      strategyParams.maxHoldBars = args['glx-max-hold'];
    }
    if (args['glx-limit-timeout'] !== undefined) {
      strategyParams.limitTimeoutCandles = args['glx-limit-timeout'];
    }
    if (args['glx-no-entry-window']) {
      strategyParams.disableEntryWindow = true;
    }
    if (args['glx-blocked-hours']) {
      strategyParams.blockedHoursEt = args['glx-blocked-hours']
        .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    }
    if (args['glx-trailing-trigger'] !== undefined) {
      strategyParams.trailingTrigger = args['glx-trailing-trigger'];
    }
    if (args['glx-trailing-offset'] !== undefined) {
      strategyParams.trailingOffset = args['glx-trailing-offset'];
    }
    if (args['glx-breakeven-trigger'] !== undefined) {
      strategyParams.breakevenTrigger = args['glx-breakeven-trigger'];
    }
    if (args['glx-breakeven-offset'] !== undefined) {
      strategyParams.breakevenOffset = args['glx-breakeven-offset'];
    }
    if (args['glx-entry-window']) {
      const m = args['glx-entry-window'].match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
      if (!m) {
        console.error('❌ --glx-entry-window must be HH:MM-HH:MM (ET).');
        process.exit(1);
      }
      strategyParams.entryWindowStartHour = parseInt(m[1], 10);
      strategyParams.entryWindowStartMinute = parseInt(m[2], 10);
      strategyParams.entryWindowEndHour = parseInt(m[3], 10);
      // endMinute not currently honored — engine treats end as :00 of endHour.
    }

    // ls-flip-trigger-bar knobs
    // --lstb-preset: named bundle of params. Applied first; individual --lstb-* flags
    // below override. See cli option `lstb-preset` for the choice list and metrics.
    // NOTE: BE params from preset are applied AFTER the engine-wide --breakeven-stop
    // block (search for "ls-flip-trigger-bar BE/trail (post-engine-wide)" below) — the
    // engine-wide block has `default: false` and would otherwise clobber preset BE.
    const LSTB_PRESETS = {
      v2:            { blockedHours: [5, 16, 21],                              minRange: null, target: null, stop: null, be: false, beTrig: null, beOff: 0, trailTrig: null, trailOff: null },
      v3:            { blockedHours: [5, 16, 17, 18, 19, 20, 21, 22, 23],     minRange: 3,    target: 15,   stop: 12,   be: true,  beTrig: 8,    beOff: 2, trailTrig: null, trailOff: null },
      'v3-max':      { blockedHours: [5, 16, 17, 18, 19, 20, 21, 22, 23],     minRange: 3,    target: 20,   stop: 12,   be: true,  beTrig: 10,   beOff: 1, trailTrig: null, trailOff: null },
      'v3-balanced': { blockedHours: [5, 16, 17, 18, 19, 20, 21, 22, 23],     minRange: 3,    target: 10,   stop: 9,    be: true,  beTrig: 6,    beOff: 1, trailTrig: null, trailOff: null },
      'v3-low-dd':   { blockedHours: [5, 16, 17, 18, 19, 20, 21, 22, 23],     minRange: 3,    target: null, stop: 8,    be: false, beTrig: null, beOff: 0, trailTrig: 12,   trailOff: 5 },
    };
    const lstbPreset = args['lstb-preset'] ? LSTB_PRESETS[args['lstb-preset']] : null;
    if (lstbPreset) {
      strategyParams.blockedHoursEt = lstbPreset.blockedHours;
      strategyParams.minTriggerRange = lstbPreset.minRange;
      strategyParams.targetPoints = lstbPreset.target;
      strategyParams.stopPoints = lstbPreset.stop;
      // BE/trail applied in post-engine-wide block below.
    }
    if (args['lstb-fib'] !== undefined) strategyParams.fib = args['lstb-fib'];
    if (args['lstb-cb-atr-max'] !== undefined) strategyParams.cbAtrMax = args['lstb-cb-atr-max'];
    if (args['lstb-atr-period'] !== undefined) strategyParams.atrPeriod = args['lstb-atr-period'];
    if (args['lstb-fill-timeout'] !== undefined) strategyParams.fillTimeoutCandles = args['lstb-fill-timeout'];
    if (args['lstb-max-hold'] !== undefined) strategyParams.maxHoldBars = args['lstb-max-hold'];
    if (args['lstb-blocked-hours']) {
      strategyParams.blockedHoursEt = args['lstb-blocked-hours']
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isFinite(n) && n >= 0 && n <= 23);
    }
    if (args['lstb-stop-pts'] !== undefined) strategyParams.stopPoints = args['lstb-stop-pts'];
    if (args['lstb-target-pts'] !== undefined) strategyParams.targetPoints = args['lstb-target-pts'];
    if (args['lstb-min-range'] !== undefined) strategyParams.minTriggerRange = args['lstb-min-range'];

    // gex-touch-confirm knobs
    if (args['gtc-iv-skew-threshold'] !== undefined) strategyParams.ivSkewThreshold = args['gtc-iv-skew-threshold'];
    if (args['gtc-no-pinbar']) strategyParams.requirePinbar = false;
    if (args['gtc-no-positive-regime']) strategyParams.requirePositiveRegime = false;
    if (args['gtc-min-dist-threshold'] !== undefined) strategyParams.minDistThreshold = args['gtc-min-dist-threshold'];
    if (args['gtc-s1-threshold'] !== undefined) strategyParams.s1VwapThreshold = args['gtc-s1-threshold'];
    if (args['gtc-atr-threshold'] !== undefined) strategyParams.atrThreshold = args['gtc-atr-threshold'];
    if (args['gtc-use-s1-filter']) strategyParams.useS1VwapFilter = true;
    if (args['gtc-touch-distance'] !== undefined) strategyParams.touchDistance = args['gtc-touch-distance'];
    if (args['gtc-stop-distance'] !== undefined) strategyParams.stopDistance = args['gtc-stop-distance'];
    if (args['gtc-target-points'] !== undefined) strategyParams.targetPoints = args['gtc-target-points'];
    if (args['gtc-limit-timeout'] !== undefined) strategyParams.limitTimeoutCandles = args['gtc-limit-timeout'];
    if (args['gtc-max-hold'] !== undefined) strategyParams.maxHoldBars = args['gtc-max-hold'];
    if (args['gtc-cooldown-ms'] !== undefined) strategyParams.signalCooldownMs = args['gtc-cooldown-ms'];
    if (args['gtc-no-entry-window']) strategyParams.disableEntryWindow = true;
    if (args['gtc-snap-lag-min'] !== undefined) strategyParams.snapLagMin = args['gtc-snap-lag-min'];
    if (args['gtp-rulebook']) strategyParams.rulebookName = args['gtp-rulebook'];
    if (args['gtp-trigger-window'] !== undefined) strategyParams.triggerWindowMin = args['gtp-trigger-window'];
    if (args['gtp-no-entry-window']) strategyParams.disableEntryWindow = true;
    if (args['gtp-entry-window']) {
      const m = args['gtp-entry-window'].match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
      if (m) {
        strategyParams.entryWindowStartHour = parseInt(m[1], 10);
        strategyParams.entryWindowStartMinute = parseInt(m[2], 10);
        strategyParams.entryWindowEndHour = parseInt(m[3], 10);
        strategyParams.entryWindowEndMinute = parseInt(m[4], 10);
      }
    }
    if (args['gtc-entry-window']) {
      const m = args['gtc-entry-window'].match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
      if (!m) {
        console.error('❌ --gtc-entry-window must be HH:MM-HH:MM (ET).');
        process.exit(1);
      }
      strategyParams.entryWindowStartHour = parseInt(m[1], 10);
      strategyParams.entryWindowStartMinute = parseInt(m[2], 10);
      strategyParams.entryWindowEndHour = parseInt(m[3], 10);
      strategyParams.entryWindowEndMinute = parseInt(m[4], 10);
    }

    // gex-level-fade --glf-preset (named bundle). Applied FIRST; individual --glf-*
    // flags below override. BE settings are applied LAST in the post-engine-wide
    // block to avoid the same clobber trap as lstb/gfi (engine-wide
    // --breakeven-offset has default:0 which clobbers strategyParams.breakevenOffset).
    // See "glf preset/individual BE apply" further down.
    const GLF_PRESETS = {
      gold:        { tgt: 100, stop: 18, mh: 180, beTrig: null, beOff: null,  levels: 'PRH,PRL,SH,SL', entryWin: '09:00-10:30', includeGex: true },
      v2:          { tgt: 110, stop: 22, mh: 180, beTrig: 100,  beOff: 10,    levels: 'PRH,PRL',       entryWin: '09:00-10:30', includeGex: true },
      'v2-max':    { tgt: 140, stop: 25, mh: 180, beTrig: 100,  beOff: 20,    levels: 'PRH,PRL,SH,SL', entryWin: '09:00-10:30', includeGex: true },
      'v2-low-dd': { tgt: 110, stop: 20, mh: 180, beTrig: 80,   beOff: 10,    levels: 'PRH,PRL',       entryWin: '09:00-10:30', includeGex: true },
    };
    const glfPreset = args['glf-preset'] ? GLF_PRESETS[args['glf-preset']] : null;
    if (glfPreset) {
      strategyParams.targetPts = glfPreset.tgt;
      strategyParams.stopPts = glfPreset.stop;
      strategyParams.maxHoldBars = glfPreset.mh;
      strategyParams.levels = glfPreset.levels.split(',').map(s => s.trim()).filter(Boolean);
      strategyParams.includeGexLevels = glfPreset.includeGex;
      const m = glfPreset.entryWin.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
      if (m) {
        strategyParams.entryWindowStartHour = parseInt(m[1], 10);
        strategyParams.entryWindowStartMinute = parseInt(m[2], 10);
        strategyParams.entryWindowEndHour = parseInt(m[3], 10);
        strategyParams.entryWindowEndMinute = parseInt(m[4], 10);
      }
      // BE applied in post-engine-wide block below to avoid clobber.
    }

    // gex-level-fade knobs
    if (args['glf-target-pts'] !== undefined) strategyParams.targetPts = args['glf-target-pts'];
    if (args['glf-stop-pts'] !== undefined) strategyParams.stopPts = args['glf-stop-pts'];
    if (args['glf-max-hold'] !== undefined) strategyParams.maxHoldBars = args['glf-max-hold'];
    if (args['glf-levels']) {
      strategyParams.levels = args['glf-levels'].split(',').map(s => s.trim()).filter(Boolean);
    }
    if (args['glf-blocked-regimes']) {
      strategyParams.blockedRegimes = args['glf-blocked-regimes'].split(',').map(s => s.trim()).filter(Boolean);
    }
    if (args['glf-blocked-hours']) {
      strategyParams.blockedHoursEt = args['glf-blocked-hours']
        .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    }
    if (args['glf-entry-window']) {
      const m = args['glf-entry-window'].match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
      if (m) {
        strategyParams.entryWindowStartHour = parseInt(m[1], 10);
        strategyParams.entryWindowStartMinute = parseInt(m[2], 10);
        strategyParams.entryWindowEndHour = parseInt(m[3], 10);
        strategyParams.entryWindowEndMinute = parseInt(m[4], 10);
      }
    }
    if (args['glf-no-entry-window']) strategyParams.disableEntryWindow = true;
    if (args['glf-min-ep']) strategyParams.minEpisodeNum = args['glf-min-ep'];
    if (args['glf-direction']) strategyParams.directionMode = args['glf-direction'];
    if (args['glf-max-last-pen'] !== undefined) strategyParams.maxLastEpPenetrationPts = args['glf-max-last-pen'];
    if (args['glf-min-last-bars'] !== undefined) strategyParams.minLastEpBarsInZone = args['glf-min-last-bars'];
    if (args['glf-min-rej-5m'] !== undefined) strategyParams.minLastEpRej5m = args['glf-min-rej-5m'];
    if (args['glf-min-rej-15m'] !== undefined) strategyParams.minLastEpRej15m = args['glf-min-rej-15m'];
    if (args['glf-rej-wick-pts'] !== undefined) strategyParams.rejectionWickMinPts = args['glf-rej-wick-pts'];
    if (args['glf-min-vol-bursts'] !== undefined) strategyParams.minLastEpVolBursts = args['glf-min-vol-bursts'];
    if (args['glf-vol-burst-mult'] !== undefined) strategyParams.volBurstMult = args['glf-vol-burst-mult'];
    if (args['glf-include-gex']) strategyParams.includeGexLevels = true;
    if (args['glf-gex-types']) strategyParams.gexLevelTypes = args['glf-gex-types'].split(',').map(s => s.trim()).filter(Boolean);
    if (args['glf-trailing-trigger'] !== undefined) strategyParams.trailingTrigger = args['glf-trailing-trigger'];
    if (args['glf-trailing-offset'] !== undefined) strategyParams.trailingOffset = args['glf-trailing-offset'];
    if (args['glf-breakeven-trigger'] !== undefined) strategyParams.breakevenTrigger = args['glf-breakeven-trigger'];
    if (args['glf-breakeven-offset'] !== undefined) strategyParams.breakevenOffset = args['glf-breakeven-offset'];

    // gex-flip-ivpct: --gfi-preset (named bundle). Applied FIRST; individual --gfi-*
    // flags below override. BE/maxHold are applied here too (no clobber risk because
    // the engine-wide --breakeven-stop block defaults to undefined, not false — the
    // gfi block below it re-applies if --gfi-breakeven-stop is passed).
    // NOTE: as with lstb, the engine-wide block has `default: false` for breakeven-
    // stop; we work around by also re-setting breakevenStop=true after that block
    // when this preset is selected. Search for "gex-flip-ivpct preset BE/dow apply"
    // below.
    const GFI_PRESETS = {
      tight: {
        globalStopPts: 60, globalTargetPts: 200, maxHoldBars: 600,
        be: true, beTrig: 70, beOff: 5,
        blockedHoursEt: [6, 7, 8], blockedDowsEt: [], disabledRules: [],
      },
      v2: {
        globalStopPts: 60, globalTargetPts: 260, maxHoldBars: 600,
        be: true, beTrig: 160, beOff: 10,
        blockedHoursEt: [6, 7, 8], blockedDowsEt: [], disabledRules: [],
      },
      'v2-max': {
        globalStopPts: 60, globalTargetPts: 320, maxHoldBars: 480,
        be: true, beTrig: 160, beOff: 10,
        blockedHoursEt: [6, 7, 8], blockedDowsEt: [], disabledRules: [],
      },
      'v2-low-dd': {
        globalStopPts: 60, globalTargetPts: 260, maxHoldBars: 600,
        be: true, beTrig: 160, beOff: 10,
        blockedHoursEt: [6, 7, 8, 11], blockedDowsEt: ['Fri'], disabledRules: ['S1'],
      },
    };
    const gfiPreset = args['gfi-preset'] ? GFI_PRESETS[args['gfi-preset']] : null;
    if (gfiPreset) {
      strategyParams.globalStopPts = gfiPreset.globalStopPts;
      strategyParams.globalTargetPts = gfiPreset.globalTargetPts;
      strategyParams.maxHoldBars = gfiPreset.maxHoldBars;
      strategyParams.blockedHoursEt = gfiPreset.blockedHoursEt;
      strategyParams.blockedDowsEt = gfiPreset.blockedDowsEt;
      strategyParams.disabledRules = gfiPreset.disabledRules;
      // BE applied in post-engine-wide block below to avoid clobber.
    }

    // gex-flip-ivpct: non-BE/trailing overrides (keep these before the engine-wide
    // BE/trailing block so they don't get clobbered)
    if (args['gfi-stop-pts'] !== undefined) strategyParams.globalStopPts = args['gfi-stop-pts'];
    if (args['gfi-target-pts'] !== undefined) strategyParams.globalTargetPts = args['gfi-target-pts'];
    if (args['gfi-rule-overrides']) {
      try {
        strategyParams.ruleOverrides = JSON.parse(args['gfi-rule-overrides']);
      } catch (e) {
        console.error('❌ --gfi-rule-overrides must be valid JSON:', e.message);
        process.exit(1);
      }
    }
    if (args['gfi-disable-rules']) {
      strategyParams.disabledRules = args['gfi-disable-rules']
        .split(',').map(s => s.trim()).filter(Boolean);
    }
    if (args['gfi-blocked-hours']) {
      strategyParams.blockedHoursEt = args['gfi-blocked-hours']
        .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    }
    if (args['gfi-blocked-dows']) {
      strategyParams.blockedDowsEt = args['gfi-blocked-dows']
        .split(',').map(s => s.trim()).filter(Boolean);
    }

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
    if (args.negSkewThreshold !== undefined) strategyParams.negSkewThreshold = args.negSkewThreshold;
    if (args.posSkewThreshold !== undefined) strategyParams.posSkewThreshold = args.posSkewThreshold;
    if (args.levelProximity !== undefined) strategyParams.levelProximity = args.levelProximity;
    if (args.tradeSupportLevels) {
      strategyParams.tradeSupportLevels = args.tradeSupportLevels.split(',').map((s) => s.trim());
    }
    if (args.tradeResistanceLevels) {
      strategyParams.tradeResistanceLevels = args.tradeResistanceLevels.split(',').map((s) => s.trim());
    }
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

    // gex-flip-ivpct preset BE/dow apply — MUST come after the engine-wide
    // breakevenStop block above (same trap as lstb). Preset BE applied first;
    // individual --gfi-* flags below override.
    if (gfiPreset && gfiPreset.be) {
      strategyParams.breakevenStop = true;
      strategyParams.breakevenTrigger = gfiPreset.beTrig;
      strategyParams.breakevenOffset = gfiPreset.beOff;
    }

    // gex-flip-ivpct BE/trailing overrides — MUST come after the engine-wide
    // breakevenStop block above, because that block writes default:false and
    // would clobber strategyParams.breakevenStop if our flag ran first.
    if (args['gfi-breakeven-stop']) strategyParams.breakevenStop = true;
    if (args['gfi-breakeven-trigger'] !== undefined) strategyParams.breakevenTrigger = args['gfi-breakeven-trigger'];
    if (args['gfi-breakeven-offset'] !== undefined) strategyParams.breakevenOffset = args['gfi-breakeven-offset'];
    if (args['gfi-trailing-trigger'] !== undefined) strategyParams.trailingTrigger = args['gfi-trailing-trigger'];
    if (args['gfi-trailing-offset'] !== undefined) strategyParams.trailingOffset = args['gfi-trailing-offset'];

    // ls-flip-trigger-bar BE/trail (post-engine-wide) — same clobber-fix pattern as gfi.
    // Preset BE/trail applied first; individual --lstb-* flags below override.
    // LSTB_PRESETS is defined in the lstb knobs block above (same scope).
    if (lstbPreset) {
      strategyParams.breakevenStop = lstbPreset.be;
      strategyParams.breakevenTrigger = lstbPreset.beTrig;
      strategyParams.breakevenOffset = lstbPreset.beOff;
      strategyParams.trailingTrigger = lstbPreset.trailTrig;
      strategyParams.trailingOffset = lstbPreset.trailOff;
    }
    if (args['lstb-breakeven-stop']) {
      strategyParams.breakevenStop = true;
      if (args['lstb-be-trigger'] !== undefined) strategyParams.breakevenTrigger = args['lstb-be-trigger'];
      if (args['lstb-be-offset'] !== undefined) strategyParams.breakevenOffset = args['lstb-be-offset'];
    }
    if (args['lstb-trail-trigger'] !== undefined) strategyParams.trailingTrigger = args['lstb-trail-trigger'];
    if (args['lstb-trail-offset'] !== undefined) strategyParams.trailingOffset = args['lstb-trail-offset'];

    // glf preset/individual BE apply — MUST come after the engine-wide
    // breakevenStop block above (same clobber trap as lstb/gfi). Preset BE applied
    // first; individual --glf-* flags override.
    if (glfPreset && glfPreset.beTrig != null) {
      strategyParams.breakevenStop = true;
      strategyParams.breakevenTrigger = glfPreset.beTrig;
      strategyParams.breakevenOffset = glfPreset.beOff;
    }
    if (args['glf-breakeven-trigger'] !== undefined) {
      strategyParams.breakevenTrigger = args['glf-breakeven-trigger'];
      if (strategyParams.breakevenTrigger > 0) strategyParams.breakevenStop = true;
    }
    if (args['glf-breakeven-offset'] !== undefined) {
      strategyParams.breakevenOffset = args['glf-breakeven-offset'];
    }
    if (args['glf-trailing-trigger'] !== undefined) strategyParams.trailingTrigger = args['glf-trailing-trigger'];
    if (args['glf-trailing-offset'] !== undefined) strategyParams.trailingOffset = args['glf-trailing-offset'];

    // gex-flip-ivpct: structural-magnet MFE ratchet (1m 9/9 swing pivots)
    if (args['gfi-magnet-ratchet']) {
      strategyParams.magnetRatchet = true;
      if (args['gfi-magnet-lock-pct'] !== undefined) strategyParams.magnetLockPct = args['gfi-magnet-lock-pct'];
      if (args['gfi-magnet-recency-hours'] !== undefined) {
        strategyParams.magnetRecencyMs = args['gfi-magnet-recency-hours'] * 60 * 60 * 1000;
      }
      if (args['gfi-magnet-fixed-per-tier']) strategyParams.magnetFixedPerTier = true;
      if (args['gfi-magnet-fallback-tiers']) {
        const tiers = args['gfi-magnet-fallback-tiers']
          .split(',').map(s => s.trim()).map(tierStr => {
            const [minMFE, lockPct] = tierStr.split(':').map(Number);
            return { minMFE, lockPct };
          }).filter(t => !isNaN(t.minMFE) && !isNaN(t.lockPct));
        if (tiers.length > 0) strategyParams.magnetFallbackTiers = tiers;
      }
    }

    // gex-flip-ivpct: Fibonacci-retrace bar-close exit. Independent of magnet
    // ratchet — they can co-exist (whichever fires first wins). The hard SL
    // stays in place either way.
    if (args['gfi-fib-retrace']) {
      strategyParams.fibRetrace = true;
      if (args['gfi-fib-retrace-pct'] !== undefined) strategyParams.fibRetracePct = args['gfi-fib-retrace-pct'];
      if (args['gfi-fib-activation-mfe'] !== undefined) strategyParams.fibActivationMFE = args['gfi-fib-activation-mfe'];
      if (args['gfi-fib-conditional']) {
        strategyParams.fibConditional = true;
        if (args['gfi-fib-conditional-mode']) {
          strategyParams.fibConditionalMode = args['gfi-fib-conditional-mode'];
        }
      }
    }

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

    // MFE ratchet trailing stop parameters
    if (args.mfeRatchet) strategyParams.mfeRatchet = true;

    // Parse custom MFE ratchet tiers: "minMFE:lockPct,minMFE:lockPct,..."
    if (args.mfeRatchetTiers) {
      const tiers = args.mfeRatchetTiers.split(',').map(s => s.trim()).map(tierStr => {
        const [minMFE, lockPct] = tierStr.split(':').map(Number);
        return { minMFE, lockPct, label: `lock ${Math.round(lockPct * 100)}%` };
      }).filter(t => !isNaN(t.minMFE) && !isNaN(t.lockPct));
      // Sort highest minMFE first (ratchet evaluates highest-first)
      tiers.sort((a, b) => b.minMFE - a.minMFE);
      if (tiers.length > 0) {
        strategyParams.mfeRatchet = true;
        strategyParams.mfeRatchetTiers = tiers;
      }
    }

    // Time-based trailing stop parameters (progressive profit protection)
    if (args.timeBasedTrailing !== undefined) strategyParams.timeBasedTrailing = args.timeBasedTrailing;

    // Parse time-based trailing rules from CLI format: "bars,mfe,action"
    // action can be "breakeven", "trail:N", or "close_below" (close if MFE < threshold)
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
      } else if (parts[2] === 'close_below') {
        // Inverse rule: close the trade if MFE is BELOW ifMFE after afterBars bars
        rule.action = 'close_below';
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

    // IV cap filter
    if (args.maxIv !== undefined) strategyParams.maxIV = args.maxIv;

    // IV shift at fill filter
    if (args.maxIvShiftAtFill !== undefined) strategyParams.maxIVShiftAtFill = args.maxIvShiftAtFill;

    // IV volatility filter
    if (args.maxIvVolatility !== undefined) strategyParams.maxIVVolatility = args.maxIvVolatility;
    if (args.ivVolatilityLookback !== undefined) strategyParams.ivVolatilityLookback = args.ivVolatilityLookback;

    // IV dead zone filter
    if (args.ivDeadZoneMin !== undefined) strategyParams.ivDeadZoneMin = args.ivDeadZoneMin;
    if (args.ivDeadZoneMax !== undefined) strategyParams.ivDeadZoneMax = args.ivDeadZoneMax;
    if (args.ivDeadZoneSide !== undefined) strategyParams.ivDeadZoneSide = args.ivDeadZoneSide;

    // Skew-trajectory entry filter
    if (args.skewEntryFilter !== undefined) strategyParams.skewEntryFilter = args.skewEntryFilter;
    if (args.favSkew30mMaxAdverse !== undefined) strategyParams.favSkew30mMaxAdverse = args.favSkew30mMaxAdverse;
    if (args.skewChg10mDeadZone !== undefined) strategyParams.skewChg10mDeadZone = args.skewChg10mDeadZone;

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
    if (args['glf-include-gex']) strategyParams.includeGexLevels = true;

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

    // DC (Directional Changes) Strategy Parameters
    if (args.dcTheta !== undefined) strategyParams.theta = args.dcTheta;
    if (args.dcUsePoints !== undefined) strategyParams.usePoints = args.dcUsePoints;
    if (args.dcEntryMult !== undefined) strategyParams.entryMultiplier = args.dcEntryMult;
    if (args.dcExtremumStop !== undefined) strategyParams.useExtremumStop = args.dcExtremumStop;
    if (args.dcExtremumBuffer !== undefined) strategyParams.extremumStopBuffer = args.dcExtremumBuffer;
    if (args.dcDurationMult !== undefined) strategyParams.durationMultiplier = args.dcDurationMult;
    if (args.dcRdThreshold !== undefined) strategyParams.rdThreshold = args.dcRdThreshold;
    if (args.dcConsecutiveCount !== undefined) strategyParams.consecutiveCount = args.dcConsecutiveCount;
    if (args.mstgamWeights !== undefined) strategyParams.weightsFile = args.mstgamWeights;

    // Gamma Regime Drift Parameters
    if (args.grdHours !== undefined) {
      strategyParams.allowedHoursUTC = String(args.grdHours).split(',').map(s => parseInt(s, 10));
    }
    if (args.grdRegimes !== undefined) {
      strategyParams.allowedRegimes = String(args.grdRegimes).split(',').map(s => s.trim());
    }
    if (args.grdEnableCrossDown !== undefined) {
      strategyParams.enableCrossDown = args.grdEnableCrossDown;
      if (args.grdEnableCrossDown) strategyParams.enableShort = true;
    }
    if (args.grdMaxTermRatio !== undefined) strategyParams.maxTermRatio = args.grdMaxTermRatio;

    // MNQ Adaptive Scalper Parameters
    if (args.softStopPoints !== undefined) strategyParams.softStopPoints = args.softStopPoints;
    if (args.dailyLossLimit !== undefined) strategyParams.dailyLossLimit = args.dailyLossLimit;
    if (args.dailyTarget !== undefined) strategyParams.dailyTarget = args.dailyTarget;
    if (args.proximity !== undefined) strategyParams.proximity = args.proximity;
    if (args.signalCooldownMs !== undefined) strategyParams.signalCooldownMs = args.signalCooldownMs;
    if (args.lastEntryTime !== undefined) strategyParams.lastEntryTime = args.lastEntryTime;

    // NQ-Leads-ES Strategy Parameters
    if (args.nqThreshold !== undefined) strategyParams.nqThreshold = args.nqThreshold / 100; // CLI takes %, strategy uses decimal
    if (args.holdBars !== undefined) {
      strategyParams.holdBars = args.holdBars;
      strategyParams.maxHoldBars = args.holdBars;
    }
    if (args.gexRegime !== undefined) strategyParams.gexRegime = args.gexRegime;
    if (args.stopPoints !== undefined) strategyParams.stopPoints = args.stopPoints;

    // GEX Support Bounce Strategy Parameters
    if (args.proximityPct !== undefined) strategyParams.proximityPct = args.proximityPct;
    if (args.levelTypes !== undefined) strategyParams.levelTypes = args.levelTypes;
    if (args.direction !== undefined) strategyParams.direction = args.direction;
    if (args.requireEsFree !== undefined) strategyParams.requireEsFree = args.requireEsFree;

    // Impulse FVG Strategy Parameters
    if (args.minBodyPoints !== undefined) strategyParams.minBodyPoints = args.minBodyPoints;
    if (args.impulseMode !== undefined) strategyParams.mode = args.impulseMode;
    if (args.fvgPullbackBuffer !== undefined) strategyParams.fvgPullbackBuffer = args.fvgPullbackBuffer;
    if (args.fvgStopBuffer !== undefined) strategyParams.fvgStopBuffer = args.fvgStopBuffer;
    if (args.fvgTargetPoints !== undefined) strategyParams.fvgTargetPoints = args.fvgTargetPoints;
    if (args.fvgMaxWaitBars !== undefined) strategyParams.fvgMaxWaitBars = args.fvgMaxWaitBars;
    if (args.noFvgStopBuffer !== undefined) strategyParams.noFvgStopBuffer = args.noFvgStopBuffer;
    if (args.noFvgTargetPoints !== undefined) strategyParams.noFvgTargetPoints = args.noFvgTargetPoints;
    if (args.noFvgMaxRisk !== undefined) strategyParams.noFvgMaxRisk = args.noFvgMaxRisk;
    if (args.signalCooldownMs !== undefined) strategyParams.signalCooldownMs = args.signalCooldownMs;
    if (args.useLimitEntry !== undefined) strategyParams.useLimitEntry = args.useLimitEntry;
    if (args.limitRetracePct !== undefined) strategyParams.limitRetracePct = args.limitRetracePct;
    if (args.limitTimeoutBars !== undefined) strategyParams.limitTimeoutBars = args.limitTimeoutBars;

    // Both strategies need dataDir for companion data loading
    strategyParams.dataDir = args.dataDir;

    // LT Structure Confirm Strategy Parameters
    if (args.entryMode !== undefined) strategyParams.entryMode = args.entryMode;
    if (args.proximityPts !== undefined) strategyParams.proximityPts = args.proximityPts;
    if (args.pivotLookback !== undefined) strategyParams.pivotLookback = args.pivotLookback;
    if (args.minSwingSize !== undefined) strategyParams.minSwingSize = args.minSwingSize;

    // Suppress strategy debug logging when --quiet
    if (args.quiet) strategyParams.debug = false;

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
      ivResolution: args.ivResolution,
      gexDir: args.gexDir || null, // Custom GEX directory (e.g., data/gex-cbbo/nq/ for CBBO-based GEX)
      lt1mFile: args['lt-1m-file'] || args.lt1mFile || null, // 1m LT CSV path for gex-lt-3m-crossover
      s1VwapFile: args['s1-vwap-file'] || args.s1VwapFile || null, // s1 VWAP feature CSV for gex-touch-confirm
      ls1mFile: args['ls-1m-file'] || args.ls1mFile || null, // 1m LS flip CSV path for ls-flip-trigger-bar
      eodCutoffEt: args.eodCutoffEt || null, // ET cutoff (HH:MM) for day-trade-margin liquidation
      strictLimitFill: args.strictFill ?? false, // require trade-through (low<entry / high>entry) for limit fills
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