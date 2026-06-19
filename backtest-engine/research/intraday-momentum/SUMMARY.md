# Intraday Momentum (Zarattini Concretum Bands) on ES — research conclusion (2026-06-15)

New-alpha track, orthogonal to the 4 NQ fade strategies. Open-anchored volatility-band
BREAKOUT + hold-to-EOD. 1s-honest (two-pass: 1m→bands, 1s→fills). 1 ES contract/signal.

## Headline
A **genuine, stable, mechanically-orthogonal LONG-ONLY ES edge** — but it does **not clear the
gold-standard bar on absolute $ throughput** (≈1 trade/day → ~$10–24k/yr/contract vs golds'
$85–200k/yr). On **edge QUALITY (PF/Sharpe/DD) in the recent live-relevant regime it is
competitive with the golds.**

## Best configs (1 ES contract, lookback 14, mult 1.5, hold-to-EOD 15:45, no entry after 15:30)
| Config | Window | Trades | PF | Sharpe | PnL | MaxDD | WR | H1/H2 PF |
|---|---|---|---|---|---|---|---|---|
| maxPnL (firstCp30)  | full 21–26 | 179 | 1.82 | 2.35 | $52,193 | $15,985 | 63.7% | 1.40/2.35 |
| maxSharpe (firstCp60)| full 21–26 | 162 | 1.69 | 2.68 | $34,915 | $9,500 | 63.6% | 1.79/1.61 |
| maxPnL (firstCp30)  | 2024–26 | 54 | 2.61 | 2.81 | $28,630 | $4,263 | 61.1% | — |
| maxPnL (firstCp30)  | **gold 2025–26** | 23 | **4.22** | **3.76** | $23,860 | $4,263 | 69.6% | — |

## What was decisively established (all 1s-honest)
1. **Hold-to-EOD is the exit.** VWAP-cross and band-reentry exits DESTROY the edge (whipsaw to
   WR 12–30%, every variant deeply negative). Catastrophic stops and trailing stops also hurt
   (cut the fat-tail winners that drive PF) — none made the top 12. The edge IS the
   intraday-drift-into-close; capping it kills it.
2. **LONG-ONLY.** The short side is a structural loser 2021–26 (−$126k raw). Trend-regime
   gating (short only below daily SMA) reduces the bleed but NEVER turns it positive
   (best regime-short still −$14k PF 0.83). Adding shorts drags Sharpe 2.68 → 0.55.
3. **mult 1.5** (wider band than paper's 1.0 → higher-quality breakouts) beats 1.0/1.25/1.75/2.0.
   **lookback 14 > 90.** **firstCp 60** (skip the 10:00 checkpoint, enter from 10:30) halves DD
   ($16k→$9.5k) at the cost of ~⅓ the PnL.
4. **Edge is strengthening, not decaying**: H2 PF > H1 PF; recent windows materially stronger
   (full PF 1.82 → 2024-26 PF 2.61 → 2025-26 PF 4.22). Recent strength is on a THIN sample
   (23–54 trades) — treat PF 4.22 as encouraging, PF 1.82 (179 tr) as the robust estimate.

## Verdict vs the bar
- **Edge quality**: PF 1.7–1.8 (full) / 2.6–4.2 (recent) — competitive with golf/glx/gfi PFs.
- **Throughput**: ~1 trade/day, $10–24k/yr/contract — well BELOW golds' absolute $. Leverage-
  invariant: scaling to N contracts scales $ but not Sharpe, so still sub-bar risk-adjusted.
- **Diversifier value (real)**: ES (zero slot contention with the 4 NQ strategies), long-only,
  low DD ($4.3k recent), mechanically uncorrelated (breakout vs fade). A Sh~2.5–3 orthogonal
  stream can lift blended portfolio Sharpe even if standalone it ranks last.

## Throughput push (round 5-6) — CEILING IS STRUCTURAL
Drew asked to push throughput before porting. Result: **single-instrument throughput cannot be
raised without destroying the edge.** Proven exhaustively:
- **Continuous 1s entry is WORSE than the 30-min checkpoint** (2024-26: PF 1.42 vs 2.61). The
  checkpoint's "wait & confirm at the half-hour" is a NOISE FILTER, not just latency — entering on
  the first 1s close-cross catches marginal/false breakouts.
- **Multiple entries/day is catastrophic** — every band/vwap re-entry variant deeply negative
  (PF 0.04-0.78, WR 3-11%). The config that hit the throughput target (1.97 trades/day) lost
  −$384k. Re-entries chase dying trends.
- Conclusion: the edge is fundamentally ~1 high-quality checkpoint-confirmed long trade/day held
  to EOD. The only throughput lever is MORE INSTRUMENTS (same mechanism), not more trades.

## Multi-instrument basket (only ES+NQ have 1s data; no YM/RTY)
Mechanism TRANSFERS to NQ (full 21-26: PF 1.66 / Sh 2.55 / $38k / DD $14.5k / 98tr — comparable to
ES). BUT mult=1.5 is too wide for NQ's higher vol → undertrades recently (only 8 trades 2024-26 vs
ES 54; recent NQ PFs are on 5-8 trades = statistically meaningless). NQ needs its own lower mult
(~1.0) and reintroduces orchestrator NQ slot contention with the fade book. A tuned 1-contract-each
ES+NQ basket caps ~$50-90k/yr — approaches glf's LOW-end $85k/yr but with 2 instruments of risk.

