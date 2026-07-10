# LT-Level Magnet Race Study — Phase 1

**Date:** 2026-07-06 | Follow-on from the DeepDive Weekly Chat accuracy study (`REPORT.md`), testing the "levels as magnets" hypothesis mechanically on the full local LT feeds.

## Question

Treat higher-timeframe liquidity levels as magnets; from any moment, race the nearest LT level above vs below spot — which gets touched first? Is the outcome predictable beyond what pure distance implies, and do short-term state variables (sentiment, momentum, time-of-day) select the winning side?

## Method

- **Data:** `data/liquidity/nq/NQ_liquidity_levels.csv` (15m cadence, 2023-03→2026-06) and `data/liquidity/es/ES_liquidity_levels_{15m,1h,1D}.csv` (2021→2026-01 usable, bounded by ES 1m raw). LT timestamps are **ET** (verified by Sunday 18:00 Globex reopen); levels are raw-contract prices, all races run on raw 1m OHLCV with per-hour volume-primary contract filtering, censored at rollovers.
- **Race:** at each (hourly) sample, nearest level above and below spot (min 0.05%, max 8% away, both must exist). Walk 1m bars forward: first side touched (high≥up / low≤dn) wins. `lt-magnet-race.py` → `races/races_*.csv`.
- **Baselines:** fair random walk P(up first)=d_dn/(d_up+d_dn) (gambler's ruin), plus a drift-adjusted variant using per-year μ/σ² from weekly returns (drift-to-variance ratio is timescale-invariant). Excess = actual − model.
- Resolution rates 95–99%; median time-to-touch: NQ15m 71 bars, ES15m 132, ES1h 261, ES1D 2,256.

## Finding 1 — Raw LT levels are NOT magnets

The fair-distance model is essentially perfectly calibrated:

- **ES 1h (n=16,953) and ES 15m (n=13,931): excess within ±1–2pt at every fair-P bucket**, no systematic pull toward levels.
- **NQ 15m (n=11,001): +2.2pt uniform excess, but it's index drift** — after drift adjustment the residual is +1.6pt (z=3.7, and inflated by race overlap). ES 1D (n=658) is noise.

Price reaches an LT level at about the rate it would reach *any* price at that distance. Reconciliation with the Weekly Chat study (levels the author *chose to write about* beat base rates, z=2.15): **selection/curation carried that edge, not the level feed itself.** This suggests the edge lives in *which* levels are highlighted (confluence, context), not in mechanical proximity — directly relevant to Phase 2 design.

## Finding 2 — Which-level-first IS predictable on NQ, from state variables

Drift-adjusted excess up-probability, NQ 15m races:

| Condition | n | up-rate | adj-fair | excess | z |
|---|---|---|---|---|---|
| LT sentiment BULLISH | 5,618 | 52.3% | 48.5% | **+3.7pt** | +6.2 |
| LT sentiment BEARISH | 5,130 | 51.7% | 52.6% | −0.9pt | −1.4 |
| BULLISH **and** 3-day mom > 0 | 2,110 | 56.4% | 51.0% | **+5.4pt** | +5.5 |
| 3-day mom > 0 alone | 4,675 | 56.7% | 53.4% | +3.2pt | +5.0 |
| BEARISH and mom < 0 | 1,254 | 44.3% | 46.5% | −2.3pt | −1.8 |
| Overnight 00–03 ET | 2,177 | 54.9% | 51.4% | +3.5pt | +3.7 |

- The BULLISH-sentiment lift is **stable every year** (+4.2 to +4.6pt raw excess in 2023/2024/2025) and **additive beyond momentum** (~+2pt on top of mom>0 alone).
- The bearish side is dead — the same one-sided pattern as the Weekly Chat direction calls and the level-role results (upside info real, downside info absent). Familiar echo of the book's own "shorts weak in pos gamma" asymmetry.
- **ES shows none of this** (sentiment excess flips sign by year on 1h; ~0 on 15m; 2022 bear year is the only span where BEARISH sentiment worked). The state-conditional edge is NQ-specific, not timeframe-specific.
- A candidate "rank-5 anti-magnet" pattern on NQ (+3.6pt) **inverts on ES (−4.2pt)** → discarded as product noise.

## Economic size (gross, race-level)

Trading WITH bullish sentiment (long at spot, target = nearest LT above, stop = nearest LT below) earns ~+0.022%/race gross (~4–5 NQ pts, median hold ~1.2h); the BULL+mom>0 subset is better but still thin vs ~1–1.5pt round-trip costs. **As-is this is a real but thin edge — it needs the Phase-2 overlays to concentrate it.** Caution: races sampled hourly overlap heavily (median resolution 71 bars), so nominal z-scores overstate effective significance ~1.5–2×; the BULLISH result survives that haircut, weaker cuts don't.

## Phase 2 plan (next)

1. **Overlay the book's short-term state features** onto NQ races: GEX regime/sign + flip distance (data exists 2024+), IV/IV-skew, LS state, squeeze momentum, wick-absorption at the level, DDS weekly vol flag. Goal: push the up-race subset from 56% → 60%+ and concentrate %/race ≥ 3× costs.
2. **Test level curation/confluence** — Finding 1 says selection matters: stack ES 15m+1h+1D levels and test whether multi-TF-confluent levels out-attract single-TF levels at matched distance (NQ higher-TF LT would need a TV dumper pull).
3. **1s-honest backtest** of any concentrated rule (fills at level touch, stop at opposite level) per CLAUDE.md — race-level probabilities are fill-free; PF/Sharpe claims must come from the 1s path.
4. Non-overlapping trade sequencing (one race at a time, FCFS-style) for honest Sharpe/DD.

---

# Phase 2 — GEX overlay (2026-07-06)

`phase2-gex-overlay.py` joins each NQ race to the latest lookahead-corrected GEX snapshot (`data/gex/nq/`, 15-min, 2023-03→2026-06) at or before race time (median age ≤15m; races without a snapshot within 45m — mostly overnight — drop out: 6,101 of 11,001 joined).

## Finding 3 — GEX levels BLOCK the path to LT levels (the discriminator)

GEX regime alone adds nothing (pos/neg both ~0 excess). The structure is in the ladder geometry:

| Condition (drift-adj excess up-probability) | n | excess | z |
|---|---|---|---|
| GEX resistance between spot and up-LT target | 559 | **−8.9pt** | −4.9 |
| GEX support between spot and down-LT target | 750 | **+8.1pt** | +5.3 |
| up-LT sits ON a GEX resistance (≤0.15%) | 1,655 | −4.5pt | −4.1 |
| down-LT sits ON a GEX support | 1,919 | +6.0pt | +5.9 |
| down-LT = put wall (shielded) | 533 | +8.5pt | +4.4 |
| spot within ±0.5% of gamma flip | 433 | −10.5pt | −4.9 |

GEX levels act as **barriers protecting the LT level behind them** — the mirror image of why gex-level-fade works. "Which LT level does price move to next?" ≈ "which path is free of GEX obstacles?"

## Composite rule + non-overlapping cost-adjusted sim (1m touch-based, INDICATIVE)

**Rule:** when one path to the nearest LT level is GEX-clear and the opposite path is GEX-blocked → enter toward the clear LT level; target = that LT level, stop = opposite LT level. Excess is year-stable (long side +12.9/+6.7/+8.8pt in 2023/24/25; short side 0/−11.9/−16.2 — short dead in 2023).

Chronological, one position at a time, 1.5 NQ pts round-trip costs:

| Side | n | WR | PF | avg pts | total pts | maxDD | med hold |
|---|---|---|---|---|---|---|---|
| Long | 507 | 78.1% | 1.71 | +15.0 | +7,597 | 966 | 55m |
| Short | 344 | 78.5% | 1.72 | +13.3 | +4,579 | 623 | 70m |
| **Both** | **799** | **78.5%** | **1.75** | **+14.9** | **+11,878** | **881** | **57m** |

By year (both): 2023 PF 1.86, 2024 PF 1.55, 2025 PF 2.12, 2026 PF 1.05 (thin n). ~0.9 trades/day when GEX data exists (RTH+evening only).

**NOT yet a gold-standard claim.** Honesty gaps before this is real: (1) 1s-honest fill/exit validation is MANDATORY (this sim counts 1m touches; same-bar double-touch races were excluded, which slightly flatters); (2) multiple-comparison haircut — ~15 conditions were examined, though the barrier hypothesis was prior-driven and z≈5 with year stability; (3) stop = opposite LT is wide (median 0.54% ≈ 115pt) — exit engineering (stop cap / BE rules) untested; (4) GEX-snapshot ladder is QQQ-derived — multiplier drift around rollovers adds level-placement noise.

---

# Phase 3, step 1 — 1s-honest validation (2026-07-06): PASSED

`1s-validate-composite.py` regenerates the 1,241 composite signals with NO reference to 1m race outcomes (same-bar-ambiguous races back in), then executes on 1s bars via the minute-offset index: entry = next 1s open + 0.25pt slip, target = exact-price limit at the LT level, stop = opposite LT − 0.5pt slip, **same-second double-touch counted as a stop**, 0.2pt commissions, one position at a time, roll fade-out guard.

| | n | WR | PF | avg pts | total | maxDD |
|---|---|---|---|---|---|---|
| 1m touch sim (gate) | 799 | 78.5% | 1.75 | +14.9 | +11,878 | 881 |
| **1s honest** | **792** | **77.1%** | **1.80** | **+15.7** | **+12,399** | **905** |

By year (1s): 2023 PF 2.03, 2024 PF 1.63, 2025 PF 2.08, 2026 PF 1.11 (n=27, GEX-thin). Exits: 621 target / 169 stop / 2 timeout. All deltas within the ~10% replication tolerance → **no fill-bar bug; the edge survives honest execution.** Trades in `results/onesec_trades.csv`.

Current geometry is high-WR / inverted-RR: median target ~0.21% (~45pt), median stop ~0.54% (~115pt). Next lever is exactly entry/exit optimization: entries near intraday structure (daily open, ON H/L, prior-day H/L, hourly H/L — precomputed in `structure/NQ_session_levels.csv` + `structure/NQ_hourly_hl.csv` by `build-structure-levels.py`) to shrink the effective stop; stop caps / BE rules on the exit side.

---

# Phase 3, step 2 — entry & stop optimization (2026-07-06)

Infrastructure: `1s-extract-paths.py` caches per-signal 1s path primitives (first target/stop touch times + adverse-extreme staircase) so entry/stop variants replay instantly (`sweep-entries.py`, `sweep-stopcap.py`). BE/time-stop variants need real paths → dedicated 1s pass (`sweep-be-1s.py`). Baseline replays the validated run exactly (sanity ✓).

## Entry sweep — limit entries dominate market entry

Limit at a fractional pullback of the entry→stop range (fill = staircase touch, exact price; misses = target ran before fill):

| entry | n | missed | WR | PF | avg | total | maxDD | realized RR |
|---|---|---|---|---|---|---|---|---|
| market (baseline) | 791 | 0 | 77.2% | 1.81 | +15.7 | +12,452 | 905 | 0.53 |
| **pull 10%** | 599 | 192 | 71.8% | **1.96** | **+22.1** | **+13,224** | **802** | 0.77 |
| pull 30% | 402 | 389 | 58.0% | 1.95 | +25.3 | +10,164 | 908 | 1.41 |
| pull 50% | 297 | 494 | 43.1% | 1.77 | +19.9 | +5,918 | 591 | 2.34 |
| structure nearest | 514 | 240 | 69.6% | 1.90 | +19.9 | +10,234 | 734 | 0.83 |

- **10% pullback is strictly better than market entry**: more total points despite 24% missed trades, higher PF, lower DD. Deeper pullbacks buy RR (up to 2.3) at the cost of frequency — a sizing choice, not a free lunch.
- **Structure-level entries (PD low/close, ON H/L, RTH open, hourly H/L) work but do NOT beat simple fractional pullbacks** — the pullback fraction is the load-bearing variable, not which reference level it lands on. (Point-in-time honesty enforced: no same-session RTH/ON values before 09:30.)
- Caveat: 2026 turns slightly negative in limit variants (n≈15) — worth watching, consistent with thin GEX coverage there.

## Stop-cap sweep — the wide LT stop EARNS its width

On both entry variants, every stop cap degrades PF and total PnL (pull_0.1: cap 40 → PF 1.67/+8,437 vs uncapped PF 1.96/+13,224). Mechanism-consistent: the pullback entry sits inside the GEX-shielded zone, where adverse excursion is routine noise — the shield is why the wide stop rarely gets hit. Tight-stop+BE logic that works for glf/gfi does NOT transfer here. A defensive variant exists for DD-tolerance sizing: pull_0.1 + cap 20 → maxDD 335 (−58%) at PF 1.59 and half the PnL.

## BE / time-stop sweep (1s pass, entry = pull 10%)

| variant | n | WR | PF | avg | total | maxDD | tShp |
|---|---|---|---|---|---|---|---|
| none (control) | 599 | 71.8% | 1.96 | +22.1 | +13,224 | 802 | 6.4 |
| be_40_0 | 647 | 59.8% | 1.96 | +15.3 | +9,904 | **527** | 5.9 |
| ts_4h | 649 | 70.7% | 2.24 | +20.3 | +13,149 | 736 | 7.8 |
| **ts_8h** | **632** | **70.9%** | **2.28** | **+22.8** | **+14,429** | **763** | **8.1** |

- **Breakeven stops are NOT worth it here** (every BE variant lowers avg and total; be_40_0 is the DD-control option: maxDD −34% at avg +15.3).
- **Flat time-stops improve everything**: trades unresolved after ~4–8h are disproportionately eventual losers (the GEX snapshot justifying the trade is stale by then) and cutting them at market saves full stop-losses AND frees the slot for new signals. Empirical confirmation of the time-in-trade-is-risk principle.

Year-stability of the time-stop (PF by year, vs uncapped control): ts_8h improves on the control in **every full year** — 2023 2.65 vs 2.28, 2024 2.20 vs 1.79, 2025 2.70 vs 2.31. 2026 (n=19, GEX-thin, includes the June feed-outage window) is −177pt in both — the OOS watch item, not a time-stop artifact.

**Current best config ("LT-GEX path race v1"):** composite clear-path signal → limit entry at 10% pullback toward the opposite LT → target = clear-path LT level (limit, exact) → stop = opposite LT level (uncapped, behind the GEX shield) → flat time-stop 8h. **1s-honest: 632 trades / 3.3y, WR 70.9%, PF 2.28, +22.8pt/trade, +14,429pt total, maxDD 763pt.** (For comparison: glx v3 gold is PF 1.90, glf v2 PF 1.44.) Joint BE×TS grids deliberately NOT swept (overfit discipline — one lever at a time).

## Remaining overlays queued (Phase 3)

IV/IV-skew (1m cbbo), LS state (contrarian per ls-overlay research), wick-absorption at the target level, QQQ vol regime, DDS weekly vol flag; sentiment adds little on top of the composite (long +0.3pt, short +3.0pt) — test after exit engineering.

## Files

- `lt-magnet-race.py` (engine), `analyze-races.py` (calibration + conditioning), `phase2-gex-overlay.py` (GEX join + conditional analysis)
- `races/races_{NQ,ES15,ES1H,ES1D}.csv` — per-race records; `races/races_NQ_gex.csv` — GEX-enriched

---

# Phase 3, step 3 — overlay round (2026-07-07)

One-at-a-time meta-filters on the v1 trade set (ts_8h, 632 trades), features read at signal time, `sweep-overlays.py` → `results/overlay_enriched.json`. Conditioning tables are subset-only (no slot re-sequencing); the one survivor was confirmed with a fresh 1s pass (`confirm-stopwall-1s.py`).

## Data-gap discovery: 2026 LT sentiment is EMPTY

All 152 races in 2026 have blank sentiment in the feed — the "NEUTRAL" bucket (n=19, PF 0.87, −177pt) is *exactly* the 2026 trade set. Any sentiment-conditioned result silently zeroes out 2026 and flatters itself. The 2026 negative window remains explained by thin GEX coverage + missing sentiment, not adjudicated by it.

## Rejected overlays (no robust signal)

- **Sentiment-aligns-side** looked great pooled (PF 2.87, DD −65%) but is year-unstable: 2023 degrades PF 2.65→2.04 while 2024/25 improve; halves trade count; unevaluable in 2026. Rejected.
- **Daily IV features** (ivPct terciles, ivChg 5d, term slope, dte0 skew): all within noise of control; ivChg≤0 slightly better pooled (PF 2.57 vs 2.26 coverage control) but not uniform by year.
- **Intraday 1m IV skew (2025+)**: put-rich vs call-rich = nothing (coverage only 115 trades).
- **LS state (2025+)**: align vs oppose PF 2.33 vs 2.11 — noise, no contrarian edge here (unlike the FCFS book overlays).
- **DDS weekly call**: bearish weeks show higher avg (+26.8 vs +19.8) via bigger ranges but identical PF — the vol-flag effect is already captured by geometry (below).
- **Gamma regime / flip distance / snapshot age / target-is-wall / LT rank**: no actionable splits (positive regime is the weakest tercile at PF 1.95 but n is large in every bucket and ordering isn't stable enough to gate on).

## Marginal survivor: exclude stop-on-wall (NOT adopted into v1)

Signals whose stop-side LT has a GEX wall sitting ON it (`stp_is_wall`, 169/1,241 signals) conditioned badly (PF 1.19, avg +5.3). Fresh 1s pass dropping them pre-sim (slot re-sequencing honest):

| | n | WR | PF | avg | total | maxDD | tShp |
|---|---|---|---|---|---|---|---|
| v1 (control) | 632 | 70.9% | 2.28 | +22.8 | +14,429 | 763 | 8.1 |
| v1 + no-stop-wall | 561 | 72.0% | **2.46** | **+24.7** | +13,879 | 764 | 8.2 |

By year: 2023 2.47 (vs 2.65 control — gives back), 2024 2.57 (vs 2.20), 2025 2.97 (vs 2.70), 2026 0.86 (vs 0.87, unchanged). The subset conditioning had promised maxDD 564 and a positive 2026 — **both evaporated under honest re-sequencing** (re-admitted signals refill the same drawdown window). Net: +0.18 PF and +1.9pt/trade for −4% PnL, DD flat, one year worse. Real but marginal — documented, not promoted. Mechanism note: a wall on the stop-side LT contradicts the composite's premise (the "shield" level is itself a magnet/battleground).

## Sizing tilt (queued for portfolio phase): wide geometry

Trades where the stop-side LT is >0.8% away (n=108, ~17%) run PF 3.01/26.7/4.13 in 2023/24/25, WR 83%, avg +60pt — the clear-path edge concentrates when LT spacing is wide (high-vol days; 60/108 in top-tercile IV; corroborated by intraday IV≥0.25 → PF 14 on n=36, 2025+). Not a drop-filter (base is fine) — a **size-up candidate** for the portfolio phase.

## Overlay-round conclusion

**v1 stands unchanged.** No overlay robustly improves PF+DD+Sharpe together once slot re-sequencing is honest. Wick-absorption at the target level (in-trade exit overlay) remains untested — it needs a different harness (1s walk with order-flow join), queued behind ES/multi-TF confluence and OOS discipline.

---

# Phase 3, steps 4–5 — exit overlay + ES confluence (2026-07-07)

## Step 4: near-target rejection exit — REJECTED

Tested the market-aware-exits failure mode (trade runs 70–90% of the way to the target LT, gets rejected, round-trips): arm at F∈{0.7,0.8,0.9} of entry→target progress, exit at market on the Nth (1 or 2) retreat of 0.3×dist from the post-arm peak, layered on full v1 (`sweep-target-reject-1s.py`, fresh 1s pass, independent slots). **Every variant is worse than plain v1** — even the mildest (arm 0.9, 2nd rejection, only 27 exits fired) bleeds total PnL; aggressive ones give up ~20% with no DD benefit. With the wide GEX-shielded stop, rejected approaches re-attack rather than round-trip, and ts_8h already cuts the stale ones. This also retires the absorption-fast-exit idea here (it was already marginal in the wick-fade research on a much shorter-hold product).

## Step 5: ES clear-path confluence — CONFIRMED, the headline overlay

Same composite rule computed on ES (races_ES15/1H + `data/gex/es/` snapshots, identical params) and read as a state (long/short/none) at each NQ signal (`sweep-es-confluence.py`). Conditioning: **es15 agree** → n=89, WR 88.8%, PF 12.96, avg +60pt, stable every year (PF 13.4/13.4/12.4); es1h agree weaker and 2023-unstable (2.60 vs control 2.71) — 15m is the lever. Orthogonal to geometry: agree & NOT wide-geom still PF 7.02; agree & wide-geom nearly lossless (n=34, WR 94.1%, maxDD 28pt).

**Fresh 1s re-sequenced confirmation (`confirm-es15-1s.py`, gate = ES 15m state agrees with NQ side at signal time):**

| | n | WR | PF | avg | total | maxDD | tShp |
|---|---|---|---|---|---|---|---|
| v1 (all signals) | 632 | 70.9% | 2.28 | +22.8 | +14,429 | 763 | 8.1 |
| **v1 + ES15-agree gate** | **121** | **86.8%** | **7.87** | **+50.1** | **+6,060** | **174** | **8.4** |

By year: 2023 PF 10.47 / 2024 10.21 / 2025 5.93. Exits: 98 target / 11 stop / 12 time-stop. **First overlay to survive honest slot re-sequencing** — unlike stop-wall, the effect *grew* (conditioned 89 → gated 121 trades as freed slots admitted more agree signals).

Mechanism: NQ GEX comes from QQQ options, ES GEX from SPY — independent complexes. When both show the same clear-path/blocked-path barrier geometry simultaneously, the race is index-wide, not NQ-idiosyncratic.

Caveats: (1) ES race/LT backtest data ends 2026-01 → the gate is unevaluated in 2026 (live ES LT feed exists, so this is a backtest wall only). (2) ~0.7 trades/week — a high-conviction sleeve, not a replacement for v1's frequency. (3) Trades cluster 04–12 ET (26/89 conditioned in 04–05h).

**Positioning ("LT-GEX path race v1-ES" candidate sleeve):** with maxDD 174pt vs v1's 763, the gated sleeve sized ~4× runs at comparable DD with ~+24k pt equivalent — a sizing decision for the portfolio phase, deliberately not swept here. The wide-geometry tilt stacks inside it (n=34, WR 94%) but is too thin to structure around alone.

## Remaining queue

OOS discipline (the whole study is one continuous window — needs a holdout protocol before deploy talk), engine-strategy port (`shared/strategies`), FCFS-book interaction (does the sleeve collide with existing slots?), live-shadow. Wide-geometry size-up and ES-gate sizing belong to the portfolio phase.

---

# Phase 4 — engine-strategy port + gold standards (2026-07-07)

Ported as `shared/strategies/lt-gex-path-race.js` (aliases `lgpr`, `path-race`), registered in the backtest engine + CLI (`--lgpr-es-gate`, `--lgpr-pullback`, `--lgpr-max-hold-min`, `--lgpr-gex-max-age-min`). **It trades NQ only** — ES is a signal-time confirmation gate, never the traded instrument. Engine additions: `maxHoldWallMs` in the trade simulator (entry-relative wall-clock time-stop, opt-in per signal — `maxHoldBars` counts traded minutes and stretches across halts); pre-fill target-touch cancellation reused the existing `cancelOnPreFillExtreme` (lstb prior art). ES gate reads precomputed point-in-time clear-path states (`data/features/es15_clearpath_states.csv`, 4,958 hourly states).

Porting discoveries:
- **Research sampling grid ≠ wall clock**: every-4th-LT-row drifts with feed gaps (2024 signals mostly at :15). Ported as every-4th-fresh-row; the engine misses rows with no candle within 20 min, so grid phase drifts vs research (~50% shared signal instants over the full window). **Off-phase 2024 run: PF 1.96 / WR 76% — the edge does not depend on grid phase.**
- On shared signal instants, exits agree 96.5% (303/314); residual per-trade delta −5.4pt = research signal-minute fill optimism + engine stop slip 1.5 vs 0.5 (kept: book-comparable).

## Engine gold standards (full window 2023-03-28 → 2026-06-16, $20/pt, comm $4 RT)

| | n | WR | PF | Sharpe | PnL | maxDD | per-year PF |
|---|---|---|---|---|---|---|---|
| **v1** | 549 | 71.0% | 2.04 | 4.22 | $209,277 | 4.73% | 2.56 / 2.27 / 2.05 (+2026: 0.65, n=16) |
| **v1-ES** | 113 | 83.2% | 5.10 | 3.15 | $97,451 | 3.22% (261pt) | 9.60 / 5.80 / 3.82 |

Commands + config in `STRATEGY-GOLD-STANDARDS.md`; trade logs in `data/gold-standard/lt-gex-path-race-v1{,-es}-trades.csv`.

Remaining before deploy talk: OOS protocol (study is one continuous window), FCFS-book slot-interaction, sleeve sizing (v1-ES at ~4× ≈ v1 DD), live plumbing (ES clear-path state computed in data-service from live ES LT + ES GEX).

---

# Phase 5 — FCFS book integration + v1-ES as meta-filter (2026-07-08)

Harness: `research/4strategy-portfolio/run-with-lgpr.js` (same conventions as the $614,730 baseline: standalone gold trade lists, first-in-wins by entryTime, slot occupied [entry, exit)). lgpr window trades from the engine gold CSVs clamped to 2025-01-13→2026-04-23: v1 = 172 tr / $83,309; v1-ES = 38 tr / $36,196 (ES wall 2026-01).

## Single-slot FCFS (the "5th strategy" question)

| scenario | trades | WR | PF | Sharpe | maxDD | PnL | Δ vs baseline |
|---|---|---|---|---|---|---|---|
| 4-strategy baseline | 6,128 | 67.0% | 1.77 | 10.78 | 4.45% | $614,730 | — |
| + lgpr **v1** | 6,047 | 67.1% | 1.79 | **10.18** | **5.44%** | $658,351 | +$43.6k, Sharpe −0.60, DD +1pt |
| + lgpr **v1-ES** | 6,099 | 67.1% | 1.80 | **10.87** | **4.45%** | $634,521 | **+$19.8k, Sharpe +0.09, DD flat** |

- **v1-ES joins the book cleanly**: 30/38 signals accepted, displaces only 79 baseline trades / $13.1k, contributes $34.1k → strictly better on PnL, PF, Sharpe with DD unchanged.
- **v1 does NOT earn a book slot**: its 8h holds displace 259 trades / $26.3k (208 lstb + the higher-value gfi/glx among them) and lumpier holds cost 0.6 Sharpe and +1pt DD for +7% PnL — the exact blocking concern, confirmed.
- **v1 independently (2nd slot)**: merged 2-slot equity = $698,039 / PF 1.80 / Sharpe 10.13 / DD 6.34% — +$83.3k over baseline but needs a second contract's margin and deeper combined DD. v1 is an own-slot/own-sizing decision, not a book member. (2-slot with v1-ES = $650,926 / DD 7.24% — dominated by just putting v1-ES IN the book.)

## v1-ES-grade state as a higher-order directional filter (Drew's question)

Joint state = NQ clear-path signal with ES agreement, active for 8h (`research/4strategy-portfolio/lgpr-es-metafilter.py`). Book gold trades bucketed by side vs active state at entry:

| strategy | aligned | opposed | none |
|---|---|---|---|
| gex-lt-3m | n=40 PF **3.30** +$29.6k | n=22 PF **0.79** −$3.3k | PF 1.89 |
| gex-level-fade | n=41 PF **2.96** +$23.2k | n=42 PF **0.92** −$1.3k | PF 1.40 |
| lstb | PF 2.14 (n=183) | PF 1.65 | PF 1.58 |
| gex-flip-ivpct | n=8 — too thin | n=1 | PF 3.28 |

The GEX-family strategies (glx, glf) are strongly state-sensitive: **opposed-to-state trades are dead-to-negative; aligned trades run 1.7-2× their unconditional PF.** Mechanically consistent with the portfolio-filter findings (level-fade hates neg gamma; ltAlign). Caveats: ALL overlap is 2025 (ES wall kills 2026, book starts 2025) — single-year, small opposed-n (22/42), state active only ~15% of hours. Status: **candidate veto/size-up for the portfolio-filter research line**, not deployable yet.

## Verdict

v1-ES = the book's 5th strategy (clean add) AND a promising directional meta-filter for glx/glf. v1 = standalone sleeve on its own slot/margin if the +$83k is wanted at DD 6.34%. Note the margin question: lgpr holds overnight by design — the production book's 15:45 EOD day-margin model doesn't apply to it; an independent slot would carry overnight margin.

## Addendum (2026-07-08): production-real 2-strategy book (gfi + glx only)

Drew: lstb is NOT running in production (live results haven't held up — overtrades); glf also not running. Live-relevant baseline = gfi+glx. Same harness, `--book=gex-flip-ivpct,gex-lt-3m`:

| scenario | trades | WR | PF | Sharpe | maxDD | PnL |
|---|---|---|---|---|---|---|
| gfi+glx baseline | 589 | 58.4% | 2.31 | 8.66 | 4.42% | $360,177 |
| + lgpr v1 | 706 | 60.3% | 2.17 | 8.01 | 7.10% | $396,125 |
| **+ lgpr v1-ES** | 609 | 59.1% | **2.34** | **8.96** | **4.42%** | **$377,572** |

v1-ES improves the lean book on every axis (+4.8% PnL, PF/Sharpe up, DD flat; displaces $16.0k, adds $34.1k). v1 is WORSE here than in the 4-strat book — with no lstb/glf soaking the slot, 149/172 of its trades get in and DD balloons +60% (4.42→7.10) while PF/Sharpe drop; 9 displaced gfi trades alone cost $18.4k. Recommendation: v1-ES = 3rd live strategy (after ES data extension past the 2026-01 wall); v1 = independent-slot sleeve only (2-slot merged $443k / PF 2.24 / Sh 8.35 / DD 7.76%, overnight margin).
