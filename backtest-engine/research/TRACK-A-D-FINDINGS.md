# Track A + D — Findings on negative-regime support and level absorption

**Window:** 2025-01-13 → 2026-04-23 (NQ raw contracts, primary-contract filtered, post-lookahead-fix data).
**Scripts:** `track-a-negative-support-deepdive.js` (n=343 touches), `track-d-level-absorption.js` (n=18,405 level events).

---

## Track A — Negative-regime support touches, stratified

Sample: from honest Track 1 — touches where regime=negative, level type ∈ {put_wall, S1–S5}, approach=from_above, deduplicating put_wall/S1 aliasing.

**Baseline** (n=343): mean fwd-15m return +11.5pt, win rate 54.8%, mean MFE 63pt, mean MAE 42pt, edge +21pt. Real but noisy.

### Filters that meaningfully improve the baseline

| Filter | n | Win% | Ret mean | Edge (MFE−MAE) |
|---|---:|---:|---:|---:|
| **S4 \| morning (10:00–12:00 ET)** | 13 | **69.2%** | +40.2 | +61.8 |
| **S3 \| morning** | 20 | **80.0%** | +31.6 | +49.2 |
| **S4 \| gamma_imbalance < −0.8** | 19 | **78.9%** | +52.1 | +56.3 |
| S2 \| gamma_imbalance −0.8 to −0.6 | 25 | 68.0% | +34.8 | +37.1 |
| S4 \| lunch (12:00–14:00) | 11 | 63.6% | +48.6 | +33.8 |
| S5 \| lunch | 10 | 70.0% | +38.8 | +34.4 |

### Filters that *destroy* the baseline (anti-setups)

| Filter | n | Win% | Ret mean |
|---|---:|---:|---:|
| **put_wall/S1 \| gamma_imbalance < −0.8** | 54 | 48.1% | **−9.2** |
| **S2 \| gamma_imbalance < −0.8** | 31 | 32.3% | **−20.7** |

### Takeaway

Two distinct signals emerge:

1. **Mid-tier support fade in mornings.** S3+S4 combined (n=33) in the 10:00–12:00 ET window with negative regime + from_above approach: ~75% win rate, ~+35pt mean fwd-15m. Sample is small (~3/month) but consistent across both level types and adjacent ToD buckets.

2. **Put-wall fails when imbalance is extreme.** When gamma_imbalance < −0.8 (most negative quintile), put_wall/S1 actually breaks — 48% WR, −9pt mean. **Don't fade the put_wall in deeply-imbalanced regime**. Conversely, S4 (further from price, deeper support) actually strengthens in those same conditions: 79% WR / +52pt.

Practical strategy candidate: **"Mid-tier support fade, mornings only, exclude extreme-imbalance put_wall touches"**. Combine S3 + S4 morning bounces, target ~25pt, stop ~30pt, max-hold 30 min. Prelim sample of ~33 trades / 12 months suggests this is sparse — would need to extend to more level types or relax ToD filter to get to ~100 trades/year.

---

## Track D — Level absorption, full year (n=18,405 transitions)

For each consecutive snapshot pair (T, T+1), classify each level present in T as either **persisted** (a level within 5pt exists in T+1) or **absorbed** (no nearby level in T+1). 61.4% persisted, 38.6% absorbed across all level types.

### Key finding: above-spot former supports absorbed → modest mean reversion UP

When current spot is BELOW a support level (i.e., spot has recently broken down through it), and that support is absorbed in the next snapshot:

| Level type | n_abs | Ret 15m | Ret 45m | Ret 90m | Cross 15m | Cross 90m |
|---|---:|---:|---:|---:|---:|---:|
| absorbed \| above \| S3 | 303 | **+7.56** | +9.19 | +6.82 | 26.1% | 41.8% |
| absorbed \| above \| S2 | 336 | +3.38 | +6.24 | +7.51 | 21.4% | 40.1% |
| absorbed \| above \| S4 | 292 | −0.57 | +6.63 | +12.34 | 19.9% | 38.8% |
| absorbed \| above \| S5 | 275 | −2.86 | +1.41 | +9.14 | 17.8% | 35.5% |

