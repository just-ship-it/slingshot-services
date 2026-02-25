/**
 * Prompt Builder - Formats market state into structured LLM prompts.
 * Produces system + user prompts with JSON output schemas for bias and entry decisions.
 */

import { formatET, formatETDateTime } from './session-utils.js';

const BIAS_OUTPUT_SCHEMA = {
  bias: 'bullish|bearish|neutral',
  conviction: '1-5 integer',
  key_levels_to_watch: [{ price: 'number', type: 'string', action: 'buy|sell|watch' }],
  reasoning: '2-3 sentences',
  avoid_conditions: ['string'],
  preferred_session_window: 'e.g. 10:00-11:30 ET',
};

const ENTRY_OUTPUT_SCHEMA_ENTER = {
  action: 'enter',
  side: 'buy|sell',
  entry_price: 'number',
  stop_loss: 'number',
  take_profit: 'number',
  risk_points: 'number',
  reward_risk_ratio: 'number',
  stop_level_reference: 'string — e.g. "Behind GEX S1 at 21450"',
  target_level_reference: 'string — e.g. "At Fib 61.8% at 21520"',
  reasoning: '1-2 sentences',
  confidence: '1-5 integer',
};

const ENTRY_OUTPUT_SCHEMA_PASS = {
  action: 'pass',
  reasoning: '1 sentence',
};

export class PromptBuilder {
  constructor({ ticker = 'NQ' } = {}) {
    this.ticker = ticker;
  }

  /**
   * Build the bias prompt (Phase 1 — pre-market).
   * Returns { system, user } prompt strings.
   */
  buildBiasPrompt(preMarketState) {
    const system = this._biasSystemPrompt();
    const user = this._biasUserPrompt(preMarketState);
    return { system, user };
  }

  /**
   * Build the entry prompt (Phase 2 — near key level).
   * Returns { system, user } prompt strings.
   */
  buildEntryPrompt(realTimeState, bias) {
    const system = this._entrySystemPrompt();
    const user = this._entryUserPrompt(realTimeState, bias);
    return { system, user };
  }

  /**
   * Build the reassessment prompt (rolling 30-min bias check).
   * Returns { system, user } prompt strings.
   */
  buildReassessmentPrompt(windowSummary, currentBias, recentTrades = []) {
    const system = this._reassessmentSystemPrompt();
    const user = this._reassessmentUserPrompt(windowSummary, currentBias, recentTrades);
    return { system, user };
  }

  // ── Bias prompts ──────────────────────────────────────────

  _biasSystemPrompt() {
    return `You are an experienced discretionary ${this.ticker} futures day trader. Your job is to analyze pre-market data and form a directional bias for the upcoming RTH session.

You think in terms of key levels, overnight positioning, volatility regime, institutional flow (via GEX), and critically, LIQUIDITY CONDITIONS (via LT levels). You are disciplined — you skip days where the setup is unclear.

## GEX Regime (Gamma Exposure) — CRITICAL for Trade Selection
The GEX regime determines HOW to trade, not just WHERE:
- **strong_positive / positive**: Dealers are SHORT gamma — they BUY dips and SELL rips, dampening moves. Mean-reversion plays work well. Expect moves to stall at GEX levels. Fading extremes is high-probability.
- **neutral**: Mixed dealer positioning. Levels may hold or break — use other signals (LT, price action) to decide.
- **negative / strong_negative**: Dealers are LONG gamma — they SELL into dips and BUY into rips, AMPLIFYING moves. Mean-reversion is DANGEROUS. Expect large directional moves, breakouts, and whipsaws. Trade WITH momentum, not against it. GEX levels become breakout triggers rather than bounce zones. Stops get run. Wider stops and momentum entries are required.

This is non-negotiable: Do NOT take mean-reversion trades in negative gamma. If regime is negative/strong_negative, only take momentum/breakout entries in the direction of the prevailing move. If regime is positive/strong_positive, fading into GEX levels is valid.

## LDPM Framework (Liquidity Dependent Price Movement)
Liquidity Trigger (LT) levels represent liquidity migration zones at different lookback periods (LT-34, LT-55, LT-144, LT-377, LT-610). They indicate WHERE institutional liquidity sits relative to price:
- **LT levels BELOW price** = institutional liquidity underneath = bullish cushion
- **LT levels ABOVE price** = institutional liquidity overhead = potential cap on upside
- CRITICAL: LT levels are NOT support/resistance levels. Price MIGRATES TOWARD them but they rarely produce bounces. Do not treat them as trade entry levels.
- The RELATIVE MOVEMENT (migration) of LT levels is more important than their static position. Levels moving away from price in the trend direction = healthy trend. Levels converging toward price = potential exhaustion.
- **LT Sentiment** (BULLISH/BEARISH) summarizes the level configuration but is a lagging indicator — it often lags price moves by hours. Do NOT over-anchor on LT sentiment for directional bias.
- Short-term lookbacks (LT-34/55) react quickly; long-term lookbacks (LT-377/610) move slowly and often LAG the current trend — this is normal, not a bearish signal.
- LT levels are ONE input among many — weigh them alongside GEX, price action, and trend structure

Your response must be valid JSON matching this schema:
{
  "bias": "bullish" | "bearish" | "neutral",
  "conviction": 1-5,
  "key_levels_to_watch": [
    { "price": <number>, "type": "<description>", "action": "buy" | "sell" | "watch" }
  ],
  "reasoning": "<2-3 sentences>",
  "avoid_conditions": ["<string>"],
  "preferred_session_window": "<e.g. 10:00-11:30 ET>"
}

## Index Character
${this.ticker} futures are a structurally bullish index — they trend higher over time with dips being buying opportunities more often than tops being shorting opportunities. Keep this secular bias in mind: all else being equal, longs have a statistical edge over shorts in equity index futures. This doesn't mean never short, but your default lean should be toward buying dips unless the evidence clearly favors selling.

Rules:
- conviction 1 = low confidence, 5 = very high
- key_levels_to_watch: include 3-6 levels from GEX, LT, or prior day levels — include BOTH buy and sell levels
- action: "buy" means you'd consider longs at this level, "sell" means shorts, "watch" means it's informational
- avoid_conditions: things that would make you NOT trade (e.g. "chop inside overnight range", "VIX spike")
- Be honest about uncertainty — if data is thin, say conviction 1-2
- Give equal consideration to bullish and bearish scenarios — do not default to bearish when uncertain

Respond ONLY with the JSON object. No markdown, no explanation outside JSON.`;
  }

