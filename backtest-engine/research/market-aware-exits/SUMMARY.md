# Market-Aware Exits Research

**Date:** 2026-05-21
**Goal:** Test whether "market-aware" exits — exits that read structure during the trade (rejections, plateaus, velocity reversals) — can improve on the just-validated v3 gold standard ($217,864 / PF 1.90 / Sharpe 8.73 / MaxDD 5.56% / 553 trades).
**Source idea:** `memory/market-aware-exits-idea.md` — Drew's systemic concern that MFE reaches ~60-80% of TP, gets rejected twice at same level, then bounces to full SL.

## TL;DR — KEEP v3. Market-aware mechanics don't help.

Three mechanics tested on v3's 553 trades; none beat baseline. Reason: **v3's wider exits + per-rule BE already defang the failure pattern Drew described.** Only **1 trade** in v3 (0.2%) actually exhibits "MFE ≥ 60% of TP → full stop_loss". The remaining "mid-MFE-loss" bucket (40-60% of TP, 26 trades / $29k) is concentrated in L_S4, where the original per-rule sweep already tested earlier BE and found it clipped more winners than it saved losers.

## Mechanics tested

All layered on top of v3's per-rule baseline policy (target/stop/BE/trail/maxHold).

### (1) DOUBLE_REJECTION
Track running MFE peak. On price retracing ≥ `pullbackMin`pt from peak and then returning to within `tolPts` of peak, count as 2nd rejection. Action: close at market OR tighten stop to `lockFrac × MFE`.

Sweep: 500 configs over (fracTp ∈ [0.4, 0.8], tol ∈ [1,2,3,5], pullback ∈ [3,5,8,12,18], action ∈ [close, tighten], lockFrac ∈ [0, 0.3, 0.5, 0.7]).

Result: best non-degenerate config (`fracTp=0.5 tol=1 pull=5 tighten lock=0`) → $222,130 / PF 1.99 / DD $10,435 → -$3,770 vs baseline. Tightening stop on 2nd rejection saves some painful losses but clips slightly more would-be winners. Net negative.

### (2) MFE_FRAC_TP (BE-style scaled by target)
When MFE ≥ `fracTp × TP`, set BE floor at `lockFrac × MFE`. Self-adjusts across rules with different TPs.

Sweep: 56 configs over (fracTp ∈ [0.4..0.8], lockFrac ∈ [0..0.7]).

Result: best non-degenerate config (`fracTp=0.7 lock=0.2`) → $224,430 / PF 1.97 / DD $10,435 → -$1,470 vs baseline. Same dynamic — the floor catches some retracements but eats into winners that recover.

### (3) VELOCITY_REVERSAL (price-only proxy — no volume)
MFE plateau ≥ `plateauSec` seconds AND single-bar adverse move ≥ `advPts` → close at market.

Sweep: 175 configs over (mfeMin ∈ [10..50], plateauSec ∈ [15..300], advPts ∈ [3..20]).

Result: best config (`mfeMin=20, plateauSec=300, advPts=20`) → $220,275 / PF 1.98 / DD $10,435 → -$5,625 vs baseline. The 300s plateau + 20pt adverse-bar threshold is so restrictive it barely fires; loosening the threshold makes performance worse.

## Why v3 already handles this

Per-rule failure-pattern audit using engine-recorded MFE (not walk-extrapolated MFE):

| Rule | Total | Losses 40-60%MFE | Losses ≥60%MFE | Mid-MFE loss $ |
|------|------:|-----------------:|---------------:|---------------:|
| L_S4 | 259 | **21** | 1 | -$24,823 |
| S_CW | 83 | 0 | 0 | $0 |
| S_GF_SOLO | 166 | 2 | 0 | -$2,505 |
| S_R4 | 45 | 3 | 0 | -$1,840 |

**v3's per-rule BE thresholds already cover most of the pattern:**

| Rule | TP | BE/trail trigger | % of TP where BE arms |
|------|---:|------------------:|----------------------:|
| L_S4 | 100 | BE @ MFE=70 | **70%** ← only one with gap below |
| S_GF_SOLO | 180 | BE @ MFE=80 | 44% |
| S_CW | 200 | BE @ MFE=80 | 40% |
| S_R4 | 80 | trail @ MFE=70 | 87% (gap below) |

For S_GF_SOLO and S_CW, BE arms BELOW the 60% mark — so a trade that reaches 60-80% MFE has BE already active, capping the downside at +$20pt. That's why Drew's pattern has **zero** ≥60%-MFE losses in these rules.

L_S4 has the failure mode exposure (21 trades, $25k bleed) because its BE arms at exactly 70% of TP — trades that reach 40-69% MFE and reverse can still take full SL. But the original v3 research sweep (`gex-lt-3m-improve/03-sweep-per-rule.js`) already tested L_S4 BE configs from MFE=15-80pt and found that earlier triggers cost more in winner clipping than they saved in loss reduction. The sweep landed on BE=70/+20 as the optimum.

S_R4's gap above 87% of TP is small (~10pt window) and its sample (3 trades) is too small to matter.

## Theoretical upper bound

If we could perfectly detect every mid-MFE+high-MFE loss and exit at 30% of MFE (lock partial profit):
* Catching all 1 high-MFE loser: +$1.8k max
* Catching all 26 mid-MFE losers: +$36.6k max
* **Combined theoretical max upside: +$38k** (with perfect detection)

But this assumes 100% detection accuracy with 0% false positives on winners. The sweep shows the actual achievable lift is **negative** — the mechanics fire on enough winners (which dip below the trigger then recover) to wipe out the small saved losses on losers.

## Recommendation

**Stick with v3 as the new gold standard.** Pareto-best variants saved at:
* `data/gold-standard/gex-lt-3m-crossover-v3.json` (recommended — $217,864 / PF 1.90 / Sharpe 8.73 / DD 5.56%)
* `data/gold-standard/gex-lt-3m-crossover-v3-max.json` (max PnL — $256,450 / PF 2.03 / DD 6.40%)
* `data/gold-standard/gex-lt-3m-crossover-v3-low-dd.json` (most conservative — $202,045 / PF 1.80 / DD 5.93%)

The market-aware mechanics evaluated here are not deployment candidates for gex-lt-3m-crossover. They may still be useful for OTHER strategies where:
* Per-rule BE doesn't already cover most of the failure pattern
* Targets are large enough that 60-80% of TP is a meaningful zone of price action (not just a noise band)

Two natural next-research targets:
1. **gex-flip-ivpct** — has fib-retrace exit already; market-aware extensions could augment.
2. **gex-level-fade** — tight stops + wide targets, more exposure to the bounce pattern.

## Files

* `01-walk-v3-fills.js` — walk v3's 553 trades in 1s OHLCV (89.8MB output)
* `02-sim-market-aware.js` — exit simulator with 3 layered mechanics
* `03-sweep-mechanics.js` — sweep all 3 mechanics (731 configs total)
* `04-failure-pattern-audit.js` — diagnostic: how often Drew's pattern occurs in v3
* `output/01-trades-walk-v3.json` — 89.8MB walk data
* `output/03-sweep-{dr,mft,vr}.csv` — top configs per mechanic
* `output/03-sweep-results.log` — full sweep stdout
* `output/04-pattern-audit.log` — pattern frequency analysis
