/**
 * GEX-Liquidity Correlation Analyzer
 *
 * Analyzes how price behaves at GEX levels (support/resistance) based on
 * the concurrent liquidity (LDPS) state. Tests the hypothesis that:
 * - Bullish LDPS + GEX Support = higher bounce probability
 * - Bearish LDPS + GEX Support = higher break probability
 * - And vice versa for resistance levels
 */

import { GexLoader } from '../data-loaders/gex-loader.js';
import { CSVLoader } from '../data/csv-loader.js';
import path from 'path';
import fs from 'fs';

/**
 * Configuration for level touch detection
 */
const DEFAULT_CONFIG = {
  // How close price must get to level to count as "touch" (in points)
  touchThreshold: 5,

  // How many candles to look ahead for outcome measurement
  lookAheadCandles: 60, // 60 minutes = 1 hour

  // Minimum move to count as "bounce" vs "chop" (in points)
  minBouncePoints: 10,

  // Minimum move to count as "break" (in points)
  minBreakPoints: 15,

  // Session filters (EST hours)
  sessions: {
    overnight: { start: 18, end: 4 },    // 6pm - 4am
    premarket: { start: 4, end: 9.5 },   // 4am - 9:30am
    rth: { start: 9.5, end: 16 },        // 9:30am - 4pm
    afterhours: { start: 16, end: 18 }   // 4pm - 6pm
  },

  // Which GEX levels to analyze
  levelsToAnalyze: ['support', 'resistance', 'gamma_flip']
};

/**
 * Event types for GEX level interactions
 */
const EventType = {
  TOUCH_SUPPORT: 'touch_support',
  TOUCH_RESISTANCE: 'touch_resistance',
  TOUCH_GAMMA_FLIP: 'touch_gamma_flip'
};

/**
 * Outcome types for level interactions
 */
const OutcomeType = {
  BOUNCE: 'bounce',      // Price reverses from level
  BREAK: 'break',        // Price goes through level
  CHOP: 'chop',          // No decisive move
  UNKNOWN: 'unknown'     // Insufficient data
};

export class GexLiquidityAnalyzer {
  constructor(dataDir, config = {}) {
    this.dataDir = dataDir;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.gexLoader = new GexLoader(path.join(dataDir, 'gex'));
    this.csvLoader = new CSVLoader(dataDir, this.getCSVConfig());

    // Analysis results
    this.events = [];
    this.statistics = {};
  }

  /**
   * Get CSV loader configuration
   */
  getCSVConfig() {
    return {
      dataFormat: {
        ohlcv: {
          timestampField: 'ts_event',
          symbolField: 'symbol',
          openField: 'open',
          highField: 'high',
          lowField: 'low',
          closeField: 'close',
          volumeField: 'volume'
        },
        liquidity: {
          timestampField: 'datetime',
          sentimentField: 'sentiment',
          levelFields: ['level_1', 'level_2', 'level_3', 'level_4', 'level_5']
        },
        gex: {
          dateField: 'date',
          gammaFlipField: 'nq_gamma_flip',
          putWallFields: ['nq_put_wall_1', 'nq_put_wall_2', 'nq_put_wall_3'],
          callWallFields: ['nq_call_wall_1', 'nq_call_wall_2', 'nq_call_wall_3'],
          regimeField: 'regime',
          totalGexField: 'total_gex'
        }
      }
    };
  }

  /**
   * Run the full analysis
   */
  async analyze(startDate, endDate) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  GEX-Liquidity Correlation Analysis');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Load all data
    console.log('📊 Loading data...\n');

    await this.gexLoader.loadDateRange(startDate, endDate);

    const { candles } = await this.csvLoader.loadOHLCVData('NQ', startDate, endDate);
    const liquidityData = await this.csvLoader.loadLiquidityData('NQ', startDate, endDate);

    console.log(`\n📈 Data loaded:`);
    console.log(`   - ${candles.length.toLocaleString()} OHLCV candles`);
    console.log(`   - ${liquidityData.length.toLocaleString()} liquidity records`);
    console.log(`   - ${this.gexLoader.sortedTimestamps.length.toLocaleString()} GEX snapshots\n`);

    // Build lookup maps for efficient access
    const liquidityMap = this.buildLiquidityMap(liquidityData);

    // Detect level touch events
    console.log('🔍 Detecting GEX level touch events...\n');
    this.detectLevelTouches(candles, liquidityMap);

