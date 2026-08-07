# Backtest Engine — New Strategy Reference (for JV-ICT implementation)

Compiled 2026-07-22 from engine source. All paths absolute from repo root. Reference simple strategies: `shared/strategies/gap-fill.js`, `shared/strategies/daily-level-sweep.js`.

## 1. Strategy contract — `shared/strategies/base-strategy.js`

Extend `BaseStrategy` (`shared/strategies/base-strategy.js:8`). Import: `import { BaseStrategy } from './base-strategy.js';`

**Required method** (only one is mandatory):
- `evaluateSignal(candle, prevCandle, marketData, options)` → returns a signal object or `null`. Base throws if not overridden (`base-strategy.js:35`). Called once per **closed** target-timeframe candle.

**Optional lifecycle / hooks:**
- `static getDataRequirements()` (`base-strategy.js:16`) — data-source manifest; `null` = config defaults. Shape (see `gap-fill.js:30`, `es-stop-hunt.js:22`, `price-action-exhaustion.js:48`): `{ candles, gex, lt, tradier, ivSkew, secondData }`. Each is `false` or an object. Set `secondData: true` to get 1s bars injected (see §4).
- `reset()` — clear state between runs; call `super.reset()` (`gap-fill.js:326`).
- `isSeeded()` (`base-strategy.js:44`) — return false until warm-up done; default `true`.
- `constructor(params)` — merge defaults: `this.params = { ...this.defaultParams, ...params }` (`gap-fill.js:96`).
- Optional `shouldInvalidatePendingOrder(signal, candle, historicalCandles)` — cancels unfilled limit orders (`backtest-engine.js:1181`).
- Helpers provided by base: `toMs()`, `checkCooldown(ts, ms)`, `updateLastSignalTime()`, `validateMarketData()`, `getNestedProperty()`, `calculateRisk()`.

**Candle shape:** `{ timestamp (ms, period START), open, high, low, close, volume, symbol }`.

**Signal object** (canonical, from `gap-fill.js:291`):
```js
{
  strategy: 'GAP_FILL',
  side: 'buy' | 'sell',              // REQUIRED (not 'long'/'short')
  action: 'place_market' | 'place_limit',
  symbol: 'NQ1!',
  price: <entry>,                    // limit price; market fills next bar open-ish
  stop_loss: <price>,                // snake_case (camelCase stopLoss also read)
  take_profit: <price>,              // snake_case (takeProfit also read)
  quantity: 1,
  maxHoldBars: 360,                  // force time-exit
  trailing_trigger: null, trailing_offset: null,
  timestamp: ISOString,
  metadata: { ... }                  // free-form, preserved into trade record
}
```
Simulator reads both snake_case and camelCase for stop/target/trailing/breakeven (`trade-simulator.js:135-160`). Optional per-signal fields honored: `stopPoints`/`targetPoints`, `stopDistance`/`targetDistance` (re-anchor SL/TP on price-improved fills), `timeoutCandles`, `softStopPoints`, `stopCheckMode` ('close' vs wick), `sameCandleFill`, `adverseFlipCancelTs`. Trailing/breakeven/fib/MFE-ratchet configs can be injected by CLI flags onto the signal (`backtest-engine.js:1214-1296`).

## 2. Registration & CLI wiring

No dynamic registry — hardcoded `switch` factory:
1. Import your class near the top of `backtest-engine/src/backtest-engine.js` (imports ~line 65).
2. Add a `case` in `createStrategy(strategyName, params)` — `backtest-engine.js:1816`; gap-fill example at `:1961`.
3. Add the name (and aliases) to the `choices` array of the `--strategy` option in `backtest-engine/src/cli.js:71`, or yargs will reject it.

Entry point `backtest-engine/src/cli.js`. `--strategy-params` / individual flags flow into `params`.

## 3. Multi-timeframe

**The engine delivers ONE timeframe per run** = `--timeframe` (choices `1m,3m,5m,15m,30m,1h,4h,1d` — `cli.js:74`). `evaluateSignal` fires on closes of that TF only. `options.historicalCandles` = last ~50 candles **of that same TF** (`backtest-engine.js:1176`). No automatic multi-TF delivery.

