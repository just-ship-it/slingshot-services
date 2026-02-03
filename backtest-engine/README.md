# Slingshot Backtesting Engine

Professional-grade backtesting suite for trading strategies with shared strategy logic between live trading and historical testing.

## Features

- **Shared Strategy Logic**: Identical strategy implementation used in both backtesting and live signal generation
- **Professional Metrics**: Comprehensive performance analysis including Sharpe ratio, Sortino ratio, maximum drawdown, and more
- **Multi-Timeframe Support**: Aggregates 1-minute data to any timeframe (5m, 15m, 30m, 1h, 4h, 1d)
- **Realistic Execution**: Models slippage, commission, and realistic order fills
- **Multiple Data Sources**: Integrates OHLCV price data, GEX levels, and liquidity trigger data
- **Real-time Progress**: Live progress reporting during backtests
- **Multiple Output Formats**: Console tables, JSON results, and CSV trade logs

## Quick Start

```bash
# Basic backtest
node index.js --ticker NQ --start 2023-03-28 --end 2023-04-15

# With custom parameters
node index.js --ticker NQ --start 2023-03-28 --end 2023-04-15 \
  --timeframe 15m --commission 5.0 --verbose

# Export results
node index.js --ticker NQ --start 2023-03-28 --end 2023-04-15 \
  --output-json results.json --output-csv trades.csv
```

## CLI Options

### Required Parameters
- `--ticker, -t`: Ticker symbol (NQ, ES, etc.)
- `--start, -s`: Start date (YYYY-MM-DD)
- `--end, -e`: End date (YYYY-MM-DD)

### Optional Parameters
- `--strategy`: Strategy name (default: gex-recoil)
- `--timeframe, -tf`: Chart timeframe (1m, 5m, 15m, 30m, 1h, 4h, 1d)
- `--commission, -c`: Round-trip commission per contract (default: $5.00)
- `--capital`: Initial capital (default: $100,000)
- `--verbose, -v`: Show detailed trade information
- `--quiet, -q`: Suppress console output
- `--show-trades`: Show individual trades in results

### Strategy Parameters
- `--target-points`: Target profit in points (default: 25.0)
- `--stop-buffer`: Stop loss buffer in points (default: 10.0)
- `--max-risk`: Maximum risk per trade (default: 30.0)
- `--use-liquidity-filter`: Enable liquidity trigger filter

### Output Options
- `--output-json`: Save results as JSON
- `--output-csv`: Save trade log as CSV

## Data File Naming Convention

Place your data files in the `data/` directory following this naming convention:

### OHLCV Data (Required)
```
data/ohlcv/{TICKER}_ohlcv_1m.csv
```
Example: `data/ohlcv/NQ_ohlcv_1m.csv`

**Format**: CSV with columns `ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol`

### GEX Levels (Optional but recommended)
```
data/gex/{TICKER}_gex_levels.csv
```
Example: `data/gex/NQ_gex_levels.csv`

**Format**: CSV with columns `date,nq_gamma_flip,nq_put_wall_1,nq_put_wall_2,nq_put_wall_3,nq_call_wall_1,nq_call_wall_2,nq_call_wall_3,regime,total_gex`

### Liquidity Trigger Levels (Optional)
```
data/liquidity/{TICKER}_liquidity_levels.csv
```
Example: `data/liquidity/NQ_liquidity_levels.csv`

**Format**: CSV with columns `datetime,unix_timestamp,sentiment,level_1,level_2,level_3,level_4,level_5`

## Strategy Configuration

The GEX Recoil strategy parameters can be configured via CLI options or by editing `src/config/default.json`:

```json
{
  "strategies": {
    "gex-recoil": {
      "targetPoints": 25.0,
      "stopBuffer": 10.0,
      "maxRisk": 30.0,
      "useTrailingStop": false,
      "trailingTrigger": 15.0,
      "trailingOffset": 10.0,
      "useLiquidityFilter": false,
      "maxLtLevelsBelow": 3,
      "signalCooldownMs": 900000
    }
  }
}
```

## Performance Metrics

The backtesting engine calculates professional-grade performance metrics:

### Basic Statistics
- Total trades, winning/losing trades, win rate
- Total P&L, average win/loss, largest win/loss
- Profit factor, expectancy, commission costs

### Return Metrics
- Total return, annualized return, CAGR
- Initial and final capital

### Risk Metrics
- Volatility (annual), Sharpe ratio, Sortino ratio
- Maximum drawdown, current drawdown, recovery factor

### Advanced Metrics
- Calmar ratio, Sterling ratio, Information ratio

## Example Output

```
📊 BACKTEST RESULTS
════════════════════════════════════════════════════════════
Strategy: GEX-RECOIL
Symbol: NQ
Period: 2023-03-28 → 2023-04-15
Timeframe: 15m
Initial Capital: $100,000
════════════════════════════════════════════════════════════

📈 PERFORMANCE SUMMARY
┌─────────────────────────┬────────────────────┐
│ Total Trades            │ 34                 │
│ Total Return            │ 0.43%              │
│ Annualized Return       │ 9.00%              │
│ Total P&L               │ $434.55            │
│ Sharpe Ratio            │ 28.90              │
│ Max Drawdown            │ 0.04%              │
│ Win Rate                │ 79.41%             │
└─────────────────────────┴────────────────────┘
```

## Architecture

The backtesting engine uses shared strategy logic to ensure consistency:

```
shared/strategies/          # Shared strategy implementations
├── base-strategy.js        # Abstract strategy interface
├── gex-recoil.js          # GEX recoil strategy (shared)
└── strategy-utils.js      # Common utility functions

backtest-engine/
├── src/
│   ├── data/              # Data loading and processing
│   ├── execution/         # Trade simulation
│   ├── analytics/         # Performance calculation
│   └── reporting/         # Result formatting
└── data/                  # CSV data files
```

## Dependencies

```bash
npm install yargs csv-parser chalk cli-table3 moment
```

## Integration with Live Trading

The backtesting engine shares the same strategy logic with the live signal generator, ensuring that:

1. **Identical Decisions**: Same strategy code = same trading decisions
2. **Easy Development**: Write strategy once, test in backtest, deploy live
3. **Reliable Results**: Backtest results accurately represent live performance potential
4. **Consistent Parameters**: Same configuration system for both environments

To deploy a backtested strategy live, the signal generator automatically uses the shared strategy implementation from `shared/strategies/`.

## Contributing

When adding new strategies:

1. Extend the `BaseStrategy` class in `shared/strategies/`
2. Implement pure strategy logic without I/O dependencies
3. Add strategy configuration to `src/config/default.json`
4. Update the strategy factory in `src/backtest-engine.js`
5. Test thoroughly with historical data before live deployment