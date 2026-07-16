# VP-Defended-Wick + Flip-Analog — new-alpha probe (2026-07-15)

**Question:** find a NEW strategy (outside the existing LS/LT/GEX/IV families) with
LSTB-class profitability, using only data already on disk.
**Benchmark:** LSTB plain v3 no-BE full-window gold — 13,049tr / $480,820 / PF 1.31 /
WR 53.9% / Sharpe 8.79, 12/12 quarters positive (2023-07→2026-06).

Two pre-registered hypotheses tested end-to-end, 1s-honest, house costs, raw contracts,
primary contract per day, up to the full 2021-01→2026-06 window (5.4y).

---

## Part 1 — Volume-profile levels × wick-absorption defense: DEAD (both halves)

**Hypothesis:** prior-day volume-at-price levels (POC/VAH/VAL — the one level family
never tested here; flagged as a data gap in FINDINGS.md) fade better than known-dead
families, especially when the touch shows 1s absorption defense (the un-productized
regime-flow finding: absorption ≥40/pt → 64% reject at LT/GEX levels).

**Method:** `01-build-daily-profiles.py` (uniform-spread 1m volume-at-price from the
pilotfish minute library, 1,395 days, roll days skipped) → `02-event-study.py`
(117,456 wick-touch events 2021→2026; four arms: vp / prior-RTH-H-L / round-100 /
+37.5pt-offset placebo; approach ≥2pt, cooldown 300s; first-passage outcomes for a
T×S grid measured from the touched level) → `03-analyze.py`.

### 1a. Level identity is worthless — VP joins the dead-family list (#5)

Expectancy at T10/S9 (entry-at-level convention): vp POC −0.28pt, vp VAH/VAL −0.36 to
−0.56, prior RTH H/L −0.40 to −0.59, round-100 −0.71, **offset placebo −0.25 to −0.53**.
VP ≈ placebo in every year and both train/test halves. Consistent with the pilotfish
Phase-7 closure of naked level families; volume-derived levels add nothing.

### 1b. Absorption is a huge conditioner — but strictly non-causal

abs10 = vol/(max_pen+0.25) over [touch, touch+10s]. Global deciles at T10/S9 perfectly
monotonic: D0 −2.68pt → D9 **+3.63pt**. Top-quartile (causal per-year cuts): positive
EVERY year (+1.7…+3.7pt, WR 59-70%), all hours, both directions, **identical across all
arms including placebo** — the level is irrelevant; the defended stall is the signal.

**Honest capture attempts (`04-honest-sim.py`, causal rolling thresholds, single slot,
2025H1):** confirm-then-market-entry at touch+10s → PF **0.65**; confirm-then-resting-
limit-at-level for the retest → PF **0.77**; arming the NEXT touch of a proven-defended
level (persistence corr 0.38) → still ≤0 expectancy every year.

The +2.4pt sits entirely at the touched price during the confirm window; mean MFE at
60s is already 10.2pt from the level. **The edge is rent paid to liquidity resting at
the level BEFORE the touch — structurally not capturable by a causal entry at 1s
granularity.** This also explains mechanistically why naked level-fade families keep
dying while wick-absorption event studies always look great.

---

## Part 2 — Flip-analog: is LSTB's edge the LS signal, or the architecture?

**Hypothesis:** LSTB = 1m state-flip → fib-0.5 pullback limit → 15/12 fixed exits →
blocked hours → EOD 15:45. If public price-only flip detectors reproduce its economics
through the same pipeline, the TradingView LS dependency (two past stamp-lookahead
incidents) can be retired.

**Method (final, authoritative):** generated engine-compatible flip CSVs for three
public detectors (`06-make-flip-files.py`: Supertrend(10,3), EMA 9×21 cross,
sign(close−close[15]); defaults only, no sweep; computed on the pilotfish minute
library, reset at rolls, stamped at bar open exactly like the LS dumper) and ran the
REAL production engine (`--strategy ls-flip-trigger-bar --ls-1m-file <flips.csv>`,
explicit v3-no-BE flags). **Calibration first:** the same command on the real LS file
reproduces the gold EXACTLY (13,049tr / $480,820 / PF 1.31 / WR 53.9%) — so the only
difference between rows below is the signal.

| flip signal (same engine, same window 2023-07→2026-06) | n | WR | PF | PnL |
|---|---|---|---|---|
| **LS 1m (proprietary, calibration)** | 13,049 | **53.9%** | **1.31** | **+$480,820** |
| Supertrend(10,3) | 9,907 | 43.6% | 0.85 | **−$220,225** |
| EMA 9×21 cross | 14,803 | 46.4% | 0.95 | **−$100,303** |
| drift15 sign flip (harness*) | 51,954 (2021-26) | 39.5% | 0.70 | −$2.54M |

*Python harness `05-flip-analog.py` validated against the engine on Supertrend
(PF 0.82 vs 0.83, n within 1%); its LS row admits ~8k extra trades the engine rejects
via candle/stamp alignment, so ENGINE numbers are authoritative for LS. Per-year: every
public detector is negative in EVERY year 2021→2026 with a clean quality gradient
(slower detector → less bad, none near water).

### Inversion appendix (2026-07-15, Drew's question)

