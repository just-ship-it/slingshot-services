# Strategy Gold-Standard Commands

Per-strategy backtest CLI invocations with current gold-standard numbers, alternate presets, and historical baselines. Auto-memory entries in `MEMORY.md` track live-default changes and supersession events — when this doc and MEMORY.md disagree, MEMORY.md is more current.

> **⚠ 2026-07-11 — stats-GEX lookahead event.** The stats-variant GEX dirs (`data/gex/nq`, `data/gex/es`) were found to embed same-day EOD close prices in every intraday snapshot's IV (verification: `research/databento-live-parity/VERIFICATION-stats-gex-lookahead.md`). Contaminated data quarantined in `data/quarantine-lookahead/`; `data/gex/nq` + `data/gex/es` now contain CAUSAL regenerations (cbbo quote IV 2025-01+, prior-day-close fallback earlier, as-of labels, primary-contract spot; provenance stamped in each file's metadata).
> **VOID golds:** all GEX-FLIP-IVPCT entries (causal rerun: 94tr / −$1,737 / PF 0.98 — edge did not survive); LT-GEX-Path-Race v1 (causal rerun 2026-07-11: 512tr / $60,998 / WR 61.9 / **PF 1.22 / Sh 0.95 / DD 16.15%** — real residual but not book quality); LT-GEX-Path-Race v1-ES (causal rerun: **98tr / $44,079 / WR 72.4 / PF 2.08 / DD 7.73%** — survives standalone but FCFS-dilutive, see below); gex-touch-patterns (used default `gex/nq`); the 4-strategy FCFS baseline where it includes gfi.
> **NEW HONEST BOOK BASELINE (2026-07-11, `research/4strategy-portfolio/run-clean-book.js`, window Jan'25–Apr'26): lstb + glx + glf = $513,536 / PF 1.64 / WR 67% / Sharpe 10.47.** Adding v1-ES-causal: $523,122 / PF 1.64 / Sharpe 10.24 (+$9.6k PnL, −0.23 Sharpe) → v1-ES does NOT earn the 4th slot on Sharpe-first criteria; bench candidate. Causal v1-ES trades: `data/gold-standard/lt-gex-path-race-v1-es-causal.json`. **Unaffected:** LS-Flip-Trigger-Bar (no GEX/IV inputs). **2026-07-12 second audit wave:** Short-DTE-IV **VOID/DEAD** — its 15m IV file was floor-labeled (row T held IV at ~T+14:59; the "enter at candle.open" timing fix harvested the leak); on as-of labels: 281tr / −$19,765 / WR 45.9 / **PF 0.80**. `nq-cbbo` GEX found partially contaminated (pre-RTH snapshots = 100% same-day-EOD-close IV; RTH ~4% fallback). **Causal reruns (`data/gex/nq-cbbo-causal`, adds CEX/VEX walls): GLX v3 $217,864/PF 1.90 → $54,096/PF 1.30 — pre-RTH edge ~91% lookahead (block 7–9 ET live), RTH drop pending re-tune attribution (v3 rules index the ladder ordering the spot fix reshuffled) → GLX v3 AS-TUNED VOID pending re-tune. GLF v2 $110,730/PF 1.44 → $87,040/PF 1.36 SURVIVES. ISG v8 $92,164/PF 1.64 → $57,188/PF 1.43 survives-thin, tuning doubly stale.**

> **⚠ 2026-07-13 — simulator BE/trailing slippage fix.** `trade-simulator.js exitTrade()` previously applied `stopOrderSlippage` (1.5 pt) only to `stop_loss`; `trailing_stop` (= BE exits) and time-based exits got ZERO slippage. Now: any stop-type exit (stop_loss, trailing_stop) slips 1.5 pt; time/market exits (eod_liquidation, market_close, max_hold_time, soft_stop, fib_retrace) slip 1.0 pt; only take_profit limit fills are slip-free. **Every gold generated before 2026-07-13 that uses BE/trailing or time exits is optimistic and needs a regen** (GLX, GLF, ISG, GFI tight-stop, …). LSTB regenerated same day (see its section + `research/lstb-be-resweep/REPORT.md`): v3-ltAlign honest = **$154,606 / PF 1.66 / Sharpe 10.4** (was $193,486 / 1.84); BE re-sweep shows **no-BE beats all BE configs** ($201,021 / Sharpe 11.0).

Run `node index.js --help` for all available strategies and options.

---

## IV-SKEW-GEX

1m IV resolution, raw contracts, cbbo-derived GEX, shared-calc IV.

