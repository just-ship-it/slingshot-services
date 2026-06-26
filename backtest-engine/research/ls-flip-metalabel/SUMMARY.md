# LS-Flip Meta-Labeling Research

**Date:** 2026-06-20 (overnight)
**Question (Drew):** new/untested ideas — *something genuinely predictive of whether an LS-flip signal will work out.*
**Approach:** meta-labeling. For each candJ (v3) trade, compute features known **at the flip instant** (no look-ahead), label win = `netPnL > 0`, and test — univariate, then a purged walk-forward model — whether anything predicts the outcome out-of-sample. Then confirm the winners causally in the real FCFS engine.

Baseline = candJ / v3 gold standard: **6,518 trades / $279,423 / WR 72.2% / PF 1.59 / Sharpe 21.3 / maxDD 1.81%** (reproduced exactly this run).

---

## TL;DR

1. **The signal is mostly efficient.** A gradient-boosted meta-labeler over 33 features gets **OOS AUC ≈ 0.53** (0.50 = coin flip), with in-sample AUC 0.66 — i.e. it overfits and barely generalizes. There is no rich hidden structure that predicts individual flip outcomes. This matches the order-flow-sweep conclusion (NQ second/minute tape is efficient).

2. **But a few interpretable filters carry real, OOS-consistent edge** — and they *beat the ML model*:
   - **LT-sentiment alignment** (`ltAlign`): flips agreeing with the 15m LT sentiment run **PF 1.78 vs 1.44**, WR 73.8% vs 70.7%, $53.8 vs $33.4/trade. Strongest single separator. (Now wired as `--lstb-require-lt-align`.)
   - **RTH hours 9–14 ET**: PF ~1.8–2.0 vs overnight 0–4 ET at PF 1.2–1.4 (consistent with the overnight-chop memory). v3 does NOT currently block 0–4 ET.
   - **Trigger-bar range** (monotonic, already partly used): range Q5 PF 2.13 vs Q1 1.23.
   - Combined `ltAlign & range≥8 & hr 9–14` → **OOS WR 77.5%, PF 2.15** on 17% of trades.

3. **GEX regime** is a real but secondary tell: lstb does *better* in **negative-gamma** (PF 1.74 vs 1.42) — opposite to gex-level-fade.

4. **Nothing else moved the needle**: trend/EMA slope, counter-trend, price-vs-recent-extreme, volume, fill latency, close-location, flip-density — all |corr| < 0.045 and not OOS-robust.

5. **The honest catch (and the real deployment question):** every winning filter *drops trades*, so per-trade tables overstate benefit. Under the FCFS 1-slot rule a dropped flip frees the slot. The causal engine runs below settle whether the PF/WR gain is worth the PnL given up. **→ see Causal Engine Results.**

6. **Highest-ceiling untested idea remains the LS conviction magnitude** (the Pine oscillator value at the flip, not the binary state). All features here are *context around* the signal; none grade the signal's own confidence. Requires a re-dump. Not done this pass — recommended next.

---

## Method

- `01-build-features.js` → `output/features.csv` (6,463 rows). Joins candJ trades + outcome with: trigger-bar shape (close-location, body, wicks), flip timing/chop (secs-since-last-flip, flips in prior 1h/2h), primary-1m context (swing-extreme distance, EMA slope, returns, position-in-range, volume ratio/z), LT confluence (nearest-level dist + sentiment alignment), daily GEX (gamma-flip dist, nearest wall, regime), fill dynamics. All as-of/≤ flip instant; primary contract via `filterPrimaryContract`.
- `02-univariate.py` → `output/02-univariate.txt`. Point-biserial corr + quintile WR/PF/$ per feature; categorical breakdowns.
- `03-metalabel-cv.py` → `output/03-metalabel-cv.txt`. HistGradientBoosting, **purged expanding-window walk-forward** (6 folds, 500-trade embargo). OOS AUC, IS/OOS gap, OOS keep-top-K% money table, hand-rule baselines, permutation importance.
- `04-tabulate.js` → `output/04-variants-table.md`. All engine variants vs baseline.

## Key numbers — univariate (in-sample, candJ exits)

| feature | signal | detail |
|---|---|---|
| ltAlign==1 | **PF 1.78 vs 1.44** | 49% of trades; WR 73.8 vs 70.7; $53.8 vs $33.4 |
| hour 10–14 ET | PF 1.8–2.0 | vs hour 0 ET PF 1.19 / WR 66.6% |
| range | monotonic | Q1(3–5.5pt) PF 1.23 → Q5(16+) PF 2.13 |
| gexRegime negative | PF 1.74 vs 1.42 | neg-gamma better; $53 vs $31.8 |
| cbAtr (lower) | PF 1.81→1.32 | confirms big-body filter direction |
| barsToFill / fillDelay | slow fills worse | immediate-fill PF 1.86 vs slow 1.27 |
| dow Tue | PF 1.79 | Mon worst (1.44) |

