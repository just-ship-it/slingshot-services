# LT Levels Extraction — TradingView → CSV → analysis-ready

A workflow for capturing lower-timeframe (1m / 3m / 5m) LT indicator levels
from TradingView when the indicator is closed-source. The Pine v6 strategy
embeds the LT levels in trade comments; you export the trade list as CSV;
the parser converts it to a clean LT levels CSV in raw-contract price space.

## Files

- **`lt-dumper.pine`** — Pine v6 strategy. Add to chart, link the 5 LT plots
  via Settings → Inputs, run.
- **`parse-lt-export.js`** — Node parser that converts TV's exported "List of
  Trades" CSV into our standard LT format and translates back-adjusted
  prices to raw-contract space using `data/ohlcv/nq/NQ_rollover_log.csv`.

## End-to-end workflow

### 1. Pine setup (one-time per indicator)

1. Open TradingView, load NQ chart at desired timeframe (5m recommended for
   first run — best ratio of resolution to chunking effort).
2. Add your LT indicator to the chart.
3. Open the Pine Editor, paste in `lt-dumper.pine`, click "Add to Chart".
4. Open the strategy's **Settings → Inputs**.
5. For each "LT Level N" input, click and pick the matching plot from the
   LT indicator (`LT 1`, `LT 2`, etc. — names depend on the indicator).
6. For "LT Sentiment", pick the indicator's sentiment plot if numeric;
   otherwise leave as `close` and the parser will ignore it.
7. **Settings → Properties**: confirm Pyramiding = 0.

### 2. Verify the strategy is dumping comments

After "Add to Chart", open **Strategy Tester → List of Trades**. You should
see one trade per bar with entry comments like:

```
1=21500.50|2=21450.25|3=21380.75|4=21320.00|5=21275.50|S=1.00|T=20250113T1430
```

If you don't see comments, the most likely issue is that the LT indicator
draws levels via `line.new()` instead of `plot()` — closed-source indicators
that only draw lines/labels (no `plot()`) cannot be referenced via
`input.source()`. Workarounds:

- Ask the indicator author to publish a version that also `plot`s the levels
  (often they will, given a reasonable case).
- Re-implement the LT logic from scratch if you know the algorithm.
- Use TradingView alerts (with `alert()` calls per bar) and a webhook
  receiver — async but works for closed-source `line.new()` indicators.

### 3. Chunked backtest runs

TradingView caps strategies at ~9000 orders per backtest. Each bar generates
~2 orders, so plan ~4500 bars per run. Use **Settings → Properties → Date
Range** to set `From` and `To`, then export.

| Timeframe | Bars/day (24h sessions) | Days/run | Runs/year |
|---|---:|---:|---:|
| 1m | ~1380 | ~3 | ~85 |
| 3m | ~460 | ~9 | ~28 |
| 5m | ~280 | ~16 | ~16 |
| 15m | ~95 | ~47 | ~5 |

**Recommended starting point:** 5m × 1 year = 16 runs of ~3 weeks each.

### 4. Export each chunk

For each chunk:
1. Set `From / To` in strategy Properties.
2. Wait for the strategy to recompute.
3. **Strategy Tester → List of Trades → Export → CSV**.
4. Save as `tv-NQ1!-{TF}-{YYYY-MM-DD}-to-{YYYY-MM-DD}.csv` in
   `research/lt-extraction/exports/`.

### 5. Parse and translate

```bash
mkdir -p research/lt-extraction/output
node research/lt-extraction/parse-lt-export.js \
  --in research/lt-extraction/exports/tv-NQ1!-5m-2025-01-13-to-2025-02-02.csv \
  --in research/lt-extraction/exports/tv-NQ1!-5m-2025-02-02-to-2025-02-23.csv \
  --in ... \
  --symbol "NQ1!" \
  --out research/lt-extraction/output/nq_lt_5m_raw.csv
```

The parser:
- Pulls each entry's comment, extracts `1=…|2=…|…|5=…|S=…|T=YYYYMMDDTHHMM`.
- Uses the embedded `T=` timestamp (UTC) for indexing (more reliable than
  TV's exported date column, which varies in format).
- For continuous symbols (NQ1!), adds the cumulative back-adjustment delta
  computed from `data/ohlcv/nq/NQ_rollover_log.csv` to translate to
  raw-contract price space.
- Dedupes on the boundary bar between chunks.
- Writes a CSV with: `timestamp_iso, unix_ms, sentiment_raw, level_1..5,
  source_symbol, was_backadjusted, raw_contract`.

### 6. Sanity check

The parser prints first 3 and last 3 rows. Spot-check:
- Are the timestamps reasonable (RTH-heavy bars)?
- Are the `level_1..5` prices in NQ range (~20k–25k for 2025)?
- Does `raw_contract` change across rollovers (NQH5 → NQM5 → NQU5 → …)?

## Back-adjustment translation — why it matters

TradingView's `NQ1!` is a continuous front-month series. At each contract
roll, TV shifts HISTORICAL prices UP by the spread (the most recent
contract is the anchor; older bars are pushed up to align with current
prices). So:

- **Continuous price at time T** = raw price at T + sum(spreads of rolls AFTER T)
- **Raw price at time T** = continuous price at T − sum(spreads of rolls AFTER T)

Example using the rollover log:

```
2025-03-18: NQH5 → NQM5, spread +208.5 pts
```

A continuous price of `21,450` on 2025-02-15 (before this roll) is actually
`21,450 − 208.5 − (any rolls after this) = 21,241.5−` in raw NQH5 space.

Our GEX levels are computed in raw-contract space (per CLAUDE.md's mandatory
"raw contracts" rule). LT levels from `NQ1!` are in continuous space, so
they MUST be translated before they can be compared.

## Alternative: avoid back-adjustment entirely

Run the Pine strategy on each specific front-month contract symbol directly
(e.g., `CME_MINI:NQM5` for March-13 → June-13 2025 window). No translation
needed since prices are raw. But you have to flip the chart symbol for
each contract — about 4 flips/year on quarterly futures.

`--symbol NQM5` to the parser will skip the back-adjustment translation
and keep prices as-is.

## Quality checks you'll want post-extraction

Once `nq_lt_5m_raw.csv` is built, validate it against the existing 15m LT
data (`data/liquidity/nq/NQ_liquidity_levels.csv`):

1. Sample 20 random 15m boundaries.
2. Average the 1m/3m/5m LT values within each 15m window.
3. Compare to the 15m LT value at the bucket boundary.
4. They should be close (5m → 15m is just 3-bar averaging).

Significant divergence would indicate an LT-indicator setting mismatch
(different lookback period, different Fibonacci levels, etc.) between the
indicator on your chart and whatever feed produced the existing 15m CSV.

## What this enables

With per-bar 1m / 3m / 5m LT data in raw-contract space, we can extend
Track E (`research/track-e-gex-lt-interactions.js`) to:

- Detect GEX–LT crossovers at 1m–5m resolution instead of 15m.
- Measure how the crossover materializes — gradual drift versus sudden
  step-change — and whether the directional bias arrives before, at, or
  after the crossover instant.
- Test crossover signals at the LT cadence (closer to GEX update cadence
  for cbbo data) rather than mismatched 15m–vs–1m.

These should both improve the timing of the +5/−3pt directional signal
identified at 15m and reduce the number of "false triggers" caused by
slow-moving 15m LT readings lagging fast price action.