```bash
cd backtest-engine
node index.js --ticker NQ --strategy iv-skew-gex --timeframe 1m --raw-contracts \
  --start 2025-01-13 --end 2026-04-23 \
  --target-points 200 --stop-loss-points 60 --max-hold-bars 90 \
  --breakeven-stop --breakeven-trigger 140 --breakeven-offset 10 \
  --blocked-regimes strong_negative \
  --level-proximity 100 \
  --neg-skew-threshold 0.0145 --pos-skew-threshold 0.0250 \
  --iv-resolution 1m \
  --gex-dir data/gex/nq-cbbo
```

**Post-fix baseline (2026-05-06):** 244 trades, **$92,164** PnL, 49.6% WR, **PF 1.64**, Sharpe 3.97, **Max DD 9.23%** over 16 months. The current SL/TP/BE params and skew thresholds were sweep-tuned against lookahead-biased data and are no longer optimal — re-tune via `research/PROMPT-reoptimize-stops-targets-post-lookahead-fix.md`.

Pre-fix v8 historical reference: 244 trades, $136,864 PnL, 51.6% WR, PF 2.03, Sharpe 5.71, Max DD 6.04%. JSON: `data/gold-standard/iv-skew-gex-v8-balanced.json` (do NOT deploy live — lookahead-biased GEX).

### Why the current params

The 5/2 sweeps (136 combos in `/tmp/overnight-sweep/`) compounded four improvements over the 5/1 baseline:
1. **Lower negSkewThreshold** (0.0165 → 0.0145): tighter LONG selectivity.
2. **Wider BE offset** (5 → 10): bigger profit on the rare BE-floor exits.
3. **Very late BE trigger** (60 → 140): BE arms only on extreme MFE retracements.
4. **Longer maxHold** (60 → 90 bars): lets rare big winners run.

Combined: +0.12 PF, +1.00 Sharpe, -1.16pp DD, +$21k PnL.

`posSkewThreshold` is insensitive in 0.024–0.028. Both skew thresholds are POSITIVE because natural ATM put-call structural skew on 7-DTE QQQ sits at +1.74% — strategy reads deviations from that baseline.

**MUST include `--level-proximity 100`** — default of 25 reduces trade count to ~94 with mediocre performance.

**MUST use `--timeframe 1m --raw-contracts`** — without `--raw-contracts`, continuous data breaks GEX proximity. **MUST include `--gex-dir data/gex/nq-cbbo`** — without it, the engine falls back to legacy daily CSV.

### v8 risk modes (STALE post 2026-05-06 lookahead fix)

The table below was sweep-tuned against lookahead-biased GEX. None of these modes are valid baselines anymore; "Balanced" is the current code default and its post-fix numbers are in the headline above.

| Mode | Config | Trades | WR | PF | Sharpe | DD | PnL |
|---|---|---:|---:|---:|---:|---:|---:|
| **Balanced** (default) | SL=60, BE=140, mh=90 | 244 | 51.6% | 2.03 | 5.71 | 6.04% | $137k |
| **Aggressive** (PnL) | SL=80, BE=130, mh=90 | 233 | 58.4% | 2.05 | 5.54 | 8.06% | $141k |
| **Even-longer hold** | SL=60, BE=130, mh=120 | 234 | 53.0% | 2.07 | 5.70 | 6.83% | $139k |
| **Earlier BE** | SL=60, BE=120, mh=90 | 244 | 53.3% | 2.05 | 5.54 | 6.98% | $135k |
| **5/1 Baseline** | SL=60, BE=60+5, neg=0.0165, mh=60 | 291 | 60.5% | 1.91 | 4.71 | 7.20% | $116k |
| **Selective Tight** | SL=80, neg=+0.0100 (TP/SL=120/80) | 63 | 73.0% | 2.48 | 1.93 | 6.16% | $35k |

Stale JSONs (do NOT use for live): `iv-skew-gex-cbbo-v6-*` (broken IV), `iv-skew-gex-v7-*` (precompute-vs-live drift).

Pre-v8 history: v2 (stats lookahead): PF 7.65. v3-v5 (cbbo with ts_event bug): PF 2.94-3.51. v6 (corrected cbbo, broken IV): PF 2.37. v7 (corrected IV, but precompute drift): PF 1.32. v8 pre-bucket-fix: PF 2.03. **v8 post-bucket-fix (5/6) is the current honest baseline at PF 1.64.**

---

## GEX-FLIP-IVPCT — v2 (live default)

5m timeframe, 1m IV resolution, day-trade-margin friendly.

```bash
cd backtest-engine
node index.js --ticker NQ --strategy gex-flip-ivpct --timeframe 5m --raw-contracts \
  --start 2025-01-13 --end 2026-04-20 \
  --iv-resolution 1m \
  --eod-cutoff-et 16:40 \
  --gfi-preset v2
```

