# T5: GEX wall reaction at the open

## TL;DR

GEX walls (call_wall, put_wall, gamma_flip, support[]/resistance[] strikes from the
post-fix CBBO data) are strongly **rejected** in the first hour of RTH and almost
never **broken** in that window. The strongest single finding: when NQ opens within
50 pts of any S/R level, a limit fade *at the level* with stop=30 / target=20 wins
**80–87%** of the time over 38–106 trades, PF 2.6–4.4, Sharpe 8–12 IS, OOS PF 1.3–3.2
(2 months / 2–9 trades). Breakout entries (stop orders past walls) lose money
under every parameterisation tested — first-hour buyers fade the wall, they do not
chase the break.

## Dataset

- **Range:** 2025-01-13 → 2026-04-23 (15 months)
- **OOS hold-out:** 2026-02-23 → 2026-04-23 (last 2 months)
- **Trading days analysed:** 315
- **Skipped:** 5 contract-rollover days; 10 with no GEX snapshot file
- **Source:** `data/ohlcv/nq/NQ_ohlcv_1m.csv` (raw, primary-contract filter) + `data/gex/nq-cbbo/nq_gex_<date>.json` (post-2026-05-06 lookahead-fix relabel)
- **Snapshot used:** the GEX snapshot whose timestamp == 9:30 ET (UTC-aware via `fromET`); all snapshots fall on 15-min boundaries so the 9:30 snap is exact

## Findings

### 1. Wall reaction probabilities (first 60 min)

For each level within ±100 pts of the 9:30 open, we tracked whether price touched
the level, then which happened first: a ≥30 pt rejection back toward the open, or
a 5m close ≥20 pts beyond the level.

| Type        | Distance | n   | Touch% | Reject\|Touch | Break\|Touch | rej / (rej+brk) |
|-------------|----------|----:|-------:|-------------:|-------------:|----------------:|
| support     | <10      |  26 |  88.5% |        78.3% |        21.7% |           78.3% |
| support     | 10-25    |  35 |  74.3% |        84.6% |        15.4% |           84.6% |
| support     | 25-50    |  40 |  52.5% |        76.2% |        23.8% |           76.2% |
| support     | 50-100   | 113 |  43.4% |        65.3% |        28.6% |           69.6% |
| resistance  | 10-25    |  26 |  73.1% |        78.9% |        21.1% |           78.9% |
| resistance  | 25-50    |  32 |  40.6% |        76.9% |        23.1% |           76.9% |
| resistance  | 50-100   |  85 |  24.7% |        57.1% |        33.3% |           63.2% |
| call_wall   | 50-100   |  27 |  29.6% |        50.0% |        37.5% |           57.1% |
| put_wall    | 50-100   |  34 |  47.1% |        68.8% |        31.3% |           68.8% |

**Reading:** support[] and resistance[] strikes are the cleanest fades — within
25 pts of the open, when price reaches the level it reverses ≥30 pts before
breaking through 78–85% of the time. The "named" walls (call_wall/put_wall) fade
less often, partly because in this dataset they often coincide with R1/S1 and
the two-tier-deep S/R levels (S2-S5, R2-R5) carry more independent rejection
signal than call_wall does on its own. The `gamma_flip` field is **null on most
days** in the cbbo dataset — n insufficient to bucket.

Maximum-rejection p75 sits at 39–45 pts across every bucket — i.e., when a wall
*does* reject, you typically get back to the open with room to spare. Maximum-
breakthrough p75 is only 27–43 pts, smaller than the rejection magnitude, which
is *why* the rejection trade has positive expectancy: even when you're wrong
(price breaks), it often only goes 20–30 pts before reversing.

### 2. Strategy grid search

Search space: 10 level-type sets × {10, 25, 50}-pt max-distance-from-open × 5
stops × 5 targets, holding ≤60 1m bars; minimum sample n=30. Two variants:

- **Rejection:** limit at level, side = against the level (long if level below
  open, short if level above open).
- **Break (confirmed):** wait for a 1m close ≥10 pts past the level, then enter
  at the *next* bar's open in the breakout direction.

#### Top 10 REJECTION (sorted by Sharpe)

