# A2 — Level-Interaction Census (GEX + LT levels vs placebo)

**Date:** 2026-07-16 · **Charter:** GREENFIELD.md / KNOWABILITY.md · **Status:** descriptive census only — NO fills simulated, NO WR/PF/Sharpe computed (that requires 1s data, later).

**Question:** do externally-supplied levels (causal options-derived GEX levels; live-captured LT feed, `level_1..5` only — sentiment column never read) measurably alter NQ 1m price behavior relative to placebo levels run through *identical* machinery?

**Headline:** almost everything is placebo. One small effect survives both placebo families and is sign-stable every year: **price penetrates ~5–15% less deeply beyond real LT levels in the 30m after a touch** (rejection depth unchanged — it is follow-through damping, not extra bouncing). Everything else — bounce/break rates, session-extreme termination, attraction/repulsion, GEX+LT confluence, first-touch specialness — is indistinguishable from placebo or inverts across years.

---

## 0. Machinery (scripts, all rerunnable from repo root)

| Script | What it does |
|---|---|
| `A2-00-cache-primary-1m.py` | Streams raw `NQ_ohlcv_1m.csv` (csv module), drops calendar spreads (`-` symbols), keeps highest-volume contract per clock-hour → `cache_nq_primary_1m.csv` (1,934,369 bars, 2020-12-27→2026-06-15). Only valid price space for GEX/LT comparison. |
| `a2_common.py` | ET session logic, as-of feeds (at-or-before + 45min staleness cap), level-identity tracker (10pt match tolerance), per-identity random placebo offsets (seeded, reproducible). |
| `A2-01-feed-characterization.py` | Feed stats + GEX↔LT agreement + `vol_daily.csv` (incl. trailing RTH 30m vol scale). |
| `A2-02-touch-census.py` | Touch state machine → `episodes.csv` (466,699 rows). |
| `A2-03-aggregate.py` | Census + conditioning + stability tables (`out-A2-03.txt`). |
| `A2-04-path-shaping.py` | Session extremes, attraction-from-afar, time-near (`out-A2-04.txt`). |
| `A2-05-candidate-checks.py` | Artifact controls + per-year deltas + grid triangulation for the two candidate effects (`out-A2-05.txt`). |

**Knowability:** bar OHLC consumed only at bar close (ts+60s); GEX snapshots / LT rows usable only at-or-after their own stamps (as-of joins, never nearest/future); forward outcomes measured strictly after the touch bar close; 36 rollover days (multi-symbol) excluded; episodes never span symbol changes or >5min bar gaps.

