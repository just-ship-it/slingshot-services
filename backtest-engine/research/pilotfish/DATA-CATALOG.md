# LS/LT data catalog & 2020-2026 pull plan (2026-07-13)

Target (Drew): LS + LT on 1/3/5/15m + 1h/4h, 2020→2026, NQ (ES secondary),
for cross-regime strategy testing. Source: TradingView dumper strategies
(proven; deep-backtest export reaches full history). Stamps = bar OPEN with
SEALED bar values — consumers must expose state only from stamp+timeframe
(see 2026-07-13 ls15 lookahead fix in backtest-engine.js).

## On disk today (NQ)

| Series | TF | Coverage | Rows | File |
|---|---|---|---|---|
| LS state | 1m | **2023-07-16** → **2026-07-14** | 83,180 | research/lt-extraction/output/nq_ls_1m_raw.csv (backfilled + refreshed 2026-07-14; TV 1m history walls at ~2023-07) |
| LS state | 3m | **2021-01-17** → 2026-07-14 | 49,506 | nq_ls_3m_raw.csv (full-history replace 2026-07-14, 99.89% overlap agreement) |
| LS state | 5m | **2021-01-17** → 2026-07-14 | 28,721 | nq_ls_5m_raw.csv (NEW 2026-07-14) |
| LS state | 1h | **2021-01-17** → 2026-07-13 | 2,197 | nq_ls_1h_raw.csv (NEW 2026-07-14) |
| LS state | 4h | **2021-01-17** → 2026-07-13 | 589 | nq_ls_4h_raw.csv (NEW 2026-07-14) |
| LS state | 1D | **2021-01-17** → 2026-07-01 | 101 | nq_ls_1d_raw.csv (NEW 2026-07-14) |
| LS state | 15m | **2021-01-17** → 2026-07-14 | 8,691 | nq_ls_15m_raw.csv (full-history replace 2026-07-14, 99.70% overlap agreement) |
| LT levels | 1m | 2025-01-01 → 2026-06-16 | 513,892 | nq_lt_1m_raw.csv |
| LT levels | 3m | 2025-01-01 → 2026-05-07 | 158,197 | nq_lt_3m_raw.csv |
| LT levels | 15m | **2021-01-27** → **2026-07-14** | 128,292 | data/liquidity/nq/NQ_liquidity_levels.csv (2021-backfill + refresh 2026-07-14; live-feed truth 2023-03→2026-06, dumper+3.25 elsewhere, ~15pt uncertainty pre-2023; sentiment = LS-15m) |
| LT levels | 1h | **2021-01-17** → 2026-07-14 | 32,419 | nq_lt_1h_raw.csv (NEW 2026-07-14, raw-translated, price-space audited) |
| LT levels | 4h | **2021-01-17** → 2026-07-14 | 8,456 | nq_lt_4h_raw.csv (NEW 2026-07-14, raw-translated, price-space audited) |
| PT triggers | 15m chart | **2021-01-17** → 2026-07-14 | 129,585 | nq_pt_15m_raw.csv (NEW: P5/PH/PD/PW/PM — full ladder; PH/PD counts match 1h/4h files exactly; PW≈weekly, PM≈monthly) |
| PT triggers | 1h chart | **2021-01-17** → 2026-07-14 | 32,434 | nq_pt_1h_raw.csv (NEW: PH hourly-sealed + PD; cross-validated vs 4h file) |
| PT triggers | 4h chart | **2021-01-17** → 2026-07-14 | 8,460 | nq_pt_4h_raw.csv (NEW 2026-07-14: Toolkit Price Triggers PH+PD; PD = sealed daily, rolls 18:00 ET; PW/PM pending W/M toggle re-pull) |
| LT levels (ES) | 15m | 2023-03 → ~2026-01 | — | data/liquidity/es/ES_liquidity_levels_15m.csv |

None at 5m / 1h / 4h. Nothing before 2023-03 anywhere; nothing before
2025-01 except LT-15m. OHLCV reference: 1m/1s raw NQ back to 2021/2023 —
already sufficient for any LS/LT window.

## Gaps vs target → prioritized export list (Drew's TV dumps)

1. **LS 1m + LS 15m, 2021-01-17 → 2025-01-01** — HIGHEST VALUE: lets LSTB
   itself (the production strategy) be tested across the 2021 melt-up, 2022
   bear, 2023-24 recovery. Everything LS-based is currently 2025+ only.
   (Start = 1s OHLCV wall, per Drew 2026-07-14 — all backfills restricted to
   1s coverage to keep exports single-chunk.)
2. **Refresh all current series to today** (LS 1m/3m from mid-June/May;
   LT 1m/3m same) — needed anyway for live-vs-backtest audits.
3. **LS 3m backfill 2021-01-17 → 2025-01** — cascade/multi-TF studies (L2).
4. **LS + LT 1h and 4h, 2021-01-17 → now** — few bars, cheap exports, opens the
   slow-regime dimension we've never had.
5. **LS 5m 2021-01-17 → now** — completes the ladder (optional until L-studies
   justify it).
6. **LT 1m/3m backfill 2021-2024** — LARGE exports; only if level-interaction
   studies (L4) earn it.
7. ES mirrors (LS all TFs) — only after NQ program proves out.

## Automation

- **Deep history**: TV websocket paging walls out (~20-45d at 1m per the
  2026-05-28 probe); Drew's strategy-dump→CSV flow is the reliable path for
  backfill. One-time cost per series.
- **Keep-current**: extend data-service to archive sealed LS/LT states for
  ALL subscribed TFs (it already runs the studies for 1m/15m live and the LT
  feed archive powered the sentiment backfill). Nightly append per series →
  never export the same window twice. Design note: one chart session per TF
  on the existing WebSocket (one-series-per-session limit, learned 2026-07-12).
