# Morning Summary — Structural-Magnet Ratchet + BE Handler (Updated)

## Status: BE handler now built (post-morning discussion)

After confirming the live deployment gap (the BE rule was never running on
the broker), built the orchestrator-side enforcement that closes that gap.
Smoke-tested with a synthetic price-stream harness; all scenarios pass.
Details in `be-handler-implementation.md`. **Not deployed.**

The handler is forward-looking for ratchet variants — when you pick one
from the overnight sweep, only the evaluator needs to grow tier logic
(~30 lines). The rest of the lifecycle is in place.



Drew, two waves of work overnight:

**Wave 1** (earlier) — pure-MFE ratchet sweep (28 configs). Conclusion: no
tier configuration beat the BE 70/+5 baseline on aggregate; the best pure
ratchet `s1-m70l40` cost ~15% of PnL for smoother equity.

**Wave 2** (after your "structural levels are smarter" reframe) — built
the magnet-aware ratchet, ran two sweeps (running-mode 15 configs +
fixed-per-tier 8 configs). Findings below.

## Read order

1. **`MORNING-SUMMARY.md`** (this file)
2. **`structural-ratchet.md`** — full magnet-ratchet writeup with both sweeps
3. **`comparison.md`** — side-by-side table across baseline, pure, structural
4. **`top-candidates.md`** — Wave 1 pure-MFE sweep ranking
5. **`today-replay.md`** — yesterday's 5 signals under every variant
6. **`live-deployment-gap.md`** — the orchestrator/broker plumbing finding

## Headline numbers

| Metric | Baseline (BE 70/+5) | Pure s1-m70l40 | **Struct fixed 40%/2h** | Struct running 95%/2h |
|---|---:|---:|---:|---:|
| Trades | 172 | 181 | 175 | 193 |
| Win Rate | 61.6% | 61.9% | 67.4% | 68.4% |
| Profit Factor | **2.99** | 2.61 | 2.47 | 2.08 |
| Sharpe | **6.41** | 5.97 | 3.87 | 3.52 |
| Max DD | 11.3% | 8.34% | 7.58% | **6.99%** |
| Total PnL | **$157,329** | $133,542 | $90,512 | $69,455 |
| Avg Winner MFE | 155.8 | 139.4 | 89.9 | 55.6 |
| Winner Capture % | 71.8% | 69.4% | 72.0% | **91.5%** |
| BE-Clip | 38 | **2** | 14 | 6 |
| Big-BE-Clip | 20 | 14 | 11 | **3** |
| MFE→SL | 8 | 12 | **7** | **7** |
| Giveback $ | $93k | $95k | $59k | **$12.5k** |

## What the data actually says

**The structural-magnet mechanic works as designed, but doesn't deliver the
aggregate edge I expected** on the current entry signal set.

- Wave 1 pure ratchet `s1-m70l40` still leads on aggregate PnL (\$134k) and
  Sharpe (5.97). The structural mechanic is anchored to "more meaningful"
  MFE levels but the engine's aggregate metrics don't notice.
- The **fixed-per-tier** semantic (your intuition: lock at the magnet,
  hold until next magnet) closed most of the structural's earlier PnL gap
  (\$54k → \$91k by switching from running to fixed mode at lower lockPct).
  It's the best structural variant, and the best Pareto on (PnL, DD)
  if you weight DD heavily.
- The **running-mode** at 95%/2h is the smoothness optimum: 91% capture,
  only \$12.5k giveback over 16 months, 6.99% DD. But PnL is \$69k —
  56% below baseline. This is the "small repeated wins" regime you mentioned
  as acceptable, taken to its extreme.

## Yesterday's day (2026-05-14) replay

The exact day that started this conversation. T1 and T3 both had MFE 138+;
T2 was a clean stop. T4/T5 blocked.

| Config | T1 | T2 | T3 | Day |
|---|---:|---:|---:|---:|
| Baseline BE 70/+5 (live) | +$100 | −$1,200 | +$100 | **−$1,000** |
| Pure s1-m70l40 | +$1,110 | −$1,200 | +$1,104 | +$1,014 |
| Pure s1-m100l60 | +$1,665 | −$1,200 | +$1,656 | +$2,121 |
| Struct running 75%/4h | +$2,081 | −$1,200 | +$2,070 | +$2,951 |
| Struct running 95%/2h | _untested at single-day level_ | | | likely close to +$3-3.5k |
| Struct fixed 40%/2h | _untested at single-day level_ | | | likely +$1.5-2k |

