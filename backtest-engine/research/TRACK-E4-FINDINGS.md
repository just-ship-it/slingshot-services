# Track E4 — MFE/MAE distributions & TP/SL grid sweep

**Window:** 2025-01-13 → 2026-04-23 (333 trading dates)
**Inputs:** All crossover events from Track E (15m, 29,557), Track E2-1m (42,661), Track E2-3m (34,963)
**Horizon:** 60 min | **Confirm window:** ±30 min vs 15m | **Min sample:** 200
**TP grid:** {10, 15, 20, 25, 30, 40, 50, 60, 80} | **SL grid:** {10, 15, 20, 25, 30, 40, 50}
**"First-to-hit-wins" execution model:** TP and SL hit in same bar → conservatively count as SL. No slippage / commissions yet.

---

## Note on aliasing

`call_wall ≡ R1` and `put_wall ≡ S1` always (the wall is always the highest-magnitude resistance/support). The sweep treats them as separate and reports identical numbers — pick one of each pair when designing the strategy whitelist to avoid double-firing.

---

## TL;DR

- Highest per-trade expectancy: **call_wall \| gex_below_lt \| confirmed** — n=361, TP=80/SL=50, **+22.34pt expectancy, PF 2.63, WR 61.8%** (= +$8,065 total ÷ 361 trades).
- Highest total expectancy (by exp × n): **S4 \| gex_above_lt \| confirmed** — n=1364, TP=80/SL=50, +8.74pt × 1364 = **+11,917 total pts**.
- Highest profit factor at meaningful sample: **gamma_flip \| gex_below_lt \| solo** — n=299, TP=60/SL=50, exp=21.33pt, **PF 3.00**, WR 67.2%.
- TP=80 dominates winners (long-tail capture matters more than tight TP).
- SL=10 works for tight-stop variants on slow-drift setups (S1/put_wall above), SL=50 dominates for the higher-magnitude ones.
- "Solo vs confirmed" preference flips per setup. Some setups (S2-below, gamma_flip-below, S5-above) strongly prefer solo. Others (S3-above, S4-above, call_wall-below) work better confirmed (more events, slightly muted per-trade but bigger total).

---

## Top setups by per-trade expectancy (n ≥ 200)

| # | Setup | n | TP / SL | Exp (pt) | PF | WR | tp_hit / sl_hit / time |
|---:|---|---:|---|---:|---:|---:|---|
| 1 | **call_wall \| gex_below_lt \| confirmed** | 361 | 80 / 50 | **+22.34** | **2.63** | 61.8% | 139 / 77 / 145 |
| 2 | **gamma_flip \| gex_below_lt \| solo** | 299 | 60 / 50 | +21.33 | **3.00** | **67.2%** | 135 / 44 / 120 |
| 3 | R4 \| gex_below_lt \| confirmed | 319 | 80 / 50 | +15.85 | 1.91 | 52.4% | 118 / 88 / 113 |
| 4 | S3 \| gex_above_lt \| solo | 609 | 80 / 30 | +12.05 | 1.75 | 43.8% | 172 / 306 / 131 |
| 5 | R2 \| gex_above_lt \| confirmed | 321 | 60 / 40 | +12.00 | 1.86 | 58.6% | 109 / 106 / 106 |
| 6 | S4 \| gex_above_lt \| solo | 626 | 80 / 25 | +11.69 | 1.78 | 38.7% | 188 / 366 / 72 |
| 7 | S5 \| gex_above_lt \| solo | 594 | 60 / 50 | +11.52 | 1.63 | 57.4% | 267 / 201 / 126 |
| 8 | R3 \| gex_below_lt \| confirmed | 321 | 80 / 50 | +10.57 | 1.52 | 48.0% | 107 / 104 / 110 |
| 9 | R5 \| gex_below_lt \| confirmed | 347 | 60 / 40 | +9.79 | 1.61 | 53.6% | 123 / 131 / 93 |
| 10 | S2 \| gex_below_lt \| solo | 647 | 60 / 40 | +9.45 | 1.52 | 51.0% | 280 / 285 / 82 |
| 11 | call_wall \| gex_above_lt \| solo | 217 | 60 / 30 | +9.64 | 1.69 | 48.4% | 74 / 96 / 47 |
| 12 | S4 \| gex_above_lt \| confirmed | 1364 | 80 / 50 | +8.74 | 1.45 | 50.1% | 350 / 466 / 548 |
| 13 | S3 \| gex_above_lt \| confirmed | 1403 | 80 / 50 | +8.41 | 1.44 | 53.0% | 339 / 476 / 588 |
| 14 | put_wall \| gex_below_lt \| solo | 1075 | 50 / 50 | +8.32 | 1.43 | 59.0% | 563 / 398 / 114 |
| 15 | S2 \| gex_above_lt \| solo | 651 | 80 / 10 | +8.33 | 2.08 | 23.0% | 119 / 501 / 31 |

