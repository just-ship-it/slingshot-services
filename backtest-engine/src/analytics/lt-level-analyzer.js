/**
 * LT Level Entry Analyzer
 *
 * Analyzes which Liquidity Trigger levels would have provided
 * optimal entry points for trade signals by tracking actual
 * price movements and determining which levels were hit.
 */

import { roundToNQTick } from '../../../shared/strategies/strategy-utils.js';

export class LTLevelAnalyzer {
  constructor() {
    this.analysisData = [];
  }

  /**
   * Start tracking LT level analysis for a new trade signal
   *
   * @param {Object} signal - Trade signal with availableLTLevels
   * @param {number} signalTimestamp - When signal was generated
   */
  startTradeAnalysis(signal, signalTimestamp) {
    if (!signal.availableLTLevels) {
      return null;
    }

    const analysis = {
      tradeId: signal.id || `signal_${signalTimestamp}`,
      signalTimestamp: signalTimestamp,
      direction: signal.entryAnalysis.direction,
      signalPrice: signal.entryAnalysis.signalPrice,
      confluenceTarget: signal.entryAnalysis.confluenceTarget,
      actualEntryPrice: signal.entryAnalysis.actualEntryPrice,
      stopLoss: signal.stop_loss,
      availableLTLevels: signal.availableLTLevels,

      // Track which levels are hit and when
      levelHits: {
        level_1: null,
        level_2: null,
        level_3: null,
        level_4: null,
        level_5: null
      },

      // Track optimal entry analysis
      optimalEntry: {
        bestLevel: null,
        bestEntryPrice: null,
        reasonStopped: null, // 'target_hit', 'stop_hit', 'market_close'
        wouldHaveBeenBetter: false,
        improvementPoints: 0
      },

      // Track actual trade outcome
      tradeOutcome: {
        exitPrice: null,
        exitReason: null,
        netPnL: null,
        completed: false
      }
    };

    // Store for tracking
    this.analysisData.push(analysis);

    return analysis;
  }

  /**
   * Update analysis with price action during trade lifecycle
   *
   * @param {string} tradeId - Trade identifier
   * @param {Object} candle - Current price candle
   */
  updateLevelHits(tradeId, candle) {
    const analysis = this.analysisData.find(a => a.tradeId === tradeId);
    if (!analysis || analysis.tradeOutcome.completed) {
      return;
    }

    // Check which levels price has hit
    Object.keys(analysis.availableLTLevels).forEach(levelKey => {
      if (levelKey === 'sentiment') return;

      const levelPrice = analysis.availableLTLevels[levelKey];
      if (!levelPrice || analysis.levelHits[levelKey]) return; // Skip if already hit

      // Check if price hit this level
      const priceHitLevel = (candle.low <= levelPrice && levelPrice <= candle.high);

      if (priceHitLevel) {
        analysis.levelHits[levelKey] = {
          timestamp: candle.timestamp,
          hitPrice: roundToNQTick(levelPrice),
          candleOpen: candle.open,
          candleClose: candle.close,
          candleHigh: candle.high,
          candleLow: candle.low
        };
      }
    });
  }

  /**
   * Complete the analysis when trade is finished
   *
   * @param {string} tradeId - Trade identifier
   * @param {Object} tradeResult - Final trade outcome
   */
  completeTradeAnalysis(tradeId, tradeResult) {
    const analysis = this.analysisData.find(a => a.tradeId === tradeId);
    if (!analysis) {
      return;
    }

    // Record final trade outcome
    analysis.tradeOutcome = {
      exitPrice: tradeResult.actualExit,
      exitReason: tradeResult.exitReason,
      netPnL: tradeResult.netPnL,
      completed: true
    };

    // Determine optimal entry level
    this.calculateOptimalEntry(analysis);
  }

