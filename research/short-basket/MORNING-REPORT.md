# Short-Basket Replication — Overnight Report

**2026-08-13, overnight session** · `research/short-basket/` · Drew asked: replicate GammaLab's
most-shorted basket from free primary data, validate the screen-positive signal on deep history,
assess book value.

## TL;DR

**The infrastructure succeeded completely; the signal mostly regressed.** We now own a
six-year, survivorship-free, point-in-time short-interest basket pipeline built entirely from
free data (FINRA + SEC + TV/Yahoo). On it, the GammaLab screen-positive (IC +0.145, p=0.02
on their 1-year series) shrinks to **IC +0.03–0.04, p≈0.14–0.21 over six years** — right
sign in 5–6 of 7 years, monotone terciles, but far below standalone tradability and below
our conditioner bar. The 1-year vendor result was most plausibly the same weak effect
plus favorable noise (their IC ±0.073 SE vs our ±0.026). Not dead — but weak.

## What was built (all reusable)

| Asset | Detail |
|---|---|
| FINRA SI archive | 152 settlement dates, 2020-04 → 2026-07, all listed markets, `data/shortinterest/finra/`. Fetcher survives API quirks (204-on-holiday, WAF). |
| SEC shares-outstanding cache | ~1,500 tickers, point-in-time by filing date, `data/shortinterest/sec/` |
| Constituent prices | 974 constituents; **zero missing** on the SI% variant (TV primary + Yahoo fallback rescued every delisted name — BBBY, HTZ, ACB...) |
| Basket builder | Top-40 by SI% (SEC denominator) + top-40 by days-to-cover (pure FINRA), publication-lagged (settlement + 9 bdays), liquidity/price/mcap screens |
| Indices | SI%-weighted + equal-weighted, drifting weights, delisting-safe |

Basket history passes qualitative validation everywhere it can be checked: GME 86→108% SI
through 2020, BBBY-cohort collapse after the Jan-2021 squeeze, SMCI topping 2025 lists.

## Parity vs GammaLab (their 1 year)

Daily-return correlation of our replica vs their index: **0.73 equal-weight**, 0.60 SI-weighted.
Same object, imperfect construction match (they likely rank on float, we rank on shares
outstanding; screens unknown; rebalance timing differs).

## The signal, honestly measured

Signal = basket 1-day return minus rolling-60d-beta × SPY (beta past-only). Forward
close-to-close returns. n≈1,519 days.

| Target | H | IC | p (circular shift) | Terciles lo→hi |
|---|---|---|---|---|
| SPY | 1 | +0.033 | 0.21 | +0.030% → +0.055% |
| SPY | 3 | +0.039 | 0.14 | +0.145% → +0.262% |
| SPY | 5 | +0.021 | 0.42 | +0.235% → +0.375% |
| NQ | 3 | +0.027 | 0.30 | +0.137% → +0.297% |

Per-year (SPY H=1): 2020 +0.01, 2021 −0.01, 2022 +0.05, 2023 −0.00, 2024 +0.06,
2025 +0.06, 2026 +0.06. Direction is persistent; magnitude is small.

**Reconciling with the +0.145 screen:** re-testing GammaLab's own series with the honest
rolling beta still gives +0.12–0.18 — so their *index* carries more measured signal than our
replica on the same window (construction gap), **but** their n=186 gives SE ±0.073: their
result is statistically compatible with a true IC near our six-year +0.04. Classic
winner's-curse resolution — exactly what this replication was for.

## Data-quality traps discovered (logged for reuse)

1. **FINRA API returns 204 (empty) for holiday settlement dates** — was misread as rate
   limiting; cost ~2h of debugging. Fixed with calendar walk-back.
2. **SEC ticker-reuse**: the ticker→CIK map is current-day, so dead tickers resolve to
   today's owners (GOLD → Gold.com, not Barrick; BBBY → renamed Overstock). Dead tickers
   are precisely the shorted-stock population. Guards added (ADV vs shares sanity, SI% cap);
   residual denominator noise remains and likely explains part of the parity gap.
3. **TV lacks delisted tickers** — Yahoo chart API covers them completely (17 names).
4. Publication-lag rule enforced: SI usable only from settlement + 9 business days. If
   GammaLab rebalances on settlement date, their index construction is ~9 days ahead of
   what live trading could know.

## Verdict & options

The risk-appetite-continuation effect probably exists but at IC ~0.03–0.05 — **too weak
for a standalone strategy, below our conditioner evidence bar** (PCC-class effects came in
at p≈0.003). Recommended: **park the signal, keep the pipeline.**

Options if you want one more push:
1. **Float-based ranking** — the one construction upgrade with a clear mechanism (their
   basket outperforms ours on signal carry; float data is the main known difference). Needs
   a cheap point-in-time float/reference-data source — purchase-policy compatible PoC.
2. **Ensemble conditioner test** — feed the weak tilt into the internals/breadth conditioner
   family and test marginal value on book sleeves; weak-but-uncorrelated inputs can still
   earn a seat, but expectations should be low.
3. **Drop it** — the pipeline stays warm for any future SI-based idea either way (bi-monthly
   FINRA pulls are one command).

DTC-ranked variant (pure-FINRA, immune to ticker reuse) finishes pricing this morning —
will be run as a robustness check; not expected to change the verdict.
