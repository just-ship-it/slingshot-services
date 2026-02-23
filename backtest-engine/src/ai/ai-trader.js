/**
 * AI Trader - Orchestrates the two-phase AI trading process for a trading day.
 * Phase 1: Pre-market bias formation (one LLM call)
 * Phase 2: Real-time entry detection near key levels (LLM calls gated by proximity)
 */

import { FeatureAggregator } from './feature-aggregator.js';
import { PromptBuilder } from './prompt-builder.js';
import { LLMClient } from './llm-client.js';
import {
  getRTHOpenTime, getRTHCloseTime, formatET, formatETDateTime,
  getSessionInfo, isTradingDay, isInTradingWindow, getTradingWindowName,
} from './session-utils.js';

export class AITrader {
  constructor(config = {}) {
    this.config = {
      evaluationTimeframe: config.evaluationTimeframe || '5m',
      levelProximityThreshold: config.levelProximityThreshold || 30,
      maxEntriesPerDay: config.maxEntriesPerDay || 4,
      maxEntriesPerSession: config.maxEntriesPerSession || 2,
      maxLossesPerDay: config.maxLossesPerDay || 2,
      reassessmentIntervalMs: config.reassessmentIntervalMs || 30 * 60 * 1000, // 30 min
      rthOnly: config.rthOnly !== false,
      dryRun: config.dryRun || false,
      verbose: config.verbose || false,
      ticker: config.ticker || 'NQ',
      dataDir: config.dataDir,
      model: config.model || 'claude-sonnet-4-20250514',
      apiKey: config.apiKey,
    };

    this.aggregator = new FeatureAggregator({
      dataDir: this.config.dataDir,
      ticker: this.config.ticker,
    });
    this.promptBuilder = new PromptBuilder({ ticker: this.config.ticker });
    this.llm = new LLMClient({
      model: this.config.model,
      apiKey: this.config.apiKey,
    });
  }

  /**
   * Load data for a date range covering all requested trading days.
   * Add buffer days before start for daily candle context.
   */
  async loadData(startDate, endDate) {
    // Add 15 calendar day buffer for prior daily candles
    const bufferStart = new Date(startDate + 'T12:00:00Z');
    bufferStart.setUTCDate(bufferStart.getUTCDate() - 15);
    const bufferedStart = bufferStart.toISOString().slice(0, 10);

    console.log(`\nLoading data: ${bufferedStart} to ${endDate} (${this.config.ticker})`);
    await this.aggregator.loadData(bufferedStart, endDate);
  }