  _biasUserPrompt(state) {
    const sections = [];

    const isLateStart = state.sessionContext != null || state.recentCandles != null;
    const header = isLateStart
      ? `# Intraday Bias Evaluation for ${this.ticker} — ${state.tradingDay}`
      : `# Pre-Market Analysis for ${this.ticker} — ${state.tradingDay}`;
    sections.push(header);

    // Current spot price (critical for late-start bias)
    if (state.currentSpotPrice != null) {
      sections.push(`\n## Current Spot Price: ${state.currentSpotPrice.toFixed(2)}`);
    }

    // Prior daily candles
    if (state.priorDailyCandles && state.priorDailyCandles.length > 0) {
      sections.push('\n## Prior Daily Candles (most recent last)');
      sections.push('| Date | Open | High | Low | Close | Range |');
      sections.push('|------|------|------|-----|-------|-------|');
      for (const c of state.priorDailyCandles) {
        const d = new Date(c.timestamp).toISOString().slice(0, 10);
        sections.push(`| ${d} | ${c.open.toFixed(2)} | ${c.high.toFixed(2)} | ${c.low.toFixed(2)} | ${c.close.toFixed(2)} | ${(c.high - c.low).toFixed(2)} |`);
      }
    }

    // Prior day HLC
    if (state.priorDayHLC) {
      sections.push(`\n## Prior Day Key Levels`);
      sections.push(`- Prior Day High: ${state.priorDayHLC.high.toFixed(2)}`);
      sections.push(`- Prior Day Low: ${state.priorDayHLC.low.toFixed(2)}`);
      sections.push(`- Prior Day Close: ${state.priorDayHLC.close.toFixed(2)}`);
    }

    // Overnight range
    if (state.overnightRange) {
      const o = state.overnightRange;
      sections.push(`\n## Overnight Session`);
      sections.push(`- Open: ${o.open.toFixed(2)} → Close: ${o.close.toFixed(2)} (${o.direction})`);
      sections.push(`- High: ${o.high.toFixed(2)}, Low: ${o.low.toFixed(2)}, Range: ${o.range.toFixed(2)} pts`);
      sections.push(`- ${o.candleCount} 1m candles`);
    }

    // GEX
    if (state.gex) {
      sections.push(`\n## GEX Levels (at open)`);
      sections.push(`- Regime: ${state.gex.regime}`);
      sections.push(`- Gamma Flip: ${this._fmt(state.gex.gammaFlip)}`);
      sections.push(`- Call Wall: ${this._fmt(state.gex.callWall)}`);
      sections.push(`- Put Wall: ${this._fmt(state.gex.putWall)}`);
      if (state.gex.resistance.length > 0) {
        sections.push(`- Resistance: ${state.gex.resistance.map((r, i) => `R${i + 1}=${this._fmt(r)}`).join(', ')}`);
      }
      if (state.gex.support.length > 0) {
        sections.push(`- Support: ${state.gex.support.map((s, i) => `S${i + 1}=${this._fmt(s)}`).join(', ')}`);
      }
      if (state.gex.totalGex != null) {
        sections.push(`- Total GEX: ${state.gex.totalGex.toFixed(0)}`);
      }
    } else {
      sections.push(`\n## GEX Levels: Not available for this date`);
    }

    // IV/Skew
    if (state.iv) {
      sections.push(`\n## Implied Volatility`);
      sections.push(`- ATM IV: ${(state.iv.iv * 100).toFixed(1)}%`);
      sections.push(`- Skew (put-call): ${(state.iv.skew * 100).toFixed(2)}%`);
      sections.push(`- Call IV: ${(state.iv.callIV * 100).toFixed(1)}%, Put IV: ${(state.iv.putIV * 100).toFixed(1)}%`);
      if (state.iv.dte) sections.push(`- DTE: ${state.iv.dte}`);
    } else {
      sections.push(`\n## Implied Volatility: Not available for this date`);
    }

    // VIX
    if (state.vix) {
      sections.push(`\n## VIX`);
      sections.push(`- Current: ${state.vix.current.toFixed(2)} (trend: ${state.vix.trend})`);
      sections.push(`- 5-day change: ${state.vix.change5d > 0 ? '+' : ''}${state.vix.change5d.toFixed(2)} (${state.vix.changePct5d > 0 ? '+' : ''}${state.vix.changePct5d.toFixed(1)}%)`);
      sections.push(`- 5-day range: ${state.vix.low5d.toFixed(2)} - ${state.vix.high5d.toFixed(2)}`);
    } else {
      sections.push(`\n## VIX: Not available for this date`);
    }

    // LT Levels — with LDPM context
    if (state.lt) {
      // Use current spot price (best), overnight close, or prior day close as reference price
      const refPrice = state.currentSpotPrice || state.overnightRange?.close || state.priorDayHLC?.close || null;
      const levelsAbove = refPrice ? state.lt.levels.filter(lv => lv > refPrice).length : '?';
      const levelsBelow = refPrice ? state.lt.levels.filter(lv => lv <= refPrice).length : '?';

      sections.push(`\n## Liquidity Trigger Levels (LDPM)`);
      sections.push(`- Sentiment: **${state.lt.sentiment}** (derived from level configuration — use as one input, not the sole directional signal)`);
      if (refPrice) {
        const refLabel = state.currentSpotPrice ? 'current spot' : state.overnightRange?.close ? 'overnight close' : 'prior day close';
        sections.push(`- Reference price (${refLabel}): ${refPrice.toFixed(2)}`);
        sections.push(`- Levels above price: ${levelsAbove} | Levels below price: ${levelsBelow}`);
      }
      const fibLabels = ['LT-34 (short-term)', 'LT-55 (short-term)', 'LT-144 (medium-term)', 'LT-377 (long-term)', 'LT-610 (long-term)'];
      state.lt.levels.forEach((lv, i) => {
        const rel = refPrice ? (lv > refPrice ? '↑ ABOVE price' : '↓ below price') : '';
        sections.push(`- ${fibLabels[i] || `Level ${i + 1}`}: ${lv.toFixed(2)} ${rel}`);
      });
    } else {
      sections.push(`\n## Liquidity Trigger Levels: Not available for this date`);
    }

    // LS (Liquidity Status) sentiment
    if (state.ls) {
      sections.push(`\n## Liquidity Status: **${state.ls.sentiment}**`);
    }

    // Late-start: current RTH session context
    if (state.sessionContext) {
      const sc = state.sessionContext;
      sections.push(`\n## Current RTH Session (live)`);
      sections.push(`- RTH Open: ${sc.rthOpen.toFixed(2)} → Current: ${state.currentSpotPrice.toFixed(2)} (${sc.distFromOpen > 0 ? '+' : ''}${sc.distFromOpen.toFixed(2)} pts from open)`);
      sections.push(`- RTH High: ${sc.rthHigh.toFixed(2)} | RTH Low: ${sc.rthLow.toFixed(2)} | Range: ${sc.rthRange.toFixed(2)} pts`);
      sections.push(`- Position in range: ${Math.round(sc.positionInRange * 100)}% (${sc.positionInRange > 0.8 ? 'near high' : sc.positionInRange < 0.2 ? 'near low' : 'mid-range'})`);
      if (sc.avgDailyRange) {
        const rangeLabel = sc.rangeRatio >= 2.0 ? 'VERY ELEVATED' : sc.rangeRatio >= 1.5 ? 'ELEVATED' : sc.rangeRatio >= 1.0 ? 'above average' : 'normal';
        sections.push(`- Avg daily range (5-day): ${sc.avgDailyRange.toFixed(1)} pts | Today: ${sc.rangeRatio.toFixed(1)}x average (${rangeLabel})`);
      }
    }

    // Late-start: recent 1m candles
    if (state.recentCandles && state.recentCandles.length > 0) {
      sections.push(`\n## Recent 1-Minute Candles (last ${state.recentCandles.length})`);
      sections.push('| Time | Open | High | Low | Close | Vol |');
      sections.push('|------|------|------|-----|-------|-----|');
      for (const rc of state.recentCandles) {
        sections.push(`| ${rc.time} | ${rc.open.toFixed(2)} | ${rc.high.toFixed(2)} | ${rc.low.toFixed(2)} | ${rc.close.toFixed(2)} | ${rc.volume} |`);
      }
    }

    return sections.join('\n');
  }

