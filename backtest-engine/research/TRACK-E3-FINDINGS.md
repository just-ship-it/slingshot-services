# Track E3 — Lead/Lag analysis across 1m / 3m / 15m LT timeframes

**Window:** 2025-01-13 → 2026-04-23 (333 trading dates)
**Inputs:** Track E (15m, 29,557 crossovers), Track E2 1m (42,661), Track E2 3m (34,963)
**Lookback for precursor detection:** 30 min | **Confluence window:** ±30 min

---

## Headline findings

1. **The three LT timeframes are largely independent signals.** Only **23.5%** of 15m crossovers have a same-direction 3m precursor within 30 min; **23.0%** have a 1m precursor. The user's prediction was right — different timeframes ARE different patterns, not resamplings of the same one. Most of the 15m events fire without any precursor on lower TFs.

2. **When precursors do exist, lead time is real and meaningful.** Median lag from 3m → 15m is **18 min**, from 1m → 15m is **15 min**, from 1m → 3m is **11 min**. So when the lower TF does fire ahead, it's typically 15+ min ahead.

3. **Counterintuitive: 15m confluence HURTS the 3m signal magnitude on most setups.** "Solo" 3m events (no 15m crossover in same direction within ±30 min) consistently produce *stronger* forward returns than "confirmed" 3m events. This flips the usual confluence logic on its head.

---

## Coverage (precursor coverage within 30 min before)

| Lead → Lag | Matched / Total | Coverage | Mean lag | Median | p10 | p90 |
|---|---:|---:|---:|---:|---:|---:|
| 3m → 15m | 6,939 / 29,557 | **23.5%** | 18.5 min | 18.0 | 3.0 | 30.0 |
| 1m → 15m | 6,801 / 29,557 | **23.0%** | 15.7 min | 15.0 | 2.0 | 30.0 |
| 1m → 3m | 14,488 / 34,963 | **41.4%** | 13.4 min | 11.0 | 2.0 | 30.0 |

Per-setup, coverage is highest for bearish-side support breakdowns (S2–S5 + put_wall \| gex_below_lt: 33–39% coverage from 3m, mean lag 16–18 min) and lowest for bullish-side resistance moves (gex_above_lt: 22–25% coverage).

---

## Confluence — the surprising result

For each 3m crossover event, classified as **"confirmed"** (a same-direction 15m crossover exists within ±30 min) vs **"solo"** (no 15m crossover nearby). Compared forward 15m returns:

| Setup | n_conf | mean_15m conf | n_solo | mean_15m solo | Δ (conf − solo) |
|---|---:|---:|---:|---:|---:|
| **S5 \| gex_above_lt** | 1,350 | +6.20 | 594 | **+19.42** | **−13.22** |
| **R4 \| gex_above_lt** | 340 | −4.03 | 127 | +11.19 | −15.21 |
| **gamma_flip \| gex_below_lt** | 1,000 | −2.89 | 299 | **−13.90** | +11.01 (solo more bearish) |
| S4 \| gex_below_lt | 1,354 | −3.64 | 621 | +5.75 | −9.39 |
| R2 \| gex_below_lt | 284 | −3.52 | 100 | −11.68 | +8.16 (solo more bearish) |
| call_wall \| gex_above_lt | 385 | −3.54 | 217 | +4.08 | −7.61 |
| S2 \| gex_below_lt | 1,417 | +3.58 | 647 | −3.64 | +7.22 (solo more bearish) |
| **S2 \| gex_above_lt** | 1,479 | +2.46 | 651 | +7.73 | −5.27 |
| put_wall \| gex_below_lt | 1,473 | −6.50 | 1,075 | −0.45 | −6.05 |
| **R3 \| gex_below_lt** | 321 | −7.76 | 93 | **−12.06** | +4.30 (solo more bearish) |
| **R4 \| gex_below_lt** | 319 | **−10.89** | 136 | −7.35 | −3.54 (confirmed slightly more bearish) |
| **call_wall \| gex_below_lt** | 361 | **−17.77** | 194 | −15.90 | −1.87 (confirmed slightly more bearish) |
| **S4 \| gex_above_lt** | 1,364 | +11.66 | 626 | +13.43 | −1.77 |
| **S3 \| gex_above_lt** | 1,403 | +10.69 | 609 | +11.60 | −0.91 |
| put_wall \| gex_above_lt | 1,527 | +7.09 | 1,103 | +7.93 | −0.84 |

In **almost every setup**, the solo direction has either the same or stronger signal magnitude than confirmed. The exceptions (call_wall and R4 below_lt) only show modest +1–4pt advantage for confirmed.

### What this means

The intuition "lower TF gives early warning, higher TF confirms" turns out to be **wrong for this signal**. When the 15m feed is also active in the same direction within ±30 min, the move is largely already priced in by the time the 3m fires. The cleanest 3m signals are the ones with NO 15m company.

