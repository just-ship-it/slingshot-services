# GammaLab vs our GEX — parity results (2026-08-12)

Comparison: GammaLab prompt-pulled QQQ dealer gamma daily series vs our
QQQ-derived NQ GEX (`data/gex/nq-cbbo-causal`), our snapshot nearest 16:00 ET
converted to QQQ strike space. Overlap 2026-02-23 → 2026-06-15, 79 trading days.
Script: `01-parity-screen.py`; per-day rows: `parity_daily.csv`.

## Headline

**Aggregate dealer gamma: near-identical reads from two independent methodologies.**

| Metric | Result |
|---|---|
| Sign agreement (pos/neg gamma day) | **76/79 (96%)** |
| Spearman corr of values | **0.944** |
| Pearson corr | 0.942 |
| Negative-gamma days | theirs 39/79, ours 36/79 |

The 3 sign mismatches (2026-02-25, 05-15, 05-18) all have |GammaLab gex| < 100M
— near-zero boundary days. On days where their reading is decisive (|gex| ≥ 100M),
agreement is 100%.

This is meaningful because the two pipelines share almost nothing: theirs is
trade-classification-based dealer positioning from (presumably) OPRA prints;
ours is OI-based CBOE GEX with cbbo IV. Agreement at 0.94 rank correlation is
strong external validation of our aggregate gamma calc — and vice versa.

Magnitudes differ by a scale factor (ours runs ~5-7x larger on big days —
different notional conventions + positioning assumptions). Use sign/rank only.

## Gamma flip level: methodology-sensitive, weakly comparable

n=42 (our flip is null on deep-negative days with no zero-crossing; theirs is
always populated — they evidently extrapolate one).

| Metric | Result |
|---|---|
| Mean abs diff | 21.3 QQQ pts (3.1% of spot ≈ ~870 NQ pts) |
| Median bias | −4.7 pts (theirs slightly below ours) |
| Level corr | 0.833 (mostly both tracking spot) |
| **Day-over-day change corr** | **0.321** — weak |

Flip *placement* is not robust across methodologies. Consistent with our long
history of GEX-level trade anchors failing placebo tests: the level is a
modeling artifact; the sign/regime is the real quantity.

## Walls: no correspondence

n=22. Call wall mean abs diff 35.7 pts (within-1% only 2/22); put wall 75.6 pts
(0/22). Their walls are coarse and sticky (pinned at 700/800/660/600 for weeks).
Do not use their walls for anything.

## Addendum (2026-08-12): were their flip levels meaningful? — NO

`02-flip-level-reaction.py`. Point-in-time honest: flip published at D close
tested as a level on D+1 (NQ raw-contract 1m, RTH, per-hour primary filter).
Side-matched placebo = same-day offsets at ±0.3%/±0.6%. Screening study
(reaction magnitudes), not a fill-simulated strategy.

- **Their flips were barely ever in play**: touched on only 7 of 77 test days
  (ours: 5/77) — the flip usually sits too far from next-day price to matter.
- Touch reaction (30/60m repel) indistinguishable from placebo:
  real +42.5±48.5 pts vs placebo +30.4±13.8 (r30); bounce rate 57% vs 61%.
- Open-above/below-flip → day direction: real 57% vs placebo 59% — the
  apparent "accuracy" is drift beta, present at offset levels too.
- Head-to-head on days both flips were touched: n=1, unusable.

9th consecutive null for GEX-level reaction, now including a trade-classified
vendor flip. Closes the question: ignore their flip levels along with walls;
their only validated quantity is aggregate gamma sign/rank (which duplicates ours).

## Addendum 2 (2026-08-12): SPX delta-flow screen — NULL at current sample

`03-delta-flow-screen.py` + inline K×H sweep. Series: `data/gammalab/
spx_net_delta_daily.csv` (2026-05-05 → 2026-08-12, their full history).

Series defects found & handled: holiday rows stamped with values (May 25,
Jun 19, Jul 3 — dropped); re-basing breaks in the cumulative (Jun 4 +390M,
Jun 22 −232M, Jul 20 −73M ≈ 10-50x median daily change — dropped as
recomputes); live-day row unsettled (dropped).

Signal = daily change of net_delta (and K-day sums, K∈{3,5,10}) vs SPY
forward close-to-close returns (H∈{1,3,5}), clean n=64 (effective less at
higher K/H). Result: ICs small and sign-unstable across the grid (−0.15 to
+0.08), all circular-shift p ≥ 0.39. Best single cell (d1 vs c->c, IC +0.077,
tercile spread +0.20%/d) is far from significance.

Verdict: no usable signal at n≈60. NOT a refutation of the dealer-flow thesis
— the sample is 3 months of one regime and the series has integrity breaks.
Action: keep accumulating via weekly archive pulls; re-screen at n≥150; ask
GammaLab support for deeper/point-in-time history and the re-basing dates.

## Addendum 3 (2026-08-12): short-basket screen — FIRST SCREEN-POSITIVE

`04-short-basket-screen.py`. Series `data/gammalab/short_basket_daily.csv`
(2025-08-14 → 2026-08-12, n=250, gapless, holidays properly absent — their
best-plumbed table). Basket beta vs SPY: 2.18.

Grid: {rE1, rW1, spread1, excess1, excess5} × H∈{1,3,5} fwd SPY close-close.
Only surviving family: **excess1** = basket 1d return minus beta×SPY
(beta-adjusted risk-appetite impulse):

- H=3: IC +0.145, circular-shift p=0.02 (n=246); H=5: +0.119, p=0.05
- Split-half H=3: 2025H2 +0.192, 2026H1 +0.105 — same sign both halves
  (H=5 dies in second half → H=3 is the cell)
- Terciles (H=3): lo −0.045% / mid +0.332% / hi +0.415% per 3d — monotone.
  Read: shorted names underperforming beta-adjusted (risk-appetite
  deterioration) → SPY flat/negative next 3d; outperforming → +0.4%/3d.

Caveats: single vendor series, 1 year / ~2 regimes, in-sample full-sample
beta, 12-cell selection (p=0.02 best cell ≈ borderline after selection).
SCREEN-GRADE ONLY.

Promotion path (if pursued): (1) replicate the basket ourselves from FINRA
short-interest data — free, extends history YEARS back, removes vendor
dependence; that replication is the real test. (2) rolling out-of-sample
beta. (3) NQ/ES targets + book-conditioner framing (fits internals/breadth
conditioner family, same 14:40-15:00 ET decision cadence as PCC ladder).

## Implications

1. **Our GEX pipeline is externally validated** at the aggregate level by an
   independent vendor. Increases confidence in PCC/regime work that conditions
   on gamma sign.
2. **Their aggregate gamma adds little incremental info over ours** (0.94 rank
   corr) — not a new data axis. The genuinely new GammaLab axes remain:
   SPX delta flow (trade-classified, we cannot compute), dark pool notional
   (30-day retention — needs frequent archiving), short basket, vol surface.
3. Our `nq-cbbo-causal` generator leaves `gamma_flip` null when the profile has
   no zero-crossing (31 of 80 days in this window, incl. nearly all of March
   2026). Any consumer of that field must handle nulls.
4. Our GEX data ends 2026-06-15 — regenerate Jun 16 → present before extending
   this comparison or any 2026 GEX-conditioned research.