## Key numbers — walk-forward OOS (the trustworthy test)

- mean IS AUC **0.660**, mean OOS AUC **0.538**, pooled OOS AUC **0.534** → thin, real, but weak per-trade predictability.
- OOS hand-rules (3,878 walk-forward test trades; baseline WR 72.1% / PF 1.57):

| rule | keep | WR% | PF | avg$ |
|---|--:|--:|--:|--:|
| ALL (baseline) | 100% | 72.1 | 1.57 | 41.9 |
| ltAlign==1 | 49% | 73.5 | 1.72 | 50.0 |
| range≥8 | 59% | 73.6 | 1.72 | 49.4 |
| hour 9–14 ET | 43% | 74.9 | 1.79 | 54.2 |
| ltAlign & hour 9–14 | 21% | **77.8** | **2.14** | 69.3 |
| ltAlign & range≥8 & hr9–14 | 17% | 77.5 | **2.15** | 70.8 |
| drop hour 0–4 ET | 71% | 73.2 | 1.68 | 47.0 |

The ML at keep-30% only reached PF 1.89 — **the hand rules dominate the model**, so production should use rules, not a model (robust, interpretable, no retraining).

---

## Causal Engine Results (FCFS-honest, full 16mo, EOD 15:45)

Every variant re-run in the real engine with the 1-slot FCFS rule (so dropped flips
free the slot). Sorted by PnL.

| variant | trades | PnL | ΔPnL | WR% | PF | Sharpe | maxDD% | avg$ |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| **baseline (candJ/v3)** | 6518 | $279,423 | — | 72.2 | 1.59 | 21.27 | 1.81 | 42.9 |
| minR5 | 5663 | $262,424 | −6% | 73.0 | 1.66 | 20.24 | 1.69 | 46.3 |
| **ltAlign** | 4259 | $238,661 | −15% | 74.4 | **1.84** | **23.22** | 1.67 | 56.0 |
| cbatr090 | 4929 | $236,164 | −15% | 73.1 | 1.68 | 19.47 | 1.45 | 47.9 |
| drop0to4 | 4575 | $223,593 | −20% | 73.5 | 1.72 | 18.69 | 2.47 | 48.9 |
| **ltAlign_minR5** | 3635 | $218,311 | −22% | 75.3 | 1.93 | 22.13 | 1.41 | 60.1 |
| drop0to4_minR5 | 4237 | $216,344 | −23% | 74.1 | 1.77 | 18.26 | 1.89 | 51.1 |
| minR8 | 4065 | $202,121 | −28% | 73.6 | 1.73 | 17.97 | 1.73 | 49.7 |
| drop0to4_cbatr | 3533 | $186,414 | −33% | 74.0 | 1.79 | 17.33 | 1.92 | 52.8 |
| ltAlign_drop0to4 | 2958 | $182,231 | −35% | 75.7 | 1.99 | 20.85 | 1.27 | 61.6 |
| ltAlign_drop0to4_minR5 | 2685 | $172,296 | −38% | 76.2 | 2.05 | 19.94 | 1.30 | 64.2 |
| rthOnly_9to14 | 2750 | $153,230 | −45% | 75.3 | 1.82 | 15.64 | 1.84 | 55.7 |
| rth_minR5 | 2661 | $153,130 | −45% | 75.7 | 1.86 | 15.58 | 2.10 | 57.5 |
| ltAlign_rth9to14 | 1763 | $128,005 | −54% | 78.1 | 2.21 | 17.44 | 0.98 | 72.6 |
| ltAlign_rth_minR5 | 1686 | $124,215 | −56% | 78.3 | **2.24** | 16.85 | **0.98** | 73.7 |

### The decisive read

