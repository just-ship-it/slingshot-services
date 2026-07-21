# B3 — Arrival-speed-conditioned reversal at fresh extremes

Date: 2026-07-17. Scripts: `B3-00-events.py` (event extraction + 1m metrics),
`B3-01-bakeoff.py` (metric bake-off), `B3-02-volcheck.py` (vol-regime controls),
`B3-03-1s-burst.py` (1s burst metric, subsample), `B3-04-sim.py` (honest 1s
strategy simulation). Caches: `B3-events.csv` (36,975 events),
`B3-events-burst.csv`, `B3-sim-*.csv`. Logs: `out-B3-dev.txt`, `out-B3-dev-q90.txt`.

## TL;DR

- The phenomenon is REAL and robust: extremes reached fast are far more likely to
  hold and produce a deep reversal than extremes reached slowly. Monotone across
  deciles, positive all 6 years, all hour buckets, and inside every vol regime.
- Recommended live metric: **arr5 = direction x (extreme_price − close_5m_ago) / ATR14_prior**.
- But fading it is NOT tradable: all 32 simulated configs (2 entries x 2 stops x
  2 targets x 2 holds x 2 speed thresholds) are flat-to-losing in the 2021–2024
  design window (best PF 1.00). **Verdict: DEAD as a standalone fade strategy.**
  The locked 2025–2026 validation set was never opened for simulation.

## Event definition (live-computable)

At the close of 1m bar t (knowable at bar close instant), the bar's high exceeds
the max high of the prior 120 one-minute bars of the same contract (symmetric for
lows). Extreme price E = that bar's high (low). Cooldown 15 min per side.
Lookback and forward windows never span a contract change (symbol column is
truth). ATR14_prior = prior-14-day daily ATR from `cache/NQ_daily_sessions.csv`
(knowable: prior days only). 36,975 events, ~6.3–6.9k/year 2021–2025, 3.3k in
H1 2026, both sides balanced.

Primary descriptive outcome (1m walk, conservative — same-bar ambiguity counts
as break): `hold_p35_b5` = price retraces ≥35pts from E before trading ≥5pts
beyond E, within 120m. Dev (2021–24) base rate 0.187. (The prior census's ~42%
base / ~65% top-decile used a different hold definition; directionally consistent.)

## Phase 1 — metric bake-off (deciles cut on 2021–24 only)

| metric | definition (all causal at event close) | mono rho | decile profile (P(hold), d1→d10) | top-dec lift | yr sign 21–26 | hour-bucket sign | corr w/ rv60 |
|---|---|---|---|---|---|---|---|
| **arr5** | dir·(E − close[t−5])/ATR14 | **+1.00** | .10 .12 .14 .15 .17 .19 .21 .22 .26 **.31** | +.120 | ++++++ | +++++ | +.62 |
| arr3 | dir·(E − close[t−3])/ATR14 | +1.00 | .10 … .31 | +.123 | ++++++ | +++++ | +.57 |
| arr10 | dir·(E − close[t−10])/ATR14 | +1.00 | .10 … .29 | +.108 | ++++++ | +++++ | +.66 |
| arr15 | dir·(E − close[t−15])/ATR14 | +1.00 | .12 … .28 | +.090 | ++++++ | ++-++ | +.66 |
| eff10 | net/Σ\|1m moves\| (path directness) | −0.76 | INVERTED, unstable | −.011 | −−−−++ | +−−−− | −.02 |
| accel | 3m rate − prior-7m rate, /ATR14 | +0.28 | U-shaped | +.062 | ++++++ | ++-++ | +.35 |
| neg_dep | −bars since price was 0.3·ATR from E | +1.00 | .15 .19 .22 .24 .30 (quintiles) | +.110 | ++++++ | ++-++ | +.77 |
| burst30 (1s) | max 30s displacement in final 10m, /ATR14 | +0.99 | .05 … .32 (2023–24 subsample) | — | — | — | +.56 |
| burst60 (1s) | max 60s displacement in final 10m, /ATR14 | +1.00 | .06 … .32 | — | — | — | +.63 |

Same ranking holds on the vol-scaled outcome (`hold_a25_b5`, retrace ≥0.25·ATR):
arr5 deciles run .022 → .168 (7.6x), rho +1.00.

