#!/usr/bin/env node
/**
 * Trade Visualization Script
 *
 * Generates an interactive HTML chart showing backtest trades
 * with entry/exit markers, stop levels, and pattern annotations.
 *
 * Usage:
 *   node scripts/visualize-trades.js --results /path/to/results.json
 *   node scripts/visualize-trades.js --results /path/to/results.json --output chart.html
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    results: null,
    output: null,
    candles: null,
    ticker: 'NQ',
    timeframe: '3m',
    limitTrades: null,      // Limit number of trades to visualize
    tradeIndex: null,       // Show specific trade by index (0-based)
    bufferHours: 4          // Hours of candle data before/after trades
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--results' && args[i + 1]) {
      options.results = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === '--candles' && args[i + 1]) {
      options.candles = args[++i];
    } else if (args[i] === '--ticker' && args[i + 1]) {
      options.ticker = args[++i];
    } else if (args[i] === '--timeframe' && args[i + 1]) {
      options.timeframe = args[++i];
    } else if (args[i] === '--limit' && args[i + 1]) {
      options.limitTrades = parseInt(args[++i]);
    } else if (args[i] === '--trade' && args[i + 1]) {
      options.tradeIndex = parseInt(args[++i]);
    } else if (args[i] === '--buffer' && args[i + 1]) {
      options.bufferHours = parseInt(args[++i]);
    }
  }

  return options;
}

// Load and parse results JSON
function loadResults(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

// Load candle data from CSV
function loadCandles(filePath, startDate, endDate) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');

  const tsIdx = header.findIndex(h => h.includes('ts_event') || h.includes('timestamp'));
  const openIdx = header.findIndex(h => h.toLowerCase() === 'open');
  const highIdx = header.findIndex(h => h.toLowerCase() === 'high');
  const lowIdx = header.findIndex(h => h.toLowerCase() === 'low');
  const closeIdx = header.findIndex(h => h.toLowerCase() === 'close');
  const volumeIdx = header.findIndex(h => h.toLowerCase() === 'volume');
  const symbolIdx = header.findIndex(h => h.toLowerCase() === 'symbol');

  // Use a map to deduplicate by timestamp (keep highest volume)
  const candleMap = new Map();
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;

    // Skip calendar spreads
    const symbol = cols[symbolIdx];
    if (symbol && symbol.includes('-')) continue;

    const timestamp = new Date(cols[tsIdx]).getTime();
    if (timestamp < start || timestamp > end) continue;

    const time = Math.floor(timestamp / 1000);
    const volume = volumeIdx >= 0 ? parseFloat(cols[volumeIdx]) || 0 : 0;

    // Keep candle with highest volume for each timestamp
    const existing = candleMap.get(time);
    if (!existing || volume > existing.volume) {
      candleMap.set(time, {
        time,
        open: parseFloat(cols[openIdx]),
        high: parseFloat(cols[highIdx]),
        low: parseFloat(cols[lowIdx]),
        close: parseFloat(cols[closeIdx]),
        volume
      });
    }
  }

  // Convert to sorted array
  const candles = Array.from(candleMap.values())
    .sort((a, b) => a.time - b.time)
    .map(({ volume, ...candle }) => candle); // Remove volume from output

  return candles;
}

// Aggregate candles to target timeframe
function aggregateCandles(candles, timeframeMinutes) {
  if (timeframeMinutes === 1) return candles;

  const aggregated = [];
  const intervalSeconds = timeframeMinutes * 60;

  let currentBar = null;

  for (const candle of candles) {
    const barTime = Math.floor(candle.time / intervalSeconds) * intervalSeconds;

    if (!currentBar || currentBar.time !== barTime) {
      if (currentBar) aggregated.push(currentBar);
      currentBar = {
        time: barTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      };
    } else {
      currentBar.high = Math.max(currentBar.high, candle.high);
      currentBar.low = Math.min(currentBar.low, candle.low);
      currentBar.close = candle.close;
    }
  }

  if (currentBar) aggregated.push(currentBar);
  return aggregated;
}

// Generate HTML chart
function generateChart(candles, trades, options) {
  const markers = [];
  const lines = [];

  // Process trades into markers and lines
  for (const trade of trades) {
    // Handle timestamps (could be ms, seconds, or ISO string)
    const parseTime = (t) => {
      if (!t) return null;
      if (typeof t === 'number') {
        return t > 1e12 ? Math.floor(t / 1000) : t;
      }
      return Math.floor(new Date(t).getTime() / 1000);
    };

    const entryTime = parseTime(trade.entryTime || trade.signalTime);
    const exitTime = parseTime(trade.exitTime);
    const isLong = trade.side === 'buy' || trade.side === 'long';
    const isWin = (trade.netPnL || 0) > 0;

    // Get exit price - could be in different fields
    const exitPrice = trade.exitPrice || trade.actualExit ||
                      (trade.exitCandle && trade.exitCandle.close);

    // Entry marker
    markers.push({
      time: entryTime,
      position: isLong ? 'belowBar' : 'aboveBar',
      color: isLong ? '#26a69a' : '#ef5350',
      shape: isLong ? 'arrowUp' : 'arrowDown',
      text: `${trade.metadata?.pattern || trade.signal?.levelType || 'Entry'} @ ${trade.entryPrice}`
    });

    // Exit marker
    if (exitTime && exitPrice) {
      markers.push({
        time: exitTime,
        position: isLong ? 'aboveBar' : 'belowBar',
        color: isWin ? '#4caf50' : '#f44336',
        shape: 'circle',
        text: `${trade.exitReason || 'Exit'} @ ${exitPrice} (${isWin ? '+' : ''}$${trade.netPnL || 0})`
      });
    }

    // Stop loss line
    if (trade.stopLoss) {
      lines.push({
        startTime: entryTime,
        endTime: exitTime || entryTime + 3600,
        price: trade.stopLoss,
        color: '#ef5350',
        lineWidth: 1,
        lineStyle: 2, // Dashed
        title: 'Stop'
      });
    }

    // Take profit line
    if (trade.takeProfit) {
      lines.push({
        startTime: entryTime,
        endTime: exitTime || entryTime + 3600,
        price: trade.takeProfit,
        color: '#26a69a',
        lineWidth: 1,
        lineStyle: 2,
        title: 'Target'
      });
    }
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trade Visualization - ${options.ticker} ${options.timeframe}</title>
  <script src="https://unpkg.com/lightweight-charts@4.1.0/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
    }
    .container { padding: 20px; }
    h1 { margin-bottom: 10px; font-size: 1.5rem; }
    .stats {
      display: flex;
      gap: 20px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }
    .stat {
      background: #16213e;
      padding: 10px 15px;
      border-radius: 8px;
    }
    .stat-label { font-size: 0.75rem; color: #888; }
    .stat-value { font-size: 1.2rem; font-weight: bold; }
    .stat-value.positive { color: #4caf50; }
    .stat-value.negative { color: #f44336; }
    #chart {
      width: 100%;
      height: calc(100vh - 150px);
      border-radius: 8px;
      overflow: hidden;
    }
    .trade-list {
      margin-top: 20px;
      background: #16213e;
      border-radius: 8px;
      overflow: hidden;
    }
    .trade-list h2 {
      padding: 15px;
      background: #0f3460;
      font-size: 1rem;
    }
    .trade {
      padding: 12px 15px;
      border-bottom: 1px solid #0f3460;
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 1fr 1fr;
      gap: 10px;
      font-size: 0.85rem;
    }
    .trade:hover { background: #1a1a3e; }
    .trade-header {
      font-weight: bold;
      background: #0f3460;
    }
    .trade .pattern { color: #64b5f6; }
    .trade .pnl.positive { color: #4caf50; }
    .trade .pnl.negative { color: #f44336; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Trade Visualization - ${options.ticker} ${options.timeframe}</h1>
    <div class="stats">
      <div class="stat">
        <div class="stat-label">Total Trades</div>
        <div class="stat-value">${trades.length}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value">${trades.length > 0 ? ((trades.filter(t => t.netPnL > 0).length / trades.length) * 100).toFixed(1) : 0}%</div>
      </div>
      <div class="stat">
        <div class="stat-label">Total P&L</div>
        <div class="stat-value ${trades.reduce((s, t) => s + (t.netPnL || 0), 0) >= 0 ? 'positive' : 'negative'}">
          $${trades.reduce((s, t) => s + (t.netPnL || 0), 0).toFixed(2)}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">Avg Win</div>
        <div class="stat-value positive">
          $${(trades.filter(t => t.netPnL > 0).reduce((s, t) => s + t.netPnL, 0) / Math.max(1, trades.filter(t => t.netPnL > 0).length)).toFixed(2)}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">Avg Loss</div>
        <div class="stat-value negative">
          $${(trades.filter(t => t.netPnL < 0).reduce((s, t) => s + t.netPnL, 0) / Math.max(1, trades.filter(t => t.netPnL < 0).length)).toFixed(2)}
        </div>
      </div>
    </div>
    <div id="chart"></div>

    <div class="trade-list">
      <h2>Trade Details</h2>
      <div class="trade trade-header">
        <div>Pattern</div>
        <div>Entry</div>
        <div>Exit</div>
        <div>Exit Reason</div>
        <div>P&L</div>
      </div>
      ${trades.map(t => {
        const exitPx = t.exitPrice || t.actualExit || (t.exitCandle && t.exitCandle.close);
        return `
        <div class="trade">
          <div class="pattern">${t.metadata?.pattern || t.signal?.levelType || 'N/A'}</div>
          <div>${t.entryPrice?.toFixed(2) || 'N/A'}</div>
          <div>${exitPx ? exitPx.toFixed(2) : 'N/A'}</div>
          <div>${t.exitReason || 'N/A'}</div>
          <div class="pnl ${(t.netPnL || 0) >= 0 ? 'positive' : 'negative'}">
            ${(t.netPnL || 0) >= 0 ? '+' : ''}$${(t.netPnL || 0).toFixed(2)}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <script>
    const chartContainer = document.getElementById('chart');
    const chart = LightweightCharts.createChart(chartContainer, {
      layout: {
        background: { type: 'solid', color: '#1a1a2e' },
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: '#2B2B43' },
        horzLines: { color: '#2B2B43' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: '#2B2B43',
      },
      timeScale: {
        borderColor: '#2B2B43',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderDownColor: '#ef5350',
      borderUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      wickUpColor: '#26a69a',
    });

    const candleData = ${JSON.stringify(candles)};
    candlestickSeries.setData(candleData);

    // Add markers for trades
    const markers = ${JSON.stringify(markers)};
    candlestickSeries.setMarkers(markers);

    // Add horizontal lines for stops/targets
    const lines = ${JSON.stringify(lines)};
    lines.forEach(line => {
      const priceLine = candlestickSeries.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: line.lineWidth,
        lineStyle: line.lineStyle,
        axisLabelVisible: true,
        title: line.title,
      });
    });

    // Store trades for click handlers
    const tradesData = ${JSON.stringify(trades)};

    // Helper to zoom to a trade
    function zoomToTrade(trade) {
      if (!trade) return;
      // Handle both ISO strings and Unix timestamps
      let entryTime = trade.entryTime || trade.signalTime;
      if (typeof entryTime === 'string') {
        entryTime = Math.floor(new Date(entryTime).getTime() / 1000);
      } else if (entryTime > 1e12) {
        // Unix milliseconds
        entryTime = Math.floor(entryTime / 1000);
      }
      const range = 3600 * 2; // 2 hours each side
      chart.timeScale().setVisibleRange({
        from: entryTime - range,
        to: entryTime + range
      });
    }

    // Auto-zoom to first trade on load
    if (tradesData.length > 0) {
      zoomToTrade(tradesData[0]);
    } else {
      chart.timeScale().fitContent();
    }

    // Handle resize
    window.addEventListener('resize', () => {
      chart.applyOptions({ width: chartContainer.clientWidth });
    });

    // Click to zoom to trade
    document.querySelectorAll('.trade:not(.trade-header)').forEach((el, idx) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        zoomToTrade(tradesData[idx]);
      });
    });

    // Keyboard navigation
    let currentTradeIdx = 0;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'n') {
        currentTradeIdx = Math.min(currentTradeIdx + 1, tradesData.length - 1);
        zoomToTrade(tradesData[currentTradeIdx]);
      } else if (e.key === 'ArrowLeft' || e.key === 'p') {
        currentTradeIdx = Math.max(currentTradeIdx - 1, 0);
        zoomToTrade(tradesData[currentTradeIdx]);
      }
    });
  </script>
</body>
</html>`;

  return html;
}

// Main
async function main() {
  const options = parseArgs();

  if (!options.results) {
    console.log('Usage: node visualize.js --results <results.json> [options]');
    console.log('\nOptions:');
    console.log('  --results    Path to backtest results JSON file (required)');
    console.log('  --output     Output HTML file path (default: trades-chart.html)');
    console.log('  --ticker     Ticker symbol (default: NQ)');
    console.log('  --timeframe  Timeframe (default: 3m)');
    console.log('  --limit N    Only show first N trades');
    console.log('  --trade N    Show specific trade by index (0-based)');
    console.log('  --buffer N   Hours of candle data around trades (default: 4)');
    process.exit(1);
  }

  // Load results
  console.log(`Loading results from ${options.results}...`);
  const results = loadResults(options.results);
  let trades = results.trades || [];

  if (trades.length === 0) {
    console.log('No trades found in results file.');
    process.exit(1);
  }

  console.log(`Found ${trades.length} total trades`);

  // Filter trades based on options
  if (options.tradeIndex !== null) {
    if (options.tradeIndex >= 0 && options.tradeIndex < trades.length) {
      trades = [trades[options.tradeIndex]];
      console.log(`Showing trade #${options.tradeIndex}`);
    } else {
      console.error(`Invalid trade index: ${options.tradeIndex}. Valid range: 0-${trades.length - 1}`);
      process.exit(1);
    }
  } else if (options.limitTrades) {
    trades = trades.slice(0, options.limitTrades);
    console.log(`Limited to first ${trades.length} trades`);
  }

  // Helper to get timestamp in ms
  const getTradeTime = (t) => {
    const time = t.entryTime || t.signalTime;
    if (typeof time === 'number') {
      return time > 1e12 ? time : time * 1000; // Handle seconds vs ms
    }
    return new Date(time).getTime();
  };

  // Determine date range from selected trades
  const tradeTimes = trades.map(getTradeTime);
  const bufferMs = options.bufferHours * 3600000;
  const startDate = new Date(Math.min(...tradeTimes) - bufferMs);
  const endDate = new Date(Math.max(...tradeTimes) + bufferMs);

  // Load candle data
  const ticker = options.ticker.toUpperCase();
  const candlePath = options.candles ||
    path.join(__dirname, 'data', 'ohlcv', ticker.toLowerCase(), `${ticker}_ohlcv_1m.csv`);

  if (!fs.existsSync(candlePath)) {
    console.error(`Candle data not found: ${candlePath}`);
    process.exit(1);
  }

  console.log(`Loading candles from ${candlePath}...`);
  const rawCandles = loadCandles(candlePath, startDate.toISOString(), endDate.toISOString());
  console.log(`Loaded ${rawCandles.length} 1m candles`);

  // Aggregate to timeframe
  const timeframeMinutes = parseInt(options.timeframe) || 3;
  const candles = aggregateCandles(rawCandles, timeframeMinutes);
  console.log(`Aggregated to ${candles.length} ${options.timeframe} candles`);

  // Generate chart
  const html = generateChart(candles, trades, options);

  // Write output
  const outputPath = options.output || 'trades-chart.html';
  fs.writeFileSync(outputPath, html);
  console.log(`\nChart saved to: ${outputPath}`);
  console.log(`Open in browser: file://${path.resolve(outputPath)}`);
}

main().catch(console.error);
