# DeepDiveStocks Weekly Chat — Prediction Accuracy Study

**Date:** 2026-07-06 | **Corpus:** 150 Weekly Chat PDFs (2023-05-01 → 2026-07-05), 148 scoreable after dedup/data-cutoff | **Author's cadence:** Sunday evening, covering the following Mon–Fri.

## Pipeline

1. `fetch-weekly-chats.py` — IMAP pull of PDFs from justin@deepdivestocks.com → `pdfs/`
2. `pdftotext -layout` → `text/`
3. 10 parallel LLM agents extracted per-report structure → `extracted/batch-*.json`:
   direction call (bullish/bearish/neutral/mixed + confidence + conditions) and explicit numeric price levels (value, instrument space, role).
4. `build-weekly-ohlc.py` — weekly OHLC for QQQ/SPY (ETF 1m) and NQ/ES (raw futures, per-hour volume-primary contract, Monday-contract price space per week).
5. `score-reports.py` — direction vs next-week return; level touches vs distance-matched empirical base rates → `results/*.csv`.

Call mix: 58 bullish / 84 bearish / 8 neutral. 110 numeric levels extracted (95 mappable to a price series); levels are concentrated in late-2024→2026 — the 2023–mid-2024 era is almost entirely qualitative (VoEx/BUPO/gamma narrative).

## Finding 1 — Direction calls: no tradeable directional edge

Scored on QQQ Monday-open → Friday-close (the actionable interpretation of a Sunday report):

| Subset | n | Accuracy | Up-week base | p vs 50% |
|---|---|---|---|---|
| All directional | 137 | 54.0% | 62.8% | 0.39 |
| Bullish calls | 57 | 70.2% | — | 0.003 |
| Bearish calls | 80 | 42.5% | — | 0.22 |
| High-confidence | 51 | **47.1%** | 66.7% | 0.78 |

- Overall accuracy (54%) is **below** the always-bullish baseline (62.8%) because the author is structurally bearish (61% of calls) in an up-drifting market.
- Bullish calls look impressive (70%) but weeks he calls bullish are up 70% vs 57.5% for bearish-call weeks — a separation of only ~13pt, Fisher one-sided **p = 0.091** (not significant). Most of the 70% is market drift.
- **Shorting his bearish calls loses money**: bearish-call weeks average **+0.53%** (bullish-call weeks +0.64% — nearly identical mean).
- **High-confidence calls are the worst subset** (47–51% across all scoring variants, negative avg return in the called direction). Emphatic calls (e.g. the 2025-04-06 "imminent, promising and substantial" downside call directly before the April rally) mildly anti-predict.
- **Accuracy decays monotonically**: 2023 62.5% → 2024 58.0% → 2025 48.6% → 2026 **38.9%** (15 of 18 calls bearish in a 78%-up-week year). Whatever edge existed in 2023 is gone or inverted.

Same conclusions hold on SPY and on Friday→Friday returns (bearish never beats a coin, bullish ≈ drift).

## Finding 2 — Bearish calls ARE a volatility signal (the real alpha)

| Call | avg \|weekly ret\| | weeks < −2% |
|---|---|---|
| Bullish (n=57) | 1.68% | 11% |
| Bearish (n=80) | **2.64%** | **26%** |

t = 3.15, **p ≈ 0.002**. His "bearish" label doesn't predict direction, but it robustly predicts **range expansion and left-tail risk** — consistent with VoEx being an options-exposure/vol construct. This is the actionable output: a weekly vol-regime flag, complementary to the intraday QQQ vol-regime filter already researched for the FCFS book (`research/vix-vol-es/`, PF 1.77→2.24).

## Finding 3 — Liquidity levels: real but modest magnet effect; they are NOT barriers

95 mappable levels scored against the matching series (ES/NQ raw futures, SPY/QQQ ETF), touch = level within the week's high–low range, benchmarked to the empirical P(touch | distance-from-spot) from all 2023–2026 weeks:

- **1-week: 33/95 hit (34.7%) vs 25.6 expected (26.9%) — z = 2.15, p ≈ 0.03.** 4-week: 52.6% vs 47.0%.
- The edge is concentrated in **above-spot levels** (17/30 = 57% hit vs 39% expected) and specifically **ceilings** (1w: 9/16 vs 5.6 expected; 4w: 14/16 hit). Downside targets/floors hit roughly at base rate — bearish price targets are the weakest element, matching Finding 1.
- **When a quoted ceiling/floor is reached, it holds only 29% of the time** (9/31 respected by weekly close). So the levels have modest value as *magnets/targets*, not as *support-resistance barriers*.
- Distance buckets (1w): 2–4% away hit 26% vs 13% base (~2× base); ≥4% away (mostly crash targets) 6.5% vs 1.8%.

Caveat: n is small, level extraction is LLM-based from prose, and SPX-vs-ES price-space ambiguity was resolved by ±12% magnitude matching (both spaces usually pass; futures assumed primary since LT levels are futures-derived).

## Bottom line

1. **Do not use the Weekly Chat as a directional signal.** Overall it underperforms always-long; its bearish majority is wrong more often than right and shorting it loses. Recent (2025–26) accuracy is inverted enough that if anything, high-confidence bearishness is a weak contrarian tell.
2. **The bearish/bullish label is a legitimate weekly VOL flag** (p≈0.002): bearish weeks realize ~1.6× the absolute move and 2.4× the tail frequency. Worth testing as a Sunday-known meta-filter input for the FCFS book (e.g., per-strategy gating like the vol-regime work, or sizing down long-hold styles on "bearish" weeks).
3. **Above-spot LT/LDPM ceilings act as price magnets** (~2× base-rate touch odds at 2–4% distance, 14/16 touched within 4 weeks) — consistent with the system's existing LT-level edge — but do not expect them to hold as resistance once reached (71% blow-through).

## Files

- `results/direction_scored.csv` — per-report call, confidence, next-week QQQ/SPY returns
- `results/levels_scored.csv` — per-level distance, series, 1w/4w touch, respected flag
- `weekly/*.csv` — weekly OHLC series used (futures = Monday-primary-contract price space)
- `extracted/batch-*.json` — structured extraction (includes supporting quotes for audit)

Known corpus quirks (from extraction agents): 2025-03-02/03 duplicate resend (deduped); ~6 admin-only issues (patch notes / registration weeks) labeled neutral; occasional misdated internal headers (filename send-date used as truth); 2026-06-28 truncated "data hiccup" issue.