  /**
   * Calculate which LT level would have provided the best entry
   *
   * @param {Object} analysis - Trade analysis object
   */
  calculateOptimalEntry(analysis) {
    const isLong = analysis.direction === 'long';
    const actualEntryPrice = analysis.actualEntryPrice;
    const confluenceTarget = analysis.confluenceTarget;
    const stopLoss = analysis.stopLoss;

    let bestEntry = {
      level: null,
      price: actualEntryPrice,
      improvement: 0,
      wouldHaveWorked: false
    };

    // Check each level that was hit
    Object.keys(analysis.levelHits).forEach(levelKey => {
      const hit = analysis.levelHits[levelKey];
      if (!hit) return;

      const levelPrice = analysis.availableLTLevels[levelKey];

      // For long trades, we want levels BELOW the signal price for better entries
      // For short trades, we want levels ABOVE the signal price for better entries
      const isValidDirection = isLong ?
        (levelPrice < analysis.signalPrice) :
        (levelPrice > analysis.signalPrice);

      if (!isValidDirection) return;

      // Calculate if this entry would have been better
      const entryImprovement = isLong ?
        (actualEntryPrice - levelPrice) : // Long: entering lower is better
        (levelPrice - actualEntryPrice);  // Short: entering higher is better

      // Check if trade would have worked from this level
      const wouldHaveHitTarget = isLong ?
        (hit.candleHigh >= confluenceTarget || analysis.tradeOutcome.exitReason === 'take_profit') :
        (hit.candleLow <= confluenceTarget || analysis.tradeOutcome.exitReason === 'take_profit');

      const wouldHaveHitStop = isLong ?
        (hit.candleLow <= stopLoss) :
        (hit.candleHigh >= stopLoss);

      // Only consider if it would have been a better entry and potentially worked
      if (entryImprovement > 0 && entryImprovement > bestEntry.improvement) {
        bestEntry = {
          level: levelKey,
          price: levelPrice,
          improvement: entryImprovement,
          wouldHaveWorked: wouldHaveHitTarget && !wouldHaveHitStop,
          hitTimestamp: hit.timestamp,
          distanceFromSignal: Math.abs(levelPrice - analysis.signalPrice)
        };
      }
    });

    analysis.optimalEntry = {
      bestLevel: bestEntry.level,
      bestEntryPrice: bestEntry.price,
      reasonStopped: analysis.tradeOutcome.exitReason,
      wouldHaveBeenBetter: bestEntry.improvement > 0,
      improvementPoints: roundToNQTick(bestEntry.improvement),
      wouldHaveWorked: bestEntry.wouldHaveWorked,
      hitTimestamp: bestEntry.hitTimestamp || null,
      distanceFromSignal: bestEntry.distanceFromSignal || 0
    };
  }

  /**
   * Get comprehensive analysis results
   *
   * @returns {Object} Analysis summary and recommendations
   */
  getAnalysisResults() {
    const completedAnalyses = this.analysisData.filter(a => a.tradeOutcome.completed);

    if (completedAnalyses.length === 0) {
      return {
        totalTrades: 0,
        message: 'No completed trades to analyze'
      };
    }

    // Overall statistics
    const stats = {
      totalTrades: completedAnalyses.length,
      tradesWithBetterLTEntry: 0,
      tradesWithWorkableLTEntry: 0,
      avgImprovement: 0,
      totalImprovementPoints: 0
    };

    // Level-specific statistics
    const levelStats = {
      level_1: { hits: 0, betterEntries: 0, workableEntries: 0, avgImprovement: 0 },
      level_2: { hits: 0, betterEntries: 0, workableEntries: 0, avgImprovement: 0 },
      level_3: { hits: 0, betterEntries: 0, workableEntries: 0, avgImprovement: 0 },
      level_4: { hits: 0, betterEntries: 0, workableEntries: 0, avgImprovement: 0 },
      level_5: { hits: 0, betterEntries: 0, workableEntries: 0, avgImprovement: 0 }
    };

    completedAnalyses.forEach(analysis => {
      // Count level hits
      Object.keys(analysis.levelHits).forEach(levelKey => {
        if (analysis.levelHits[levelKey]) {
          levelStats[levelKey].hits++;
        }
      });

      // Track optimal entry stats
      if (analysis.optimalEntry.wouldHaveBeenBetter) {
        stats.tradesWithBetterLTEntry++;
        stats.totalImprovementPoints += analysis.optimalEntry.improvementPoints;

        if (analysis.optimalEntry.wouldHaveWorked) {
          stats.tradesWithWorkableLTEntry++;
        }

        // Update level-specific stats
        const bestLevel = analysis.optimalEntry.bestLevel;
        if (bestLevel && levelStats[bestLevel]) {
          levelStats[bestLevel].betterEntries++;
          levelStats[bestLevel].avgImprovement += analysis.optimalEntry.improvementPoints;

          if (analysis.optimalEntry.wouldHaveWorked) {
            levelStats[bestLevel].workableEntries++;
          }
        }
      }
    });

    // Calculate averages
    stats.avgImprovement = stats.tradesWithBetterLTEntry > 0 ?
      roundToNQTick(stats.totalImprovementPoints / stats.tradesWithBetterLTEntry) : 0;

    Object.keys(levelStats).forEach(level => {
      const levelData = levelStats[level];
      levelData.avgImprovement = levelData.betterEntries > 0 ?
        roundToNQTick(levelData.avgImprovement / levelData.betterEntries) : 0;
    });

    // Recommendations
    const recommendations = this.generateRecommendations(stats, levelStats);

    return {
      summary: stats,
      levelBreakdown: levelStats,
      recommendations: recommendations,
      trades: completedAnalyses.map(a => ({
        tradeId: a.tradeId,
        timestamp: new Date(a.signalTimestamp).toISOString(),
        direction: a.direction,
        actualEntry: a.actualEntryPrice,
        optimalLevel: a.optimalEntry.bestLevel,
        optimalEntry: a.optimalEntry.bestEntryPrice,
        improvement: a.optimalEntry.improvementPoints,
        wouldHaveWorked: a.optimalEntry.wouldHaveWorked,
        tradeResult: a.tradeOutcome.netPnL
      }))
    };
  }

