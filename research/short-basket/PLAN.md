# Short-basket replication program

Goal: rebuild GammaLab's "top-20 most-shorted" basket from primary FINRA data,
validate the screen-positive signal (beta-adjusted basket excess return → fwd
index returns, IC +0.145 p=0.02 at H=3 on their 1-yr series — see
`research/gammalab-parity/results.md` addendum 3) on 6 years of history, and
test it as a conditioner on the existing book.

## Data

- **FINRA consolidated short interest** (PRIMARY, free, no auth):
  `api.finra.org/data/group/otcMarket/name/consolidatedShortInterest`,
  bi-monthly settlement dates 2020-04-15 → present. Fetcher:
  `backtest-engine/scripts/fetch-finra-short-interest.py` →
  `backtest-engine/data/shortinterest/finra/si_YYYY-MM-DD.csv`
  (non-OTC rows: NYSE / NNM / SC / AMEX / ARCA / BZX; ~9-13k rows/date).
  Fields: shares short, prior, change%, ADV, days-to-cover, market class.
- **Constituent daily OHLCV**: TV pipeline (`fetch-macro-daily.js` pattern) per
  ticker once constituents are known. TV also fallback for basket-like index
  tickers if needed (Drew, 2026-08-12) — not needed so far.
- **GammaLab basket series** (`data/gammalab/short_basket_daily.csv`,
  2025-08-14 → present): ground truth for replication parity over the overlap.
- Later if needed: SEC companyfacts for shares outstanding (SI% of shares
  ranking); cheap delisted-inclusive EOD vendor if survivorship bias proves
  material (purchase policy allows PoC-scale buys).

## Honesty traps (design rules)

1. **Publication lag.** SI for settlement date D is DISSEMINATED ~7-9 business
   days later. Basket rebalance must take effect on the publication date, not
   D. If GammaLab rebalances on settlement date, their index has construction
   lookahead — a divergence source to expect in parity checks. Publication
   dates: FINRA publishes a dissemination schedule; approximate with D+9
   business days until exact calendar is sourced.
2. **Survivorship.** Heavily-shorted names delist/get acquired at above-average
   rates. TV may not serve delisted tickers' history. Quantify: count top-20
   constituents whose TV history is missing/ends early; if material, buy
   delisted-inclusive EOD data before trusting long-history results.
   The 2025-08→now GammaLab overlap is the calibration: if our replica tracks
   their series closely there, construction is right.

## Build steps

1. Fetch FINRA archive (RUNNING 2026-08-12).
2. Ranking experiments per settlement date, universe = NYSE+NNM+SC+AMEX common
   stock (drop ARCA/BZX ~ETFs; name-filter ETF/ETN/ADR/warrant/unit/pfd),
   liquidity + min-ADV + min-price screens:
   (a) rank by days-to-cover; (b) rank by absolute shares short;
   (c) later: SI% of shares outstanding via SEC.
   Pick whichever top-20 best reproduces GammaLab's basket over the overlap.
3. Fetch constituent daily bars via TV for all names ever in any top-20.
4. Construct SI-weighted + equal-weighted indices, publication-lagged
   rebalance. Parity vs GammaLab series (level corr, return corr).
5. Signal test on full history: excess1 (basket ret − beta×SPY, rolling OOS
   beta) → fwd SPY/NQ/ES at H∈{1,3,5}; circular-shift placebo; split-year
   stability; ex-tariff-regime robustness per house convention.
6. If it survives: conditioner overlay on book sleeves (PCC/Monday/gap-fade
   cadence — signal known EOD, gates or sizes next-day exposure), 1s-honest
   sims via the engine for any traded implementation.

## Status log

- 2026-08-12: FINRA API probed (unauth OK, 5000/page, record-total header,
  data floor 2020-04-15). Fetcher written + full 2020-04→2026-08 pull running.
