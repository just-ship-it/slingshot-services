# B10 — Stand-down fade (15:00→15:30 ET, PCC complement)

**Question.** On days the confirmed pre-close continuation strategy (PCC) STANDS DOWN
— small-move days where `|day_move| ≤ 0.30·ATR14` — is there a tradable OPPOSITE
(fade / mean-reversion) edge in the same 15:00→15:30 ET window? These days are disjoint
from PCC's trended-day set, so any fade edge here is a zero-conflict complement.

## Construction (reused from PCC exactly)

- At 15:00:00: `day_move = (last 1s close < 15:00) − (first 1s open ≥ 09:30)`;
  `ATR14 = atr14_prior` (prior-day, knowable at open).
- STAND-DOWN universe = full-RTH, no-roll (`rth_same_sym`), ATR-known days with
  `|day_move| ≤ 0.30·ATR14`.
- **FADE (primary):** enter market at 15:00:01 in the OPPOSITE direction of `day_move`
  (short if day up, long if day down), exit 15:30:00, no stop.
- Sub-bands by `|day_move|/ATR14`: {0.00–0.10 near-flat, 0.10–0.20, 0.20–0.30 almost-trended}.
- Controls on the same days: CONTINUATION (with the small move), fixed-LONG, fixed-SHORT.
- Variant: 15:45 exit.

## Sim rules (non-negotiable, per B4_common / KNOWABILITY)

1s from fill instant. Market entry = next 1s open ±0.25pt adverse (first bar ts≥15:00:01,
decision knowable at 15:00:00). Time exit = 1s open ∓0.25pt at first bar ≥ flat_ts. No stop.
$5 RT commission, NQ $20/pt, 1 contract. Roll days excluded. 2× slip sensitivity reported.

## DEV RESULTS — 2021–2024 ONLY (design/sweep window)

Stand-down universe: **444 days** (band 0.00–0.10: 160, 0.10–0.20: 148, 0.20–0.30: 136).

| Config | n | WR | PF | PnL | Sharpe | maxDD | gross pts/tr | per-year (PnL/n) | 2× slip PF |
|---|---|---|---|---|---|---|---|---|---|
| **FADE 15:30 ALL ≤0.30** | 443 | 47.4 | **0.895** | −$11,610 | −0.6 | −$24,575 | −0.56 | 21:−5530 22:−9140 23:−2535 24:+5595 | 0.858 |
| **FADE 15:30 band 0.00–0.10** | 159 | 52.8 | **1.265** | +$8,150 | 1.33 | −$6,375 | +3.31 | 21:−435 22:+2140 23:+2105 24:+4340 | 1.208 |
| **FADE 15:30 band 0.10–0.20** | 148 | 48.6 | 1.091 | +$2,820 | 0.47 | −$7,425 | +1.70 | 21:+3310 22:+2385 23:−3190 24:+315 | 1.042 |
| **FADE 15:30 band 0.20–0.30** | 136 | 39.7 | **0.537** | −$22,580 | −3.24 | −$23,810 | −7.55 | 21:−8405 22:−13665 23:−1450 24:+940 | 0.517 |
| CONT 15:30 ALL ≤0.30 | 443 | 49.7 | 0.984 | −$1,680 | −0.09 | −$20,910 | +0.56 | 21:+2320 22:+5810 23:−855 24:−8955 | 0.943 |
| CONT 15:30 band 0.00–0.10 | 159 | 44.0 | 0.689 | −$12,920 | −2.1 | −$16,905 | — | 0/4 yrs+ | — |
| CONT 15:30 band 0.10–0.20 | 148 | 47.3 | 0.799 | −$7,260 | −1.2 | −$8,795 | — | 1/4 yrs+ | — |
| CONT 15:30 band 0.20–0.30 | 136 | 58.8 | **1.665** | +$18,500 | 2.65 | −$4,800 | — | 21:+7475 22:+12165 23:+610 24:−1750 | — |
| LONG 15:30 ALL ≤0.30 | 444 | 48.4 | 0.97 | −$3,170 | −0.16 | −$15,055 | +0.39 | 2/4 yrs+ | 0.93 |
| SHORT 15:30 ALL ≤0.30 | 444 | 48.6 | 0.908 | −$10,150 | −0.52 | −$18,390 | −0.39 | 2/4 yrs+ | 0.87 |
| FADE 15:45 ALL ≤0.30 | 443 | 49.0 | 0.927 | −$9,835 | −0.42 | −$25,910 | −0.36 | 1/4 yrs+ | 0.896 |
| FADE 15:45 band 0.20–0.30 | 136 | 39.0 | 0.562 | −$25,935 | −3.22 | −$27,095 | −8.78 | 1/4 yrs+ | 0.546 |