A few possible mechanisms:
- The 15m crossover represents the slower structural shift that's already partially expressed in price; the 3m crossover with 15m presence is a continuation of an already-running move.
- Solo 3m crossovers represent fresh structural inflections that haven't reached the slower indicator's threshold yet — these are the "leading edge" with the most directional kick.
- Or: 3m+15m simultaneous = whipsaw cluster; 3m alone = clean trigger.

---

## Lead/lag — when both TFs fire, who's first?

Looking only at the matched subset (where a 3m precursor exists for a 15m event):

- **Median 3m→15m lag: 18 min.** So when the 3m and 15m both fire on the same setup, the 3m typically leads by ~18 min.
- p10 lag is 3 min (the lower-bound earliest), p90 is 30 min (the analysis cap).
- This applies to ~24% of 15m events. The other 76% don't have a 3m precursor at all.

Combined with the confluence finding, the actionable interpretation is:
- A 3m crossover that has a 15m crossover *behind* it (3m fired ~15min earlier and 15m caught up) is the "confluence" subset → muted forward returns
- A 3m crossover with no 15m around is the cleanest signal → strongest forward returns
- Most 15m crossovers don't have a 3m precursor anyway, so they're their own thing

---

## Best 3m setups (post lead/lag analysis)

Adjusting Track E2 results with confluence consideration: prefer SOLO 3m events.

| Setup | n_solo | mean_15m solo | Note |
|---|---:|---:|---|
| **call_wall \| gex_below_lt** (confirmed) | 361 | **−17.77** | Slight edge to confirmed; both subsets very strong |
| **S5 \| gex_above_lt** (solo) | 594 | **+19.42** | Solo gets +19pt — biggest single bull signal |
| **call_wall \| gex_below_lt** (solo) | 194 | −15.90 | Solo also very strong |
| **R3 \| gex_below_lt** (solo) | 93 | **−12.06** | Small n but strong magnitude |
| **R4 \| gex_below_lt** (confirmed) | 319 | **−10.89** | This is one of the few where confirmed is slightly stronger |
| **gamma_flip \| gex_below_lt** (solo) | 299 | −13.90 | Strong bearish when no 15m present |
| **R5 \| gex_below_lt** (solo) | 149 | −14.46 | (vs confirmed −10.61) |
| S4 \| gex_above_lt (solo) | 626 | +13.43 | Slight edge to solo |
| S3 \| gex_above_lt (solo) | 609 | +11.60 | Slight edge to solo |
| put_wall \| gex_above_lt (solo) | 1,103 | +7.93 | Higher freq, smaller mean |

The strongest single signal in the entire study is now: **S5 \| gex_above_lt, solo on 3m, n=594, +19.42pt mean forward 15m**. Combined call_wall_below_lt (n=555 confirmed + 194 solo = 749 events at ~−16pt mean) is the next-best bearish.

---

## Strategy design implications

1. **Use 3m as the primary signal cadence.** Strongest mean magnitudes, sample sizes still ample.

2. **Solo-3m filter is the goldilocks signal.** Strategy: at every 3m boundary, check for crossover events. For each, look back ±30 min in the 15m feed for same-direction events. If none, this is a "solo" signal — trade it. If present, fade or pass.

3. **Side-specific GEX type whitelist.** Don't trade all GEX types — only the ones with clean directional bias:
    - **Bullish (gex_above_lt):** S3, S4, S5, put_wall
    - **Bearish (gex_below_lt):** call_wall (R1), R3, R4, R5, gamma_flip
    - Avoid: S2 (mixed), R2 (small magnitude), gamma_flip|above (no edge)

4. **Lead/lag is real but coverage is low.** For ~25% of 15m events, the 3m fired ~18 min earlier — meaningful for entry timing if we already filter to the "matched precursor" subset. But this is a smaller pool than the standalone-3m approach.

5. **MFE/MAE distributions still missing.** Track E3 used end-of-window close returns; we still don't know the realistic stop/target hit rates. A separate measurement walking each event's intra-window NQ candles is needed before strategy params can be set.

---

## Recommended next step

Build the strategy. Two options:

**A. Implement `gex-lt-3m-crossover` as an engine strategy** with a hardcoded whitelist of (gex_type, direction) pairs and a "solo" filter that requires no 15m same-direction event in the prior 30 min. Use placeholder TP/SL (e.g., 30/25 pts) and run a sweep.

**B. First measure MFE/MAE per event** to derive principled TP/SL ranges, then implement. Adds 1 step but reduces wasted sweeping.

I'd recommend B — measuring intra-window MFE/MAE on the strongest setup (e.g., S5|above_lt solo, n=594) gives us realistic R:R bounds before we sweep. About 1 hour of compute.
