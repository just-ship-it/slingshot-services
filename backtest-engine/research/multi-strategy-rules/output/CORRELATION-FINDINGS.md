# first-in-wins Correlation Findings & Smart Filters

Companion to SUMMARY.md. Re-runnable via `node research/multi-strategy-rules/06-correlation-analysis.js`.

**Baseline being analyzed:** Model B `first-in-wins`. 1473 trades / WR 39.0% / PF 1.49 / Sharpe 5.79 / **DD 11.19% ($16,739)** / **$289,540** PnL.

## 1. Where the losses live

### 1.1 The instant stop-out cluster

**376 trades** (25.5% of all) exit in under 5 minutes. They account for **-$107k of net losses** (WR 11.4%, PF 0.39). This is the single biggest leak in the portfolio.

Origin breakdown:

| Origin | Instant stops | WR | Net PnL |
|---|---:|---:|---:|
| gex-level-fade | 264 | 4.5% | **-$72,953** |
| gex-lt-3m | 102 | 25.5% | -$28,755 |
| gex-flip-ivpct | 10 | 50.0% | -$5,000 |

**70% of instant stops come from gex-level-fade.** Hour breakdown for level-fade instant stops:

- 09:00 ET: 167 trades / -$39,935
- 10:00 ET: 97 trades / -$33,018
- 11:00 ET: <1 trade

Level-fade's gold-standard config uses `--glf-entry-window 09:00-10:30` — so all of its entries happen in this window. About half of them are instant rejects.

### 1.2 By-duration win rate (proof that fast = bad)

| Duration | n | WR | PF | totalPnL |
|---|---:|---:|---:|---:|
| 0-5 min | 376 | 11.4% | 0.39 | **-$106,708** |
| 5-15 min | 284 | 27.8% | 0.94 | -$8,580 |
| 15-60 min | 449 | 45.2% | 1.79 | +$150,118 |
| 1-4 hr | 335 | 67.2% | 3.62 | +$192,129 |
| 4-24 hr | 29 | 82.8% | 11.23 | +$62,582 |

Trades that survive past 15 minutes are dramatically more likely to win and to win bigger. **A live time-stop at 5-15 minutes** (exit if not in profit) would cap the left tail but needs engine support to test honestly.

## 2. Other univariate signals

### 2.1 By hour of entry (ET)

- **05 ET**: 13 trades, WR 84.6%, PF 7.37, avg +$1,207 — tiny sample but exceptional
- **04 ET**: 52 trades, WR 65.4%, PF 2.47 — strong pre-market
- **08 ET**: 72 trades, WR 52.8%, PF 1.87
- **09 ET**: 513 trades (biggest hour), WR 29.4%, PF 1.57 — high volume, mediocre WR
- **10 ET**: 325 trades, WR 32.3%, PF 1.45
- **11-12 ET**: WR drops to 44-45% with PF ~1.15
- **14-15 ET**: WR 49-50%, modest PF (~1.3-1.5)
- **13 ET**: 1 trade (lunch hour deserter)

The 09-10 ET hours are the volume center but the worst-performing per-trade. They're not catastrophic, just diluted.

### 2.2 By origin strategy

| Origin | n | WR | PF | avgPnL | totalPnL |
|---|---:|---:|---:|---:|---:|
| gex-flip-ivpct | 147 | 66.7% | 2.71 | $651 | $95,702 |
| gex-lt-3m | 760 | 46.6% | 1.35 | $166 | $126,060 |
| gex-level-fade | 566 | 21.6% | 1.39 | $120 | $67,778 |

gex-flip-ivpct wins per-trade by a wide margin but takes the slot relatively rarely. gex-lt-3m drives the bulk of PnL through volume.

### 2.3 By day of week

Fridays (5) are weakest: WR 33.2%, PF 1.09, only $11k from 295 trades. Wednesdays (3) are best: WR 44.3%, PF 1.91. Marginal effect; not strong enough to filter on alone.

### 2.4 By previous trade outcome / streaks

**No meaningful effect.** WR after a loss (38.6%) ≈ WR after a win (39.6%). Streak-of-3-losses WR 35.5% vs streak-of-3-wins 38.2% — within noise. The trades are essentially independent — past outcome doesn't predict next outcome.

This is actually good news: it means the strategy doesn't have a momentum bias that needs filtering.

## 3. The "rejection-during-hold" finding (retroactive but illustrative)

While first-in-wins holds a position, other strategies emit signals that get rejected. Count those rejections per trade.

**Same-side rejections** (other strategy agreed but got blocked):

| Same-side rejections | n | WR | PF | avgPnL |
|---:|---:|---:|---:|---:|
| 0 | 1311 | 35.6% | 1.23 | $97 |
| 1 | 118 | **63.6%** | **4.40** | **$882** |
| 2-3 | 44 | **72.7%** | **6.18** | **$1,341** |

**Opposite-side rejections** (other strategy disagreed) — surprisingly also bullish:

| Opp-side rejections | n | WR | PF | avgPnL |
|---:|---:|---:|---:|---:|
| 0 | 1343 | 36.6% | 1.31 | $127 |
| 1 | 99 | 56.6% | 2.89 | $641 |
| 2-3 | 28 | **82.1%** | **14.26** | $1,594 |
| 4+ | 3 | 100% | ∞ | $3,638 |

Both look powerful, **BUT they're largely a proxy for trade duration** — winning trades stay open longer, giving more time for other strategies' signals to arrive (and get rejected). They confirm what duration already showed, but you can't filter on these features at entry time.

