/**
 * Confluence Analyzer Engine
 *
 * Analyzes multiple level sources to identify high-probability confluence zones
 * for precision entries with optimal risk/reward ratios.
 *
 * Key Features:
 * - Multi-source level integration (fibonacci, GEX, session, structural)
 * - Proximity-based clustering
 * - Weighted scoring based on level type and historical accuracy
 * - Risk/reward ratio optimization
 */

export class ConfluenceAnalyzer {
  constructor(options = {}) {
    this.options = {
      // Confluence zone parameters
      proximityThreshold: options.proximityThreshold || 50,    // Points to group levels
      minLevelsForConfluence: options.minLevelsForConfluence || 2, // Min levels in zone
      maxZoneWidth: options.maxZoneWidth || 100,              // Max width of confluence zone

      // Level source weights (based on proven effectiveness)
      levelWeights: options.levelWeights || {
        gex: 1.5,         // Highest weight - proven market reality
        fibonacci: 1.0,   // Base weight
        session: 1.2,     // High weight for key levels
        structural: 0.8   // Lower weight for higher timeframe levels
      },

      // Fibonacci ratio specific weights
      fibonacciRatioWeights: options.fibonacciRatioWeights || {
        0.705: 1.3,  // Primary golden ratio - highest
        0.5: 1.1,    // Strong half retracement
        0.618: 1.0,  // Standard golden ratio
        0.786: 0.9,  // Deep retracement
        0.382: 0.8,  // Shallow retracement
        0.236: 0.7   // Very shallow
      },

      // Confluence scoring thresholds
      minConfluenceScore: options.minConfluenceScore || 5.0,
      excellentConfluenceScore: options.excellentConfluenceScore || 8.0,

      ...options
    };

    // Storage for confluence zones
    this.confluenceZones = [];
    this.lastUpdate = null;
  }

  /**
   * Analyze all levels from multiple sources and identify confluence zones
   */
  analyzeLevels(levelSources, currentPrice, tradeDirection) {
    const allLevels = this.combineAllLevels(levelSources, currentPrice, tradeDirection);
    const clusteredLevels = this.clusterLevelsByProximity(allLevels);
    const confluenceZones = this.scoreConfluenceZones(clusteredLevels);

    // Sort by confluence score (highest first)
    this.confluenceZones = confluenceZones.sort((a, b) => b.score - a.score);
    this.lastUpdate = Date.now();

    return this.confluenceZones;
  }

  /**
   * Combine levels from all sources into unified format
   */
  combineAllLevels(levelSources, currentPrice, tradeDirection) {
    const allLevels = [];

    // Add fibonacci levels
    if (levelSources.fibonacci) {
      levelSources.fibonacci.forEach(level => {
        allLevels.push({
          price: level.price,
          source: 'fibonacci',
          sourceWeight: this.options.levelWeights.fibonacci,
          ratioWeight: this.options.fibonacciRatioWeights[level.ratio] || 1.0,
          type: level.type,
          strength: level.strength || 50,
          description: level.description,
          metadata: {
            ratio: level.ratio,
            ratioPercent: level.ratioPercent,
            swingHigh: level.swingHigh,
            swingLow: level.swingLow,
            swingSize: level.swingSize
          }
        });
      });
    }

    // Add GEX levels
    if (levelSources.gex) {
      levelSources.gex.forEach(level => {
        allLevels.push({
          price: level.price,
          source: 'gex',
          sourceWeight: this.options.levelWeights.gex,
          ratioWeight: 1.0,
          type: level.type,
          strength: level.strength || 75, // GEX levels default high strength
          description: level.description,
          metadata: {
            gexType: level.gexType, // put_wall, call_wall, gamma_flip
            gexStrength: level.gexStrength
          }
        });
      });
    }

    // Add session levels
    if (levelSources.session) {
      levelSources.session.forEach(level => {
        allLevels.push({
          price: level.price,
          source: 'session',
          sourceWeight: this.options.levelWeights.session,
          ratioWeight: 1.0,
          type: level.type,
          strength: level.strength || 60,
          description: level.description,
          metadata: {
            session: level.session,
            levelType: level.levelType
          }
        });
      });
    }

    // Add structural levels
    if (levelSources.structural) {
      levelSources.structural.forEach(level => {
        allLevels.push({
          price: level.price,
          source: 'structural',
          sourceWeight: this.options.levelWeights.structural,
          ratioWeight: 1.0,
          type: level.type,
          strength: level.strength || 55,
          description: level.description,
          metadata: {
            timeframe: level.timeframe,
            touches: level.touches
          }
        });
      });
    }

    // Filter levels based on trade direction
    return this.filterLevelsByDirection(allLevels, currentPrice, tradeDirection);
  }

