# JV-ICT Program Summary (2026-07-22 → 2026-07-23)

**Objective:** Fresh-eyes conversion of Jordan Vera's ICT eBook into a backtestable NQ strategy, clean-roomed from all prior ICT attempts in this repo.

**Verdict: the eBook's mechanical content, faithfully implemented, contains no structure-specific edge on NQ (dev 2021-01-18 → 2024-12-31). Every surviving configuration is explained by NQ upward drift plus selection.** The 2025–2026 locked validation set was never touched.

## What was built (all kept, all reusable)

- `01-METHODOLOGY.md` — page-cited extraction of all 12 lessons; five load-bearing interpretations independently verified against page renders by the orchestrator.
- `02-STRATEGY-SPEC.md` — fully mechanical ruleset; 16-item ambiguity register (2 blocking → parameterized, 14 defaulted).
- `shared/strategies/jv-ict.js` — complete M/W state machines (sweep → close-confirmed MSS → body-to-body fib + OB/IMB zones → resting limit), causal 2-bar-lagged pivots, 1H/4H internal structure tracking, 8 parameter axes, engine-honest `placeboMode` and `smtMode` (ES cross-symbol). Registered as `jv-ict`.
- **Audit status: PASS.** Independent Python re-derivations reproduced 8/8 signals (run-TF) and 5/5 (1H structure, ES SMT) exactly; zero lookahead violations.

## The evidence chain

1. **Round 1 (12 configs):** nothing deployable. IMB confluence = real filter (PF 1.44), OB = anti-signal, longs carry all edge, ALL configs fail 2024 (PF 0.10–0.66). Entry-depth ordering matches the book's naming (Discount 0.64 < Optimal ≈1.04 < Premium 1.09) — the extraction captured something real about *relative* geometry, but not a tradable edge.
2. **Round 2 (book-faithful extensions):** 1H structure alignment doesn't fix 2024 (0.63/0.40). 5m recovers trade frequency (~100/yr) but not edge (≤1.04), and the per-year profile inverts between 15m and 5m — noise-regime resonance. Post-hoc compound (long+imb+premium, PF 2.07, 4/4 years) refuted by its own 5m replication (0.91).
3. **Round 3 (kill tests):**
   - **Placebo:** engine-honest random long limits with matched time-of-day/offset/stop/TP geometry, 20 seeds/arm. Broad long arm (n=78, PF 1.19) = **80th percentile — placebo-equivalent**. The one nominal survivor (long+imb, n=27, PF 2.21, 95th pct, p≈0.10) is the selected max of 12 dev configs, separates only in 2021–2023, and **loses to placebo in 2024** (0.78 vs 1.12).
   - **SMT/pairs (last untested book ingredient):** `require` kills 2023, `avoid` kills 2024; shorts not rescued (0.19/0.35). Sign-flip noise.

## What this does and does not say

- It **does** say: the rules the eBook actually writes down, mechanized faithfully across a 20+ configuration space with honest 1s fills, do not produce a positive-expectancy NQ strategy 2021–2024, and their apparent successes are drift artifacts.
- It does **not** say the source trader didn't make money. The book is underdetermined: no numeric targets, no session rule, no threshold for "A+ setup." The gap between ~1,500 mechanical sweep events/year and a hand-picked few trades/day is where a discretionary edge would live — and that layer is not in the book.

## What would reopen the program (material worth digging up)

Ranked by information value:
1. **A set of his actual called/taken trades** (dates + direction + entry/stop/target — even 30–50 of them). We could measure what his selection function was relative to the mechanical setup universe: that difference IS the missing ingredient, and it's learnable from surprisingly few examples.
2. **Live commentary/recordings** of him choosing one setup over another (reveals the selection criteria directly).
3. Session/killzone habits, news-day behavior, and which HTF levels he actually privileged (PDH/PDL vs opens vs range extremes).
4. Any second document (mentorship notes, Discord pins) with concrete management rules — partials, break-even moves, scaling — absent from the eBook.

Do NOT re-sweep the existing axes; the placebo result closes that avenue.
