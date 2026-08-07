# JV-ICT Dev-Period Results (2026-07-22)

Dev window: **2021-01-18 → 2024-12-31** (continuous 1s starts 2021-01-18; 2021-01-01→17 skipped
to keep every fill/exit 1s-honest). 2025+ untouched (locked validation).

Engine flags (all runs): `--ticker NQ --timeframe 15m --eod-cutoff-et 15:45 --slippage 0.25
--stop-slippage 0.5 --strict-fill` (1s execution on by default, continuous data).
Strategy: `jv-ict`, 1 contract, both models (M short / W long).

## Verification (pre-run)

### Smoke run (2024-03-01 → 2024-04-30)
8 signals, 5 executed (3 pending orders cancelled pre-fill), engine clean.

### Independent re-derivation audit — PASS
A from-scratch Python implementation of the spec (aggregating the raw 1m continuous CSV to 15m,
own pivot/IMB/OB/fib/state-machine code) reproduced **8/8 engine signals with identical
timestamps, entry, stop, TP, fib anchors, causal swing (O), sweep extreme, and OB zones**.

### Lookahead sniff test — PASS
For every trade: all metadata timestamps (sweep, causal swing, sweep extreme, MSS close, leg
terminus, IMB bars, OB bar) ≤ signal close time; entry fills strictly after signal time.
0 violations.

### Worked audit example (trade T000002, M short, 2024-03-27)

15m candles (UTC start | O H L C | bodyHigh bodyLow), from `NQ_ohlcv_1m_continuous.csv`:

```
17:00 | 20159.50 20165.50 20125.75 20142.50 | 20159.50 20142.50
17:15 | 20142.75 20157.75 20138.00 20146.00 | 20146.00 20142.75
17:30 | 20146.00 20153.25 20140.25 20147.75 | 20147.75 20146.00
17:45 | 20148.00 20157.25 20145.00 20148.75 | 20148.75 20148.00
18:00 | 20149.00 20155.00 20133.25 20149.50 | 20149.50 20149.00   <- pivot low 20133.25
18:15 | 20149.50 20180.00 20145.50 20173.25 | 20173.25 20149.50   <- SWEEP bar (high 20180 > swing 20172); also the OB (last up-close)
18:30 | 20173.25 20179.00 20146.00 20153.50 | 20173.25 20153.50   <- pivot low confirms at this close (2-bar lag)
18:45 | 20153.00 20157.75 20131.25 20138.00 | 20153.00 20138.00
19:00 | 20138.25 20152.00 20119.00 20132.25 | 20138.25 20132.25   <- MSS bar: closes 20132.25 < O 20133.25
```

Rule-by-rule re-derivation (all confirmed against engine metadata):
- **Sweep** (close 18:30): 18:15 bar high 20180 > most recent unbroken confirmed swing high
  20172 (earlier structure). Close 20173.25 > 20172 → close-through sweep. NH = 20180 @ 18:15.
- **O (causal low)**: at sweep time the last confirmed swing low was an earlier/lower pivot; at
  the 18:30 bar close the 18:00-bar pivot low 20133.25 confirms (strictly below lows of 17:30,
  17:45, 18:15, 18:30 — 2 bars each side) and **re-anchors O** (newer, higher low, formed before
  the extreme bar) — exactly the spec's A13 rule.
- **MSS** (close 19:15 UTC = 15:15 ET): 19:00 bar closes 20132.25 < O 20133.25. In session
  (09:30–15:30 ET) ✓. Bias: close < daily open 20196 ✓ (short allowed).
- **Fib** body-to-body: fib100 = bodyHigh(18:15) = 20173.25; fib0 = min body of leg
  (18:15..19:00) = 20132.25. Band = [50%,79%] = [20152.75, 20164.64].
- **Confluence**: no bearish 3-bar wick gap in the leg (checked: none) → IMB absent; OB = last
  up-close candle before MSS = 18:15 bar, zone [20145.50, 20180.00], overlaps band ✓ →
  'either' gate passes.
- **Entry**: 70.5% = 20132.25 + 0.705 × 41.00 = 20161.155 → tick-rounded **20161.25** (sell
  limit). **Stop** = NH 20180 + 1.00 = **20181** (19.75 pts ≤ 50). **TP** = leg low 20119 +
  0.25 = **20119.25**.
- **Execution**: limit filled 19:28:43 UTC (after signal) at 20161.25; stopped at
  20181 + 0.5 stop slippage = 20181.50; −20.25 pts. All engine numbers match by hand.