  /**
   * Run the AI trading process for a single day.
   */
  async runDay(tradingDay) {
    if (!isTradingDay(tradingDay)) {
      console.log(`  ${tradingDay}: Weekend — skipping`);
      return null;
    }

    console.log(`\n${'━'.repeat(60)}`);
    console.log(`  Trading Day: ${tradingDay} (${this.config.ticker})`);
    console.log(`${'━'.repeat(60)}`);

    const dayResult = {
      date: tradingDay,
      bias: null,
      entries: [],
      outcomes: [],
      skipped: false,
    };

    // ── Phase 1: Bias Formation ────────────────────────────
    console.log('\n  Phase 1: Pre-market bias formation...');

    const preMarketState = this.aggregator.getPreMarketState(tradingDay);

    // Check if we have enough data
    if (!preMarketState.priorDailyCandles || preMarketState.priorDailyCandles.length < 2) {
      console.log('  Insufficient prior daily data — skipping day');
      dayResult.skipped = true;
      dayResult.skipReason = 'insufficient_prior_data';
      return dayResult;
    }

    const biasPrompt = this.promptBuilder.buildBiasPrompt(preMarketState);

    let bias;
    if (this.config.dryRun) {
      bias = this.llm.dryRun(biasPrompt.system, biasPrompt.user, 'bias');
    } else {
      try {
        bias = await this.llm.query(biasPrompt.system, biasPrompt.user);
      } catch (e) {
        console.log(`  Bias LLM error: ${e.message}`);
        dayResult.skipped = true;
        dayResult.skipReason = 'bias_llm_error';
        return dayResult;
      }
    }

    dayResult.bias = bias;
    console.log(`  Bias: ${bias.bias} (conviction: ${bias.conviction}/5)`);
    console.log(`  Reasoning: ${bias.reasoning}`);

    if (this.config.verbose && bias.key_levels_to_watch) {
      for (const kl of bias.key_levels_to_watch) {
        console.log(`    Level: ${kl.price} (${kl.type}) → ${kl.action}`);
      }
    }

    // If bias is neutral with low conviction, optionally skip
    if (bias.bias === 'neutral' && bias.conviction <= 1) {
      console.log('  Neutral bias with minimal conviction — still scanning for entries');
    }

    // ── Phase 2: Entry Detection with Rolling Reassessment ──
    console.log('\n  Phase 2: Scanning for entries (with 30-min bias reassessment)...');

    const rthOpen = getRTHOpenTime(tradingDay);
    const rthClose = getRTHCloseTime(tradingDay);

    // Get candles for the evaluation period
    const rthCandles1m = this.aggregator.getRTHCandles(tradingDay);
    if (rthCandles1m.length === 0) {
      console.log('  No RTH candles found — skipping entry phase');
      dayResult.skipped = true;
      dayResult.skipReason = 'no_rth_candles';
      return dayResult;
    }

    // Aggregate to evaluation timeframe
    const evalCandles = this.aggregator.aggregateCandles(rthCandles1m, this.config.evaluationTimeframe);
    console.log(`  ${evalCandles.length} ${this.config.evaluationTimeframe} candles to evaluate`);

    let activeBias = bias;
    let lastReassessmentTime = rthOpen;
    let totalEntriesMade = 0;
    let totalLosses = 0;
    let sessionEntriesMade = 0;
    let currentWindow = null;
    let llmCallsThisDay = 0;
    let reassessmentCalls = 0;
    let biasReversals = 0;
    let skippedNotNear = 0;
    let lastStopTimestamp = 0;
    const STOP_COOLDOWN_MS = 30 * 60 * 1000;
    let cooldownLoggedForStop = 0; // track which stop we've already logged cooldown for
    const biasHistory = [{ time: formatET(rthOpen), bias: bias.bias, conviction: bias.conviction, source: 'pre-market' }];

    dayResult.biasHistory = biasHistory;

    for (let i = 1; i < evalCandles.length; i++) {
      if (totalEntriesMade >= this.config.maxEntriesPerDay) {
        if (this.config.verbose) console.log(`  Max daily entries (${this.config.maxEntriesPerDay}) reached`);
        break;
      }
      if (totalLosses >= this.config.maxLossesPerDay) {
        console.log(`  Daily loss limit reached (${totalLosses} losses) — done for the day`);
        break;
      }

      const candle = evalCandles[i];
      const price = candle.close;

      // Skip candles outside trading windows (midday break 11:00-13:00)
      if (!isInTradingWindow(candle.timestamp)) {
        continue;
      }

      // Track session transitions — reset per-session entry counter
      const windowName = getTradingWindowName(candle.timestamp);
      if (windowName !== currentWindow) {
        if (currentWindow !== null) {
          console.log(`  Session transition: ${currentWindow} → ${windowName}`);
        }
        currentWindow = windowName;
        sessionEntriesMade = 0;
        // Reset reassessment timer at session start
        lastReassessmentTime = candle.timestamp;
      }

      // Per-session entry limit
      if (sessionEntriesMade >= this.config.maxEntriesPerSession) {
        continue;
      }

      // Post-stop cooldown: skip entry eval AND reassessment for 30 min after a stop loss
      if (lastStopTimestamp > 0 && candle.timestamp - lastStopTimestamp < STOP_COOLDOWN_MS) {
        if (this.config.verbose && cooldownLoggedForStop !== lastStopTimestamp) {
          const remainingMin = Math.ceil((STOP_COOLDOWN_MS - (candle.timestamp - lastStopTimestamp)) / 60000);
          const stopTimeET = formatET(lastStopTimestamp);
          console.log(`  Cooldown active (${remainingMin} min remaining after stop at ${stopTimeET})`);
          cooldownLoggedForStop = lastStopTimestamp;
        }
        continue;
      }

      // Rolling reassessment every 30 minutes during active trading windows
      if (candle.timestamp - lastReassessmentTime >= this.config.reassessmentIntervalMs) {
        const previousBias = activeBias.bias;
        activeBias = await this._reassessBias(tradingDay, candle.timestamp, lastReassessmentTime, activeBias, dayResult.entries, dayResult.outcomes);
        reassessmentCalls++;

        biasHistory.push({
          time: formatET(candle.timestamp),
          bias: activeBias.bias,
          conviction: activeBias.conviction,
          source: 'reassessment',
        });

        if (activeBias.bias !== previousBias) {
          biasReversals++;
        }

        lastReassessmentTime = candle.timestamp;
      }

      // Gate: Check if near a key level
      const proximity = this.aggregator.isNearKeyLevel(candle.timestamp, price, this.config.levelProximityThreshold, tradingDay);
      if (!proximity.near) {
        skippedNotNear++;
        continue;
      }

      llmCallsThisDay++;

      if (this.config.verbose) {
        const nearest = proximity.nearest;
        console.log(`  [${formatET(candle.timestamp)}] Near ${nearest.label} (${nearest.price.toFixed(2)}, ${nearest.distance.toFixed(1)} pts) — evaluating...`);
      }

      // Build recent candle window (prior 20 eval-timeframe candles)
      const recentWindow = evalCandles.slice(Math.max(0, i - 20), i);

      const realTimeState = this.aggregator.getRealTimeState(candle.timestamp, candle, recentWindow, tradingDay);

      // Inject LT migration into realTimeState for the entry prompt
      if (lastReassessmentTime && candle.timestamp - lastReassessmentTime < this.config.reassessmentIntervalMs) {
        const ltMig = this.aggregator._computeLTMigration(
          tradingDay,
          Math.max(rthOpen, candle.timestamp - 30 * 60 * 1000),
          candle.timestamp
        );
        if (ltMig) {
          realTimeState.ltMigration = {
            overallSignal: ltMig.overallSignal,
            shortTermTrend: ltMig.shortTermTrend,
            longTermTrend: ltMig.longTermTrend,
          };
        }
      }

      const entryPrompt = this.promptBuilder.buildEntryPrompt(realTimeState, activeBias);

      let decision;
      if (this.config.dryRun) {
        decision = this.llm.dryRun(entryPrompt.system, entryPrompt.user, 'entry');
      } else {
        try {
          decision = await this.llm.query(entryPrompt.system, entryPrompt.user);
        } catch (e) {
          console.log(`  Entry LLM error at ${formatET(candle.timestamp)}: ${e.message}`);
          continue;
        }
      }

      if (decision.action === 'enter') {
        // Post-decision validation
        const riskPts = Math.abs(decision.entry_price - decision.stop_loss);
        const rewardPts = Math.abs(decision.take_profit - decision.entry_price);
        const rrRatio = riskPts > 0 ? rewardPts / riskPts : 0;

        if (riskPts > 40) {
          console.log(`  REJECTED at ${formatET(candle.timestamp)}: risk ${riskPts.toFixed(1)} pts exceeds 40pt safety cap`);
          continue;
        }
        if (isNaN(decision.stop_loss) || isNaN(decision.take_profit)) {
          console.log(`  REJECTED at ${formatET(candle.timestamp)}: invalid stop/target values`);
          continue;
        }
        if (rrRatio < 1.5) {
          console.log(`  REJECTED at ${formatET(candle.timestamp)}: R:R ${rrRatio.toFixed(2)} below 1.5 minimum`);
          continue;
        }
        if (rrRatio < 2.0) {
          console.log(`  WARNING at ${formatET(candle.timestamp)}: R:R ${rrRatio.toFixed(2)} below 2.0 target (accepted)`);
        }

        totalEntriesMade++;
        sessionEntriesMade++;

        const stopRef = decision.stop_level_reference || '';
        const targetRef = decision.target_level_reference || '';
        console.log(`  ENTRY #${totalEntriesMade} [${currentWindow}]: ${decision.side.toUpperCase()} at ${decision.entry_price} (stop: ${decision.stop_loss}${stopRef ? ' ' + stopRef : ''}, target: ${decision.take_profit}${targetRef ? ' ' + targetRef : ''})`);
        console.log(`    Risk: ${riskPts.toFixed(1)} pts, Target: ${rewardPts.toFixed(1)} pts, R:R: ${rrRatio.toFixed(1)}:1, Confidence: ${decision.confidence}/5`);
        console.log(`    Reason: ${decision.reasoning}`);
        console.log(`    Active bias: ${activeBias.bias} (conviction: ${activeBias.conviction}/5)`);

        // Simulate outcome with active trade management
        const outcome = this.aggregator.simulateManagedTrade(
          candle.timestamp,
          decision.entry_price,
          decision.stop_loss,
          decision.take_profit,
          decision.side,
          tradingDay
        );
        console.log(`    Outcome: ${outcome.outcome.toUpperCase()} — P&L: ${outcome.pnl > 0 ? '+' : ''}${outcome.pnl.toFixed(2)} pts (${outcome.bars} bars, exit ${outcome.exitTime || 'N/A'})`);

        if (outcome.stopAdjustments && outcome.stopAdjustments.length > 0) {
          const trail = outcome.stopAdjustments.map(a => `${a.to} (${a.reason} @bar ${a.bar})`).join(' → ');
          console.log(`    Stop trail: ${decision.stop_loss} → ${trail}`);
        }
        if (outcome.maxFavorableExcursion != null) {
          console.log(`    MFE: +${outcome.maxFavorableExcursion.toFixed(1)} pts | MAE: ${outcome.maxAdverseExcursion.toFixed(1)} pts`);
        }

        dayResult.entries.push({
          time: formatET(candle.timestamp),
          session: currentWindow,
          activeBias: activeBias.bias,
          ...decision,
          nearestLevel: proximity.nearest,
        });
        dayResult.outcomes.push(outcome);
        if (outcome.pnl < 0) {
          totalLosses++;
          lastStopTimestamp = candle.timestamp;
        }
      } else {
        if (this.config.verbose) {
          console.log(`  PASS at ${formatET(candle.timestamp)}: ${decision.reasoning}`);
        }
      }
    }

    dayResult.biasReversals = biasReversals;
    dayResult.reassessmentCalls = reassessmentCalls;

    console.log(`\n  Summary: ${skippedNotNear} candles not near levels, ${llmCallsThisDay} entry evals, ${reassessmentCalls} reassessments, ${biasReversals} bias reversals, ${totalEntriesMade} entries`);
    if (biasHistory.length > 1) {
      console.log(`  Bias progression: ${biasHistory.map(b => `${b.bias}(${b.conviction})`).join(' → ')}`);
    }

    return dayResult;
  }

