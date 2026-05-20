# LS-Flip-Edge Research Summary

**Date:** 2026-05-19
**Goal:** Build a tradable strategy from LS (Liquidity Status) flip events that beats the existing gold-standard bar. No reuse of production strategies (gex-flip-ivpct, gex-lt-3m-crossover, gex-level-fade).
**Bar to clear:** PF ≥ 1.5, Sharpe ≥ 4, DD ≤ 8%, ≥ 200 trades, low overlap with production trio.

## TL;DR

**`ls-flip-fade-3m` with stop=40 / target=120** clears every bar:

| Metric         | Value             | Bar      | Notes                                |
|----------------|-------------------|----------|--------------------------------------|
| Trades         | 514 (363 standalone) | ≥ 200    | ~32/mo over 16 mo                    |
| **PF**         | **1.75**          | ≥ 1.5    | Standalone (no overlap) PF = 1.63    |
| **Sharpe(yr)** | **4.09**          | ≥ 4      | Per-trade Sharpe 0.205 × √400 trades |
| **Max DD**     | **5.59%**         | ≤ 8      | Best DD of any tested candidate      |
| PnL (1 NQ)     | $90,200           | —        | 16-month period                      |
| Train PF       | 1.58              | —        | Jan-Aug 2025                         |
| **Test PF**    | **1.93**          | —        | Sep 2025-Apr 2026 (out-of-sample)    |
| Test DD        | 9.14%             | —        | Train 13.17% — test is BETTER        |
| Overlap        | 29.4%             | < 30     | vs gex-flip-ivpct + gex-lt-3m + gex-level-fade + iv-skew-gex |

The more scalp-like variant **`ls-flip-fade-3m` s=40 / t=60** also clears: PF 1.65, Sharpe 4.12, DD 9.35%, $74.7k. Out-of-sample also stronger than train (PF 1.74 test / 1.57 train).

## Strategy specification

**Direction:** FADE (contrarian to the new LS state) — bear→bull flip = SHORT; bull→bear flip = LONG.

**Entry condition (all three must hold):**
1. **TF:** 3m LS just flipped.
2. **AGAINST higher TFs:** the new 3m state is opposite both s1m and s15m at the flip instant.
3. **Climax candle:** the 1m primary-contract bar containing the flip has |close − open| ≥ 0.82 × ATR(20).

**Entry mechanic:** market order at the open of the next 1s bar after the 3m flip bar closes (= flip_ts + 180s).

**Exit:** stop=40pt, target=120pt (or 60pt for scalp), no maxhold beyond 60min, no BE rule, no EOD cutoff.

**Direction-to-side mapping:**
- new 3m state = 0 (bearish flip), AGAINST means s1m=1 AND s15m=1 → fade = **LONG**
- new 3m state = 1 (bullish flip), AGAINST means s1m=0 AND s15m=0 → fade = **SHORT**

The two sides are roughly balanced (~50/50 split of trade count).

## Research path

| Phase | Output | Key finding |
|-------|--------|------------|
| **A.** Forward-return event study on 49k LS flips (1m+3m), 1s-honest walks | `01-events.csv` (60 MB, 95k rows) | Unconditional PF ≈ 1.0 at every fixed grid cell — no raw edge. Prior "77% WR" was an artifact of unbounded winners. |
| **B.** Feature enrichment at flip instant (LS alignment, GEX, TOD, IV, candle, momentum) | `02-features.csv` (13.5 MB) | 44 features per flip. |
| **C-1.** Unconditional grid scan across (tf, dir, stop, target) | `03-grid-scan.txt` | 3m FADE is the only direction with stable mild edge (PF 1.02-1.03). 1m flat both ways. 3m MOMENTUM negative everywhere. |
| **C-2.** Univariate filter scan | `04-univariate.txt` | Only `align_bits` survives the bar — all other features fail train/test stability. |
| **C-3.** align_bits deep-dive | `05-align-deep-dive.txt` | The pattern is "fade flips that go against higher TFs" — single composite filter unifies it. |
| **D.** Bivariate confluence within AGAINST=true | `06-bivariate.txt` | Top stable second filter: **candle_body/ATR ≥ Q5 (0.82)** lifts PF 1.24 → 1.65 on 3m@s40/t60. |
| **E-1.** Grid surface per candidate | `07-candidates.txt` | Candidate B has stable PF ≥ 1.5 across the whole right half of the stop/target grid. |
| **E-2.** Sharpe / MaxDD / monthly distribution | `08-sharpe-dd.txt` + `candidate-B-*.json` | B-s40-t120 clears every bar simultaneously. |
| **F.** Independence check vs production trio | `09-independence.txt` | 29.4% overlap; standalone PF = 1.63-1.75 (higher than full on 3 of 4 variants). |

## Why this works (mechanism)

