# Deck-Filter Research — Capital Flows decks → FCFS book tweaks + new strategy

Source ideas: the Capital Flows "theDesk / Mindset Corner" slide decks (see `trading-decks/capital-flows/`).
Goal: turn deck *concepts* into codifiable levers on the production 4-strat NQ FCFS book (long/short
filter, lever-up vs skip) and one new backtestable strategy. Each thread gets a hard YES/NO.

**Baseline (validated, reproduced exactly by `lib/engine.js`):** $614,730 / PF 1.77 / Sharpe 10.8 /
maxDD $11,642 / 6,128 trades / test-half PF 2.04. Window 2025-01-13 → 2026-04-23 (train ≤2025-09-30).

Accept test = **PF-over-PnL**: full PF up, Sharpe not materially worse, maxDD not worse (≤+2%), AND
test-half PF beats baseline (OOS). PnL alone never qualifies.

Shared infra: `lib/annotate.js` (per-trade causal features) + `lib/engine.js` (generalized causal
FCFS with per-signal size multiplier; skip frees the slot). `lib/build-nq-atr.js` builds the NQ 1m
ATR cache. Control: `00-verify-baseline.js` reproduces $614,730 to the dollar.

---

## A1 — Vol-regime sizing ladder (skip / 1× / 2×)   →   ✅ YES (narrow)

`01-a1-sizing-ladder.js`. Deck: `volregime` ("constant risk not constant size", "size is a staircase").

**Finding:** Uniform or lumpy-strategy levering FAILS — it raises PnL and PF but expands $-drawdown
~proportionally and *erodes Sharpe* (concentrating size into the high-vol "favorable" regime is
anti-diversifying; those trades carry higher per-trade variance). Sharpe is ~scale-invariant, so the
Sharpe drop is the tell.

The one thing that works: lever **only the low-variance, high-Sharpe strategy (lstb)** in its
favorable vol regime (`ivPct≥0.5 & ivChg>0`). This raises PF and Sharpe with **maxDD exactly flat**
($11,642) and OOS-stable — the book's worst-drawdown window doesn't involve lstb-favorable trades, so
scaling them adds PnL/Sharpe without touching peak-to-trough.

| Config | PnL | PF | Sharpe | maxDD | test PF |
|---|---|---|---|---|---|
| baseline | $614,730 | 1.77 | 10.8 | $11,642 | 2.04 |
| lever lstb-fav 2× | $657,782 | 1.80 | 11.2 | $11,642 | 2.06 |
| **lstb-fav 2× + downsize lumpy-unfav 0.5×** | $646,423 | **1.85** | **11.5** | **$11,642** | **2.09** |
| lever lstb-fav 3× | $700,835 | 1.83 | 11.4 | $11,642 | 2.07 |
| CTRL lever *all* lstb 2× (no regime) | $832,927 | 1.71↓ | 12.7 | $13,780↑ | 1.91↓ |

**Control proves the regime does the work:** regime-agnostic lstb levering dilutes PF and blows out
DD + test-PF. Only the regime-gated form passes.

**Verdict: YES, narrowly.** Actionable rule: lever lstb to 2× when `ivPct≥0.5 & ivChg>0`; keep the
lumpy GEX strategies at 1× (optionally downsize them 0.5× in their unfavorable regime). Do NOT lever
indiscriminately. Improvement is modest (PF +0.08, Sharpe +0.7, +$32k, DD flat).

**Caveats:** the DD-flat result is partly an artifact of *where* the historical max-DD fell; forward,
an lstb-fav cluster could participate in a drawdown, so Sharpe (+6%) is the more trustworthy gain than
the literal DD-flat. 2–3× means 2–3 NQ contracts on those signals (margin/capital implication).

---

## A2 — Stop-vs-realized-vol noise gate   →   ❌ NO

`02-a2-noise-gate.js`. Deck: `volregime` ("your stop didn't move, the range did"). Feature
stopAtr = stopPts / NQ-1m-ATR-14. Hypothesis: low stopAtr (stop inside the noise band) => noise-stopped.

**Finding: the hypothesis is INVERTED for this book.** Diagnostic — lstb (tightest stop, where the
effect should be strongest) sorted by stopAtr quintile is cleanly *monotonic the wrong way*:

| lstb quintile | stopAtr | WR | PF | total$ |
|---|---|---|---|---|
| Q1 (tightest stop vs noise = highest vol) | 0.21–0.83 | **78%** | **2.46** | $106,678 |
| Q3 | 1.17–1.61 | 72% | 1.62 | $57,810 |
| Q5 (stop far outside noise = low vol) | 2.23–8.91 | **66%** | **1.16** | $18,041 |

