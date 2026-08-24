# Repo audit: existing assets for the pattern engine (2026-08-18)

Graded against `schema/pattern-event.schema.json` (v0 PatternEvent).

## 1. Existing structure / pattern detection code

### 1a. Reuse — the good one
**`shared/strategies/ict-mtf-sweep/timeframe-analyzer.js`** (804 L) — the only genuinely
**incremental, O(1)-per-candle, causally-correct** structure engine in the repo. One instance
per timeframe; `processCandle(candle)` → `{ newSwings, structureShift, chochEvent, bosEvent,
newFVGs, newOBs, filledRejections, trend }`.
- Swing confirmation correct (`_detectNewSwings`, L173-190): inspects `checkIdx = buf.length-1-lb`
  → swing emitted exactly `lb` bars after its own bar. No lookahead.
- Gap vs schema: swing carries `timestamp` but no `confirmedAt` (1-line add).
- Also FVG scan (`_scanFVG` L526), Order Block (`_detectOB` L588), impulse ranges,
  expiry/mitigation (`_expireAndFill` L693), bounded buffers. Siblings: `equal-level-detector.js`,
  `liquidity-pool-tracker.js`, `range-detector.js`, `killzone-filter.js`, `setup-tracker.js`.
- Used only by `ict-mtf-sweep/index.js`; not registered in the live strategy factory.

**`shared/strategies/patterns/`** (18 files + `index.js`) — candlestick registry, uniform static
interface `{ name, side, candlesRequired, detect(current, previous, context), getEntryPrice,
getStopPrice, getStrength, filters, exits, metrics }`. Covers engulfing (2), FVG (2), swing sweep
(2), pin bar (2), hammer, shooting star, inside/outside bar, doji, 3 soldiers/crows, morning/evening
star. Stateless & bar-local → trivially streaming. `metrics` all zeros. Only consumer:
`backtest-engine/scripts/micro-structure-pattern-scan.js` (batch harness over CandleAggregator,
`--timeframe 1m|3m|5m|15m`). `swing-low-sweep.js:findSwingLows` rescans whole array, no confirmedAt.
**Missing entirely: all chart patterns** (flag, pennant, wedge, triangle, double top/bottom, H&S,
cup&handle, rectangle) — zero hits in `shared/`. Build fresh.

### 1b. Named indicator files — status

| File | Does | API | Streaming? | Pivot lag / confirmedAt | Live use |
|---|---|---|---|---|---|
| `shared/indicators/market-structure.js` (398L) | HH/HL vs LH/LL, structure breaks, fib | `identifySwings` L39, `analyzeTrendStructure` L83, `detectStructureBreak` L143, `analyzeStructure` L253 | Batch | lb=5 symmetric, correct lag, no confirmedAt | AI feature-aggregators only |
| `shared/indicators/ict-structure-analyzer.js` (386L) | CHoCH+MSS+OB → bias | `analyzeStructure(candles, t)` L81 | Batch | inherits | ict-ob/ict-smc strategies — NOT in factory (dead) |
| `shared/indicators/ict/{choch,mss,order-block}-detector.js` | as named | `identifySwings` duplicated verbatim | Batch | lb 5, no confirmedAt | dead |
| `shared/indicators/range-detector.js` (262L) | S/R box + ATR width + touches | `detectRange(candles, swings)` L32 | Batch lb=50 | external swings | no importers |
| `shared/indicators/trend-line-detector.js` (193L) | OLS through last N swings, channel, break | `detectTrendLines` L27 | Batch | uses swing.index | no importers |
| `shared/indicators/structural-levels.js` (421L) | MTF S/R with own HTF aggregation | `processCandles(candles, tf)` L44 | Batch | `detectedAt: Date.now()` (wall-clock — useless in backtest) | no importers |
| `shared/indicators/key-levels.js` (516L) | PDH/PDL/PDC, ON H/L, OR, weekly | `processCandles` L109; real ET session logic `getSessionType` L83 | Batch | n/a | no importers |
| `shared/indicators/dynamic-levels.js` (274L) | VWAP+bands, EMAs, BB | `update(candle, isNewSession)` L41 | **STREAMING** | n/a | level-bounce.js |
| `shared/indicators/squeeze-momentum.js` (320L) | TTM squeeze | `calculate(candles, prevMom)` L265 | Batch window | n/a | gex-recoil, engine |
| `shared/indicators/momentum-divergence.js` (301L) | RSI/MACD divergence | `detectDivergence` L181, `findPriceSwings` L127 | Batch | correct lag, no confirmedAt | no importers |
| `shared/indicators/fibonacci-levels.js` (508L) | fib from swings | `detectSwings` L70 | Batch | **rolling max/min window — repaints; NOT a pivot detector** | no importers |
| `shared/indicators/volume-profile.js` (509L) | POC/VA/HVN/LVN | `addCandle` L58 incremental; `SessionVolumeProfiles` L420 | **STREAMING** | n/a | dead ICT strategies |
| `shared/indicators/swing-pivots.pine` | TV visualizer | — | — | `lookahead_on` — repaints | display only |