**Not a vol proxy.** arr5 quintile profile stays perfectly monotone *within* each
day-vol tercile (loV .09→.27, midV .11→.27, hiV .14→.29) and each intraday rv60
tercile; top-quintile lift is positive in 17/18 year x regime cells. A fully
vol-stripped variant (arr5 / trailing-60m realized vol, corr with rv60 −0.11)
retains a clean top-decile lift every year (e.g., 2026: .40 vs base .26) — there
is genuine burstiness information beyond regime.

**1s burst metrics add little:** corr(burst60, arr5) = +0.85; within arr5
top-quintile, burst60 quartiles move P(hold) only .24→.33. Not worth 1s live
infrastructure.

### Recommended metric

**arr5 = side x (E − close_{t−5m}) / ATR14_prior**, where side = +1 for a new
high / −1 for a new low, E = the new extreme price, close_{t−5m} = 1m close 5
bars before the event bar, ATR14_prior = prior-14-day daily ATR. One subtraction
and one division from a streaming 1m feed. Dev cut points: q80 = 0.089,
q90 = 0.127 (≈ 24 / 35 NQ pts at ATR 275). Runner-up: arr3 (near-identical);
burst60 if a 1s feed is already present.

### Reversal anatomy (dev, arr5 top-quintile)

Fast arrivals resolve fast in BOTH directions — that duality is the whole story:
- 69% break the extreme by ≥5pts within 15m (base: 54%). Only 14% never break
  within 120m.
- Max retrace before break: median 15pts, p75 41, p90 89 (0.06/0.15/0.32 ATR).
- Conditional on holding (retrace ≥35 first, n=1,529): retrace p25/50/75/90 =
  48/69/108/168 pts (0.18/0.26/0.40/0.59 ATR); 35pts arrives in median 5 min;
  max retrace at median 31 min.
→ Realistic target ~0.10–0.20 ATR, realistic hold 30–60m, stop must sit beyond E.

## Phase 2 — honest 1s strategy test (design window 2021–2024 only)

Simulation per charter/KNOWABILITY: order placed at event-bar close instant;
fills and all exits walk 1s bars of the event's own contract from the fill
instant onward; limit fills exact on first 1s bar touching the price; stop exits
at stop ± 0.5pt; time/market exits at 1s open ± 0.25pt; same-1s-bar stop+target
= STOP; no fills 15:15–18:00 ET; hard flat 15:45 ET; $5 RT commission, $20/pt,
one contract, non-overlapping trades per config. 1s reads seeked via
`NQ_ohlcv_1s.index.json` (one contiguous read per event window).

Grid (ALL configs run are shown; nothing withheld):
entry L = limit at E, TTL 15m; entry C = first 1m close back inside the prior
120-bar range within 15m, market at next 1s open. Stop S ∈ {15, 25} pts beyond
E. Target T ∈ {0.10, 0.20}·ATR14 from E. Max hold ∈ {30, 60} min.
Speed threshold arr5 ≥ 0.089 (dev q80) and arr5 ≥ 0.127 (dev q90).

### Dev results, arr5 ≥ 0.089 (full table in `out-B3-dev.txt`)