  /**
   * Generate strategic recommendations based on analysis
   *
   * @param {Object} stats - Overall statistics
   * @param {Object} levelStats - Level-specific statistics
   * @returns {Array} Array of recommendation strings
   */
  generateRecommendations(stats, levelStats) {
    const recommendations = [];

    // Overall improvement potential
    const improvementRate = (stats.tradesWithBetterLTEntry / stats.totalTrades) * 100;
    const workabilityRate = stats.tradesWithBetterLTEntry > 0 ?
      (stats.tradesWithWorkableLTEntry / stats.tradesWithBetterLTEntry) * 100 : 0;

    recommendations.push(
      `${improvementRate.toFixed(1)}% of trades had better LT entry opportunities (${stats.tradesWithBetterLTEntry}/${stats.totalTrades})`
    );

    if (stats.tradesWithBetterLTEntry > 0) {
      recommendations.push(
        `${workabilityRate.toFixed(1)}% of better entries would have worked (${stats.tradesWithWorkableLTEntry}/${stats.tradesWithBetterLTEntry})`
      );

      recommendations.push(
        `Average improvement: ${stats.avgImprovement} points per trade`
      );
    }

    // Find best performing level
    let bestLevel = null;
    let bestScore = 0;

    Object.keys(levelStats).forEach(level => {
      const levelData = levelStats[level];
      if (levelData.hits > 0) {
        // Score based on workable entries and hit frequency
        const score = (levelData.workableEntries / stats.totalTrades) + (levelData.avgImprovement / 100);
        if (score > bestScore) {
          bestScore = score;
          bestLevel = level;
        }
      }
    });

    if (bestLevel) {
      const levelData = levelStats[bestLevel];
      recommendations.push(
        `Best level: ${bestLevel} (${levelData.workableEntries} workable entries, ${levelData.avgImprovement} avg improvement)`
      );
    }

    // Strategy suggestions
    if (improvementRate > 50) {
      recommendations.push(
        'RECOMMENDATION: Implement LT-level entry system - high improvement potential detected'
      );
    } else if (improvementRate > 25) {
      recommendations.push(
        'SUGGESTION: Consider LT-level entries for selective trades'
      );
    }

    return recommendations;
  }

  /**
   * Reset analysis data
   */
  reset() {
    this.analysisData = [];
  }

  /**
   * Get detailed trade-by-trade analysis
   *
   * @returns {Array} Detailed analysis for each trade
   */
  getDetailedAnalysis() {
    return this.analysisData.filter(a => a.tradeOutcome.completed);
  }
}