    console.log(`   Found ${this.events.length.toLocaleString()} level touch events\n`);

    // Measure outcomes
    console.log('📏 Measuring event outcomes...\n');
    this.measureOutcomes(candles);

    // Calculate statistics
    console.log('📊 Calculating statistics...\n');
    this.calculateStatistics();

    // Print results
    this.printResults();

    return this.getResults();
  }

  /**
   * Build a map for efficient liquidity lookups by timestamp
   */
  buildLiquidityMap(liquidityData) {
    const map = new Map();

    for (const record of liquidityData) {
      // Key by 15-minute bucket
      const bucketTs = Math.floor(record.timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);
      map.set(bucketTs, record);
    }

    return map;
  }

  /**
   * Get liquidity state for a given timestamp
   */
  getLiquidityState(timestamp, liquidityMap) {
    // Round down to 15-minute bucket
    const bucketTs = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

    // Try exact match first
    if (liquidityMap.has(bucketTs)) {
      return liquidityMap.get(bucketTs);
    }

    // Try previous bucket
    const prevBucket = bucketTs - (15 * 60 * 1000);
    if (liquidityMap.has(prevBucket)) {
      return liquidityMap.get(prevBucket);
    }

    return null;
  }

  /**
   * Detect all instances where price touches a GEX level
   */
  detectLevelTouches(candles, liquidityMap) {
    const threshold = this.config.touchThreshold;
    const cooldownMs = 15 * 60 * 1000; // 15 minutes between same-level events
    const lastTouchTimes = new Map();

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const candleDate = new Date(candle.timestamp);

      // Get GEX levels for this timestamp
      const gexLevels = this.gexLoader.getGexLevels(candleDate);
      if (!gexLevels) continue;

      // Get liquidity state
      const liquidityState = this.getLiquidityState(candle.timestamp, liquidityMap);

      // Check support levels
      const supportLevels = gexLevels.support || [];
      for (let j = 0; j < supportLevels.length && j < 3; j++) {
        const level = supportLevels[j];
        if (!level) continue;

        const levelKey = `support_${j}_${Math.round(level)}`;
        const lastTouch = lastTouchTimes.get(levelKey) || 0;

        // Check if price touched this level from above
        if (candle.low <= level + threshold &&
            candle.high >= level - threshold &&
            candle.timestamp - lastTouch > cooldownMs) {

          this.events.push({
            type: EventType.TOUCH_SUPPORT,
            levelType: `support_${j + 1}`,
            levelPrice: level,
            timestamp: candle.timestamp,
            candleIndex: i,
            candle: { ...candle },
            gexLevels: { ...gexLevels },
            liquidityState: liquidityState ? { ...liquidityState } : null,
            session: this.getSession(candleDate),
            gexRegime: gexLevels.regime
          });

          lastTouchTimes.set(levelKey, candle.timestamp);
        }
      }

      // Check resistance levels
      const resistanceLevels = gexLevels.resistance || [];
      for (let j = 0; j < resistanceLevels.length && j < 3; j++) {
        const level = resistanceLevels[j];
        if (!level) continue;

        const levelKey = `resistance_${j}_${Math.round(level)}`;
        const lastTouch = lastTouchTimes.get(levelKey) || 0;

        // Check if price touched this level from below
        if (candle.high >= level - threshold &&
            candle.low <= level + threshold &&
            candle.timestamp - lastTouch > cooldownMs) {

          this.events.push({
            type: EventType.TOUCH_RESISTANCE,
            levelType: `resistance_${j + 1}`,
            levelPrice: level,
            timestamp: candle.timestamp,
            candleIndex: i,
            candle: { ...candle },
            gexLevels: { ...gexLevels },
            liquidityState: liquidityState ? { ...liquidityState } : null,
            session: this.getSession(candleDate),
            gexRegime: gexLevels.regime
          });

          lastTouchTimes.set(levelKey, candle.timestamp);
        }
      }

      // Check gamma flip level
      const gammaFlip = gexLevels.gamma_flip;
      if (gammaFlip) {
        const levelKey = `gamma_flip_${Math.round(gammaFlip)}`;
        const lastTouch = lastTouchTimes.get(levelKey) || 0;

        if (candle.low <= gammaFlip + threshold &&
            candle.high >= gammaFlip - threshold &&
            candle.timestamp - lastTouch > cooldownMs) {

          this.events.push({
            type: EventType.TOUCH_GAMMA_FLIP,
            levelType: 'gamma_flip',
            levelPrice: gammaFlip,
            timestamp: candle.timestamp,
            candleIndex: i,
            candle: { ...candle },
            gexLevels: { ...gexLevels },
            liquidityState: liquidityState ? { ...liquidityState } : null,
            session: this.getSession(candleDate),
            gexRegime: gexLevels.regime
          });

          lastTouchTimes.set(levelKey, candle.timestamp);
        }
      }
    }
  }

  /**
   * Determine trading session for a timestamp
   */
  getSession(date) {
    // Convert to EST
    const estHour = date.getUTCHours() - 5; // Simplified EST conversion
    const adjustedHour = estHour < 0 ? estHour + 24 : estHour;

    const sessions = this.config.sessions;

    if (adjustedHour >= sessions.rth.start && adjustedHour < sessions.rth.end) {
      return 'rth';
    } else if (adjustedHour >= sessions.premarket.start && adjustedHour < sessions.premarket.end) {
      return 'premarket';
    } else if (adjustedHour >= sessions.afterhours.start && adjustedHour < sessions.afterhours.end) {
      return 'afterhours';
    } else {
      return 'overnight';
    }
  }

  /**
   * Measure outcomes for all detected events
   */
  measureOutcomes(candles) {
    const lookAhead = this.config.lookAheadCandles;

    for (const event of this.events) {
      const startIdx = event.candleIndex;
      const endIdx = Math.min(startIdx + lookAhead, candles.length - 1);

      // Track price movement after the touch
      let maxFavorable = 0;  // Max move in expected direction
      let maxAdverse = 0;    // Max move against expected direction
      let closePrice = event.candle.close;

      const isSupport = event.type === EventType.TOUCH_SUPPORT;
      const isResistance = event.type === EventType.TOUCH_RESISTANCE;

      for (let i = startIdx + 1; i <= endIdx; i++) {
        const candle = candles[i];

        if (isSupport) {
          // For support, favorable = price going up
          const upMove = candle.high - event.levelPrice;
          const downMove = event.levelPrice - candle.low;
          maxFavorable = Math.max(maxFavorable, upMove);
          maxAdverse = Math.max(maxAdverse, downMove);
          closePrice = candle.close;
        } else if (isResistance) {
          // For resistance, favorable = price going down
          const downMove = event.levelPrice - candle.low;
          const upMove = candle.high - event.levelPrice;
          maxFavorable = Math.max(maxFavorable, downMove);
          maxAdverse = Math.max(maxAdverse, upMove);
          closePrice = candle.close;
        } else {
          // For gamma flip, track both directions
          const upMove = candle.high - event.levelPrice;
          const downMove = event.levelPrice - candle.low;
          maxFavorable = Math.max(maxFavorable, Math.max(upMove, downMove));
          maxAdverse = 0; // N/A for gamma flip
          closePrice = candle.close;
        }
      }

      // Determine outcome
      const minBounce = this.config.minBouncePoints;
      const minBreak = this.config.minBreakPoints;

      let outcome;
      if (isSupport) {
        if (maxAdverse >= minBreak) {
          outcome = OutcomeType.BREAK;
        } else if (maxFavorable >= minBounce) {
          outcome = OutcomeType.BOUNCE;
        } else {
          outcome = OutcomeType.CHOP;
        }
      } else if (isResistance) {
        if (maxAdverse >= minBreak) {
          outcome = OutcomeType.BREAK;
        } else if (maxFavorable >= minBounce) {
          outcome = OutcomeType.BOUNCE;
        } else {
          outcome = OutcomeType.CHOP;
        }
      } else {
        // Gamma flip - any significant move counts
        if (maxFavorable >= minBounce) {
          outcome = OutcomeType.BOUNCE;
        } else {
          outcome = OutcomeType.CHOP;
        }
      }

      event.outcome = {
        type: outcome,
        maxFavorable: Math.round(maxFavorable * 100) / 100,
        maxAdverse: Math.round(maxAdverse * 100) / 100,
        netMove: Math.round((closePrice - event.candle.close) * 100) / 100,
        candlesAnalyzed: endIdx - startIdx
      };
    }
  }

  /**
   * Calculate statistics by various groupings
   */
  calculateStatistics() {
    // Filter to events with outcomes
    const validEvents = this.events.filter(e => e.outcome);

    // Overall stats
    this.statistics.overall = this.calcGroupStats(validEvents, 'All Events');

    // By LDPS sentiment
    this.statistics.bySentiment = {
      bullish: this.calcGroupStats(
        validEvents.filter(e => e.liquidityState?.sentiment === 'BULLISH'),
        'BULLISH Sentiment'
      ),
      bearish: this.calcGroupStats(
        validEvents.filter(e => e.liquidityState?.sentiment === 'BEARISH'),
        'BEARISH Sentiment'
      ),
      unknown: this.calcGroupStats(
        validEvents.filter(e => !e.liquidityState),
        'Unknown Sentiment'
      )
    };

    // By event type (support vs resistance)
    this.statistics.byEventType = {
      support: this.calcGroupStats(
        validEvents.filter(e => e.type === EventType.TOUCH_SUPPORT),
        'Support Levels'
      ),
      resistance: this.calcGroupStats(
        validEvents.filter(e => e.type === EventType.TOUCH_RESISTANCE),
        'Resistance Levels'
      ),
      gammaFlip: this.calcGroupStats(
        validEvents.filter(e => e.type === EventType.TOUCH_GAMMA_FLIP),
        'Gamma Flip'
      )
    };

    // Key combinations: Sentiment + Event Type
    this.statistics.combinations = {
      bullish_support: this.calcGroupStats(
        validEvents.filter(e =>
          e.liquidityState?.sentiment === 'BULLISH' &&
          e.type === EventType.TOUCH_SUPPORT
        ),
        'BULLISH + Support'
      ),
      bearish_support: this.calcGroupStats(
        validEvents.filter(e =>
          e.liquidityState?.sentiment === 'BEARISH' &&
          e.type === EventType.TOUCH_SUPPORT
        ),
        'BEARISH + Support'
      ),
      bullish_resistance: this.calcGroupStats(
        validEvents.filter(e =>
          e.liquidityState?.sentiment === 'BULLISH' &&
          e.type === EventType.TOUCH_RESISTANCE
        ),
        'BULLISH + Resistance'
      ),
      bearish_resistance: this.calcGroupStats(
        validEvents.filter(e =>
          e.liquidityState?.sentiment === 'BEARISH' &&
          e.type === EventType.TOUCH_RESISTANCE
        ),
        'BEARISH + Resistance'
      )
    };

    // By GEX regime
    this.statistics.byRegime = {};
    const regimes = [...new Set(validEvents.map(e => e.gexRegime).filter(r => r))];
    for (const regime of regimes) {
      this.statistics.byRegime[regime] = this.calcGroupStats(
        validEvents.filter(e => e.gexRegime === regime),
        `${regime} GEX Regime`
      );
    }

    // By session
    this.statistics.bySession = {
      rth: this.calcGroupStats(
        validEvents.filter(e => e.session === 'rth'),
        'Regular Trading Hours'
      ),
      premarket: this.calcGroupStats(
        validEvents.filter(e => e.session === 'premarket'),
        'Pre-Market'
      ),
      overnight: this.calcGroupStats(
        validEvents.filter(e => e.session === 'overnight'),
        'Overnight'
      ),
      afterhours: this.calcGroupStats(
        validEvents.filter(e => e.session === 'afterhours'),
        'After Hours'
      )
    };

    // By specific level (support_1, support_2, etc.)
    this.statistics.byLevel = {};
    const levelTypes = [...new Set(validEvents.map(e => e.levelType))];
    for (const levelType of levelTypes) {
      this.statistics.byLevel[levelType] = this.calcGroupStats(
        validEvents.filter(e => e.levelType === levelType),
        levelType
      );
    }
  }

  /**
   * Calculate statistics for a group of events
   */
  calcGroupStats(events, groupName) {
    if (events.length === 0) {
      return { name: groupName, count: 0 };
    }

    const bounces = events.filter(e => e.outcome.type === OutcomeType.BOUNCE);
    const breaks = events.filter(e => e.outcome.type === OutcomeType.BREAK);
    const chops = events.filter(e => e.outcome.type === OutcomeType.CHOP);

    const favorableMoves = events.map(e => e.outcome.maxFavorable);
    const adverseMoves = events.map(e => e.outcome.maxAdverse);
    const netMoves = events.map(e => e.outcome.netMove);

    return {
      name: groupName,
      count: events.length,
      bounceCount: bounces.length,
      breakCount: breaks.length,
      chopCount: chops.length,
      bounceRate: Math.round((bounces.length / events.length) * 1000) / 10,
      breakRate: Math.round((breaks.length / events.length) * 1000) / 10,
      chopRate: Math.round((chops.length / events.length) * 1000) / 10,
      avgFavorable: Math.round(this.average(favorableMoves) * 100) / 100,
      avgAdverse: Math.round(this.average(adverseMoves) * 100) / 100,
      avgNetMove: Math.round(this.average(netMoves) * 100) / 100,
      maxFavorable: Math.round(Math.max(...favorableMoves) * 100) / 100,
      maxAdverse: Math.round(Math.max(...adverseMoves) * 100) / 100
    };
  }

  /**
   * Calculate average of array
   */
  average(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  /**
   * Print analysis results
   */
  printResults() {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ANALYSIS RESULTS');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Overall
    this.printGroupStats(this.statistics.overall);

    // Key hypothesis test: Does LDPS sentiment affect GEX level behavior?
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  LDPS SENTIMENT IMPACT ON GEX LEVELS');
    console.log('───────────────────────────────────────────────────────────\n');

    console.log('SUPPORT LEVELS:');
    this.printGroupStats(this.statistics.combinations.bullish_support, '  ');
    this.printGroupStats(this.statistics.combinations.bearish_support, '  ');

    const supportDiff = (this.statistics.combinations.bullish_support.bounceRate || 0) -
                       (this.statistics.combinations.bearish_support.bounceRate || 0);
    console.log(`  → Bullish sentiment ${supportDiff > 0 ? 'INCREASES' : 'DECREASES'} support bounce rate by ${Math.abs(supportDiff).toFixed(1)}%\n`);

    console.log('RESISTANCE LEVELS:');
    this.printGroupStats(this.statistics.combinations.bullish_resistance, '  ');
    this.printGroupStats(this.statistics.combinations.bearish_resistance, '  ');

    const resistanceDiff = (this.statistics.combinations.bearish_resistance.bounceRate || 0) -
                          (this.statistics.combinations.bullish_resistance.bounceRate || 0);
    console.log(`  → Bearish sentiment ${resistanceDiff > 0 ? 'INCREASES' : 'DECREASES'} resistance bounce rate by ${Math.abs(resistanceDiff).toFixed(1)}%\n`);

    // By GEX regime
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  BY GEX REGIME');
    console.log('───────────────────────────────────────────────────────────\n');

    for (const [regime, stats] of Object.entries(this.statistics.byRegime)) {
      this.printGroupStats(stats, '  ');
    }

    // By session
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  BY TRADING SESSION');
    console.log('───────────────────────────────────────────────────────────\n');

    this.printGroupStats(this.statistics.bySession.rth, '  ');
    this.printGroupStats(this.statistics.bySession.premarket, '  ');
    this.printGroupStats(this.statistics.bySession.overnight, '  ');

    // By specific level
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  BY LEVEL TYPE');
    console.log('───────────────────────────────────────────────────────────\n');

    for (const [level, stats] of Object.entries(this.statistics.byLevel)) {
      this.printGroupStats(stats, '  ');
    }

    // Actionable insights
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ACTIONABLE INSIGHTS');
    console.log('═══════════════════════════════════════════════════════════\n');

    this.generateInsights();
  }

  /**
   * Print statistics for a group
   */
  printGroupStats(stats, indent = '') {
    if (!stats || stats.count === 0) {
      console.log(`${indent}${stats?.name || 'Unknown'}: No data`);
      return;
    }

    console.log(`${indent}${stats.name} (n=${stats.count}):`);
    console.log(`${indent}  Bounce: ${stats.bounceRate}% (${stats.bounceCount}) | Break: ${stats.breakRate}% (${stats.breakCount}) | Chop: ${stats.chopRate}% (${stats.chopCount})`);
    console.log(`${indent}  Avg Favorable: ${stats.avgFavorable} pts | Avg Adverse: ${stats.avgAdverse} pts | Net: ${stats.avgNetMove} pts\n`);
  }

  /**
   * Generate actionable trading insights
   */
  generateInsights() {
    const insights = [];

    // Compare bullish vs bearish at support
    const bullSupp = this.statistics.combinations.bullish_support;
    const bearSupp = this.statistics.combinations.bearish_support;

    if (bullSupp.count >= 20 && bearSupp.count >= 20) {
      const diff = bullSupp.bounceRate - bearSupp.bounceRate;
      if (Math.abs(diff) >= 5) {
        insights.push({
          type: 'support_filter',
          finding: diff > 0
            ? `BULLISH sentiment increases support bounce rate by ${diff.toFixed(1)}%`
            : `BEARISH sentiment increases support bounce rate by ${Math.abs(diff).toFixed(1)}%`,
          recommendation: diff > 0
            ? 'Filter long entries at support to BULLISH LDPS conditions'
            : 'Consider counter-trend shorts at support during BEARISH conditions',
          magnitude: Math.abs(diff),
          sampleSize: bullSupp.count + bearSupp.count
        });
      }
    }

    // Compare bullish vs bearish at resistance
    const bullRes = this.statistics.combinations.bullish_resistance;
    const bearRes = this.statistics.combinations.bearish_resistance;

    if (bullRes.count >= 20 && bearRes.count >= 20) {
      const diff = bearRes.bounceRate - bullRes.bounceRate;
      if (Math.abs(diff) >= 5) {
        insights.push({
          type: 'resistance_filter',
          finding: diff > 0
            ? `BEARISH sentiment increases resistance bounce rate by ${diff.toFixed(1)}%`
            : `BULLISH sentiment increases resistance bounce rate by ${Math.abs(diff).toFixed(1)}%`,
          recommendation: diff > 0
            ? 'Filter short entries at resistance to BEARISH LDPS conditions'
            : 'Consider avoiding shorts at resistance during BULLISH conditions',
          magnitude: Math.abs(diff),
          sampleSize: bullRes.count + bearRes.count
        });
      }
    }

    // Best performing level type
    const levels = Object.entries(this.statistics.byLevel)
      .filter(([_, stats]) => stats.count >= 20)
      .sort((a, b) => b[1].bounceRate - a[1].bounceRate);

    if (levels.length > 0) {
      const [bestLevel, bestStats] = levels[0];
      insights.push({
        type: 'best_level',
        finding: `${bestLevel} has the highest bounce rate at ${bestStats.bounceRate}%`,
        recommendation: `Prioritize ${bestLevel} for level-based entries`,
        magnitude: bestStats.bounceRate,
        sampleSize: bestStats.count
      });
    }

    // Print insights
    for (const insight of insights) {
      console.log(`📊 ${insight.finding}`);
      console.log(`   → ${insight.recommendation}`);
      console.log(`   (Sample: n=${insight.sampleSize}, Magnitude: ${insight.magnitude.toFixed(1)}%)\n`);
    }

    if (insights.length === 0) {
      console.log('⚠️  Insufficient data to generate actionable insights.');
      console.log('   Need at least 20 events per comparison group.\n');
    }

    this.statistics.insights = insights;
  }

  /**
   * Get full results object
   */
  getResults() {
    return {
      events: this.events,
      statistics: this.statistics,
      config: this.config,
      summary: {
        totalEvents: this.events.length,
        dateRange: this.events.length > 0 ? {
          start: new Date(Math.min(...this.events.map(e => e.timestamp))),
          end: new Date(Math.max(...this.events.map(e => e.timestamp)))
        } : null
      }
    };
  }

  /**
   * Export results to JSON
   */
  exportResults(filepath) {
    const results = this.getResults();
    fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
    console.log(`\n💾 Results exported to ${filepath}`);
  }
}

/**
 * CLI entry point
 */
export async function runAnalysis(args = {}) {
  const dataDir = args.dataDir || path.join(process.cwd(), 'data');
  const startDate = args.startDate ? new Date(args.startDate) : new Date('2023-03-28');
  const endDate = args.endDate ? new Date(args.endDate) : new Date('2025-12-24');

  const analyzer = new GexLiquidityAnalyzer(dataDir, args.config || {});

  try {
    const results = await analyzer.analyze(startDate, endDate);

    if (args.outputFile) {
      analyzer.exportResults(args.outputFile);
    }

    return results;
  } catch (error) {
    console.error('Analysis failed:', error);
    throw error;
  }
}