- **Almost every filter trades PnL *and Sharpe* for WR/PF.** candJ's 21.3 Sharpe comes from taking ~6,500 small, consistent bets; slicing by hour/size/cbAtr removes the diversification, so Sharpe falls even as PF rises. WR-for-its-own-sake is a trap here.
- **`ltAlign` is the exception — the only config that improves PF, Sharpe, *and* drawdown at once** (PF 1.59→1.84, Sharpe 21.3→**23.2** = best of all, DD 1.81→1.67), for −15% PnL. It works because it removes *genuinely wrong-side* trades (flips fighting the 15m LT trend) rather than arbitrarily thinning the book — so quality rises while enough trades remain to keep the curve smooth.
- **Stacking ltAlign + minR5** is the higher-WR sweet spot: WR 75.3, PF 1.93, Sharpe 22.1 (still > baseline), DD 1.41, −22% PnL.
- **Pushing WR to ~78%** (`ltAlign_rth_minR5`) is achievable and gives the lowest DD (0.98%) and highest PF (2.24), but halves PnL and drops Sharpe to 16.9 — a small-account / smooth-equity choice, not a risk-adjusted win.

### Train/test stability (split Sep-1-2025)

| variant | H1 WR/PF | H2 WR/PF |
|---|---|---|
| baseline | 72.2 / 1.57 | 72.7 / 1.61 |
| ltAlign | 75.6 / 1.92 | 74.1 / 1.79 |
| ltAlign_minR5 | 76.9 / 2.08 | 74.6 / 1.85 |

ltAlign beats baseline in **both** halves — no overfit. (Also independently confirmed OOS in the walk-forward hand-rule table above.)

---

## Recommendations

1. **Ship `ltAlign` as the v3.1 default** (PF-over-PnL pick per `feedback_pf_over_pnl`): it's the rare strict risk-adjusted upgrade — higher PF, higher Sharpe, lower DD, +30% avg $/trade — for a tolerable 15% PnL haircut. Already wired: set `requireLtAlign: true` in `signal-generator/strategy-config.json` lstb block (or `--lstb-require-lt-align`). One-bit filter, clear mechanism, low overfit risk.
2. **For a higher win rate specifically** (Drew's original ask): `ltAlign + minTriggerRange 5` → WR 75.3 / PF 1.93, still Sharpe 22.1 and lower DD. Best WR you can get while staying above baseline Sharpe.
3. **Do NOT** deploy the time/size-only filters (drop0to4, rthOnly, minR8, cbatr090) standalone — they cut Sharpe with no offsetting benefit ltAlign doesn't already provide.
4. **Next research — the highest remaining ceiling:** re-dump the LS Pine indicator's *continuous oscillator value* (conviction magnitude) at each flip; it's the one feature that grades the signal itself, and everything tested here only grades the *context*. Pair with a 2-feature regime gate (ltAlign × negative-gamma). The per-trade ceiling beyond that looks thin — this signal is largely efficient.

---

## Phase 1 follow-up — LT-level GEOMETRY (2026-06-21): DEAD END

Drew's idea: now that LS×LT sentiment alignment works, mine the LT *levels* (over/under spot, proximity, headroom) for hidden edge. Built direction-aware geometry from the 5 levels/bar: stop-side backstop, target headroom, flip-at-level confluence, stack position (`05-build-lt-geom.js`, `06-lt-geom-analyze.py`).

**Per-trade signal looked real:**
- `targetBlocked` (an LT level inside the TP path): PF 1.35 vs 1.66 clear. On top of ltAlign: PF 1.78→1.85 keeping 81% of trades.
- flip-at-level only works *conditioned on* ltAlign (PF 1.96) — neutral/slightly negative standalone (PF 1.53). Genuine but interaction-only.
- All numeric geometry features weak (|corr|<0.03). Edge, if any, is binary direction-aware geometry, not distance (raw `ltDist` was null).

**But it does NOT survive the FCFS causal test** (wired `--lstb-require-lt-target-clear`):

| variant | trades | PnL | WR% | PF | Sharpe | maxDD% |
|---|--:|--:|--:|--:|--:|--:|
| ltAlign (best) | 4259 | $238,661 | 74.4 | 1.84 | **23.22** | 1.67 |
| targetClear alone | 5457 | $245,952 | 72.5 | 1.62 | 19.61 | 2.09 |
| ltAlign + targetClear | 3612 | $205,323 | 74.3 | 1.85 | 20.69 | 1.93 |
| ltAlign + minR5 (ref) | 3635 | $218,311 | 75.3 | 1.93 | 22.13 | 1.41 |
| ltAlign + targetClear + minR5 | 3142 | $189,958 | 75.2 | 1.93 | 20.09 | 1.59 |

Stacking targetClear on ltAlign leaves PF flat (1.84→1.85 = noise) but **drops Sharpe 23.2→20.7, raises DD 1.67→1.93, and gives up $33k.** Same against ltAlign+minR5 (Sharpe 22.1→20.1, worse on every axis). The "blocked-target" trades weren't destroying realized value in sequence — removing them just thins the book and hurts the risk-adjusted curve. **Verdict: LT-level geometry is a dead end; ltAlign (sentiment) remains the sole deployable edge.**

**Implication for Phase 2:** the working lever is LT *sentiment*, not LT *levels*. So a multi-timeframe pull should chase **sentiment** (is 5m a less-stale gate than 15m? does multi-TF agreement beat single-TF?), NOT level geometry. That's the only Phase-2 worth Drew's data pull.

---

## Phase 1b — LT level DYNAMICS + flip-at-level (2026-06-21)

Drew pushed back: maybe we mis-interpreted the levels (static snapshot only) — try **1m LT** and the **over→under spot dynamics** (crossing, migration). Two findings:

**(1) A price-space phantom — caught and killed.** First dynamics pass used the 1m file's `sentiment_raw` column as spot. But `sentiment_raw` is UNCONVERTED continuous space (≈ raw + Σroll-spread, ~+210pt) while the `level_1..5` are raw (parse-lt-export.js converts them via the rollover log). The ~950pt mismatch produced a fake `nearAbove` edge (corr −0.097, top-quintile PF 3.51) and "93% of levels below spot." Re-running **raw-levels vs raw-close killed it** (corr −0.002, naNow spread balanced 0–5). Logged as `memory/lt-1m-price-space-gotcha.md`. The levels are NON-repainting (fixed at bar close, per Drew), so proximity features are causal.

**(2) flip-at-level — the first LT-level edge that SURVIVES FCFS.** In corrected raw space, a flip firing within ≤0.5 ATR of a 1m LT level, on top of ltAlign, ran PF 1.99 per-trade keeping 48% of aligned trades. Engine-confirmed (`--lstb-require-flip-at-level`, needs `--lt-1m-file`):

| variant | trades | PnL | WR% | PF | Sharpe | maxDD% |
|---|--:|--:|--:|--:|--:|--:|
| ltAlign (incumbent) | 4259 | $238,661 | 74.4 | 1.84 | **23.22** | 1.67 |
| flipAtLevel alone | 3434 | $157,941 | 72.4 | 1.64 | 15.13 | 2.05 |
| ltAlign + flipAtLevel (0.5 ATR) | 2153 | $138,536 | 75.1 | **2.00** | 15.73 | 1.91 |
| ltAlign + flipAtLevel (0.75 ATR) | 2752 | $168,965 | 75.0 | 1.94 | 18.69 | **1.52** |

Unlike targetClear (PF went flat under FCFS), **flip-at-level's PF bump is real and held** (2.00 / 1.94), train/test stable (a075: H1 PF 1.98, H2 1.92). So the **LS×LT confluence is genuine — LS flips at LT levels are higher-quality trades** (Drew's original "they work together" thesis, confirmed at 1m resolution).

