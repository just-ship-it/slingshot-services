/**
 * Per-session packet builder.
 *
 * Inputs:
 *   - sessionDateKey: 'YYYY-MM-DD' (ET date)
 *   - lookbackTrades: array of completed trades from prior N sessions
 *   - lookbackRejections: array of rejection records from prior N sessions
 *   - dailyBars: array of daily OHLC bars covering at least the lookback window
 *
 * Output:
 *   - { packetText, stats } — packetText is the user-message string for Claude.
 *
 * The text format is compact-but-readable: AI parses it fine and the human
 * reader can audit any session's decision context.
 */

function formatPctTwo(n) {
  return Number.isFinite(n) ? n.toFixed(2) : 'n/a';
}

function formatUsd(n) {
  return Number.isFinite(n) ? `$${Math.round(n)}` : 'n/a';
}

function etDateKey(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ts));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day}`;
}

function etTimeHM(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ts));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return `${o.hour}:${o.minute}`;
}

export function buildPacket({
  sessionDateKey,
  lookbackTrades = [],
  lookbackRejections = [],
  dailyBars = [],
  fcfsRef = null,  // { prevSessionPnL, prevSessionTrades, lookbackPnL, lookbackTrades } — what doing-nothing produced
}) {
  const lines = [];

  // ── Header ────────────────────────────────────────────────────────────
  lines.push(`SESSION DATE (ET): ${sessionDateKey}`);
  lines.push('');

  // ── Daily price context (last 10 sessions) ────────────────────────────
  if (dailyBars.length > 0) {
    const recent = dailyBars.slice(-10);
    lines.push('LAST 10 SESSIONS — DAILY OHLC (NQ futures, raw contract prices):');
    lines.push('  Date         Open      High      Low       Close     Range');
    for (const b of recent) {
      const range = (b.high - b.low).toFixed(2);
      lines.push(`  ${b.date}   ${b.open.toFixed(2).padStart(9)} ${b.high.toFixed(2).padStart(9)} ${b.low.toFixed(2).padStart(9)} ${b.close.toFixed(2).padStart(9)} ${range.padStart(7)}`);
    }

    // Pre-computed pivot levels — saves the AI from arithmetic and surfaces
    // the levels we expect it to use in directionalLevelGuards.
    const yesterday = recent[recent.length - 1];
    const last5 = recent.slice(-5);
    const last10 = recent;
    const max = (arr, key) => Math.max(...arr.map(b => b[key]));
    const min = (arr, key) => Math.min(...arr.map(b => b[key]));
    lines.push('');
    lines.push('KEY PIVOTS (use these as the primary candidates for directionalLevelGuards):');
    lines.push(`  Yesterday (${yesterday.date}):  H=${yesterday.high.toFixed(2)}  L=${yesterday.low.toFixed(2)}  C=${yesterday.close.toFixed(2)}`);
    lines.push(`  5-day:                          H=${max(last5, 'high').toFixed(2)}  L=${min(last5, 'low').toFixed(2)}`);
    lines.push(`  10-day:                         H=${max(last10, 'high').toFixed(2)}  L=${min(last10, 'low').toFixed(2)}`);

    // Range vs trend hint — compute close-to-close change across last 5 sessions.
    const c0 = last5[0].close, cN = last5[last5.length - 1].close;
    const pct5 = ((cN - c0) / c0) * 100;
    const totalRange5 = max(last5, 'high') - min(last5, 'low');
    const avgRange5 = last5.reduce((s, b) => s + (b.high - b.low), 0) / last5.length;
    const trendiness = Math.abs(cN - c0) / totalRange5;
    const regime = trendiness > 0.6 ? 'TRENDING' : (trendiness < 0.25 ? 'RANGING' : 'mixed');
    const direction = cN > c0 ? 'UP' : (cN < c0 ? 'DOWN' : 'flat');

    // Position within 5-day range — tells the AI whether yesterday's close
    // was at the top of the range (long bias risk), middle, or bottom.
    const hi5 = max(last5, 'high');
    const lo5 = min(last5, 'low');
    const posInRange = ((yesterday.close - lo5) / (hi5 - lo5)) * 100;
    const positionLabel = posInRange > 70 ? 'UPPER (near 5d high)'
                       : posInRange < 30 ? 'LOWER (near 5d low)'
                       : 'MIDDLE';

    // Range expansion vs contraction: today's vs prior 3-day avg range.
    const prior3Avg = recent.slice(-4, -1).reduce((s, b) => s + (b.high - b.low), 0) / 3;
    const yRange = yesterday.high - yesterday.low;
    const rangeExp = yRange / prior3Avg;
    const rangeLabel = rangeExp > 1.3 ? 'EXPANDING' : rangeExp < 0.7 ? 'CONTRACTING' : 'stable';

    lines.push(`  5-day move:    ${pct5 >= 0 ? '+' : ''}${pct5.toFixed(2)}%  (direction: ${direction})`);
    lines.push(`  Total range:   ${totalRange5.toFixed(0)}pt   avg daily range: ${avgRange5.toFixed(0)}pt`);
    lines.push(`  Regime hint:   ${regime}  (trendiness ${trendiness.toFixed(2)})`);
    lines.push(`  Yest close in 5d range: ${posInRange.toFixed(0)}%  → ${positionLabel}`);
    lines.push(`  Yest range:    ${yRange.toFixed(0)}pt vs 3d-avg ${prior3Avg.toFixed(0)}pt  → ${rangeLabel}`);
    lines.push('');
  }

  // ── FCFS performance reference (what "doing nothing" produced) ────────
  if (fcfsRef) {
    lines.push('FCFS REFERENCE — what doing NOTHING (all strategies open, no overrides) produced:');
    if (fcfsRef.prevSessionPnL != null) {
      lines.push(`  Previous session (FCFS):  ${fcfsRef.prevSessionTrades} trades  pnl ${formatUsd(fcfsRef.prevSessionPnL)}`);
    }
    if (fcfsRef.lookbackPnL != null) {
      lines.push(`  Full lookback (FCFS):     ${fcfsRef.lookbackTradesCount} trades  pnl ${formatUsd(fcfsRef.lookbackPnL)}`);
    }
    lines.push('  Your ruleset must BEAT this. Every override risks falling below.');
    lines.push('');
  }

  // ── Per-strategy trade summary (last N sessions in lookback) ──────────
  const byStrat = {};
  for (const t of lookbackTrades) {
    if (!byStrat[t.strategy]) byStrat[t.strategy] = [];
    byStrat[t.strategy].push(t);
  }

  lines.push(`LAST ${lookbackTrades.length === 0 ? 'N' : ''} SESSIONS — PER-STRATEGY TRADE SUMMARY:`);
  for (const strat of ['ls-flip-trigger-bar', 'gex-flip-ivpct', 'gex-lt-3m-crossover', 'gex-level-fade']) {
    const ts = byStrat[strat] || [];
    if (ts.length === 0) {
      lines.push(`  ${strat}: 0 trades`);
      continue;
    }
    const wins = ts.filter(t => t.netPnL > 0).length;
    const totalPnL = ts.reduce((s, t) => s + t.netPnL, 0);
    const longTrades = ts.filter(t => t.side === 'long').length;
    const shortTrades = ts.length - longTrades;
    const longPnL = ts.filter(t => t.side === 'long').reduce((s, t) => s + t.netPnL, 0);
    const shortPnL = ts.filter(t => t.side === 'short').reduce((s, t) => s + t.netPnL, 0);
    const wr = (wins / ts.length) * 100;
    const avgHoldMin = ts.reduce((s, t) => s + (t.durationMs / 60000), 0) / ts.length;
    lines.push(`  ${strat}: ${ts.length} trades  WR ${wr.toFixed(1)}%  PnL ${formatUsd(totalPnL)}  avgHold ${avgHoldMin.toFixed(0)}min`);
    lines.push(`    long: ${longTrades} (${formatUsd(longPnL)})   short: ${shortTrades} (${formatUsd(shortPnL)})`);
  }
  lines.push('');

  // ── Per-strategy per-hour PnL (last sessions, ET hour bucket) ─────────
  // Helps the AI spot "this strategy is bleeding 10-11 ET" patterns.
  const byStratHour = {};       // {strat|hour: {trades, pnl}}
  const byStratHourSide = {};   // {strat|hour|side: {trades, wins, pnl}}
  for (const t of lookbackTrades) {
    const h = parseInt(etTimeHM(t.entryTs).split(':')[0], 10);
    const key = `${t.strategy}|${h}`;
    if (!byStratHour[key]) byStratHour[key] = { trades: 0, pnl: 0 };
    byStratHour[key].trades += 1;
    byStratHour[key].pnl += t.netPnL;
    const skey = `${t.strategy}|${h}|${t.side}`;
    if (!byStratHourSide[skey]) byStratHourSide[skey] = { trades: 0, wins: 0, pnl: 0 };
    byStratHourSide[skey].trades += 1;
    byStratHourSide[skey].pnl += t.netPnL;
    if (t.netPnL > 0) byStratHourSide[skey].wins += 1;
  }
  if (Object.keys(byStratHour).length > 0) {
    lines.push('HOURLY PNL BUCKETS (ET hour, lookback total):');
    for (const strat of ['ls-flip-trigger-bar', 'gex-flip-ivpct', 'gex-lt-3m-crossover', 'gex-level-fade']) {
      const hours = [];
      for (let h = 0; h <= 23; h++) {
        const k = `${strat}|${h}`;
        if (byStratHour[k]) hours.push(`${h}ET:${formatUsd(byStratHour[k].pnl)}(${byStratHour[k].trades})`);
      }
      if (hours.length > 0) {
        lines.push(`  ${strat}: ${hours.join('  ')}`);
      }
    }
    lines.push('');
  }

  // ── Statistical patterns: surface only high-evidence combos ───────────
  // Only show hour × strategy × side combos with at least 4 trades AND a
  // WR outside [30%, 70%] OR PnL/trade outside [-$100, +$100]. This is the
  // "actionable evidence" filter — anything below this threshold is noise
  // the AI should ignore.
  const patterns = [];
  for (const [k, v] of Object.entries(byStratHourSide)) {
    if (v.trades < 4) continue;
    const wr = (v.wins / v.trades) * 100;
    const avg = v.pnl / v.trades;
    if (wr >= 30 && wr <= 70 && Math.abs(avg) <= 100) continue;
    const [strat, hourStr, side] = k.split('|');
    patterns.push({ strat, hour: parseInt(hourStr, 10), side, trades: v.trades, wins: v.wins, wr, pnl: v.pnl, avg });
  }
  patterns.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  if (patterns.length > 0) {
    lines.push('HIGH-EVIDENCE TIME-OF-DAY PATTERNS (>=4 trades AND extreme WR or avg PnL — these are CANDIDATES for blockedHoursET, not auto-blocks):');
    for (const p of patterns.slice(0, 12)) {
      const flag = p.pnl < 0 ? 'BLEED' : 'EDGE';
      lines.push(`  ${p.strat.padEnd(22)} ${p.hour}ET ${p.side.padEnd(5)} ${p.trades} trades  WR ${p.wr.toFixed(0)}%  PnL ${formatUsd(p.pnl)}  avg ${formatUsd(p.avg)}  [${flag}]`);
    }
    lines.push('');
  }

  // ── Recent trade tape (last ~20 trades, chronological) ────────────────
  lines.push(`RECENT TRADES (most recent ${Math.min(20, lookbackTrades.length)}):`);
  const recent = lookbackTrades.slice(-20);
  for (const t of recent) {
    const d = etDateKey(t.entryTs);
    const h = etTimeHM(t.entryTs);
    lines.push(`  ${d} ${h}ET  ${t.strategy.padEnd(22)} ${t.side.padEnd(5)}  e=${t.entryPrice.toFixed(2)} → ${t.exitPrice.toFixed(2)}  (${t.exitReason})  pnl=${formatUsd(t.netPnL)}`);
  }
  lines.push('');

  // ── Prior-session rejections (counts only — too many to dump) ─────────
  if (lookbackRejections.length > 0) {
    const rejByStrat = {};
    for (const r of lookbackRejections) {
      if (!rejByStrat[r.strategy]) rejByStrat[r.strategy] = {};
      rejByStrat[r.strategy][r.reason] = (rejByStrat[r.strategy][r.reason] || 0) + 1;
    }
    lines.push('PRIOR-SESSION REJECTION COUNTS (per strategy × reason):');
    for (const [strat, reasons] of Object.entries(rejByStrat)) {
      const parts = Object.entries(reasons).map(([r, n]) => `${r}:${n}`).join(' ');
      lines.push(`  ${strat}: ${parts}`);
    }
    lines.push('');
  }

  // ── Decision request ──────────────────────────────────────────────────
  lines.push(`Now emit the ruleset JSON for session ${sessionDateKey}. JSON only, no prose.`);

  const packetText = lines.join('\n');
  return {
    packetText,
    stats: {
      lookbackTradeCount: lookbackTrades.length,
      lookbackRejectionCount: lookbackRejections.length,
      packetChars: packetText.length,
    },
  };
}

// ── Daily OHLC aggregation from 1m CSV ───────────────────────────────────
// Standalone helper: read 1m candles in a window, aggregate to ET daily bars.
// Used by the driver to provide daily price context to the AI.
import fs from 'fs';
import path from 'path';
import readline from 'readline';

export async function loadDailyBarsFromOhlcv1m(csvPath, startDateKey, endDateKey) {
  return new Promise((resolve, reject) => {
    const byDate = new Map();
    const stream = fs.createReadStream(csvPath, { highWaterMark: 1 << 20 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let header = null;
    let idx = null;
    rl.on('line', (line) => {
      if (!line) return;
      if (!header) {
        header = line.split(',');
        idx = {
          ts: 0,
          open: header.indexOf('open'),
          high: header.indexOf('high'),
          low: header.indexOf('low'),
          close: header.indexOf('close'),
          volume: header.indexOf('volume'),
          symbol: header.indexOf('symbol'),
        };
        return;
      }
      const cols = line.split(',');
      const sym = cols[idx.symbol];
      if (sym && sym.includes('-')) return; // skip calendar spreads
      const ts = new Date(cols[idx.ts]).getTime();
      if (!Number.isFinite(ts)) return;
      const o = parseFloat(cols[idx.open]);
      const h = parseFloat(cols[idx.high]);
      const l = parseFloat(cols[idx.low]);
      const c = parseFloat(cols[idx.close]);
      if (!Number.isFinite(o)) return;
      // ET date for the bar's timestamp
      const dk = etDateKey(ts);
      if (dk < startDateKey || dk > endDateKey) return;
      if (!byDate.has(dk)) {
        byDate.set(dk, { date: dk, open: o, high: h, low: l, close: c, _firstTs: ts, _lastTs: ts });
      } else {
        const b = byDate.get(dk);
        if (h > b.high) b.high = h;
        if (l < b.low) b.low = l;
        if (ts > b._lastTs) { b.close = c; b._lastTs = ts; }
        if (ts < b._firstTs) { b.open = o; b._firstTs = ts; }
      }
    });
    rl.on('close', () => {
      const out = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      resolve(out);
    });
    rl.on('error', reject);
  });
}

export { etDateKey };