  // ── Entry prompts ─────────────────────────────────────────

  _entrySystemPrompt() {
    return `You are an experienced discretionary ${this.ticker} futures day trader evaluating a potential trade entry. Price is near a key level. Decide whether to enter or pass.

## Stop Loss Placement (Structure-Based)
- Place your stop BEHIND the nearest structural level that would invalidate your trade thesis
- For longs: stop below the nearest support level (GEX support, PD Low, fib level, swing low, overnight low)
- For shorts: stop above the nearest resistance level (GEX resistance, PD High, fib level, swing high, overnight high)
- Add 5-8 points of buffer beyond the level (stops at exact levels get hunted)
- Maximum safety cap: 40 points risk (hard limit)
- Identify which level your stop is placed behind in stop_level_reference

## Stop Placement Must Reflect Candle Structure
- Your stop must be placed at a price that the market should NOT reach if your thesis is correct
- Look at the recent candle lows (for longs) or highs (for shorts) — your stop should be BELOW a recent swing low or ABOVE a recent swing high
- A stop that is tighter than the recent candle range is likely to be noise-stopped. If the last 15 minutes covered 150 pts, a 20pt stop is meaningless
- If the recent candle structure doesn't support a reasonable stop within the 40pt safety cap, PASS on the trade
- Rule of thumb: your stop should be at least below the low of the most recent significant pullback (for longs) or above the high of the most recent bounce (for shorts)

## Target Placement (Structure-Based)
- Target the next structural level in your trade direction
- For longs: target the nearest resistance above entry (GEX resistance, fib level, PD High)
- For shorts: target the nearest support below entry (GEX support, fib level, PD Low)
- Fib retracement levels between swing H/L are excellent targets (50%, 61.8%)
- Levels marked [LT confluence] are stronger — prefer these as targets
- Identify which level your target is at in target_level_reference

## Risk:Reward Requirements
- Minimum 2:1 reward:risk ratio (prefer 3:1)
- If the nearest structural stop and target don't give you at least 2:1, PASS
- A tight stop behind a strong level with a distant target is the ideal setup
- Calculate and include reward_risk_ratio in your response

## GEX Regime — Trade Selection Filter
- **positive/strong_positive regime**: Mean-reversion is valid. Fade into GEX levels (buy support, sell resistance). Expect levels to hold. This is the BEST environment for taking trades in both directions.
- **negative/strong_negative regime**: Mean-reversion is DANGEROUS. Only take momentum/breakout trades WITH the prevailing move direction. GEX levels become breakout triggers, not bounce zones. Do NOT fade momentum in negative gamma — if price is ripping up, do not short it; if price is dumping, do not buy it. Wait for a pullback entry in the momentum direction, or PASS.
- This overrides all other signals: trade WITH the flow in negative gamma, regardless of your directional bias.

## Liquidity Trigger (LT) Levels — How to Use Them
LT levels (labeled LT-34, LT-55, LT-144, LT-377, LT-610) are NOT support/resistance levels. They are liquidity migration zones based on different lookback periods. Key rules:
- Price tends to MIGRATE TOWARD these levels, but they rarely act as strict support or resistance where price bounces
- An LT level CANNOT be the sole justification for entering a trade at a price. Never say "shorting at LT-55 resistance" or "buying at LT-34 support" — they don't work that way
- LT levels provide CONFLUENCE value only: if a GEX level, prior day level, or fib retracement level happens to align with an LT level, that strengthens the structural level
- The most valuable LT signal is MIGRATION: are levels moving toward or away from price? This is shown in the LT migration data. Levels moving away from price in the trend direction = healthy trend. Levels converging toward price = exhaustion warning
- When referencing levels for stop_level_reference or target_level_reference, use structural levels (GEX, fib retracements, prior day H/L/C, swing H/L), not LT levels

## Entry Quality — Extended Price Filters
- Check the Session Context data: if price is already extended (>70% of average daily range from open), be VERY selective
- If price has moved >100 pts in the last 15 minutes, do NOT chase — wait for a pullback or PASS
- If today's range already exceeds 1.5x the average daily range, only take trades with 3:1+ R:R and 4+ confidence
- The best entries come AFTER a pullback to a structural level, not during a momentum thrust

## Short Entry Quality — Additional Requirements
- Counter-trend shorts (selling into a recovery/uptrend) MUST have confluence with a fib retracement level on the 1h swing structure
- If the HTF Swing Structure shows price is between fib levels (not AT one within 10 points), do not short — you're selling into a retracement with no structural resistance
- The best short entries come at or above the 70.5% retracement of the prior swing, or at a clear HTF fib level with additional GEX/LT confluence
- If no HTF swing data is available, require at least 2 independent resistance confluences (e.g., GEX resistance + prior day high) before shorting

## Index Character — Structural Bullish Bias
${this.ticker} is a structurally bullish equity index. Historically, buying dips into support produces better results than shorting rips into resistance. When in doubt between a long and short setup of similar quality, prefer the long. When price is in an uptrend and pulling back to support, this is a HIGH-PROBABILITY long setup.

## General Rules
- Prefer entries AT levels, not past them
- Your directional bias is a strong guide, not an absolute rule:
  - Conviction 4-5 bias: trade in bias direction unless price action strongly contradicts
  - Conviction 3 bias: moderate flexibility — bias direction preferred but not required
  - Conviction 1-2 bias: bias is weak — let price action and level reactions guide you
  - If setup is clearly counter-bias but has strong level support and good R:R, you may take it
- Actively look for BOTH long and short setups — do not default to one direction
- Consider current price action and volume
- If in doubt, pass — there will be more opportunities

Your response must be valid JSON matching ONE of these schemas:

ENTER:
{
  "action": "enter",
  "side": "buy" | "sell",
  "entry_price": <number>,
  "stop_loss": <number>,
  "take_profit": <number>,
  "risk_points": <number>,
  "reward_risk_ratio": <number>,
  "stop_level_reference": "<e.g. Behind GEX S1 at 21450>",
  "target_level_reference": "<e.g. At Fib 61.8% at 21520>",
  "reasoning": "<1-2 sentences>",
  "confidence": 1-5
}

PASS:
{
  "action": "pass",
  "reasoning": "<1 sentence>"
}

Respond ONLY with the JSON object. No markdown, no explanation outside JSON.`;
  }

