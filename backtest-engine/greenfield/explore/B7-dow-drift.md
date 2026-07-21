# B7 — Day-of-week drift candidates (honest 1s viability)

Two survivors of a sibling day×time census, tested as fresh hypotheses on clean
1s data. Book target: uncorrelated ~3-4pt/day edges; these fire at different
times than the confirmed 15:00→15:30 pre-close edge, so could be book members.

Sim: `B7_dow.py` (reuses `B4_common.sim_market_hold`). Market entry = next 1s
open ± slip; time exit = flat-bar open ± slip; stop = stop ± 0.5pt; same-1s
stop+target ⇒ STOP; $5 RT comm; NQ $20/pt; 1 contract. Eligibility: dow match,
`full_rth`, `rth_same_sym` (roll-in-window days excluded). ATR stop configs also
require knowable `atr14_prior`. dow==0 confirmed = Monday. **Slippage is specified
in pt/side for the market leg** (kernel base `SLIP_MKT`=0.25pt ⇒ `slip_mult`=pts/0.25;
stop leg base 0.5pt scales with the same mult). Main line 0.5pt/side; sensitivity
lines 0.25 / 1.0 pt/side. All headline numbers below are at the honest 0.5pt/side.

**Design window: 2021-2024. 2025-2026 LOCKED (run once, frozen config, verbatim).**

Survival bar: PF ≥ 1.3 after 0.5pt costs, positive most years, ≥100 trades,
locked 2025-2026 PF ≥ 1.2.

---

## Candidate A — Monday RTH strength (LONG 09:30:01, exit end of RTH)

### Dev 2021-2024 grid (slip 0.5)

| exit | stop | n | WR | PF | Sharpe | maxDD | avgPnL | grossPts | yrs+ | per-year (sum/n) |
|---|---|---|---|---|---|---|---|---|---|---|
| 15:45 | none   | 180 | 56.1 | **1.316** | 1.69 | -$28,525 | +$285 | 15.5 | 3/4 | 21:+7730/45 22:**-8765**/44 23:+45805/44 24:+6510/47 |
| 15:45 | 0.6ATR | 180 | 54.4 | 1.242 | 1.38 | -$25,626 | +$224 | 12.6 | 3/4 | 21:+9750 22:-21192 23:+43385 24:+8434 |
| 16:00 | none   | 180 | 58.3 | 1.491 | 2.40 | -$22,855 | +$436 | 23.0 | 4/4 | 21:+11110 22:+5220 23:+48540 24:+13560 |
| 16:00 | 0.6ATR | 180 | 56.1 | 1.361 | 1.95 | -$24,896 | +$333 | 18.0 | 3/4 | 21:+14890 22:-13405 23:+46302 24:+12140 |

Cost sensitivity is mild (full-day hold, slip immaterial vs the 23pt gross move):
15:45/none PF 1.329→1.316→1.291 across slip 0.25/0.5/1.0 pt/side.

**Reads.** (1) The protective stop HURTS: it converts 2022 from a small loss
(-$8k) to a large one (-$20k) by getting whipsawed out of a mean-reverting down
year — a full-day directional hold does not want a tight vol stop. No-stop wins.
(2) 16:00 (PF 1.49, 4/4 yrs) is materially better than 15:45 (PF 1.316, 3/4)
but the **16:00 close is NOT deployable** — production hard-flat is 15:45 ET, so
the honest deployable config caps at 15:45. (3) Even at 15:45 the edge is
**heavily regime-concentrated**: 2023 alone is +$46k of the $54k total; 2022 is
negative. This matches the census caveat (post-2023 loaded). The 15:45/none PF
of 1.316 clears the bar only because of one dominant year. The locked test is
the arbiter of whether this is a live edge or a 2023 artifact.

### FROZEN CONFIG (declared before locked run)
**Monday: LONG market @ 09:30:01 ET, exit market @ 15:45:00 ET (production
cutoff), NO stop, slip 0.5pt/side.** Eligibility dow==0 & full_rth & rth_same_sym.
(15:45 chosen over 16:00 because 16:00 is not deployable under the 15:45 hard-flat.)

---

## Candidate B — Tuesday morning weakness (SHORT 09:30:01, exit 10:30)

### Dev 2021-2024 grid (slip 0.5)

| exit | stop | n | WR | PF | Sharpe | maxDD | avgPnL | grossPts | yrs+ | per-year (sum/n) |
|---|---|---|---|---|---|---|---|---|---|---|
| 10:30 | none   | 205 | 52.7 | **1.348** | 1.86 | -$10,405 | +$206 | 11.5 | 4/4 | 21:+5570/50 22:+22590/52 23:+4115/51 24:+9855/52 |
| 10:30 | 0.4ATR | 205 | 52.2 | 1.326 | 1.78 | -$13,098 | +$194 | 11.0 | 4/4 | 21:+686 22:+23488 23:+5516 24:+10031 |