(`return` is signed in the "drift toward the level" direction — positive = price moved up toward the absorbed support; `cross` = price actually reached the level price during the window.)

**Interpretation:** Mean-reversion bias. Spot temporarily traded below the support, the support gets demoted out of the level set, and price recovers back toward where the support was. Persistent equivalents have flat-to-slightly-negative drift, so the absorption itself isn't necessary for the reversion — it's the spot-below-support condition that matters. **Not a strong tradable signal on its own.**

### Key finding: continuation pattern (absorbed levels reach next-same-side-level more often)

The "reach next level" stat shows whether price actually traveled past the absorbed level to the *next* same-side level in the new snapshot. Compared to persisted baselines:

| Setup | n_abs | reach90% absorbed | reach90% persisted | Δ |
|---|---:|---:|---:|---:|
| above \| R5 absorbed | 485 | 29.4% | 11.7% | **+17.7pp** |
| above \| R3 absorbed | 203 | 30.7% | 15.0% | +15.7pp |
| below \| put_wall absorbed | 725 | 34.6% | 19.6% | **+15.0pp** |
| below \| S3 absorbed | 576 | 33.9% | 19.7% | +14.2pp |
| above \| R2 absorbed | 239 | 28.4% | 17.3% | +11.1pp |
| above \| R4 absorbed | 274 | 27.0% | 17.5% | +9.5pp |
| below \| S2 absorbed | 549 | 30.8% | 22.0% | +8.8pp |
| below \| S4 absorbed | 501 | 31.9% | 23.9% | +8.0pp |

**Real but modest signal.** Absorbed levels are roughly 1.5–2.5× more likely to be "passed through" within 90 minutes than persisted levels. But absolute reach rates max out at ~35%, so most of the time absorption doesn't lead to a clean run-through.

### What didn't pan out

- **Walls (call_wall, put_wall) above spot:** absorption doesn't change reach behavior much.
- **Gamma flip absorption:** flat directional return either way (~−2pt mean across both states).
- **Direct directional return (PnL, not just reach rate):** even where reach-rate uplift exists, the mean directional return only improves by 5–10pt — and stops/slippage would eat most of that.

---

## Net assessment

**Track A:** A specific small-sample pocket (S3+S4 in negative regime mornings) shows clear edge (~75% WR), but ~33 trades/year is too sparse for confidence. Could form one component of a multi-signal strategy.

**Track D:** The absorption hypothesis is *partially* validated — absorbed levels do show a measurable continuation bias toward the next same-side level (reach rates roughly 2× higher than persisted). But the directional-return uplift is small (5–10pt), so the signal alone isn't tradable with reasonable stops. **The mean-reversion observation (spot below absorbed support → price recovers up) is interesting but appears to be driven by the spot-below-support setup itself, not by the absorption.**

### Recommendations

1. **Strongest combined signal worth prototyping:** combine Track A's morning-S3/S4 fade with Track D's "level absorbed in last snapshot" filter. Hypothesis: the same support that gets touched and then absorbed has the cleanest fade signature (the dealer hedging that created the support is being unwound exactly as price tests it). This is a 2-condition filter on Track A's sample — would cut the n further but may push WR from 75% → ?80%+%.

2. **The absorption signal as a context filter, not a primary entry.** Use "is the touched level absorbed in T+1?" as a *boost* on existing strategies rather than a standalone strategy.

3. **Skip a standalone absorption strategy.** The directional return uplifts (5–10pt) are too small to cover stops/slippage, even though the reach-rate stats look interesting.

Open question: does the Track D absorption signal compound with regime? E.g., is the "absorbed support → continuation down" pattern stronger when total_gex is in deep-negative territory? Worth one more stratification pass before deciding whether to drop or proceed.