  /**
   * Filter levels based on trade direction
   */
  filterLevelsByDirection(levels, currentPrice, tradeDirection) {
    return levels.filter(level => {
      if (tradeDirection === 'buy') {
        // For buy signals, only consider support levels below current price
        return level.type === 'support' || level.price < currentPrice;
      } else if (tradeDirection === 'sell') {
        // For sell signals, only consider resistance levels above current price
        return level.type === 'resistance' || level.price > currentPrice;
      }
      return true;
    });
  }

  /**
   * Group levels into confluence zones using dynamic clustering
   */
  clusterLevelsByProximity(levels) {
    if (levels.length < 2) return [];

    // Sort levels by price
    const sortedLevels = [...levels].sort((a, b) => a.price - b.price);

    // Use adaptive clustering based on level density
    const clusters = this.adaptiveDensityClustering(sortedLevels);

    // Filter clusters by minimum size
    return clusters.filter(cluster => cluster.length >= this.options.minLevelsForConfluence);
  }

  /**
   * Adaptive density-based clustering algorithm
   * Finds natural groupings without fixed threshold
   */
  adaptiveDensityClustering(sortedLevels) {
    // Use density-based scanning to find clusters
    const clusters = [];
    const used = new Set();

    for (let i = 0; i < sortedLevels.length; i++) {
      if (used.has(i)) continue;

      const cluster = this.growCluster(sortedLevels, i, used);
      if (cluster.length >= this.options.minLevelsForConfluence) {
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * Grow a cluster from a seed point using density-based approach
   */
  growCluster(sortedLevels, seedIndex, used) {
    const cluster = [];
    const toProcess = [seedIndex];
    const maxClusterWidth = 75; // Maximum width for a single confluence zone

    while (toProcess.length > 0) {
      const idx = toProcess.shift();
      if (used.has(idx)) continue;

      used.add(idx);
      cluster.push(sortedLevels[idx]);

      // Find neighbors within adaptive radius
      const radius = this.calculateAdaptiveRadius(sortedLevels, idx);

      // Look for nearby levels to add to cluster
      for (let j = idx - 1; j >= 0; j--) {
        if (used.has(j)) continue;
        const distance = Math.abs(sortedLevels[idx].price - sortedLevels[j].price);

        // Check cluster width constraint
        const currentClusterLevels = cluster.concat(sortedLevels[j]);
        const clusterWidth = Math.max(...currentClusterLevels.map(l => l.price)) -
                            Math.min(...currentClusterLevels.map(l => l.price));

        if (distance <= radius && clusterWidth <= maxClusterWidth) {
          toProcess.push(j);
        } else {
          break; // Too far, stop looking in this direction
        }
      }

      // Look forward
      for (let j = idx + 1; j < sortedLevels.length; j++) {
        if (used.has(j)) continue;
        const distance = Math.abs(sortedLevels[idx].price - sortedLevels[j].price);

        // Check cluster width constraint
        const currentClusterLevels = cluster.concat(sortedLevels[j]);
        const clusterWidth = Math.max(...currentClusterLevels.map(l => l.price)) -
                            Math.min(...currentClusterLevels.map(l => l.price));

        if (distance <= radius && clusterWidth <= maxClusterWidth) {
          toProcess.push(j);
        } else {
          break; // Too far, stop looking in this direction
        }
      }
    }

    return cluster;
  }

  /**
   * Calculate adaptive radius based on local density
   */
  calculateAdaptiveRadius(sortedLevels, centerIndex) {
    // Look at nearby level spacing to determine appropriate radius
    const window = 2; // Look at 2 levels on each side
    const start = Math.max(0, centerIndex - window);
    const end = Math.min(sortedLevels.length - 1, centerIndex + window);

    const distances = [];
    for (let i = start + 1; i <= end; i++) {
      distances.push(sortedLevels[i].price - sortedLevels[i - 1].price);
    }

    if (distances.length === 0) return 35; // Default radius

    // Use median distance as base, multiply by factor for radius
    distances.sort((a, b) => a - b);
    const median = distances[Math.floor(distances.length / 2)];

    // Radius is 2x median spacing, but capped
    return Math.min(Math.max(median * 2, 20), 50);
  }


  /**
   * Score confluence zones based on multiple factors
   */
  scoreConfluenceZones(clusters) {
    return clusters.map(cluster => {
      const zone = this.analyzeConfluenceZone(cluster);
      return zone;
    }).filter(zone => zone.score >= this.options.minConfluenceScore);
  }

  /**
   * Analyze a single confluence zone and calculate its score
   */
  analyzeConfluenceZone(levels) {
    const prices = levels.map(l => l.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    // Calculate weighted centroid instead of simple center
    const weightedCentroid = this.calculateWeightedCentroid(levels);
    const centerPrice = weightedCentroid;
    const zoneWidth = maxPrice - minPrice;

    // Base score from number of levels
    let score = levels.length * 2;

    // Source diversity bonus
    const sourceCounts = {};
    levels.forEach(level => {
      sourceCounts[level.source] = (sourceCounts[level.source] || 0) + 1;
    });
    const uniqueSources = Object.keys(sourceCounts).length;
    score += uniqueSources * 1.5; // Bonus for multiple source types

    // Level quality scoring
    levels.forEach(level => {
      const levelScore = level.strength * 0.01 * level.sourceWeight * level.ratioWeight;
      score += levelScore;
    });

    // Zone compactness bonus (tighter zones score higher)
    const compactnessBonus = Math.max(0, (this.options.proximityThreshold - zoneWidth) * 0.02);
    score += compactnessBonus;

    // Special bonuses for high-value combinations
    const hasGex = levels.some(l => l.source === 'gex');
    const hasPrimeGoldenFib = levels.some(l => l.source === 'fibonacci' && Math.abs(l.metadata?.ratio - 0.705) < 0.01);
    const hasHalfRetracement = levels.some(l => l.source === 'fibonacci' && Math.abs(l.metadata?.ratio - 0.5) < 0.01);
    const hasSessionLevel = levels.some(l => l.source === 'session');

    if (hasGex && hasPrimeGoldenFib) score += 2.0; // GEX + 70.5% fib
    if (hasGex && hasHalfRetracement) score += 1.5; // GEX + 50% fib
    if (hasGex && hasSessionLevel) score += 1.5;    // GEX + session level
    if (hasPrimeGoldenFib && hasSessionLevel) score += 1.0; // 70.5% fib + session

    return {
      centerPrice: centerPrice,
      minPrice: minPrice,
      maxPrice: maxPrice,
      zoneWidth: zoneWidth,
      levelCount: levels.length,
      uniqueSources: uniqueSources,
      score: score,
      quality: this.getZoneQuality(score),
      levels: levels,
      sourceSummary: sourceCounts,
      hasGex: hasGex,
      hasPrimeGoldenFib: hasPrimeGoldenFib,
      hasSessionLevel: hasSessionLevel,
      density: levels.length / (zoneWidth + 1), // Levels per point of price
      entryPrice: weightedCentroid // Optimal entry based on weighted center
    };
  }

  /**
   * Calculate weighted centroid of levels for optimal entry point
   */
  calculateWeightedCentroid(levels) {
    let totalWeight = 0;
    let weightedSum = 0;

    levels.forEach(level => {
      // Calculate weight based on level strength and type
      let weight = level.strength * 0.01 * level.sourceWeight * level.ratioWeight;

      // Extra weight for special levels
      if (level.source === 'gex') weight *= 1.5;
      if (level.source === 'fibonacci' && Math.abs(level.metadata?.ratio - 0.705) < 0.01) weight *= 1.3;

      weightedSum += level.price * weight;
      totalWeight += weight;
    });

    return totalWeight > 0 ? weightedSum / totalWeight :
           (Math.min(...levels.map(l => l.price)) + Math.max(...levels.map(l => l.price))) / 2;
  }

  /**
   * Get zone quality rating based on score
   */
  getZoneQuality(score) {
    if (score >= this.options.excellentConfluenceScore) return 'excellent';
    if (score >= this.options.minConfluenceScore * 1.5) return 'good';
    if (score >= this.options.minConfluenceScore) return 'fair';
    return 'poor';
  }

  /**
   * Get the best confluence zone for entry
   */
  getBestConfluenceZone() {
    if (this.confluenceZones.length === 0) return null;
    return this.confluenceZones[0]; // Already sorted by score
  }

  /**
   * Get confluence zones above a certain quality threshold
   */
  getQualityZones(minQuality = 'fair') {
    const qualityOrder = { 'poor': 0, 'fair': 1, 'good': 2, 'excellent': 3 };
    const minLevel = qualityOrder[minQuality];

    return this.confluenceZones.filter(zone =>
      qualityOrder[zone.quality] >= minLevel
    );
  }

  /**
   * Calculate risk/reward ratio for a confluence zone
   */
  calculateRiskReward(zone, currentPrice, stopLossPrice, targetPrice) {
    const entryPrice = zone.centerPrice;
    const risk = Math.abs(entryPrice - stopLossPrice);
    const reward = Math.abs(targetPrice - entryPrice);

    return {
      entryPrice: entryPrice,
      risk: risk,
      reward: reward,
      ratio: reward / risk,
      maxAcceptableRisk: 50 // points
    };
  }

  /**
   * Get debug information about confluence analysis
   */
  getDebugInfo() {
    return {
      totalZones: this.confluenceZones.length,
      qualityBreakdown: this.confluenceZones.reduce((acc, zone) => {
        acc[zone.quality] = (acc[zone.quality] || 0) + 1;
        return acc;
      }, {}),
      topZones: this.confluenceZones.slice(0, 3).map(zone => ({
        centerPrice: zone.centerPrice.toFixed(2),
        score: zone.score.toFixed(2),
        quality: zone.quality,
        levelCount: zone.levelCount,
        sources: Object.keys(zone.sourceSummary),
        zoneWidth: zone.zoneWidth.toFixed(2)
      })),
      lastUpdate: this.lastUpdate
    };
  }
}