  /**
   * Reassess directional bias based on the last 30-min window of data.
   */
  async _reassessBias(tradingDay, currentTimestamp, windowStartTime, currentBias, entries, outcomes) {
    const windowSummary = this.aggregator.getWindowSummary(tradingDay, windowStartTime, currentTimestamp);

    // Build recent trades for context
    const recentTrades = [];
    for (let i = 0; i < entries.length; i++) {
      if (outcomes[i]) {
        recentTrades.push({ entry: entries[i], outcome: outcomes[i] });
      }
    }

    const reassessPrompt = this.promptBuilder.buildReassessmentPrompt(windowSummary, currentBias, recentTrades);

    let newBias;
    if (this.config.dryRun) {
      newBias = this.llm.dryRun(reassessPrompt.system, reassessPrompt.user, 'reassessment');
    } else {
      try {
        newBias = await this.llm.query(reassessPrompt.system, reassessPrompt.user);
      } catch (e) {
        console.log(`  Reassessment LLM error at ${formatET(currentTimestamp)}: ${e.message} — keeping current bias`);
        return currentBias;
      }
    }

    const changed = newBias.bias !== currentBias.bias;
    const convChanged = newBias.conviction !== currentBias.conviction;
    if (changed || convChanged) {
      console.log(`  30-min reassessment at ${formatET(currentTimestamp)}: ${currentBias.bias}(${currentBias.conviction}) → ${newBias.bias}(${newBias.conviction})`);
      if (this.config.verbose) {
        console.log(`    Reason: ${newBias.reasoning}`);
      }
    } else if (this.config.verbose) {
      console.log(`  30-min reassessment at ${formatET(currentTimestamp)}: bias unchanged — ${newBias.bias}(${newBias.conviction})`);
    }

    return newBias;
  }

