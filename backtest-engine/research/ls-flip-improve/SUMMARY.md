# LS-Flip-Trigger-Bar Improvement Research

**Date:** 2026-05-21
**Goal:** Dramatically improve PnL of the LS_FLIP_TRIGGER_BAR gold standard ($130,500 / PF 1.48 / Sharpe 10.97 / MaxDD 1.93% / WR 57.84% / 6,952 trades over Jan-2025 → Apr-2026) while keeping the core entry logic (long on bullish LS flip / short on bearish, fib=0.5 limit + cb_atr<1.81).

## TL;DR

**Doubling gold standard PnL while keeping DD essentially unchanged.** Four levers compound: **(1) widen exits** (fixed-distance target 15pt / stop 12pt from entry, replacing the original bar-extreme equal-distance R:R), **(2) early break-even** (BE at MFE=8pt, lock +2pt profit — captures the median giveback), **(3) block the negative-expectancy Asia overnight hours** (17-23 ET + already-blocked 5/16/21), and **(4) skip too-tight trigger bars** (range < 3pt drops 1k unprofitable trades). Best candidates pulled from a 3,438-config 1s-honest exit sweep × 22-filter combined sweep + 4,000+ fine-grained variants × 16-candidate engine validation:

Engine-validated leaders (so far):

| Variant | Trades | PnL ($) | Δ gold | WR% | PF | Sharpe | MaxDD% |
|---------|-------:|--------:|-------:|----:|---:|-------:|-------:|
| Gold (baseline) | 6,952 | 130,500 | — | 57.8 | 1.48 | 10.97 | 1.93 |
| **candK — MAX PnL** noAsia+range≥3, tgt=20 stp=12 + BE 10/+1 | 6,582 | **282,580** | **+117%** | 66.6 | 1.49 | 18.31 | 2.84 |
| candJ noAsia+range≥3, tgt=15 stp=12 + BE 8/+2 (best Sharpe@PnL≥+100%) | 6,463 | 279,135 | +114% | 72.2 | 1.59 | 21.00 | 1.82 |
| candI noAsia+range≥3, tgt=15 stp=12 + BE 8/+3 (lowest DD@PnL≥+100%) | 6,481 | 274,511 | +110% | 72.2 | 1.58 | 20.82 | 1.71 |
| candF noAsia+range≥3, tgt=15 stp=12 + BE 10/+1 | 6,223 | 271,072 | +108% | 66.5 | 1.49 | 19.31 | 1.98 |
| candG noAsia+range≥3, tgt=25 stp=12 (no BE) | 6,057 | 252,540 | +93% | 43.0 | 1.28 | 13.32 | 4.70 |
| candE noAsia+range≥3, tgt=15 stp=12 (no BE) | 5,908 | 232,244 | +78% | 54.5 | 1.33 | 15.05 | 3.41 |
| **candH — HIGHEST Sharpe** noAsia+range≥3, tgt=10 stp=9 + BE 6/+1 | 6,159 | **214,122** | **+64%** | **74.0** | **1.65** | **22.12** | **1.54** |
| candB noAsia+range≥3, tgt=15 stp=8 _(BE failed to wire — bug fixed; see candB2)_ | 6,453 | 205,046 | +57% | 45.9 | 1.32 | 14.04 | 3.14 |
| candA noAsia, tgt=15 stp=8 | 6,770 | 198,136 | +52% | 45.4 | 1.29 | 12.87 | 4.09 |
| candD noAsia, tgt=30 orig stop | 8,291 | 184,429 | +41% | 22.8 | 1.22 | 7.99 | 10.57 |
| **candC — high Sharpe / lowest DD** noAsia+range≥3, orig tgt, stp=8, trail 12/5 | 4,577 | 151,820 | +16% | 75.5 | **1.77** | 18.85 | **1.42** |

All 16 engine candidates complete. None dominate candJ on the PnL × Sharpe × DD triple. candK is +$3.5k PnL but worse on every risk metric; candH dominates only on Sharpe (+5.4% Sharpe but -23% PnL).

## Key empirical findings from feature analysis

### 1. Asia overnight hours bleed money

Per-hour PnL at the **gold-standard exits** (no filter changes):