(table continues; full data in JSON output)

## Solo vs confirmed — when each wins

| Setup | Solo per-trade | Confirmed per-trade | Solo wins by |
|---|---:|---:|---:|
| **S2 \| gex_below_lt** | 9.45 | 2.43 | **3.9×** |
| **gamma_flip \| gex_below_lt** | 21.33 | 5.23 | **4.1×** |
| **S5 \| gex_above_lt** | 11.52 | 4.92 | 2.3× |
| **S2 \| gex_above_lt** | 8.33 | 5.52 | 1.5× |
| S3 \| gex_above_lt | 12.05 | 8.41 | 1.4× |
| S4 \| gex_above_lt | 11.69 | 8.74 | 1.3× |
| put_wall \| gex_below_lt | 8.32 | 3.09 | 2.7× |
| **R4 \| gex_below_lt** | (no n≥200) | 15.85 | confirmed only |
| **call_wall \| gex_below_lt** | (no n≥200) | 22.34 | confirmed only |
| **R3 \| gex_below_lt** | (no n≥200) | 10.57 | confirmed only |

So "solo" reliably wins on the **support-side support breaks** (S2/S5 above_lt, S2 below_lt, gamma_flip below) — these are the setups where the freshness-of-3m matters most because the move is fast.

The mid-tier resistance breakdowns (R3/R4 below_lt, call_wall below_lt) pass the n≥200 threshold only on the *confirmed* side. They co-occur with 15m so frequently that solo is a very small population. Confirmed is fine here.

## MFE/MAE distribution patterns

Most setups show median MFE ≈ 40–60pt and median MAE ≈ 30–50pt over the 60-min window. Notable outliers:

- **call_wall \| gex_below_lt \| confirmed**: MFE p25/50/75/90 = **32 / 52 / 102 / 240** vs MAE = **14 / 30 / 52 / 98** — strongly asymmetric in favor of bearish drift, which is why the 80/50 combo works so well (20 pts of "free" R:R).
- **gamma_flip \| gex_below_lt \| solo**: MFE p90 = 157 vs MAE p90 = 71 — even more asymmetric, hence the PF 3.00.
- **gex_above_lt setups** generally have similar MFE/MAE distributions, which is why their winning combos lean on small SL (10–25) to capture the asymmetry.

The avg time-to-MFE / time-to-MAE is ~26–30 min for both — neither happens "early." Most events fully play out near the 30-min mark, suggesting a 30-min hold cap might match the 60-min sweep results closely (worth re-running with --horizon-min 30 if we want a faster strategy).

---

## Proposed strategy whitelist

