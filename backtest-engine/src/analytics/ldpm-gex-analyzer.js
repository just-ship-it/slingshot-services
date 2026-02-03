/**
 * LDPM-GEX Correlation Analyzer
 *
 * Analyzes how LDPM level characteristics affect price behavior at GEX levels:
 * - Level ordering (ascending, descending, mixed patterns)
 * - Level stacking/spacing (tight vs spread)
 * - Level direction (rising vs falling as price approaches GEX)
 * - Confluence between LDPM and GEX levels
 */

import fs from 'fs';
import path from 'path';
import { GexLoader } from '../data-loaders/gex-loader.js';

export class LdpmGexAnalyzer {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this.touchThreshold = options.touchThreshold || 5; // Points to consider "touching" a GEX level
    this.lookAheadCandles = options.lookAheadCandles || 60; // 1 hour of 1-min candles
    this.lookBackPeriods = options.lookBackPeriods || 4; // 4 x 15-min = 1 hour lookback for LDPM direction

    this.gexLoader = new GexLoader(path.join(this.dataDir, 'gex'));
    this.ohlcvData = [];
    this.liquidityData = new Map(); // keyed by timestamp
    this.events = [];
  }

  /**
   * Load all required data
   */
  async loadData(startDate, endDate) {
    console.log('\n📊 Loading data...\n');

    // Load GEX data
    await this.gexLoader.loadDateRange(startDate, endDate);

    // Load OHLCV data
    await this.loadOhlcvData();

    // Load and index liquidity data
    await this.loadLiquidityData();

    console.log(`\n📈 Data loaded:`);
    console.log(`   - ${this.ohlcvData.length.toLocaleString()} OHLCV candles`);
    console.log(`   - ${this.liquidityData.size.toLocaleString()} liquidity records`);
    console.log(`   - ${this.gexLoader.sortedTimestamps.length.toLocaleString()} GEX snapshots`);
  }

  /**
   * Load OHLCV data from CSV
   */
  async loadOhlcvData() {
    const ohlcvPath = path.join(this.dataDir, 'ohlcv', 'NQ_ohlcv_1m.csv');
    console.log(`📊 Loading OHLCV data from ${ohlcvPath}...`);

    const content = fs.readFileSync(ohlcvPath, 'utf8');
    const lines = content.trim().split('\n');

    let total = 0;
    let filtered = 0;

    // CSV format: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 10) continue;

      total++;
      const symbol = parts[9]; // Symbol is column 9

      // Skip calendar spreads (contain dash like NQH1-NQM1)
      if (symbol && symbol.includes('-')) continue;

      filtered++;
      const timestamp = new Date(parts[0]);

      this.ohlcvData.push({
        timestamp,
        open: parseFloat(parts[4]),
        high: parseFloat(parts[5]),
        low: parseFloat(parts[6]),
        close: parseFloat(parts[7]),
        volume: parseInt(parts[8]),
        symbol
      });
    }

    // Sort by timestamp
    this.ohlcvData.sort((a, b) => a.timestamp - b.timestamp);
    console.log(`✅ Loaded ${filtered.toLocaleString()} candles (filtered from ${total.toLocaleString()} total)`);
  }

  /**
   * Load liquidity data and index by 15-min timestamp
   */
  async loadLiquidityData() {
    const liquidityPath = path.join(this.dataDir, 'liquidity', 'NQ_liquidity_levels.csv');
    console.log(`📊 Loading liquidity data from ${liquidityPath}...`);

    const content = fs.readFileSync(liquidityPath, 'utf8');
    const lines = content.trim().split('\n');

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 7) continue;

      const timestamp = new Date(parts[0]);
      const timestampKey = timestamp.getTime();

      const levels = [
        parseFloat(parts[3]), // level_1
        parseFloat(parts[4]), // level_2
        parseFloat(parts[5]), // level_3
        parseFloat(parts[6]), // level_4
        parseFloat(parts[7])  // level_5
      ];

      this.liquidityData.set(timestampKey, {
        timestamp,
        sentiment: parts[2],
        levels,
        ...this.analyzeLevelCharacteristics(levels)
      });
    }

    console.log(`✅ Loaded ${this.liquidityData.size.toLocaleString()} liquidity records`);
  }

  /**
   * Analyze characteristics of LDPM levels
   */
  analyzeLevelCharacteristics(levels) {
    const sorted = [...levels].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[4];
    const spread = max - min;
    const midpoint = (max + min) / 2;

    // Find which level index is highest and lowest
    const minIndex = levels.indexOf(min);
    const maxIndex = levels.indexOf(max);

    // Determine ordering pattern
    let ordering = this.classifyOrdering(levels);

    // Calculate spacing between adjacent levels
    const spacings = [];
    for (let i = 0; i < levels.length - 1; i++) {
      spacings.push(Math.abs(levels[i + 1] - levels[i]));
    }
    const avgSpacing = spacings.reduce((a, b) => a + b, 0) / spacings.length;
    const minSpacing = Math.min(...spacings);

    // Detect tight clustering (stacking)
    const tightThreshold = spread * 0.15; // 15% of total spread
    const tightlyStacked = minSpacing < tightThreshold;

    // Calculate center of mass (weighted average position)
    const centerOfMass = levels.reduce((a, b) => a + b, 0) / levels.length;

    return {
      spread,
      midpoint,
      centerOfMass,
      minLevel: min,
      maxLevel: max,
      minLevelIndex: minIndex,
      maxLevelIndex: maxIndex,
      ordering,
      avgSpacing,
      minSpacing,
      tightlyStacked,
      // Position of level_1 relative to others (above/below midpoint)
      level1Position: levels[0] > midpoint ? 'above' : 'below'
    };
  }

  /**
   * Classify the ordering pattern of levels
   */
  classifyOrdering(levels) {
    // Check if ascending (L1 < L2 < L3 < L4 < L5)
    let ascending = true;
    let descending = true;

    for (let i = 0; i < levels.length - 1; i++) {
      if (levels[i] >= levels[i + 1]) ascending = false;
      if (levels[i] <= levels[i + 1]) descending = false;
    }

    if (ascending) return 'ASCENDING';
    if (descending) return 'DESCENDING';

    // Check for V-pattern (levels decrease then increase, L3 is lowest)
    const minIdx = levels.indexOf(Math.min(...levels));
    if (minIdx === 2) {
      // L3 is minimum - check if L1 > L2 > L3 and L3 < L4 < L5
      if (levels[0] > levels[1] && levels[1] > levels[2] &&
          levels[2] < levels[3] && levels[3] < levels[4]) {
        return 'V_PATTERN';
      }
    }

    // Check for inverted V (levels increase then decrease, L3 is highest)
    const maxIdx = levels.indexOf(Math.max(...levels));
    if (maxIdx === 2) {
      if (levels[0] < levels[1] && levels[1] < levels[2] &&
          levels[2] > levels[3] && levels[3] > levels[4]) {
        return 'INVERTED_V';
      }
    }

    // Check if L1 is outlier (much different from L2-L5)
    const l2to5 = levels.slice(1);
    const l2to5Range = Math.max(...l2to5) - Math.min(...l2to5);
    const l1Distance = Math.min(
      Math.abs(levels[0] - Math.max(...l2to5)),
      Math.abs(levels[0] - Math.min(...l2to5))
    );
    if (l1Distance > l2to5Range * 0.5) {
      return levels[0] > Math.max(...l2to5) ? 'L1_HIGH_OUTLIER' : 'L1_LOW_OUTLIER';
    }

    return 'MIXED';
  }

  /**
   * Get LDPM data at a specific timestamp (finds nearest 15-min snapshot)
   */
  getLdpmAt(timestamp) {
    const targetTime = timestamp.getTime();

    // Round down to nearest 15-minute interval
    const rounded = Math.floor(targetTime / (15 * 60 * 1000)) * (15 * 60 * 1000);

    // Try exact match first
    if (this.liquidityData.has(rounded)) {
      return this.liquidityData.get(rounded);
    }

    // Try previous interval
    const prev = rounded - (15 * 60 * 1000);
    if (this.liquidityData.has(prev)) {
      return this.liquidityData.get(prev);
    }

    return null;
  }

  /**
   * Calculate LDPM direction (rising/falling) over lookback period
   * Tracks individual level slopes for granular analysis
   */
  getLdpmDirection(timestamp, lookbackPeriods = this.lookBackPeriods) {
    const current = this.getLdpmAt(timestamp);
    if (!current) return null;

    const intervalMs = 15 * 60 * 1000;
    const history = [];

    // Collect historical LDPM data
    for (let i = 0; i <= lookbackPeriods; i++) {
      const t = timestamp.getTime() - (i * intervalMs);
      const rounded = Math.floor(t / intervalMs) * intervalMs;
      const data = this.liquidityData.get(rounded);
      if (data) {
        history.push(data);
      }
    }

    if (history.length < 2) return null;

    // Calculate direction and SLOPE of each level
    const levelDirections = [];
    let risingCount = 0;
    let fallingCount = 0;

    for (let lvl = 0; lvl < 5; lvl++) {
      const oldest = history[history.length - 1].levels[lvl];
      const newest = history[0].levels[lvl];
      const change = newest - oldest;
      const pctChange = (change / oldest) * 100;

      // Calculate slope (points per 15-min period)
      const periodsElapsed = history.length - 1;
      const slope = periodsElapsed > 0 ? change / periodsElapsed : 0;

      const direction = change > 5 ? 'RISING' : change < -5 ? 'FALLING' : 'FLAT';
      if (direction === 'RISING') risingCount++;
      if (direction === 'FALLING') fallingCount++;

      levelDirections.push({
        level: lvl + 1,
        change,
        pctChange,
        slope, // Points per 15-min period
        direction
      });
    }

    // Consensus: are most levels moving same direction?
    let levelConsensus = 'MIXED';
    if (risingCount >= 4) levelConsensus = 'MOSTLY_RISING';
    else if (fallingCount >= 4) levelConsensus = 'MOSTLY_FALLING';
    else if (risingCount >= 3) levelConsensus = 'LEANING_RISING';
    else if (fallingCount >= 3) levelConsensus = 'LEANING_FALLING';

    // Average slope across all levels
    const avgSlope = levelDirections.reduce((s, d) => s + d.slope, 0) / 5;

    // Overall direction based on center of mass movement
    const oldestCom = history[history.length - 1].centerOfMass;
    const newestCom = history[0].centerOfMass;
    const comChange = newestCom - oldestCom;
    const comSlope = (history.length - 1) > 0 ? comChange / (history.length - 1) : 0;

    // Spread direction (expanding or contracting)
    const oldestSpread = history[history.length - 1].spread;
    const newestSpread = history[0].spread;
    const spreadChange = newestSpread - oldestSpread;

    // Classify slope strength
    let slopeStrength = 'NEUTRAL';
    if (avgSlope > 10) slopeStrength = 'STRONG_RISING';
    else if (avgSlope > 3) slopeStrength = 'RISING';
    else if (avgSlope < -10) slopeStrength = 'STRONG_FALLING';
    else if (avgSlope < -3) slopeStrength = 'FALLING';

    return {
      levelDirections,
      levelConsensus,
      avgSlope,
      slopeStrength,
      overallDirection: comChange > 10 ? 'RISING' : comChange < -10 ? 'FALLING' : 'FLAT',
      comChange,
      comSlope,
      spreadDirection: spreadChange > 5 ? 'EXPANDING' : spreadChange < -5 ? 'CONTRACTING' : 'STABLE',
      spreadChange,
      periodsAnalyzed: history.length,
      risingLevels: risingCount,
      fallingLevels: fallingCount
    };
  }

  /**
   * Detect LDPM level crossovers (when levels change relative ordering)
   * Crossovers indicate shifting liquidity on higher timeframes
   */
  detectLdpmCrossovers(timestamp, lookbackPeriods = 4) {
    const intervalMs = 15 * 60 * 1000;
    const history = [];

    // Collect historical LDPM data
    for (let i = 0; i <= lookbackPeriods; i++) {
      const t = timestamp.getTime() - (i * intervalMs);
      const rounded = Math.floor(t / intervalMs) * intervalMs;
      const data = this.liquidityData.get(rounded);
      if (data) {
        history.push(data);
      }
    }

    if (history.length < 2) return null;

    const current = history[0];
    const previous = history[1];
    const oldest = history[history.length - 1];

    // Detect crossovers between adjacent levels
    const crossovers = [];

    for (let i = 0; i < 4; i++) {
      const currentDiff = current.levels[i] - current.levels[i + 1];
      const previousDiff = previous.levels[i] - previous.levels[i + 1];

      // Crossover: sign change in the difference
      if (Math.sign(currentDiff) !== Math.sign(previousDiff) && previousDiff !== 0) {
        const crossType = currentDiff > 0 ? 'CROSS_ABOVE' : 'CROSS_BELOW';
        crossovers.push({
          levels: `L${i + 1}_L${i + 2}`,
          type: crossType,
          currentDiff,
          previousDiff
        });
      }
    }

    // Check for ordering changes (did the overall pattern change?)
    const currentOrdering = this.getLevelRanking(current.levels);
    const previousOrdering = this.getLevelRanking(previous.levels);
    const orderingChanged = currentOrdering !== previousOrdering;

    // Count how many level pairs have crossed over the lookback period
    let totalCrossovers = 0;
    for (let h = 1; h < history.length; h++) {
      for (let i = 0; i < 4; i++) {
        const currDiff = history[h - 1].levels[i] - history[h - 1].levels[i + 1];
        const prevDiff = history[h].levels[i] - history[h].levels[i + 1];
        if (Math.sign(currDiff) !== Math.sign(prevDiff) && prevDiff !== 0) {
          totalCrossovers++;
        }
      }
    }

    // Detect convergence/divergence of levels
    const currentSpread = current.spread;
    const oldestSpread = oldest.spread;
    const spreadTrend = currentSpread < oldestSpread * 0.9 ? 'CONVERGING' :
                        currentSpread > oldestSpread * 1.1 ? 'DIVERGING' : 'STABLE';

    // Check if L1 crossed above/below the pack (significant shift)
    const currentL1Position = this.getL1RelativePosition(current.levels);
    const previousL1Position = this.getL1RelativePosition(previous.levels);
    const l1PositionChanged = currentL1Position !== previousL1Position;

    return {
      recentCrossovers: crossovers,
      recentCrossoverCount: crossovers.length,
      totalCrossoversInLookback: totalCrossovers,
      orderingChanged,
      currentOrdering,
      previousOrdering,
      spreadTrend,
      l1PositionChanged,
      currentL1Position,
      hasCrossover: crossovers.length > 0,
      hasMultipleCrossovers: totalCrossovers >= 2,
      isHighActivity: totalCrossovers >= 3
    };
  }

  /**
   * Get a string representing the ranking of levels (for comparison)
   */
  getLevelRanking(levels) {
    const indexed = levels.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    return indexed.map(x => x.i).join('');
  }

  /**
   * Get L1's position relative to other levels
   */
  getL1RelativePosition(levels) {
    const l1 = levels[0];
    const others = levels.slice(1);
    const aboveCount = others.filter(l => l1 > l).length;

    if (aboveCount >= 4) return 'HIGHEST';
    if (aboveCount >= 3) return 'HIGH';
    if (aboveCount <= 0) return 'LOWEST';
    if (aboveCount <= 1) return 'LOW';
    return 'MIDDLE';
  }

  /**
   * Calculate price direction over lookback period
   */
  getPriceDirection(index, lookbackCandles = 15) {
    if (index < lookbackCandles) return null;

    const current = this.ohlcvData[index].close;
    const past = this.ohlcvData[index - lookbackCandles].close;
    const change = current - past;

    return {
      direction: change > 10 ? 'RISING' : change < -10 ? 'FALLING' : 'FLAT',
      change,
      pctChange: (change / past) * 100
    };
  }

  /**
   * Detect when price approaches GEX levels and capture LDPM state
   */
  detectGexApproaches(startDate, endDate) {
    console.log('\n🔍 Detecting GEX level approaches with LDPM context...\n');

    const events = [];
    const startTime = startDate.getTime();
    const endTime = endDate.getTime();

    // Track cooldowns to avoid duplicate events
    const levelCooldowns = new Map();
    const cooldownMs = 30 * 60 * 1000; // 30 minute cooldown per level

    for (let i = 15; i < this.ohlcvData.length - this.lookAheadCandles; i++) {
      const candle = this.ohlcvData[i];
      const candleTime = candle.timestamp.getTime();

      if (candleTime < startTime || candleTime > endTime) continue;

      // Get GEX levels at this time
      const gexData = this.gexLoader.getGexLevels(candle.timestamp);
      if (!gexData) continue;

      // Get LDPM data and direction
      const ldpm = this.getLdpmAt(candle.timestamp);
      if (!ldpm) continue;

      const ldpmDirection = this.getLdpmDirection(candle.timestamp);
      const priceDirection = this.getPriceDirection(i);
      const crossoverData = this.detectLdpmCrossovers(candle.timestamp);

      // Check each GEX level for touches
      const levels = [
        { price: gexData.support?.[0], type: 'support_1', side: 'support' },
        { price: gexData.support?.[1], type: 'support_2', side: 'support' },
        { price: gexData.support?.[2], type: 'support_3', side: 'support' },
        { price: gexData.resistance?.[0], type: 'resistance_1', side: 'resistance' },
        { price: gexData.resistance?.[1], type: 'resistance_2', side: 'resistance' },
        { price: gexData.resistance?.[2], type: 'resistance_3', side: 'resistance' },
        { price: gexData.gamma_flip, type: 'gamma_flip', side: 'neutral' }
      ].filter(l => l.price != null);

      for (const level of levels) {
        // Check if price touched this level
        const touchedFromAbove = candle.low <= level.price + this.touchThreshold &&
                                  candle.high > level.price;
        const touchedFromBelow = candle.high >= level.price - this.touchThreshold &&
                                  candle.low < level.price;

        if (!touchedFromAbove && !touchedFromBelow) continue;

        // Check cooldown
        const cooldownKey = `${level.type}_${Math.round(level.price)}`;
        const lastTouch = levelCooldowns.get(cooldownKey) || 0;
        if (candleTime - lastTouch < cooldownMs) continue;

        levelCooldowns.set(cooldownKey, candleTime);

        // Calculate LDPM-GEX relationship
        const ldpmGexRelationship = this.analyzeLdpmGexRelationship(
          ldpm, level.price, candle.close, level.side
        );

        // Measure outcome
        const outcome = this.measureOutcome(i, level.price, level.side);

        // Determine price vs LDPM direction relationship
        let priceLdpmRelationship = 'unknown';
        if (priceDirection && ldpmDirection) {
          if (priceDirection.direction === ldpmDirection.overallDirection) {
            priceLdpmRelationship = 'SAME_DIRECTION';
          } else if (
            (priceDirection.direction === 'RISING' && ldpmDirection.overallDirection === 'FALLING') ||
            (priceDirection.direction === 'FALLING' && ldpmDirection.overallDirection === 'RISING')
          ) {
            priceLdpmRelationship = 'OPPOSITE_DIRECTION';
          } else {
            priceLdpmRelationship = 'MIXED';
          }
        }

        // Key analysis: approaching resistance with LDPM direction
        // or approaching support with LDPM direction
        let approachContext = null;
        if (level.side === 'resistance' && priceDirection?.direction === 'RISING') {
          // Price rising to resistance
          if (ldpmDirection?.overallDirection === 'RISING') {
            approachContext = 'RESISTANCE_PRICE_UP_LDPM_UP'; // Deteriorating liquidity
          } else if (ldpmDirection?.overallDirection === 'FALLING') {
            approachContext = 'RESISTANCE_PRICE_UP_LDPM_DOWN'; // Improving liquidity
          } else {
            approachContext = 'RESISTANCE_PRICE_UP_LDPM_FLAT';
          }
        } else if (level.side === 'support' && priceDirection?.direction === 'FALLING') {
          // Price falling to support
          if (ldpmDirection?.overallDirection === 'FALLING') {
            approachContext = 'SUPPORT_PRICE_DOWN_LDPM_DOWN'; // LDPM chasing price down
          } else if (ldpmDirection?.overallDirection === 'RISING') {
            approachContext = 'SUPPORT_PRICE_DOWN_LDPM_UP'; // LDPM diverging
          } else {
            approachContext = 'SUPPORT_PRICE_DOWN_LDPM_FLAT';
          }
        }

        // Is LDPM "leading" or "lagging" price?
        // If price and LDPM moving same direction, but LDPM moved more = leading
        let ldpmLeadLag = null;
        if (priceDirection && ldpmDirection && ldpmDirection.comChange) {
          const priceMovePts = priceDirection.change;
          const ldpmMovePts = ldpmDirection.comChange;
          if (Math.sign(priceMovePts) === Math.sign(ldpmMovePts)) {
            ldpmLeadLag = Math.abs(ldpmMovePts) > Math.abs(priceMovePts) ? 'LDPM_LEADING' : 'LDPM_LAGGING';
          } else {
            ldpmLeadLag = 'LDPM_DIVERGING';
          }
        }

        events.push({
          timestamp: candle.timestamp,
          price: candle.close,
          levelType: level.type,
          levelSide: level.side,
          levelPrice: level.price,
          touchDirection: touchedFromAbove ? 'from_above' : 'from_below',
          gexRegime: gexData.regime,

          // Price direction
          priceDirection: priceDirection?.direction,
          priceChange: priceDirection?.change,

          // LDPM characteristics
          ldpmSentiment: ldpm.sentiment,
          ldpmOrdering: ldpm.ordering,
          ldpmSpread: ldpm.spread,
          ldpmTightlyStacked: ldpm.tightlyStacked,
          ldpmCenterOfMass: ldpm.centerOfMass,
          ldpmLevels: ldpm.levels,

          // LDPM direction and slope
          ldpmOverallDirection: ldpmDirection?.overallDirection,
          ldpmComChange: ldpmDirection?.comChange,
          ldpmComSlope: ldpmDirection?.comSlope,
          ldpmSpreadDirection: ldpmDirection?.spreadDirection,
          ldpmAvgSlope: ldpmDirection?.avgSlope,
          ldpmSlopeStrength: ldpmDirection?.slopeStrength,
          ldpmLevelConsensus: ldpmDirection?.levelConsensus,
          ldpmRisingLevels: ldpmDirection?.risingLevels,
          ldpmFallingLevels: ldpmDirection?.fallingLevels,
          ldpmLevelDirections: ldpmDirection?.levelDirections,

          // Price vs LDPM relationship
          priceLdpmRelationship,
          approachContext,
          ldpmLeadLag,

          // LDPM-GEX relationship
          ...ldpmGexRelationship,

          // LDPM crossover data
          hasCrossover: crossoverData?.hasCrossover,
          hasMultipleCrossovers: crossoverData?.hasMultipleCrossovers,
          crossoverCount: crossoverData?.totalCrossoversInLookback,
          orderingChanged: crossoverData?.orderingChanged,
          spreadTrend: crossoverData?.spreadTrend,
          l1PositionChanged: crossoverData?.l1PositionChanged,
          isHighCrossoverActivity: crossoverData?.isHighActivity,

          // Outcome
          ...outcome
        });
      }
    }

    this.events = events;
    console.log(`   Found ${events.length.toLocaleString()} level touch events with LDPM context`);
    return events;
  }

  /**
   * Analyze relationship between LDPM levels and GEX level
   */
  analyzeLdpmGexRelationship(ldpm, gexLevelPrice, currentPrice, levelSide) {
    const levels = ldpm.levels;

    // How many LDPM levels are below/above the GEX level?
    const levelsBelow = levels.filter(l => l < gexLevelPrice).length;
    const levelsAbove = levels.filter(l => l > gexLevelPrice).length;

    // Distance from nearest LDPM level to GEX level
    const distances = levels.map(l => Math.abs(l - gexLevelPrice));
    const nearestDistance = Math.min(...distances);
    const nearestLdpmIndex = distances.indexOf(nearestDistance);

    // Is LDPM center of mass above or below GEX level?
    const comRelativeToGex = ldpm.centerOfMass > gexLevelPrice ? 'above' : 'below';

    // Are LDPM levels stacked near the GEX level? (confluence)
    const levelsNearGex = levels.filter(l => Math.abs(l - gexLevelPrice) < ldpm.spread * 0.3).length;
    const hasConfluence = levelsNearGex >= 2;

    // Is price between LDPM center of mass and GEX level?
    const priceBetween = (currentPrice > Math.min(ldpm.centerOfMass, gexLevelPrice) &&
                         currentPrice < Math.max(ldpm.centerOfMass, gexLevelPrice));

    // LDPM "support" - are levels clustered below price (bullish) or above (bearish)?
    const ldpmBias = ldpm.centerOfMass < currentPrice ? 'supportive' : 'resistant';

    // Alignment check: For support levels, bullish LDPM (levels below) is aligned
    // For resistance levels, bearish LDPM (levels above) is aligned
    let aligned = false;
    if (levelSide === 'support') {
      aligned = ldpmBias === 'supportive';
    } else if (levelSide === 'resistance') {
      aligned = ldpmBias === 'resistant';
    }

    return {
      ldpmLevelsBelow: levelsBelow,
      ldpmLevelsAbove: levelsAbove,
      nearestLdpmDistance: nearestDistance,
      nearestLdpmLevel: nearestLdpmIndex + 1,
      comRelativeToGex,
      ldpmGexConfluence: hasConfluence,
      ldpmLevelsNearGex: levelsNearGex,
      ldpmBias,
      ldpmGexAligned: aligned,
      priceBetweenLdpmAndGex: priceBetween
    };
  }

  /**
   * Measure outcome after touching a GEX level
   */
  measureOutcome(startIndex, levelPrice, levelSide) {
    const startCandle = this.ohlcvData[startIndex];
    const entryPrice = startCandle.close;

    let maxFavorable = 0;
    let maxAdverse = 0;
    let finalPrice = entryPrice;
    let outcome = 'chop';

    // For support, favorable = up, adverse = down
    // For resistance, favorable = down, adverse = up
    const favorableMultiplier = levelSide === 'resistance' ? -1 : 1;

    for (let i = 1; i <= this.lookAheadCandles && startIndex + i < this.ohlcvData.length; i++) {
      const candle = this.ohlcvData[startIndex + i];

      const highMove = (candle.high - entryPrice) * favorableMultiplier;
      const lowMove = (candle.low - entryPrice) * favorableMultiplier;

      maxFavorable = Math.max(maxFavorable, highMove, lowMove);
      maxAdverse = Math.min(maxAdverse, highMove, lowMove);

      finalPrice = candle.close;
    }

    maxAdverse = Math.abs(maxAdverse);

    // Classify outcome
    if (maxFavorable >= 20 && maxFavorable > maxAdverse * 1.5) {
      outcome = 'bounce';
    } else if (maxAdverse >= 20 && maxAdverse > maxFavorable * 1.5) {
      outcome = 'break';
    }

    return {
      outcome,
      maxFavorable: Math.round(maxFavorable * 100) / 100,
      maxAdverse: Math.round(maxAdverse * 100) / 100,
      netMove: Math.round((finalPrice - entryPrice) * favorableMultiplier * 100) / 100
    };
  }

  /**
   * Calculate statistics grouped by various LDPM characteristics
   */
  calculateStatistics() {
    const stats = {
      overall: this.calculateGroupStats(this.events),
      byOrdering: {},
      byDirection: {},
      bySpreadDirection: {},
      byStacking: {},
      byConfluence: {},
      byAlignment: {},
      byComPosition: {},
      byLevelsNearGex: {},
      // Price vs LDPM direction
      byPriceLdpmRelationship: {},
      byApproachContext: {},
      byLdpmLeadLag: {},
      // LDPM slope analysis
      bySlopeStrength: {},
      byLevelConsensus: {},
      byNearestLevelSlope: {},
      // LDPM crossover analysis
      byCrossover: {},
      bySpreadTrend: {},
      byL1PositionChange: {},
      byCrossoverCount: {},
      // Combined factors
      byOrderingAndDirection: {},
      byAlignmentAndDirection: {}
    };

    // Group by LDPM ordering pattern
    const orderingGroups = this.groupBy(this.events, 'ldpmOrdering');
    for (const [key, events] of Object.entries(orderingGroups)) {
      stats.byOrdering[key] = this.calculateGroupStats(events);
    }

    // Group by LDPM direction
    const directionGroups = this.groupBy(this.events, 'ldpmOverallDirection');
    for (const [key, events] of Object.entries(directionGroups)) {
      if (key) stats.byDirection[key] = this.calculateGroupStats(events);
    }

    // Group by spread direction
    const spreadDirGroups = this.groupBy(this.events, 'ldpmSpreadDirection');
    for (const [key, events] of Object.entries(spreadDirGroups)) {
      if (key) stats.bySpreadDirection[key] = this.calculateGroupStats(events);
    }

    // Group by tight stacking
    const stackingGroups = this.groupBy(this.events, 'ldpmTightlyStacked');
    for (const [key, events] of Object.entries(stackingGroups)) {
      stats.byStacking[key === 'true' ? 'TIGHT' : 'SPREAD'] = this.calculateGroupStats(events);
    }

    // Group by LDPM-GEX confluence
    const confluenceGroups = this.groupBy(this.events, 'ldpmGexConfluence');
    for (const [key, events] of Object.entries(confluenceGroups)) {
      stats.byConfluence[key === 'true' ? 'CONFLUENCE' : 'NO_CONFLUENCE'] = this.calculateGroupStats(events);
    }

    // Group by LDPM-GEX alignment
    const alignmentGroups = this.groupBy(this.events, 'ldpmGexAligned');
    for (const [key, events] of Object.entries(alignmentGroups)) {
      stats.byAlignment[key === 'true' ? 'ALIGNED' : 'OPPOSED'] = this.calculateGroupStats(events);
    }

    // Group by center of mass relative to GEX
    const comGroups = this.groupBy(this.events, 'comRelativeToGex');
    for (const [key, events] of Object.entries(comGroups)) {
      if (key) stats.byComPosition[key.toUpperCase()] = this.calculateGroupStats(events);
    }

    // Group by number of LDPM levels near GEX
    for (let n = 0; n <= 5; n++) {
      const filtered = this.events.filter(e => e.ldpmLevelsNearGex === n);
      if (filtered.length >= 50) {
        stats.byLevelsNearGex[`${n}_LEVELS`] = this.calculateGroupStats(filtered);
      }
    }

    // Combined: Ordering + Direction
    for (const ordering of ['ASCENDING', 'DESCENDING', 'V_PATTERN', 'MIXED']) {
      for (const direction of ['RISING', 'FALLING', 'FLAT']) {
        const filtered = this.events.filter(e =>
          e.ldpmOrdering === ordering && e.ldpmOverallDirection === direction
        );
        if (filtered.length >= 30) {
          stats.byOrderingAndDirection[`${ordering}_${direction}`] = this.calculateGroupStats(filtered);
        }
      }
    }

    // Combined: Alignment + Direction
    for (const aligned of [true, false]) {
      for (const direction of ['RISING', 'FALLING', 'FLAT']) {
        const filtered = this.events.filter(e =>
          e.ldpmGexAligned === aligned && e.ldpmOverallDirection === direction
        );
        if (filtered.length >= 30) {
          const key = `${aligned ? 'ALIGNED' : 'OPPOSED'}_${direction}`;
          stats.byAlignmentAndDirection[key] = this.calculateGroupStats(filtered);
        }
      }
    }

    // NEW: Group by price vs LDPM direction relationship
    const priceLdpmGroups = this.groupBy(this.events, 'priceLdpmRelationship');
    for (const [key, events] of Object.entries(priceLdpmGroups)) {
      if (key && key !== 'unknown') {
        stats.byPriceLdpmRelationship[key] = this.calculateGroupStats(events);
      }
    }

    // NEW: Group by approach context (KEY ANALYSIS)
    const approachGroups = this.groupBy(this.events, 'approachContext');
    for (const [key, events] of Object.entries(approachGroups)) {
      if (key && key !== 'null') {
        stats.byApproachContext[key] = this.calculateGroupStats(events);
      }
    }

    // NEW: Group by LDPM lead/lag
    const leadLagGroups = this.groupBy(this.events, 'ldpmLeadLag');
    for (const [key, events] of Object.entries(leadLagGroups)) {
      if (key && key !== 'null') {
        stats.byLdpmLeadLag[key] = this.calculateGroupStats(events);
      }
    }

    // NEW: Group by LDPM slope strength
    const slopeGroups = this.groupBy(this.events, 'ldpmSlopeStrength');
    for (const [key, events] of Object.entries(slopeGroups)) {
      if (key && key !== 'null' && key !== 'undefined') {
        stats.bySlopeStrength[key] = this.calculateGroupStats(events);
      }
    }

    // NEW: Group by level consensus
    const consensusGroups = this.groupBy(this.events, 'ldpmLevelConsensus');
    for (const [key, events] of Object.entries(consensusGroups)) {
      if (key && key !== 'null' && key !== 'undefined') {
        stats.byLevelConsensus[key] = this.calculateGroupStats(events);
      }
    }

    // NEW: Group by nearest LDPM level's slope (relative to the GEX level touched)
    // This tells us: when price touches GEX support, is the nearest LDPM level rising or falling?
    for (const event of this.events) {
      if (!event.ldpmLevelDirections || !event.nearestLdpmLevel) continue;

      const nearestLevelIdx = event.nearestLdpmLevel - 1;
      const nearestDir = event.ldpmLevelDirections[nearestLevelIdx];
      if (!nearestDir) continue;

      // Create a key combining level side and nearest level's direction
      const key = `${event.levelSide.toUpperCase()}_NEAREST_LDPM_${nearestDir.direction}`;
      if (!stats.byNearestLevelSlope[key]) {
        stats.byNearestLevelSlope[key] = [];
      }
      stats.byNearestLevelSlope[key].push(event);
    }

    // Convert arrays to stats
    for (const [key, events] of Object.entries(stats.byNearestLevelSlope)) {
      if (events.length >= 30) {
        stats.byNearestLevelSlope[key] = this.calculateGroupStats(events);
      } else {
        delete stats.byNearestLevelSlope[key];
      }
    }

    // NEW: Group by crossover presence
    const crossoverGroups = this.groupBy(this.events, 'hasCrossover');
    stats.byCrossover['HAS_CROSSOVER'] = this.calculateGroupStats(
      this.events.filter(e => e.hasCrossover === true)
    );
    stats.byCrossover['NO_CROSSOVER'] = this.calculateGroupStats(
      this.events.filter(e => e.hasCrossover === false)
    );
    stats.byCrossover['MULTIPLE_CROSSOVERS'] = this.calculateGroupStats(
      this.events.filter(e => e.hasMultipleCrossovers === true)
    );
    stats.byCrossover['HIGH_ACTIVITY'] = this.calculateGroupStats(
      this.events.filter(e => e.isHighCrossoverActivity === true)
    );

    // NEW: Group by spread trend
    const spreadTrendGroups = this.groupBy(this.events, 'spreadTrend');
    for (const [key, events] of Object.entries(spreadTrendGroups)) {
      if (key && key !== 'null' && key !== 'undefined') {
        stats.bySpreadTrend[key] = this.calculateGroupStats(events);
      }
    }

    // NEW: Group by L1 position change
    stats.byL1PositionChange['L1_CHANGED'] = this.calculateGroupStats(
      this.events.filter(e => e.l1PositionChanged === true)
    );
    stats.byL1PositionChange['L1_STABLE'] = this.calculateGroupStats(
      this.events.filter(e => e.l1PositionChanged === false)
    );

    // NEW: Group by crossover count
    for (let n = 0; n <= 4; n++) {
      const filtered = this.events.filter(e => e.crossoverCount === n);
      if (filtered.length >= 50) {
        stats.byCrossoverCount[`${n}_CROSSOVERS`] = this.calculateGroupStats(filtered);
      }
    }

    return stats;
  }

  /**
   * Group events by a property
   */
  groupBy(events, property) {
    const groups = {};
    for (const event of events) {
      const key = String(event[property]);
      if (!groups[key]) groups[key] = [];
      groups[key].push(event);
    }
    return groups;
  }

  /**
   * Calculate statistics for a group of events
   */
  calculateGroupStats(events) {
    if (events.length === 0) return null;

    const bounces = events.filter(e => e.outcome === 'bounce');
    const breaks = events.filter(e => e.outcome === 'break');
    const chops = events.filter(e => e.outcome === 'chop');

    const avgFavorable = events.reduce((s, e) => s + e.maxFavorable, 0) / events.length;
    const avgAdverse = events.reduce((s, e) => s + e.maxAdverse, 0) / events.length;
    const avgNet = events.reduce((s, e) => s + e.netMove, 0) / events.length;

    return {
      count: events.length,
      bounceCount: bounces.length,
      breakCount: breaks.length,
      chopCount: chops.length,
      bounceRate: (bounces.length / events.length * 100).toFixed(1),
      breakRate: (breaks.length / events.length * 100).toFixed(1),
      chopRate: (chops.length / events.length * 100).toFixed(1),
      avgFavorable: Math.round(avgFavorable * 100) / 100,
      avgAdverse: Math.round(avgAdverse * 100) / 100,
      avgNet: Math.round(avgNet * 100) / 100
    };
  }

  /**
   * Print analysis results
   */
  printResults(stats) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  LDPM-GEX CORRELATION ANALYSIS RESULTS');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Overall
    this.printGroupStats('OVERALL', stats.overall);

    // By Ordering
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  BY LDPM LEVEL ORDERING PATTERN');
    console.log('───────────────────────────────────────────────────────────\n');
    for (const [key, s] of Object.entries(stats.byOrdering)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // By Direction
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  BY LDPM DIRECTION (Rising/Falling over 1hr)');
    console.log('───────────────────────────────────────────────────────────\n');
    for (const [key, s] of Object.entries(stats.byDirection)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // By Spread Direction
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  BY LDPM SPREAD DIRECTION (Expanding/Contracting)');
    console.log('───────────────────────────────────────────────────────────\n');
    for (const [key, s] of Object.entries(stats.bySpreadDirection)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // By Stacking
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  BY LDPM LEVEL STACKING');
    console.log('───────────────────────────────────────────────────────────\n');
    for (const [key, s] of Object.entries(stats.byStacking)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // By Confluence
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  BY LDPM-GEX CONFLUENCE (LDPM levels near GEX level)');
    console.log('───────────────────────────────────────────────────────────\n');
    for (const [key, s] of Object.entries(stats.byConfluence)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // By Alignment
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  BY LDPM-GEX ALIGNMENT');
    console.log('  (ALIGNED = LDPM supports the expected bounce direction)');
    console.log('───────────────────────────────────────────────────────────\n');
    for (const [key, s] of Object.entries(stats.byAlignment)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // By Levels Near GEX
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  BY NUMBER OF LDPM LEVELS NEAR GEX LEVEL');
    console.log('───────────────────────────────────────────────────────────\n');
    for (const [key, s] of Object.entries(stats.byLevelsNearGex)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // Combined: Ordering + Direction
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  COMBINED: ORDERING + DIRECTION');
    console.log('───────────────────────────────────────────────────────────\n');
    const sortedCombined = Object.entries(stats.byOrderingAndDirection)
      .filter(([k, s]) => s && s.count >= 30)
      .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));
    for (const [key, s] of sortedCombined) {
      this.printGroupStats(key, s);
    }

    // Combined: Alignment + Direction
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  COMBINED: ALIGNMENT + DIRECTION');
    console.log('───────────────────────────────────────────────────────────\n');
    const sortedAlignDir = Object.entries(stats.byAlignmentAndDirection)
      .filter(([k, s]) => s && s.count >= 30)
      .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));
    for (const [key, s] of sortedAlignDir) {
      this.printGroupStats(key, s);
    }

    // KEY ANALYSIS: Price vs LDPM Direction
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  KEY ANALYSIS: PRICE vs LDPM DIRECTION');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Price/LDPM relationship
    console.log('  PRICE & LDPM MOVING SAME vs OPPOSITE DIRECTION:\n');
    for (const [key, s] of Object.entries(stats.byPriceLdpmRelationship)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // LDPM Lead/Lag
    console.log('\n  LDPM LEADING vs LAGGING vs DIVERGING FROM PRICE:\n');
    for (const [key, s] of Object.entries(stats.byLdpmLeadLag)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // Approach Context (THE KEY QUESTION)
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  APPROACH CONTEXT: Price approaching GEX + LDPM direction');
    console.log('  (e.g., Price RISING to Resistance while LDPM also RISING)');
    console.log('───────────────────────────────────────────────────────────\n');

    const sortedApproach = Object.entries(stats.byApproachContext)
      .filter(([k, s]) => s && s.count >= 30)
      .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));
    for (const [key, s] of sortedApproach) {
      this.printGroupStats(key, s);
    }

    // LDPM Slope Analysis
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  LDPM SLOPE ANALYSIS (Rate of Change)');
    console.log('  Rising = deteriorating liquidity, Falling = improving');
    console.log('═══════════════════════════════════════════════════════════\n');

    // By slope strength
    console.log('  BY AVERAGE SLOPE STRENGTH:\n');
    const sortedSlope = Object.entries(stats.bySlopeStrength)
      .filter(([k, s]) => s && s.count >= 50)
      .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));
    for (const [key, s] of sortedSlope) {
      this.printGroupStats(key, s);
    }

    // By level consensus
    console.log('\n  BY LEVEL CONSENSUS (how many levels moving same direction):\n');
    const sortedConsensus = Object.entries(stats.byLevelConsensus)
      .filter(([k, s]) => s && s.count >= 50)
      .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));
    for (const [key, s] of sortedConsensus) {
      this.printGroupStats(key, s);
    }

    // By nearest level slope
    console.log('\n───────────────────────────────────────────────────────────');
    console.log('  NEAREST LDPM LEVEL SLOPE when touching GEX level');
    console.log('  (Is the closest LDPM level rising or falling?)');
    console.log('───────────────────────────────────────────────────────────\n');
    const sortedNearest = Object.entries(stats.byNearestLevelSlope)
      .filter(([k, s]) => s && s.count >= 30)
      .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));
    for (const [key, s] of sortedNearest) {
      this.printGroupStats(key, s);
    }

    // LDPM Crossover Analysis
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  LDPM CROSSOVER ANALYSIS');
    console.log('  (When LDPM levels cross each other = shifting liquidity)');
    console.log('═══════════════════════════════════════════════════════════\n');

    // By crossover presence
    console.log('  BY CROSSOVER PRESENCE:\n');
    for (const [key, s] of Object.entries(stats.byCrossover)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // By spread trend
    console.log('\n  BY SPREAD TREND (Levels converging/diverging):\n');
    for (const [key, s] of Object.entries(stats.bySpreadTrend)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // By L1 position change
    console.log('\n  BY L1 POSITION CHANGE (Did L1 shift relative to others?):\n');
    for (const [key, s] of Object.entries(stats.byL1PositionChange)) {
      if (s && s.count >= 50) this.printGroupStats(key, s);
    }

    // By crossover count
    console.log('\n  BY NUMBER OF CROSSOVERS IN LOOKBACK PERIOD:\n');
    const sortedCrossCount = Object.entries(stats.byCrossoverCount)
      .filter(([k, s]) => s && s.count >= 50)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
    for (const [key, s] of sortedCrossCount) {
      this.printGroupStats(key, s);
    }

    // Actionable insights
    this.printInsights(stats);
  }

  /**
   * Print stats for a single group
   */
  printGroupStats(label, stats) {
    if (!stats) return;
    console.log(`  ${label} (n=${stats.count}):`);
    console.log(`    Bounce: ${stats.bounceRate}% (${stats.bounceCount}) | Break: ${stats.breakRate}% (${stats.breakCount}) | Chop: ${stats.chopRate}% (${stats.chopCount})`);
    console.log(`    Avg Favorable: ${stats.avgFavorable} pts | Avg Adverse: ${stats.avgAdverse} pts | Net: ${stats.avgNet} pts\n`);
  }

  /**
   * Print actionable insights
   */
  printInsights(stats) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ACTIONABLE INSIGHTS');
    console.log('═══════════════════════════════════════════════════════════\n');

    const insights = [];

    // Compare ordering patterns
    if (stats.byOrdering) {
      const orderings = Object.entries(stats.byOrdering)
        .filter(([k, s]) => s && s.count >= 100)
        .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));

      if (orderings.length >= 2) {
        const best = orderings[0];
        const worst = orderings[orderings.length - 1];
        const diff = parseFloat(best[1].bounceRate) - parseFloat(worst[1].bounceRate);
        if (diff > 3) {
          insights.push({
            factor: 'LDPM Ordering',
            best: best[0],
            bestRate: best[1].bounceRate,
            worst: worst[0],
            worstRate: worst[1].bounceRate,
            diff: diff.toFixed(1),
            sample: best[1].count
          });
        }
      }
    }

    // Compare directions
    if (stats.byDirection) {
      const directions = Object.entries(stats.byDirection)
        .filter(([k, s]) => s && s.count >= 100)
        .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));

      if (directions.length >= 2) {
        const best = directions[0];
        const worst = directions[directions.length - 1];
        const diff = parseFloat(best[1].bounceRate) - parseFloat(worst[1].bounceRate);
        if (diff > 3) {
          insights.push({
            factor: 'LDPM Direction',
            best: best[0],
            bestRate: best[1].bounceRate,
            worst: worst[0],
            worstRate: worst[1].bounceRate,
            diff: diff.toFixed(1),
            sample: best[1].count
          });
        }
      }
    }

    // Compare alignment
    if (stats.byAlignment?.ALIGNED && stats.byAlignment?.OPPOSED) {
      const aligned = stats.byAlignment.ALIGNED;
      const opposed = stats.byAlignment.OPPOSED;
      const diff = parseFloat(aligned.bounceRate) - parseFloat(opposed.bounceRate);
      if (Math.abs(diff) > 2) {
        insights.push({
          factor: 'LDPM-GEX Alignment',
          best: diff > 0 ? 'ALIGNED' : 'OPPOSED',
          bestRate: diff > 0 ? aligned.bounceRate : opposed.bounceRate,
          worst: diff > 0 ? 'OPPOSED' : 'ALIGNED',
          worstRate: diff > 0 ? opposed.bounceRate : aligned.bounceRate,
          diff: Math.abs(diff).toFixed(1),
          sample: aligned.count
        });
      }
    }

    // Compare confluence
    if (stats.byConfluence?.CONFLUENCE && stats.byConfluence?.NO_CONFLUENCE) {
      const conf = stats.byConfluence.CONFLUENCE;
      const noConf = stats.byConfluence.NO_CONFLUENCE;
      const diff = parseFloat(conf.bounceRate) - parseFloat(noConf.bounceRate);
      if (Math.abs(diff) > 2) {
        insights.push({
          factor: 'LDPM-GEX Confluence',
          best: diff > 0 ? 'CONFLUENCE' : 'NO_CONFLUENCE',
          bestRate: diff > 0 ? conf.bounceRate : noConf.bounceRate,
          worst: diff > 0 ? 'NO_CONFLUENCE' : 'CONFLUENCE',
          worstRate: diff > 0 ? noConf.bounceRate : conf.bounceRate,
          diff: Math.abs(diff).toFixed(1),
          sample: conf.count
        });
      }
    }

    // Compare spread direction
    if (stats.bySpreadDirection) {
      const spreads = Object.entries(stats.bySpreadDirection)
        .filter(([k, s]) => s && s.count >= 100)
        .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));

      if (spreads.length >= 2) {
        const best = spreads[0];
        const worst = spreads[spreads.length - 1];
        const diff = parseFloat(best[1].bounceRate) - parseFloat(worst[1].bounceRate);
        if (diff > 3) {
          insights.push({
            factor: 'LDPM Spread Direction',
            best: best[0],
            bestRate: best[1].bounceRate,
            worst: worst[0],
            worstRate: worst[1].bounceRate,
            diff: diff.toFixed(1),
            sample: best[1].count
          });
        }
      }
    }

    // Compare slope strength
    if (stats.bySlopeStrength) {
      const slopes = Object.entries(stats.bySlopeStrength)
        .filter(([k, s]) => s && s.count >= 100)
        .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));

      if (slopes.length >= 2) {
        const best = slopes[0];
        const worst = slopes[slopes.length - 1];
        const diff = parseFloat(best[1].bounceRate) - parseFloat(worst[1].bounceRate);
        if (diff > 3) {
          insights.push({
            factor: 'LDPM Slope Strength',
            best: best[0],
            bestRate: best[1].bounceRate,
            worst: worst[0],
            worstRate: worst[1].bounceRate,
            diff: diff.toFixed(1),
            sample: best[1].count
          });
        }
      }
    }

    // Compare approach contexts (THE KEY ANALYSIS)
    if (stats.byApproachContext) {
      const approaches = Object.entries(stats.byApproachContext)
        .filter(([k, s]) => s && s.count >= 50)
        .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));

      if (approaches.length >= 2) {
        const best = approaches[0];
        const worst = approaches[approaches.length - 1];
        const diff = parseFloat(best[1].bounceRate) - parseFloat(worst[1].bounceRate);
        if (diff > 3) {
          insights.push({
            factor: 'Approach Context (Price + LDPM direction)',
            best: best[0],
            bestRate: best[1].bounceRate,
            worst: worst[0],
            worstRate: worst[1].bounceRate,
            diff: diff.toFixed(1),
            sample: best[1].count
          });
        }
      }
    }

    // Print insights sorted by impact
    insights.sort((a, b) => parseFloat(b.diff) - parseFloat(a.diff));

    for (const insight of insights) {
      console.log(`📊 ${insight.factor}:`);
      console.log(`   Best: ${insight.best} (${insight.bestRate}% bounce)`);
      console.log(`   Worst: ${insight.worst} (${insight.worstRate}% bounce)`);
      console.log(`   Difference: +${insight.diff}% bounce rate improvement`);
      console.log(`   Sample: n=${insight.sample}\n`);
    }

    // Best combined conditions
    if (stats.byOrderingAndDirection) {
      const combined = Object.entries(stats.byOrderingAndDirection)
        .filter(([k, s]) => s && s.count >= 50)
        .sort((a, b) => parseFloat(b[1].bounceRate) - parseFloat(a[1].bounceRate));

      if (combined.length > 0) {
        console.log('🎯 BEST COMBINED CONDITIONS:\n');
        for (let i = 0; i < Math.min(3, combined.length); i++) {
          const [key, s] = combined[i];
          console.log(`   ${i + 1}. ${key}: ${s.bounceRate}% bounce (n=${s.count}, net=${s.avgNet} pts)`);
        }
        console.log('\n🚫 WORST COMBINED CONDITIONS:\n');
        for (let i = 0; i < Math.min(3, combined.length); i++) {
          const [key, s] = combined[combined.length - 1 - i];
          console.log(`   ${i + 1}. ${key}: ${s.bounceRate}% bounce (n=${s.count}, net=${s.avgNet} pts)`);
        }
      }
    }

    // KEY FINDINGS: Approach context summary
    if (stats.byApproachContext && Object.keys(stats.byApproachContext).length > 0) {
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('  KEY FINDING: PRICE vs LDPM DIRECTION AT GEX LEVELS');
      console.log('═══════════════════════════════════════════════════════════\n');

      // Support analysis
      const supportUp = stats.byApproachContext['SUPPORT_PRICE_DOWN_LDPM_UP'];
      const supportDown = stats.byApproachContext['SUPPORT_PRICE_DOWN_LDPM_DOWN'];
      if (supportUp && supportDown) {
        console.log('  AT SUPPORT (price falling):');
        console.log(`    LDPM RISING (diverging):  ${supportUp.bounceRate}% bounce (n=${supportUp.count})`);
        console.log(`    LDPM FALLING (chasing):   ${supportDown.bounceRate}% bounce (n=${supportDown.count})`);
        const diff = parseFloat(supportUp.bounceRate) - parseFloat(supportDown.bounceRate);
        if (Math.abs(diff) > 2) {
          console.log(`    → ${diff > 0 ? 'LDPM RISING' : 'LDPM FALLING'} is better by ${Math.abs(diff).toFixed(1)}%`);
        }
        console.log('');
      }

      // Resistance analysis
      const resistUp = stats.byApproachContext['RESISTANCE_PRICE_UP_LDPM_UP'];
      const resistDown = stats.byApproachContext['RESISTANCE_PRICE_UP_LDPM_DOWN'];
      if (resistUp && resistDown) {
        console.log('  AT RESISTANCE (price rising):');
        console.log(`    LDPM RISING (same dir):   ${resistUp.bounceRate}% bounce (n=${resistUp.count})`);
        console.log(`    LDPM FALLING (diverging): ${resistDown.bounceRate}% bounce (n=${resistDown.count})`);
        const diff = parseFloat(resistUp.bounceRate) - parseFloat(resistDown.bounceRate);
        if (Math.abs(diff) > 2) {
          console.log(`    → ${diff > 0 ? 'LDPM RISING' : 'LDPM FALLING'} is better by ${Math.abs(diff).toFixed(1)}%`);
        }
        console.log('');
      }

      // Interpretation
      console.log('  INTERPRETATION:');
      console.log('    - LDPM rising = deteriorating liquidity (levels moving up/away from support)');
      console.log('    - LDPM falling = improving liquidity (levels moving down toward support)');
      console.log('    - For longs at support: better when LDPM is stable or supportive');
      console.log('    - For shorts at resistance: better when LDPM confirms the rejection\n');
    }
  }

  /**
   * Run complete analysis
   */
  async runAnalysis(startDate, endDate) {
    await this.loadData(startDate, endDate);
    this.detectGexApproaches(startDate, endDate);
    const stats = this.calculateStatistics();
    this.printResults(stats);

    return {
      events: this.events,
      stats
    };
  }
}

/**
 * CLI runner
 */
export async function runLdpmAnalysis(args) {
  const analyzer = new LdpmGexAnalyzer({
    dataDir: args.dataDir,
    touchThreshold: args.config?.touchThreshold || 5,
    lookAheadCandles: args.config?.lookAheadCandles || 60,
    lookBackPeriods: args.config?.lookBackPeriods || 4
  });

  const startDate = new Date(args.startDate);
  const endDate = new Date(args.endDate);

  return await analyzer.runAnalysis(startDate, endDate);
}