  _entryUserPrompt(realTimeState, bias) {
    const sections = [];

    sections.push(`# Entry Evaluation — ${realTimeState.time}`);

    // Bias context
    sections.push(`\n## Your Current Directional Bias`);
    sections.push(`- Bias: ${bias.bias} (conviction: ${bias.conviction}/5)`);
    sections.push(`- Reasoning: ${bias.reasoning}`);
    if (bias.avoid_conditions && bias.avoid_conditions.length > 0) {
      sections.push(`- Avoid: ${bias.avoid_conditions.join(', ')}`);
    }
    if (bias.preferred_session_window) {
      sections.push(`- Preferred window: ${bias.preferred_session_window}`);
    }

    // LT migration summary (if available in real-time state)
    if (realTimeState.ltMigration) {
      const m = realTimeState.ltMigration;
      sections.push(`- LT liquidity trend: ${m.overallSignal} (short-term: ${m.shortTermTrend}, long-term: ${m.longTermTrend})`);
    }

    // Session context
    if (realTimeState.sessionContext) {
      const sc = realTimeState.sessionContext;
      sections.push(`\n## Session Context (RTH today)`);
      sections.push(`- Open: ${sc.rthOpen.toFixed(2)} → Current: ${realTimeState.currentCandle.close.toFixed(2)} (${sc.distFromOpen > 0 ? '+' : ''}${sc.distFromOpen.toFixed(2)} pts from open)`);
      sections.push(`- RTH High: ${sc.rthHigh.toFixed(2)} | RTH Low: ${sc.rthLow.toFixed(2)} | Range: ${sc.rthRange.toFixed(2)} pts`);
      sections.push(`- Position in range: ${Math.round(sc.positionInRange * 100)}% (${sc.positionInRange > 0.8 ? 'near high' : sc.positionInRange < 0.2 ? 'near low' : 'mid-range'})`);
      const rangeLabel = sc.rangeRatio >= 2.0 ? 'VERY ELEVATED' : sc.rangeRatio >= 1.5 ? 'ELEVATED' : sc.rangeRatio >= 1.0 ? 'above average' : 'normal';
      sections.push(`- Avg daily range (5-day): ${sc.avgDailyRange.toFixed(1)} pts | Today: ${sc.rangeRatio.toFixed(1)}x average (${rangeLabel})`);
    }

    // Recent momentum
    if (realTimeState.recentMomentum) {
      const rm = realTimeState.recentMomentum;
      const dirLabel = rm.direction.replace('_', ' ');
      sections.push(`- Last 15 min: ${rm.priceDelta > 0 ? '+' : ''}${rm.priceDelta.toFixed(1)} pts (${dirLabel}), ${rm.rangeCovered.toFixed(1)} pt range covered`);
    }

    // Current candle
    const c = realTimeState.currentCandle;
    sections.push(`\n## Current Candle`);
    sections.push(`O: ${c.open.toFixed(2)} H: ${c.high.toFixed(2)} L: ${c.low.toFixed(2)} C: ${c.close.toFixed(2)} V: ${c.volume}`);

    // Recent candles
    if (realTimeState.recentCandles && realTimeState.recentCandles.length > 0) {
      sections.push(`\n## Recent Candles (oldest to newest)`);
      sections.push('| Time | Open | High | Low | Close | Vol |');
      sections.push('|------|------|------|-----|-------|-----|');
      for (const rc of realTimeState.recentCandles) {
        sections.push(`| ${rc.time} | ${rc.open.toFixed(2)} | ${rc.high.toFixed(2)} | ${rc.low.toFixed(2)} | ${rc.close.toFixed(2)} | ${rc.volume} |`);
      }
    }

    // Price action
    if (realTimeState.priceAction) {
      const pa = realTimeState.priceAction;
      sections.push(`\n## Price Action Context`);
      sections.push(`- Trend: ${pa.trend}`);
      sections.push(`- Range: ${pa.range?.toFixed(2) || 'N/A'} pts (Swing H: ${pa.swingHigh?.toFixed(2) || 'N/A'}, Swing L: ${pa.swingLow?.toFixed(2) || 'N/A'})`);
      sections.push(`- Avg Volume: ${pa.avgVolume}, Current ratio: ${pa.currentVolumeRatio}x`);
    }

    // Nearby GEX levels
    if (realTimeState.gex) {
      sections.push(`\n## GEX Levels`);
      sections.push(`- Regime: ${realTimeState.gex.regime}${realTimeState.gex.totalGex != null ? ` (Total GEX: ${realTimeState.gex.totalGex.toFixed(0)})` : ''}`);
      if (realTimeState.gex.nearestLevels && realTimeState.gex.nearestLevels.length > 0) {
        sections.push('- Nearest levels:');
        for (const l of realTimeState.gex.nearestLevels) {
          const dir = l.distance > 0 ? 'above' : 'below';
          sections.push(`  ${l.label}: ${l.price.toFixed(2)} (${Math.abs(l.distance).toFixed(1)} pts ${dir})`);
        }
      }
    }

    // IV
    if (realTimeState.iv) {
      sections.push(`\n## Current IV`);
      sections.push(`- ATM: ${(realTimeState.iv.iv * 100).toFixed(1)}%, Skew: ${(realTimeState.iv.skew * 100).toFixed(2)}%`);
    }

    // LT levels
    if (realTimeState.lt) {
      sections.push(`\n## Liquidity Trigger Levels (${realTimeState.lt.sentiment})`);
      sections.push(`(These are liquidity migration zones, NOT support/resistance — see system rules)`);
      for (const l of realTimeState.lt.levels) {
        const dir = l.distance > 0 ? 'above' : 'below';
        sections.push(`- LT-${l.fibLookback}: ${l.price.toFixed(2)} (${Math.abs(l.distance).toFixed(1)} pts ${dir})`);
      }
    }

    // LS sentiment
    if (realTimeState.ls) {
      sections.push(`\n## Liquidity Status: **${realTimeState.ls.sentiment}**`);
    }

    // Structural Levels Map
    if (realTimeState.structuralLevels && realTimeState.structuralLevels.length > 0) {
      const price = realTimeState.currentCandle.close;
      const aboveLevels = realTimeState.structuralLevels.filter(l => l.aboveBelow === 'above');
      const belowLevels = realTimeState.structuralLevels.filter(l => l.aboveBelow === 'below');

      sections.push(`\n## Structural Levels Map (sorted by price)`);
      sections.push(`Levels ABOVE current price (targets for longs, stops for shorts):`);
      for (const l of aboveLevels) {
        const confluence = l.ltConfluence ? '  [LT confluence]' : '';
        sections.push(`  ${l.price.toFixed(2)}  ${l.label}${confluence}`);
      }

      sections.push(`\n── Current Price: ${price.toFixed(2)} ──\n`);

      sections.push(`Levels BELOW current price (stops for longs, targets for shorts):`);
      for (const l of belowLevels) {
        const confluence = l.ltConfluence ? '  [LT confluence]' : '';
        sections.push(`  ${l.price.toFixed(2)}  ${l.label}${confluence}`);
      }

      if (realTimeState.swingRange) {
        sections.push(`\nSwing Range: ${realTimeState.swingRange.low.toFixed(2)} - ${realTimeState.swingRange.high.toFixed(2)} (${realTimeState.swingRange.range.toFixed(0)} pts)`);
      }
    }

    // Higher-Timeframe Swing Structure
    if (realTimeState.htfSwingStructure) {
      const htf = realTimeState.htfSwingStructure;
      const currentPrice = realTimeState.currentCandle.close;
      const positionPct = htf.swingRange > 0
        ? ((currentPrice - htf.swingLow) / htf.swingRange * 100).toFixed(1)
        : '?';

      sections.push(`\n## Higher-Timeframe Swing Structure (1h)`);
      sections.push(`- Swing High: ${htf.swingHigh.toFixed(2)} | Swing Low: ${htf.swingLow.toFixed(2)} | Range: ${htf.swingRange.toFixed(2)} pts`);
      sections.push(`- Current price at ${positionPct}% retracement of this swing`);
      sections.push(`- HTF Fib Levels:`);
      for (const fib of htf.fibLevels) {
        const dist = Math.abs(currentPrice - fib.price);
        const dir = currentPrice > fib.price ? 'above' : 'below';
        sections.push(`  ${(fib.ratio * 100).toFixed(1)}%: ${fib.price.toFixed(2)} (${dist.toFixed(1)} pts ${dir})`);
      }
    }

    // Key levels from bias
    if (bias.key_levels_to_watch && bias.key_levels_to_watch.length > 0) {
      sections.push(`\n## Your Key Levels`);
      for (const kl of bias.key_levels_to_watch) {
        sections.push(`- ${kl.price?.toFixed?.(2) || kl.price} (${kl.type}) → ${kl.action}`);
      }
    }

    return sections.join('\n');
  }