**v2 gold standard (2026-05-21):** **161 trades, $208,938 PnL, 54.0% WR, PF 3.39, Sharpe 5.31, Max DD $8,595** over 16 months. Max single loss capped at **-$1,235** (Drew's $1,240 small-account hard constraint preserved). JSON: `data/gold-standard/gex-flip-ivpct-v2.json`. Research writeup: `research/gex-flip-ivpct-improve/SUMMARY.md`.

**Vs. prior tight-stop gold ($157,329 / PF 2.99 / Sh 4.76 / DD $14,580):** +33% PnL, +0.40 PF, +12% Sharpe, **-41% DD**. Dominates on every metric. Live now defaults to v2 via `GFI_PRESET=v2` (set in `signal-generator/src/utils/config.js`); flip to `GFI_PRESET=tight` to revert.

`--gfi-preset v2` expands to: `--gfi-stop-pts 60 --gfi-target-pts 260 --gfi-breakeven-stop --gfi-breakeven-trigger 160 --gfi-breakeven-offset 10 --gfi-blocked-hours 6,7,8` plus `maxHoldBars=600`. **Fib retrace is OFF by default** in v2 (research showed it hurts the wider target by ~$20-30k).

Alternate presets (all preserve -$1,235 max loss):
- `--gfi-preset v2-max`: tgt=320 + mh=480 → 161 trades, **$217,538**, PF 3.49, Sh 5.14, DD $8,595 (max PnL, -0.17 Sharpe vs v2)
- `--gfi-preset v2-low-dd`: drops h11+Fri+S1 → 119 trades, $167,713, PF 3.70, Sh 4.92, DD $11,190 (highest PF but engine DD slightly ABOVE v2's — selective-trading variant, name preserved per family convention)
- `--gfi-preset tight`: prior 2026-05-12 gold for comparison runs

Mechanism (two compounding levers):
1. **Target 200 → 260pt** captures fat-tail upside. Avg win $1,524 → $2,121.
2. **BE trigger 70 → 160pt** + offset 5 → 10 eliminates winner-clipping. Gold's BE 70/+5 caught 36 trades for $5pt micro-locks; v2's BE 160/+10 arms only on ~11 trades that truly retrace from MFE≥160. Net: DD drops 41% because the micro-clip BE exits were masking variance.

Prior tight-stop gold (2026-05-12) — **SUPERSEDED by v2:** 172 trades, $157,329 PnL, 61.6% WR, PF 2.99, Sharpe 6.41, Max DD 11.3%. JSON: `data/gold-standard/gex-flip-ivpct-tight-s60t200be70.json`. Reproduce via `--gfi-preset tight`.

Pre-refit wide-stop baseline reference (per-rule stops 106-184pt): 143 trades, $275k PnL, PF 4.29, Sharpe 10.60, Max DD 4.16% — higher headline numbers but max single loss $3,720 and 15 painful givebacks. JSON: `data/gold-standard/gex-flip-ivpct-postfix-baseline.json` (do NOT deploy on a small account).

**Parity REQUIRES** `--iv-resolution 1m`, `--timeframe 5m`, and `--eod-cutoff-et 16:40`. With 15m IV, skew can be up to 14 min stale; with 1m timeframe the engine puts evaluations on a different bar grid.

---

## Short-DTE-IV

15m timeframe, production params from `default.json`.

```bash
cd backtest-engine
node index.js --ticker NQ --strategy short-dte-iv --timeframe 15m \
  --start 2025-01-13 --end 2026-01-23
```

Production defaults baked into `src/config/default.json`. Does NOT require `--raw-contracts`.

---

## GEX-LT-3M-Crossover — v3 (live default)

1m timeframe, 1m LT × GEX 3-min sign-flip detector.

```bash
cd backtest-engine
node index.js --ticker NQ --strategy gex-lt-3m-crossover --timeframe 1m --raw-contracts \
  --start 2025-01-13 --end 2026-04-23 \
  --gex-dir data/gex/nq-cbbo \
  --lt-1m-file research/lt-extraction/output/nq_lt_1m_raw.csv \
  --glx-force-any \
  --eod-cutoff-et 16:40 \
  --glx-entry-window 07:00-16:00 \
  --glx-blocked-hours 13 \
  --glx-preset v3
```

**v3 gold standard (2026-05-21):** **553 trades, $217,864 PnL, 60% WR, PF 1.90, Sharpe 8.73, MaxDD 5.56%** over 16 months. JSON: `data/gold-standard/gex-lt-3m-crossover-v3.json`. Strategy uses `place_limit` at signal close with 5-min timeout. Research writeup: `research/gex-lt-3m-improve/SUMMARY.md`.

Per-rule v3 config (baked into `--glx-preset v3`):
- **L_S4**: TP=100/SL=70/mh=120/BE 70/+20, blocks Thu/Fri + L3/L5
- **S_GF_SOLO**: TP=180/SL=70/mh=120/BE 80/+20, blocks 11 ET
- **S_CW**: TP=200/SL=70/mh=120/BE 80/+20, blocks 14-15 ET
- **S_R4**: TP=80/SL=40/mh=60 + trail 70/25, blocks Fri + L3/L5 + 11/15 ET

Alternate presets:
- `--glx-preset v3-max`: $256k / PF 2.03 / Sh 8.75 / DD 6.40% (wider L_S4 target + longer holds)
- `--glx-preset v3-balanced`: TBD
- `--glx-preset v3-low-dd`: TBD
- `--glx-preset w12`: $179k / PF 1.44 — prior gold standard, preserved for reproduction

**W12+SCW-PM-block baseline (2026-05-18) — SUPERSEDED by v3:** 888 trades, $179,201 PnL, 47.6% WR, PF 1.44, Sharpe 6.12, MaxDD 8.26%. Active rules (4): L_S4 (TP=120/SL=50/mh=90), S_GF_SOLO (TP=60/SL=50/mh=90), S_CW (TP=120/SL=50/mh=90, blocked 14:00-15:59 ET), S_R4 (TP=80/SL=50/mh=60). Live now defaults to v3 via `GLX_PRESET=v3` (set in `signal-generator/src/utils/config.js`); flip to `GLX_PRESET=w12` to revert. JSON: `data/gold-standard/gex-lt-3m-crossover.json`. Historical write-up: `research/GEX-LT-3M-IMPLEMENTATION-RESULTS.md`.

Prior W12 baseline (2026-05-08, before S_CW PM block): 909 trades, $164,847 PnL, PF 1.39, Sharpe 5.62, MaxDD 8.30%. S_CW analysis: morning (07-12 ET) PF 2.08 / +$47.7k; afternoon (14-15 ET) flipped to PF 0.29 / −$10.5k / WR 32% on 25 trades. Other 3 rules are *more* efficient in afternoon. Surgical fix: block S_CW only in afternoon.

Earlier "v14" config (139 trades, $40k) was an overfit driven by stacking unjustified constraints copied from gex-flip-ivpct. **Methodology lesson: cast a wide net first, then filter one constraint at a time and keep only those proven to help.**

---

## LS-Flip-Trigger-Bar — v3 candJ (current gold)

1m timeframe, fixed-point exits + BE + noAsia + min-range filter.

```bash
cd backtest-engine
node index.js --ticker NQ --strategy ls-flip-trigger-bar --timeframe 1m --raw-contracts \
  --start 2025-01-13 --end 2026-04-23 \
  --ls-1m-file research/lt-extraction/output/nq_ls_1m_raw.csv \
  --eod-cutoff-et 15:45 \
  --lstb-preset v3
```

`--lstb-preset v3` expands to: `--lstb-blocked-hours "5,16,17,18,19,20,21,22,23" --lstb-min-range 3 --lstb-target-pts 15 --lstb-stop-pts 12 --lstb-breakeven-stop --lstb-be-trigger 8 --lstb-be-offset 2`.

**v3 candJ gold standard (2026-05-21):** **6,463 trades / $279,135 PnL / +114% vs v2 / WR 72.2% / PF 1.59 / Sharpe 21.00 / MaxDD 1.82%** over 16 months. JSON: `data/gold-standard/ls-flip-trigger-bar-v3.json`. Doubles v2's $130,500 PnL while preserving sub-2% DD; per-trade Sharpe nearly doubles (10.97 → 21.00).

### v3 + ltAlign (2026-07-11 — RETIRED 2026-07-14, ls15 stamp lookahead)

> **⚠ 2026-07-14 — ls15 lookahead fix + ltAlign retirement.** The 15m LS dumper
> stamps bars at OPEN; the sealed state is knowable only at CLOSE. The engine
> exposed it at the stamp → every ltAlign backtest had up to 14min of foresight
> during flip bars (caught by a PILOTFISH timing test: 15m-flip 60m drift +31pt
> at stamp, +0.6pt at stamp+15m). Engine fixed (`knowableAt = ts − 15m`,
> backtest-engine.js). Honest rerun: ltAlign-no-BE = 3,137tr/$142,805/PF 1.39/
> Sh 11.46/DD 3.01% vs **plain v3 no-BE = 5,934tr/$241,928/PF 1.35/Sh 15.76/
> DD 3.70%** — the filter costs 41% PnL and 4.3 Sharpe for +0.04 PF; it does
> NOT earn its place at honest semantics. **LIVE reverted to plain v3 no-BE
> 2026-07-14 04:00Z** (`LSTB_REQUIRE_LT_ALIGN=false` env on signal-generator,
> artifact restart; startup log verified `requireLtAlign=false,
> breakevenStop=false`). **New live gold:**
> `ls-flip-trigger-bar-v3-plain-noBE-slipfix.json`. The honest ltAlign regen is
> `ls-flip-trigger-bar-v3-ltalign-noBE-ls15fix.json` (reference only). DWF
> ls-align variants (A/C) died the same way — dte0-only variant B unaffected.

> **✅ 2026-07-14 — TRUE OOS CONFIRMATION (2023-08→2025-01).** LS-1m backfill
> (TV dumper, walls at 2023-07-16) enabled the first cross-regime test of the
> live config on data its params never saw: **6,108 trades / $191,133 /
> PF 1.26 / Sharpe 10.67 / MaxDD 3.85% / WR 52.8%, ALL SIX quarters positive**
> (PF by quarter 1.25/1.20/1.22/1.10/1.37/1.44). Softer than in-sample
> (PF 1.35/Sh 15.8) but decisively profitable across the 2023 recovery and
> 2024 grind. JSON: `ls-flip-trigger-bar-v3-plain-noBE-oos2023-24.json`.
> Caveat: the 2023-24 LS-1m series is single-source (no cross-validation
> possible; flip-rate profile matches the validated 2025+ series).

> **📊 2026-07-14 — FULL-WINDOW EXTENSION + HOURS STUDY (`research/lstb-hours/REPORT.md`).**
> Single continuous run of the live config over the max honest window
> 2023-07-16 → 2026-06-15 (LS-1m walls at 2023-07-16 — TV 1m deep-backtest
> limit; the new 2021 backfills are 3m/15m only and don't feed LSTB):
> **13,049tr / $480,820 / WR 53.9 / PF 1.31 / Sharpe 8.79 / maxDD $6,310 /
> ALL 12 quarters positive** — `ls-flip-trigger-bar-v3-plain-noBE-fullwindow-2023-2026.json`.
> Hours: existing 5,16-23 blocks decisively validated (fully-open evenings
> = PF 0.12-0.79, negative all 4 periods, ≈ −$106k); hour 0 ET is the only
> consistently bad open hour (PF 0.93, −$4.1k, negative 3/4 periods).
> Engine-verified block-0 variant: **12,623tr / $483,510 / PF 1.33 / Sharpe 8.88
> / maxDD $6,460 / 12/12 quarters +**
> (`ls-flip-trigger-bar-v3-plain-noBE-block0-fullwindow.json`) — **DEPLOYED LIVE
> 2026-07-14 ~16:10Z** via `LSTB_BLOCKED_HOURS_ET=0,5,16,17,18,19,20,21,22,23`
> env on signal-generator + artifact redeploy (b8ab8f0); verified via
> `/strategy/status/ls-flip-trigger-bar` → blockedHoursEt includes 0. The v3
> preset lists in cli.js/config.js intentionally NOT changed — env override is
> the live truth; backtests should pass the explicit blocked-hours flag.
> **This block-0 JSON is the new live gold.**

Adds `--lstb-require-lt-align --ls15-file research/lt-extraction/output/nq_ls_15m_raw.csv` to the v3 command. The alignment source is the **LS-15m state** point-in-time (the historical LT-feed "sentiment" column IS this series — 99.7% verified; see `memory/lt-sentiment-is-ls15.md`). `--ls15-file` decouples the filter from LT-row coverage and mirrors the live design (dedicated 15m LS study; the 1m LS stream is NOT a valid proxy — 52% agreement).

**v3-ltAlign gold (2026-07-11, filter active over the FULL window):** **3,449 trades / $193,486 / WR 74.5% / PF 1.84 / Sharpe 19.98 / MaxDD 1.47%.** −47% trades and −$86k PnL vs plain v3, buying +0.25 PF and a lower DD. JSON: `data/gold-standard/ls-flip-trigger-bar-v3-ltalign.json`. **⚠ SUPERSEDED 2026-07-13 by the simulator BE-slippage fix (see banner):** honest regen = **3,449 trades / $154,606 / WR 73.6% / PF 1.66 / daily Sharpe 10.4 / worst day −$2,170**, JSON `ls-flip-trigger-bar-v3-ltalign-slipfix.json`. At MNQ scale with real fees (~$2.4/RT) ≈ $8.9k/15.5mo ≈ +$27/day. BE re-sweep on the fixed engine (`research/lstb-be-resweep/REPORT.md`): **no-BE = $201,021 / PF 1.57 / Sharpe 11.0 / MNQ real-fee $13.9k** beats every BE config (BE only trims tail: worst day −$2,170 vs −$2,750); balanced alternates trig12/off2 ($184,621/Sh 10.6) and trig10/off3 ($171,762/PF 1.63). **LIVE DEFAULT since 2026-07-13: no-BE** (`LSTB_BREAKEVEN_STOP=false` env on signal-generator Sevalla app; preset stays v3 otherwise — ltAlign ON, tgt 15/stp 12). New live gold = `ls-flip-trigger-bar-v3-ltalign-noBE-slipfix.json`: **3,278 trades / $201,021 / WR 58.5% / PF 1.57 / Sharpe 11.0 / maxDD $3,055 / worst day −$2,750**.

**Book context (post-lookahead-event production candidate, `run-book-scenarios.js`, Jan'25–Apr'26):** GLX + LSTB-ltAlign = **$381,305 / PF 1.86 / WR 72.1% / Sharpe 9.40 / maxDD $7,157 (3.0%) / worst day −$4,135 / worst week −$3,131**. Adding v1-ES: +$12.4k but Sharpe −0.15 (benched). Adding GLF: +$69k but PF −0.11, worst day −$5,085 (small-account risk trade-off).

Mechanism (four levers compound):
1. Fixed 15pt target / 12pt stop replacing bar-extreme equidistant TP/SL.
2. BE @ MFE=8pt locking +2pt profit (fires on 2,309 trades = 35% of total).
3. Block hours 17-23 ET (Asia overnight bled ~$11k cumulative).
4. Skip trigger bars with range <3pt (1k unprofitable trades dropped).

On 3,783 trades present in both v2 and v3, exit-policy alone is +$69,734 (+61%); rest is filter-driven trade flow improvements. Train/test stable: H1 PF 1.56 / H2 PF 1.62, no overfit.

Alternate v3 presets (in `data/gold-standard/ls-flip-trigger-bar-v3-{max,balanced,low-dd}.json`):
- `--lstb-preset v3-max` (candK, tgt=20 stp=12 BE 10/+1): $282,580 / Sharpe 18.31 / DD 2.84% / PF 1.49
- `--lstb-preset v3-balanced` (candH, tgt=10 stp=9 BE 6/+1): $214,122 / **Sharpe 22.12** / DD 1.54% / PF 1.65
- `--lstb-preset v3-low-dd` (candC, orig tgt + stp=8 + trail 12/5): $151,820 / Sharpe 18.85 / **DD 1.42%** / PF 1.77

v2 preserved at `data/gold-standard/ls-flip-trigger-bar-v2.json` (reproduce with `--lstb-preset v2`: blocked-hours 5/16/21, bar-extreme exits). v1 ($129k, no blocks, eod 17:00) at `data/gold-standard/ls-flip-trigger-bar.json`.

Research log: `backtest-engine/research/ls-flip-improve/SUMMARY.md` — feature buckets, 4,000+ candidate sweep, mechanism analysis, all 16 engine validations.

---

## GEX-Level-Fade — v2 (current gold)

1m timeframe, structural-level fade. 09:00-10:30 ET entry, wider exits + structural BE + dropped SH/SL.

```bash
cd backtest-engine
node index.js --ticker NQ --strategy gex-level-fade --timeframe 1m --raw-contracts \
  --start 2025-01-13 --end 2026-04-23 \
  --glf-preset v2 \
  --gex-dir data/gex/nq-cbbo \
  --eod-cutoff-et 16:40
```

`--glf-preset v2` expands to: `--glf-target-pts 110 --glf-stop-pts 22 --glf-max-hold 180 --glf-breakeven-trigger 100 --glf-breakeven-offset 10 --glf-levels "PRH,PRL" --glf-include-gex --glf-entry-window 09:00-10:30`.

**v2 gold standard (2026-05-21):** **716 trades / $110,730 PnL / WR 25.7% / PF 1.44 / Sharpe 4.44 / Max DD 7.96%** over 16 months. JSON: `data/gold-standard/gex-level-fade-v2.json`. Research writeup: `research/gex-level-fade-improve/SUMMARY.md`.

**vs. baseline (`--glf-preset gold` + same EOD):** 903 trades / $90,475 / Sh 3.66 / DD 8.17% → +22% PnL / Sh +21% / DD -3% / PF +9%. Live now defaults to v2 via `GLF_PRESET=v2` (set in `signal-generator/src/utils/config.js`); flip to `GLF_PRESET=gold` to revert.

Mechanism (three levers compound):
1. **Stop 18 → 22pt** — escapes the false-stop noise band (286 gold stops in the 0-10pt MFE bucket many of which recovered).
2. **Target 100 → 110pt** — captures fat-tail winners without breaking PF.
3. **Structural BE @ MFE=100 / +10pt** — catches the "MFE 80-100 → full SL" pattern. 174 gold trades had MFE ≥30pt yet hit full SL (19.6% of all trades — vs glx v3's 0.2%).

Plus **drop SH/SL levels** (PF 0.96 zone, -$2,000 net at gold exits). PRH/PRL + all GEX levels retained.

Alternate v2 presets (saved JSONs `data/gold-standard/gex-level-fade-v2-{max,low-dd}.json`):
- `--glf-preset v2-max` (t=140 s=25 BE 100/+20 all-levels): 774 / $106,272 / Sh 3.81 / DD 13.52% / PF 1.35. **Sim predicted $148k but engine -$42k** — wider exits hit concurrent-trade rejection harder + kept SHL adds zero-edge noise. NOT recommended; strictly dominated by v2.
- `--glf-preset v2-low-dd` (t=110 s=20 BE 80/+10 drop SHL): 745 / $100,020 / Sh 3.95 / DD 8.25% / PF 1.42. Sim said low DD but engine DD essentially tied with v2 — SHL filter is the dominant DD reducer, not the tighter stop. Strictly dominated by v2.

**Saved May-17 gold reference:** `data/gold-standard/gex-level-fade.json` (889 trades / $104,771 / Sh 4.21 / DD 7.04%) — generated WITHOUT `--eod-cutoff-et` so its baseline numbers are slightly inflated vs production-honest EOD. Use the engine-reproduced baseline ($90,475) for honest v2 comparison.

**GEX-only Pareto reference** (separate config, not in v2 family): `--glf-levels NONE --glf-include-gex` → `data/gold-standard/gex-level-fade-gexonly.json` (200 trades / WR 28% / PF 1.97 / Sh 3.26 / DD 3.92% / $55,355). Use when small-account DD ceiling is the priority — trade count is much lower (~12/mo).

Research log: `backtest-engine/research/gex-level-fade-improve/SUMMARY.md` — 1s-honest walks, exit sweeps (1,500+ configs), feature analysis, filter sweep, market-aware exits tested and rejected, train/test stability.

---

## LT-GEX-Path-Race — v1 / v1-ES (2026-07-07, NOT live)

1m timeframe, hourly composite: GEX barriers block/clear the path to the nearest LT level on each side; trade toward the GEX-clear LT with the GEX-shielded opposite LT as stop. From the LT magnet-race study (`research/deepdive-weekly/REPORT-LT-MAGNET.md`).

```bash
cd backtest-engine
# v1 (ungated)
node index.js --ticker NQ --strategy lt-gex-path-race --timeframe 1m --raw-contracts \
  --start 2023-03-28 --end 2026-06-16 \
  --gex-dir data/gex/nq \
  --commission 4 --allow-overnight-holds

# v1-ES sleeve (ES-15m clear-path confluence gate)
node index.js ... (same) --lgpr-es-gate
```

**v1 gold standard (2026-07-07):** **549 trades / $209,277 / WR 71.0% / PF 2.04 / Sharpe 4.22 / MaxDD 4.73%** over 38.5 months. Per-year PF 2.56 / 2.27 / 2.05 (2023/24/25); 2026 −$7.4k on n=16 (GEX-thin window — known watch item). Trades: `data/gold-standard/lt-gex-path-race-v1-trades.csv`.

**v1-ES gold standard (2026-07-07):** **113 trades / $97,451 / WR 83.2% / PF 5.10 / Sharpe 3.15 / MaxDD 3.22% (261pt)** — per-year PF 9.60 / 5.80 / 3.82, ~0.7 trades/week. ES race data walls at 2026-01 (live ES LT feed exists, so backtest-only limitation). Gate state file: `data/features/es15_clearpath_states.csv`. Trades: `data/gold-standard/lt-gex-path-race-v1-es-trades.csv`.

Config (defaults baked into the strategy): every 4th fresh LT-feed row (~hourly, drifts with the feed grid); nearest LT above/below spot (0.05% < d < 8%); GEX snapshot ≤45 min; composite = no GEX resistance between spot and target-LT (0.15%-of-spot epsilon) AND GEX support between spot and stop-LT (mirrored for shorts); limit entry at 10% pullback of the spot→stop range, cancelled if target touches first (`cancelOnPreFillExtreme`); target/stop = the LT levels themselves (no fixed points); **8h wall-clock time-stop** (`maxHoldWallMs` — spans maintenance/weekends; NOT `maxHoldBars`). No entry window, holds overnight (`--allow-overnight-holds` required), no EOD cutoff.

Research parity (1s-honest research sim: 632 tr / WR 70.9 / PF 2.28 / +14,429pt): engine WR matches exactly; n −13% / PF −10% from (a) LT row-grid phase drift (engine misses rows with no candle within 20 min), (b) research's signal-minute fill optimism, (c) engine stop slip 1.5 vs research 0.5 (kept for book-comparability). Exit agreement on shared signal instants: 96.5%. Grid-phase robustness confirmed (off-phase 2024: PF 1.96). Diff tool: `research/deepdive-weekly/diff-engine-vs-research.py`.

Rejected in research (do NOT re-sweep): stop caps, breakeven stops, near-target rejection exits, sentiment/IV/LS/DDS signal filters, stop-on-wall exclusion (marginal, DD gain evaporates under slot re-sequencing). Wide-geometry (stop-LT >0.8% away) is a SIZE-UP tilt (PF 3-5 every year), not a filter — portfolio phase.

---

## Dealer-Wall-Fade — v1 CANDIDATE (2026-07-13, NOT live, awaiting OOS)

Short NQ at flow-confirmed dealer-LONG-gamma GEX walls after a 5-min stall in the ±0.10% zone (below-approach only). Mechanism pre-registered + placebo-controlled (`research/dealer-flow/`): naked GEX walls proved placebo-equivalent; the edge is specifically dealer positioning SIGN from signed options flow (TCBBO quote-rule; Schwab polling and tick-rule both empirically REJECTED as substitutes).

```bash
cd backtest-engine
node index.js --ticker NQ --strategy dwf --timeframe 1m --raw-contracts   --start 2025-02-02 --end 2026-01-28   --dwf-levels-file data/features/dwf_levels.csv   --dwf-stop-mode zone --dwf-max-hold 120 --dwf-target-pts 45   --commission 4 --allow-overnight-holds
```

**v1 candidate (engine, house slippage 1.0/1.5):** **272 trades / $27,422 / WR 55.5% / PF 1.33 / Sharpe 2.11 / MaxDD 6.59%** over 2025-02→2026-01 (12 months — TCBBO coverage limit). Quarter-blocks ALL positive [6219, 4948, 2109, 14146]; 9/12 months green, worst month −$3,591. Trades: `data/gold-standard/dealer-wall-fade-v1-candidate.json`.

Sweep (engine): base s25/h60 PF 1.19 → s35/h60 1.25 → zone/h120/t35 1.31 → **zone/h120/t45 1.33** (plateau t35↔t45). Breakeven overlay REJECTED under house stop slippage (whipsaw tax; research's 0.5pt slip had flattered it). `--allow-overnight-holds` REQUIRED (38% of trades die to session force-close without it — evening/overnight carries much of the edge; RTH-only variant guts it to PF 1.10).

Levels file: `scripts/precompute-dwf-levels.py` (causal cbbo GEX walls × signed-flow dealer inventory from `data/flow/qqq/`). **Gates before live:** (1) OOS on 2026-02→present (TCBBO extension purchase, ~$150-200 one-time, or Massive Options Advanced trial month); (2) ~~unexplored conditioning~~ DONE 2026-07-13, see v1.1 below; (3) live inventory feed = options tape ($199/mo class — Massive Adv or Databento OPRA Std; Schwab CANNOT substitute, verified).

### v1.1 conditioning variants (2026-07-13, gate #2 complete — in-sample refinements, same OOS gate applies)

One condition at a time on the v1 config (`--dwf-min-dte0`, `--dwf-ls-align` + `--ls15-file research/lt-extraction/output/nq_ls_15m_raw.csv`):

| Variant | n | PnL | PF | Sharpe | MaxDD | WR | Quarters |
|---|---|---|---|---|---|---|---|
| v1 base | 272 | $27,422 | 1.33 | 2.11 | 6.59% | 55.5% | all + |
| ~~A `--dwf-ls-align`~~ | 114 | $11,640 | 1.30 | 1.10 | 4.26% | 55.3% | DEAD (ls15 lookahead; honest regen 2026-07-14) |
| **B `--dwf-min-dte0 0.16`** | 183 | $25,758 | **1.47** | **2.28** | **3.83%** | 56.8% | **all +** |
| ~~C both gates~~ | 74 | $9,329 | 1.37 | 0.93 | 3.11% | — | DEAD (ls15 lookahead) |

**B is the only surviving conditioner** (raises PF+Sharpe+DD together while keeping 94% of PnL) — A and C were ls15-stamp lookahead artifacts (see LSTB section banner); their pre-fix rows: A 115/$20,609/1.61, C 73/$18,251/1.88. Both gates are mechanism-grounded, not mined: dte0 = concentration of TODAY's hedging obligation at the strike (charm-consistent; matches the pilotfish D2 gradient PF 1.04→1.53 and walls strengthening after 14:00 ET), lsAlign = don't short walls into bullish 15m tape. Placebo-with-stall control CLOSED by pilotfish E6 (stall shape at round hundreds = null both 2023-24 and 2025-26 → flow-signing IS the edge). Caveat: both conditioners chosen on the same 12-month window as v1 — the 2026-02+ OOS purchase remains the arbiter for ALL variants.