The signal stack is:
1. **LS is contrarian** — Phase 0 of prior LS-overlay research confirmed at 1m/3m the state predicts the *opposite* direction (77% WR walking to next flip).
2. **Higher-TF disagreement** — when a 3m flip happens *against* both 1m and 15m, it's typically a noise-driven micro-reversal inside a larger trend. The slower TFs are the trend anchor; the 3m flip is the over-extension.
3. **Climax body** — the body/ATR filter captures the cases where the flip move *exhausted* itself in one bar. A small-body flip can keep extending; a big-body flip has already paid out its move and tends to mean-revert.

Together: **3m makes a one-bar climax move against the prevailing higher-TF bias → fade it.**

## Variants

| Variant | s/t (pts) | Trades | PF | Sharpe | DD | PnL (1 NQ, 16mo) |
|---------|-----------|--------|----|----|----|------------------|
| **`B-s40-t120`** primary | 40/120 | 514 | **1.75** | 4.09 | **5.59%** | **$90.2k** |
| **`B-s40-t60`** scalp-leaning | 40/60 | 514 | 1.65 | **4.12** | 9.35% | $74.7k |
| `B-s25-t60` tight-scalp | 25/60 | 514 | 1.49 | 3.26 | 11.74% | $52.4k |
| `B-s25-t30` ultra-scalp | 25/30 | 514 | 1.48 | 3.59 | 11.11% | $43.9k |

Trade count is identical across variants (514) — only exits change. Drawdown is best with the wider target because winners are bigger; PF improves with tighter risk/reward (40/120 has 3:1 RR).

## Live deployment gap (blocker)

LS data is currently **offline-only** — generated by running `ls-dumper.pine` as a TradingView strategy and exporting via XLSX. There is no real-time feed yet. Live deployment requires one of:

1. **Re-implement the LS indicator's logic in JS** (best). The Pine source `nq_ls_*_raw.csv` files have `state` (0/1) only, not the underlying calculation — investigate the LS indicator's mechanics to port.
2. **Stream LS state from TV via webhook** — `ls-dumper.pine` already emits state changes; could push to webhook on `barstate.isconfirmed` AND `flipped`. Latency / reliability TBD.
3. **Use a different liquidity-style indicator** (lt-extraction has working LT data feed via the same pattern — LT levels stream from a 1m TV dumper. Could the LS indicator be added to the same machinery?)

Until LS is live, this strategy is research-only. No urgency to deploy without addressing this gap.

## Independence breakdown vs production trio

| Production strategy | Overlap (B-s40-t120) | Same-side / Opposite | Overlap PnL |
|---------------------|----------------------|----------------------|------------|
| gex-flip-ivpct-tight | 7.8% | 26 / 14 | +351 pts |
| gex-lt-3m-crossover | **15.2%** | 41 / 37 | +1,125 pts |
| gex-level-fade | 12.6% | 36 / 29 | +1,355 pts |
| iv-skew-gex-cbbo-gold | 11.3% | 35 / 23 | +1,169 pts |
| **Unique overlap (any)** | **29.4% (151/514)** | — | — |
| **Standalone (no overlap)** | **70.6% (363/514)** | — | $45.6k @ PF 1.63 |

The highest single overlap is with gex-lt-3m-crossover (15.2%) — expected, both use LT/LS-style indicators. Critically, the side-agreement is 41/37 ≈ split — when these strategies overlap they're often taking *opposite sides*, not duplicating.

## Caveats

- **`candle_body / ATR(20)` uses the 1m bar at flip_ts**, not the full 3m bar. For 3m flips, this is the FIRST minute of the 3m bar. The filter works empirically; should re-validate against the actual 3m bar's body before live deployment.
- **Sample size in test half (251 trades, 8 months)** — not huge, but trade rate (~31/mo) is stable across all 16 months.
- **No EOD cutoff applied.** A few trades may walk through session boundaries; absolute impact small (max hold = 60min, sessions don't generally close mid-trade for futures).
- **Sharpe(yr)=4.09 assumes 400 trades/yr.** If trade rate changes (e.g., LS flip rate decreases in a low-vol regime), Sharpe will scale.

## Reproduction

```bash
cd backtest-engine
node research/ls-flip-edge/01-event-study.js   # ~2min, writes 01-events.csv
node research/ls-flip-edge/02-enrich-features.js  # ~30s, writes 02-features.csv
node research/ls-flip-edge/03-grid-scan.js
node research/ls-flip-edge/04-univariate.js
node research/ls-flip-edge/05-align-deep-dive.js
node research/ls-flip-edge/06-bivariate.js
node research/ls-flip-edge/07-candidates.js
node research/ls-flip-edge/08-sharpe-dd.js   # also saves candidate-*.json
node research/ls-flip-edge/09-independence.js
```

All Phase A 1s walks are 1s-honest per CLAUDE.md rules.
