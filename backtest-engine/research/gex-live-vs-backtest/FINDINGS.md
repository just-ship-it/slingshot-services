# Live (Schwab) vs Backtest (Databento/OPRA) GEX Levels — Definitive Reconciliation

**Question:** GLX trades against GEX levels. Live computes them from the Schwab options
chain; the backtest (`data/gex/nq-cbbo`, GLX's gold-standard reference) computes them from
Databento OPRA. Where and why do the two disagree? Is that the source of live-vs-backtest
signal divergence?

**Method (no re-implementation guesses — real endpoints):**
- **Endpoint A (live):** the *real* `signal-generator/src/tradier/exposure-calculator.js`
  run on the archived Schwab snapshots (`data/schwab-snapshots/<day>/`) with the correct
  `asOf` timestamp and the same QQQ spot as B.
- **Endpoint B (backtest):** the *committed* `data/gex/nq-cbbo/nq_gex_<day>.json` (the actual
  data GLX's gold standard was validated on), converted QQQ↔NQ by its own multiplier.
- A parametrized GEX engine (`engine.mjs`) faithful to both source calcs, validated against
  each endpoint, used for one-factor-at-a-time ablation.
- OPRA quotes parsed from `data/cbbo-1m/qqq` faithfully to `generate-cbbo-gex.js` loadCBBO
  (15m buckets, last-quote-wins, bid>0/ask>0/spread≤50%). OPRA OI from `stat_type=9`.

Overlap days with Schwab snapshots: 2026-03-12..19, 04-27..30, 05-01, 05-04..08.

---

## Headline

**On days representative of current live (full option-chain capture), the live and backtest
GEX levels AGREE.** Call wall, put wall, and gamma flip match to ~0; the support ladder is
the same set of strikes. The only residual is **positional re-ordering within a tight
near-spot cluster of near-equal-GEX support strikes** — which matters only because GLX
indexes the ladder *by position* (`S4 = support[3]`).

The large divergences claimed earlier (481pt / 134pt / 33–57pt) were **artifacts**, not real.

---

## What was RULED OUT (with evidence)

| Candidate | Verdict | Evidence |
|---|---|---|
| Open interest (Schwab vs OPRA) | **Identical** | calls 5018/5019, puts 5019/5019 match exactly on 05-08; OCC-cleared. |
| GEX math (IV / gamma / GEX formula) | **Identical** | Same Brenner-Subrahmanyam IV, same BS gamma, same `sign·γ·OI·100·S²·0.01`. |
| S/R **selection method** (GEX vs OI-weighted) | **NOT a divergence — both GEX-based** | See "Source/data mismatch" below. This was the leading theory; it is wrong. |
| Quote source (Schwab mid vs OPRA cbbo mid) | **~0 effect** | Same universe, swap only the mid → median S4 diff = 0, walls = 0 (all 6 full-capture days). |
| Volume gate (live drops `volume==0`) | **~0 effect** | Gate drops only 1–2% of OPRA-quoted contracts; median S4/wall diff = 0 (all 6 days). |
| 0DTE handling | **Not a wall driver** | Live floors 0DTE TTE at 0.001yr (~8.8h) — *smaller* 0DTE gamma than backtest's 2.5h floor, opposite of the "0DTE explodes near-spot walls" story. |
| Call wall / put wall / gamma flip | **Agree ~0** | On full-capture days, median diff ≈ 0 QQQ pts every snapshot (see table). |

## What the residual IS

- **Support-ladder positional ordering.** Same ~4–5 of 5 strikes, but which strike lands in
  slot S1..S5 differs. Median S4 diff (live vs nq-cbbo, full-capture days): 7 / 15 / 20 / 30 /
  39 / 48 QQQ pts across 05-08/04-30/04-29/05-05/05-07/05-06.
- **Driver = feed-native coverage jitter**, not quotes or the volume gate. The near-spot
  support strikes carry near-equal GEX; tiny per-strike GEX differences (from which exact
  strikes each *feed* quotes) flip their rank order within the cluster.
- **Why it matters for GLX:** `gex-lt-3m-crossover.js:233-235` builds `S${i+1}` by array
  position, so `L_S4` keys off `support[3]`. Re-ordering makes S4 a different strike →
  different S4×LT crossover. GLX's per-`(rule, ltIdx)` blocked-cell filters are tuned to the
  backtest's ordering, so ordering drift silently mis-targets them. **GLX's positional
  support indexing is not robust to feed-ordering differences.**

## Full-capture-day comparison (real live calc vs committed nq-cbbo, QQQ pts)

| Day | callWallΔ | putWallΔ | flipΔ | supOverlap/5 | S4Δ |
|---|---|---|---|---|---|
| 04-29 | ~0 | ~0 | 1 | 4 | 20 |
| 04-30 | ~0 | ~0 | ~0 | 5 | 15 |
| 05-05 | ~0 | ~0 | ~0 | 5 | 30 |
| 05-06 | ~0 | ~0 | ~0 | 4 | 48 |
| 05-07 | ~0 | 1 | ~0 | 4 | 39 |
| 05-08 | ~0 | ~0 | (null) | 4 | 7 |

## The capture-truncation artifact (explains the "big" historical divergences)

Divergence magnitude correlates 1:1 with how much of the option chain the *old* Schwab
snapshots captured — NOT with anything methodological:

| Day(s) | Expirations captured | maxDTE | Wall divergence |
|---|---|---|---|
| 03-12/16/19 | 3 | 8–32d | 15–28pt |
| 04-27/28 | 15 | ~39d | 33–57pt |
| 04-29/30, 05-05..08 | 32–33 | ~625d | ~0 |

Old snapshots were missing LEAP expirations the backtest includes, shifting walls. Current
live captures full DTE (~625d+), so this artifact does not apply to current live.

---

## LANDMINE: source code and committed data are OUT OF SYNC

- The committed `scripts/generate-cbbo-gex.js` selects walls by **highest OI** and S/R by
  **OI-weighted** `putOI + |gex|/1e6` (lines ~347–368).
- But the committed `data/gex/nq-cbbo/*.json` (GLX's gold-standard reference) is **GEX-based
  near-spot**: my engine reproduces its walls **26/27 (call), 16/27 (put)** with GEX-based
  selection vs **1/27, 0/27** with OI-weighted.
- Git: commit `26362e9` ("Fixing a bug in the gex calculator. will capture snapshots next
  week") introduced the OI-weighted code; `nq-cbbo` was generated 2026-06-16 by the *earlier*
  GEX-based version and **never regenerated**.

**Consequence:** if anyone regenerates `nq-cbbo` with the current source and re-runs GLX,
they will get DEEP OI-weighted levels that GLX was never validated on → the v3 gold standard
($218k) would break. Before any regeneration, revert `generate-cbbo-gex.js` wall/S-R
selection to **GEX-based** (which matches both live and the committed data).

---

## Bottom line & the honest caveat

- The GEX **levels agree** between live and backtest on representative days. The premise that
  "differing levels are the sole source of the backtest-vs-live discrepancy" is **not
  supported by the overlap-day data** — walls/flip are identical and support is the same set.
- The one real level-space effect is **support-ladder positional re-ordering**, which GLX is
  uniquely sensitive to because it indexes `support[3]` by position. This is a plausible
  contributor but is a small, cluster-internal jitter — unlikely on its own to zero out ALL
  GLX longs for a whole month.
- **June cannot be tested directly** — there are no June Schwab snapshots. Given levels agree
  on Mar–May, the June "149 short / 0 long" is more likely **June-specific**: the documented
  GEX-feed outage (June 9–10, all three GEX strategies dark) and/or stale/degraded live GEX
  feed, and/or the crossover-state / LT-level path — not a standing level-computation
  divergence. Closing June requires archiving June Schwab snapshots (or a Databento June pull)
  and replaying GLX's crossover state live-vs-backtest.

## Recommended next actions
1. **Make GLX robust to ordering:** have `L_S3/4/5` match support by *proximity/role* (nearest
   support below price), not array position; or sort the ladder deterministically (by price)
   in both live and backtest before indexing.
2. **Fix the source/data desync:** revert `generate-cbbo-gex.js` to GEX-based selection so the
   source matches both the committed data and live; add a regression test that the generator
   reproduces committed `nq-cbbo` within tolerance.
3. **Archive live GEX + LT daily** (`gex:by-day`, `lt:by-day`) so June-style questions are
   answerable without a data pull.
4. Treat the June 0-longs as a **feed-availability** question first (fail-open vs fail-silent
   when GEX is stale), per the June 9–10 outage.

## Scripts (this directory)
- `engine.mjs` — parametrized GEX engine (faithful to both calcs).
- `run-live-calc.mjs` — drive the real ExposureCalculator on a Schwab snapshot.
- `compare-day.mjs` — real-live vs committed-nq-cbbo per snapshot.
- `extract-opra-cbbo.mjs` — faithful OPRA cbbo → per-strike quotes cache.
- `validate-bt.mjs` / `validate-bt-gex.mjs` — engine@BT reproduction check (OI vs GEX selection).
- `ablate-quotes.mjs` — isolate quote source (same universe).
- `ablate-universe.mjs` — isolate volume gate.