## Run table (dev 2021-01-18 → 2024-12-31, 1 contract, $ = NQ $20/pt)

One axis varied per run, all else at defaults. "Sig" = signals emitted; unfilled limits are
cancelled pre-fill (fill rate ≈ 35%). Engine Sharpe (equity-period based) was ≈ −0.2 for all
near-flat configs; PF / max closed-trade DD are the meaningful discriminators at this trade count.

| config | sig | trades | t/yr | WR | PF | maxDD $ | avg win pts | avg loss pts | net $ |
|---|---|---|---|---|---|---|---|---|---|
| **default** (either/dailyOpen/hard/legLow/optimal) | 386 | 137 | 34 | .416 | **1.04** | 10,385 | +45.4 | −30.6 | +2,030 |
| confluence=**both** | 93 | 20 | 5 | .300 | 0.71 | 6,780 | +51.2 | −30.7 | −2,555 |
| confluence=**none** | 548 | 206 | 52 | .422 | 1.00 | 11,635 | +43.0 | −31.1 | −200 |
| confluence=**imb** | 186 | 52 | 13 | .481 | **1.44** | 6,205 | +48.8 | −31.0 | +7,405 |
| confluence=**ob** | 293 | 105 | 26 | .362 | 0.81 | 11,645 | +44.0 | −30.5 | −7,930 |
| bias=**none** | 632 | 223 | 56 | .426 | 0.99 | 10,705 | +40.7 | −30.0 | −550 |
| bias=**pdhpdl** | 139 | 43 | 11 | .419 | 1.03 | 8,545 | +47.0 | −32.4 | +515 |
| stop=**close** (1m-close soft stop + 2× hard) | 386 | 137 | 34 | .445 | 1.04 | 13,065 | +45.5 | −34.6 | +2,295 |
| tp=**external** | 386 | 136 | 34 | .419 | 0.97 | 7,955 | +40.4 | −29.7 | −1,475 |
| entry=**imbEdge** (spec A6 default) | 391 | 139 | 35 | .410 | 1.03 | 10,310 | +45.9 | −30.5 | +1,575 |
| entry=**discount** (50%) | 208 | 99 | 25 | .414 | **0.64** | 15,695 | +28.1 | −30.7 | −13,055 |
| entry=**premium** (79%) | 468 | 152 | 38 | .382 | 1.09 | 10,575 | +50.5 | −28.3 | +4,585 |

Exit mix (default): 72 stop_loss / 40 take_profit / 25 eod_liquidation.
stop=close swaps stops to 66 soft_stop (1m-close-confirmed, market exit) with WR up 3pts but
avg loss wider (−34.6) — net wash, deeper DD.

## Per-year PF (n)

| config | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|
| default | 0.93 (38) | 2.30 (23) | 1.12 (40) | **0.46 (36)** |
| conf=both | 1.02 (5) | 2.25 (4) | 0.56 (3) | 0.02 (8) |
| conf=none | 0.90 (55) | 1.95 (31) | 0.97 (63) | 0.66 (57) |
| conf=imb | 1.38 (14) | 6.39 (9) | 1.19 (15) | **0.31 (14)** |
| conf=ob | 0.80 (29) | 1.31 (18) | 1.00 (28) | 0.40 (30) |
| bias=none | 0.92 (58) | 1.58 (45) | 1.03 (69) | 0.58 (51) |
| bias=pdhpdl | 3.74 (10) | 2.57 (8) | 1.13 (13) | **0.10 (12)** |
| stop=close | 1.01 (38) | 2.07 (23) | 1.33 (40) | 0.40 (36) |
| tp=external | 0.61 (37) | 2.05 (23) | 1.14 (40) | 0.47 (36) |
| entry=imbEdge | 0.86 (39) | 2.35 (23) | 1.12 (41) | 0.46 (36) |
| entry=discount | 0.89 (37) | 0.28 (9) | 0.90 (26) | 0.38 (27) |
| entry=premium | 0.89 (40) | 1.90 (28) | 1.51 (41) | 0.52 (43) |

Side split (models):

| run | M-short PF (n) | W-long PF (n) |
|---|---|---|
| default | 0.89 (61) | **1.17 (76)** |
| conf=imb | 0.96 (26) | **2.20 (26)** |