  /**
   * Run across multiple trading days and aggregate results.
   */
  async runMultipleDays(tradingDays) {
    const results = {
      config: { ...this.config, apiKey: undefined },
      days: [],
      summary: null,
    };

    for (const day of tradingDays) {
      const dayResult = await this.runDay(day);
      if (dayResult) {
        results.days.push(dayResult);
      }
    }

    // Aggregate summary
    results.summary = this._summarize(results.days);
    results.cost = this.llm.getCostSummary();

    return results;
  }

  /**
   * Summarize results across multiple days.
   */
  _summarize(days) {
    const activeDays = days.filter(d => !d.skipped);
    const allOutcomes = activeDays.flatMap(d => d.outcomes || []);

    if (allOutcomes.length === 0) {
      return {
        totalDays: days.length,
        activeDays: activeDays.length,
        skippedDays: days.length - activeDays.length,
        totalTrades: 0,
        message: 'No trades taken',
      };
    }

    const wins = allOutcomes.filter(o => o.pnl > 0);
    const losses = allOutcomes.filter(o => o.pnl < 0);
    const timeouts = allOutcomes.filter(o => o.outcome === 'timeout');
    const totalPnl = allOutcomes.reduce((sum, o) => sum + o.pnl, 0);
    const avgPnl = totalPnl / allOutcomes.length;
    const avgWin = wins.length > 0 ? wins.reduce((s, o) => s + o.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, o) => s + o.pnl, 0) / losses.length : 0;

