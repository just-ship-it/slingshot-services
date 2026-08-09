# I1 — Market-internals (breadth) gate study on the book sleeves

**Date:** 2026-08-08 · **Scripts:** `I1-internals-gate.py`, `I1b-trin-robustness.py`
**Data:** free TV internals (`data/macro/{tick,tickq,add,addq,vold,voldq,trin}_{1d,1h,15m}.csv`;
1h → 2020-01, 15m → 2025-01, daily → 1990s). Sleeves = honest 1s-simulated
`book-*-daily.csv` (PCC n=709, Monday n=249, gap-fade n=125, 2021→2026-06).
Study is day-level gating on top of honest PnL → 1s-honest by construction.
PCC trade sides derived from raw NQ 1m (primary contract at 14:59 by volume;
709/709 matched, min |move| 48pt sanity-passed).

## Design

One feature at a time (house rule), causal cutoffs only:
- **PCC** (15:00 decision): same-day internals from 1h bars **closing ≤14:30**
  (full window) and 15m bars closing ≤15:00 (2025+ subset).
- **Monday / gap-fade** (09:30 decisions): prior-day daily internals only.
- Permutation placebo (2000 shuffles) per test; per-year splits; ~13 primary tests.

## Results

### ★ Lead: PCC × TRIN alignment — the one survivor

Pass = TRIN<1 on longs / TRIN>1 on shorts (last 1h bar closing ≤14:30 ET):

| | n | PnL | PF | avg |
|---|---|---|---|---|
| ALL PCC | 708 | $77,165 | 1.45 | $109 |
| **pass (aligned)** | 398 | **$68,950** | **1.77** | $173 |
| fail (misaligned) | 310 | $8,215 | 1.10 | $26 |

perm-p = 0.034. **Pass side positive all 6 years** — including 2024, the only
year base PCC lost (base −$1,215 → gated +$4,195). Drops 44% of trades, keeps
89% of PnL (less time-in-market at same $).

**I1b robustness — all four checks passed:**
1. **Threshold sweep 0.8–1.2:** pass>fail at every threshold; peak at the
   canonical 1.0 (not a fitted value). Not a knife-edge.
2. **Cutoff-time sweep:** monotone strengthening into the decision
   (closes≤12:30 PF 1.56/1.32 → ≤13:30 1.63/1.24 → ≤14:30 1.77/1.10) —
   behaves like real same-day information.
3. **|day-move| tercile control:** separation holds within small/mid/large
   move days (1.54/0.97, 1.78/1.27, 1.88/1.08) — NOT a move-size proxy.
4. **Prior-day-TRIN placebo:** inverts to null (1.33 vs 1.58, p=0.41) —
   stale TRIN carries nothing; the machinery doesn't manufacture edges.

Coherent family support: VOLD alignment (same pressure-quality family) shows
the same direction (PF 1.70/1.04, p=0.053) but fails 2024; ADDQ 15m (2025+)
PF 1.99/0.68, p=0.045 on 19mo only.

**Honest caveats:** 1 of ~13 primary tests at p=0.034 → does NOT survive
multiple-comparison correction on its own; the I1b structure checks are the
mitigant, not proof. Fail side is still PF 1.10 (this is a quality tier /
sizing lever, not a "these trades lose" filter). TRIN is live-sourceable
free (USI:TRIN via existing TV websocket path).

### Nulls (do not re-sweep)

- **PCC:** ADD 1h alignment (p=0.76), VOLDQ (p=0.42), TICK/TICKQ ±1000
  extreme counts (p=0.25–0.76), afternoon ADD slope (p=0.54–0.92).
- **Monday:** prior-day ADD / VOLD / TRIN all null (p=0.49–0.87) — and the
  *misaligned* side is consistently (insignificantly) better, consistent with
  the weekend-risk-premium mechanism (weak Friday → better Monday), not with
  breadth confirmation. Friday-TICK-washout tercile suggestive (T1 PF 1.90)
  but p=0.65.
- **Gap-fade:** prior-day weak-breadth hypotheses all null (p=0.29–0.97);
  prior-day TRIN>1 directionally *anti*-predictive. n=125 underpowered.

## Implications

1. **Candidate conditioner, not yet deployable:** PCC × same-day TRIN
   alignment as a sizing lever (e.g. 2 lots aligned / 1 lot misaligned) or
   quality filter. Pre-registered confirm = track it through the live shadow
   (log TRIN at 15:00 alongside PCC signals) and/or an ES-PCC analog test
   before wiring into sizing.
2. **The ~$130 IQFeed 1m-internals buy is NOT justified yet:** the surviving
   signal works at 1h resolution from free TV data; nothing in I1 demonstrated
   intraday-fidelity (1m) value. Revisit only if a TRIN/ADDQ 15m refinement
   shows the 14:30→15:00 reading materially matters (needs more 15m history —
   accumulating free via `--merge`).
3. Internals daily gates on 09:30-decision sleeves (Monday, gap-fade) are
   dead — breadth carries no overnight-stale predictive value for these edges.