### Interpretation of the controls (genuine fade vs continuation vs drift)

- **Band 0.20–0.30 (almost-but-not-quite trended): the move CONTINUES, it does not revert.**
  FADE loses hard (PF 0.537, −$22,580, gross −7.55 pts/tr) while CONTINUATION wins
  (PF 1.665, 3/4 yrs). The a-priori "a stalling move reverts" hypothesis is FALSE — the
  near-threshold band behaves like a weak PCC extension, not a fade. (Continuation here is
  out of B10's scope and also fails positive-every-year (2024 −1750), but it is the honest
  read of the band.)
- **Band 0.00–0.10 (near-flat): genuine reversion.** FADE wins (PF 1.265) AND CONTINUATION
  loses (PF 0.689) on the same days — the sign flips with direction, so this is a real fade,
  not intraday drift (fixed-LONG 0.97 / fixed-SHORT 0.908 are both ~flat-negative, ruling out
  a directional-drift explanation).
- **Whole ≤0.30 set and 15:45 variant: dead** (PF 0.895 / 0.927). Pooling the reverting
  near-flat band with the continuing 0.20–0.30 band cancels out. 15:45 exit is strictly worse
  (more time-in-trade = more risk, no added edge).

### Best fade candidate vs survival bar (DEV)

Only **FADE 15:30 band 0.00–0.10** shows any fade edge (PF 1.265, Sharpe 1.33, 3/4 yrs+,
n=159, gross +3.31 pts/tr, net avg +$51/tr — comfortably above the ~0.75pt round-trip cost,
so the edge is NOT a cost artifact). But it **FAILS the survival bar in dev**:
- PF 1.265 < 1.3 ❌
- Not positive every year (2021 = −$435 over 37 trades) ❌

Per the greenfield charter, a candidate below the bar is dead, not "promising." No config
clears the bar in the design window.

## FROZEN CONFIG (declared in writing BEFORE the locked run)

Even though it already fails the dev bar, the single strongest fade candidate is promoted to
one confirmatory locked look (one config, one look, no re-fit):

> **FROZEN:** FADE the day move on stand-down days in band `|day_move|/ATR14 ∈ [0.00, 0.10)`.
> Enter market at 15:00:01 opposite `sign(day_move)`, exit market 15:30:00, no stop.
> 1 contract, entry/exit ±0.25pt slip, $5 RT commission. Universe = full-RTH, no-roll,
> ATR-known, `|day_move| ≤ 0.30·ATR14`, band [0.00,0.10). Pass = locked 2025–26 PF ≥ 1.2
> AND positive both years.

## LOCKED RESULTS — 2025–2026 (single run, verbatim)

Stand-down universe: **165 days** (band 0.00–0.10: 45, 0.10–0.20: 57, 0.20–0.30: 63).

