# Round 7 — JV's LIVE rules (from video evidence), three pre-registered tests (2026-07-23)

Sources: YouTube journal "losing $21,000" (trade day 2026-07-10), X recaps 7/13 + 7/15,
teaching videos (QQQ 6/17-18/24, NQ 6/19/24). These supplied three rules the eBook never
stated, tested here against the R4 3,600-signal universe (dev 2021-2024, locked set untouched).

Sizing directive (Drew): total position 10 MNQ ≈ 1 NQ; scale-in modeled as 5+5.

## Test 1 — "Make sure they all break" (multi-market alignment) — REFUTED

Operationalized 2-way: NQ signal aligned iff ES produced a same-direction close-confirmed
MSS (identical jv-ict detector, engine capture on ES 15m continuous → 4,169 events) within
W minutes before NQ fill. Pre-registered: aligned > unaligned EV, monotone in W, stable
years, beats placebo spread.

Result (`11-alignment-gate.py`, tags in `11-alignment-tags.csv`): aligned is WORSE at every
window (dEV −3.5 to −9.8 pts; W=60: aligned −7.96 vs unaligned +1.81), race-20 WR flat
(.495 vs .497), years sign-flip (+2022/2023, −2021/2024), real spread sits mid-placebo
(beats 2/5). Both-markets-broke ≈ both already extended → chase entries. No selection value
2-way. (4-way with QQQ/SPY untested — no intraday data; nothing here motivates buying it.)

## Test 2 — "Larger timeframe holds more value" (4H hierarchy) — REFUTED (regime beta)

Engine `biasMode:'htf4h'` capture (1,540/3,600 pass) defines aligned subset; membership
join. Pre-registered: improvement must hold per side (drift control) + stable years.

Result (`12-htf4h-gate.py`): pooled dEV +15.3 looks great — but it is entirely 2022 shorts
(aligned sells 2022 +44.6, 2024 −20.9; aligned buys underperform unaligned buys 3/4 years;
buy dEV +2.9 ≈ placebo drift +2.6). The 4H gate = short exposure in bear regimes, not setup
selection. Same shape as R2's htf1h.

## Test 3 — Scale-in + TP1/2/3 ladder + BE (his live management) — profile NOT reproduced

`13-scalein-1s-sim.js` (kernel = audited 10-sim; exact-limit fills, 0.5 slip on stops/flat,
16:00 flat; invariants clean, 3 trades hand-verified to the tick). Pre-registered spec:
e1 5 MNQ at signal limit; e2 5 MNQ at midpoint(e1, stop45), cancelled on TP1/stop/flat;
stop45 both tranches; TP1/TP2 = {leg terminus, external pool} sorted near→far, sizes
4/3/3 (10-lot) or 2/2/1 (5-lot); BE→avg entry after TP1. Arms: A base10+BE, B 5+5+BE,
C 5+5 noBE, D base10 noBE. All 6 universes, 8,090 fills.

Real universe (727 traded days, net of $1.50/MNQ rt):

| arm | EV/tr (c-pts) | green-day% | daily PF | maxDD | $/yr net |
|-----|------|------|------|------|------|
| A base10+BE | −3.5 | 43.1% | 0.89 | $47,950 | −$7,638 |
| B 5+5+BE | **+0.7** | **43.9%** | 0.93 | **$31,351** | −$3,908 |
| C 5+5 noBE | +1.0 | 41.8% | 0.94 | $32,883 | −$3,682 |
| D base10 noBE | +1.2 | 41.4% | 0.94 | $48,230 | −$4,375 |

- Scale-in works as averaging mechanics (Drew's prediction): B beats A by +4.2 c-pts/trade
  and halves max DD. But PF stays <1 and green-day% stays ~44%.
- **Green-day rate 43.9% (best year 48.9%) — nowhere near JV's observed ~daily green.**
  The full live-management stack does NOT manufacture his profile on these entries.
- **Real ≈ placebo everywhere**: green% 43.9 inside placebo 42.9–45.3; PF 0.93 inside
  0.78–1.08; EV inside −11.8…+11.8. Placebo p4 beats real.
- Composition: TP1 hit 44% vs initial stop 52% — structural stops die before the first
  ladder rung at these geometries.
- e2 filled 68% of trades. 3rd scale-in NOT modeled: with B ≈ placebo and green-day
  flat, a deeper tranche continues the DD-shaping trend but cannot change the verdict
  (recommend skip unless the DD number itself is wanted).

## Round 7 verdict

All three live-derived rules fail to separate the universe from noise or reproduce the
observed profile. Combined with R1–R6: entries, filters, confluence, selection ceiling,
R:R geometry, profit-lock, alignment, TF hierarchy, and scale-in/ladder management are
ALL placebo-equivalent on NQ 2021-24. The $21k-loss video confirms his record has fat
red tails; remaining reconciliation = regime-conditional performance + curated/partial
display + possibly much tighter TP1 geometry than the book's structures produce — none
of which is a mechanizable edge from available material. Program stays CLOSED; next
evidence tier would be his actual full trade log (wins AND losses over a fixed period).
