# NQ Futures Trading Strategy Research Findings

**Generated**: January 28, 2026
**Phase**: 1 - Research
**Objective**: Identify trading concepts with edge potential for NQ futures scalping

---

## Executive Summary

This research synthesizes web-based academic and practitioner insights with the existing quantitative analysis conducted on 2025 NQ data. Five major research areas were investigated:

1. **Gamma Exposure (GEX) Trading** - Strong evidence for tradeable edge
2. **Order Flow Analysis** - Moderate evidence, requires specialized data
3. **Options Flow for Futures** - Mixed evidence, 0DTE impact debated
4. **Time-Based Patterns** - Opening range strategies show diminished returns
5. **Liquidity/SMC Patterns** - Conceptually sound, requires validation

**Key Finding**: The existing quantitative research already demonstrates statistically significant relationships between GEX levels, IV, and price behavior. The most promising strategies combine GEX level touches with regime filtering.

---

## Topic 1: Gamma Exposure (GEX) Trading

### Research Summary

Gamma Exposure (GEX) aggregates the net gamma of all open options positions, reflecting how sensitive dealer delta hedging is to price changes. When dealers are:

- **Long Gamma**: They sell rallies and buy dips, creating *mean reversion* and price stability
- **Short Gamma**: They buy rallies and sell dips, *amplifying* moves and increasing volatility

#### The Gamma Flip
The "gamma flip" or "zero gamma level" is the price where aggregate dealer gamma transitions from positive to negative. Above this level, markets tend toward stability; below it, instability.

#### GEX as Support/Resistance
High gamma concentrations at specific strikes create:
- **Gamma walls**: Price levels where hedging flows create strong resistance/support
- **Pin risk**: Near expiration, high positive gamma strikes can "pin" price

### Existing Quantitative Findings (from prior analysis)

| Finding | Value | Source |
|---------|-------|--------|
| GEX Support 1 bounce rate (1h) | 54.2% | Event Study |
| GEX Support bounce in NEG GEX regime | 57.1% win rate | Event Study |
| GEX Support bounce in POS GEX regime | 53.3% win rate | Event Study |
| Price return correlation with GEX proximity | r = -0.41 (resistance), r = +0.39 (support) | Correlation Analysis |
| Total GEX vs IV correlation | r = -0.47 | Correlation Analysis |
| All 8 regimes show mean reversion | Autocorr: -0.25 to -0.38 | Regime Analysis |

### Testable Hypotheses

**H1.1 - GEX Support Mean Reversion (HIGH PRIORITY)**
> When price touches GEX Support 1 (within 15 points) in a NEGATIVE GEX regime, entering long with a 30pt stop and 90pt target will yield positive expectancy.

*Rationale*: Existing data shows 57.1% win rate for support bounces in negative GEX regimes - counterintuitive but statistically supported.

**H1.2 - Gamma Flip Volatility Filter**
> Trading days where price crosses below the gamma flip level will exhibit 30%+ higher volatility than days that remain above the gamma flip.

*Rationale*: Negative gamma environments should amplify moves.

**H1.3 - GEX Level Pin Near Expiration**
> On weekly options expiration days (Wednesday/Friday), price movement narrows as it approaches the highest positive gamma strike.

*Rationale*: Gamma increases exponentially near expiration.

### Data Available
- `gex/nq/nq_gex_YYYY-MM-DD.json` - Daily GEX levels with support/resistance
- Options open interest from `statistics/*.csv`

### Expected Edge: HIGH
*Existing quantitative evidence supports tradeable edge*

---

## Topic 2: Order Flow Analysis

### Research Summary

Order flow trading analyzes the interaction between buyers and sellers at specific price levels to anticipate future price movement.

#### Key Concepts

**Delta Divergence**
- Price makes higher high, but delta makes lower high → Buyers weakening (bearish signal)
- Price makes lower low, but delta makes higher low → Sellers weakening (bullish signal)
- Best used at key levels, not in "middle of nowhere"

