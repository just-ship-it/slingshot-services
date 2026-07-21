# B8 — European-open drive (03:35→04:05 ET LONG): honest 1s viability sim

**Verdict: DEAD-for-live.** The census gross drift (~2.6pt) is real and reproduces, but
it cannot survive two overnight market fills. At the realistic 1.0pt/side slippage line
(primary judge for 03:35 ET thinness) the strategy is PF 1.04 / +$7 per trade on the full
sample and PF **0.96 / −$5.7 on the 2021–2024 design period** — below the survival bar on
every axis. It only turns net-positive at 0.5pt/side (PF 1.16 full, still < 1.3), which is
unrealistic for the European-cash-open hour. **No book file written.**

---

## Candidate

Census finding (sibling job, tested here, not trusted): go LONG at 03:35:01 ET, exit at
04:05:00 ET. Claimed NQ +2.58pt gross, positive every year 2021–2026, autonomous vs prior
overnight, ~+1.5pt net after conservative cost. Mechanism: European cash open (~03:00 ET /
08:00 London) sets a direction that carries ~30 min. Structurally overnight → uncorrelated
with the confirmed 15:00→15:30 RTH edge, so valuable as a diversifier IF it clears cost.

## Data build + verification

**Cache:** `cache_nq_euopen_1s.csv` — primary-contract 1s OHLCV for the 03:00–04:30 ET
window each day, columns `date,ts,o,h,l,c,v` (ts = UTC epoch sec, date = ET trade date).
Built by `B8-00-build-cache.py`:

- Seeks directly into the 7.6GB raw `NQ_ohlcv_1s.csv` using `NQ_ohlcv_1s.index.json`
  (minute-epoch-ms → byte offset/length). Full 2021→2026-06 build in ~43s.
- Primary contract per UTC-minute taken from `cache_nq_primary_1m.csv` (`symbol` column).
  Only rows whose `symbol` == that minute's primary are kept; multiple 1s rows in the same
  second are aggregated (o=first, h=max, l=min, c=last, v=sum).
- DST handled via `America/New_York` (03:35 EDT=07:35Z, 03:35 EST=08:35Z).

**Eligibility** (`B8-eligibility.csv`): a day is eligible only if all 91 window-minutes are
present in the index AND the primary symbol is constant across the window (no in-window
rollover). Tally over 2021→2026-06:

| reason | days |
|---|---|
| **ok (traded)** | **1390** |
| no_primary_data (weekends/holidays) | 584 |
| full-window gap (raw 1s missing) | 10 |
| symbol_change in-window (rollover) | 7 |
| single-minute gap | 1 |

**Verification vs 1m cache** (1s aggregated to the 03:35 ET bar):
- Summer/EDT (2023-06-12..16) and winter/EST (2023-01-16..18): 1s O/H/L/C match the
  `cache_nq_primary_1m.csv` bar exactly within tick rounding (1m file rounded to 0.2/0.25,
  1s full precision). DST mapping to 07:35Z / 08:35Z both confirmed correct.
- Overnight is thin: ~2000–2900 traded seconds per 5460-second window (~40–50% coverage) —
  normal for 03:00–04:30 ET, and the reason slippage is the deciding factor.

## Sim rules (per charter / task, non-negotiable)

- Fills/exits walk 1s bars from the fill instant. Entry = market LONG, fill = first 1s bar
  open at/after 03:35:01 ET **+ slip** (buy adverse). Time exit = first 1s bar open at/after
  04:05:00 ET **− slip** (sell adverse). Stop exit = `stop − 0.5pt` (fixed). Same-1s-bar
  ambiguity resolved against the trade (fill-bar low can trigger the stop).
- $5 RT commission, NQ $20/pt, 1 contract. Slippage grid **0.5 / 1.0 / 1.5 pt per fill**
  applied to entry + time exit (2 fills). Stop keeps its fixed 0.5pt.
- Grid: stop {none, 0.3×ATR14_prior} × gate {none, first-5min (03:30→03:35) close-up>0}.
  4 configs. Primary = `nostop_nogate` (the raw census drift). ATR14_prior from `B12-days.csv`.

## Design period 2021–2024 (grid — this is where judgment happens)

Primary judge = 1.0pt line.

**nostop_nogate (primary):**

| slip | n | WR | PF | Sharpe | maxDD | avgPnL | grossPts |
|---|---|---|---|---|---|---|---|
| 0.5 | 1018 | 50.7% | 1.10 | 0.53 | −$8,250 | +$14.32 | 1.97 |
| **1.0** | 1018 | 48.5% | **0.96** | −0.21 | −$17,755 | **−$5.68** | 1.97 |
| 1.5 | 1018 | 45.4% | 0.85 | −0.95 | −$28,555 | −$25.68 | 1.97 |

Per-year @1.0pt: 2021 PF 0.92, 2022 PF 1.14, **2023 PF 0.83**, 2024 PF 0.90 — **positive in
only 1 of 4 years.** Gross drift is a mere 1.97pt on the design period (below the 2.58 claim).