**BUT it still doesn't beat ltAlign on the risk-adjusted frontier:** halving the trade count craters Sharpe (23.2→15.7 at 0.5 ATR, 18.7 at 0.75) and gives up $70–100k — the same diversification-loss tax every trade-thinning filter pays. The 0.75-ATR variant is the sweet spot and has the **lowest DD of any config (1.52%)**.

**Net verdict on LT levels:** static geometry = dead end; dynamics = phantom; **flip-at-level = real but an overlay** (WR/PF/DD-max small-account option, not a Sharpe upgrade). **ltAlign remains the deployable leader.** The real prize from this pass is knowledge: the LS×LT level confluence is genuine, which strengthens the case that **multi-timeframe LT *sentiment*** (Phase 2) is the direction with the most remaining upside.

## Code changes this pass (backward-compatible, dormant unless enabled)
- `shared/strategies/ls-flip-trigger-bar.js`: new optional `requireLtAlign` param (DEPLOY THIS) + `requireLtTargetClear` (dead end, leave off). Both read `marketData.ltLevels` (engine) / `liquidityLevels` (live); fail-open when absent. No behavior change unless set.
- `backtest-engine/src/cli.js`: new `--lstb-require-lt-align` (keep) + `--lstb-require-lt-target-clear` (dead end) flags.
- Files: `research/ls-flip-metalabel/` (01–06 + run-*.sh + outputs). Nothing deployed.

## Code changes this pass
- `shared/strategies/ls-flip-trigger-bar.js`: new optional `requireLtAlign` param (reads `marketData.ltLevels.sentiment`; fail-open when absent). Backward-compatible.
- `backtest-engine/src/cli.js`: new `--lstb-require-lt-align` flag.