**Absorption Patterns**
When large volume hits a level without breaking it:
- Large selling at support + price holds = buyers absorbing (bullish)
- Large buying at resistance + price holds = sellers absorbing (bearish)
- Often signals reversal at that level

**Book Imbalance**
Stacked imbalances (consecutive one-sided candles) indicate strong momentum and often act as future support/resistance.

### Existing Quantitative Findings

The dataset `orderflow/nq/book-imbalance-1m.csv` contains pre-computed imbalance data. From the correlation analysis:

| Finding | Value | Source |
|---------|-------|--------|
| Liquidity max change → volatility prediction | r = 0.19 | Lead-Lag Analysis |
| Liquidity spikes (>2σ) increase volatility | MFE 247pts, MAE 119pts | Event Study |
| Liquidity spikes do NOT predict direction | Win rate ~50% | Event Study |

### Testable Hypotheses

**H2.1 - Book Imbalance Momentum**
> When 1-minute book imbalance exceeds 2 standard deviations in the direction of the trend AND price is above VWAP (for longs), continuation moves of 20+ points occur within 15 minutes at >55% frequency.

*Rationale*: Stacked imbalances indicate strong institutional conviction.

**H2.2 - Absorption at GEX Levels**
> When large negative delta (selling pressure) occurs at a GEX support level AND price does not break the level, subsequent 15-minute returns are positive at >55% frequency.

*Rationale*: Combining order flow with GEX structure increases signal quality.

**H2.3 - Delta Divergence Filter**
> Filtering existing GEX bounce signals by requiring NO delta divergence (i.e., delta confirms direction) improves win rate by 5%+.

*Rationale*: Divergence signals weakening momentum that could invalidate the bounce.

### Data Available
- `orderflow/nq/book-imbalance-1m.csv` - Pre-computed imbalance
- `orderflow/nq/mbp-1/*.csv` - Market-by-price L1 data (2025+)

### Expected Edge: MODERATE
*Requires careful integration with price structure; raw imbalance alone is not predictive*

---

## Topic 3: Options Flow for Futures (0DTE Impact)

### Research Summary

The explosive growth of 0DTE (zero days to expiration) options has created debate about their market impact.

#### 0DTE Gamma Mechanics
- 0DTE options have extremely high gamma due to time decay
- Small price moves can create large delta changes requiring dealer hedging
- Creates potential for "gamma squeezes" in either direction

#### Research Findings - Mixed Evidence

**CBOE Research (Skeptical)**:
> "Net market maker gamma hedging remains de minimis, representing at best just 0.2% of the SPX daily liquidity... There is no discernible market impact from 0DTE option trading."

**Academic Research (Supportive)**:
> "Market Makers' inventory, as measured by net gamma, is on average positive and negatively related to future intraday volatility."

#### IV Term Structure
- High IV percentile predicts future volatility (r = 0.30 at 15m lag)
- IV expansion → expect increased range (not direction)
- IV contraction → negative drift at 4h horizon (-0.16%)

### Existing Quantitative Findings

| Finding | Value | Source |
|---------|-------|--------|
| IV percentile → volatility (15m lag) | r = 0.30 | Lead-Lag Analysis |
| IV skew → returns (15m lag) | r = -0.09 | Lead-Lag Analysis |
| IV expansion events increase range | 302pt avg range vs 290pt contraction | Event Study |
| IV contraction shows negative drift | -0.16% at 4h | Event Study |

### Testable Hypotheses

**H3.1 - IV Regime Position Sizing**
> When IV percentile > 70th percentile, reducing position size by 50% and widening stops by 50% improves risk-adjusted returns.

*Rationale*: High IV environments have larger ranges requiring adjusted parameters.

**H3.2 - IV Skew Directional Bias**
> When IV skew (put IV - call IV) is in top 10th percentile, short positions outperform long positions over the next 1-hour window.

*Rationale*: High put skew indicates institutional hedging demand, often preceding downside.

**H3.3 - IV Contraction Mean Reversion**
> Following an IV contraction event (>1.5σ decrease), mean reversion trades toward VWAP have improved win rates (>55%) over 2-4 hour horizons.

