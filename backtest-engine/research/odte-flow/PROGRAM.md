# 0DTE-Flow → Index-Futures program

**Started 2026-07-23 (Drew pivot).** Thesis: 0DTE options flow in SPX/SPY/QQQ drives (a) the **opening range**
and (b) the **day-to-day levels where indices mean-revert**. Test how that flow moves ES/NQ.

## Guardrails from prior work (do NOT re-run these dead ends)
- **Naked GEX walls / all-OI GEX levels = PLACEBO-EQUIVALENT** as barriers/pins (58k-episode study; also R1
  rejection null; Wave-A "GEX not walls at 1m"). Static gamma strikes carry no edge over round/random levels.
- **GEX state features invert sign every year** 2023→2026 (causal-gex-screen). Do not sweep state conditioners.
- **What survived = FLOW-SIGNED dealer gamma** (quote-rule aggressor → dealer inventory → key off the SIGN).
  DWF v1: dealer-long-gamma wall after flat stall → fade (PF 1.33–1.53). 0DTE-share AMPLIFIES.
- Standing hypothesis this program tests head-on: *"0DTE growth eroded daily-OI GEX bindingness"* — i.e. the
  binding positioning is 0DTE-specific and must be measured from SIGNED FLOW, not OI snapshots.

**Implication:** channel Drew's "mean-reversion levels" toward **0DTE-specific, flow-signed dealer gamma
regimes**, NOT static gamma strikes. Placebo controls (round-number + random levels through identical
machinery) are MANDATORY on every level claim.

## DATA REALITY (inventoried 2026-07-23) — the binding constraint
| Underlying | 0DTE signed flow? | What we have |
|---|---|---|
| **QQQ → NQ** | **YES (clean, ready)** | `flow/qqq/{signed-flow,dealer-strikes}` 2025-01→2026-01 (quote-rule, DTE buckets incl `pos_dte0_5`); `iv/qqq/qqq_atm_iv_1m.csv` 1-min 0DTE ATM call/put IV 2025-01→2026-06; NQ 1m/1s + `gex/nq-cbbo-causal` |
| **SPX → ES** | **NO — data wall** | `options-trades/spx` + `cbbo-1m/spx` are **`SPX` monthly root ONLY (zero SPXW)**; SPX 0DTE trades under SPXW which we don't hold. Signed-flow builder written+validated (`01-build-spx-signed-flow.py`, 100% BBO match) but **PARKED pending SPXW tape purchase**. |
| **SPY → ES** | degraded (OI only) | `statistics/spy` daily per-contract OI incl same-day expiries (0DTE OI ~4.7k records/day); unsigned → OI-based only (the weaker path), usable as an ES cross-check |

**Primary testbed = QQQ→NQ.** ES cross-check = SPY 0DTE OI (degraded). True SPX→ES signed-flow cross-validation
needs an **SPXW data purchase** — flagged, not spent; justify only if QQQ→NQ shows a real effect.
QQQ↔NQ mapping validated ≤3bps (per R1); NQ/QQQ ratio available per-day from `gex/nq` JSON spots.

## Hypotheses (census, placebo-controlled)
- **H1 Opening range ← pre-open 0DTE positioning.** Overnight-held 0DTE dealer book (exp==D, as-of D-1 close,
  knowable pre-open): does its net-gamma SIGN predict OR width (long-gamma→tight/pinned, short-gamma→wide/trend)?
  Do OR high/low cluster at 0DTE dealer-gamma strikes (mapped to NQ) vs placebo? Does sign predict OR hold vs break?
- **H2 Intraday mean-reversion (pin) ← 0DTE gamma sign.** On +0DTE-gamma days does NQ revert toward the
  max-0DTE-gamma strike; on −gamma days trend away? (0DTE-signed, not all-OI; placebo = random/round strike.)
  Needs intraday 0DTE inventory accumulation (Phase 0b) for the sharp version.
- **H3 Close-drift charm ← 0DTE.** Is B4a (our one confirmed edge: pre-close continuation 15:00→15:30)
  conditioned/strengthened by 0DTE gamma sign/magnitude (charm hedging into close)? Explain + extend.

## Phases
- **P0 infra:** QQQ 0DTE daily features (this step) → intraday 0DTE inventory (0b, if H1/H2 live). SPX parked.
- **P1 census:** H1/H2/H3 characterization, placebo-controlled, quarter-stability (only ~1yr flow → quarters).
- **P2:** 1s-honest shaping of survivors on NQ; SPY-OI ES cross-check; SPXW purchase decision.

Sample caveat: signed-flow window is 2025-01→2026-01 (~1 year, ~250 days). Report per-QUARTER, not per-year.
Every survivor must clear placebo + quarter-stability before any 1s shaping.
