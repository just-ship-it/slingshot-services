# First-Hour RTH NQ Strategy — Master Findings

**Date:** 2026-05-10
**Window studied:** 2025-01-13 → 2026-04-23 (15 months, ~325 trading days)
**OOS slice:** 2026-02-23 → 2026-04-23 (~2 months, 30-45 days)
**Tracks aggregated:** T0–T11 (12 parallel research tracks)
**Goal:** Single-trade-per-day NQ strategy, 9:30–11:00 ET, 20-30+ pt target

---

## 1. Executive Summary

Twelve parallel hypotheses were tested against post-fix CBBO GEX, raw NQ contracts, and the standard 15-month window. **Three structural edges emerged with both IS strength and OOS survival**:

1. **T5 — GEX Wall Fade at the open** is the strongest setup in the entire study. Limit-fading the closest support/resistance level when price opens within 50 pts of it produces 81% WR / PF 2.91 / Sharpe 8.67 IS, holding up at PF 2.0 OOS. ~1.6 trades/week. **Recommended top pick.**
2. **T8 — Gap × GEX Regime Fade** uniquely identifies positive-gamma fade days. `gap_up_strong × positive regime` → SHORT @ 9:30 with 20pt SL / 30pt TP, PF 2.04, Sharpe 5.65. ~2 trades/month standalone, 7-8/month if all three variants stacked.
3. **T7 — ONH/ONL Aligned-Gap Break** is the cleanest momentum play: gap_up_strong → buy ONH+5; gap_down_strong → sell ONL-5. PF 2.04 IS / **PF 4.00 OOS** with WR 94% (n=16). ~6.4 trades/month.

**One Tier-2 layer is mandatory globally**: T9's event-day kill-switch (NVDA T+1, FOMC, FOMC T+1 = hard skip; NFP T+1 = long-only). This is roughly 23 hard-skip days over the 15-month window — small slice, large risk reduction.

**Top single implementation pick: T5 GEX Wall Fade with the T9 event filter pre-applied.** Cleanest entry rule (limit at level, fixed 30/20 SL/TP), no momentum-chasing dependency, fastest exits (most winners hit target inside 5 min), independent from T7 (the next-best candidate). T5+T8 also stack cleanly because their direction logic is orthogonal (T5 fades the level, T8 fades the gap).

**Five hypotheses are killed:** T1 (post-sweep RTH-timed reversal), T6 (IB failure standalone), T10 (opening-drive continuation), T5-break variant (chasing through walls), T7-fade variant (degraded OOS in trend-heavy Q1 2026). Don't rebuild these.

**One-line ordering:** T5 > T7 > T8 > T2 > T11 > T4 > T3 > T6 > T1 ≈ T10 (NULL).

---

## 2. Tier-1 Standalone Strategies

| Rank | Track | Thesis | IS PF / Sharpe / DD | OOS PF / n | Trades/mo | EV/trade |
|---:|---|---|---:|---:|---:|---:|
| 1 | T5 | Limit-fade closest S/R level if price opens within 50 pt | 2.91 / 8.67 / 90 pt | 2.00 / 8 | 6.8 | +10.7 pt ($214/NQ) |
| 2 | T7 | Stop-buy/sell ONH+5 / ONL-5 on aligned strong gap | 2.04 / — / 185 pt | **4.00** / 16 | 6.4 | +8.9 pt IS, +14.1 pt OOS |
| 3 | T8 | Fade strong/mild up-gap in positive GEX regime | 2.04 / 5.65 / — | not run | 2.0 (variant A) | +8.8 pt |
| 4 | T2 | LONG/SHORT @ 9:30 by GEX wall asymmetry ≥ ±150 pt | 2.06 / 5.65 / 401 pt | 1.65 / 37 | 16.0 | +26 pt |
| 5 | T11 | Reclaim ON-VWAP from below in non-negative regime | 1.28 / 1.85 / 319 pt | **3.38** / 7 | 2.8 | +8.6 pt |
| 6 | T4 | 15-min ORB + gap-dir + ON-bias + IV-middle-60 filters | 1.91 / 4.79 / 214 pt | not run | 4.6 | +16.4 pt |

### 2.1 T5 — GEX Wall Fade (TOP PICK)

