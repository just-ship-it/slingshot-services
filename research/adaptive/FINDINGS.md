# A1 — Does setup performance persist? (2026-08-21)

**Verdict: RED.** No detectable persistence at any window (z = +0.5 to +1.3 vs a matched
null). Even read at face value the effect is ~0.3pp where the cost bar needs ~7.2pp — off
by ~24x. Selection over this candidate family cannot be made to work by tuning.

Script: `01-persistence.py`. Substrate: `tick-engine/firstbreak/NQ_{3m,5m,15m}_fb.csv`
(363k 5m candles, 2021-01-18 -> 2026-06-16, 1400 days). Features are everything knowable
at the candle close; the label walks 1s bars forward from that close with same-second
ambiguity resolved ADVERSELY — causal and 1s-honest by construction.

288 PRE-REGISTERED candidates: 12 features x {hi,lo} x 6 time-buckets x {long,short},
thresholds frozen on 2021 so each candidate is a stable object trackable across windows.
Costs: 2 ticks on a win, 4 on a loss.

## Results (excess over a permuted null, 2-3 seeds)

| tf | window | rhoEV | carry | **lift excess (pp)** | EV | baseline |
|---|---|---|---|---|---|---|
| 5m | 5d | 0.032 | +3.2% | **+0.17** | −2.79 | −3.00 |
| 5m | 21d | 0.027 | +5.3% | **+0.32** | −2.84 | −3.00 |
| 5m | 63d | 0.134 | +9.6% | **+0.37** | −2.46 | −3.00 |
| 3m | 63d | 0.142 | +5.2% | −0.18 | −3.25 | −3.00 |
| 15m | 21d | 0.009 | +3.2% | **+0.76** | −2.75 | −3.00 |
| 15m | 63d | 0.090 | +6.6% | −0.08 | −2.18 | −3.00 |

**No configuration is profitable.** Best adaptive EV −1.4 to −2.8 ticks/trade vs a −3.00
baseline: selection recovers at most ~1 tick of a 3-tick cost.

## Why no payoff structure rescues it

Breakeven for the candle-geometry payoff (win≈19, lose≈20, costs 2/4):
`p = 24/41 = 58.5%` against a martingale base of `20/39 = 51.3%` → **+7.2pp required**.

More general: for a 0.2pp edge to cover 3 ticks of cost you need
`0.002 x (win+lose) > 3` → **~375 points of combined excursion per trade**. There is no
target/stop pair that saves an edge this small. This is not a tuning problem.

## Three traps hit while building this — all the same trap

Every one was geometry masquerading as signal. In this dataset any metric not normalised
by geometry gets dominated by it.

1. **Broken placebo.** Permuting `firstBreak` alone, leaving `winLongTicks`/`loseLongTicks`
   on their rows, severs the mechanical label-geometry coupling (a close near the high
   makes the high likely to break first). It manufactured rows with big wins and small
   losses and "proved" **+72 ticks/trade, spearman 0.93 from pure noise**. Fix: permute the
   outcome triple as a unit, destroying only the feature->outcome link.
2. **Top-decile carryover is not 10% under the null — it is 15.6-19.6%.** Candidates have
   heterogeneous sample sizes, and high-variance candidates reach the top decile in ANY
   window. Read against chance the real numbers looked like 2x signal; against the correct
   null they are +1 to +10pp.
3. **"Lift over base rate" reported +36pp for candidates that LOSE money.** Selecting
   candles that close a tick off their low gives ~95% hit rates with no predictive content.
   The only skill measure that maps to EV is excess over the **martingale**
   `P(high first) = (close-low)/((high-close)+(close-low))`. That the all-candidate baseline
   lands on exactly **−3.00 ticks = the cost bar** confirms the market sits on this fair
   line and validates the harness.

## A1b — calibration, and a retraction

Binning candidates by skill in window t and measuring the skill they deliver in t+1 is the
direct test of "keep winners, kill underperformers": it asks whether past performance
predicts future performance AT THE TOP END, not on average.