Inverting the losing detectors does NOT work — it's much worse, not better
(harness, full window, `--invert`): st 0.85→**0.46** (−$2.50M), ema 0.78→**0.46**
(−$3.63M), drift 0.70→**0.37** (−$8.68M), and even LS inverted = **0.32** (−$3.99M
where straight LS makes +$481k). Two reasons: (1) ~60-70% of the originals' losses
are round-trip costs (commission + stop slip), which the inverse pays again in its
own direction; (2) inverting the signal also mirrors the fib-pullback entry onto the
momentum side — the limit now fills by price running THROUGH it (chased fills, n
explodes ~35%, pre-fill invalidation stops protecting), so the inverse is a
structurally different, worse strategy — not the counterparty of the original fills.
Don't revisit "flip the sign" on pullback-limit architectures.

### Verdict

**The LS signal carries the entire edge — +7.5 to +10pp of win rate at 15/12 exits over
the best public flip detector through the identical pipeline** (best public detector,
EMA cross, still loses $100k where LS makes $481k). The architecture
(pullback limit, fixed exits, hour discipline) is a cost-control wrapper, not an edge
source. Corollaries:
1. No public-data LSTB clone is available this way; the TV LS feed remains a hard
   dependency and its knowability audits remain critical.
2. LS flips are NOT generic trend/momentum flips — whatever LDPS computes, it is not
   reproducible by ATR-channel/MA/momentum states at 1m.
3. Any future "replace LS" effort should target reverse-engineering the LDPS
   indicator itself (Drew has the Pine source + primers in ereptor/docs), not
   generic detector substitution.

---

## Part 3 — 🚨 LSTB adverse-cancel lookahead (found via Drew's TV cross-validation)

Cross-validating LSTB on TradingView (`ereptor/strategies/LSTB Trigger Bar.pine`,
execution-parity build) exposed a 60-second lookahead carrying the ENTIRE gold edge.

**Bug:** `_loadLs1mFile()` precomputes `adverseFlipTs` = next flip's bar-OPEN stamp;
the flip is knowable only at bar CLOSE (+60s). Live lt-monitor emits `ls_status`
strictly at bar close (verified). The simulator cancels pending fib limits from the
stamp — up to 60s before live could — and fib-pullback limits fill disproportionately
DURING the developing adverse bar, so the foresight dodges exactly the losing fills.
Third stamp-semantics lookahead in the LS pipeline (ls15 ltAlign; stats-GEX IV).

**Proof (4-way, window 2023-07→2026-06 unless noted):**

| implementation | cancel timing | n | WR | PF | PnL |
|---|---|---|---|---|---|
| engine (gold, reproduced exactly first) | stamp (foresight) | 13,049 | 53.9% | 1.31 | +$480,820 |
| **engine, one-line fix (+60000)** | close (honest) | 16,298 | 43.9% | **0.87** | **−$304,128** |
| python harness | stamp | 12,881 | 53.2% | 1.23 | +$374,606 |
| python harness | close | 17,293 | 42.0% | 0.78 | −$608,912 |
| TradingView (2025-07→2026-07) | close (real broker emu) | 6,249 | 43.1% | 0.84 | −$155,390 |

Matched-trade outcome agreement engine↔TV = 98.1% (execution is not the issue);
the divergence is entirely cluster flips (LS flips every 1-4 min in whipsaw) where
the foresight-cancel skips the WR-31% fills.

**Salvage paths tested — all DEAD:**
- Cancel-delay sweep (stamp+X): X=0 → PF 1.23; **X=15s → 0.88**; X=30s → 0.83;
  X=60s → 0.78. The edge evaporates within the first 15 SECONDS of the adverse bar —
  before any forming-bar signal could reliably exist. Forming-bar cancel cannot save it.
- Market entry at flip close (no pending, no cancel dependency): PF 0.74 / −$1.14M.

**Scope of void:** every LSTB gold using place_limit + adverse cancel — fullwindow
$480k, block-0 $483k, plain-noBE-slipfix $241,928/PF 1.35 (the live gold), TRUE-OOS
2023-24 $191k, v1/v2/v3 golds, the lstb-hours study, and every book baseline
containing LSTB. Honest LSTB as configured ≈ PF 0.87 = losing; live semantics match
the honest run. Artifacts: `output/engine_ls_honest_advcancel.json`,
`output/05-adv*.log`, `output/05-mktentry.log`. Engine source restored (fix NOT
applied — one-liner documented above, Drew's call).

## Where this leaves the "new strategy with LSTB-class profitability" goal

Nothing tested here earns a book slot. Three rigorous closures (VP levels; causal
absorption capture; public-flip LSTB clones) prevent future wasted sweeps. The
highest-expected-value remaining paths, in order:
1. **First-hour NQ book (parked, already validated):** T5 GEX-wall limit-fade
   PF 2.91/Sh 8.67 IS, PF 2.0 OOS + T7 ONH/ONL gap-break PF 2.04 IS / 4.00 OOS —
   separate 9:30-11:00 single-trade book, needs an owner and live plumbing.
2. **DWF v1.1-B OOS purchase** (~$150-200 one-time TCBBO extension) — the only
   mechanism-grounded, placebo-controlled NEW edge awaiting a decisive test.
3. **LDPS reverse-engineering** (Pine source available) — if parity is achieved, the
   LS dependency risk collapses and multi-timeframe/multi-instrument variants open up.

## Files
- `01-build-daily-profiles.py` → `output/nq_daily_profiles.csv` (1,395 days)
- `02-event-study.py` → `output/events.csv` (117k events); `03-analyze.py` tables
- `04-honest-sim.py` → `output/dws_trades_{A,B}.csv`
- `05-flip-analog.py` (screening harness) → `output/flip_analog_*.csv`, logs
- `06-make-flip-files.py` → `output/flips_{st,ema,drift}.csv`
- Engine runs: `output/engine_{ls_calib,st,ema}.json` + logs