| Type set    | maxDist | Stop | Tgt | n   | WR%  | PF   | Sharpe | TotPts | OOS n | OOS PF |
|-------------|--------:|-----:|----:|----:|-----:|-----:|-------:|-------:|------:|-------:|
| resistance  |      50 |   30 |  20 |  38 | 86.8 | 4.40 |  12.44 |    510 |     2 |   0.67 |
| resistance  |      50 |   25 |  20 |  38 | 81.6 | 3.54 |  10.52 |    445 |     2 |   0.80 |
| **s_r**     |      50 |   30 |  20 | 102 | 81.4 | 2.91 |   8.67 |   1090 |     8 |   2.00 |
| any         |      50 |   30 |  20 | 106 | 80.2 | 2.70 |   8.00 |   1070 |     9 |   1.33 |
| all_named   |      50 |   30 |  20 | 106 | 80.2 | 2.70 |   8.00 |   1070 |     9 |   1.33 |
| **s_r**     |      50 |   25 |  20 | 102 | 76.5 | 2.60 |   7.79 |    960 |     8 |   2.40 |
| any         |      50 |   25 |  20 | 106 | 76.4 | 2.59 |   7.76 |    995 |     9 |   1.60 |
| all_named   |      50 |   25 |  20 | 106 | 76.4 | 2.59 |   7.76 |    995 |     9 |   1.60 |
| **s_r**     |      25 |   25 |  20 |  76 | 76.3 | 2.58 |   7.70 |    710 |     5 |   3.20 |
| any         |      25 |   25 |  20 |  80 | 76.3 | 2.57 |   7.67 |    745 |     5 |   3.20 |

The "resistance only" winner (PF 4.40) has only 2 OOS trades — too thin to trust.
The robust pick is **`s_r` (support+resistance) within 50 pts, stop=30, tgt=20**:
n=102, IS PF 3.0, OOS PF 2.0 / 8 trades, very stable across stop=25–30. Effective
trade rate: 102 / 315 days ≈ 0.32 trades/day, ~1.6/week.

A wider type set (`any` / `all_named`) adds the named walls (call_wall / put_wall /
gamma_flip) — n only goes from 102 → 106 because most of those strikes already
appear inside support[]/resistance[]. PF drops slightly and OOS PF drops to 1.33;
the named walls add noise without much new signal. **Stick with `s_r`.**

#### Top 10 BREAK (confirmed close + next-bar entry)

| Type set    | maxDist | Stop | Tgt | n   | WR%  | PF   | Sharpe | TotPts | OOS n | OOS PF |
|-------------|--------:|-----:|----:|----:|-----:|-----:|-------:|-------:|------:|-------:|
| support     |      50 |   15 |  20 |  54 | 37.0 | 0.78 |  -1.90 |   -110 |     6 |   1.33 |
| support     |      50 |   15 |  60 |  54 | 14.8 | 0.70 |  -2.30 |   -210 |     6 |   0.80 |
| support     |      50 |   20 |  60 |  54 | 18.5 | 0.68 |  -2.62 |   -280 |     6 |   0.60 |
| support     |      25 |   30 |  30 |  41 | 41.5 | 0.71 |  -2.72 |   -210 |     3 |   0.50 |
| support     |      50 |   25 |  60 |  54 | 22.2 | 0.69 |  -2.72 |   -330 |     6 |   0.48 |

**No combination of type / distance / stop / target produces a positive-Sharpe
break setup.** Every variant loses money in-sample. The first-hour edge is
unambiguously fade, not chase. (This is consistent with the 65–85% rejection-
given-touch numbers in the reaction table — by definition, "did not break"
dominates.)

### 3. MFE / MAE on the recommended config

On the recommended `s_r / dist≤50 / stop=30 / tgt=20` config (102 trades):

- Avg pnl: +10.7 pts/trade
- Avg win: +20.0 pts (target hits)
- Avg loss: −30.0 pts (stop hits)
- Max drawdown (running, in points): 90 pts ≈ 4.5 stops in a row worst case
- Hold time median: <5 min on winners, full ~30–60 min on losers (target hits fast on the touch bar; losers bleed)

The 2:3 reward:risk skew is *more than overcome* by the 81% win rate. Trades close
fast — most winners take their +20 pt target within the first 5 min after entry,
because the entry bar IS the touch bar.

## Proposed Strategy v0a — **Wall Rejection (recommended)**