The real curve looked encouraging — monotonic through the middle deciles, top-minus-bottom
spread +0.29pp (21d) and +0.39pp (63d). Against a SINGLE null seed (−0.59pp) that read as
signal. It is not. Null spreads vary enormously seed to seed:

| window | real spread | null (5 seeds) | z |
|---|---|---|---|
| 21d | +0.29pp | +0.04 ± 0.46 | **+0.54** |
| 63d | +0.39pp | +0.27 ± 0.09 | **+1.29** |

**Neither is significant.** Past skill does not predict future skill at any threshold, so
no "keep winners" rule can work regardless of tuning. Even taken at face value the best
decile returns +0.30pp against a 7.2pp requirement, with EV −2.66 ticks.

### 🚨 Retraction: "persistence is strongest at 63 days"

A1 highlighted rising rhoEV at the 63-day window as the one keeper. **Withdrawn.** The
null shows a consistent POSITIVE spread at 63 days (+0.27 ± 0.09, tight), i.e. the effect
is structural, not market. Likely mechanism: permuting within a day preserves that day's
TOTAL residual, so any candidate selecting a stable fraction of days inherits a persistent
component carrying no row-level predictive content. Long windows average more days and
expose it more.

**Methodological rule for this program: never read a null off one seed.** A single draw
here ranged −0.72 to +0.44pp — wide enough to manufacture or destroy any effect of the
size we are hunting.

## A1c — the richer MTF family gives the same answer

A1's family was single-feature thresholds on a candle's own extremes, so the RED verdict
could have been an artifact of a weak family. `03-mtf-persistence.py` reruns the identical
gate on `mtf/NQ_15m_3m_mtf.csv` — **does 3m structure predict which side of the previous
15m candle breaks first**, which is the question this program started from. It adds the
cumulative path since the HTF close, the LTF sequence position `k`, and the HTF candle's
own shape: 17 features, 180k rows.

| window | lift excess | EV | baseline |
|---|---|---|---|
| 5d | +0.51pp | −2.01 | −3.00 |
| 10d | +0.35pp | −3.63 | −3.00 |
| 21d | +0.28pp | −2.95 | −3.00 |
| 63d | −0.58pp | −3.98 | −3.00 |

Same result: ~0.3-0.5pp at best, no window profitable, `allmean` again exactly −3.00.
The RED verdict is **not** an artifact of a thin candidate family.

## Honest limits of this verdict

- It covers **threshold rules over these feature sets**. A pattern that no candidate can
  express would show no persistence here simply because nothing captures it. A richer
  learner (walk-forward gradient boosting on the same causal features) is a legitimate
  extension — though the calibration result argues the problem is persistence itself
  rather than expressiveness.
- It covers the **first-break payoff family** (target = the candle's / HTF candle's own
  extreme). But the arithmetic generalises: a 0.3pp edge needs ~375 points of combined
  excursion to clear 3 ticks of cost, so no target/stop pair rescues it.
- NQ only. ES data exists (`wicks/ES_*`) but per Drew's standing guidance a separate
  instrument is not a validity gate.

## Recommended next step: A2, adapt the CONDITIONING, not the setup

A1 tested adaptive *setup discovery*. The repo's own evidence favours the other framing —
"conditioners only sharpen forced-flow edges" (6-pillars): TRIN/COR did not create the PCC
edge, it sized an existing one, and that ladder is what is deployed. Adaptive conditioning
has a track record here; adaptive discovery now has an anti-track-record.

A2 should therefore ask: does conditioning an ALREADY-VALIDATED edge on recent regime
(vol state, trend/chop, time-of-day) improve PF/Sharpe out-of-sample — pooling to keep n
high instead of slicing it thin across 288 candidates?

## Reusable assets

- `01-persistence.py` — window sweep, martingale-excess skill, matched-null placebo,
  adaptive-vs-static comparison. Any future selection scheme can be dropped into it.
- The corrected null and the martingale baseline are the two pieces worth carrying into
  every subsequent experiment in this program.