| Field | Value |
|---|---|
| Origin | T5 — `s_r / dist≤50 / stop=30 / tgt=20` |
| Thesis | Within ±50 pts of any S/R strike at 9:30, walls reject 78–85% of touches before breaking |
| Entry | At 9:30 ET, identify the *closest* level in `support[]∪resistance[]` within 50 pt of the open. Place a **limit** order at the level price (LONG if level below open; SHORT if above). |
| Stop | 30 pt from entry (level price ± 30) |
| Target | 20 pt from entry |
| Time-stop | If unfilled by 10:30 ET cancel; if filled, 60-min hard exit |
| Frequency | ~102 trades / 315 days = ~6.8 trades/mo (~0.32/day, ~1.6/wk) |
| WR | 81.4% IS, 75% OOS |
| PF | 2.91 IS / 2.00 OOS (8 OOS trades) |
| Sharpe | 8.67 IS |
| Max DD | 90 pt (≈4.5 stops in a row) |
| Per-trade EV | +10.7 pt = **$214 / NQ contract** |
| R:R | 2:3 (target:stop), but 81% WR carries it |

### 2.2 T7 — ONH/ONL Aligned-Gap Break

| Field | Value |
|---|---|
| Origin | T7 — Aligned-gap break, `stop=75/tgt=20` |
| Thesis | Strong gap that returns to ONH/ONL has momentum to break through |
| Entry | Stop-market at `ONH+5` if `gap > +0.4%`; stop-market at `ONL-5` if `gap < -0.4%` (skip if open already past level) |
| Stop | 75 pt beyond entry |
| Target | 20 pt |
| Time-stop | 11:00 ET soft / 12:00 ET hard |
| Frequency | ~96 trades / 15 mo = **6.4/mo** |
| WR | 87.5% IS, **93.8% OOS** |
| PF | 2.04 IS / **4.00 OOS** |
| Per-trade EV | +8.9 pt IS, +14.1 pt OOS |
| R:R | 1 : 3.75 (target : stop) — high WR required, and delivered |

### 2.3 T8 — Gap × GEX Regime Fade (Variant A: SHORT_HARD)

| Field | Value |
|---|---|
| Origin | T8 — Cell `gap_up_strong × positive regime` |
| Thesis | Dealers actively suppress strong up-gaps in positive gamma — fade the open |
| Entry | SHORT NQ at 9:30 market when `gap > +0.5% AND regime ∈ {positive, strong_positive}` |
| Stop | 20 pt above entry |
| Target | 30 pt below entry |
| Time-stop | 11:00 ET force flat |
| Frequency | ~33 trades / 16 mo = **~2/mo** |
| WR | 57.6% |
| PF | 2.04 |
| Sharpe | 5.65 |
| Per-trade EV | +8.8 pt = $176 / NQ |
| OOS | Not formally split (sample too small for OOS hold-out) |

### 2.4 T2 — Wall-Asymmetry Direction Bet (Workhorse, high-frequency)

| Field | Value |
|---|---|
| Origin | T2 — Rule R1, TP=75 / SL=100 |
| Thesis | When the call wall is far above and the put wall is close beneath, dealer hedge flow tilts bullish (and vice versa) |
| Entry | At 9:30 ET, market entry. LONG if `(callWall − price) − (price − putWall) ≥ +150 pt`; SHORT if same expression ≤ −150 pt |
| Stop | 100 pt | Target | 75 pt | Time | 11:00 ET |
| Frequency | 218 trades / 283 IS days = ~16/mo (>>1/day candidate, fires 77% of days) |
| WR | 70.6% IS, 67.6% OOS | PF | 2.06 IS / 1.65 OOS |
| Caveat | This is more "directional regime tilt" than "single-trade setup". Best used as a confluence layer or sized smaller. |

### 2.5 T11 — VWAP Reclaim Long (low-frequency, high OOS)

| Field | Value |
|---|---|
| Origin | T11 — `reclaim_long` × regime ∈ {positive, neutral, strong_negative} |
| Entry | If 9:30 open < ON-VWAP − 5 pt, then on first 1m close ≥ 5 pt above ON-VWAP between 9:30-10:30 ET, enter LONG |
| Stop | 60 pt | Target | 100 pt | Time | 90 min |
| Frequency | ~45 trades / 16 mo = **~2.8/mo** |
| WR | 48.9% IS / **71.4% OOS (n=7)** |
| PF | 1.28 IS / **3.38 OOS** |
| Caveat | OOS sample tiny but the regime gate generalizes; the IS Sharpe winners with no regime gate failed OOS. |

---

## 3. Tier-2 Confluence / Direction / Filter Layers