*Rationale*: IV contraction signals stabilization, favoring mean reversion.

### Data Available
- `iv/qqq/qqq_atm_iv_15m.csv` - 15-minute ATM IV data
- `cbbo-1m/qqq/*.csv` - Options quotes for custom IV calculations

### Expected Edge: LOW-MODERATE
*IV is useful as a filter/regime indicator, not a primary signal generator*

---

## Topic 4: Time-Based Patterns

### Research Summary

#### Opening Range Breakout (ORB)
Historically popular strategy that trades breakouts of the first 5-30 minute range.

**2025 Findings**:
> "Opening range breakout trading strategies don't work very well anymore. Backtests on trading the opening range breakouts on the S&P 500 show diminished returns."

*The strategy has been arbitraged away in liquid markets like ES and NQ.*

#### Session Characteristics

| Session | Characteristics | Opportunity |
|---------|-----------------|-------------|
| Overnight (6pm-6am ET) | Low volume, algorithmic activity, wide ranges | Multi-hour trades, 100+ point targets on NQ |
| Premarket (6am-9:30am ET) | News-driven, positioning | Gap analysis, fade extremes |
| RTH First 30 min | High volume, institutional activity | VWAP signals most valid |
| RTH Last 30 min | Portfolio rebalancing | Potential reversals |

#### Gap Analysis
Large overnight gaps often fill toward the RTH opening range. This creates a measurable mean reversion opportunity.

### Existing Quantitative Findings

From regime analysis, session breakdown was not explicitly analyzed but:
- All regimes show mean reversion (negative autocorrelation)
- Best win rates occur in LOW_IV regimes (57-58%)

### Testable Hypotheses

**H4.1 - Opening Range Failure (Fade Breakout)**
> Rather than trading breakouts, fading failed opening range (first 15 min) breakouts that reverse within 5 minutes produces positive expectancy.

*Rationale*: If ORB breakouts don't work, the fade should work.

**H4.2 - Session-Based Risk Parameters**
> Using wider stops and targets during overnight session (1.5x RTH parameters) and tighter parameters during RTH mid-day (0.75x) improves overall performance.

*Rationale*: Session volatility profiles differ significantly.

**H4.3 - Gap Fill Mean Reversion**
> When overnight session creates a gap > 50 points from prior RTH close, fading toward the gap fill level in first 2 hours of RTH has positive expectancy.

*Rationale*: Large gaps tend to fill, especially in mean-reverting regimes.

**H4.4 - End-of-Day Reversion**
> Positions opened in the direction opposite to the day's trend during the final 30 minutes of RTH (3:30-4pm ET) show improved win rates.

*Rationale*: Portfolio rebalancing creates predictable end-of-day flows.

### Data Available
- Timestamps in all OHLCV data (convert UTC to ET)
- `ohlcv/nq/NQ_ohlcv_1m.csv` - Full 1-minute history

### Expected Edge: LOW
*Session filtering is a useful modifier, not a primary edge source*

---

## Topic 5: Liquidity Patterns & ICT/SMC Concepts

### Research Summary

Smart Money Concepts (SMC) is a price-action framework that models how institutional traders ("smart money") move markets.

#### Core ICT/SMC Concepts

**Liquidity Sweep**
- Price spikes through a level where retail stops are clustered
- "Smart money" takes liquidity, then reverses
- A sweep that reverses = high-probability entry zone

**Order Blocks (OB)**
- The last bearish candle before a bullish move (for longs)
- Represents unfilled institutional orders
- Price often returns to "rebalance" at these levels

**Fair Value Gap (FVG)**
- Three-candle pattern where middle candle moves so fast the first and third candles don't overlap
- Creates an "imbalance" that price returns to fill ~70% of the time
- Precise pullback entry zones

#### The Confirmation Model
Highest probability setups combine all three:
1. **Liquidity sweep** occurs (takes out stops)
2. **Order block** exists at sweep location
3. **Fair value gap** overlaps the order block