  // ── Reassessment prompts ─────────────────────────────────

  _reassessmentSystemPrompt() {
    return `You are reassessing your directional bias for ${this.ticker} based on the last 30 minutes of price action and objective liquidity data. Be willing to change your mind when the evidence warrants it.

Key principle: If LT migration shows improving liquidity (levels moving away from rising price), this is an objective bullish signal regardless of your current bias. If LT migration shows deteriorating liquidity (levels converging toward price), this warns of reversal risk. Give LT migration data significant weight.

Your response must be valid JSON matching this schema:
{
  "bias": "bullish" | "bearish" | "neutral",
  "conviction": 1-5,
  "key_levels_to_watch": [
    { "price": <number>, "type": "<description>", "action": "buy" | "sell" | "watch" }
  ],
  "reasoning": "<2-3 sentences>",
  "avoid_conditions": ["<string>"],
  "preferred_session_window": "<e.g. 13:00-15:00 ET>"
}

Rules:
- If price action and LT migration both contradict your current bias, flip it
- If only one signal contradicts, reduce conviction but maintain direction
- If bias has been wrong (recent stops hit), be more willing to reassess
- New conviction of 1-2 means you're basically neutral — let setups speak for themselves
- Be honest: if the morning proved your thesis wrong, say so

Respond ONLY with the JSON object. No markdown, no explanation outside JSON.`;
  }