Combining everything: call_wall = R1, put_wall = S1 (don't double-count). Suggested whitelist with per-rule TP/SL.

### Long rules (gex_above_lt)

| Rule | Setup | Filter | TP | SL | Notes |
|---|---|---|---:|---:|---|
| L_S3 | S3 \| gex_above_lt | confirmed | 80 | 50 | exp 8.4, PF 1.44, n=1403 — strongest by total |
| L_S4 | S4 \| gex_above_lt | confirmed | 80 | 50 | exp 8.7, PF 1.45, n=1364 |
| L_S5_solo | S5 \| gex_above_lt | **solo** | 60 | 50 | exp 11.5, PF 1.63, n=594 — solo bumps quality |
| L_pw_tight | put_wall \| gex_above_lt | confirmed | 80 | 10 | exp 7.0, PF **1.92**, n=1527 — high freq, tight SL |

### Short rules (gex_below_lt)

| Rule | Setup | Filter | TP | SL | Notes |
|---|---|---|---:|---:|---|
| S_cw | call_wall \| gex_below_lt | confirmed | 80 | 50 | exp **22.3**, PF **2.63**, n=361 — strongest single setup |
| S_R4 | R4 \| gex_below_lt | confirmed | 80 | 50 | exp 15.9, PF 1.91, n=319 |
| S_R3 | R3 \| gex_below_lt | confirmed | 80 | 50 | exp 10.6, PF 1.52, n=321 |
| S_R5 | R5 \| gex_below_lt | confirmed | 60 | 40 | exp 9.8, PF 1.61, n=347 |
| S_gf_solo | gamma_flip \| gex_below_lt | **solo** | 60 | 50 | exp 21.3, PF **3.00**, n=299 — sparse but exceptional |
| S_S2_solo | S2 \| gex_below_lt | **solo** | 60 | 40 | exp 9.5, PF 1.52, n=647 |
| S_pw_solo | put_wall \| gex_below_lt | **solo** | 50 | 50 | exp 8.3, PF 1.43, n=1075 |

### Total opportunity

Sum of (exp × n) across the whitelist (deduped: no R1/call_wall double-count, no S1/put_wall double-count):

- Longs: ~38,000 pts
- Shorts: ~46,000 pts
- **Total: ~84,000 pts ≈ $1.68M idealized over 16 months on 1 NQ contract**

Realistic expectations after position concurrency, cooldowns, slippage:
- Track E2 found ~17 events/day on 3m. With 11 rules, but a 1-position-at-a-time concurrency cap and a ~30-min cooldown, realized trade count likely falls to ~3–5 trades/day.
- Realized PnL probably 25–40% of idealized = **$420k–$670k** over 16 months on 1 NQ contract. Comparable to or better than the $275k of post-fix gex-flip-ivpct.

---

## Caveats

1. **No slippage or commissions yet.** NQ is liquid (1–2 tick slippage typical) but commissions ($4–5 round-trip) reduce per-trade expectancy by ~1pt. Re-derive after engine integration.
2. **Same-bar TP+SL handled conservatively** (counted as SL hit). Real fills may differ but bias is on the safe side.
3. **No concurrency rules in the sweep.** Multiple rules can fire on the same crossover — the engine will need a "one position at a time" or "max N concurrent" rule to avoid double-counting.
4. **Lookahead status: clean.** All inputs use the post-2026-05-06 corrected GEX data and back-adjusted-to-raw LT data. Forward returns measured strictly forward from entry candle's open.
5. **`barsSinceEntry` is per 1m candle in the engine** (per the gex-flip-ivpct memory note), so when implementing, max-hold should be 60 (in minutes), not 60/3=20.

---

## Recommended next step

Build the engine strategy `gex-lt-3m-crossover` with the per-rule whitelist above. Reference template: `shared/strategies/gex-flip-ivpct.js` — same priority-ordered RULES array pattern with per-rule stops/targets.

Implementation outline:
- Strategy fires on `candle.timestamp % (3 * 60_000) === 0` (3-min boundary)
- At each fire, compute current GEX × 1m-LT pair signs, compare to previous 3m boundary's signs to detect crossovers
- For each crossover, check rule conditions (gex_type match, direction match, optional solo filter against 15m feed)
- If a rule fires and no position is active, place limit at next bar's open with the rule's TP/SL/maxHold
- Cooldown: 30 min after exit (per gex-flip-ivpct precedent)
- EOD cutoff: 16:40 ET (per prior strategy)

Then run the gold-standard parity command and compare to the +84k idealized estimate.

We should also revisit whether the 1m LT data (from the user's TradingView extraction) is what the engine should use live, or whether we need a 1m LT feed in production. (The 1m extraction is a one-time historical dump; live trading would need a live 1m LT feed.)
