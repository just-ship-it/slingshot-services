# I7 — Zarattini ES breakout: INVALIDATED during go-live port (2026-08-09)

**Verdict: the parked "PF 1.94 / Sharpe 2.67" ES edge does not exist on a
clean implementation. Go-live cancelled at the parity gate.** Scripts:
`research/intraday-momentum/09-signal-parity.js`, `10-rebuild-days-primary.js`;
port (kept, inert): `shared/strategies/intraday-momentum.js` (+ engine
registration `zim`, seed util `tv-series-fetcher.js`).

## How it was caught

The live port (primary-contract-filtered everywhere) failed signal parity vs
the research trade list: 108/135 exact, 16 missed, **72 extra** — divergences
clustered around quarterly roll dates. Root cause in the research pipeline
(`02-precompute-rth-1s.js`): pass 1 built the BAND inputs (day open, per-minute
closes, prevClose) with **last-write-wins across contract months** — the
primary filter existed but was only applied to the 1s FILL store. Proof:
2022-09-06 prevClose recorded 3927.25 = thin back-month ESZ2 quote (4-60
lots/min) vs true primary ESU2 3911 (700-3,400 lots/min).

The June research already knew half of this — its own lesson said "never price
fills from days.json mClose" after the Gao/Baltussen phantom — but the bands
kept using the contaminated matrix. Fills were honest; the SIGNAL was not.

## What the contamination did

Back-month quotes trade at a calendar-spread premium, so contaminated
prevClose/mClose systematically LIFTED the band anchor — an accidental
"breakout must also clear ~the calendar spread" selectivity filter, plus
arbitrary roll-window signal deletions. That selectivity WAS the edge:

| Variant (identical honest 1s fills) | n | PnL | PF | Sharpe |
|---|---|---|---|---|
| Contaminated bands (research, "validated") | 135 | $50,538 | 1.94 | 2.67 |
| **Clean primary bands (true implementation)** | 192 | $9,990 | **1.09** | **0.37** |

Clean-band H2 PF 0.89 (second half negative). Explicit-selectivity rescue
sweep (mult 1.5-3.0 × minBreak 0-10, dev 2021-24 vs locked 2025-26): dev and
locked INVERT across neighboring cells; the single both-positive cell
(mult1.5/mb5) is a lone spike with catastrophic neighbors — noise, not a
plateau. **Dead. Do not re-tune further.**

## Status of I4

I4's "re-validated byte-exact" claim is corrected: it validated that the
contaminated pipeline reproduces itself, not that the edge is real. The I4
conditioner nulls are moot (they conditioned artifact trades).

## House lesson (add to the permanent list)

**The primary-contract filter applies to SIGNAL INPUTS, not just fills.** A
band/feature/level computed from unfiltered multi-contract data can smuggle
calendar-spread structure into the strategy and manufacture an edge that
evaporates on the tradable implementation. Port-parity against an
independent reimplementation is exactly the gate that catches this — the
failure mode is invisible to placebo controls, cost models, and 1s-honest
fills, because the contamination lives upstream of all of them.

## Disposition

- Go-live CANCELLED; `intraday-momentum` disabled in strategy-config; the
  data-service ES feed re-enable and dashboard whitelist addition reverted.
- Kept as inert infrastructure: the strategy class (correct implementation),
  engine registration, TV series fetcher (reusable backfill util), clean
  `days.ES.primary.json` rebuild script.
- The 15h full-engine ES run was stopped (its result is predictable ≈ the
  clean replay).