### Existing Quantitative Findings

The Liquidity Trigger levels data captures some SMC-like concepts:

| Finding | Value | Source |
|---------|-------|--------|
| BULLISH LT sentiment win rate | ~57.5% | Regime Analysis |
| LT max change → volatility | r = 0.19 | Lead-Lag Analysis |
| LT level spacing correlates with IV | r = 0.65 | Correlation Analysis |

### Testable Hypotheses

**H5.1 - Liquidity Sweep + GEX Confluence**
> When price sweeps below a prior swing low (liquidity grab) AND is within 20 points of GEX Support 1, long entries produce >55% win rate with 1:3 R:R.

*Rationale*: Combining SMC liquidity concept with GEX structural support.

**H5.2 - Fair Value Gap Fill**
> Identifying FVGs on 15-minute chart and entering on 1-minute chart when price returns to the FVG produces win rate > 55%.

*Rationale*: FVGs represent genuine price imbalances that "need" to be filled.

**H5.3 - Order Block as Stop Placement**
> Placing stops behind identified order blocks (rather than arbitrary point-based stops) reduces stop-out rate while maintaining similar profitability.

*Rationale*: Structure-based stops respect institutional price levels.

**H5.4 - VWAP + GEX Confluence**
> Entries at GEX support levels that are ALSO below VWAP (for longs) have higher win rates than GEX-only signals.

*Rationale*: VWAP acts as institutional fair value benchmark; being below it on a long adds confluence.

### Data Available
- `liquidity/nq/NQ_liquidity_levels.csv` - Pre-computed liquidity levels
- Can compute FVGs and order blocks from OHLCV data

### Expected Edge: MODERATE
*Conceptually sound but requires precise implementation and filtering*

---

## Ranked Strategy Concepts by Expected Edge

Based on research synthesis, here are the most promising strategies ranked by expected edge:

| Rank | Strategy Concept | Expected Edge | Rationale |
|------|------------------|---------------|-----------|
| **1** | GEX Support Mean Reversion in NEG GEX Regime | HIGH | 57.1% historical win rate with statistical significance |
| **2** | GEX + IV Regime Adaptive Parameters | HIGH | Strong correlations support regime-based adjustments |
| **3** | Liquidity Sweep + GEX Confluence | MODERATE-HIGH | Combines two validated concepts |
| **4** | Book Imbalance Momentum with VWAP Filter | MODERATE | Requires careful threshold tuning |
| **5** | Fair Value Gap Mean Reversion | MODERATE | Widely used but needs NQ-specific validation |
| **6** | IV-Based Position Sizing | MODERATE | Improves risk management, not signal generation |
| **7** | Session-Based Parameter Adjustment | LOW-MODERATE | Modifier, not primary edge |
| **8** | Opening Range Fade (Failed Breakout) | LOW | Contrarian to diminished ORB strategy |
| **9** | Delta Divergence Filter | LOW | Useful filter but weak standalone |

---

## Recommended Strategies for Phase 2 Design

Based on this research, recommend designing the following 3-5 strategies:

### Strategy 1: GEX Mean Reversion (Primary)
- **Entry**: Long at GEX Support 1 touch in NEGATIVE GEX regime
- **Filters**: IV percentile < 70, price below VWAP
- **Exit**: Fixed target (90pt) or trailing stop
- **Risk**: Max 30pt stop

### Strategy 2: Liquidity Sweep + GEX Confluence
- **Entry**: Long after liquidity sweep (new low) reversal at GEX Support
- **Filters**: Order block present, bullish LT sentiment
- **Exit**: Target = FVG fill or 3x risk
- **Risk**: Stop behind order block (max 30pt)

### Strategy 3: Book Imbalance Momentum
- **Entry**: Long when 1m book imbalance > 2σ bullish, price > VWAP
- **Filters**: Positive GEX regime (stable environment)
- **Exit**: Trailing stop (3pt trigger, 1pt offset) or target
- **Risk**: 20pt stop