**The one live-actionable inversion of this:** rank entries by likelihood of attracting confluence in the next N minutes. Hard to predict ex-ante without modeling each strategy's signal generation conditional on market state.

## 4. Live-actionable filter experiments

Each row applies a single rule on top of first-in-wins (drop matching trades from the realized portfolio). DD$ is the realized max drawdown in dollars; lower is better.

| Filter | Trades dropped | PnL change | Sharpe | DD% | DD$ |
|---|---:|---:|---:|---:|---:|
| **Baseline** | 0 | $289,540 | 5.79 | 11.19% | $16,739 |
| I — drop short trades 10-11 ET | 205 (14%) | -$19k → $270k | **5.93** | **9.08%** | **$13,118** |
| L — drop ALL level-fade entries | 566 (38%) | -$68k → $222k | 5.31 | 10.94% | $14,388 |
| N — drop level-fade @ 10-12 ET | 184 (12%) | -$17k → $272k | 5.59 | 10.17% | $18,033 |
| P — drop gex-lt-3m LONG @ 09 ET | 61 (4%) | -$13k → $277k | 5.67 | 10.10% | $13,639 |
| Q — drop ALL 09 ET entries | 513 (35%) | -$104k → $186k | 4.49 | 9.74% | $13,075 |
| R — drop after 30d negative rolling PnL | 117 (8%) | -$23k → $267k | 5.76 | 13.93% | $19,223 (worse) |

**Simple winner**: **Filter I (drop short trades 10-11 ET)** — costs $19k PnL (-6.6%) but improves Sharpe 5.79→5.93 (+2.4%), DD 11.19%→9.08% (-19%), DD$ saves $3,621. Clean entry-time rule.

### Combined-filter stacks

| Stack | Trades dropped | PnL | Sharpe | DD% | DD$ |
|---|---:|---:|---:|---:|---:|
| STACK-2 (L + short morning) | 687 (47%) | $202k | 5.44 | 9.15% | $11,953 |
| STACK-4 (L + lt-3m long @ 09) | 627 (43%) | $209k | 5.21 | **8.95%** | **$11,318** |
| STACK-5 (L + short morning + lt-3m long @ 09) | 748 (51%) | $189k | 5.40 | **7.08%** | $12,185 |
| FOCUS (keep ONLY gex-flip-ivpct) | 1326 (90%) | $96k | **6.89** | **6.28%** | **$8,845** |

STACK-5 trades $100k of PnL for cutting DD% from 11.19% to 7.08% — a 37% drawdown reduction. If you care about smoothness more than absolute return, this is meaningful.

The **FOCUS** rule (only take gex-flip-ivpct signals) drops 90% of trades and gives up 67% of PnL but is the closest first-in-wins variant to confluence-only-last-exit's risk profile.

## 5. How this compares to confluence-only-last-exit

Recap from main SUMMARY:

| Rule | Trades | Sharpe | DD% | DD$ | PnL |
|---|---:|---:|---:|---:|---:|
| first-in-wins (baseline) | 1473 | 5.79 | 11.19% | $16,739 | $289,540 |
| first-in-wins + STACK-5 filters | 725 | 5.40 | 7.08% | $12,185 | $189,021 |
| first-in-wins + FOCUS | 147 | 6.89 | 6.28% | $8,845 | $95,702 |
| **confluence-only-last-exit** | **212** | **8.56** | **4.24%** | **$6,358** | **$104,954** |

`confluence-only-last-exit` is still the risk-adjusted champion — even the most aggressive first-in-wins filters can't match its Sharpe or DD. Its edge comes from a structural requirement (≥2 strategies agreeing) that no entry-time filter on first-in-wins can replicate.

## 6. Outside-the-box ideas worth building (not testable in this pipeline)

These require engine-level support to test honestly:

1. **Dynamic time-stop**: if held trade is at a loss after 5-10 minutes, tighten stop or flatten. Targets the $107k instant-stop-out cluster directly. Honest test needs 1m/1s bar replay.
2. **Confluence-aware extended hold**: if a same-side signal arrives during hold, extend max-hold time by N bars (or hold until that secondary signal would naturally exit). Captures the duration-WR relationship by letting confirmed winners breathe.
3. **Origin-conditional sizing**: 1.5 contracts on gex-flip-ivpct entries, 1 contract on gex-lt-3m, 0.5 contracts on gex-level-fade. Concentrates capital where per-trade edge is highest (PF 2.71 vs 1.39). Needs micro contract support.
4. **Two-tier "smart first-in-wins"**: always take gex-flip-ivpct signals; only take gex-lt-3m/gex-level-fade if a same-side gex-flip signal fired in the previous N minutes (recency-weighted confluence proxy that's evaluable at entry time, unlike post-hoc rejection counting).
5. **Hour gate**: reject all entries before 04 ET and after 15 ET. Modest aggregate effect; could be applied per-strategy.

## 7. TL;DR — what to actually use

- **If running first-in-wins live**: apply **Filter I** (drop SHORT entries in the 10-11 ET hours). 20% DD reduction at 6% PnL cost. Trivially encodable as a one-line rule on `signal-generator`.
- **If small-account / DD-conscious**: switch to `confluence-only-last-exit`. Lower PnL but the best risk-adjusted profile of anything tested.
- **The big lever is the instant-stop-out cluster** (-$107k, 376 trades). A live time-stop targeting trades not in profit after 5 minutes would likely beat all the entry-time filters tested here — recommend building and back-testing as a follow-up (requires the engine to expose intra-trade exit overrides).
