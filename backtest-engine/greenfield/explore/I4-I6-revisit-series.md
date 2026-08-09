# I4–I6 — TRIN/COR re-look at prior candidates (2026-08-09)

Drew's question after the PCC conditioner success: can TRIN/COR sharpen
anything previously judged real-but-parked or unconverted? Three candidates,
in priority order. Scripts: `I4-zarattini-conditioner.py`,
`I5-lt-state-study.py` + `I5b-lt-state-robustness.py`, `I6-firsthour-breadth.py`.

## I4 — Zarattini ES breakout × TRIN/COR: conditioners NULL, base edge re-validated

Baseline reproduced byte-exact from the intact feature store
(research/intraday-momentum, recommended frozen config): **135 trades /
$50,538 / PF 1.94 / Sharpe 2.67 / maxDD $15.5k**, 2021-02→2026-01, 1s-honest.

Conditioners: COR Δ5d null both directions (p=0.27–0.86; stress tercile AND
calm tercile each look "good" on different cuts = noise signature; 2022
inverts). TRIN null at every causality-respecting reading (first-hour p=0.76,
prior-day p=0.40 and wrong-signed). The n=17 15m-at-entry cell (10/10 wins)
is anecdote. **Verdict: this edge is unconditional.**

**Actionable:** the base edge itself is re-legitimized by the
capacity-constrained doctrine (~$10k/yr/contract, Sharpe 2.67, corr +0.12 to
the book, ES = no NQ slot contention). Candidate book sleeve #5/#6 as-is —
needs engine port + composite book-harness check, not conditioners.
Trade list: `research/intraday-momentum/output/trades-recommended.ES.csv`
(08-trades-export.js).

## I5 — ★ LT levels × COR state: REAL FINDING (pre-registered, placebo-controlled)

Re-cut of the A2 census episodes (111,202 X=5 touch episodes, 2020-12→2026-06,
real LT + matched-random placebos + round-number grid through identical
machinery). Pre-registered hypothesis: rising correlation = forced-flow tape →
levels break; calm → liquidity pools hold.

**Result: the A2 damping survivor (price penetrates less beyond real LT levels
than placebo) is a CALM-REGIME effect:**

| COR Δ5d state | real depth (×vol30) | rand-placebo | real-vs-placebo |
|---|---|---|---|
| calm (≤2.27) | 1.013 | 1.139 | **−11.1%** |
| rising (>2.27) | 1.396 | 1.452 | −3.8% |

Interaction day-perm **p=0.018; p=0.003 excluding tariff week**. Bounce-share
endpoint corroborates in direction (p≈0.05). Robustness (I5b): tercile cut
shows rising as the clear outlier (−0.056 vs −0.121/−0.136); replicates at
X=10; clean 4/6 years (2021 noisy, 2026 partial mixed). TRIN state: nothing —
the regime variable is COR, not intraday breadth.

**Caveats:** effect is specific to the matched-random placebo comparison —
the round-number (grid50) family does NOT show the interaction (round numbers
appear swept even harder in stress); magnitude (~0.12×vol30 ≈ 2.5–6pt of
damping per touch) is a context effect, not a standalone trade.

**Usable as a DESIGN RULE, not a sleeve:**
1. Any logic using LT levels as targets/stops/barriers (DWF structure-target
   overlays, future LT-based exits) should trust them in calm regimes and
   distrust them when COR Δ5d > ~2.3 — in stress tape LT levels are
   placebo-equivalent.
2. Mirror: breakout-through-level constructions should prefer rising-COR days.
3. Same COR feed the PCC ladder already fetches — zero new data cost.

## I6 — First-hour breadth gates: NULL

301 qualifying days (2025-01→2026-06 intersection of 15m internals × primary
1m cache; |first-15m move| ≥0.05%). Base R4 fact confirmed weakly (aligned
continuation to 15:00 = +13.4pt, WR 58%). All five opening-breadth gates
(ADD/ADDQ/TICK-extreme/TRIN/VOLD confirm) null at both horizons (p=0.27–0.97);
TICK-extreme and VOLD point *inverted* (confirmed opens continue LESS —
insignificant, but kills the confirmation thesis). Don't re-sweep at this
sample; the 15m internals archive accrues via `--merge` if we ever want a
bigger window.

## Series verdict

One real finding (I5 LT×COR state rule), one re-validated unconditional edge
(I4 Zarattini base — book-sleeve candidate on capacity doctrine), one null
(I6). The conditioners are not magic dust — they sharpen edges whose mechanism
they touch (index-level forced flow), which PCC and LT-level behavior share
and Zarattini/first-hour do not.
