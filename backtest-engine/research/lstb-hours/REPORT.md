# LSTB full-window extension + trading-hours re-analysis (2026-07-14)

**Question (Drew):** with LS/LT history now back to 2021-01-17, re-run LSTB and decide
whether to restrict trading hours further.

## Data constraint — 2021 not reachable for LSTB

Today's TV dumps backfilled LS **3m and 15m** to 2021-01-17 (merged into
`research/lt-extraction/output/nq_ls_{3m,15m}_raw.csv`), but LSTB triggers on the
**1m** LS series and the deepest 1m dump (`a7f2c`) walls at **2023-07-16** — TV's 1m
deep-backtest limit (the reason the 2021 dumps are coarser TFs). 1s/1m OHLCV covers
2021+; the LS-1m series is the binding constraint. Max honest window:
**2023-07-16 → 2026-06-15 (35 months)** — more than double the prior gold window.

## Runs (all: plain v3 no-BE live config unless noted; slip-fixed engine, eod 15:45,
`--raw-contracts`, 1s exit resolution)

| run | trades | net$ | WR | PF | daily Sharpe | maxDD | worst day | neg qtrs |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| live config (block 5,16-23) | 13,049 | $480,820 | 53.9% | 1.31 | 8.79 | $6,310 | −$2,375 | 0/12 |
| **+ block hour 0 (engine-verified)** | 12,623 | **$483,510** | 54.1% | **1.33** | **8.88** | $6,460 | −$2,425 | 0/12 |
| all 24 hours open | 19,620 | $374,969 | — | 1.20 | 5.75 | $7,107 | — | — |

JSONs: `full-window-live-config.json`, `full-window-block0.json`,
`full-window-allhours.json` (this dir); analysis script `analyze-hours.py`.

## Per-hour findings (live config, full window, entry hour ET)

- **Hour 0 = the only consistently bad open hour**: 452tr, PF 0.93, −$4,055,
  negative in 2023H2/2024/2026, 2025 barely positive. Same shape in the all-hours
  run (independent trade population). t-stat only −0.7 → the case is
  sign-consistency + metric trifecta, not significance.
- Hour 1 marginal (PF 1.10, −$6.6k in 2024, +$7.8k overall, 3/4 periods +) — not acted on.
- Hours 2-15 all positive over 35 months; 8-14 ET core PF 1.37-1.71 (t 4.6-8.2).
  The 2-4 ET overnight stretch is fine (PF 1.16-1.23) — the "0-4:59 chop bleed"
  reputation comes from hour 0 plus variance.
- **Existing blocks decisively validated**: fully-open evening hours are ruinous with
  0/4-period consistency — 16 ET PF 0.12 (WR 8.5%!), 18-23 PF 0.45-0.79, combined
  ≈ −$106k. Hour 5 open = PF 1.02 / t 0.29 (dead) → keep blocked.
- Hour-discipline value: all-hours book is PF 1.20 / Sh 5.75 vs 1.31 / 8.79 blocked.

## Verification note

Leave-one-hour-out subtraction projected +$4,055 for blocking hour 0; the real
engine rerun delivered +$2,690 (slot interactions: freed hour-0 slots let other,
mostly-average trades in). Always engine-verify hour blocks.

## Recommendation

Block hour 0 → `LSTB_BLOCKED_HOURS_ET=0,5,16,17,18,19,20,21,22,23` on
signal-generator (env override beats preset v3 in
`getLsFlipTriggerBarParams()`), restart artifact, verify startup log.
Improvement is modest (+$2.7k, +0.02 PF, +0.09 Sharpe, DD +$150 worse) but
consistent across two independent runs and 3/4 periods; removes a PF-0.93 hour
at near-zero opportunity cost. Backtest presets (cli.js + config.js PRESETS,
kept in sync) unchanged until Drew confirms — new invocations should pass the
explicit blocked-hours list.