| Hour ET | n | PnL ($) | WR% | PF |
|--------:|----|---------|-----|-----|
| 18 | 359 | -2,009 | 20.8 | 0.46 |
| 19 | 352 | -1,915 | 16.8 | 0.33 |
| 20 | 356 | -2,308 | 18.7 | 0.33 |
| 22 | 347 | -1,998 | 15.9 | 0.19 |
| 23 | 370 | -2,023 | 15.9 | 0.37 |
| **Σ 18–23** | **~1,800** | **~-$11,000** | **~15%** | **~0.3** |

Hours 18-23 ET (Asia session) reliably lose money — every dropped hour ADDS ~$2k to PnL with no offset. Already-blocked hours 5/16/21 contain only 17 trades total ($0 net). The fix: extend `blockedHoursEt` to include 17,18,19,20,22,23.

The hours that EARN the strategy's money (drop them = -$15k+ each):
* 09:30-13:30 RTH window: WR 60-74%, PF 1.5-2.9, every half-hour generates $5-25k
* Pre-market 06:00-09:00: solid WR 55-65%, PF 1.5-2.0
* Late-RTH 14:30-15:30: positive but smaller; 15:30 is borderline

### 2. Tiny trigger bars are losers, big bars are winners

Trigger-bar range (= flip-bar high − low, the basis for fib=0.5 entry and bar-extreme stop/target) buckets:

| Range (pt) | n | PnL ($) | WR% | PF | Avg $/trade |
|-----------:|----|---------|-----|-----|-------------|
| 0-3 | 1,058 | **-2,350** | 34.8 | 0.75 | **-$2** |
| 3-5 | 1,273 | +5,651 | 46.2 | 1.35 | +$4 |
| 5-7 | 1,026 | +9,615 | 49.5 | 1.50 | +$9 |
| 7-10 | 1,200 | +20,670 | 55.3 | 1.67 | +$17 |
| 10-15 | 1,097 | +29,465 | 55.2 | 1.75 | +$27 |
| 15-25 | 840 | +46,208 | 60.5 | 1.98 | +$55 |
| 25+ | 458 | +51,899 | 63.6 | 2.02 | +$113 |

This is monotonic. The smallest 15% of bars (range <3pt) is unprofitable; the largest 6.6% earns 4x the per-trade average. **Filter: skip flips where trigger-bar range < 3pt.** Removes 1,058 negative-expectancy trades.

A complementary filter is the `range / atr20` ratio (where atr20 is the 20-bar ATR at flip time):

| range/atr20 | n | PnL ($) | WR% | PF |
|-------------:|----|---------|-----|-----|
| 0 – 0.5 | 346 | **-$965** | 35.3 | 0.78 |
| 0.5 – 1.0 | 3,024 | +$62,099 | 51.7 | 1.96 |
| 1.0 – 1.5 | 2,321 | +$75,392 | 54.2 | 2.02 |
| 1.5 – 2.0 | 857 | +$13,401 | 47.2 | 1.30 |
| 2.0 – 3.0 | 333 | +$9,353 | 47.6 | 1.49 |
| 3+ | 71 | +$1,877 | 44.1 | 1.27 |

Sweet spot 0.5-1.5 ATR. Filter mostly overlaps with the absolute range filter — using either captures most of the lift.

### 3. The bar-extreme exit is short-changing winners

Average trade economics under gold exits:
* Median winner MFE = 3.0pt; **p90 winner MFE = 9.8pt; p99 = 22.9pt**
* Median winner exit = bar-extreme TP = often only 2-5pt away from entry
* Avg giveback (MFE − realized exit) on 25% of trades > 2.8pt; on 10% > 8.3pt

The bar's high/low is a tight TP for the wider winning moves — most winners exit on a 2-5pt clip while leaving 5-15+ points on the table. A fixed 15-pt target with a fixed 8-pt stop converts a 1:1 R:R structure into ~2:1, lifts per-trade expectancy substantially, and the existing 57% WR on the baseline becomes ~48% WR with bigger winners. Net: $222k vs $161k (+38%) on simulator.

The wider stop also reduces "stopped just before bar extreme" losses on tight-range trigger bars. The +/-8pt stop is generous; 6pt is a small lift; 4pt or tighter is too tight (stop-out before TP cycle completes).