The single-day picture favors high-lock structural variants strongly. But
single days are not the right unit of analysis for picking a config.

## My read

Honest summary: I built what you asked for, ran every sensible sweep I could
think of, and the data says **the simpler pure ratchet `s1-m70l40` is still
the better choice on aggregate** unless drawdown reduction is the dominant
objective. The structural mechanic has theoretical appeal but doesn't show
a clean aggregate edge in this entry set.

Where the structural variants ARE clearly better:
- **`struct-running-95%/2h`** if you genuinely want "small repeated wins,
  never give back," accept the 56% PnL cut, and prefer the lowest possible
  DD (6.99%) and giveback ($12.5k). This matches the small-wins philosophy
  you described.
- **`struct-fixed-40%/2h`** as a middle ground — \$91k PnL, 7.58% DD, more
  trades captured at deeper magnets via the fixed-per-tier semantic.

If you want the most PnL with non-catastrophic giveback, `s1-m70l40` is the
clean answer. It's not what we were building toward, but the sweep doesn't
lie.

## Fallback test (post-summary update)

I went ahead and tested follow-up #2 (pure-ratchet fallback when no magnets
present) on both leading structural configs. It HURT PnL on both:

| Config | PF | Sharpe | DD | PnL |
|---|---:|---:|---:|---:|
| Struct fixed 40%/2h (no fallback) | 2.47 | 3.87 | 7.58% | **$90,512** |
| Struct fixed 40%/2h + s1-m70l40 fallback | 2.23 | 3.25 | 6.79% | $71,357 |
| Struct running 95%/2h (no fallback) | 2.08 | 3.52 | 6.99% | **$69,455** |
| Struct running 95%/2h + s1-m70l40 fallback | 1.80 | 2.79 | **5.97%** | $49,225 |

Adding fallback reduces PnL by ~$20k in both cases. The pure-ratchet on
no-magnet trades is clipping winners that would have otherwise ridden to TP.
This rules out follow-up #2 — the "no fallback" version of each structural
variant is the right choice.

Drawdown drops slightly with fallback (struct running + fallback hits 5.97%
DD — new minimum). But the PnL cost is steeper than the DD improvement is
worth. Pareto-dominated.

## Three follow-ups that might unlock the structural promise

The structural mechanic might still win if we changed entry signals or
filters, not the exit mechanic. Three things I'd test next if you want:

1. **Magnet-aware entry filter**: only fire signals when there's a clear
   magnet structure ahead. Current gex-flip-ivpct fires at IV/skew/wall
   conditions regardless of swing structure. Filtering for "≥2 magnets
   in profit region" might raise the structural ratchet's edge by
   selecting trades it's designed for.

2. ~~Pure ratchet fallback~~ — TESTED, doesn't help (see Fallback test
   section above). Pareto-dominated.

3. **Magnet significance threshold**: filter magnets by depth/retest count,
   not just "any 9/9 pivot." Shallow / unconfirmed pivots add noise as
   tiers. Top-3-strongest only might produce a cleaner edge.

## Wave 3 (after morning discussion) — Fib-Retrace bar-close exit