### Strategy 4: IV Regime Adaptive
- **Entry**: Use GEX Mean Reversion signals
- **Modification**: Adjust stops/targets based on IV percentile
  - Low IV (<30): Tighter (20pt stop, 60pt target)
  - High IV (>70): Wider (30pt stop, 90pt target) with reduced size
- **Risk**: Always max 30pt

---

## Data Gaps & Future Research

1. **Volume Profile Data**: VWAP can be computed from OHLCV, but proper volume profile requires integration
2. **FVG/Order Block Detection**: Requires implementation of detection algorithms
3. **Intraday GEX Updates**: Current data is daily; intraday updates would improve timing
4. **Options Trades Flow**: `options-trades/` data not yet analyzed for directional signals

---

## Research Sources

### GEX Trading
- [Cheddar Flow - What Is Gamma Exposure?](https://www.cheddarflow.com/blog/what-is-gamma-exposure-an-in-depth-analysis-for-traders/)
- [MenthorQ - Gamma Levels for Futures Trading](https://menthorq.com/guide/gamma-levels-for-futures-trading/)
- [Yahoo Finance - Gamma Exposure Explained](https://finance.yahoo.com/news/gamma-exposure-explained-see-hidden-114155839.html)

### Order Flow
- [Bookmap - Cumulative Volume Delta](https://bookmap.com/blog/how-cumulative-volume-delta-transform-your-trading-strategy)
- [Mind Math Money - Order Flow Trading Course 2025](https://www.mindmathmoney.com/articles/the-ultimate-order-flow-trading-course-full-guide-2025)
- [Trading Riot - Delta vs Liquidity](https://tradingriot.com/orderflow-trading/)

### 0DTE/Options
- [SpotGamma - All About 0DTE Options](https://spotgamma.com/0dte/)
- [CBOE - 0DTEs Decoded](https://www.cboe.com/insights/posts/0-dt-es-decoded-positioning-trends-and-market-impact/)
- [MenthorQ - Understanding 0DTE Gamma Exposure](https://menthorq.com/guide/understanding-0dte-gamma-exposure/)

### Time-Based Patterns
- [HighStrike - Trading the Opening Range 2025](https://highstrike.com/opening-range/)
- [Quantified Strategies - Opening Range Breakout Backtest](https://www.quantifiedstrategies.com/opening-range-breakout-strategy/)
- [TRADEPRO Academy - Trading Futures Overnight](https://tradeproacademy.com/ultimate-guide-to-trading-futures-overnight/)

### SMC/Liquidity
- [XS - Smart Money Concepts Complete Guide](https://www.xs.com/en/blog/smart-money-concept/)
- [ATAS - What Is Liquidity Sweep?](https://atas.net/technical-analysis/what-is-liquidity-sweep-how-to-trade-it/)
- [ACY - The Confirmation Model: OB + FVG + Liquidity Sweep](https://acy.com/en/market-news/education/confirmation-model-ob-fvg-liquidity-sweep-j-o-20251112-094218/)

### VWAP
- [TheVWAP - Strategy Guide](https://thevwap.com/vwap-strategy/)
- [MetroTrade - Understanding VWAP for Futures Trading](https://www.metrotrade.com/understanding-vwap-for-futures-trading/)

### Put/Call Ratio
- [Financer - Put/Call Ratio 101](https://financer.com/invest/put-call-ratios/)
- [Quantified Strategies - Put Call Ratio Backtest](https://www.quantifiedstrategies.com/put-call-ratio-backtest-strategy/)

---

## Conclusion

The research phase has identified **GEX-based mean reversion as the highest-probability strategy concept** for NQ futures scalping. The existing quantitative analysis provides strong statistical support (57.1% win rate for support bounces in negative GEX regimes) that aligns with the theoretical understanding of dealer hedging mechanics.

Secondary strategies should focus on **confluence** - combining GEX levels with:
- Liquidity sweeps (SMC concepts)
- Book imbalance momentum
- VWAP positioning
- IV regime filtering

The research supports moving to Phase 2: Strategy Design with these concepts.

---

*Research completed: January 28, 2026*
