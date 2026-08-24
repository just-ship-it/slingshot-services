# Tick engine — overnight results (2026-08-19/20)

## 1. The engine is built, fast, and validated three ways

**Built:** columnar 1s caches for both products (NQ 67.6M bars / 1400 sessions; ES 55.6M / 1293),
`TickCore` (cursor + session tracking + incremental MTF aggregation + per-second evaluation),
`WatchIndex` (price-bucketed conditional triggers), `TickBroker` (honest fills, resting orders,
N concurrent working orders, explicit latency budget).

**Fast:** full NQ history with 128 concurrent watches across 3 timeframes in **8.2 seconds**
(the bar-close engine needed ~20 minutes for one 1m run). The price-bucketed index is what does it:
with 2048 live watches it examines ~20 slots per bar instead of 2048.

**Validated:**
1. *Internal* — replay gate passes at every cut (truncated run = byte-exact prefix of the full run).
2. *Against the bar-close pattern engine* — fvg-bear restricted to one working order reproduces the
   old port: **−$19.5k/yr vs −$18.6k/yr, 1592 vs 1642 trades**. Two independent implementations,
   same answer.
3. *Against the greenfield Python harness* — PCC (a live-book strategy built on a completely separate
   codebase) reproduces at **$77,335 vs $77,635 total** (0.4% apart), +$14.3k/yr. The engine's clock,
   DST handling, fills, slippage and costs are right, **and it can produce positive results** — which
   is the control that makes the negatives below meaningful.

## 2. Every structure strategy tested is negative under honest 1s simulation

| strategy | dev (≤2024) | validation (2025-26) | verdict |
|---|---|---|---|
| fvg-bear, 1 working order | −$19.5k/yr, PF 0.88 | — | matches the old port |
| fvg-bear, 4–64 working orders | −$5.9k…−$7.7k/yr, PF 0.97 | — | concurrency helps but does not save it |
| hs-top, classic | −$0.6k/yr, PF 0.97 | −$5.2k/yr, PF 0.86 | DEAD |
| hs-top, **predictive** | −$7.6k/yr, PF 0.88 | −$27.9k/yr, PF 0.76 | DEAD — and *earlier is worse* |
| retest-continuation long, NQ | −$4.5k/yr, PF 0.95 | +$22.9k/yr | dev-negative ⇒ not selectable |
| retest-continuation short, NQ | −$8.9k/yr | +$0.9k/yr | DEAD |
| retest-continuation, ES (both) | −$6.4k / −$7.8k/yr | −$7.0k / −$8.7k/yr | DEAD |

**fvg-bear was the one with the strongest prior** (honest research re-test said PF 1.43 / +$82k/yr).
The tick engine says otherwise, and the diagnosis is now precise: on the 1,353 trades both take, the
two agree (13.89 vs 13.67 pts/trade). The research's profit lived entirely in ~1,000 trades it took
and the tick engine doesn't — and the research's rule for skipping the others was **non-causal**
(it skipped events based on whether an *earlier order would later fill*, which is unknowable at the
time). With causal selection the edge is gone.

**hs-top is the cleanest kill.** We suspected latency: 44% of its bar-close signals arrived after
price had passed the neckline. So I rebuilt it predictively — rest a sell-stop at the neckline the
moment the post-head trough confirms, voided if price exceeds the head, i.e. positioned *before* the
right shoulder even forms. It got **worse** (dev −$7.6k, val −$27.9k). The structure does not predict;
the research's $18k/yr was 100% fill fantasy.

## 3. Sweeps: NQ-only positives that die cross-product

Given how fast the engine is, I swept honestly (rank on dev ≤2024, read validation once).

**FVG (432 configs, 31 min).** The research's frozen config is not in the top 12. Configs that DO
work on NQ use the gap midpoint, a target, and a short time cap: `ord8 ce stop1 cap60 tgt1` →
dev PF 1.10 / $14.2k/yr, val PF 1.04 / $8.5k/yr; `ord2 ce ...` → val PF 1.16 / $24.3k/yr.
**But on ES the same configs are PF 0.90–0.95 on dev AND val.** Per this repo's own kill criterion,
an NQ-only survivor of a 432-config sweep is a selection artifact. DEAD.