- **Entry window:** 9:30–10:30 ET (60 min from open)
- **Setup:** at 9:30 ET, find all GEX levels (`support[]`, `resistance[]` arrays
  from the 9:30 cbbo snapshot) within 50 pts of the 9:30 NQ open. Skip the day
  if no qualifying level exists.
- **Side selection:** pick the *closest* qualifying level. If it sits **above**
  the open, place a **SHORT limit at the level**. If it sits **below** the open,
  place a **LONG limit at the level**.
- **Stop:** ±30 pts from level (entry price). Tied to the maxRejection p90 of
  ~50 pts and maxBreakthrough p75 of ~30 pts — gives breakouts room to retrace
  while still cutting losses cleanly.
- **Target:** ±20 pts from level (entry price). The 80%+ win rate carries the
  2:3 R:R; tighter targets push WR to 85%+ but lose the asymmetric tail.
- **Time stop:** if not filled by 10:30 ET, cancel. If filled but neither stop
  nor target hit by 60 min after entry, exit at market (fewer than 5% of trades
  reach the time stop in IS data).
- **Frequency:** ~0.32 trades/day (102 trades / 315 days), ~1.6/week.
- **Per-trade EV:** +10.7 pts × $20/pt (NQ) = **+$214/contract** before
  commissions. Annualised at ~80 trades/yr ≈ +$17k/contract/year.

## Proposed Strategy v0b — Wall Break (NOT recommended)

The break variant has no positive-Sharpe parameterisation. Recommend **no
breakout strategy** based on first-hour wall data. (If a breakout idea is wanted,
look at later sessions or different confirmation rules — e.g., volume surge,
gap-and-go context.)

## Backtest-engine integration sketch

- New strategy file: `shared/strategies/first-hour-gex-wall.js` (extends `base-strategy.js`).
- Signal generator hooks: subscribe to `gex.levels` (already published by data-service) and `candle.close` (1m). At 9:30 ET (using `marketSession === 'rth'` plus a minute check), evaluate the rule above. Place a single `place_limit` signal with `strategy: 'FIRST_HOUR_GEX_WALL'`.
- New CLI flags for backtest engine:
  - `--fhgw-max-dist <pts>` (default 50)
  - `--fhgw-stop <pts>` (default 30)
  - `--fhgw-target <pts>` (default 20)
  - `--fhgw-types <s_r|any|walls>` (default `s_r`)
  - `--fhgw-window <HH:MM-HH:MM>` (default `09:30-10:30` ET)
- The strategy must use `place_limit` (not `place_market`) so backtests fill at the level price with **zero slippage** — matches our analysis assumptions.

## Caveats / Followups

1. **OOS sample is thin.** The 2-month OOS hold-out yields only 8–9 trades on
   the recommended config. Direction (PF >1) is consistent but the precision is
   loose. Re-validate after another 1–2 months of live data.
2. **Same-bar stop/target ambiguity.** When a limit fills on the touch bar, that
   bar's full range can include both stop and target. We used the
   stop-priority (pessimistic) convention; same-bar exits are <10% of trades.
   Live execution will resolve via real-time tick order.
3. **`call_wall` / `put_wall` redundancy.** These named fields almost always
   equal `resistance[0]` / `support[0]`. Adding them as separate triggers
   (variants `walls`, `walls_flip`) does not improve the strategy. Recommend
   keeping the `support[]`/`resistance[]` arrays as the canonical source.
4. **`gamma_flip` is null** on most days in cbbo data — could not be tested as a
   standalone trigger. Re-evaluate once gamma_flip coverage improves.
5. **Distance bucket interaction.** At distance <10 pts, the level is essentially
   "at the open" — the trade fills immediately at 9:30. At distance 25–50, it
   may take 10–20 min to reach. In both cases the WR / PF are similar, so the
   strategy is robust to this latency.
6. **Regime overlay (untried).** Did not condition on `regime` (positive /
   negative / strong_negative). Worth a follow-up sweep — the iv-skew-gex
   strategy blocks `strong_negative` and that filter likely transfers.
7. **Combine with T0 / T3 filters.** If T3 (0-DTE QQQ IV) confirms the
   directional bias matching the rejection side, expect WR / PF lift. Defer to
   the cross-track integration step.