### 1c. Other pattern-ish code
`shared/strategies/ict-smc/pattern-detector.js` (`MWPatternDetector` M/W shapes); strategy-level
swing detection rolled per strategy in `imbalance-detector.js`, `impulse-fvg.js`, `sweep-reversal.js`,
`swing-reversal.js`, `price-action-exhaustion.js`, `micro-structure-scalper.js`,
`ohlcv-mtf-rejection.js`; `backtest-engine/src/analysis/{level-sweep,liquidity-sweep}-detector.js`,
`sweep-labeler.js`, `volume-spike-detector.js`.

### 1d. The one place `confirmedAt` is done right
`backtest-engine/scripts/precompute-swing-pivots.js` + `src/data-loaders/swing-pivot-loader.js` —
9/9 fractals → `backtest-engine/research/swing-pivots/NQ_swings_1m_9_9.csv` (~36k pivots,
2024-10→2026-04; cols `ts_event,type,price,confirmed_at,symbol`). Loader `getActiveSwings(ts, type,
recencyMs)` filters `confirmedAt > ts`. **Reference JS pattern for pivot knowability.**
Python equivalent: `greenfield/explore/C1_common.py:244 fractal_swings(bh, bl, N)` →
`(bar_idx, 'H'|'L', price, confirm_idx=j+N)`.

## 2. Candle aggregation infrastructure
- **`shared/utils/candle-aggregator.js`** (490L): `aggregate(candles, tf)` batch;
  `initIncremental(tf, key)` L34 → `addCandleIncremental(candle, tf, key)` L58 O(1), returns array
  incl. still-forming period. Supports 15s..1d.
- ⚠️ **`getPeriodStart(ts, intervalMinutes)` L209 is rolling wall-clock floor-aligned within the
  hour using the process LOCAL timezone** (`getMinutes/getHours`). No session anchoring; 4h =
  `floor(localHour/4)*4`; 1d = local midnight. **Schema's ET session-anchored requirement NOT met —
  build fresh or wrap.** Bars stamped at OPEN (`timestamp = periodStart`) — consistent with KNOWABILITY.
- Live: `data-service/src/candle-manager.js` (`processQuote` L59; two emission semantics
  documented L67-105: completed-bar feeds publish immediately, forming-bar feeds publish prev bar on
  next-bar arrival) → `CHANNELS.CANDLE_CLOSE`. `signal-generator/src/utils/candle-buffer.js` ring
  buffer. `multi-strategy-engine.js handleCandleClose` L572 → per-strategy aggregator
  (`StrategyRunner` L44-49); `getAggregatedCandle` L642 delivers HTF bar on the close of its last 1m
  constituent (correct). Only ONE evalTimeframe per strategy — **no multi-TF fan-out exists**.
