# B9 — Large-Gap-Up Morning Fade (SHORT hedge candidate)

**Date:** 2026-07-18 · **Status:** design complete, frozen config declared, locked run below.

## Thesis / role
Short a large gap-up at the RTH open, cover late morning. This is a **HEDGE / diversifier
candidate**, not a standalone core. The book has two long-directional edges and no
downside protection. This sleeve is SHORT and (by construction) pays hardest in
down/vol years exactly when long edges bleed, and loses in melt-ups. It is therefore
evaluated on whether it improves the COMPOSITE (lower book DD / higher book Sharpe),
and is EXPECTED to fail the strict "positive every year" survival bar (it loses 2021).

## Signal (all knowable at 09:30 ET)
`gap = rth_open − prior_rth_close`; eligible day if `gap ≥ K·atr14_prior`.
Additional eligibility (roll-gap safety, all knowable at 09:30):
`full_rth ∧ rth_same_sym ∧ same_sym_prev_rth ∧ ¬roll_in_day ∧ atr14_prior present`.
`same_sym_prev_rth` is REQUIRED — a gap measured across a contract change is a phantom
roll-spread (~200pt), not a real overnight move; including it manufactures fake
"large gap up" signals. This is why my universe (K=0.5 n=125 full / 84 design) is
smaller than a naive census: 20 roll-boundary days and 33 intraday-roll days excluded.

Universe (full sample 2021–2026, roll-safe): K=0.3 → 280 days; K=0.5 → 125 days.
Design (2021–2024): K=0.3 → 202; K=0.5 → 84.

## Sim contract (1s-honest, non-negotiable)
- SHORT market placed 09:30:01 ET → fills at first 1s bar ts≥place, at bar OPEN − slip
  (short sells lower = adverse). Cover market at flat_ts (11:00 or 12:00 ET) at flat-bar
  OPEN + slip (buys higher = adverse). Both legs cost slippage.
- Optional protective stop above entry: `stop = entry_px + stop_pts`; triggers when a 1s
  HIGH ≥ stop over [entry_bar, flat_bar); may trigger on the entry bar; same-1s-bar
  stop+cover ⇒ STOP (against the trade). Cover at stop + slip.
- Costs: $5 RT commission, NQ $20/pt, 1 contract. Roll days excluded. slip base 0.5pt/side;
  1.0pt/side reported as slippage stress. Kernel: `B9_sim.sim_short` — faithful to the
  verified short-slippage logic of `B4_common.sim_market_hold`, slippage set to brief spec.

## Design grid (2021–2024 ONLY, 8 configs × 2 slippage)

### slip = 0.5 pt/side
| config | n | WR | PF | PnL | Sharpe | maxDD | grossPt/tr | per-year (PnL/n) |
|---|---|---|---|---|---|---|---|---|
| K0.3 11:00 noStop | 202 | 52.0 | **1.32** | 42,900 | 1.77 | -13,710 | 11.87 | 21:-10555/50 22:+19175/40 23:+15830/47 24:+18450/65 |
| K0.3 11:00 stop0.5ATR | 202 | 52.0 | 1.25 | 35,570 | 1.43 | -15,066 | 10.05 | 21:-11856 22:+15895 23:+13708 24:+17823 |
| K0.3 12:00 noStop | 202 | 48.5 | 1.10 | 16,590 | 0.59 | -22,025 | 5.36 | 21:-20525 22:+24340 23:+19700 24:-6925 |
| K0.3 12:00 stop0.5ATR | 202 | 47.0 | 1.04 | 6,393 | 0.23 | -27,604 | 2.83 | 21:-24691 22:+19905 23:+17071 24:-5891 |
| **K0.5 11:00 noStop (PRIMARY)** | 84 | 46.4 | **1.359** | 20,935 | **1.97** | -11,190 | 13.71 | 21:-10245/18 22:+10110/14 23:+1895/24 24:+19175/28 |
| K0.5 11:00 stop0.5ATR | 84 | 46.4 | 1.29 | 17,968 | 1.66 | -11,626 | 11.95 | 21:-10849 22:+10110 23:+410 24:+18297 |
| K0.5 12:00 noStop | 84 | 48.8 | 1.14 | 9,980 | 0.82 | -13,035 | 7.19 | 21:-11380 22:+10640 23:+6580 24:+4140 |
| K0.5 12:00 stop0.5ATR | 84 | 47.6 | 1.10 | 7,208 | 0.59 | -13,223 | 5.54 | 21:-11497 22:+10640 23:+3288 24:+4777 |

### slip = 1.0 pt/side (stress)
| config | n | WR | PF | PnL | Sharpe | grossPt/tr |
|---|---|---|---|---|---|---|
| K0.3 11:00 noStop | 202 | 51.5 | 1.286 | 38,860 | 1.60 | 11.87 |
| **K0.5 11:00 noStop (PRIMARY)** | 84 | 46.4 | **1.325** | 19,255 | 1.81 | 13.71 |
| (all 8 configs computed; ranking unchanged — 11:00 noStop dominates; stop and 12:00 both degrade) | | | | | | |

