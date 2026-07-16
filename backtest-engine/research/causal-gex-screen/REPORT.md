# R1 — Causal GEX/IV predictive screen (ground-zero alpha search)

**Date:** 2026-07-11 | **Data:** causal `gex/nq` snapshots, intraday-cbbo-IV segment (2025-01→2026-06), 20,457 snapshots; NQ primary-contract 1m forward returns, roll-censored.
**Protocol:** discovery = 2025 (14,186 rows); **2026 holdout untouched** until a final shortlist exists. 51 feature×horizon tests → Bonferroni p* ≈ 1e-3. Quarterly sign-stability required.

## Headline: real material survives the lookahead removal

Survivors (Bonferroni-significant AND quarter-stable, 2025 discovery):

| Feature → target | IC | p | Decile spread (log-ret %) | Notes |
|---|---|---|---|---|
| **abs_flip_dist_pct → r4h** | **+0.104** | 1.7e-22 | **+0.187** | THE standout. Also r1h (+0.060, p=1.8e-8, stable) and r15m (+0.030). Strongest in RTH morning (session IC **+0.186**). Far from gamma flip → positive drift; near flip → chop/weakness. |
| iv → r4h | +0.045 | 1.5e-4 | +0.245 | High ATM IV → positive 4h returns (vol risk premium shape). Stable. |
| call_wall_dist_pct → r4h | +0.045 | 8.1e-8 | +0.062 | More room below the call wall → better returns (pinning release). Stable. |
| wall_gex_ratio → r4h | −0.044 | 1.9e-7 | −0.049 | Call-side gamma dominance → weaker forward returns. Stable. |
| gamma_imbalance → r4h | −0.042 | 8.2e-7 | −0.080 | Same direction as wall_gex_ratio (they're cousins). Stable. |

Significant but NOT quarter-stable (parked): near_res_dist_pct (+0.057 r4h, Q4 flips), log_total_gex_abs (−0.053 r4h, sign flips Q1/Q4), near_sup_dist_pct.

Dead in this screen: flip_present, total_gex_sign alone, put_wall_dist, top_sup/res_share, iv_skew, iv_chg_15m/1h, all r15m-only relationships except abs_flip_dist.

## Interpretation

- The signal concentrates at the **4h horizon** and in **RTH morning** — slow positioning drift, not a scalp. Consistent with the gamma-clock finding that gamma effects are session-structured.
- `abs_flip_dist` is UNSIGNED distance: the market drifts up when it's far from the flip point in either direction, and chops/bleeds near it. This is exactly the "near gamma-flip = −10.5pt race deficit" geometry lgpr's Phase-2 found independently on contaminated data — the mechanism apparently survives causality.
- The five survivors are 2-3 effective factors (flip distance; IV level; call-side-gamma dominance family).

## Caveats

- **Overlapping samples:** 15-min sampling of 4h returns → ~16× overlap; true p-values are far weaker than printed. Quarterly sign-stability and decile spreads are the real evidence here. Non-overlapping/event-based re-test is step R2.
- Decile spreads are gross log-return %, not tradeable-net numbers.
- 2023–24 (prevday-IV segment) not yet screened — different IV regime, run after regen completes.

## R2 (non-overlapping re-test, 2025): PASSED

Three disjoint daily sample windows (09:30, 14:00 materialize). Survivors sharpened: abs_flip_dist IC +0.133 (p .019, n=310), gamma_imbalance −0.110, wall_gex_ratio −0.097, log_total_gex_abs −0.092. **iv died** (R1 iv signal = overlap inflation).

## Strategy matrix (2025 discovery, 212 configs, 1m sim): strong plateau

Top: LONG flip≥P90+imb≤P50 RTH-am 4h stop100 (PF 2.67, Shp 8.29); SHORT flip≤P20+imb≥P80 day EOD stop100 (PF 2.95); volume variant LONG flip≥P80+res≥P50 day (158tr, PF 1.82). Broad neighborhoods PF 1.8–2.7. **Control: unconditional RTH-am long 2025 = NEGATIVE (PF 0.97, DD $55k)** — conditioning did all the work in-sample.

## 1s-honest validation (2025): PASSED

F1 42tr/WR 59.5/$35,167/PF 2.09/Shp 6.22 (PF −22% vs 1m — intrabar stops); F2 47tr/$51,897/PF 2.95 (byte-stable); F3 154tr/$86,569/PF 1.85 (matches).

## Pseudo-OOS 2023–24 (prevday-IV segment): YEAR-UNSTABLE

F1: 2023 PF 3.27 / 2024 PF 0.84. F2: 2023 PF 0.35 / 2024 PF 2.02. F3: fades to ~1.1. Same picture under fixed-2025 and segment-local thresholds. Confound: static prior-day IV = degraded features (can't separate "regime luck" from "needs intraday IV").

## 2026 holdout (one-shot unseal, same-regime cbbo IV): FAILED

F1 n=16 PF 1.20; F2 <15 trades; F3 PF 0.98 — while unconditional long made $40k/PF 1.22. Factor-level check on 2026: **the 2025 IC structure inverts** (gamma_imbalance −0.042→+0.033, wall_gex_ratio −0.044→+0.042, call_wall_dist +0.045→−0.044, abs_flip_dist ≈ 0).

## Conclusion (2026-07-11)

**Causal GEX state-features (flip distance, imbalance, wall geometry as snapshot conditioners) have NO year-stable predictive structure at 15m–4h horizons.** Each year 2023–2026 carries its own correlation signs. The 2025 in-sample result — despite pre-validated ICs, non-overlap re-test, honest 1s fills, and a negative control — did not generalize. This is consistent with: gfi's edge being pure lookahead; lgpr's 2026-negative watch item; DeepDive-report accuracy decay into 2026. Hypothesis for the drift: 0DTE flow growth makes daily-OI-based GEX progressively less binding.

**What remains alive:** level-INTERACTION mechanisms (touch/fade/break at walls — glf PF 1.44 live-default on clean cbbo data; wick-fade absorption; lgpr barrier-geometry pending causal rerun). The alpha hunt should pivot from state-conditioners to event mechanics at causal levels. **Open decision: ~$220 QQQ cbbo 2023-24 backfill** would give uniform intraday-IV features across 4 regimes — the only way to fully close the "does the state edge exist with proper IV" question (also needed for the Databento parity plan regardless).

## Level-touch event study (09, all years, 12,297 events): year-stable structure EXISTS

- **Broken-resistance retest (res, approach-above): reject-biased + positive fwd60 in ALL 4 years**, amplified with no LT confluence (fwd60 +0.016/+0.025/+0.122/+0.064% by year). The one directional cell stable everywhere.
- Support wick-bounce: 1.4–1.8× bounce:break odds all years, but flat 60m drift (scalp-shaped).
- Wick-only touches reject more than close-throughs in every cell/year (absorption mechanism confirmed on causal levels).
- **Gamma-flip touches: nothing** — flip is a regime boundary, not a hedging wall.

## Shaping (10): retest-long REAL but modest; support scalp DEAD

- **A-retest-noLT (long at touch, stop 25 below level, 2h time exit): 688tr / $48,344 / PF 1.22 / DD $17,718 / Sharpe 1.33, all years positive.** Neighborhoods PF 1.1–1.25. No segment (prevday vs cbbo IV) dependence.
- Regime cut (pre-registered: continuation prefers neg gamma): PF 1.76 but n=72, 2025-concentrated → REJECTED on stability.
- B support-bounce scalp: ALL configs negative after $4+1pt costs (echoes gex-touch-flow dead end).

## lgpr causal reruns

v1 full window: 512tr / $60,998 / PF 1.22 / Sh 0.95 / DD 16.15% (vs void gold PF 2.04/Sh 4.22/DD 4.73). Intraday-IV segment only (2025-01→2026-06): 183tr / PF 1.25 / Sh 1.14 — **no IV-fidelity dependence**; residual mechanism edge ≈ PF 1.22–1.25 ungated. v1-ES gate = remaining path (causal gate rebuild in progress).

## Next experiments queued

1. QQQ cbbo 2023-24 backfill (purchased $197) → uniform intraday-IV regen → re-run state screen + retest + lgpr on uniform data.
2. **Per-strike CEX/VEX walls**: generator computes charm/vega per contract but only emits totals — extend snapshot schema on the next regen, then repeat the touch study on charm walls (expiry-driven dealer flow; Drew's GEX/CEX/IV thesis).
3. v1-ES causal verdict.

Files: `01`–`10` scripts, `features.csv` (45,701 rows, segment-tagged), `matrix-discovery.json`, `validate-1s.json`, `touch-events.json`, `shape-touch.json`.

## Charm/vanna investigation (11, 2026-07-12): NEGATIVE — no incremental alpha

Per-strike CEX/VEX walls added to the generator (top-5 |magnitude| per side, signed, futures-translated; emitted in `data/gex/nq-cbbo-causal`). Two pre-registered tests:

1. **CEX-wall touches** (2,700 events, GEX-overlap control): the only year-stable cell (neg-charm walls approached from above: fwd60 +0.047/+0.024%) is the broken-resistance retest wearing a charm costume (neg charm concentrates at above-spot ATM strikes). Positive-charm cells flip sign between years. Nothing charm-SPECIFIC separates from GEX-wall behavior.
2. **Charm flow → close drift** (total_cex at 14:00 ET vs 14:00→15:45 return): 2025 IC −0.055 (p=0.39), 2026 IC +0.148 (p=0.12) — null both years, opposite signs.

CLOSED. Caveat: 18-month window (2025–26), B-S-approx greeks from OI×quotes; a dedicated dealer-positioning dataset could reopen this, our data cannot.
