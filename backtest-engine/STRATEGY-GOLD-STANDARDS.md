# Strategy Gold-Standard Commands

Per-strategy backtest CLI invocations with current gold-standard numbers, alternate presets, and historical baselines. Auto-memory entries in `MEMORY.md` track live-default changes and supersession events — when this doc and MEMORY.md disagree, MEMORY.md is more current.

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
