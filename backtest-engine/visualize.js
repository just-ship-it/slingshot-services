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
    timeframe: '5m',
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

  // Snap timestamps to candle boundaries so markers align with aggregated bars
  const intervalSeconds = (parseInt(options.timeframe) || 3) * 60;
  const parseTime = (t) => {
    if (!t) return null;
    let s;
    if (typeof t === 'number') {
      s = t > 1e12 ? Math.floor(t / 1000) : t;
    } else {
      s = Math.floor(new Date(t).getTime() / 1000);
    }
    return Math.floor(s / intervalSeconds) * intervalSeconds;
  };

  // Process trades into entry/exit markers only (no static lines)
  for (const trade of trades) {
    const entryTime = parseTime(trade.entryTime || trade.signalTime);
    const exitTime = parseTime(trade.exitTime);
    const isLong = trade.side === 'buy' || trade.side === 'long';
    const isWin = (trade.netPnL || 0) > 0;

    const exitPrice = trade.exitPrice || trade.actualExit ||
                      (trade.exitCandle && trade.exitCandle.close);

    markers.push({
      time: entryTime,
      position: isLong ? 'belowBar' : 'aboveBar',
      color: isLong ? '#26a69a' : '#ef5350',
      shape: isLong ? 'arrowUp' : 'arrowDown',
      text: `${trade.metadata?.entryModel || 'Entry'} @ ${trade.entryPrice}`
    });

    if (exitTime && exitPrice) {
      markers.push({
        time: exitTime,
        position: isLong ? 'aboveBar' : 'belowBar',
        color: isWin ? '#4caf50' : '#f44336',
        shape: 'circle',
        text: `${trade.exitReason || 'Exit'} @ ${exitPrice} (${isWin ? '+' : ''}$${trade.netPnL || 0})`
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
      overflow: hidden;
    }
    .container {
      display: flex;
      height: 100vh;
    }
    .left-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      padding: 12px;
      gap: 8px;
    }
    h1 { font-size: 1.3rem; flex-shrink: 0; }
    .stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    .stat {
      background: #16213e;
      padding: 6px 12px;
      border-radius: 6px;
    }
    .stat-label { font-size: 0.7rem; color: #888; }
    .stat-value { font-size: 1rem; font-weight: bold; }
    .stat-value.positive { color: #4caf50; }
    .stat-value.negative { color: #f44336; }
    #chart {
      flex: 1;
      min-height: 0;
      border-radius: 8px;
    }
    #trade-info {
      flex-shrink: 0;
      background: #16213e;
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 0.8rem;
      line-height: 1.5;
      min-height: 80px;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      color: #ccc;
    }
    #trade-info .info-header {
      font-weight: bold;
      font-size: 0.85rem;
      color: #eee;
      margin-bottom: 4px;
    }
    #trade-info .sweep { color: #ff9800; }
    #trade-info .shift { color: #9c27b0; }
    #trade-info .zone { color: #2196f3; }
    #trade-info .entry-line { color: #eee; }
    #trade-info .model-tag {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.7rem;
      font-weight: bold;
      margin-left: 6px;
    }
    #trade-info .model-MW_PATTERN { background: #ff9800; color: #000; }
    #trade-info .model-STRUCTURE_RETRACE { background: #9c27b0; color: #fff; }
    #trade-info .model-STRUCTURE_DIRECT { background: #2196f3; color: #fff; }
    #trade-info .model-MOMENTUM_CONTINUATION { background: #00bcd4; color: #000; }
    #trade-info .meta-row { color: #888; font-size: 0.75rem; margin-top: 2px; }
    #trade-info .fib-zone { color: #ffd54f; }
    #trade-info .causal { color: #e91e63; }
    .trade-list {
      width: 350px;
      flex-shrink: 0;
      overflow-y: auto;
      height: 100vh;
      background: #16213e;
      border-left: 1px solid #0f3460;
    }
    .trade-list-header {
      padding: 10px 12px;
      background: #0f3460;
      font-size: 0.9rem;
      font-weight: bold;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .trade-row-header {
      display: grid;
      grid-template-columns: 18px 40px 72px 70px;
      gap: 6px;
      padding: 6px 10px;
      font-size: 0.7rem;
      color: #888;
      font-weight: bold;
      background: #0f3460;
      position: sticky;
      top: 36px;
      z-index: 1;
    }
    .trade {
      display: grid;
      grid-template-columns: 18px 40px 72px 70px;
      gap: 6px;
      padding: 7px 10px;
      font-size: 0.78rem;
      border-bottom: 1px solid #0f346044;
      cursor: pointer;
      align-items: center;
    }
    .trade .entry-model-tag {
      font-size: 0.6rem;
      padding: 1px 4px;
      border-radius: 2px;
      color: #fff;
      grid-column: 1 / -1;
    }
    .model-c-MW { background: #ff980088; }
    .model-c-SR { background: #9c27b088; }
    .model-c-SD { background: #2196f388; }
    .model-c-MC { background: #00bcd488; }
    .trade:hover { background: #1a2a4e; }
    .trade.selected { background: #1a3a5e; }
    .trade .pnl.positive { color: #4caf50; }
    .trade .pnl.negative { color: #f44336; }
    .trade .trade-reason { font-size: 0.68rem; color: #888; grid-column: 1 / -1; }
    .toolbar {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .tool-btn {
      background: #16213e;
      color: #ccc;
      border: 1px solid #0f3460;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 0.75rem;
      cursor: pointer;
      font-family: inherit;
    }
    .tool-btn:hover { background: #1a2a4e; }
    .tool-btn.active { border-color: #4fc3f7; color: #4fc3f7; }
    #chart.fib-mode, #chart.fib-mode * { cursor: crosshair !important; }
  </style>
</head>
<body>
  <div class="container">
    <div class="left-panel">
      <h1>Trade Visualization - ${options.ticker} ${options.timeframe}</h1>
      <div class="stats">
        <div class="stat">
          <div class="stat-label">Trades</div>
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
      <div class="toolbar">
        <button class="tool-btn active" data-tool="select">Select</button>
        <button class="tool-btn" data-tool="fib">Fib</button>
        <button class="tool-btn" id="clear-fibs">Clear Fibs</button>
      </div>
      <div id="trade-info">Select a trade to view ICT setup details</div>
      <div id="chart"></div>
    </div>

    <div class="trade-list">
      <div class="trade-list-header">Trades (${trades.length})</div>
      <div class="trade-row-header">
        <div>#</div>
        <div>Side</div>
        <div>Entry</div>
        <div>P&L</div>
      </div>
      ${trades.map((t, i) => {
        const side = t.side || 'N/A';
        const sideColor = (side === 'buy' || side === 'long') ? '#26a69a' : '#ef5350';
        const sideLabel = (side === 'buy' || side === 'long') ? 'BUY' : 'SELL';
        const em = t.metadata?.entryModel || '';
        const emShort = em === 'MW_PATTERN' ? 'MW' : em === 'STRUCTURE_RETRACE' ? 'SR' : em === 'STRUCTURE_DIRECT' ? 'SD' : em === 'MOMENTUM_CONTINUATION' ? 'MC' : em;
        const emClass = em === 'MW_PATTERN' ? 'MW' : em === 'STRUCTURE_RETRACE' ? 'SR' : em === 'STRUCTURE_DIRECT' ? 'SD' : em === 'MOMENTUM_CONTINUATION' ? 'MC' : '';
        return `
        <div class="trade" data-idx="${i}">
          <div style="color: #666; font-size: 0.7rem;">${i + 1}</div>
          <div style="color: ${sideColor}; font-weight: bold;">${sideLabel}</div>
          <div>${t.entryPrice?.toFixed(2) || 'N/A'}</div>
          <div class="pnl ${(t.netPnL || 0) >= 0 ? 'positive' : 'negative'}">
            ${(t.netPnL || 0) >= 0 ? '+' : ''}$${(t.netPnL || 0).toFixed(2)}
          </div>
          <div class="trade-reason">${t.exitReason || ''} <span class="entry-model-tag model-c-${emClass}">${emShort}</span></div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <script>
    const chartContainer = document.getElementById('chart');
    const chart = LightweightCharts.createChart(chartContainer, {
      autoSize: true,
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
        vertLine: { labelVisible: true, labelBackgroundColor: '#0f3460' },
        horzLine: { labelVisible: true, labelBackgroundColor: '#0f3460' },
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

    // Store trades for click handlers
    const tradesData = ${JSON.stringify(trades)};

    // ICT annotation state
    let activeAnnotations = [];

    // Parse timestamp helper (ms or seconds or ISO string -> seconds)
    const tfInterval = ${intervalSeconds};
    function parseTs(t) {
      if (!t) return null;
      if (typeof t === 'string') return Math.floor(new Date(t).getTime() / 1000);
      return t > 1e12 ? Math.floor(t / 1000) : t;
    }
    function snapTs(s) {
      if (!s) return s;
      return Math.floor(s / tfInterval) * tfInterval;
    }

    // Format timestamp for display
    function fmtTime(ms) {
      if (!ms) return '';
      const d = new Date(ms > 1e12 ? ms : ms * 1000);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' ' +
             d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
    }

    // Draw annotations for the SELECTED trade only (stop, target, entry, ICT levels)
    function drawAnnotations(trade) {
      // Remove previous annotations
      activeAnnotations.forEach(line => {
        try { candlestickSeries.removePriceLine(line); } catch(e) {}
      });
      activeAnnotations = [];
      activePrimitives.forEach(p => {
        try { candlestickSeries.detachPrimitive(p); } catch(e) {}
      });
      activePrimitives = [];

      const meta = trade.metadata || trade.signal?.metadata || {};
      const exitPx = trade.exitPrice || trade.actualExit || (trade.exitCandle && trade.exitCandle.close);
      const entryTs = snapTs(parseTs(trade.entryTime || trade.signalTime));
      const exitTs = snapTs(parseTs(trade.exitTime));
      const tradeSpan = exitTs ? exitTs - entryTs : 3600;

      // --- Trade execution levels (stop, target, entry, exit) ---

      // Entry price
      if (trade.entryPrice) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: trade.entryPrice,
          color: '#ffffff',
          lineWidth: 2,
          lineStyle: 0,
          axisLabelVisible: true,
          title: 'Entry ' + trade.entryPrice,
        }));
      }

      // Stop loss
      if (trade.stopLoss) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: trade.stopLoss,
          color: '#ef5350',
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Stop ' + trade.stopLoss,
        }));
      }

      // Take profit
      if (trade.takeProfit) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: trade.takeProfit,
          color: '#26a69a',
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Target ' + trade.takeProfit,
        }));
      }

      // Exit price (if different from stop/target)
      if (exitPx && exitPx !== trade.stopLoss && exitPx !== trade.takeProfit) {
        const isWin = (trade.netPnL || 0) > 0;
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: exitPx,
          color: isWin ? '#4caf50' : '#f44336',
          lineWidth: 1,
          lineStyle: 3,
          axisLabelVisible: true,
          title: (trade.exitReason || 'Exit') + ' ' + exitPx,
        }));
      }

      // --- ICT structure levels ---

      // Sweep level
      if (meta.sweepLevel) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: meta.sweepLevel,
          color: '#ff9800',
          lineWidth: 2,
          lineStyle: 0,
          axisLabelVisible: true,
          title: 'Sweep: ' + (meta.sweepType || '') + ' @ ' + meta.sweepLevel,
        }));
      }

      // Structure shift
      if (meta.structureShift?.level) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: meta.structureShift.level,
          color: '#9c27b0',
          lineWidth: 2,
          lineStyle: 0,
          axisLabelVisible: true,
          title: (meta.structureShift.type || 'Shift') + ' @ ' + meta.structureShift.level,
        }));
      }

      // Causal swing
      if (meta.causalSwing) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: meta.causalSwing,
          color: '#e91e63',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Causal Swing ' + meta.causalSwing,
        }));
      }

      // Target pool
      if (meta.targetPool?.price) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: meta.targetPool.price,
          color: '#4caf50',
          lineWidth: 1,
          lineStyle: 3,
          axisLabelVisible: true,
          title: (meta.targetPool.type || 'Target Pool') + ' ' + meta.targetPool.price,
        }));
      }

      // --- Entry zone (FVG / OB) rectangle ---
      if (meta.entryZone?.top && meta.entryZone?.bottom) {
        const zoneStart = snapTs(parseTs(meta.entryZone.timestamp) || entryTs);
        const zoneEnd = exitTs || (zoneStart + tradeSpan);
        const zoneType = (meta.entryZone.type || 'zone').toUpperCase();
        const zoneTF = meta.entryZone.entryTF ? ' [' + meta.entryZone.entryTF + ']' : '';
        const zoneFormed = meta.entryZone.timestamp ? ' formed ' + fmtTime(meta.entryZone.timestamp) : '';
        const label = zoneType + ' ' + meta.entryZone.bottom + ' - ' + meta.entryZone.top + zoneTF + zoneFormed;
        const zoneColor = zoneType.includes('OB') ? 'rgba(156, 39, 176,' : 'rgba(33, 150, 243,';
        const prim = new RectanglePrimitive(
          chart, candlestickSeries,
          { time: zoneStart, price: meta.entryZone.top },
          { time: zoneEnd, price: meta.entryZone.bottom },
          { fillColor: zoneColor + ' 0.15)', borderColor: zoneColor + ' 0.6)', label: label }
        );
        candlestickSeries.attachPrimitive(prim);
        activePrimitives.push(prim);
      }

      // --- Fib retracement zone (50-79%) ---
      if (meta.fibData?.fib50 && meta.fibData?.fib79) {
        const fibTop = Math.max(meta.fibData.fib50, meta.fibData.fib79);
        const fibBottom = Math.min(meta.fibData.fib50, meta.fibData.fib79);
        const fibStart = snapTs(parseTs(meta.structureShift?.timestamp) || entryTs);
        const fibEnd = exitTs || (fibStart + tradeSpan);
        const fibLabel = 'FIB 50-79% (' + fibBottom.toFixed(0) + '-' + fibTop.toFixed(0) + ')' + (meta.fibData.inFibZone ? ' IN ZONE' : '');
        const prim = new RectanglePrimitive(
          chart, candlestickSeries,
          { time: fibStart, price: fibTop },
          { time: fibEnd, price: fibBottom },
          { fillColor: meta.fibData.inFibZone ? 'rgba(255, 213, 79, 0.12)' : 'rgba(255, 213, 79, 0.05)', borderColor: 'rgba(255, 213, 79, 0.4)', label: fibLabel }
        );
        candlestickSeries.attachPrimitive(prim);
        activePrimitives.push(prim);
      }

      // --- Reference levels (lighter, less prominent) ---

      // PDH / PDL
      if (meta.pdh) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: meta.pdh, color: '#ffffff44', lineWidth: 1, lineStyle: 3,
          axisLabelVisible: false, title: 'PDH ' + meta.pdh,
        }));
      }
      if (meta.pdl) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: meta.pdl, color: '#ffffff44', lineWidth: 1, lineStyle: 3,
          axisLabelVisible: false, title: 'PDL ' + meta.pdl,
        }));
      }

      // Daily open
      if (meta.dailyOpen) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: meta.dailyOpen, color: '#ffeb3b55', lineWidth: 1, lineStyle: 1,
          axisLabelVisible: false, title: 'D.Open ' + meta.dailyOpen,
        }));
      }

      // Weekly open
      if (meta.weeklyOpen) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: meta.weeklyOpen, color: '#03a9f455', lineWidth: 1, lineStyle: 1,
          axisLabelVisible: false, title: 'W.Open ' + meta.weeklyOpen,
        }));
      }

      // Monthly open
      if (meta.monthlyOpen) {
        activeAnnotations.push(candlestickSeries.createPriceLine({
          price: meta.monthlyOpen, color: '#e040fb55', lineWidth: 1, lineStyle: 1,
          axisLabelVisible: false, title: 'M.Open ' + meta.monthlyOpen,
        }));
      }
    }

    // Rectangle primitive for entry zone (OB/FVG) overlay
    // Uses lightweight-charts ISeriesPrimitive API — renders inside the chart's
    // own paint loop so coordinates stay correct on pan/zoom/resize.
    class RectangleRenderer {
      constructor(view) { this._view = view; }
      draw(target) {
        target.useBitmapCoordinateSpace(scope => {
          const v = this._view;
          if (v._x1 === null || v._x2 === null || v._y1 === null || v._y2 === null) return;
          const ctx = scope.context;
          const hr = scope.horizontalPixelRatio;
          const vr = scope.verticalPixelRatio;
          const x1 = Math.round(v._x1 * hr);
          const x2 = Math.round(v._x2 * hr);
          const y1 = Math.round(v._y1 * vr);
          const y2 = Math.round(v._y2 * vr);
          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          const w = Math.abs(x2 - x1);
          const h = Math.abs(y2 - y1);

          // Fill
          ctx.fillStyle = v._opts.fillColor;
          ctx.fillRect(left, top, w, h);
          // Border
          ctx.strokeStyle = v._opts.borderColor;
          ctx.lineWidth = hr;
          ctx.setLineDash([4 * hr, 3 * hr]);
          ctx.strokeRect(left + 0.5, top + 0.5, w, h);
          ctx.setLineDash([]);
          // Label
          ctx.fillStyle = v._opts.borderColor;
          ctx.font = Math.round(11 * vr) + 'px -apple-system, sans-serif';
          ctx.fillText(v._opts.label, left + 4 * hr, top + 14 * vr);
        });
      }
    }

    class RectanglePaneView {
      constructor(source) { this._source = source; this._x1 = null; this._x2 = null; this._y1 = null; this._y2 = null; this._opts = source._opts; }
      update() {
        const s = this._source;
        this._x1 = s._chart.timeScale().timeToCoordinate(s._p1.time);
        this._x2 = s._chart.timeScale().timeToCoordinate(s._p2.time);
        this._y1 = s._series.priceToCoordinate(s._p1.price);
        this._y2 = s._series.priceToCoordinate(s._p2.price);
      }
      renderer() { return new RectangleRenderer(this); }
    }

    class RectanglePrimitive {
      constructor(theChart, theSeries, p1, p2, opts) {
        this._chart = theChart;
        this._series = theSeries;
        this._p1 = p1; // { time, price }
        this._p2 = p2; // { time, price }
        this._opts = opts; // { fillColor, borderColor, label }
        this._paneViews = [new RectanglePaneView(this)];
      }
      updateAllViews() { this._paneViews.forEach(v => v.update()); }
      paneViews() { return this._paneViews; }
      priceAxisViews() { return []; }
      timeAxisViews() { return []; }
    }

    let activePrimitives = [];

    // ---- Fibonacci Retracement Primitive ----
    const FIB_LEVELS = [
      { ratio: 0,     label: '0%',    color: '#888888' },
      { ratio: 0.5,   label: '50%',   color: '#ff9800' },
      { ratio: 0.705, label: '70.5%', color: '#ffd54f' },
      { ratio: 0.79,  label: '79%',   color: '#ffd54f' },
      { ratio: 1,     label: '100%',  color: '#888888' },
    ];

    class FibRenderer {
      constructor(view) { this._view = view; }
      draw(target) {
        target.useBitmapCoordinateSpace(scope => {
          const v = this._view;
          if (v._x1 === null || v._x2 === null) return;
          const ctx = scope.context;
          const hr = scope.horizontalPixelRatio;
          const vr = scope.verticalPixelRatio;
          const left = Math.round(Math.min(v._x1, v._x2) * hr);
          const right = Math.round(Math.max(v._x1, v._x2) * hr);
          const ext = scope.bitmapSize.width; // extend lines to right edge of chart
          const labelX = right + Math.round(6 * hr); // labels near end of drawn range
          const width = ext - left;

          // Draw OTE zone fill (between 70.5% and 79%)
          const y705 = v._levelYs[2];
          const y79 = v._levelYs[3];
          if (y705 !== null && y79 !== null) {
            const top = Math.round(Math.min(y705, y79) * vr);
            const bottom = Math.round(Math.max(y705, y79) * vr);
            ctx.fillStyle = 'rgba(255, 213, 79, 0.10)';
            ctx.fillRect(left, top, width, bottom - top);
          }

          // Draw level lines and labels
          for (let i = 0; i < v._levelYs.length; i++) {
            const y = v._levelYs[i];
            if (y === null) continue;
            const py = Math.round(y * vr);
            const level = FIB_LEVELS[i];
            ctx.strokeStyle = level.color;
            ctx.lineWidth = (i === 0 || i === 4) ? hr : 1.5 * hr;
            ctx.setLineDash([5 * hr, 3 * hr]);
            ctx.beginPath();
            ctx.moveTo(left, py + 0.5);
            ctx.lineTo(ext, py + 0.5);
            ctx.stroke();
            ctx.setLineDash([]);

            // Label
            const price = v._levelPrices[i];
            ctx.fillStyle = level.color;
            ctx.font = Math.round(11 * vr) + 'px -apple-system, sans-serif';
            ctx.fillText(level.label + ' (' + price.toFixed(1) + ')', labelX, py - 4 * vr);
          }

          // Draw anchor dots
          for (const py of [v._levelYs[4], v._levelYs[0]]) { // 100% = A, 0% = B
            if (py === null) continue;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(v._anchorX !== null ? Math.round(v._anchorX * hr) : left, Math.round(py * vr), 3 * hr, 0, Math.PI * 2);
            ctx.fill();
          }
        });
      }
    }

    class FibPaneView {
      constructor(source) {
        this._source = source;
        this._x1 = null; this._x2 = null;
        this._anchorX = null;
        this._levelYs = FIB_LEVELS.map(() => null);
        this._levelPrices = FIB_LEVELS.map(() => 0);
      }
      update() {
        const s = this._source;
        this._x1 = s._chart.timeScale().timeToCoordinate(s._p1.time);
        this._x2 = s._chart.timeScale().timeToCoordinate(s._p2.time);
        this._anchorX = this._x1; // dot at point A
        const range = s._p1.price - s._p2.price;
        for (let i = 0; i < FIB_LEVELS.length; i++) {
          const price = s._p2.price + range * FIB_LEVELS[i].ratio;
          this._levelPrices[i] = price;
          this._levelYs[i] = s._series.priceToCoordinate(price);
        }
      }
      renderer() { return new FibRenderer(this); }
    }

    class FibRetracementPrimitive {
      constructor(theChart, theSeries, p1, p2) {
        this._chart = theChart;
        this._series = theSeries;
        this._p1 = p1; // { time, price } - point A (swing start)
        this._p2 = p2; // { time, price } - point B (swing end)
        this._paneViews = [new FibPaneView(this)];
      }
      updateAllViews() { this._paneViews.forEach(v => v.update()); }
      paneViews() { return this._paneViews; }
      priceAxisViews() { return []; }
      timeAxisViews() { return []; }
      // Allow updating point B for live preview
      setPointB(p2) { this._p2 = p2; }
    }

    // Update info panel with ICT setup timeline
    function updateInfoPanel(trade) {
      const panel = document.getElementById('trade-info');
      const meta = trade.metadata || trade.signal?.metadata || {};
      const isLong = trade.side === 'buy' || trade.side === 'long';
      const sideLabel = isLong ? 'BUY' : 'SELL';
      const exitPx = trade.exitPrice || trade.actualExit || (trade.exitCandle && trade.exitCandle.close);
      const pattern = meta.signalType || meta.pattern || 'N/A';
      const rr = meta.riskReward ? meta.riskReward.toFixed(1) : 'N/A';
      const structTF = meta.structureTF || '?';
      const entryTF = meta.entryTF || '?';
      const entryModel = meta.entryModel || 'MW_PATTERN';

      let html = '<div class="info-header">' + sideLabel + ' ' + pattern +
        ' | ' + structTF + ' &rarr; ' + entryTF +
        ' | R:R ' + rr +
        '<span class="model-tag model-' + entryModel + '">' + entryModel + '</span></div>';

      let step = 1;

      if (meta.sweepLevel) {
        html += '<div class="sweep">' + step + '. Sweep: ' + (meta.sweepType || '?') +
          ' @ ' + meta.sweepLevel + ' (' + fmtTime(meta.sweepTimestamp) + ')</div>';
        step++;
      }

      if (meta.structureShift?.level) {
        const shiftType = meta.structureShift.type || 'shift';
        html += '<div class="shift">' + step + '. Shift: ' + shiftType +
          ' @ ' + meta.structureShift.level + ' (' + fmtTime(meta.structureShift.timestamp) + ')';
        if (meta.structureShift.impulseRange) {
          html += ' [impulse: ' + meta.structureShift.impulseRange.range?.toFixed(1) + 'pts]';
        }
        html += '</div>';
        step++;
      }

      if (meta.causalSwing) {
        html += '<div class="causal">' + step + '. Causal Swing: ' + meta.causalSwing + ' (stop anchor)</div>';
        step++;
      }

      if (meta.entryZone?.top) {
        const ezTF = meta.entryZone.entryTF ? ' (' + meta.entryZone.entryTF + ')' : '';
        html += '<div class="zone">' + step + '. Zone: ' + (meta.entryZone.type || 'zone').toUpperCase() + ezTF +
          ' ' + meta.entryZone.bottom?.toFixed?.(2) + ' - ' + meta.entryZone.top?.toFixed?.(2) +
          ' | formed ' + fmtTime(meta.entryZone.timestamp) + '</div>';
        step++;
      }

      if (meta.fibData) {
        const inZone = meta.fibData.inFibZone ? 'IN ZONE' : 'outside';
        html += '<div class="fib-zone">' + step + '. Fib 50-79%: ' +
          (meta.fibData.fib79?.toFixed(1) || '?') + ' - ' + (meta.fibData.fib50?.toFixed(1) || '?') +
          ' (' + inZone + ')</div>';
        step++;
      }

      html += '<div class="entry-line">' + step + '. Entry: ' + (trade.entryPrice || '?') +
        ' &rarr; Target: ' + (meta.targetPool ? (meta.targetPool.type + ' @ ' + meta.targetPool.price) : (trade.takeProfit || '?')) +
        ' | Stop: ' + (trade.stopLoss || '?') + '</div>';

      if (exitPx) {
        const pnlColor = (trade.netPnL || 0) >= 0 ? '#4caf50' : '#f44336';
        const pnlSign = (trade.netPnL || 0) >= 0 ? '+' : '';
        html += '<div style="color: ' + pnlColor + '; margin-top: 2px;">Exit: ' +
          (trade.exitReason || '?') + ' @ ' + exitPx + ' (' + pnlSign + '$' +
          (trade.netPnL || 0).toFixed(2) + ')</div>';
      }

      // Additional metadata row
      const metaParts = [];
      if (meta.dailyOpenBias) metaParts.push('Bias: ' + meta.dailyOpenBias);
      if (meta.htfBias) {
        const htf1h = meta.htfBias['1h'] || 'null';
        const htf4h = meta.htfBias['4h'] || 'null';
        metaParts.push('HTF: 1h=' + htf1h + ' 4h=' + htf4h);
      }
      if (meta.dailyBarPattern && meta.dailyBarPattern !== 'normal') {
        metaParts.push('Bar: ' + meta.dailyBarPattern);
      }
      if (meta.rangeContext?.adr) {
        metaParts.push('ADR: ' + meta.rangeContext.adr.toFixed(0) + ' (' + ((meta.rangeContext.pctOfADR || 0) * 100).toFixed(0) + '%)');
      }
      if (meta.confirmationType) metaParts.push('Confirm: ' + meta.confirmationType);
      if (metaParts.length > 0) {
        html += '<div class="meta-row">' + metaParts.join(' | ') + '</div>';
      }

      panel.innerHTML = html;
    }

    // Zoom to show full setup: earliest event to exit, with buffer
    function zoomToTrade(trade) {
      if (!trade) return;
      const meta = trade.metadata || trade.signal?.metadata || {};

      // Collect all event timestamps to find earliest
      const timestamps = [];
      const entryTs = parseTs(trade.entryTime || trade.signalTime);
      if (entryTs) timestamps.push(entryTs);
      if (meta.sweepTimestamp) timestamps.push(parseTs(meta.sweepTimestamp));
      if (meta.structureShift?.timestamp) timestamps.push(parseTs(meta.structureShift.timestamp));
      if (meta.entryZone?.timestamp) timestamps.push(parseTs(meta.entryZone.timestamp));

      const exitTs = parseTs(trade.exitTime);
      if (exitTs) timestamps.push(exitTs);

      if (timestamps.length === 0) return;

      const earliest = Math.min(...timestamps);
      const latest = Math.max(...timestamps);
      const buffer = 1800; // 30 min buffer each side

      chart.timeScale().setVisibleRange({
        from: earliest - buffer,
        to: latest + buffer
      });

      // Force price scale to auto-fit the visible candles
      chart.priceScale('right').applyOptions({ autoScale: true });
    }

    // Select a trade: zoom, annotate, update panel, highlight row
    function selectTrade(idx) {
      if (idx < 0 || idx >= tradesData.length) return;
      currentTradeIdx = idx;
      const trade = tradesData[idx];

      zoomToTrade(trade);
      drawAnnotations(trade);
      updateInfoPanel(trade);

      // Highlight selected row
      document.querySelectorAll('.trade').forEach(el => el.classList.remove('selected'));
      const row = document.querySelector('.trade[data-idx="' + idx + '"]');
      if (row) {
        row.classList.add('selected');
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    // Auto-select first trade on load
    let currentTradeIdx = 0;
    if (tradesData.length > 0) {
      selectTrade(0);
    } else {
      chart.timeScale().fitContent();
    }

    // autoSize: true handles resize automatically

    // Click to select trade
    document.querySelectorAll('.trade[data-idx]').forEach(el => {
      el.addEventListener('click', () => {
        selectTrade(parseInt(el.dataset.idx));
      });
    });

    // ---- Fib Drawing Tool State ----
    let currentTool = 'select';
    let fibStartPoint = null;
    let activeFibs = [];
    let previewFib = null;

    function setTool(tool) {
      currentTool = tool;
      document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === tool);
      });
      document.getElementById('chart').classList.toggle('fib-mode', tool === 'fib');
      // Cancel any in-progress fib
      if (tool !== 'fib') {
        cancelFibInProgress();
      }
    }

    function cancelFibInProgress() {
      fibStartPoint = null;
      if (previewFib) {
        try { candlestickSeries.detachPrimitive(previewFib); } catch(e) {}
        previewFib = null;
      }
    }

    function clearAllFibs() {
      activeFibs.forEach(f => {
        try { candlestickSeries.detachPrimitive(f); } catch(e) {}
      });
      activeFibs = [];
      cancelFibInProgress();
    }

    // Toolbar button clicks
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    document.getElementById('clear-fibs').addEventListener('click', clearAllFibs);

    // Keyboard navigation + fib shortcuts (registered first to avoid being blocked by chart API errors)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'f') {
        e.preventDefault();
        setTool(currentTool === 'fib' ? 'select' : 'fib');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (fibStartPoint) {
          cancelFibInProgress();
        } else if (currentTool === 'fib') {
          setTool('select');
        }
        return;
      }
      // Trade navigation only in select mode
      if (currentTool !== 'select') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'n') {
        e.preventDefault();
        selectTrade(Math.min(currentTradeIdx + 1, tradesData.length - 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'p') {
        e.preventDefault();
        selectTrade(Math.max(currentTradeIdx - 1, 0));
      }
    });

    // Chart click handler for fib tool
    try {
      chart.subscribeClick(param => {
        if (currentTool !== 'fib') return;
        if (!param.point) return;
        const price = candlestickSeries.coordinateToPrice(param.point.y);
        if (price === null || price === undefined) return;
        const time = param.time || chart.timeScale().coordinateToTime(param.point.x);
        if (!time) return;

        if (!fibStartPoint) {
          // First click — set anchor
          fibStartPoint = { time, price };
          previewFib = new FibRetracementPrimitive(chart, candlestickSeries, fibStartPoint, { time, price });
          candlestickSeries.attachPrimitive(previewFib);
        } else {
          // Second click — lock fib in place
          if (previewFib) {
            previewFib.setPointB({ time, price });
            activeFibs.push(previewFib);
            previewFib = null;
          }
          fibStartPoint = null;
        }
      });
    } catch(e) { console.warn('chart.subscribeClick not available:', e); }

    // Live preview on crosshair move
    try {
      chart.subscribeCrosshairMove(param => {
        if (currentTool !== 'fib' || !fibStartPoint || !previewFib) return;
        if (!param.point) return;
        const price = candlestickSeries.coordinateToPrice(param.point.y);
        const time = chart.timeScale().coordinateToTime(param.point.x);
        if (price === null || price === undefined || !time) return;
        previewFib.setPointB({ time, price });
        previewFib.updateAllViews();
        chart.timeScale().applyOptions({});
      });
    } catch(e) { console.warn('chart.subscribeCrosshairMove not available:', e); }
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

  // Load candle data — prefer continuous (back-adjusted) file if available
  const ticker = options.ticker.toUpperCase();
  const continuousPath = path.join(__dirname, 'data', 'ohlcv', ticker.toLowerCase(), `${ticker}_ohlcv_1m_continuous.csv`);
  const rawPath = path.join(__dirname, 'data', 'ohlcv', ticker.toLowerCase(), `${ticker}_ohlcv_1m.csv`);
  const candlePath = options.candles ||
    (fs.existsSync(continuousPath) ? continuousPath : rawPath);

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