**ORB (216 configs, 18 min).** Best dev config — OR60 (the initial balance), stop 2 ATR, hold to EOD,
**long only** — dev PF 1.18 / $18.9k/yr, val PF 1.26 / **$39.4k/yr**. Validation better than dev.
Then the drift twin (same clock, same exits, **no breakout condition at all**):

| arm | dev $/yr | val $/yr |
|---|---|---|
| ORB breakout long | $18,860 | $39,351 |
| **unconditional long** | $16,669 | **$59,490** |

The twin makes *more* on validation. ORB-long is **beta**, not alpha; ES agrees ($3.6k/$17.0k vs
$4.9k/$15.0k). The breakout condition does carry real information on the SHORT side (NQ dev −$6.3k vs
−$20.1k unconditional) — it just isn't enough to overcome drift.

## 4. The latency thesis: NOT established

This is the experiment the whole architecture rests on, so it needs the cleanest read. Long-side
comparisons are contaminated — in a rising market an earlier long is mechanically better — so the
short side is the honest test.

| product | side | resting − close1m (dev) | (val) |
|---|---|---|---|
| NQ | long | +$18/trade | +$47/trade |
| NQ | short | +$7/trade | +$113/trade |
| **ES** | long | **−$17/trade** | **−$23/trade** |
| **ES** | short | **−$21/trade** | $0/trade |

Pre-positioning is worth real money on NQ and **negative on ES**. A benefit that flips sign between
two highly correlated index futures is not an established effect. My earlier interim note (that
*waiting* is better) was also wrong — it was measured on a no-edge config. The honest statement is:
**entry-latency value is unproven for breakout entries at a known level.** It may still matter for
mechanisms that are genuine races (a clock event, a print); it does not show up here.

## 5. Superseded interim note: being early is not automatically better

The ORB latency experiment holds the mechanism fixed and varies only decision speed:

| arm | dev $/yr | val $/yr | avg $/trade (dev) |
|---|---|---|---|
| resting stop pre-positioned at the level | −$13.2k | **+$6.8k** | −$51 |
| act on the 1m close beyond the level | −$16.3k | −$19.0k | −$64 |
| act on the 5m close beyond the level | **−$6.5k** | −$3.9k | **−$26** |

Pre-positioning beats reacting-on-1m-close on both sets — reaction latency is a real cost. But
**waiting for a 5m close beat both on dev**, because the delay filters false breaks: a resting order
catches every poke, including the ones that immediately reverse.

So the thesis needs refining. Speed is decisive when you are *racing to a level that matters* and the
fill is the scarce thing. It is counterproductive when the level is noisy and the delay is doing
useful filtering work. The tick engine's real value is that it can now tell you which regime a given
strategy is in — in seconds, honestly, instead of never.

## 6. What this means

The bar-close architecture was not why these strategies failed. Four structure families, tested at
1-second resolution with pre-positioned broker-side orders and honest fills, have no edge that
survives a drift twin and a cross-product check.
The earlier positive numbers were artifacts of three specific simulator sins, all of which the tick
engine makes structurally impossible: filling at prices the market had already left, selecting trades
using knowledge of future fills, and assuming order concurrency the execution path never had.

The instrument is now trustworthy and ~150× faster. That is the asset. The strategies are not.

## 7. Recommended next steps

1. **Do not deploy any of these.** The current book stays exactly as it is (untouched, as instructed).
2. **Use the speed for breadth, not depth.** A 432-config sweep takes 30 minutes; the whole
   22-primitive catalog can be screened honestly in a couple of days rather than a quarter. The
   sensible next move is a *census* — measure every primitive's honest tick economics — rather than
   more hand-tuning of individual candidates.
3. **Demo-account tests** from `BROKER-CAPABILITIES.md` (in priority order): does `activationTime`
   gate arming server-side; is an opposite-side StopLimit accepted; is a correct-side two-Stop OCO
   accepted. These decide how much of the Watch vocabulary the broker can hold for us.
4. **Fix flagged live bugs before any deployment**: `modifyBracketStop` omits `orderType` and would
   convert a live Stop into a Limit; `placeOrder` discards `failureReason` (rejections return HTTP
   200). (The `hasTrailing` temporal-dead-zone bug that would have made `place_stop_limit` throw is
   already fixed — it was mine, introduced earlier that day.)
5. **Consider BBO/tick data only if a specific mechanism demands it.** Nothing tested tonight was
   limited by 1s resolution — the limits were the strategies, not the data. Budget stays unspent.