## Candidate #2 (rROD) & #3 (Gao first-half-hour) — DEAD (roll-contamination phantom)
Tested on the same ES/NQ harness (`04-last30.js`): last-30-min directional hold into the close,
dir = sign of an earlier return. INITIAL run looked spectacular (NQ Gao long exit-16:00:
PF 1.81 / Sh 2.95 / $269k full; gold-window Sh 8.09 / $188k). **It was a BUG.** Those entries/exits
were priced directly from `days.<tk>.json` mClose — which is NOT strict-primary-contract filtered
(pass-1 last-write-wins across contract months) → on ~20 roll days the 15:30 & 16:00 prices
straddled a ~70pt NQ roll spread = phantom PnL. **Re-verified with strict-primary 1s prices
(`05-verify-last30.js`): NQ Gao long collapses to PF 0.73 / Sh −1.73 / −$66k.** Every honest #2/#3
variant is NEGATIVE on both ES and NQ. The CLAUDE.md "suspect a bug when Sharpe exceeds validated
strategies" + mandatory-verification rule caught a 100%-phantom result. DO NOT revisit #2/#3.

## Candidate #1 robustness — CONFIRMED REAL (roll-checked)
Candidate #1's FILLS use the strict-primary 1s store (clean); only band anchors touch the matrix.
Excluding roll days (`--excludeRollDays`): full PF 1.82→1.77 / Sh 2.35→2.22; gold window
PF 4.22→4.36 (improves). Edge is NOT roll-driven. Real and robust.

## Final verdict (ALL candidates resolved) — STATUS: PARKED (not deployed) 2026-06-15
- **#1 Concretum breakout (ES long-only)**: REAL, robust, orthogonal, convex trend-day capture.
  **RECOMMENDED CONFIG (if ever deployed): lookback 14, mult 1.5, long-only, checkpoint entry
  (30-min grid, first cp 10:00), HOLD-TO-EOD 15:45, no-entry-after 12:00, no stop.** → full 21-26
  PF 1.94 / Sharpe 2.67 / $50,538 / DD $15.5k / ~3 trades/month / WR 66%. Fills on strict-primary
  1s. Value = modest uncorrelated (+0.12) ES diversifier with NO NQ slot contention — NOT a hedge,
  does not beat golds on $. PARKED per Drew (thorough but sub-bar; revisit for portfolio-filter
  inclusion or if YM/RTY 1s data enables a true multi-instrument momentum basket).
- **#2 rROD / #3 Gao**: DEAD (roll-contamination phantom; verified negative on honest pricing).

## Pipeline files
- `01-sim.js` standalone sim · `02-precompute-rth-1s.js` feature store (days.<tk>.json + rth1s.<tk>.bin)
- `03-sweep.js` in-memory param sweep · `04-last30.js` cand #2/#3 (DEAD) · `05-verify-last30.js` roll-verify
- `06-inspect-signals.js` per-trade trigger walkthrough · `07-complementarity.js` vs fade book

## Deep-dive on candidate #1 (signal inspection + 4 threads, 2026-06-15)
Frequency CORRECTION: winner fires ~3/month (179tr/5yr), ~2/month recent (23tr) — NOT ~1/day
(that was the raw mult-1.0 both-sides baseline). Most days no trade → slot free most of the time.

**Character = convex trend-day capture (06-inspect-signals.js).** Lumpy & fat-tailed: 2025-04-09
(tariff-pause monster rally, +$20,958, MFE +436pt) = 88% of the gold-window net and 40% of the
full-period net. BUT full period is robust without it ($31,235 over the other 178 trades). Profile:
~117 small ±$1k chops, ~40 wins >$1k, ~22 losses >$1k; worst single loss ~−$4,500 (90pt reversal).

**Thread 1 — complementarity vs fade book (07, corrected my hedge hypothesis):** corr only **+0.12**
(weakly positive, NOT a hedge). On the fade book's 10 WORST days, ES traded $0 (absent, ~base-rate).
On ES's 10 best days the fade book was mostly ALSO positive (incl. Apr-9 fade +$7,050: glx +6595,
lstb +1935, glf −1900). So it's a modest INDEPENDENT/uncorrelated additive stream, **not** the
tail-hedge I first claimed. (Overlap 2025-01-13..2026-01-23, only 23 ES days = thin.)

**Thread 2 — tail-loss stops:** disaster stops HURT or are neutral even when wide (60pt $26k/PF1.38;
80pt $46k/PF1.66 + HIGHER DD; 100pt $49k/PF1.73; 120pt≈none $52k/PF1.82). Convex strategy wants NO
stop — the EOD hold IS the risk management. Worst loss ~$4.5k is the figure to size around.

**Thread 3 — entry-timing (REAL refinement):** `no-entry-after 12:00` keeps $50,538 (vs $52,193
all-day) but lifts **PF 1.82→1.94, Sharpe 2.35→2.67, WR 63.7→65.9%**, DD ~flat. Afternoon breakouts
are net noise. REFINED config = lookback14, mult1.5, long, hold-to-EOD-15:45, no-entry-after 12:00.

## Data-hygiene lesson (reusable)
NEVER price trade entries/exits directly from the `days.json` mClose matrix — it is last-write-wins
across contract months (built for σ-ratio averaging, where roll spreads wash out). For PnL, fills
MUST come from the strict-primary-filtered 1s store (`rth1s.bin`). A strategy that prices off the
raw matrix will show phantom roll-spread profits, worst on NQ (~70pt spread vs ES ~10pt).

## Pipeline
- `01-sim.js` — standalone 1s-honest simulator (full re-stream).
- `02-precompute-rth-1s.js` — one-time 6.9GB stream → `output/days.json` + `output/rth1s.bin`.
- `03-sweep.js` — fast in-memory param sweep over the feature store (seconds/variant).
