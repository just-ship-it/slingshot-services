# JV-ICT Dev-Period Results, Round 3 — Placebo Kill Test + SMT (2026-07-23)

Extends 04/05. Same dev window (**2021-01-18 → 2024-12-31**, 2025+ still locked/untouched), same
honest flags on every run: `--ticker NQ --timeframe 15m --eod-cutoff-et 15:45 --slippage 0.25
--stop-slippage 0.5 --strict-fill` (1s execution, continuous data), 1 contract, $ = NQ $20/pt.

Round-3 question: **is the surviving W-model long edge structure-specific (sweep→MSS mechanism),
or just NQ upward drift + selection?**

## 1. Placebo test (the kill test)

### Design

Engine-honest placebo: `placeboMode` implemented inside `shared/strategies/jv-ict.js` itself, so
placebo trades run through the exact same engine path (1s fills, strict-fill, same slippage, same
EOD cutoff, same pending-order lifecycle) as real trades. No hand-rolled fill sim.

- **Geometry harvest**: each real arm was run once in `--capture-signals` mode (captures ALL
  emitted signals, not just fills). Per signal we recorded `{m: ET minute-of-day at emission,
  off: mss_close − entry (limit offset below current price), stop: entry − stop_loss,
  tp: take_profit − entry}` → catalog files.
- **Placebo replay**: each catalog entry is assigned a uniformly random weekday in the dev window
  by a seeded `mulberry32` PRNG (fully reproducible per seed) and fires at the first 15m close
  at/after its original ET minute-of-day on that day — i.e. **identical time-of-day, limit-offset,
  stop-distance, TP-distance and TTL marginals; only the DAY (and hence any relation to sweep/MSS
  structure) is randomized.** Session gate identical (09:30–15:30 ET emission). Pre-fill cancel
  rules identical: synthesized `extreme`/`legTerminus` are the algebraic inverse of the real
  construction (`extreme = stop + buffer`, `legTerminus = TP + tick`), so
  `close_beyond_sweep_extreme` / `close_beyond_leg_terminus` / TTL / session-end cancels all run.
  Entries assigned to holidays never fire (~4% loss, uniform across seeds).