**Higher-TF context is built by the strategy itself**, two patterns:
- **Manual ET-day tracking** (what gap-fill/daily-level-sweep do): watch each 1m candle, detect a new trading day via `America/New_York` `dateKey`, roll your own prev-day high/low etc. See `daily-level-sweep.js:150-156`, `gap-fill.js:148-173`. No separate daily-candle data source is loaded — daily levels are built from the intraday stream.
- **Internal aggregation:** `shared/utils/candle-aggregator.js` `CandleAggregator` supports `1m…1d` (`:11`). `addCandleIncremental(candle, '1h', stateKey)` (O(1), returns array incl. in-progress period, `:53`) or batch `aggregate(candles, '4h')` (`:154`). **Watch look-ahead:** only act on closed higher-TF bars; the engine's own 15m FVG path enforces "only fully-closed 15m bars visible" (`backtest-engine.js:1125-1138`) — mirror that discipline.

Daily bars come only from aggregating the loaded intraday data.

## 4. 1s honesty — SecondDataProvider

`SecondDataProvider` in `backtest-engine/src/data/csv-loader.js:581`, instantiated `backtest-engine.js:523` from `data/ohlcv/<ticker>/<TICKER>_ohlcv_1s[_continuous].csv`.

- 1s data drives **exit/fill precision automatically** whenever present and trades are active (`backtest-engine.js:1044`, `:1457`; `trade-simulator.js:270` `processSecondBars`). Same-candle limit fills use 1s too (`backtest-engine.js:1380`).
- **Disable with `--minute-resolution`** (`cli.js:152`).
- For a strategy to **receive 1s bars in `evaluateSignal`**: `static getDataRequirements(){ return { ..., secondData: true } }` → `marketData.secondCandles` injected per eval (`backtest-engine.js:1202-1206`). Example consumer: `price-action-exhaustion.js:48`.
- Continuous 1m pairs only with continuous 1s (never mixes price spaces) — `backtest-engine.js:505`.

## 5. Positions / scaling — `backtest-engine/src/execution/trade-simulator.js`

- **One trade at a time.** `processSignal` rejects new signals while `activeTrades.size > 0` (`trade-simulator.js:120-124`); engine records `reason: 'position_already_active'` (`backtest-engine.js:1366`). Signals while in-position are **dropped** (no pyramiding, no reversal-on-signal).
- **Quantity > 1 supported** (`:134`, P&L at `:2435`) but single all-or-nothing unit.
- **No partial exits / scale-outs.** A trade exits fully via one `exitTrade(...)` (`:2462`) on stop_loss / take_profit / trailing_stop / time (maxHoldBars) / eod-cutoff. Modeling scale-outs requires simulator changes.
- **capture-signals mode** (`--capture-signals <file>`) bypasses the position gate, always-flat, records every trigger (`backtest-engine.js:1310`, `cli.js:127`) — research only.

## 6. Relevant CLI flags for an honest NQ run (`backtest-engine/src/cli.js`)

- `--ticker NQ` (`:46`), `--start` / `--end` YYYY-MM-DD (`:53`,`:60`), `--timeframe` (`:74`).
- `--raw-contracts` (`:158`) — raw dated contracts instead of back-adjusted continuous. Default off. Pure price-action strategies (fibs/structure from same series) may use continuous per CLAUDE.md.
- `--minute-resolution` (`:152`) — turns OFF 1s exec (default: 1s ON if file present).
- `--eod-cutoff-et "15:45"` (`:296`) — force-flat at ET wall-clock (15:45 = live-honest per memory).
- `--slippage <pts>` (`:88`); `--stop-slippage <pts>` (`:93`); `--commission` (`:82`).
- `--strict-fill` (`:301`) — limit fills require trade-through, not touch.
- Session filters: `--use-session-filter` (`:986`), `--blocked-sessions overnight,premarket,afterhours,rth` (`:991`).
- `--capital` (`:99`), `--output-json`/`--output-csv`, `--verbose`, `--quiet`, `--show-trades`.

**Honest NQ example:**
```
node backtest-engine/src/cli.js --ticker NQ --start 2024-01-01 --end 2024-12-31 \
  --strategy <name> --timeframe 1m \
  --eod-cutoff-et 15:45 --slippage 0.25 --stop-slippage 0.5 --strict-fill
```

## Quick-start checklist for a new pure-price NQ strategy
1. Create `shared/strategies/<name>.js` extending `BaseStrategy`; implement `evaluateSignal` returning §1 signal shape; `static getDataRequirements(){ return { candles:true, gex:false, lt:false, tradier:false, ivSkew:false } }` (add `secondData:true` only if intra-bar needed).
2. Track higher-TF/daily context internally via ET `dateKey` rollover or `CandleAggregator.addCandleIncremental` — closed bars only.
3. Register: import + `case` in `backtest-engine.js:1816`, add name to `--strategy` choices in `cli.js:71`.
4. Emit `side:'buy'|'sell'`, `stop_loss`, `take_profit`, `quantity`, `maxHoldBars`. One position at a time, no scale-outs.