**Touch definition:** level must first be *armed* by a bar trading ≥25pts away; first bar whose range comes within X∈{2,5,10}pts fires a touch; approach direction = side of price while armed. **Race metric:** first of ±10pts beyond level ("break") vs 10pts back on approach side ("bounce"), walked bar-by-bar 30m/60m. **Normalization:** ÷ `vol30` = trailing-20-RTH-day median |30m close move| (handles NQ's 3x price drift; median ~20pts 2021–24, ~40pts 2025–26).

**Placebos (identical machinery):** (a) `grid50`/`grid100` — round-number grids near price; (b) `*_rand0..2` — every real level identity shifted by a fixed random ±30–120pts (3 seeded draws), drifting in sync with its real twin.

---

## 1. Feed characterization (out-A2-01.txt)

**GEX** (`data/gex/nq/`, 804 days 2023-03-29→2026-06-15): 60 snapshots/day at 15min spacing (~04:15–20:00 ET), 11 levels each (5 support + 5 resistance + gamma flip). Levels sit FAR from spot: median 432pts, p25 187pts — only the near tail is ever touched. Snapshot-to-snapshot persistence: 50.7% within 1pt, 91.2% within 5pt. Within-day 5pt-identity lifetime: median 0.8h, p90 8.2h.

**LT** (`NQ_liquidity_levels.csv`, 128,292 rows 2021-01-27→2026-07-14; timestamps verified UTC): strict 15-min cadence, always exactly 5 levels, near spot (median 71pts, p25 30pts). Values drift constantly: the set changes every row at 0.1pt tolerance; 5pt-identity lifetime median ~15min, p90 1.2h. This drift matters — see the artifact control in §4.

**GEX↔LT agreement is LOW:** an LT level is within 10pts of a GEX level 10.1% of the time (25pts: 24.0%); a GEX level is within 10pts of an LT level 4.3% (n≈483k/228k level-stamps). The feeds are essentially independent level sources.

---

## 2. Touch census — real vs placebo (out-A2-03.txt)

Bounce share = bounce/(bounce+break) of resolved 30m races. Absolute levels of this number are machinery geometry (touching within X leaves price closer to the reject threshold than the break threshold — hence ~60%→~88% as X widens **for every class including placebos**). The measurement is the real-minus-placebo delta.

### GEX family (2023-03→2026-06)

| X | class | n | resolved | bounce% | medFwd30 (v) | medRej30 (v) | medBey30 (v) |
|---|---|---|---|---|---|---|---|
| 5 | gex_real | 4,633 | 4,297 | **72.6 ±0.7** | +0.03 | 1.36 | 0.97 |
| 5 | gex_rand | 15,086 | 13,940 | 72.0 ±0.4 | −0.04 | 1.37 | 0.91 |
| 5 | grid50 | 24,450 | 22,224 | 71.4 ±0.3 | 0.00 | 1.26 | 0.90 |
| 5 | grid100 | 12,207 | 11,101 | 70.7 ±0.4 | 0.00 | 1.26 | 0.90 |

X=2: real 60.7±0.8 vs rand 60.0±0.4; X=10: real 87.9±0.5 vs rand 87.9±0.3. **Bounce-share deltas ≤0.7pt ≈ 1 SE at every X. Null.**

### LT family (2021-01→2026-06)

| X | class | n | resolved | bounce% | medRej30 (v) | medBey30 (v) |
|---|---|---|---|---|---|---|
| 5 | lt_real | 22,049 | 20,551 | 72.4 ±0.3 | 1.09 | **0.66** |
| 5 | lt_rand | 51,523 | 47,952 | 72.1 ±0.2 | 1.15 | 0.75 |
| 5 | grid50 | 37,363 | 34,418 | 71.3 ±0.2 | 1.21 | 0.87 |
| 5 | grid100 | 18,709 | 17,239 | 70.9 ±0.3 | 1.21 | 0.88 |

X=10 bounce: real 89.4±0.2 vs rand 88.7±0.1 (+0.7, ~3 SE — small but the only bounce delta above noise; consistent with the penetration damping below rather than a separate effect). **The real signal is in the excursion columns: both rej30 and bey30 smaller at real LT levels** — dissected in §4.

---

## 3. Conditioning (X=5, real vs pooled rand — out-A2-03.txt)

Every strong conditioner turned out to be a property of *price*, not of *levels* — it appears identically in the placebo:

- **Approach speed** (15m move toward level / vol30): fast approaches bounce far less (real 67–68%, slow 77–80%) — **identical gradient in rand** (66.5→79.5). Generic momentum/mean-reversion, not a level effect.
- **Session:** RTH-open touches have ~2x the excursions and lowest bounce share — same in placebo. Generic vol-of-day.
- **Level age:** <30m-old levels see lower bounce + bigger excursions — same in placebo (young levels appear in volatile moments). Not a level effect.
- **First-touch vs re-touch:** GEX real Δ = +1.6pt (73.1 vs 71.5) but rand shows +2.7pt (73.3 vs 70.6) — placebo "first-touch effect" is *bigger* than the real one. LT: no difference at all. **First-touch specialness: null.**
- **GEX↔LT confluence:** GEX touches with an LT level within 10pts: bounce 73.9±1.6 vs solo 71.8±0.9 (~1 SE). LT touches with GEX within 10pts: 70.9±1.6 vs solo 72.5±0.5 (wrong sign). **Confluence adds nothing.** (n=812/907 confluent touches.)
- **Crowding (distance to nearest same-feed level):** no differential vs placebo.
- **Direction:** support tests drift back up, resistance tests drift on up — in real *and* rand (the sample's upward drift). Generic.

---

## 4. The two candidates, artifact-controlled (out-A2-05.txt)

### 4a. LT follow-through damping — SURVIVES

Raw finding: 30m excursions after LT touches smaller both sides vs rand (rej 1.09v vs 1.15v; bey 0.66v vs 0.75v).

**Artifact risk:** LT levels drift every 15min; a level can drift ONTO quiet price, firing a "touch" with no price impulse (its placebo twin 30–120pts away does not fire) → damped-looking outcomes for real only. **Control:** restrict to price-driven touches (`appr15 ≥ 20pts`, price itself covered the arm distance).

Result under the control (X=5, vol-normalized medians):

- **Reject side collapses to zero** (Δreal−rand = −0.003 pooled; sign flips year to year) → the "stronger rejection" component **was** the drift artifact.
- **Beyond side survives:** real 0.849v vs rand 0.905v vs grid50 1.007v (n = 11,412 / 29,492 / 23,264).
  - vs rand: **negative all 6 years** (−0.023, −0.020, −0.060, −0.118, −0.080, −0.040 for 2021→2026)
  - vs grid50: **negative all 6 years** (−0.160, −0.051, −0.133, −0.217, −0.218, −0.194)
  - holds at every touch threshold: X=2 real 0.974 / rand 1.030 / grid 1.127; X=5 0.849/0.905/1.007; X=10 0.672/0.716/0.822.

**Plain English:** after price drives into a real LT level, the next 30m of penetration *beyond* the level is ~0.04–0.06 vol-units (≈1–2.5pts vs rand, ≈3–6pts vs round numbers) shallower than at placebo levels, every year, at every touch width. Rejection depth is unchanged — LT levels don't bounce price harder; they slightly blunt follow-through.

### 4b. GEX permeability — FAILS stability

Raw finding: fwd30 (drift in approach direction) more positive at real GEX levels than rand (Δ +0.076v pooled, +0.109v price-driven; positive vs rand all 4 years), i.e. GEX levels look *more* permeable than random points — the opposite of dealer-wall folklore.

Grid triangulation kills it: rand carries a mechanical negative-fwd bias (rand fwdn −0.05v vs grid ~0.00), so vs grid50 the delta shrinks to +0.061v pooled **and inverts in 2025** (2023 +0.137, 2024 +0.109, 2025 −0.060, 2026 +0.044). Beyond-penetration delta is positive 4/4 vs both placebos but is dominated by one year (2025 +0.19; other years +0.01–0.05). Per charter rule 6 (sign inversion across years = noise) and the requirement to beat *both* placebo families: **not established. Do not build on it.** The safe conclusion is the negative one: **GEX levels are certainly not walls at 1m resolution.**

---

## 5. Path shaping beyond touches (out-A2-04.txt; 1,336 RTH days)

- **Session-extreme termination — NULL.** P(RTH high/low within 10pts of a level knowable at 09:30): GEX real 13.7%/13.5% vs rand 13.0%/13.9%. LT real 14.6%/17.3% vs rand 16.6%/16.6% — the real LT *high* number is below its own placebo. At 25pts LT real is again below placebo (31.4/35.9 vs 35.1/35.3). Per-year deltas flip sign repeatedly. Days do not preferentially top/bottom at these levels. (grid50 37% is pure geometry: any point is within 10pts of a 50-grid with p≈0.4.)
- **Attraction from afar — NULL.** P(price reaches within 10pts of a frozen level within 60m | starts 25–75pts away): GEX real 42.9±0.3 vs rand 44.4±0.2 (mild *avoidance*, −1.5pt) but the delta inverts in 2026 (+1.2). LT real 44.8 vs rand 44.4: per-year +1.8, −0.1, +1.3, +1.4, −0.3, −4.0 — inverts. Neither attractor nor repellent survives stability.
- **Time-near (context only, count-matched per draw):** GEX real 18.3% of RTH minutes within 10pts vs rand ~21.5% (consistent with mild avoidance, but see above — not year-stable). LT real 35.4% vs rand ~30.7% — expected mechanically (LT levels are spawned/updated near price structure); NOT evidence of attraction.

---

## 6. RANKED shortlist — what beat placebo

1. **LT follow-through damping (beyond-level penetration).** Effect: −0.04..−0.06 vol-units (~1–2.5pts) vs random-offset placebo, −0.16 vol-units (~3–6pts) vs round numbers, in 30m post-touch penetration depth. n = 11,412 price-driven real touches (21,696 unfiltered). Stability: sign-stable 6/6 years vs BOTH placebos, robust at X=2/5/10. Verdict: **real but small.** Not a directional edge (bounce/break odds unchanged); it says breaks *through* LT levels travel slightly less far. Proposed follow-up: (i) 1s re-verification of penetration depth from the touch instant; (ii) test as an *exit/target-shading* input (e.g., don't hold continuation trades through an LT level; fade-targets just short of the far side), not as an entry signal; (iii) check whether damping concentrates in RTH vs overnight before any use.

That is the entire list. Nothing else beat both placebos with stable sign.

**Borderline, recorded for honesty, classified dead:** GEX permeability (§4b) — sign-stable vs rand only, inverts vs grid in 2025; LT X=10 bounce +0.7pt (likely the same damping effect seen through the race metric).

## 7. What showed NOTHING (explicit nulls)

1. **Bounce/break odds at GEX levels** — identical to placebo at every touch width (Δ ≤0.7pt ≈1 SE).
2. **Bounce/break odds at LT levels** — identical to placebo at X=2/5 (X=10 +0.7pt, see above).
3. **GEX+LT confluence** — no improvement either direction (n≈800–900 confluent touches per feed).
4. **First-touch-of-day specialness** — placebo shows the same or bigger "effect".
5. **Session-extreme termination at pre-known levels** — both feeds ≈ or below placebo.
6. **Levels as attractors or repellents** — deltas exist but invert across years (both feeds).
7. **Level age, crowding, approach-speed, session, direction as *level-specific* conditioners** — all gradients replicate in placebo (they condition price, not levels).
8. **Round numbers as support/resistance** — grid50/grid100 bounce shares sit slightly *below* the drifting placebos; no folklore effect.
9. **The "levels bounce ~60–88% of the time" observation itself** — true of ANY price you pick, including random ones; it is 1m mean-reversion geometry, not level power.

## 8. Caveats

- 1m OHLC census; intrabar sequencing unknown. Any tradability claim requires the 1s pipeline (charter rule 2). Effect sizes here are medians of post-touch paths, not P&L.
- Cache prices carry %g 6-sig-digit formatting (≤0.05pt rounding) — immaterial at the 1–6pt effect scale.
- Level identity = 10pt match tolerance; arm distance fixed at 25pts; race threshold fixed at ±10pts. Placebos share every one of these choices, so comparisons are internally consistent, but absolute rates are parameter-dependent.
- The random-offset placebo itself shows a small negative fwd-drift bias vs grid (§4b) — deltas vs rand alone should be discounted; that is why both placebo families are required.
- LT feed has a known gap structure (1,409 gaps >1h = weekends/outages); staleness cap 45min drops levels across gaps. GEX 2023-03 start limits that family to 3.2 years.