    // Bias accuracy: count days where bias direction matched the day's overall move
    let biasCorrect = 0;
    for (const day of activeDays) {
      if (!day.bias || day.bias.bias === 'neutral') continue;
      const rthCandles = this.aggregator.getRTHCandles(day.date);
      if (rthCandles.length < 2) continue;
      const dayMove = rthCandles[rthCandles.length - 1].close - rthCandles[0].open;
      if ((day.bias.bias === 'bullish' && dayMove > 0) || (day.bias.bias === 'bearish' && dayMove < 0)) {
        biasCorrect++;
      }
    }
    const directionalDays = activeDays.filter(d => d.bias && d.bias.bias !== 'neutral').length;

    // Reassessment stats
    const totalReassessments = activeDays.reduce((s, d) => s + (d.reassessmentCalls || 0), 0);
    const totalBiasReversals = activeDays.reduce((s, d) => s + (d.biasReversals || 0), 0);

    // Trade management metrics
    const allEntries = activeDays.flatMap(d => d.entries || []);
    const avgRiskPoints = allEntries.length > 0
      ? Math.round(allEntries.reduce((s, e) => s + (Math.abs(e.entry_price - e.stop_loss) || 0), 0) / allEntries.length * 100) / 100
      : 0;
    const rrRatios = allEntries
      .map(e => {
        const risk = Math.abs(e.entry_price - e.stop_loss);
        const reward = Math.abs(e.take_profit - e.entry_price);
        return risk > 0 ? reward / risk : 0;
      })
      .filter(r => r > 0);
    const avgRewardRiskRatio = rrRatios.length > 0
      ? Math.round(rrRatios.reduce((s, r) => s + r, 0) / rrRatios.length * 100) / 100
      : 0;

    const outcomesWithMFE = allOutcomes.filter(o => o.maxFavorableExcursion != null);
    const avgMFE = outcomesWithMFE.length > 0
      ? Math.round(outcomesWithMFE.reduce((s, o) => s + o.maxFavorableExcursion, 0) / outcomesWithMFE.length * 100) / 100
      : 0;
    const avgMAE = outcomesWithMFE.length > 0
      ? Math.round(outcomesWithMFE.reduce((s, o) => s + o.maxAdverseExcursion, 0) / outcomesWithMFE.length * 100) / 100
      : 0;
    const trailedToBreakeven = allOutcomes.filter(o =>
      o.stopAdjustments && o.stopAdjustments.some(a => a.reason === 'breakeven')
    ).length;
    const managedExits = allOutcomes.filter(o => o.outcome === 'managed_exit').length;

    return {
      totalDays: days.length,
      activeDays: activeDays.length,
      skippedDays: days.length - activeDays.length,
      totalTrades: allOutcomes.length,
      wins: wins.length,
      losses: losses.length,
      timeouts: timeouts.length,
      managedExits,
      winRate: allOutcomes.length > 0 ? Math.round((wins.length / allOutcomes.length) * 100) : 0,
      totalPnlPoints: Math.round(totalPnl * 100) / 100,
      avgPnlPoints: Math.round(avgPnl * 100) / 100,
      avgWinPoints: Math.round(avgWin * 100) / 100,
      avgLossPoints: Math.round(avgLoss * 100) / 100,
      profitFactor: Math.abs(avgLoss) > 0 ? Math.round((avgWin / Math.abs(avgLoss)) * 100) / 100 : Infinity,
      avgRiskPoints,
      avgRewardRiskRatio,
      avgMFE,
      avgMAE,
      trailedToBreakeven,
      biasAccuracy: directionalDays > 0 ? `${biasCorrect}/${directionalDays} (${Math.round((biasCorrect / directionalDays) * 100)}%)` : 'N/A',
      totalReassessments,
      totalBiasReversals,
      avgReassessmentsPerDay: activeDays.length > 0 ? Math.round((totalReassessments / activeDays.length) * 10) / 10 : 0,
    };
  }

  getCostSummary() {
    return this.llm.getCostSummary();
  }
}