| Layer | Origin | Use | Effect |
|---|---|---|---|
| **Event-day kill-switch** | T9 | Hard-skip NVDA T+1, FOMC, FOMC T+1; long-only NFP T+1; 1.75× stop on PCE±1, CPI, NFP, FOMC T-1 | ~23 hard-skip days / 15 mo (~7%); MAE on those days runs 1.9-4.1× baseline so the savings are concentrated where it matters |
| **Wall-asymmetry direction tilt** | T2 R1 | Bias trade direction on standalone setups (T5, T11) when `wallAsym` is ≥ ±150 pt | Adds independent confirmation; OOS PF 1.65 |
| **GEX regime gate** | T8 cell logic | Block setups in mismatched regime (e.g. don't take T11 reclaim when regime = `negative` or `strong_positive`) | Already the core gate of T11; should also gate T2 short-side |
| **Weekday tilt** | T9 | Monday +9 pp bull, Thursday -8 pp bear | Tie-breaker only — not a filter |
| **Gap bucket / bull-15m baseline** | T0 | gap_down_strong + bullish 15m bar = 82.5% close above open at 11:00 | Cheap signal at 9:45 ET to confirm a long bias on panic-down opens |
| **IV middle-60 band** | T4 | Skip when 9:30 QQQ ATM IV outside p20-p80 (0.149-0.249) | Removes panic / complacency tail days; lifted T4 Sharpe to 4.79 |
| **Overnight bias / VWAP slope** | T4, T11 | ON close in upper-half range → long-bias; falling slope → don't reclaim | Stack-able with T11 and T4 |

---

## 4. Trade-List Overlap Analysis

Computed pairwise overlap on reconstructed trade-day sets. T2, T5 trade lists were summary-only in the JSON outputs, so T8 was reconstructed from `T8.perDay`, T11 from `T11.signals.reclaim`, T7 from `T0.perDay` gap-strong filter, T1 from full `t1.trades[]`.

### Set sizes (15-month window)

| Set | Definition | Size |
|---|---|---:|
| T8_HARD | gap_up_strong × {positive, strong_positive} regime | 42 |
| T8_FADE | gap_up × {positive, strong_positive} | 40 |
| T8_DRIFT | flat × positive | 54 |
| T8_ALL | union of the three T8 short cells | 136 |
| T7_ALG | aligned-gap break candidates (gap_strong only) | 165 |
| T11_RL | reclaim long, regime-gated | 45 |
| T1_SWEEP | post-sweep reversal trade days | 245 |

### Pairwise day-level overlap (Jaccard, intersection)

| Pair | Inter | Jaccard | Notes |
|---|---:|---:|---|
| T8_HARD ∩ T11_RL | 0 | 0.0% | **Fully diversified.** No conflict possible. |
| T8_HARD ∩ T7_ALG | 42 | 25.5% | **DIRECT DIRECTION CONFLICT** — every T8_HARD day is also a T7-LONG aligned-break candidate. **Cannot stack T8_HARD + T7 long-side as a portfolio.** Pick one. |
| T8_ALL ∩ T7_ALG | 55 | 22.4% | Same conflict pattern but only on the gap-strong slice |
| T8_ALL ∩ T11_RL | 4 | 2.3% | Effectively independent |
| T11_RL ∩ T7_ALG | 24 | 12.9% | Modest — both triggered on directional days but T11 is long-only and T7 long is gap-up; T7 short on gap-down days does not conflict with T11 long |
| T7_ALG ∩ T1_SWEEP | 100 | 32.3% | T1 fires on most directional days anyway |
| T11_RL ∩ T1_SWEEP | 38 | 15.1% | |
| T8_HARD ∩ T1_SWEEP | 28 | 10.8% | |

### Combined coverage of the three Tier-1 picks (T5, T7, T8, T11) — see caveat

Combining T8_HARD + T11_RL + T7_ALG (the three trade-day sets we can reconstruct) covers **186 unique days vs 252 if summed = 26% redundancy**, almost all of which is the T7×T8 direction-conflict on gap_up_strong days. After resolving that conflict (drop one side of the duplicates), the portfolio is essentially independent.

T5 trade-day set was unavailable as a full list, but T5 trade-days are determined by *price proximity to a wall at the open*, NOT gap or regime — structurally orthogonal to all four others. Expect T5 to overlap T8_HARD on roughly its base rate of 32% (the days where price happens to open near a wall), with no direction conflict (T5 fades the level, not the gap, so on a gap_up_strong day where price opens at R1 it would also be SHORT — agreement with T8).

### Portfolio recommendations

| Combination | Stack? | Rationale |
|---|:---:|---|
| T5 + T8 | YES | Direction-aligned on overlap days; structurally independent |
| T5 + T11 | YES | Different price triggers; sample sizes too small to confirm OOS but no theoretical conflict |
| T8 + T11 | YES | Jaccard 2.3%, no conflict |
| T7 + T8 | NO | 100% direction conflict on gap_up_strong + positive days. Pick whichever has higher OOS conviction (T7 currently — PF 4.0 OOS) |
| T7 + T11 | YES | T11 only fires on reclaim, T7 only fires on aligned break |
| T2 (Tier 1) + anything | Use as direction tilt only | T2 fires 77% of days; treating it as standalone double-counts |
| T1 + anything | NO standalone, optional confluence | T1 weak edge; not worth its 245-day footprint |

---

## 5. Recommended First Implementation: **T5 GEX Wall Fade**

**Rationale:** Cleanest entry mechanic (limit at price), tightest IS Sharpe (8.67), best WR (81%), shortest hold (most winners exit < 5 min), structurally orthogonal to other Tier-1 picks, OOS survives at PF 2.0 (although thin n=8). T7 has higher OOS PF but the 75-pt stop is large and the trade is conceptually a momentum chase, which historically has not survived re-tunes well in NQ. T5 is the safest first build.

### Implementation spec

| Item | Value |
|---|---|
| File | `shared/strategies/first-hour-gex-wall.js` (new, extends `BaseStrategy`) |
| Engine entry | `place_limit` at level price (zero slippage on fill) |
| Limit timeout | If unfilled by 10:30 ET, cancel |
| Stop | 30 NQ pts (broker stop converted to market on hit) |
| Target | 20 NQ pts |
| Time stop | 60 min after fill |
| Day filter | Apply T9 event kill-switch (skip NVDA T+1, FOMC, FOMC T+1) |
| Wide-stop multiplier | 1.5× on PCE/CPI/NFP days (target unchanged) |

### Required CLI flags

```
--strategy first-hour-gex-wall
--timeframe 1m --raw-contracts
--gex-dir data/gex/nq-cbbo
--start 2025-01-13 --end 2026-04-23
--fhgw-max-dist 50
--fhgw-stop 30
--fhgw-target 20
--fhgw-types s_r          # support[] ∪ resistance[]; not call_wall/put_wall/gamma_flip
--fhgw-window 09:30-10:30
--fhgw-time-stop 60
--event-filter on         # implement T9 kill-switch as engine-level filter
```

### Data dependencies

| Resource | Path | Status |
|---|---|---|
| NQ raw OHLCV | `data/ohlcv/nq/NQ_ohlcv_1m.csv` | exists |
| GEX CBBO snapshots | `data/gex/nq-cbbo/nq_gex_<date>.json` | exists, 325 days, post-bucket-fix |
| Rollover log | `data/ohlcv/nq/NQ_rollover_log.csv` | exists |
| T9 event calendar | `research/first-hour/output/T9-dow-events.json → events` | exists, ship as static JSON |

### Estimated implementation effort

**Small** (~4-6 hours):
- Strategy class: 100-150 LoC (load 9:30 GEX snapshot, find closest level, emit limit + stop + tgt)
- Event filter helper: 50 LoC (`getEventTag(date)`)
- CLI flag wiring: 30 LoC in `cli.js`
- Engine `place_limit` + same-bar stop/target priority already handled

### First backtest command

```bash
cd backtest-engine
node index.js \
  --ticker NQ --strategy first-hour-gex-wall \
  --timeframe 1m --raw-contracts \
  --gex-dir data/gex/nq-cbbo \
  --start 2025-01-13 --end 2026-04-23 \
  --fhgw-max-dist 50 --fhgw-stop 30 --fhgw-target 20 \
  --fhgw-types s_r --fhgw-window 09:30-10:30 --fhgw-time-stop 60 \
  --event-filter on
```

**Expected output to validate** against T5 research: ~102 trades, WR ~81%, PF ~2.9, +1090 pt over 15 months. With T9 event filter on, expect ~5-8 fewer trades and slightly improved DD.

---

## 6. Phase 2 / Future Work

### Partials & runners (user's stated Phase 2 goal)

| Strategy | Phase-2 idea |
|---|---|
| T5 wall fade | Take 50% off at +20 pt (current target), trail remainder to entry+10 / target +50 pt. With 81% IS WR on the first scale, the runner cost is small and adds tail upside. |
| T7 aligned-gap break | At 88% WR on +20 pt target, scale 50% off and trail runner to ONH/ONL+50 with breakeven stop. Phase-2 prototype already noted in T7 findings. |
| T8 SHORT_HARD | Asymmetric scale: half off at +20, half runs to opposite wall with trailing stop. Cell mean magnitude tilt is -94 pt — runner has plenty of room. |

### Cross-track combinations worth testing

1. **T5 + T2 wall-asymmetry direction tilt** — only take T5 long fades when wallAsym ≥ +50 pt, only T5 short fades when wallAsym ≤ -50 pt. Should improve WR.
2. **T5 + T8 stacked portfolio** — orthogonal triggers, direction-aligned on overlap. No conflict expected.
3. **T7 + T9 event filter** — T7 OOS PF 4.0 may be even higher with hard-skip days removed.
4. **T6 IB-failure with T7's aligned-gap pre-condition** — IB-failure standalone is weak; pairing with a momentum/regime confirmation might rescue it.
5. **T1 sweep + T2 wall-asym side-prediction confluence** — T1 alone is too weak, but the original 90.5% sweep-side prediction may align with T2's directional signal often enough to lift T1 to standalone-grade.
6. **T11 + slope filter sweep** — current filter is binary (regime in/out); a slope-band sweep on the 90-min ON-VWAP slope could add another 5-10 pp WR.

### Data improvements

- Re-run T7 fade-family after Q2 2026 OOS data accumulates — current OOS degradation may be a regime artifact.
- T3 IV-bell short-side has zero OOS coverage; collect low-IV days through paper trading and reactivate.
- Build 1-second replay path for top configs to remove same-bar stop-vs-target tiebreak conservatism (T5, T7, T8 all flagged this).

---

## 7. Stale / Killed Hypotheses

| Track | Why killed |
|---|---|
| T1 — Post-sweep reversal restricted to RTH | The 67.6% all-session reversal rate drops to 51% inside the 9:30-11:00 window. The post-sweep edge is a multi-hour phenomenon, not a first-hour one. |
| T6 — IB failure reversal standalone | OOS PF 1.25, WR 41% — does not clear the 50% bar. Wall-touch confluence subset went 0/4 OOS (overfit). Strategy is structurally a 10:30+ entry, conflicts with the 9:30-11:00 spec. |
| T10 — Opening-drive continuation | 48-53% continuation probability — coin flip. P(TP-before-SL ±30) on first-15m drives is 41%, *worse* than random. NULL. |
| T5 — Wall BREAK variant (chase) | Every breakout parameterization tested (10 type sets × 3 distances × 25 stop/target combos) lost money in-sample. First-hour edge is unambiguously fade. |
| T7 — Fade family (ONH-fade × positive, ONL-fade × non-positive) | IS PF 2.6 looked great but degraded to OOS PF 0.6-1.5 in trend-heavy Q1 2026. Flag as regime-dependent. Aligned-gap break is the survivor. |
| T2 R7 — Original sweep-prediction composite as direction signal | OOS PF 0.54, Sharpe -4.99. The 90.5% sweep-side score does NOT generalize to close-by-11:00 direction. Stick to wallAsym. |
| T11 — Rejection variant | All IS-favored configs collapsed OOS (n=1-5, PF 0-0.30). Don't deploy. |
| T3 — IV-bell short side | Zero OOS coverage (no low-IV days in Feb-Apr 2026). Long-side directional signal is weak (r=0.138). Park until more low-IV samples. |

---

## 8. Cross-Track Patterns Worth Flagging

1. **First-hour NQ is a fade market, not a chase market.** T5 (wall fade), T7 (level retest), T8 (gap fade), T10 (no continuation) all converge on this. Any future "breakout" hypothesis should start with a strong prior against.
2. **GEX regime is the most consistently useful filter across tracks.** It appears as a primary or secondary filter in T2, T5, T7, T8, T11. Build event-day-style infrastructure around regime classification at 9:30 ET.
3. **OOS degradation is universal but uneven** — fade-family strategies (T5, T7-fade) saw 30-50% PF compression OOS in the trend-heavy Q1 2026 slice. Aligned-direction trades (T7 break, T11 long-only) actually *improved* OOS. Combine fade with directional confirmation when possible.
4. **Sample sizes for the deepest cells (T8 strong_positive, T7 fade × small regime cells, T3 short-side) are too small to validate** — the highest IS PFs in the study (T2 R5 PF 6.29, T7 ONH-fade × positive PF 2.62) all live in cells with n < 65. Plan paper-trading to build OOS samples on these before sizing up.
5. **The 2025-04-07 tariff-shock day is the dominant outlier** in the entire dataset (range 1688 pt). It distorts T9 weekday stats and several T0 magnitude tails. Track and version any "regime-defining" events.

---

## Files

- This document: `/home/drew/projects/slingshot-services/backtest-engine/research/first-hour/MASTER-FINDINGS.md`
- Per-track findings: `T0-FINDINGS.md` through `T11-FINDINGS.md` in same directory
- Per-track data: `output/T0-baseline.json` through `output/T11-vwap.json`
- Overlap analysis script: `/tmp/overlap-analysis.js`
- Master plan: `MASTER-PLAN.md`
