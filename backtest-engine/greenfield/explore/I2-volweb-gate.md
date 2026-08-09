# I2 — Vol-web / dispersion / VIX-tailwind gates on the book sleeves

**Date:** 2026-08-08 · **Scripts:** `I2-volweb-gate.py`, `I2b-stress-robustness.py`
**Data:** free TV daily vol complex (`data/macro/`: vix, vxn, vvix, vix9d, vix3m,
move, ovx, gvz, cor1m, cor3m — 2001-2011 starts; 1h variants 2020+) joined to
honest `book-*-daily.csv` PnL. Closes out the 6-Pillars article review (I1 =
internals). ~46 effective tests, permutation placebo on each, per-year splits.

## Headline: ONE factor survives — PCC does better in STRESS regimes

All five p<0.05 hits landed on PCC and point the same direction (they are one
correlated factor, agreement 0.40-0.77): rising implied correlation, inverted
VIX term structure, high VVIX. Sub-threshold members of the same monotone
family: VIX 5d-change T3 (p=0.075), VIX level T3 (p=0.079), web z-dispersion T3.

**Sharpest expression: COR1M 5-day change, top tercile (rising correlation ≳
+2.3pts over 5 days), prior-day close — causal for the 15:00 decision:**

| E3 tercile | n | $PF | avg$ | ATR-norm PF | WR |
|---|---|---|---|---|---|
| T1 falling | 237 | 1.41 | $76 | 1.43 | 54.4% |
| T2 flat | 236 | 1.04 | $10 | 1.11 | 57.2% |
| **T3 rising** | 236 | **1.94** | **$242** | **1.78** | 59.7% |

**I2b structure checks (all passed):**
1. **Scale confound — the make-or-break:** stress regimes have bigger point
   moves, so $-uplift could be pure scale. E3 SURVIVES ATR14 normalization
   (causal prior-session ATR from TV daily; full-n 709; normalized perm-p
   0.038). Discriminating control: **VIX *level* T3 dies normalized (p=0.73)**
   — the factor is genuinely "correlation rising = better edge," not "high
   vol = bigger $." (First-pass normalizer had a TV session-labeling bug —
   futures daily bars are labeled by session OPEN date, so exact-date joins
   drop all Fridays and include the trade day's own range; fixed via bisect
   join + window ending at the prior session.)
2. **Cutoff sweep:** monotone plateau, PF 1.48→1.98 as cutoff rises −2→+3;
   perm-p stabilizes at 0.006 for cutoffs ≥+2. Not a knife-edge.
3. **Lag placebo:** live p=0.009 → lag5 nulls/inverts (0.68) → lag10 null.
   Timely information, not a persistent-regime proxy.
4. **Mechanism-sensible:** rising index correlation = index-level forced flows
   (vol-target/hedging) dominating single-name flow — exactly the tape where a
   late-day index continuation edge should pay. Coherent with R3's late-day
   volume-run survivor.

**Honest caveats:** screening provenance (strongest of a correlated family);
**2024 negative** (T3 −$3,310 vs rest +$2,565) — 5/6 years positive, not
every-year; tercile edge from the joined sample (mitigated by the plateau).

## TRIN × stress overlap (diagnostic, NOT combo tuning)

The I1 TRIN conditioner and E3 stress are complementary (agreement ~0.54):

| | n | PF | avg$ |
|---|---|---|---|
| TRIN-aligned × stress | 140 | **2.20** | $309 |
| TRIN-aligned × calm | 258 | 1.48 | $99 |
| TRIN-misaligned × stress | 98 | 1.54 | $137 |
| TRIN-misaligned × calm | 212 | **0.91** | −$25 |

A clean monotone grid; the "neither" cell (30% of PCC trades) is net negative.
Suggests a sizing ladder (0-1-2 lots) as the shadow-confirm hypothesis — to be
pre-registered, not backfit further.

## Nulls (do not re-sweep)

- **Monday + gap-fade: the ENTIRE I2 battery is null** (term structure,
  VIX change/level, VVIX, vol-web breadth/dispersion/divergence, COR regime).
  Combined with I1: these two sleeves are now fully swept for breadth AND
  vol-regime conditioners — their edges are unconditional. Done.
- **Falling-VIX "systematic tailwind" (article pillar 2): null everywhere**,
  and on PCC the direction is *opposite* (rising vol better — the stress
  factor). The article's mechanism claim is not supported in our data.
- PCC: vol-web z-count/divergence, same-day VXN/VIX-falling alignment
  (p=0.21-0.37; same 2024-inversion signature as I1's ADD/VOLD).
- VIX *level* on PCC = scale artifact (see check 1).

## Status

**6-Pillars article review COMPLETE.** Final tally across I1+I2: two
complementary PCC conditioners (TRIN alignment; rising-COR1M stress), both
candidate-not-deployed, both live-sourceable free (USI:TRIN intraday; COR1M
prior-day close via TV). Confirm path: log both at 15:00 during the production
shadow; pre-register the 0-1-2 sizing ladder; no engine/live changes until the
shadow sample confirms. Monday/gap-fade: unconditional, leave alone.