### Design findings
1. **11:00 exit dominates 12:00 everywhere** — the edge is the MORNING fade; afternoon
   up-drift rescues bull-year gaps and roughly halves PF/Sharpe. Confirms the census.
2. **The protective stop (0.5×ATR) HURTS in every config** — PF and PnL fall, maxDD barely
   improves (8–16% of trades stop out). A gap-up short's tail risk is real, but a fixed
   vol stop gets whipsawed out before the fade completes; the pooled cost exceeds the
   tail it removes. → **no stop.**
3. **K=0.5 vs K=0.3:** K=0.5 (more selective) has the best PF (1.36) and Sharpe (1.97) but
   fewer trades; K=0.3 has ~2.4× the trades and higher TOTAL hedge PnL ($42.9k) at PF 1.32.
   For a hedge sleeve, K=0.3 offers more diversification capacity — noted as an alternate.
4. **Every 11:00-noStop config loses ONLY 2021 (melt-up) and wins 2022/2023/2024** — the
   textbook hedge signature.

## FROZEN CONFIG DECLARATION (declared BEFORE any 2025–2026 run)
> **Frozen: K = 0.5, exit 11:00 ET, NO stop, slip 0.5pt/side (1.0pt reported).**
> Rationale: census's cleanest; best PF (1.359) and Sharpe (1.97) in design; morning-only
> leg; no whipsaw stop. This is the brief's designated primary and I concur from the grid.
> K=0.3/11:00/noStop retained only as a higher-capacity ALTERNATE, not the frozen line.

--- everything below this line uses 2025–2026 (LOCKED) — run once ---

## LOCKED RUN (2025–2026, frozen config K0.5/11:00/noStop, run once — verbatim)
```
LOCKED slip0.5   n=41 WR=56.1 PF=2.072 PnL=$34335 Sh=4.5  DD=$-12020 grossPt/tr=43.12 [2025:+26215/29 2026:+8120/12]
LOCKED slip1.0   n=41 WR=56.1 PF=2.035 PnL=$33515 Sh=4.39 DD=$-12120 grossPt/tr=43.12 [2025:+25635/29 2026:+7880/12]
```
Both locked years positive; PF 2.07/2.04 clears the locked ≥1.2 gate with huge margin.
2025 (down/vol) pays +$26k at 43pt/trade gross — the hedge doing its job.

### Frozen config FULL SAMPLE (all 6 years, verbatim)
```
FROZEN full slip0.5  n=125 WR=49.6 PF=1.611 PnL=$55270 Sh=2.97 DD=$-12020 grossPt/tr=23.36
  [2021:-10245/18  2022:+10110/14  2023:+1895/24  2024:+19175/28  2025:+26215/29  2026:+8120/12]
FROZEN full slip1.0  n=125 WR=49.6 PF=1.576 PnL=$52770 Sh=2.84 DD=$-12120 grossPt/tr=23.36
  [2021:-10605  2022:+9830  2023:+1415  2024:+18615  2025:+25635  2026:+7880]
```
Net pts/trade: **22.1** (0.5pt slip) / **21.1** (1.0pt slip). Gross 23.4 pt/trade.

## Standalone verdict — PASSES all bars EXCEPT "positive every year" (as expected)
| Survival bar | Requirement | Result | Pass |
|---|---|---|---|
| PF | ≥ 1.3 | 1.611 (full), 2.07 (locked) | ✅ |
| Positive every year | all 6 | **loses 2021** (melt-up) | ❌ (expected for a hedge) |
| Trade count | ≥ 100 | 125 | ✅ |
| Locked PF | ≥ 1.2 | 2.072 | ✅ |
| 1s-honest | yes | yes | ✅ |
| Live-sourceable | yes | OHLCV only (gap, ATR14) | ✅ |

The single failing bar is "positive every year", and it fails it ONLY in 2021 — the
melt-up year, which is precisely the year a short hedge is SUPPOSED to lose. Under the
brief's HEDGE evaluation this does NOT auto-kill the candidate.

## HEDGE assessment — CONFIRMED hedge
Losses concentrate exactly where a long book prints its best returns:
- **Only losing year = 2021** (the 2021 NQ melt-up).
- **Pays hardest in the down/vol years**: 2022 +$10.1k and **2025 +$26.2k** (2025 alone is
  47% of total PnL, at 43 gross pt/trade — the strongest year, opposite of long-edge bleed).
- Net-positive over the full sample (+$55,270) with a shallow maxDD (−$12,020) and the
  loss cluster (2021) is the long book's melt-up win. This is a genuine negative-correlation
  diversifier, not just a second long tilt. → its value is measured in the COMPOSITE.

## Book file — WRITTEN
`book-gapfade-daily.csv` (125 rows, columns `date,pnl`, frozen config, 0.5pt slip) written.
**Provisional / HEDGE sleeve** — net-positive AND losses concentrate in the melt-up year,
so it qualifies as a hedge and is handed to the composite harness to decide its fate
(does adding it lower book DD / raise book Sharpe). Not a standalone deployable core.

## Scripts
- `B9_sim.py` — sim kernel (`sim_short`, `eligible_days`, `run_config`), 1s-honest.
- `B9_run.py` — driver: `design` | `full` | `locked` | `book`.