- **Arms** (both `sides=long`, 15m, dev window):
  - **Arm A** = `confluenceMode=imb` (the program's surviving row). 97 emitted signals harvested.
  - **Arm B** = default config (broader sample so the verdict doesn't hang on ~30 trades).
    211 emitted signals harvested.
- **20 seeds per arm** (40 engine runs), seeds 1–20.

Sanity: placebo fill dynamics match the real arms — arm A real fill rate 27/97 (28%) vs placebo
mean 33.4/97 (34%); arm B real 78/211 (37%) vs placebo mean 78.0/211 (37%). Exit mixes comparable
(real A: 13 TP / 10 SL / 4 EOD; placebo A pooled: 36% TP / 57% SL / 7% EOD — placebo skews
slightly more SL, i.e. real entries are *better located*, which is exactly what the test measures).

### Results

Real arms (fresh normal runs this round):

| arm | config | n | WR | PF | mean pts/tr | per-year PF (n) |
|---|---|---|---|---|---|---|
| A real | long + imb | 27 | .630 | **2.21** | +14.8 | 3.38 (9) / 4.04 (4) / 2.01 (10) / **0.78 (4)** |
| B real | long default | 78 | .474 | **1.19** | +3.5 | 1.20 (20) / 1.84 (15) / 1.33 (28) / **0.57 (15)** |

Placebo distributions (20 seeds each):

| | Arm A placebo | Arm B placebo |
|---|---|---|
| n per seed | 27–42 (mean 33.4) | 63–88 (mean 78.0) |
| PF min / q25 / med / q75 / q90 / max | 0.45 / 0.71 / 0.85 / 0.97 / 1.30 / 2.28 | 0.65 / 0.90 / 0.99 / 1.10 / 1.37 / 1.86 |
| mean pts/tr med / q90 / max | −2.6 / +5.0 / +15.0 | +0.1 / +6.2 / +11.2 |
| WR med / max | .406 / .600 | .425 / .558 |
| pooled (all seeds) | 667 tr, PF 0.91, −1.4 pts/tr | 1,559 tr, PF 1.03, +0.8 pts/tr |
| pooled per-year PF | 0.71 / 0.94 / 0.80 / **1.12** | 1.02 / 1.10 / 1.13 / **0.89** |
| **REAL percentile** | **PF 95th, pts 95th, WR 100th** | **PF 80th, pts 80th, WR 85th** |
| seeds ≥ real PF | 1/20 (seed 14: 2.28) | 4/20 (1.37, 1.61, 1.86, 1.37) |

### Placebo verdict

- **Arm B (broad long arm, n=78): PLACEBO-EQUIVALENT.** 80th percentile on both PF and
  mean-points — below the pre-registered 90th-pct bar. The bulk of jv-ict's long-side
  profitability is indistinguishable from time-and-geometry-matched random long limit entries,
  i.e. NQ drift.
- **Arm A (imb-gated, n=27): nominally clears the bar** (95th pct; 1 of 20 seeds beat it;
  seed-rank p ≈ 2/21 ≈ 0.10). Honest caveats that neutralize this pass:
  1. Arm A is the **maximum of ~12 correlated dev configs** from round 1 — picking the best row
     and then finding it at the 95th pct of a null distribution is roughly what selection alone
     produces. The pre-registered bar was applied to a post-hoc-selected arm.
  2. Its outperformance vs placebo is **entirely 2021–2023**. In 2024 the relationship INVERTS:
     real 0.78 vs pooled-placebo 1.12 — in the one year where placebo longs finally make money
     (drift year), the "structure" entries LOSE to random. A real mechanism should not
     underperform its own placebo in the most recent year.
  3. n=27 (~7/yr), below any deployable bar, and the arm already fails the program's alive
     criterion (2024 ≥ ~0.8) regardless of the placebo result.

Per protocol (arm A > 90th pct), Task 2 was run rather than skipped.

## 2. ES/SMT pairs confirmation (spec §7, book p33 #7)

### Implementation

`smtMode: 'off'|'require'|'avoid'` in `jv-ict.js`. The engine has no cross-symbol data path for
backtests (`es-cross-signal.js`'s `getDataRequirements().quoteSymbols` is live data-service
wiring only), so per this repo's aux-file precedent (`--ls-1m-file`) the strategy loads a
prepared ES 15m series (`smtEsFile`). Preparation: `ES_ohlcv_1m_continuous.csv` deduped by
timestamp (0 duplicates found in the continuous file — the known duplicate-bar defect is in the
raw file) and aggregated to UTC-aligned 15m (117,930 bars; series starts **2021-01-26**, so the
first 8 days of dev are `smt_nodata`). ES structure is mirrored with the SAME discipline as the
run symbol (pivotN=2 confirm-lagged fractals, levels-as-of-prior-close, close-confirmed
broken-marking); only ES bars fully closed at the current NQ 15m close are consumed. SMT is
evaluated on the ES bar with the same period-start as each NQ sweep-push bar and re-evaluated on
new extreme pushes (the final push before MSS gates). `require` = SMT divergence (NQ swept its
level, ES did NOT sweep its own — classic SMT reversal signal); `avoid` = agreement (both swept —
book p33 "pairs move together confirms").

**Verification**: independent Python re-derivation of ES pivots/breaks/sweep-status from the
prepared CSV reproduced the engine's `smt_status` on 5/5 smoke-run signals (2024-03/04).

### Results (dev, conf=imb, 15m)

| run | sig | n | WR | PF | net $ | per-year PF (n) — 2024 bold |
|---|---|---|---|---|---|---|
| both + require | 116 | 35 | .514 | 1.50 | +5,415 | 1.41 (10) / 11.12 (7) / 0.33 (9) / **0.62 (9)** |
| long + require | 63 | 19 | .632 | 1.87 | +4,150 | 5.62 (7) / 4.04 (4) / 0.43 (5) / **1.46 (3)** |
| short + require | 53 | 17 | .412 | 1.21 | +1,290 | 0.00 (3) / inf (3) / 0.19 (4) / **0.35 (7)** |
| both + avoid | 63 | 16 | .438 | 1.35 | +2,050 | 1.37 (3) / 2.32 (2) / 5.25 (6) / **0.00 (5)** |
| long + avoid | 33 | 8 | .625 | 3.18 | +3,700 | 0.92 (2) / — / 10.84 (5) / **0.00 (1)** |
| short + avoid | 30 | 8 | .250 | 0.61 | −1,650 | inf (1) / 2.32 (2) / 0.00 (1) / **0.00 (4)** |

### SMT verdict

- **The acid test fails everywhere it can be read.** both+require 2024 = 0.62; short+require
  (the one gate that might rescue shorts) = 0.35 in 2024 and 0.19 in 2023 — shorts are NOT
  rescued; aggregate PF 1.21 is carried by a 3-trade `inf` 2022.
- long+require's 2024 = 1.46 is **three trades**; its 2023 is 0.43 (losing). No 3/4-positive-year
  config exists in the table.
- `require` kills 2023 while `avoid` kills 2024 (long+avoid PF 3.18 is five 2023 trades) —
  **adjacent slices sign-flip by year**, the same regime-resonance signature as the round-2
  timeframe inversion. SMT divergence adds an independent information source and it still
  produces no stable structure.

## 3. Final verdict

**Is there ANY structure-specific mechanical edge in this mechanization? No.**

- The broad long arm is statistically indistinguishable from random time/geometry-matched long
  limit entries (80th pct). Every "long edge" row in rounds 1–2 that this arm feeds is therefore
  explained by NQ drift + engine fill mechanics, not by sweep/MSS structure.
- The one cell that nominally beats its placebo (imb longs, 95th pct, p≈0.10) is the selected
  maximum of the round-1 sweep, is 27 trades over 4 years, earns its entire separation in
  2021–2023, and **underperforms its own placebo in 2024** — the wrong direction for a live
  mechanism and an automatic fail of the pre-registered alive bar (≥3/4 positive years incl.
  2024, PF ≥ 1.3). It does not earn a locked-set (2025+) run, and none was performed.
- SMT/pairs confirmation — the last untested book ingredient with independent information —
  does not repair 2024, does not rescue shorts, and its two polarities kill different years.

**What would change the answer:** (a) a mechanically-specified setup-selection rule that
reproduces the source trader's discretionary "obvious pool" picking and passes THIS round's
placebo protocol at >90th pct with 2024 ≥ 1.0 on ≥30 trades — no such rule emerged in three
rounds of book-faithful gates (confluence, bias, HTF structure, session, depth, TF, SMT);
(b) verifiable evidence that the source results exist at all (live tape, broker records) —
absent that, the null (screenshots + survivorship) stands.

**Recommendation: CLOSE the jv-ict program.** Mechanization is complete and audited clean
(rounds 1–2 re-derivation audits, this round's placebo + SMT verification); the missing
ingredient is discretion/unverifiable. jv-ict joins the dead-family list — do not re-sweep axes.
The 2025+ locked window was never touched and remains clean if a genuinely new,
placebo-passing variant ever appears.

## Artifacts

- Code: `shared/strategies/jv-ict.js` — `placeboMode` (+ `placeboSeed`/`placeboCatalogFile`/
  `placeboStart`/`placeboEnd`) and `smtMode` (+ `smtEsFile`), both default-off, research-only.
- Scratchpad (`/tmp/claude-1000/-home-drew-projects-slingshot-services/e3ac9791-.../scratchpad/`):
  `r3-cap-arm{A,B}.json` (signal harvests), `r3-catalog-arm{A,B}.json` (geometry catalogs),
  `r3-real-arm{A,B}.json`, `r3-placebo-{A,B}-s{1..20}.json` (40 placebo runs),
  `r3-placebo-pair.sh`, `r3-es-15m.csv` (deduped ES 15m), `r3-smt-*.json/.log` (6 SMT runs),
  `r3-smt-smoke*` (SMT smoke + 5/5 independent verification).