| Config | n | WR | PF | PnL | Sharpe | maxDD | gross pts/tr | per-year (PnL/n) | 2× slip PF |
|---|---|---|---|---|---|---|---|---|---|
| **FADE 15:30 band 0.00–0.10 (FROZEN)** | 45 | 42.2 | **0.56** | −$7,435 | −3.17 | −$13,555 | −7.51 | 25:−13335/34 26:+5900/11 | 0.541 |
| FADE 15:30 ALL ≤0.30 | 165 | 44.8 | 0.971 | −$1,565 | −0.17 | −$12,915 | +0.28 | 25:−8105 26:+6540 | 0.941 |
| FADE 15:30 band 0.10–0.20 | 57 | 54.4 | 1.139 | +$2,250 | 0.72 | −$5,990 | +2.72 | 25:+5010 26:−2760 | 1.102 |
| FADE 15:30 band 0.20–0.30 | 63 | 38.1 | 1.177 | +$3,620 | 0.93 | −$4,955 | +3.62 | 25:+220 26:+3400 | 1.143 |
| CONT 15:30 ALL ≤0.30 | 165 | 51.5 | 0.938 | −$3,385 | −0.36 | −$12,900 | −0.28 | 25:+4685 26:−8070 | 0.909 |
| LONG 15:30 ALL ≤0.30 | 165 | 48.5 | 0.823 | −$10,265 | −1.09 | −$17,775 | −2.36 | 25:−8485 26:−1780 | 0.797 |
| SHORT 15:30 ALL ≤0.30 | 165 | 47.9 | 1.106 | +$5,315 | 0.57 | −$9,275 | +2.36 | 25:+5065 26:+250 | 1.072 |
| FADE 15:45 ALL ≤0.30 | 165 | 52.7 | 1.122 | +$7,045 | 0.66 | −$11,685 | +2.88 | 25:+525 26:+6520 | 1.092 |
| FADE 15:45 band 0.20–0.30 | 63 | 58.7 | 1.588 | +$10,795 | 2.67 | −$6,005 | +9.32 | 25:+3180 26:+7615 | 1.546 |

### FROZEN-CONFIG OUTCOME

**FAIL, decisively.** FADE 15:30 band 0.00–0.10 locked at **PF 0.56, −$7,435, 1/2 years
positive** (2025 = −$13,335 over 34 trades). Pass bar was locked PF ≥ 1.2 and positive both
years. The dev near-flat fade edge (PF 1.265) fully INVERTED out-of-sample.

### Sign instability across the split (the tell)

Every band flips sign between windows — the hallmark of noise, not structure
(charter honesty rule #6):

| Band | DEV 2021–24 FADE PF | LOCKED 2025–26 FADE PF |
|---|---|---|
| 0.00–0.10 (near-flat) | 1.265 (edge) | 0.56 (anti-edge) |
| 0.10–0.20 | 1.091 | 1.139 |
| 0.20–0.30 (almost-trended) | 0.537 (continues) | 1.177 (reverts) |

The near-flat band went from best fade to worst; the 0.20–0.30 band went from strong
CONTINUATION to a fade lean. No band is stable in sign, so no fade rule generalizes. The
one config that looks good in locked (FADE 15:45 band 0.20–0.30, PF 1.588) is (a) not the
frozen config — it's a post-hoc pick on the locked set, inadmissible — and (b) the exact
inverse of that band's dev behavior, i.e. noise, not a discovered edge.

No config passed → **no book file written** (`book-standdownfade-daily.csv` not created);
the PCC-correlation check is moot (nothing to correlate).

## VERDICT: DEAD

No stand-down sub-band or exit variant produces a fade edge that survives honest costs and
an out-of-sample look. The only fade candidate that cleared any dev threshold (near-flat
0.00–0.10) failed the dev survival bar outright (PF 1.265 < 1.3, one negative year) and then
inverted to PF 0.56 in the locked window. Bands flip sign across the 2021–24 / 2025–26
split → the apparent edges are sampling noise. Costs were not the killer (net avg tracked
gross closely; the near-flat dev edge was real net, just non-stationary) — the killer is
non-stationarity. Consistent with the poor prior for small-move fades. Nothing to deploy;
nothing to carry forward.

