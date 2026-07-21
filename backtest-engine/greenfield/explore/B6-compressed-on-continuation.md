# B6 — Compressed-Overnight Morning Continuation (1s-honest viability)

**Verdict: DEAD as a strategy.** Failure mode = **direction is NOT load-bearing.** The
apparent census edge is a *long-side drift on compressed-ON days*, not a first-hour
*continuation* effect. The interaction the census claimed (compressed-ON × aligned
first-hour direction) is refuted at the 1s level: unconditional-long ≥ direction-
conditioned, and the short legs (the down-first-hour "continuation" trades) are dead.

Scope note (honesty rule #8, pooled vs day-weighted): this signal fires **once per day**
(one decision at D per eligible day), so pooled == day-weighted here. No divergence to flag.

---

## Setup

- **Hypothesis under test (from sibling census, taken as hypothesis not truth):** on days
  whose overnight (18:00→09:30 ET) range is in the bottom trailing tercile (knowable at
  09:30), the first-hour direction *continues* into midday (+4.5 pt to 10:30, +11.9 pt to
  noon, gross, positive every year 2021–2026, n≈440).
- **Eligible day** = `on_compressed` (ON range ≤ trailing-250d 33.33rd pct, strictly prior)
  AND `full_rth` AND `rth_same_sym` (excludes roll-in-window days; trade window is inside
  RTH) AND `atr14_prior` knowable AND day present in the 1s RTH cache.
- **Signal (causal):** at decision D ∈ {10:00, 10:30} ET, `first_hour_move = price(D) −
  rth_open`, where `price(D)` = close of the last 1s bar CLOSED by D (knowable at D).
  `direction = sign(first_hour_move)`. Enter MARKET at the first 1s bar with ts ≥ D.
  Optional near-flat filter: require `|first_hour_move| > 0.10·ATR14`.
- **Sim contract:** fills/exits walk 1s bars from the fill instant. Market entry = entry-bar
  open +0.25pt adverse (×slip_mult); stop = stop ∓0.5pt (×slip_mult), eligible on entry bar
  (against trade); target = limit exact, NOT eligible on entry bar; same-1s-bar stop+target
  ⇒ STOP; time/flat exit = flat-bar open ∓0.25pt. $5 RT commission, NQ $20/pt, 1 contract.
- **Universe:** 367 compressed eligible days in cache (2021:67, 2022:44, 2023:130, 2024:45,
  2025:69, 2026:12); 961 non-compressed control days. Design/sweep = **2021–2024 only**;
  **2025–2026 LOCKED**, run once on the single frozen config.

## Grid (16 configs, all disclosed)

D {10:00, 10:30} × filter {none, >0.10·ATR14} × exit/stop {noon-time no-stop, noon-time
0.4A-stop, tgt0.3A no-stop (flat 15:45), tgt0.5A + 0.4A-stop (flat 15:45)}.

## Dev sweep 2021–2024 (compressed × aligned direction)

Only decision D = **10:30** (the true first-hour close) produced anything; D = 10:00 (half
the first hour) was ~flat. Noon time-exit + 0.4A stop was best. Two configs passed the dev
survival screen (PF ≥ 1.3, all 4 years +, n ≥ 100):

| config | n | WR | PF | Sharpe | maxDD | netPt/tr | grossPt/tr | per-year (PnL/n) |
|---|---|---|---|---|---|---|---|---|
| 10:30 f-none T12:00 s0.4A | 285 | 55.1 | **1.328** | 1.73 | -11,832 | 6.52 | 7.29 | 21:+2430/67 22:+7311/43 23:+18244/130 24:+9188/45 |
| 10:30 f>.10A T12:00 s0.4A | 188 | 54.8 | 1.399 | 1.65 | -10,739 | 7.93 | 8.70 | 21:+2797/49 22:+5871/31 23:+17494/83 24:+3648/25 |

(Full 16-config table in `B6-dev-results.json`.) The no-stop noon variants were positive only
3/4 years (2021 negative); the 0.4A stop is what makes every year positive — disclosed grid
member, so kept. Target-exit variants held ~4–5h (median 315m) with lower/inconsistent PF —
time-in-trade risk without PF benefit, consistent with "let it drift to noon" being the real
structure.

## FROZEN CONFIG (declared BEFORE the locked run)

> **D = 10:30 ET · filter = none · exit = noon (12:00 ET) fixed-time · stop = 0.4×ATR14 ·
> hard flat 15:45 ET · market in/out · 1 contract NQ.**
>
> Chosen over the >0.10A-filter variant: higher Sharpe (1.73 vs 1.65) and ~50% more trades
> (285 vs 188 dev) for a stable locked read, at a trivial PF cost (1.328 vs 1.399); fewer
> researcher degrees of freedom (no filter). This is the single config run verbatim on
> 2025–2026.

## MANDATORY CONTROLS (dev 2021–2024, frozen config)

| block | n | WR | PF | Sharpe | maxDD | netPt/tr | per-year |
|---|---|---|---|---|---|---|---|
| **STRAT** compressed × aligned-dir | 285 | 55.1 | 1.328 | 1.73 | -11,832 | 6.52 | 21:+/22:+/23:+/24:+ |
| STRAT @ 2× slippage | 285 | 55.1 | 1.300 | 1.60 | -12,202 | 6.02 | all + |
| **CTRL1** non-compressed, same rule | 687 | 51.8 | **1.099** | 0.58 | -29,601 | 2.98 | all + but weak |
| **CTRL2** compressed **uncond-LONG** | 286 | 55.2 | **1.347** | 1.83 | -8,491 | 6.74 | all + |
| CTRL2b compressed uncond-SHORT | 286 | 42.7 | 0.743 | -1.80 | -45,239 | -6.91 | 0/4 |

**Decomposition of the conditioned strategy (dev 2021–2024):**

| leg | n | WR | PF | netPt/tr |
|---|---|---|---|---|
| LONG legs (first-hour UP → long) | 150 | 60.0 | **1.845** | +12.91 |
| SHORT legs (first-hour DOWN → short) | 135 | 49.6 | **0.977** | -0.58 |

### Reading the controls

1. **Compression IS load-bearing (CTRL1 passes).** Same rule on non-compressed days: PF
   1.10 vs 1.33, netPt 2.98 vs 6.52, Sharpe 0.58 vs 1.73. The compressed-ON gate roughly
   doubles per-trade points. So the *day-type* filter is real. Good — but not sufficient.

2. **Direction is NOT load-bearing (CTRL2 fails the interaction).** Compressed
   **unconditional-long** (PF 1.347, netPt 6.74, Sharpe 1.83) **matches/beats** the
   direction-conditioned strategy (PF 1.328). Conditioning on first-hour direction adds
   *nothing* — it slightly *hurts*, because on down-first-hour days it shorts a market that
   drifts back up. The decomposition proves it: **all** the edge is in the LONG legs
   (PF 1.845); the SHORT legs — which ARE the continuation test on down days — are dead
   (PF 0.977, −0.58 pt). Unconditional-short is a −$40k disaster (PF 0.74). The mechanism is
   a **long drift on quiet-overnight days**, not first-hour continuation.

**The census claim was the interaction (compressed × aligned direction).** That interaction
is refuted. What survives is a directional *main effect* (compressed days drift up), which
is a different, weaker thing and explicitly out of scope for this study.

## LOCKED RUN 2025–2026 (frozen config, run once, verbatim)

| block | n | WR | PF | Sharpe | maxDD | netPt/tr | per-year (PnL/n) |
|---|---|---|---|---|---|---|---|
| **STRAT** locked (frozen config) | 81 | 55.6 | **0.888** | -0.72 | -12,656 | -3.00 | 2025:+3894/69 · 2026:-8760/12 |
| STRAT locked @ 2× slippage | 81 | 55.6 | 0.871 | -0.84 | -12,936 | -3.50 | 2025:+3204 · 2026:-8880 |
| CTRL1 non-compressed locked | 274 | 49.3 | 0.994 | -0.04 | -31,858 | -0.28 | 2025:-10626/174 · 2026:+9094/100 |
| CTRL2 compressed uncond-LONG locked | 81 | 55.6 | **1.222** | 1.24 | -7,990 | 5.06 | 2025:+205/69 · 2026:+8000/12 |
| **STRAT FULL 2021–2026** | 366 | 55.2 | **1.206** | 1.14 | -12,656 | 4.41 | 21:+/22:+/23:+/24:+/25:+/**26:-8760** |

The out-of-sample collapse is decisive: the direction-conditioned strategy fell from dev
PF 1.328 → **locked PF 0.888 (net −$4,866, −3.0 pt/trade)** — it *lost money* out of sample.
The unconditional-long control held up far better (dev 1.347 → **locked 1.222**), out-
performing the conditioned strategy out of sample yet again. The first-hour direction signal
was fitting noise; only the compressed-day long drift is durable — and even that (locked
PF 1.222, full-sample 1.206) sits **below the 1.3 survival bar** and is just directional
beta concentrated on quiet-overnight days.

## Verdict vs the survival bar

| criterion | bar | result | pass? |
|---|---|---|---|
| PF ≥ 1.3 after costs (full 2021–2026) | ≥ 1.3 | 1.206 | ✗ |
| positive every calendar year | all + | 2026 negative (−$8,760) | ✗ |
| ≥ 100 trades | ≥ 100 | 366 | ✓ |
| locked 2025–2026 PF ≥ 1.2 | ≥ 1.2 | **0.888** | ✗ |
| compression load-bearing | materially > non-comp | dev 1.33 vs 1.10 | ✓ |
| **direction load-bearing (interaction)** | strat > uncond-long | **strat ≤ uncond-long, dev & locked** | ✗ |

**DEAD.** Fails four of six criteria, including both the locked-period gate (PF 0.888) and —
fatally — the direction load-bearing / interaction test (dev & locked). The compression gate
is real, but the *continuation* mechanism the census claimed does not exist at the 1s level:
the short legs (down-first-hour → short) are dead in-sample and the whole conditioned trade
loses money out-of-sample, while doing nothing but sitting long on compressed days matches or
beats it everywhere. This is a long-drift main effect masquerading as an interaction, and the
main effect itself is sub-bar. Net-of-cost: **−3.0 pt/trade locked, +4.4 pt/trade full but
concentrated in longs and below bar.**

## Reusable artifacts / notes for the orchestrator

- `B6-01-sim.py` — 16-config dev sweep + `sim_trade` (market-in / optional stop+target /
  time-flat, exact 1s contract w/ slip_mult); `B6-02-controls-locked.py` — controls + locked;
  `B6-dev-results.json` — full dev grid.
- **Distinct, out-of-scope observation (NOT a recommendation):** "buy NQ at 10:30 on
  compressed-overnight days, hold to noon, 0.4A stop" (unconditional long) is the only piece
  with any life (dev PF 1.35, locked 1.22) but is sub-bar and looks like quiet-day index beta,
  not an intraday edge. Would need a separate, honest study framed as a directional/beta bet —
  it is not this continuation strategy and should not be smuggled in as one.