conf=imb longs by year: 2021 3.38 (9), 2022 4.04 (4), 2023 2.01 (10), 2024 0.77 (3).
Shorts by year (conf=imb): 0.13 / 8.42 / 0.15 / 0.17 — 2022-only.

## Gate rejection funnel (default config, full dev period)

```
sweeps: 6,025 (M 3,034 / W 2,991)
  -> MSS reached: 4,613 (M 2,276 / W 2,337); mss_timeout consumed 1,411 sweeps
  -> rejected at setup build:
       session_fail     1,585   (MSS completed outside 09:30-15:30 ET)
       confluence_fail  1,189   (no IMB/OB overlapping the 50-79% band)
       bias_fail        1,108   (MSS close on wrong side of daily open)
       stop_too_wide      340   (> 50 pts)
       degenerate_leg       3,  limit_through_price 1, no_causal_swing 0
  -> signals emitted:  386
  -> filled:           137 (rest cancelled pre-fill: extreme-break / leg-break / TTL / session end)
```

No single gate strangles the strategy; the default config trades ~34/yr — a healthy sample.

## Honest assessment

**Is there edge signal here? Essentially no — the default model is a coin flip (PF 1.04) whose
profitable years are 2022-shaped.** Findings:

1. **Every configuration dies in 2024** (PF 0.10–0.66 across all 12 runs). Whatever the
   sweep→shift→retest mechanic captured in 2021–2023 chop/bear conditions, it did not survive
   the 2024 low-vol grind-up tape. This is the dominant fact and dwarfs every axis choice.
2. **Confluence axis matters most, and only the IMB half of it.** conf=imb is the lone
   PF > 1.1 run (1.44, 52 trades, smallest DD, 3/4 positive years) while conf=ob is actively
   bad (0.81) and conf=both inherits OB's damage on 20 trades. The book's "OB or IMB are
   interchangeable confluence" framing is empirically wrong here: requiring the retest band to
   sit inside a 3-bar imbalance is a real filter; the last-opposite-candle OB is noise.
   Caveat: conf=imb's aggregate PF leans on 2022's 6.39 over 9 trades, and its 2024 is 0.31 —
   this is "least dead", not "alive".
3. **The long (W) model carries everything.** Shorts are PF ≤ 0.96 in every year except 2022
   in both examined runs. An NQ-drift story, not a symmetric-model story.
4. **Entry depth behaves as the book claims** (the one place the book is validated): Discount
   (50%) entries are the worst run in the table (PF 0.64 — shallow entries catch every
   continuation), Optimal (70.5%) ≈ imbEdge, Premium (79%) marginally best on PF 1.09 with
   fewer-but-deeper fills. The "Optimal/Premium" naming survives contact with data;
   the strategy around it does not.
5. **Stop semantics (A7) are a wash**: 1m-close-confirmed stops raise WR ~3pts but widen losses
   and DD (13.1k vs 10.4k) for identical PF. The book's "closes not wicks" stop philosophy does
   not rescue the model, and true 15m-close stops would only widen risk further.
6. **Bias gates**: daily-open bias adds nothing vs none (1.04 vs 0.99) at 40% fewer trades;
   pdhpdl bias looked great 2021–22 (3.74/2.57) and then collapsed (0.10 in 2024) — regime
   artifact, not filter.

**What to try next (if anything):** (a) long-only + conf=imb + premium entry is the only
compound direction the axis runs justify, but at ~6–13 trades/yr it cannot clear the greenfield
survival bar without pooling more years or the 5m entry TF (spec A3) for sample size; (b) sweep
the entry TF (5m/30m) before any further filter stacking; (c) treat 2024 as the acid test —
any variant that can't get 2024 above 0.8 is dead on arrival for 2025+ validation. No variant
here earns a locked-set run.

**Spec problems discovered:** §4.5 says TP sits at "legLow + 1 tick (0% fib)" but 0% fib is the
*body* low while legLow is the wick low — implemented as wick low + tick, gloss is wrong. §3
prose ("bodyLow of leg-low bar") vs §5 pseudocode (`minBody` over leg) conflict — pseudocode
implemented. A6's "enter at the IMB proximal edge when it sits shallower than 70.5%" contradicts
its own `max()` formula (the max picks the *deeper* edge); formula implemented. A13's bare
pseudocode would let mid-decline lows ratchet the MSS trigger toward price; constrained per the
prose (see implementation notes #4). `biasMode:'pdhpdl'` was named in the task axes but never
defined in the spec — interpreted as prior-day-range break (documented).