  _reassessmentUserPrompt(windowSummary, currentBias, recentTrades) {
    const sections = [];

    sections.push(`# 30-Minute Bias Reassessment — ${windowSummary.fromTime} to ${windowSummary.toTime}`);

    // Current bias recap
    sections.push(`\n## Current Bias`);
    sections.push(`- Direction: ${currentBias.bias} (conviction: ${currentBias.conviction}/5)`);
    sections.push(`- Reasoning: ${currentBias.reasoning}`);

    // Window price action
    if (windowSummary.ohlcv) {
      const o = windowSummary.ohlcv;
      sections.push(`\n## 30-Min Price Action`);
      sections.push(`- Open: ${o.open.toFixed(2)} → Close: ${o.close.toFixed(2)} (${o.direction}, ${o.changePts > 0 ? '+' : ''}${o.changePts.toFixed(2)} pts)`);
      sections.push(`- High: ${o.high.toFixed(2)}, Low: ${o.low.toFixed(2)}, Range: ${o.range.toFixed(2)} pts`);
      sections.push(`- Volume: ${o.totalVolume} total, ${o.avgVolumePerCandle} avg/candle`);
    }

    // LT Migration — the key objective signal
    if (windowSummary.ltMigration) {
      const m = windowSummary.ltMigration;
      sections.push(`\n## LT Level Migration (OBJECTIVE SIGNAL)`);
      sections.push(`- Price: ${m.priceStart.toFixed(2)} → ${m.priceEnd.toFixed(2)} (${m.priceDirection}, ${m.priceDelta > 0 ? '+' : ''}${m.priceDelta.toFixed(2)} pts)`);
      sections.push(`- Overall liquidity signal: **${m.overallSignal.toUpperCase()}** (score: ${m.normalizedScore})`);
      sections.push(`- Short-term lookbacks (LT-34/55): ${m.shortTermTrend}`);
      sections.push(`- Long-term lookbacks (LT-377/610): ${m.longTermTrend}`);
      sections.push('');
      sections.push('| LT Lookback | Start | End | Delta | Direction | Crossed Price? |');
      sections.push('|-------------|-------|-----|-------|-----------|----------------|');
      for (const l of m.levels) {
        sections.push(`| ${l.fib} | ${l.startPrice.toFixed(2)} | ${l.endPrice.toFixed(2)} | ${l.delta > 0 ? '+' : ''}${l.delta.toFixed(2)} | ${l.direction} | ${l.crossedPrice ? 'YES' : 'no'} |`);
      }
    } else {
      sections.push(`\n## LT Level Migration: Not available`);
    }

    // GEX regime comparison
    if (windowSummary.gex) {
      const g = windowSummary.gex;
      sections.push(`\n## GEX Regime`);
      if (g.regimeChanged) {
        sections.push(`- REGIME CHANGE: ${g.startRegime} → ${g.endRegime}`);
      } else {
        sections.push(`- Regime: ${g.endRegime} (unchanged)`);
      }
      if (g.endGammaFlip) sections.push(`- Gamma Flip: ${g.endGammaFlip.toFixed(2)}`);
      if (g.endCallWall) sections.push(`- Call Wall: ${g.endCallWall.toFixed(2)}`);
      if (g.endPutWall) sections.push(`- Put Wall: ${g.endPutWall.toFixed(2)}`);
    }

    // IV movement
    if (windowSummary.iv) {
      const iv = windowSummary.iv;
      sections.push(`\n## IV Movement`);
      sections.push(`- ATM IV: ${(iv.startIV * 100).toFixed(1)}% → ${(iv.endIV * 100).toFixed(1)}% (${iv.trend})`);
      sections.push(`- Skew change: ${(iv.skewChange * 100).toFixed(2)}%`);
    }

    // Level interactions
    if (windowSummary.levelInteractions) {
      const li = windowSummary.levelInteractions;
      sections.push(`\n## Level Interactions`);
      if (li.tested.length > 0) {
        sections.push(`- Tested: ${li.tested.map(l => `${l.label} (${l.price.toFixed(2)})`).join(', ')}`);
      }
      if (li.held.length > 0) {
        sections.push(`- Held: ${li.held.map(l => `${l.label} (${l.price.toFixed(2)})`).join(', ')}`);
      }
      if (li.broke.length > 0) {
        sections.push(`- Broke: ${li.broke.map(l => `${l.label} (${l.price.toFixed(2)})`).join(', ')}`);
      }
      sections.push(`- Net direction: ${li.netDirection}`);
    }

    // Recent trade results
    if (recentTrades.length > 0) {
      sections.push(`\n## Recent Trade Results`);
      for (const t of recentTrades) {
        const entry = t.entry;
        const outcome = t.outcome;
        sections.push(`- ${entry.side.toUpperCase()} at ${entry.entry_price} → ${outcome.outcome.toUpperCase()} (${outcome.pnl > 0 ? '+' : ''}${outcome.pnl.toFixed(2)} pts)`);
      }
      const totalPnl = recentTrades.reduce((s, t) => s + t.outcome.pnl, 0);
      sections.push(`- Session P&L: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} pts`);
    }

    return sections.join('\n');
  }

  // ── Helpers ──────────────────────────────────────────────

  _fmt(val) {
    if (val == null) return 'N/A';
    return typeof val === 'number' ? val.toFixed(2) : String(val);
  }

  /**
   * Estimate prompt token count (rough: ~4 chars per token).
   */
  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }
}