---

# A2 — LOCAL analogue repetition (Drew's actual timescale)

A1 tested the wrong thing. Drew's idea was 1-3 days MAX — signatures from the last hour or
two predicting a similarly-shaped candle in the next hour. A1 selected among candidates on
5-63 TRADING-DAY windows, which is a different hypothesis entirely.

Predictor: mean martingale-residual of the previous m candles in the SAME coarse signature
bucket (close location x body share x volume lean), strictly prior, capped by age.
Median look-alike age 48 min (m=3) / 78 min (m=5) — Drew's window.

## 🚨 The finding that nearly got away: resolve-side lookahead

First pass reported **+0.47pp at z=8.5** on 3m, and pairing it with the wider 15m bracket
gave **+7.8 ticks/trade excess, 6/6 positive years, z=4-6**. All of it was contamination.

`pred` averages the OUTCOMES of prior look-alikes, but an outcome resolves AFTER its bar
closes. On the 15m bracket median resolution is 5.1 min (p90 16.1), and **27.3% of
decisions used a look-alike that had not yet resolved** — median 4.9 min of look-ahead.
That leaks what price is doing at the decision instant, which is precisely what predicts
the current break.

**A permutation null CANNOT catch this.** The permutation preserves timing structure, so
the null stayed clean while the real number inflated. Same failure mode as the
dealer-reaction FSM (PF 1.35, VOID). **Audit exit-walk t0 against the entry instant BEFORE
trusting any placebo.**

Corrected (a look-alike is admissible only once `ts + secsToBreak <= now`):

| test | contaminated | knowability-corrected |
|---|---|---|
| 3m own-candle, m=5 | +0.47pp, z=8.5 | **+0.184pp, z=2.96** |
| 15m bracket, EV | +8.40 ticks, 6/6 yrs | **−3.54 ticks, 1/5 yrs, skill +0.003pp** |

3m was only 3.5% contaminated (1.4 min) yet that inflated the effect ~60%. The MTF version
collapsed completely.

## What actually survives

Small, real, and concentrated exactly where Drew predicted:

| cell | n | excess | z | EV excess |
|---|---|---|---|---|
| ALL | 437k | +0.168pp | 2.70 | +0.03 |
| within 2pt of a 50-level | 36k | **+0.720pp** | 3.33 | +0.43 |
| within 5pt of a 50-level | 89k | **+0.587pp** | **4.25** | +0.27 |
| within 2pt of a 100-level | 18k | +0.695pp | 2.30 | +0.38 |
| 10:00-12:00 AND within 5pt of 50 | 8.8k | **+1.052pp** | 2.46 | +0.88 |

Round-number proximity concentrates the edge **3-4x**. Time-of-day alone is weak
(+0.34pp, z=1.78); round numbers are the real filter, and the dose-response across
25/50/100-levels held on the contaminated run too.

## Why it still does not pay, and the one arithmetic route out

The 3m candle's own bracket is ~35 ticks combined, needing **7.3pp**. We have ~0.7pp.

Breakeven excess is `(X+4)/(2X+2) − 0.5` for a symmetric target X ticks. Setting that to
0.7pp gives **X ≈ 213 ticks ≈ 53 points combined** (roughly a ±26pt bracket). So the honest
next step is: keep the round-number-conditioned 3m signal, trade a MUCH wider bracket, and
price it on the touch-grid.

Caveat that must be respected: the one wider-bracket test run so far (A2d, 15m) showed
skill +0.003pp — but on only 3,272 rows after knowability filtering, so it is low-powered
rather than decisive.

## Standing rules added by A2

1. **Knowability audit BEFORE placebo.** Placebos cannot see resolve-side lookahead.
   For any predictor built from prior OUTCOMES, verify `outcome_resolved_ts <= decision_ts`
   for every contributing row and report the violation rate.
2. A 3.5% contamination rate with 1.4 min of leak inflated a result by 60%. Small
   violation rates are not safe.