Cost sensitivity mild: none PF 1.368→1.348→1.309 across slip 0.25/0.5/1.0 pt/side.

**Reads.** (1) Stop again HURTS (nearly wipes 2021: +$6.3k→+$1.4k) and raises DD;
no-stop wins. (2) **All 4 years positive**, distributed ($6k/$23k/$5k/$11k) —
less regime-concentrated than Monday, though 2022 is the biggest. (3) Short
60-min hold = low time-in-trade risk, small DD (-$10k), Sharpe 2.0, fully inside
the 15:45 cutoff. This is the cleaner, more sign-stable candidate (matches census:
negative every year, ES-replicated). Magnitude-decay caveat (census) to watch in
locked run.

### FROZEN CONFIG (declared before locked run)
**Tuesday: SHORT market @ 09:30:01 ET, exit market @ 10:30:00 ET, NO stop,
slip 0.5pt/side.** Eligibility dow==1 & full_rth & rth_same_sym.

---

## LOCKED 2025-2026 out-of-sample (run ONCE on frozen configs)

Run once on the frozen configs. Verbatim (slip 0.5pt/side):

**Candidate A — Monday, FROZEN exit=15:45/nostop:**
`n=69 WR=63.8 PF=1.677 Sharpe=3.09 maxDD=-$28,530 avgPnL=+$850 grossPts=43.7`
per-year `2025:+$30,210/48  2026:+$28,405/21` (2/2 years positive). Cost-insensitive
(PF 1.687→1.677→1.657 across 0.25/0.5/1.0 pt/side). Reference: 16:00/nostop and
15:45/0.6ATR ran even higher but are NOT the frozen deployable config.

**Candidate B — Tuesday, FROZEN exit=10:30/nostop:**
`n=75 WR=52.0 PF=1.169 Sharpe=0.97 maxDD=-$18,045 avgPnL=+$153 grossPts=8.9`
per-year `2025:+$4,165/52  2026:+$7,325/23` (2/2 years positive). Cost-insensitive
(PF 1.181→1.169→1.145).

---

## VERDICTS vs survival bar (PF≥1.3 dev, positive most yrs, ≥100 tr, locked PF≥1.2)

### Candidate A — Monday RTH strength: **ALIVE**
- Dev (frozen 15:45/nostop): PF 1.316, 180 tr, 3/4 yrs+. Locked: **PF 1.677, 2/2 yrs+, Sharpe 3.09.**
- The census "regime-loaded" caveat resolved **favorably** — the edge did NOT fade
  out-of-sample, it strengthened (gross 15.5pt dev → 43.7pt locked; 2025 +$30.2k,
  2026 +$28.4k). Locked PF 1.677 clears the ≥1.2 bar comfortably.
- **Honest read / risk:** this is a long-only beta/momentum bet on the RTH session.
  Its dev PF (1.316) was carried by 2023 and its locked strength coincides with a
  strong 2025-2026 tape; 2022 (the one bear year) was negative. It will bleed in a
  sustained down-regime. But it PASSES every gate as specified, is fully causal
  (fixed entry/exit clock, no lookahead), cost-insensitive, and fires at a
  different time than the pre-close edge → valid book member. The deployable
  config is the 15:45 hard-flat one (PF 1.68), not the richer 16:00/stop variants.
- Net **+23.3 pts/trade** gross over full history (frozen config); +43.7 locked.
- **book-monday-daily.csv WRITTEN** (249 trades, full 2021-2026 history, frozen
  15:45/nostop @ 0.5pt: net $109,895, PF 1.442, Sharpe 2.16, 5/6 yrs+, only 2022 −).

### Candidate B — Tuesday morning weakness: **DEAD**
- Dev (frozen 10:30/nostop): PF 1.348, 205 tr, 4/4 yrs+ — passed dev cleanly.
- Locked: **PF 1.169 < 1.2 bar → FAIL.** Both locked years positive and the short
  sign persisted (census's most sign-stable cell held direction), but the
  **magnitude decayed exactly as the census caveat warned** (−15→−7pt across the
  early/late dev halves; gross 11.5pt dev → 8.9pt locked), dragging PF below the
  out-of-sample threshold. Sharpe collapsed 1.86→0.97.
- Failure mode: **edge decay** — real but shrinking; out-of-sample PF a hair under
  the 1.2 gate. A near-miss, not a blow-up, but the bar is the bar.
- Net +8.9 pts/trade gross locked (down from 11.5 dev). **No book file written.**