lstb's low-stopAtr trades WIN at 78% — they are NOT being noise-stopped; they reach target. `stopAtr`
is just a proxy for vol regime (low stopAtr ⟺ high ATR ⟺ high vol), and lstb likes high vol (see A1).
So the right move is A1's (lever those up), the *opposite* of skipping. GEX strategies show no
monotonic pattern (noise). Every skip config degrades the book (PF 1.77→1.62–1.73, all fail verdict).

**Verdict: NO.** The noise-band concern doesn't manifest on this book; the feature inversely tracks
vol regime, which A1 already exploits the correct way. (Only the skip arm is testable from the log;
the "widen-stop" arm has nothing to fix since the high-vol trades already hit target at 78% WR.)
Useful negative: A2 cross-validates A1 from a second angle.
## A3 — Skew + gamma directional gate   →   ✅ YES

`03-a3-skew-gamma.js`. Deck: `positioning` ("don't fade into a crowded one-sided book"). Operationalized
as gamma sign (NQ total_gex) + put/call skew (ivSkew = put_iv-call_iv) as the positioning read.

**Finding: the gamma-sign gate on the FADE strategy (glf) works.** Diagnostic confirms the prior —
glf in positive gamma PF 1.60 vs **negative gamma PF 1.29** (fades mean-revert when dealers are
long-gamma; degrade in negative/trending gamma).

| Config | PnL | PF | Sharpe | maxDD | test PF |
|---|---|---|---|---|---|
| baseline | $614,730 | 1.77 | 10.8 | $11,642 | 2.04 |
| **H1: glf → positive-gamma only** | $587,772 | **1.83** | 10.9 | $11,565 | 2.05 |
| **H2b: glf skip shorts in pos-gamma** | $604,562 | 1.80 | 10.9 | **$9,570** | **2.08** |
| H2: skip *all* shorts in pos-gamma | $489,557 | 1.76 | 10.0 | $7,445 | 1.99 ❌ |

**Verdict: YES.** Two robust forms: H1 (glf positive-gamma-only) maximizes PF (1.83); H2b (glf skip
shorts in pos-gamma) gives the best OOS test PF (2.08) and lowest DD ($9,570). Both OOS-stable across
all 5 quarters, modest PnL cost. The broad "skip all shorts in pos-gamma" prior does NOT hold
(over-filters). Skew is secondary/weaker than gamma (glf better in high put-skew, PF 1.71 vs 1.13, but
only 62% coverage). Skip (not lever) is correct — glf is lumpy (A1: levering lumpy strats hurts).

---

### Bucket A wrap (FCFS book tweaks)
Two of three deck-derived tweaks improve the book, both PF-over-PnL and OOS-stable, and they're
**orthogonal** (A1 sizes lstb up in high vol; A3 gates glf by gamma). Stacked (`04-combined.js`):

| Config | PnL | PF | Sharpe | maxDD | test PF |
|---|---|---|---|---|---|
| baseline | $614,730 | 1.77 | 10.8 | $11,642 | 2.04 |
| **A1 + A3-H2b** (best PnL-preserving) | $642,007 | 1.87 | **11.6** | **$9,570** | **2.12** |
| **A1 + A3-H1 + A3-H2b** (max PF) | $620,302 | **1.91** | 11.5 | **$9,570** | 2.10 |

Stack effect: flat PnL, **PF +8%, Sharpe +6%, maxDD −18%**, every quarter improved (worst quarter
1.46→1.62), train PF 1.76 / test 2.10 → no overfit. This is the deployable Bucket-A deliverable.

A2 rejected (and usefully cross-validated A1). Net deck ideas that survived contact with the data:
*constant-risk sizing* (lever only the low-variance strat, in its vol regime) and *don't fade into
negative gamma*. Recommended deploy candidate: **A1 + A3-H2b** (keeps PnL, best OOS test PF, −18% DD).
## B  — Vol-compression breakout strategy   →   ❌ NO

`research/vol-compression-breakout/` (separate folder; 1s-honest, own SUMMARY.md). Deck: `volregime`
"suppressed vol = compressed spring → trade the expansion." Enter on 1m squeeze release in the
momentum direction; fills/exits walked on 1s OHLC; EOD-flat 15:45.

**Finding: no edge in any of 18 configs** (entry onMin {1,3,6} × 4 exit families). PF 0.77–0.90,
negative Sharpe, in BOTH train and test. NQ does not trend out of an intraday squeeze — it weakly
MEAN-REVERTS, and that reversion is already (better) harvested by the production GEX-level-fade. A
breakout is the wrong side of NQ intraday — matches the parked intraday-momentum "NQ breakouts
struggled" result. 1s-honesty verified (fill-bar assertion 0 violations; negative results can't be the
inflating fill-bug; invert-symmetry rules out a labeling bug).

**Verdict: NO.** Reusable harness if revisiting with a mean-reversion thesis or a different vehicle.