Other configs (all @1.0pt): `stop_nogate` PF 0.96 (0.3×ATR stop essentially never binds in a
30-min hold → identical to no-stop). `nostop_gate` / `stop_gate` PF 0.93, and the gate
*halves* the sample (n≈508) while making 2023 far worse (PF 0.63) — a momentum gate does not
rescue it. No config clears even 1.0 at the realistic line.

## FROZEN CONFIG DECLARATION (before locked run)

Frozen config = **`nostop_nogate`** (primary census-raw drift; stop never binds, gate hurts),
judged at the **1.0pt/side** slippage line. Locked survival floor: PF ≥ 1.2.

## Locked run 2025–2026 (run ONCE, verbatim)

**nostop_nogate:**

| slip | n | WR | PF | Sharpe | maxDD | avgPnL | grossPts |
|---|---|---|---|---|---|---|---|
| 0.5 | 372 | 55.6% | 1.29 | 1.40 | −$9,270 | +$61.68 | 4.33 |
| **1.0** | 372 | 53.2% | **1.19** | 0.94 | −$9,850 | +$41.68 | 4.33 |
| 1.5 | 372 | 51.6% | 1.09 | 0.49 | −$11,315 | +$21.68 | 4.33 |

Per-year @1.0pt: 2025 PF 1.04 (+$1,990), 2026 PF 1.50 (+$13,515). The locked period is
**more favorable** than design (gross 4.33pt vs 1.97pt) — an out-of-sample regime tailwind,
not a validated edge — yet still lands at **PF 1.19, below the 1.2 locked floor**, and 2025
alone is essentially flat (PF 1.04).

## Full sample 2021–2026 (pooled, reference)

**nostop_nogate:** gross drift **2.60pt/trade** — reproduces the census 2.58pt claim, so the
census gross number was honest. Net after cost:

| slip | n | WR | PF | Sharpe | avgPnL | net pts/trade |
|---|---|---|---|---|---|---|
| 0.5 | 1390 | 52.0% | 1.16 | 0.83 | +$26.99 | +1.35 |
| **1.0** | 1390 | 49.8% | **1.04** | 0.22 | +$6.99 | **+0.35** |
| 1.5 | 1390 | 47.1% | 0.93 | −0.40 | −$13.01 | −0.65 |

## Cost-cliff analysis (the crux)

Gross drift ≈ 2.6pt = **$52/trade**. Round-trip cost = 2 fills × slip × $20 + $5 commission:

| slip/side | total cost | net at 2.6pt gross |
|---|---|---|
| 0.25pt | $15 = 0.75pt | +$37 (would survive — but fantasy at 03:35 ET) |
| **0.5pt** | $25 = 1.25pt | +$27 → PF 1.16 (still < 1.3) |
| **1.0pt** | $45 = 2.25pt | +$7 → PF 1.04 (breakeven) |
| **1.5pt** | $65 = 3.25pt | −$13 → PF 0.93 (loss) |

A ~2.6pt drift crossed by two overnight market fills has almost no room. Break-even sits
right at ~1.15pt/side. Realistic 03:35 ET (European-cash-open hour, ~40–50% second coverage)
slippage is at least 1.0pt/side and plausibly more — squarely in the zone where the edge is
gone. The candidate only shows a real positive expectation at ≤0.5pt/side, which the task
itself flags as unrealistic for this hour.

## Survival-bar scorecard

| criterion | bar | result | pass |
|---|---|---|---|
| PF @1.0pt (design 2021–24) | ≥1.3 | 0.96 | ✗ |
| Positive most years (design) | yes | 1 of 4 | ✗ |
| Trade count | ≥100 | 1390 | ✓ |
| Locked 2025–26 PF @1.0pt | ≥1.2 | 1.19 | ✗ (just under) |
| Borderline band (PF 1.2–1.3 @1.0pt) | — | design 0.96, full 1.04 | ✗ (well below) |

Not "alive", not even "borderline" (borderline = PF 1.2–1.3 after realistic cost; this is
0.96 on design, 1.04 pooled). **DEAD-for-live.**

## Book output

**`book-euopen-daily.csv` NOT written** — the candidate is DEAD, not borderline. Its net
expectation at realistic overnight slippage is ~0 (design negative), so it would add cost and
variance to the composite without a positive stand-alone edge. The diversification value of an
uncorrelated overnight slot is only worth harvesting if the slot itself is at least
break-even-plus after honest cost; this one is not.

## Deliverables

- `B8-00-build-cache.py` — overnight 1s cache builder (index-seek + primary filter + DST).
- `cache_nq_euopen_1s.csv` — 03:00–04:30 ET primary 1s slice (250MB, reusable).
- `B8-eligibility.csv` — per-day eligibility + reason.
- `B8-01-sim.py` — honest 1s grid sim (4 configs × 3 slippage), per-year, book dumper.
- `B8-euopen-drive.md` — this doc.
