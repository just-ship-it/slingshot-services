# JV Trading ICT Strategy Reference

> Source: "Unlock the Market" eBook by Jordan Vera (JV Trading)
> Purpose: Comprehensive reference for strategy implementation and backtesting in Slingshot
> Created: 2026-02-21

---

## Table of Contents

1. [Strategy Overview](#strategy-overview)
2. [Lesson 1: PDH/PDL (Previous Day High/Low)](#lesson-1-pdhpdl)
3. [Lesson 2: Identifying the Range](#lesson-2-identifying-the-range)
4. [Lesson 3: Highs & Lows](#lesson-3-highs--lows)
5. [Lesson 4: Change of Character (CHoCH)](#lesson-4-change-of-character-choch)
6. [Lesson 5: Market Structure Shift (MSS)](#lesson-5-market-structure-shift-mss)
7. [Lesson 6: Order Blocks (OB)](#lesson-6-order-blocks-ob)
8. [Lesson 7: Imbalance (IMB)](#lesson-7-imbalance-imb)
9. [Lesson 8: Fibonacci Tool](#lesson-8-fibonacci-tool)
10. [Lesson 9: M & W Patterns (Buy to Sell / Sell to Buy)](#lesson-9-m--w-patterns)
11. [Lesson 10: Momentum Trades](#lesson-10-momentum-trades)
12. [Lesson 11: Opens (Daily, Weekly, Monthly)](#lesson-11-opens)
13. [Lesson 12: Outside & Inside Bars](#lesson-12-outside--inside-bars)
14. [Mastery Add-Ons (Trading Rules)](#mastery-add-ons)
15. [Concept Relationships & Confluence Model](#concept-relationships)
16. [Implementation Notes for Slingshot](#implementation-notes)

---

## Strategy Overview

This is an ICT (Inner Circle Trader) style price action methodology built around **12 core concepts** that work together as a confluence-based trading system. The strategy is designed for futures trading (particularly NQ/ES) and emphasizes:

- **Liquidity-driven price action** (smart money concepts)
- **Multi-timeframe analysis** (higher TF for bias, lower TF for entries)
- **Confluence-based entries** (multiple concepts aligning at the same zone)
- **Strict risk management** (0.5%-1% per trade, no revenge trading)

The 12 concepts build on each other in a specific learning path and are designed to be used together, not in isolation. The core trade models (M and W patterns in Lesson 9) synthesize ALL prior concepts into complete trade setups.

---

## Lesson 1: PDH/PDL

**Previous Day High / Previous Day Low**

### Definition
- **PDH**: The high of the previous trading day
- **PDL**: The low of the previous trading day

### Key Properties
- Act as **key liquidity levels** where stop losses cluster
- Price often **reacts** at these levels -- either rejecting (bouncing) or sweeping through (liquidity grab)
- Serve as **magnets** that attract price and **reversal zones** where direction changes
- Act as **confluence for continuation** when combined with other concepts

### Trading Rules
- Mark PDH and PDL at the start of each trading day
- Watch for price to **wick off** these levels (not fully break and close through)
- A wick through PDH/PDL followed by rejection = potential liquidity sweep/reversal
- A clean break and close through = potential continuation

### Implementation Notes
- Simple to compute: just track the previous day's high and low from OHLCV data
- Use daily candle data or aggregate from intraday (max high, min low of prior session)
- These are the foundation-level "liquidity pools" that the rest of the strategy builds on

---

## Lesson 2: Identifying the Range

### Definition
A **range** is a consolidation zone defined by a clear high (resistance) and low (support) on the **4HR or Daily** timeframe. Price is "trapped" between these levels before expanding.

### Key Properties
- Use **higher timeframes** (4HR or Daily) to identify -- NQ has larger ranges due to volatility
- The range defines the boundaries that **must break** to signal direction
- Range = consolidation; breakout = expansion
- Stay OUT of choppy range-bound trading

### Trading Process (6 Steps)
1. **Identify the High and Low** of the range on 4HR/Daily
2. **Wait for the range to break** -- price closes beyond one boundary
3. **Note the "Next Low/High"** outside the range -- this becomes the target
4. **Look for Order Blocks and Imbalances** created during the break
5. **Wait for retest** of the OB/IMB zone (this is where you enter)
6. **Target the External Break level** -- the next significant high/low beyond the range

### Trading Rules
- **Wait for clean breaks** -- don't trade inside the range
- The break creates OBs and IMBs that become your entry zones on the retest
- Weekly Open can serve as extra confluence when it aligns with OB/IMB zones
- This is described as an "A+ setup" when all elements align

### Implementation Notes
- Range detection requires identifying swing highs/lows on 4HR/Daily charts
- Track when price breaks and closes beyond range boundaries
- After break, identify OB and IMB zones for entry on retest
- Can be combined with candle aggregation (aggregate 1m candles to 4HR/Daily)

---

## Lesson 3: Highs & Lows

### Definitions

**Structural Highs (Marking Highs):**
- A **High** is identified as the **last up-move that pushed price down** (the swing high before a downward move)
- It's the candle/area that preceded the selling pressure

**Structural Lows (Marking Lows):**
- A **Low** is identified as the **last down-move that caused a break to the upside** (the swing low before an upward move)
- It's the candle/area that preceded the buying pressure

### Both in Play (Dynamic Updates)
- When a **Low breaks**: market shifts bearish; the **new high** becomes the last high that caused the breakdown
- When a **High breaks**: market shifts bullish; the **new low** becomes the last low that caused the breakup
- Highs and Lows are **constantly updated** as structure develops

### Key Relationships
- Breaking a High = bullish structure shift (new low is set)
- Breaking a Low = bearish structure shift (new high is set)
- These structural levels are the foundation for CHoCH and MSS detection

### Implementation Notes
- Requires swing detection algorithm (identify pivot highs/lows)
- Track the "causal" swing -- the last opposing swing before a structural break
- State machine: track current High, current Low, and update when either breaks
- This is essentially **swing point detection with causality tracking**

---

## Lesson 4: Change of Character (CHoCH)

### Definition
A **Change of Character** is the **first sign** that the previous trend is potentially reversing. It signals a change in price delivery -- flipping from bullish to bearish or vice versa.

### Detection Rules

**Bearish CHoCH (Shift Down):**
- In an uptrend, the **low that caused the most recent new high** gets broken
- This low was the launch point for the last bullish push
- When price breaks below it, it's the first warning of bearish reversal

**Bullish CHoCH (Shift Up):**
- In a downtrend, the **high that caused the most recent new low** gets broken
- This high was the launch point for the last bearish push
- When price breaks above it, it's the first warning of bullish reversal

### Key Properties
- CHoCH is the **first clue** -- not confirmation, but an early warning
- It precedes Market Structure Shift (MSS)
- CHoCH alone is NOT a trade entry -- it alerts you to watch for MSS and OBs

### Implementation Notes
- Depends on Lesson 3 (Highs & Lows tracking)
- Detect when the "causal" swing level from the prior trend gets broken
- Boolean flag: `choch_detected = true` when the opposing causal swing breaks
- Must track direction: was the prior trend bullish or bearish?

---

## Lesson 5: Market Structure Shift (MSS)

### Definition
A **Market Structure Shift** happens AFTER a CHoCH. It **confirms** that the trend has actually changed direction. The key additional requirement vs CHoCH: **the candle must close beyond the level** (not just wick through).

### Detection Rules

**Bullish MSS (Shift Up):**
- After a CHoCH to the upside
- The **previous high** gets broken AND **candle closes above it**
- Confirms uptrend continuation/establishment

**Bearish MSS (Shift Down):**
- After a CHoCH to the downside
- The **previous low** gets broken AND **candle closes below it**
- Confirms downtrend continuation/establishment

### Key Distinction: CHoCH vs MSS
| Feature | CHoCH | MSS |
|---------|-------|-----|
| Role | Early warning | Confirmation |
| Requirement | Break of causal swing | Break + candle CLOSE beyond level |
| Action | Alert/prepare | Look for entry |
| Sequence | Comes first | Comes after CHoCH |

### Implementation Notes
- MSS requires checking candle **close** (not just high/low touching the level)
- `mss_confirmed = true` when candle.close > previous_high (bullish) or candle.close < previous_low (bearish)
- This is where Order Blocks typically form -- right after the MSS break

---

## Lesson 6: Order Blocks (OB)

### Definition
An **Order Block** is the candle immediately before a strong impulsive move (Break in Structure). It represents the zone where institutional orders were placed that caused the move.

### Detection Rules

**Bearish Order Block:**
1. A Break in Structure occurs to the **downside** (Shift Down)
2. The **last up-candle before the break** = the Order Block
3. This zone (the body of that candle, or its full range) is marked
4. Price often **retests** this zone before continuing lower

**Bullish Order Block:**
1. A Break in Structure occurs to the **upside** (Shift Up)
2. The **last down-candle before the break** = the Order Block
3. This zone is marked
4. Price often **retests** this zone before continuing higher

### Trading Process
1. Identify the Break in Structure (using Lesson 3/5)
2. Mark the candle BEFORE the impulsive move as the OB
3. Wait for price to return to the OB zone
4. Enter on the retest with stop loss beyond the OB

### Key Properties
- OBs form right after a Break in Structure "most of the time"
- The strong buying/selling creates Imbalances (IMB) alongside the OB
- OB = the origin of the move; price returns to it before continuing
- OBs are where you **execute trades** (entry zones)

### Implementation Notes
- After detecting MSS/BoS, look back to find the last opposing candle
- Bearish OB: last bullish candle before a bearish BoS -- zone = [candle.low, candle.high] (or body: [candle.open, candle.close])
- Bullish OB: last bearish candle before a bullish BoS -- zone = [candle.low, candle.high]
- Track OB zones as potential entry areas; trigger when price returns to them

---

## Lesson 7: Imbalance (IMB)

### Definition
An **Imbalance** (also called Fair Value Gap / FVG) is a price area where buying and selling were **not equal** -- caused by a strong, fast move. It creates a **gap between wicks** of surrounding candles.

### Detection
- Three consecutive candles where the wick of candle 1 does not overlap with the wick of candle 3
- The gap between candle 1's wick and candle 3's wick = the imbalance zone
- Bearish IMB: gap forms during a strong downward move
- Bullish IMB: gap forms during a strong upward move

### Key Properties
- Imbalances get **revisited** -- price often returns to fill them or reject at them
- "If it left fast, it'll come back slow"
- IMBs serve as **confluence zones** -- when an IMB aligns with an OB, it's a stronger entry
- A filled imbalance (price returns and fills the gap) can then act as a rejection zone

### Trading Rules
- IMBs are NOT standalone entries -- they add confluence
- Best used when they overlap with OBs and align with structure shift direction
- Price filling an IMB before continuing = sign of "clean delivery" (see Lesson 10)

### Implementation Notes
- Three-candle pattern detection:
  - Bearish IMB: `candle[i-1].low > candle[i+1].high` (gap between them)
  - Bullish IMB: `candle[i-1].high < candle[i+1].low` (gap between them)
- The IMB zone = the gap area
- Track active IMBs and mark them as filled when price returns

---

## Lesson 8: Fibonacci Tool

### Definition
Fibonacci retracements are used to find **retest zones after structure shifts**. They identify where price might pull back before continuing the new trend.

### How to Draw
- **Bullish (Shift Up)**: Draw fib from **low to high** (candle body to candle body, NOT wicks)
- **Bearish (Shift Down)**: Draw fib from **high to low** (candle body to candle body, NOT wicks)

### Key Levels
| Level | Zone Name | Quality |
|-------|-----------|---------|
| 79.00% | Premium | Deepest retracement -- best R:R but less frequent |
| 70.50% | Optimal | Sweet spot -- the ideal entry zone |
| 62.00% | - | Standard retracement level |
| 50.00% | Discount | Shallowest meaningful retracement |

### Trading Rules
- After a structure shift (MSS), draw fibs on the impulsive move
- Wait for price to retrace into the 50%-79% zone
- The deeper the retracement (toward 79%), the better the risk:reward
- "Wait for retest or regret the fill"
- Left chart example: bullish shift, tapped discount (50%), went higher
- Right chart example: bearish shift, tapped optimal (70.5%), went lower

### Implementation Notes
- Compute fib levels from the swing that created the MSS:
  - `fib_level = swing_start + (swing_end - swing_start) * percentage`
- Use candle BODIES (open/close), not wicks, for the anchor points
- Key retracement zone: 50% - 79% of the impulsive move
- Best confluence: fib zone overlapping with OB and/or IMB

---

## Lesson 9: M & W Patterns

This is the **core trade model** that synthesizes ALL prior concepts into complete setups.

> **Important**: M/W patterns are the most complete expression of the model, but they are **not the only valid setups**. The individual concepts (OB retests, IMB fills, momentum continuation, PDH/PDL sweeps, range breakouts, etc.) all produce tradeable setups on their own and across multiple timeframes. Our Slingshot strategies should leverage the **entire model** -- detecting structure, confluence zones, and trade opportunities wherever they appear in the concept hierarchy, not just when a full M or W formation completes. A CHoCH + OB retest at a key level with IMB confluence is a valid trade even without the full M/W shape. Think of the model as a toolkit, not a single pattern.

### M Pattern (Buy to Sell) -- Bearish Setup

**Shape**: Price forms a letter "M" on the chart -- two peaks with a valley between them.

**Sequence:**
1. **Previous High** is marked (existing resistance)
2. **Structure Shifted Bullish** -- price breaks above the high (this is a **liquidity sweep**)
3. **New Low** forms -- the low that caused the shift up
4. **Structure Shifts Bearish** -- the new low breaks, confirming bearish reversal
5. **New High** is identified -- this is where your **stop loss goes** (just above)
6. Price **taps into the Imbalance/OB zone** -- **THIS IS WHERE YOU SELL**
7. Price continues lower -- take profit

**Entry**: At the OB/IMB zone on the retest after the bearish structure shift
**Stop Loss**: Above the new high that caused the shift down
**Target**: Below the previous low / next liquidity level

**Confluence checklist for M setup:**
- [ ] Liquidity swept (previous high broken then rejected)
- [ ] Structure shift to downside confirmed (MSS)
- [ ] Order Block identified
- [ ] Imbalance present
- [ ] PDH/PDL alignment
- [ ] Fib retracement into 50-79% zone

### W Pattern (Sell to Buy) -- Bullish Setup

**Shape**: Price forms a letter "W" on the chart -- two valleys with a peak between them.

**Sequence:**
1. **Previous Low** is marked (existing support)
2. **Structure Shifted Bearish** -- price breaks below the low (this is a **liquidity sweep**)
3. **New High** forms -- the high that caused the shift down
4. **Structure Shifts Bullish** -- the new high breaks, confirming bullish reversal
5. **New Low** is identified -- this is where your **stop loss goes** (just below)
6. Price **taps into the Imbalance/OB zone** -- **THIS IS WHERE YOU BUY**
7. Price continues higher -- take profit

**Entry**: At the OB/IMB zone on the retest after the bullish structure shift
**Stop Loss**: Below the new low that caused the shift up
**Target**: Above the previous high / next liquidity level

**Confluence checklist for W setup:**
- [ ] Liquidity swept (previous low broken then rejected)
- [ ] Structure shift to upside confirmed (MSS)
- [ ] Order Block identified
- [ ] Imbalance present
- [ ] PDH/PDL alignment
- [ ] Fib retracement into 50-79% zone

### Implementation Notes
- M/W detection is the synthesis of Lessons 1-8
- State machine:
  1. Detect liquidity sweep at previous H/L
  2. Detect CHoCH
  3. Detect MSS (close confirmation)
  4. Identify OB and IMB from the structure break
  5. Wait for price to return to OB/IMB zone
  6. Execute entry with stop beyond the causal swing

---

## Lesson 10: Momentum Trades

### Definition
A **Momentum Trade** occurs when price makes a strong directional push AFTER clearing (filling) an imbalance. The filled IMB confirms "clean delivery" -- no unfilled orders remain to pull price back.

### Momentum Down
1. Price **fills a bearish imbalance** (returns to it and rejects)
2. The **low breaks** after the fill
3. **Strong push downward** -- continuation trade

### Momentum Up
1. Price **fills a bullish imbalance** (returns to it and bounces)
2. The **high breaks** after the fill
3. **Strong push upward** -- continuation trade

### Key Properties
- The imbalance fill is the **prerequisite** -- it shows price has cleared its business
- "Clean delivery" = no orders left unfilled, so price can move freely
- Momentum trades happen AFTER the retest, not on the initial move
- These are **continuation trades**, not reversals

### Implementation Notes
- Track IMBs and detect when they get filled (price returns to the zone)
- After fill + rejection, watch for a break of the recent high/low
- If the break occurs, this is a momentum entry
- More aggressive than the M/W model (less waiting for full pattern)

---

## Lesson 11: Opens

### Daily Open
- The **opening price** of the current trading day
- Acts as dynamic **support** (when price is above) or **resistance** (when price is below)
- Helps establish **intraday bias**: above open = bullish lean, below open = bearish lean

### Weekly Open
- Where the market opened for the current week
- **Stronger** level than daily open due to higher timeframe significance
- Acts as support/resistance and a **magnet** for price

### Monthly Open
- Where the market opened for the current month
- **Strongest** open level -- aligns with major reversals and continuation plays
- Above monthly open = bullish control; below = bearish control

### Yearly Open
- Where the market opened for the current year
- Highest timeframe reference -- strongest magnet/reaction level

### Trading Rules
- When price is above an open level, expect it to act as support
- When price is below an open level, expect it to act as resistance
- Opens serve as **confluence** for OB/IMB entries
- Multiple opens aligning at the same zone = very high conviction
- "Where the day begins, bias is born"

### Implementation Notes
- Trivial to compute from OHLCV data:
  - Daily open = first candle's open of the session
  - Weekly open = Sunday/Monday session first candle's open
  - Monthly open = first trading day of month's open
- Track all three as horizontal levels
- Use as additional confluence filter for M/W entries

---

## Lesson 12: Outside & Inside Bars

### Outside Bar
- A candle that goes **above AND below** the previous day's high and low (PDH/PDL)
- Breaks both ends of the prior range
- Indicates **high volatility** and potential manipulation/trapping before a big move
- Viewed on **Daily, Weekly, Monthly** timeframes

### Inside Bar
- A candle that stays **within** the previous day's high and low (PDH/PDL)
- Does NOT break either PDH or PDL
- Indicates **compression/consolidation** -- building energy for a breakout
- Strong signal of **continuation** in the current direction
- Can have "double inside bars" (multiple consecutive inside bars)

### Trading Rules
- **Outside Bars**: Be cautious -- the market is trapping both sides; wait for the dust to settle before trading
- **Inside Bars**: Look for breakout in the direction of the prevailing trend; the compression suggests continuation
- Both are best identified on D, W, M timeframes

### Implementation Notes
- Outside Bar: `candle.high > PDH && candle.low < PDL`
- Inside Bar: `candle.high < PDH && candle.low > PDL`
- Use as a filter/confirmation, not standalone entry
- Inside bar breakouts can be powerful continuation entries

---

## Mastery Add-Ons

These are 10 additional trading rules/principles from the eBook:

### 1. Timeframes
- **Entry TFs**: 5min, 15min, 30min (fast execution)
- **Structure TFs**: 1HR, 4HR (intraday structure/control)
- **Bias TFs**: Daily, Weekly, Monthly (direction/bias)
- **Rule**: Always align lower TF trades with higher TF structure

### 2. Stop Loss
- Always use a stop loss that respects the **candle close**, not just the wick
- You should only be stopped out if the candle **closes** above/below your key level
- Wicks are noise; closes show real breaks

### 3. Wicks vs Close
- Wicks can take your stop without changing real direction
- **Candle closes confirm** if a level truly broke
- Trust the close over the wick

### 4. Risk
- **0.5% to 1%** per trade maximum
- Small risk keeps you alive during drawdowns
- Protect capital first -- profits come second

### 5. Losing Streak
- If you hit a losing streak, **stop trading**
- Step away, review what went wrong
- Protect mental capital as much as trading capital

### 6. Alerts
- Set alerts at key levels (OBs, IMBs, PDH/PDL)
- Let price come to you -- don't chase
- Prevents overtrading in choppy markets

### 7. Pairs / Correlation
- Watch NQ with ES, QQQ, and SPY
- If correlated instruments move together, the setup is stronger
- If they diverge, be cautious

### 8. News
- Wait for news to release BEFORE taking trades
- News causes fake breakouts and fast spikes
- Trade the real direction AFTER the move settles

### 9. Chart Cleanliness
- Keep chart clean -- minimal indicators
- Only mark: structure, key levels, and liquidity zones
- Extra indicators create noise and hesitation

### 10. Psychology
- Don't revenge trade after a loss
- One trade doesn't define your future
- Stay calm, stay focused, there's always another setup tomorrow

---

## Concept Relationships

The 12 lessons form a **dependency chain** for the complete trade model:

```
PDH/PDL (1) ─────────────────────────────────────────────┐
                                                          │
Range (2) ──── identifies consolidation boundaries        │
                                                          │
Highs & Lows (3) ──── tracks structural swing points      │
        │                                                 │
        v                                                 │
CHoCH (4) ──── first warning of trend change              │
        │                                                 │
        v                                                 │
MSS (5) ──── confirms trend change (close-based)          │
        │                                                 │  All feed into
        ├──> Order Blocks (6) ──── entry zone             │  M/W Pattern (9)
        │                                                 │  = COMPLETE TRADE
        ├──> Imbalance (7) ──── confluence zone           │
        │                                                 │
        └──> Fibs (8) ──── retest depth measurement       │
                                                          │
Opens (11) ────── directional bias + confluence ──────────┤
                                                          │
OS/IS Bars (12) ── volatility/compression filter ─────────┤
                                                          │
Momentum (10) ──── continuation after IMB fill ───────────┘
```

### The Complete Trade Checklist (A+ Setup)
1. Higher TF bias established (Daily/Weekly structure + Opens)
2. PDH/PDL marked as liquidity targets
3. Liquidity sweep occurs at PDH or PDL
4. CHoCH detected (first warning)
5. MSS confirmed (candle close beyond key level)
6. Order Block identified (last opposing candle before the break)
7. Imbalance present (gap in the impulsive move)
8. Fib retracement into 50-79% zone overlaps with OB/IMB
9. Entry at OB/IMB zone on retest
10. Stop loss beyond the causal swing (the new high/low from the M/W)
11. Target: next liquidity level (external high/low)

---

## Implementation Notes

### Detection Algorithm Pseudocode

```
// State tracking
let currentHigh = null;   // Lesson 3
let currentLow = null;    // Lesson 3
let trend = null;         // 'bullish' | 'bearish'
let chochDetected = false; // Lesson 4
let mssConfirmed = false;  // Lesson 5
let activeOBs = [];       // Lesson 6
let activeIMBs = [];      // Lesson 7
let pdh, pdl;             // Lesson 1
let dailyOpen, weeklyOpen, monthlyOpen; // Lesson 11

// On each candle:
function processCandle(candle) {
    // 1. Update PDH/PDL at session start
    // 2. Update Opens at period boundaries
    // 3. Detect swing highs/lows (Lesson 3)
    // 4. Check for structural breaks:
    //    - If low breaks: check if CHoCH or MSS
    //    - If high breaks: check if CHoCH or MSS
    // 5. On MSS: identify OB (last opposing candle)
    // 6. Detect IMBs (3-candle gap pattern)
    // 7. Check if price returned to OB/IMB zone
    // 8. If in zone + all confluences align = SIGNAL
}
```

### Key Data Requirements
- **OHLCV**: 1-minute candles for entry, aggregated to 4HR/Daily for structure
- **Session data**: RTH open times for Daily Open calculation
- **Calendar data**: Week/month boundaries for Weekly/Monthly Opens
- **PDH/PDL**: Prior day high/low (pre-computed or tracked)

### Mapping to Existing Slingshot Infrastructure
- **Candle aggregation**: Use `shared/utils/candle-aggregator.js` for multi-TF
- **Strategy base**: Extend `shared/strategies/base-strategy.js`
- **Signal format**: Use existing `trade.signal` channel format
- **Backtest engine**: Can test with `backtest-engine/` using NQ/ES 1m data
- **GEX overlay**: GEX levels can serve as additional confluence for the OB/IMB zones

### Timeframe Mapping for NQ
| Analysis Level | Timeframe | Purpose |
|---------------|-----------|---------|
| Bias | Daily, Weekly | Determine bullish/bearish lean |
| Structure | 4HR, 1HR | Identify ranges, H/L, CHoCH, MSS |
| Entry | 15min, 5min | Find OB/IMB, execute M/W pattern |
| Precision | 1min | Fine-tune entry and stop placement |

### Risk Parameters (from eBook)
- Risk per trade: 0.5% - 1% of account
- Stop loss: Beyond the causal swing (new high for shorts, new low for longs)
- Stop must respect candle CLOSE, not just wick
- Target: Next external liquidity level (next swing high/low beyond the range)