- Backtest: `cli.js:79 --timeframe`; `backtest-engine.js:636 aggregatedCandles`; L641 separate
  hard-coded 15m `fvgCandles` (KNOWABILITY incident #4 lived here); data bundle L752-770 passes
  `candles`, `originalCandles` (1m), `fvgCandles`. ICT-SMC CLI has `--structure-timeframe` /
  `--entry-timeframe` (L1026-1036) and `--active-timeframes` (L1611) — MTF-option precedent.
- `base-strategy.js`: only `evaluateSignal(candle, prevCandle, marketData, options)`; no onCandle /
  multi-TF hook — HTF context arrives via `marketData`.

## 3. Backtest / research plumbing to reuse
- `csv-loader.js:523 filterPrimaryContract` (per-hour highest-volume symbol; does NOT drop
  calendar spreads — greenfield Python version does); copy-pasted ~15×.
- `SecondDataProvider` (`csv-loader.js:581`): byte-offset index by minute → `getSecondsForMinute`
  L772, LRU 100 minutes. `NQ_ohlcv_1s.csv` 8.3GB + `.index.json` 99MB.
- **Greenfield caches:** `greenfield/explore/cache/NQ_1m_primary.csv` (160MB, 1,934,369 bars
  2020-12-27→2026-06-15), `ES_1m_primary.csv`, `NQ_daily_sessions.csv` (per-day session/ATR/roll);
  `cache_nq_rth_1s.{csv,npz}` + `.days.json`, `cache_nq_euopen_1s.csv` (B12-01 seeks RTH minutes via
  index); `R3-dense.npz`, `R3-baselines.npz`; registries `C1-levels-registry.csv`, `C1-touches.csv.gz`
  (3.2M), `C2-registry-{NQ,ES}.csv`, `C2-pivot-registry-NQ-{5,15}m.csv`.
- **1s sim kernel: `greenfield/explore/B12_sim.py`** — canonical honest fill contract (limit fills at
  exactly limit on first 1s bar at/after placement; market `open±0.25`; stop slip 0.5; same-bar
  stop+target ⇒ STOP; target can't fill on entry bar; $5 RT, $20/pt). Reuse verbatim.
- JS 1s precompute convention: `research/gex-touch-confirm/06-precompute-s1-vwap.js` (readline
  stream, `--start/--end/--out`, 1m-keyed feature CSV).
- Convention: greenfield = Python/numpy/pandas, `X-NN-name.py` + `X_common.py` + `out-X-NN.txt` +
  one `X-topic.md`. Follow it for research; JS for anything that must go live.
- Placebo harness: `C1_common.py:207 rand_offset(level_id, seed, lo, hi)` (deterministic CRC32 twin,
  3 seeds) + round-grid class; `C2_common.py:115 placebo_slope` + flat-band + shuffle/randsign;
  `G1-placebo.py`, `G1-robustness.py`, `G1-yoy-breakdown.py`; `A2-05-candidate-checks.py`.
  **Hard lessons:** side-matched placebos mandatory for one-sided families; tiling (non-overlapping
  windows) mandatory.

## 4. Live plug-in points
- `strategy-factory.js` plain switch (~25 strategies; none ICT/pattern). Adding = 3 switch arms.
- `multi-strategy-engine.js`: `StrategyRunner` L23, `ProductState` L71 (1m buffer, gex, lt, iv, ls);
  `handleCandleClose` L572 single ingress; `checkStrategyDataReady` ~L560 + `DATA_READY` handshake.
- Channels `shared/index.js:16-115`; precedent `LS_STATUS_15M` (separate channel so a 15m state feed
  is never mistaken for a 1m trigger). Natural fit: `PATTERN_EVENTS: 'pattern.events'` (+
  `PATTERN_STATE` snapshot), publisher in data-service next to candle-manager; engine caches on
  `ProductState`, passes via `marketData.patterns`. Keep per-TF streams separable.

## 5. Prior reports (priors)
- **A1** (`greenfield/explore/A1-price-structure.md`): survivors = vol clustering (15m range lag-1
  +0.61, 6/6yr), gap fill monotone 96%→24% by |gap|/ATR, low ON-range → both extremes broken 38% vs
  16%, one RTH extreme final by 10:30 on 79%; dead = round numbers, return autocorr, volume-spike
  direction, ON-break follow-through, NR7 compression→expansion (inverted), gap direction.
- **A2**: LT follow-through damping only survivor (non-directional); GEX bounce/break ≡ placebo.
- **C1** (most important prior): classic S/R placebo-equivalent (80.8% of RTH range within 5pt of a
  level); swing-fractal +0.9pp = side-matching artifact; survivors = OR bounce-DEFICIT (−2.4pp),
  compression-box persistence (~0pt). **Dead & directly relevant: springs/failed breakouts ("generic
  1m price action, fully present at random prices"), double tests, confluence, held-vs-broken
  discrimination.**
- **C2**: channels = sloped levels = placebo; channel-break continuation p≈0.61 identical in
  flat-band control (generic post-vol-expansion drift); clean channel only ~26% of time. §0 lookahead
  self-audit structure is the template for the new engine's design doc.

## Reuse vs build-fresh
**Reuse:** candle-aggregator incremental path (replace `getPeriodStart` with ET session-anchored);
`filterPrimaryContract` + `SecondDataProvider`; swing-pivot `confirmedAt` convention; greenfield
caches; `B12_sim.py`; `C1_common.py`/`C2_common.py` (fractal_swings, agg_bars, touch_events,
rand_offset, placebo_slope, tiling, side-matching); `shared/strategies/patterns/*` (+confirmedAt);
`timeframe-analyzer.js` as streaming template.
**Build fresh:** ET session-anchored MTF fan-out; entire chart-pattern family; PatternEvent state
machine + instanceId lifecycle; `PATTERN_EVENTS` publisher; `parents` nesting link.
**Do not resurrect:** `fibonacci-levels.js detectSwings`; `swing-pivots.pine`; `structural-levels.js`
Date.now(); the filterPrimaryContract clones; any design leaning on level confluence / "respected
levels" / springs / double tests / channel-rail respect as edge.