| config | n | WR | PF | Sharpe | maxDD | PnL | per-year PF 21/22/23/24 |
|---|---|---|---|---|---|---|---|
| L S15 T0.10 H30 | 3994 | .368 | 0.91 | −1.30 | −73k | −68k | .90/.91/.99/.85 |
| L S15 T0.10 H60 | 3988 | .357 | 0.91 | −1.39 | −78k | −73k | .90/.91/.99/.85 |
| L S15 T0.20 H30 | 3935 | .299 | 0.97 | −0.42 | −37k | −27k | .97/1.00/1.03/.87 |
| L S15 T0.20 H60 | 3891 | .258 | 0.97 | −0.39 | −51k | −27k | 1.03/.99/1.03/.84 |
| L S25 T0.10 H30 | 3924 | .477 | 0.93 | −1.09 | −74k | −70k | .88/.90/1.03/.92 |
| L S25 T0.10 H60 | 3907 | .475 | 0.93 | −1.03 | −73k | −69k | .90/.90/1.02/.93 |
| L S25 T0.20 H30 | 3830 | .406 | 0.99 | −0.13 | −33k | −11k | .96/.94/1.09/.98 |
| **L S25 T0.20 H60** | 3741 | .369 | **1.00** | −0.02 | −38k | −1k | .99/.97/1.06/.99 |
| C S15 T0.10 H30 | 3685 | .562 | 0.80 | −2.63 | −145k | −142k | .76/.93/.81/.70 |
| C S15 T0.10 H60 | 3681 | .568 | 0.80 | −2.69 | −151k | −148k | .76/.93/.81/.70 |
| C S15 T0.20 H30 | 3569 | .456 | 0.98 | −0.31 | −55k | −23k | 1.02/.99/1.01/.90 |
| C S15 T0.20 H60 | 3507 | .439 | 0.97 | −0.45 | −66k | −35k | 1.02/.99/1.01/.86 |
| C S25 T0.10 H30 | 3653 | .607 | 0.82 | −2.31 | −144k | −140k | .78/.92/.82/.73 |
| C S25 T0.10 H60 | 3636 | .624 | 0.82 | −2.34 | −151k | −147k | .79/.92/.80/.74 |
| C S25 T0.20 H30 | 3485 | .509 | 1.00 | −0.05 | −50k | −4k | 1.03/.97/1.04/.97 |
| C S25 T0.20 H60 | 3376 | .507 | 0.99 | −0.10 | −56k | −9k | 1.04/.98/1.00/.96 |

Median hold 3–20m depending on config (time-in-trade is small; that is not the
problem). Side splits: shorts-at-highs slightly less bad than longs-at-lows
(best side-cell: short@hi C S25 T0.20 H30, PF 1.03 — noise level).

### Dev results, arr5 ≥ 0.127 (top decile; `out-B3-dev-q90.txt`)

Uniformly WORSE: best config PF 0.95 (C S25 T0.20 H30, n=1703); L-entry best
0.93; the C T0.10 configs collapse to PF 0.62–0.66. Sharper speed conditioning
does not rescue the trade — it concentrates the immediate-continuation tail.

### 2x-slippage sensitivity

Not run: every config already fails at 1x slippage, and doubling slippage is
strictly monotonic-worse (every stop/market exit degrades by a further
0.5/0.25pt = $10–15/trade). Moot.

### Locked validation (2025–2026)

**NOT OPENED.** No config survived the design window, so the locked set was
never simulated (bake-off decile stats over 2025–26 events were reported
descriptively for metric stability only — the metric's lift persists there,
e.g. 2026 vol-stripped top-decile hold .40 vs base .26).

## Failure mode (why a real conditional probability isn't a trade)

The lift is real: P(35pt retrace before 5pt break) rises .10→.31 across arr5
deciles. But the complement dominates the payoff algebra, and both entry styles
suffer adverse selection:

1. **Limit at E**: the deepest reversals (median 69pt retrace on holds, 35pts
   gone in ~5 min) run away from the extreme without returning — the limit
   misses precisely the best outcomes, and fills preferentially when the extreme
   is being re-attacked and broken (69% of top-quintile events break ≥5pts
   within 15m). WR ~37% at S25 T0.20 with ~1:1 realized payoff → PF ~1.0
   before it can clear costs.
2. **Confirmation entry**: pays 10–30pts of the retrace to confirm, leaving too
   little of the median move; with near targets (0.10·ATR) the E-anchored
   target is frequently already passed at fill (instant structural loss) —
   PF 0.80 class.
3. 2023 is the only year the fade family is (mildly) positive; 2021, 2022 and
   especially 2024 bleed. Fails "positive every year" in every configuration.

## Verdict vs survival bar

DEAD. No configuration approaches PF ≥ 1.3 (best 1.00), none is positive every
year. The survival bar is not met at the design stage; validation never opened.

**What survives:** arr5 as a *state variable*. A one-line, live-computable,
vol-robust, 6-years-stable predictor of "this extreme will produce a deep, fast
retrace vs immediate continuation" is real information (P(hold) .10→.31, and its
inverse: bottom-decile arrivals break/hold at 90/10 — slow grinds to fresh
extremes overwhelmingly continue). It just isn't monetizable as a naive fade
with static stops/targets. If reused, use it to condition or veto other entries,
not as a standalone signal.