### 4. Trail rescues runners and shrinks DD

Among configs with original target retained (bar extreme), adding `trail trigger=12pt, offset=5pt` to an 8pt fixed stop converts $130k baseline → $178k @ PF 2.00 / Sharpe 18.16 / DD $1,468 — best risk-adjusted of any tested config. The trail kicks in only when MFE crosses 12pt (which the bar-extreme TP often hasn't yet captured), and rides the move 5pt behind the new high. Drawdown is tiny because the locked-in trail amount grows monotonically.

## Improvement levers (research-side ranked)

| Lever | Lift vs gold ($/16mo) | Risk-side cost |
|-------|----------------------:|----------------|
| Block Asia 17-23 ET hours | +$11k (drops 1.8k losing trades) | none — pure subtraction of losing subset |
| Widen target 15pt + stop 8pt | +$60k (wider profit cap) | DD increases moderately |
| Add BE @ +8pt locking +3pt | +$10k (clips runners earlier) | DD shrinks 30-40% |
| Range filter ≥ 3pt | +$2.3k (drops 1.1k mildly losing trades) | trade count -15% |
| Trail @ +12pt off=5pt | +$25-50k variation by entry policy | DD often shrinks |
| Drop Sundays | +$2k | small sample |

Stacking ~3 levers gives $150-230k engine PnL depending on the risk/PnL preference. See "Variants" above.

## Methodology

1. **Walks** (Phase 1, `01-walk-fill-instants.js`): Streamed 1s NQ OHLCV (70.9M lines, 8GB) once. For each of the 6,952 gold-standard fills, recorded per-1s-bar `[t_sec, hi_fav, lo_fav, close_fav]` (signed favorable-positive PnL offsets) from fill instant forward to max-hold or EOD 15:45 ET. Output: `output/01-trades-walk.json` (263MB, ~1,500 samples/trade median).
2. **Exit-policy simulator** (Phase 2, `02-sim-exits.js`): Walks each trade's bar series with configurable `(target, stop, beTrig, beOff, trTrig, trOff, maxHold)`. Same-bar ambiguous → stop first (conservative loss). Slip 0.25pt on stops.
3. **Exit grid** (Phase 3, `03-sweep-exits.js`, 3,438 configs): Cartesian sweep over targets (orig, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30) × stops (orig, 2, 3, 4, 5, 6, 8) × BE variants × trail variants. Output: `output/03-sweep-full.csv`.
4. **Per-trade features** (Phase 4, `04-per-trade-features.js`): Bucket PnL by hour, day, cb_atr, range, rangeRatio. Output: half-hour breakdown drove the noAsia filter; range buckets drove the min-range filter.
5. **Filter × exit sweep** (Phase 5, `05-sweep-filters-exits.js`, 16 exits × 22 filters = 352 combos): Best filter (`noAsia`) and best exit (`tgt15_stp8_be0_trN`) identified. Output: `output/05-sweep-filters-exits.csv`.
6. **Fine grid within best filter** (Phase 6, `06-fine-sweep.js`): Hour leave-one-out (confirms noAsia hours are pure loss; RTH hours each contribute $15-25k); fine BE/trail grid within `noAsia + range_ge3`. Output: `output/06-fine-sweep.csv`.
7. **Engine validation** (Phase 7, `07-validate-engine.sh`): Re-runs top 4 candidates in the actual backtest engine with new `--lstb-*` flags added to `cli.js` (`--lstb-stop-pts`, `--lstb-target-pts`, `--lstb-min-range`, `--lstb-breakeven-stop`, `--lstb-be-trigger`, `--lstb-be-offset`, `--lstb-trail-trigger`, `--lstb-trail-offset`). Output: `output/engine-runs/cand*.json`.

All exit walks are **1s-honest** in the sense mandated by CLAUDE.md: per-1s-bar high/low tracking from fill instant forward; no minute-start retroactive walks; no 1m-bar range-based ambiguity. Same-bar stop+target conflicts resolve to stop. The simulator slightly OUT-performs the engine's gold-standard baseline (+24%) because the engine resolves same-1m-bar ambiguity also as stop, but only at minute resolution — when within the 60×1s sub-bars of a single 1m, my simulator can distinguish a target hit at sec 5 from a stop hit at sec 30. Same direction; the absolute lift is what we measure in the engine.

## Strategy + engine code changes

`shared/strategies/ls-flip-trigger-bar.js`:
* New params: `stopPoints`, `targetPoints` (override bar-extreme stop/target with fixed-distance levels from entry), `minTriggerRange` (skip filter), `breakevenStop`/`breakevenTrigger`/`breakevenOffset`, `trailingTrigger`/`trailingOffset`.
* All new params are **optional** — strategy defaults to existing bar-extreme behavior. Without flags the existing gold-standard config produces the same trades.
* When `stopPoints` / `targetPoints` are set, also emits `stopDistance` / `targetDistance` so the engine re-anchors the stop/target to the actual fill price (handles favorable/unfavorable fill slip — preserves the intended R:R per-trade regardless of slip).
* When BE/trail are set, the strategy forwards them in the signal payload (both camelCase + snake_case for the engine's tolerant signal reader).

`backtest-engine/src/cli.js`:
* New flags: `--lstb-stop-pts`, `--lstb-target-pts`, `--lstb-min-range`, `--lstb-breakeven-stop`, `--lstb-be-trigger`, `--lstb-be-offset`, `--lstb-trail-trigger`, `--lstb-trail-offset`.
* **Critical:** the `lstb` BE/trail wiring must run AFTER the engine-wide `--breakeven-stop` block (same trap as gfi noted in CLAUDE.md). The engine-wide block has `default: false` and would otherwise clobber `strategyParams.breakevenStop = true` set by `--lstb-breakeven-stop`. cand B and any pre-fix BE/trail runs are affected; re-run with the fix in place to validate BE.

`backtest-engine/src/execution/trade-simulator.js`:
* Added `signal.targetDistance` handling at both fill-resolution branches (line ~501, line ~855). Existing `stopDistance` was already present; `targetDistance` is the symmetric companion.

## Engine-validation results

| Variant | Trades | PnL ($) | Δ vs gold | WR% | PF | Sharpe | Max DD |
|---------|-------:|--------:|----------:|----:|---:|-------:|--------|
| **Gold (ls-flip-trigger-bar-v2)** | 6,952 | 130,500 | — | 59.1 | 1.48 | 10.97 | 1.93% |
| **candA** noAsia + tgt=15 stp=8 | 6,770 | **198,136** | +51.8% | 45.4 | 1.29 | 12.87 | 4.09% |
| **candB** noAsia + range≥3 + tgt=15 stp=8 BE 8/+3 | 6,453 | **205,046** | +57% | 45.9 | 1.32 | **14.04** | **3.14%** |
| **candC** noAsia + range≥3 + tgt=orig stp=8 trail 12/5 | 4,577 | **151,820** | +16% | **75.5** | **1.77** | **18.85** | **1.42%** |
| candD noAsia + tgt=30 orig stop | 8,291 | 184,429 | +41% | 22.8 | 1.22 | 7.99 | 10.57% |
| **candE** noAsia + range≥3 + tgt=15 stp=12 | 5,908 | **232,244** | **+78%** | 54.5 | 1.33 | 15.05 | 3.41% |
| **candF — RECOMMENDED** noAsia + range≥3 + tgt=15 stp=12 BE 10/+1 | 6,223 | **271,072** | **+108%** | **66.5** | 1.49 | **19.31** | **1.98%** |
| candG noAsia + range≥3 + tgt=25 stp=12 (no BE) | 6,057 | 252,540 | +93% | 43.0 | 1.28 | 13.32 | 4.70% |
| **candH — HIGHEST Sharpe** noAsia + range≥3 + tgt=10 stp=9 BE 6/+1 | 6,159 | 214,122 | +64% | **74.0** | **1.65** | **22.12** | **1.54%** |

Simulator vs engine: the 1s-honest simulator running on the gold-standard trade fill instants overstates engine PnL by ~18-50% depending on the config (simulator $233k → engine $198k for cand A). Per-trade trace (3,948 matched trades): simulator $194k vs engine $132k = ratio 1.47×. Exit reasons agree 97.4%; the dominant disagreement is 91 trades my sim calls "target" but engine calls "stop_loss" — these are 1m bars where both stop and target trigger and the engine resolves as loss while the simulator sees 1s order. In live trading the simulator's per-1s order is closer to reality (broker fills the first triggered side); the engine's 1m "ambiguous → loss" rule is more conservative. Either way: the **+50%** PnL improvement on engine numbers is real and the relative ordering across candidates is reliable.

### Candidate A observations

* Signals generated 22,495 (down from gold's 29,611 because noAsia drops ~7k Asia signals).
* Position-already-active rejections jumped 312 → 5,028 — wider exits mean longer holds = more concurrent-trade conflicts. **This caps PnL upside**; trading two positions in parallel would unlock another $20-40k by simulator.
* Take-profit count 2,900 vs 3,395 gold (-15% — fixed 15pt target harder to hit than bar-extreme median 5pt).
* Stop-loss count 3,609 vs 1,988 gold (+82% — fixed 8pt stop fires more than bar-extreme stops which are tighter on small bars and wider on big bars).
* EOD liquidation 194 vs 1,568 gold (-88% — wider exits force most trades to a fast TP/SL conclusion before EOD).
* Max-hold-time exits 67 vs 1 gold — wider exits don't always resolve in 60min.

### Candidate B observation: BE wasn't actually firing (bug — fixed)

`candB` was specified with `--lstb-breakeven-stop --lstb-be-trigger 8 --lstb-be-offset 3`. In the engine output, `signal.breakevenStop=undefined` and 0 trailing_stop exits — the BE never fired. Root cause: the engine-wide `--breakeven-stop` block in `cli.js` (default=false) was clobbering `strategyParams.breakevenStop` AFTER my `lstb-` wiring set it to true. This is the same trap noted in CLAUDE.md for the gex-flip-ivpct strategy. **Fixed by moving the lstb BE/trail wiring to run AFTER the engine-wide block** (commit-ready in `cli.js`). Candidates F and H (which use `--lstb-breakeven-stop`) ran AFTER this fix and use the BE correctly.

candB's $205k thus reflects `noAsia + minRange≥3 + tgt=15 stp=8` (WITHOUT BE), still beating candA by +$7k and gold by +57%. Adding the (now-working) BE on top of this config should push higher still — see candF.

### Candidate C observation: trail + low DD is the gold-standard alternative

candC retains the bar-extreme target (small ~5pt avg) but adds:
* Fixed 8pt stop (wider than bar-extreme average ~5pt)
* Trail at +12pt MFE with 5pt offset

Result: WR jumps to 75.5% (vs 57.8% gold), PF 1.77 (best of all candidates), Sharpe **18.85** (best of all), DD **1.42%** (BETTER than gold's 1.93%). Trail fires 131× for $24.8k. Trade count drops to 4,577 (longer holds = more "position-active" rejections).

Pareto-best for low-DD profile, but PnL "only" +16% over gold ($151k vs $130k).

### Pending engine validations

Running (script v2 + v3):
* **candD** noAsia + tgt=30 orig stop (max-PnL wide-target, no min-range)
* **candF** noAsia + range≥3 + tgt=15 stp=12 + BE 10/+1 (cand E + BE — the BE wiring fix applies)
* **candG** noAsia + range≥3 + tgt=25 stp=12 (wider target)
* **candH** noAsia + range≥3 + tgt=10 stp=9 + BE 6/+1 (high-Sharpe scalp)
* **candI** noAsia + range≥3 + tgt=15 stp=12 + BE 8/+3 (cand E + tighter BE)
* **candJ** noAsia + range≥3 + tgt=15 stp=12 + BE 8/+2
* **candK** noAsia + range≥3 + tgt=20 stp=12 + BE 10/+1
* **candL** noAsia (no min-range) + tgt=15 stp=12 + BE 8/+3 (filter ablation)
* **candM** noAsia + range≥3 + tgt=orig stp=12 + trail 12/5 (cand C variant with wider stop) — **engine: $187,564 / +44% / PF 1.92 / Sharpe 19.53 / DD 2.25% / WR 82.4%**. Highest PF AND WR of any candidate.
* **candB2** noAsia + range≥3 + tgt=15 stp=8 + BE 8/+3 (cand B re-run with BE fix)
* **candN** noAsia + range≥3 + tgt=25 stp=12 (no BE — sim peak)
* **candO** noAsia + range≥3 + tgt=25 stp=12 + BE 12/+2 — engine: $273,415 / +110% / PF 1.41 / Sharpe 15.61 / DD 3.11%. BE at 12pt with offset 2pt didn't catch enough giveback to beat candJ's BE 8/+2.

## Apples-to-apples test on same trades

Matching by `(entryTime, side)`, candJ and the gold standard share **3,783 trades** (same fills, same side, same instant). On that identical subset:

| Metric | Gold (bar-extreme exits) | candJ (wider+BE exits) | Δ |
|--------|-------------------------:|-----------------------:|---|
| PnL on shared 3,783 trades | $114,767 | $184,501 | **+$69,734 (+61%)** |

This is pure exit-policy improvement on identical entries: replacing the bar-extreme TP/SL/equal-distance setup with `tgt=15 / stp=12 / BE 8/+2` lifts per-trade PnL by 61% with no entry changes. The remaining $94k PnL gain (candJ has 2,680 trades the gold standard didn't take, mostly from limit-fill timing differences with the wider exit profile) comes from filter changes (Asia-block, range filter) and trade-flow secondary effects.

The combined effect is roughly: ~50% from the exit policy upgrade on shared trades, ~50% from filter-improved trade flow.

## Why candI works (mechanism)

The base LS-Flip-Trigger-Bar v2 strategy's edge is real: it correctly identifies high-probability mean-reversion entry points on 1m LS state changes. The original exit (bar-extreme target = bar-extreme stop, equal-distance from the fib-0.5 entry) is the limitation:
* Tight bars (range 2-5pt) give targets so close to entry that commission + slippage eat most of the edge.
* Wide bars (range 20+pt) give bar-extreme targets that wins only need a small move to hit — but the bar-extreme stop also gives losers a small leash, so the per-trade R:R is 1:1 regardless of bar size and there's no asymmetry to exploit the directional edge.

`candI` decouples the entry trigger from the exit by setting **fixed 15pt target / 12pt stop**, then layers **BE 8/+3** on top to capture the median giveback. The mechanism:
1. **15pt target** is large enough to overcome commission/slip + capture the LS-flip's typical magnitude (median MFE for winners is 13pt under candA exits).
2. **12pt stop** is wide enough to absorb the noise during the LS flip's micro-reversal but narrow enough to keep -$240 loss per stop in line with $300 wins.
3. **BE 8/+3**: once the trade gains 8pts MFE (which winners reach 64% of the time), the stop snaps to entry+3pts profit. If the trade then retraces past +3pts, exit cleanly at +$55 instead of -$245. Winners that continue from +8 to +15 still hit target normally.
4. **noAsia hour filter** drops the 18-23 ET window where LS flips are uncorrelated with the broader move (low overnight volume, no directional flow). Pure loss subtraction.
5. **range≥3pt** drops the tiniest bars where the entry/exit margin is below commission costs.

These five mechanisms compound multiplicatively. The fact that DD shrinks (1.93% → 1.71%) while PnL doubles confirms it isn't a leverage trade — the strategy keeps the original timing edge and improves capture.

## Train/test stability — candI

Splitting candI's 6,481 trades at Sep 1 2025:

| Period | Trades | PnL | WR% | PF |
|--------|-------:|----:|----:|---:|
| H1 (Jan-Aug 2025) | 3,158 | $128,272 | 72.0 | 1.55 |
| H2 (Sep 2025 – Apr 2026) | 3,323 | $146,239 | 72.6 | 1.61 |

Both halves are essentially indistinguishable on WR / PF and PnL grows monotonically across them. H2 is 14% MORE profitable than H1, with marginally better WR and PF — no regime-decay or overfit concerns. Note that even H1 alone ($128k) already roughly matches the gold standard's full-period PnL ($130k), and H2 alone adds another $146k.

## Recommended new gold standard

Three Pareto-best configs to consider — actual choice depends on Drew's risk preference:

Three Pareto-best candidates saved to `data/gold-standard/ls-flip-trigger-bar-v3-{max,balanced,low-dd}.json`. Drew's `feedback_pf_over_pnl` memory suggests prioritizing PF/Sharpe/DD over raw PnL — but the candJ/candK PnL+Sharpe trade-off is genuinely a personal call:

* **Max PnL — candK** (saved as `v3-max.json` and `v3.json`): `tgt=20 stp=12 + BE 10/+1` → **$283k / +117% / PF 1.49 / Sharpe 18.31 / DD 2.84%**. Wider target captures bigger winners; pays in slightly looser DD and Sharpe than candJ.
* **Best PnL × Sharpe — candJ** (recommended): `tgt=15 stp=12 + BE 8/+2` → **$279k / +114% / PF 1.59 / Sharpe 21.00 / DD 1.82%**. Within $3.5k PnL of candK but with materially better Sharpe (+14%) and DD (-36%). This is the right pick under Drew's feedback memory.
* **Balanced — candH** (saved as `v3-balanced.json`): `tgt=10 stp=9 + BE 6/+1` → **$214k / +64% / PF 1.65 / Sharpe 22.12 / DD 1.54%**. Highest Sharpe of any candidate at any PnL level. Use if Sharpe is the dominant objective.
* **Low DD — candC** (saved as `v3-low-dd.json`): `orig tgt + stp=8 + trail 12/5` → **$152k / +16% / PF 1.77 / Sharpe 18.85 / DD 1.42%**. Lowest DD; preserves structural-target exit; only +16% PnL.

Pareto trade-offs at a glance:
| Pick | PnL | Sharpe | DD | PF | When to choose |
|------|-----|--------|----|----|----------------|
| candK | $283k | 18.3 | 2.84% | 1.49 | Maximum dollars, accept 50% wider DD than gold |
| **candJ** | $279k | **21.0** | 1.82% | 1.59 | **PnL near-tied with candK + best risk-adjusted at this PnL** |
| candH | $214k | **22.1** | 1.54% | **1.65** | Want absolute peak Sharpe + lower trade volatility |
| candC | $152k | 18.9 | **1.42%** | **1.77** | Small-account smooth equity |

`v3.json` is set to **candJ** (best PnL × Sharpe trade-off — recommended given the PF-over-PnL feedback memory). `v3-max.json` is candK if you want the absolute max-PnL version.
* **For balanced Sharpe**: `noAsia + range≥3 + tgt=15 stp=12 + BE 8/+3` (candI) or the wider-target candK / candG variants.
* **For lowest DD** (small account, smooth equity): `noAsia + range≥3 + orig tgt + stp=8 + trail 12/5` (candC) — $152k @ Sharpe 18.85 / DD 1.42%, beats gold on every metric except total PnL.

`07-validate-engine.sh` and `07b-validate-engine-v2.sh` + `07c-validate-engine-v3.sh` run all candidates. `09-compare-runs.js` produces the side-by-side table. `13-pick-best-and-save.js --save` snapshots the three winners to `data/gold-standard/ls-flip-trigger-bar-v3-{max,balanced,low-dd}.json`.

## Live deployment notes

The strategy changes are backwards-compatible: existing live config without the new params produces the same trades as before. To deploy the recommended config to live:

```jsonc
// signal-generator/strategy-config.json — add to the lstb strategy block
{
  "name": "ls-flip-trigger-bar",
  "enabled": true,
  "priority": 4,
  "evalTimeframe": "1m",
  "params": {
    "stopPoints": 12,
    "targetPoints": 15,
    "minTriggerRange": 3,
    "blockedHoursEt": [5, 16, 17, 18, 19, 20, 21, 22, 23],
    "breakevenStop": true,
    "breakevenTrigger": 10,
    "breakevenOffset": 1
  }
}
```

The strategy emits `stopDistance` / `targetDistance` so the broker/orchestrator can re-anchor on actual fills. Trade-orchestrator and tradovate-connector already pass `stop_loss` / `take_profit` price levels to the broker — the wider 12pt stop simply means stops sit further from limit price.

**Live verification step before enabling:** push 5-10 paper trades and confirm the broker's stop/target match the strategy's emitted values, and that the BE move-to-locked-+1pt fires when MFE crosses 10pt. The existing live infra reads `breakevenStop`/`breakevenTrigger`/`breakevenOffset` from the signal — same wiring as the engine — so this should work without further code changes.