After you proposed it explicitly ("only close it if a 1 minute trading
bar CLOSES above/below a 78.6% retrace from FILL price to lowest/highest
extreme"), built the mechanic into the engine alongside the existing
ratchet modes. Hard SL=60 unchanged; mechanism only engages once MFE ≥
activation threshold.

### Implementation
- `trade-simulator.js` — fibRetrace check in processCandle, bar-close-gated
- `backtest-engine.js` — fibRetrace config passthrough + per-signal emission
- `cli.js` — `--gfi-fib-retrace`, `--gfi-fib-retrace-pct`, `--gfi-fib-activation-mfe`
- `shared/strategies/gex-flip-ivpct.js` — signal emission of fibRetrace + config
- `scripts/sweep-fib-retrace-gfi.js` — 20-config sweep harness

### Sweep result (`retracePct ∈ {0.50, 0.618, 0.706, 0.786, 0.886}` × `activationMFE ∈ {30, 40, 50, 70}`)

| Category | Config | PF | Sharpe | DD% | PnL$ | Today (2026-05-14) | vs Live |
|---|---|---:|---:|---:|---:|---:|---:|
| Live baseline | BE 70/+5 | 2.99 | 6.41 | 11.30 | 157,329 | -$1,000 | — |
| **Best PnL+Sharpe** | `fib-r886-a70` | 2.68 | 6.00 | 9.98 | 145,956 | ~-$760 | +$240 |
| Best PF | `fib-r786-a30` | 2.80 | 5.10 | 8.28 | 123,429 | ~-$200 | +$800 |
| **Best balanced** | `fib-r618-a40` | 2.77 | 5.59 | **7.11** | 127,502 | **~+$720** | **+$1,720** |
| Lowest DD | `fib-r618-a30` | 2.72 | 4.97 | **6.58** | 114,112 | ~+$720 | +$1,720 |

### Key findings

- **retracePct = 0.50 is too aggressive.** Every variant in that column
  has PF ≤ 2.37. Locking 50% of MFE clips winners mid-flight.
- **retracePct = 0.618 – 0.886 forms a plateau.** PF clusters at 2.53 –
  2.80, with DD ranging 6.58% – 10.83% depending on activation threshold.
- **activationMFE = 70** delivers max PnL (rare-big-trade preservation)
  but at cost of higher mfe→SL count (14 vs 5 at activation 30-50).
- **Bar-close confirmation works.** mfe→SL count stays ≤6 across the
  PF-plateau cells. No "wick got my stop" surprises like the wick-trigger
  ratchet modes had.
- **Fib beats pure-MFE ratchet on PF and Sharpe.** Best fib variant
  (fib-r886-a70: PF 2.68, Sharpe 6.00, $146k) beats the best pure-MFE
  ratchet (s1-m70l40: PF 2.61, Sharpe 5.97, $134k) on all three.

### Honest verdict

None of the fib variants beat live baseline on PnL/PF. The baseline is
tuned tight enough that **most winners run to TP=200 unscathed**, and
the BE-clip events lock small profit ($100/clip). Fib trades some of
that "let winners ride" effect for "limit the rare big giveback."

**The strategic choice now**:
1. **fib-r618-a40** — pay $30k PnL over 16 months to cut DD almost in
   half (11.3% → 7.1%) and rescue today's wave-day pattern (+$1,720 vs
   live). Small-account-friendly.
2. **fib-r886-a70** — pay $11k PnL to cut DD by 1.3pp (11.3% → 9.98%)
   and keep Sharpe near baseline (6.00 vs 6.41). Closer to current
   risk-profile.
3. **Keep baseline + accept the bad days** — current production tuned
   for max headline numbers; today's −$1,000 is the price of the long-run
   $157k. Not crazy, but the wave-pattern days will keep happening.

Full results in `comparison.md`, `today-replay.md`, `top-candidates.md`.

## What was edited overnight

Engine + strategy changes (gex-flip-ivpct only; nothing live touched):
- `shared/strategies/gex-flip-ivpct.js` — magnet ratchet emission, tiers, fixed-per-tier toggle
- `backtest-engine/src/data-loaders/swing-pivot-loader.js` — new loader
- `backtest-engine/src/backtest-engine.js` — wires loader into strategy
- `backtest-engine/src/cli.js` — `--gfi-magnet-*` flags
- `backtest-engine/src/execution/trade-simulator.js` — fixed-per-tier ratchet mode
- `backtest-engine/src/analytics/performance-calculator.js` — Wave 1 metrics
- `backtest-engine/src/reporting/console-reporter.js` — MFE/giveback table

New scripts:
- `scripts/precompute-swing-pivots.js`
- `scripts/sweep-mfe-ratchet-gfi.js` (Wave 1)
- `scripts/sweep-mfe-ratchet-launcher.sh`
- `scripts/rank-mfe-ratchet-sweep.js`
- `scripts/sweep-structural-ratchet.js` (Wave 2 running)
- `scripts/sweep-structural-ratchet-fixed.js` (Wave 2 fixed)
- `scripts/compare-ratchet-variants.js`
- `scripts/replay-today-5-14.js`

Output artifacts in `research/mfe-ratchet-gfi/` and `research/swing-pivots/`.

Nothing committed, nothing pushed, nothing in `signal-generator/`,
`trade-orchestrator/`, or `tradovate-service/` modified. The deployment
gap from `live-deployment-gap.md` still stands — even the existing BE 70/+5
appears not to actually run on the broker, which is the bigger question
to resolve before any live change.
