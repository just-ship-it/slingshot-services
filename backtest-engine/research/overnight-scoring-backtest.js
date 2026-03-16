/**
 * Overnight Scoring Strategy Backtest
 *
 * Multi-factor scoring approach: combine LT, GEX, IBS, day-of-week, GEX magnitude
 * into a composite score. Only trade when score >= threshold. Goal: 80%+ WR.
 *
 * Wider stops (or none), time-based exit at 2 AM EST.
 * NQ needs room to breathe — tight stops get hunted.
 *
 * Usage:
 *   node backtest-engine/research/overnight-scoring-backtest.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// ============================================================================
// TIMEZONE
// ============================================================================
function isDST(utcMs) {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (m >= 3 && m <= 9) return true;
  if (m === 0 || m === 1 || m === 11) return false;
  if (m === 2) { const fd = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return utcMs >= Date.UTC(y, 2, fd === 0 ? 8 : 15 - fd, 7); }
  if (m === 10) { const fd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return utcMs < Date.UTC(y, 10, fd === 0 ? 1 : 8 - fd, 6); }
  return false;
}
function utcToEST(ms) { return ms + (isDST(ms) ? -4 : -5) * 3600000; }
function getESTHour(ts) { const d = new Date(utcToEST(ts)); return d.getUTCHours() + d.getUTCMinutes() / 60; }
function getESTDateStr(ts) { const d = new Date(utcToEST(ts)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function getDayOfWeek(ds) { return new Date(ds + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' }); }

// ============================================================================
// DATA LOADING
// ============================================================================
function loadOHLCV() {
  console.log('Loading NQ OHLCV...');
  const raw = fs.readFileSync(path.join(DATA_DIR, 'ohlcv/nq/NQ_ohlcv_1m_continuous.csv'), 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const c = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 6) continue;
    c.push({ timestamp: new Date(p[0]).getTime(), open: +p[1], high: +p[2], low: +p[3], close: +p[4], volume: +p[5]||0 });
  }
  console.log(`  ${c.length} candles`);
  return c;
}

function loadIntradayGEX() {
  console.log('Loading GEX...');
  const dir = path.join(DATA_DIR, 'gex/nq');
  const files = fs.readdirSync(dir).filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'));
  const g = {};
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (!d.metadata?.date || !d.data?.length) continue;
      const last = d.data[d.data.length - 1];
      g[d.metadata.date] = { totalGex: last.total_gex, regime: last.regime, gammaFlip: last.gamma_flip };
    } catch(e) {}
  }
  console.log(`  ${Object.keys(g).length} dates`);
  return g;
}

function loadDailyGEX() {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'gex/nq/NQ_gex_levels.csv'), 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const g = {};
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 11) continue;
    g[p[0]] = { totalGex: +p[10], regime: p[11]?.trim()||'unknown', gammaFlip: +p[1] };
  }
  return g;
}

function loadLT() {
  console.log('Loading LT...');
  const raw = fs.readFileSync(path.join(DATA_DIR, 'liquidity/nq/NQ_liquidity_levels.csv'), 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const lt = {};
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 8) continue;
    lt[p[0].split(' ')[0]] = { sentiment: p[2] };
  }
  console.log(`  ${Object.keys(lt).length} dates`);
  return lt;
}

// ============================================================================
// SESSION BUILDER
// ============================================================================
function buildSessions(candles) {
  console.log('Building sessions...');
  const byDate = {};
  for (const c of candles) {
    const d = getESTDateStr(c.timestamp);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({ ...c, estHour: getESTHour(c.timestamp) });
  }
  const dates = Object.keys(byDate).sort();
  const sessions = [];
  for (let i = 0; i < dates.length - 1; i++) {
    const today = dates[i], tomorrow = dates[i + 1];
    const tc = byDate[today]||[], nc = byDate[tomorrow]||[];
    const rth = tc.filter(c => c.estHour >= 9.5 && c.estHour < 16);
    if (rth.length < 30) continue;

    const rthHigh = Math.max(...rth.map(c => c.high));
    const rthLow = Math.min(...rth.map(c => c.low));
    const rthClose = rth[rth.length - 1].close;
    const rthOpen = rth[0].open;
    const ibs = rthHigh > rthLow ? (rthClose - rthLow) / (rthHigh - rthLow) : 0.5;

    // Last hour direction (3pm-4pm)
    const lastHour = tc.filter(c => c.estHour >= 15 && c.estHour < 16);
    const lastHourReturn = lastHour.length > 1 ? lastHour[lastHour.length-1].close - lastHour[0].open : 0;

    // Previous day return (simple: look back)
    const prevDayIdx = i > 0 ? i - 1 : null;

    const on = [...tc.filter(c => c.estHour >= 18), ...nc.filter(c => c.estHour < 9.5)];
    if (on.length < 10) continue;

    sessions.push({
      date: today, nextDate: tomorrow, dayOfWeek: getDayOfWeek(today),
      rthOpen, rthClose, rthHigh, rthLow,
      rthReturn: rthClose - rthOpen,
      rthReturnPct: (rthClose - rthOpen) / rthOpen * 100,
      ibs, lastHourReturn,
      overnightCandles: on,
      overnightOpen: on[0].open,
    });
  }
  console.log(`  ${sessions.length} sessions`);

  // Add consecutive down/up day tracking
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i-1].rthReturn < 0 && sessions[i].date > sessions[i-1].date) {
      sessions[i].consecutiveDown = (sessions[i-1].consecutiveDown || 0) + 1;
    } else {
      sessions[i].consecutiveDown = 0;
    }
    if (sessions[i-1].rthReturn > 0) {
      sessions[i].consecutiveUp = (sessions[i-1].consecutiveUp || 0) + 1;
    } else {
      sessions[i].consecutiveUp = 0;
    }
  }

  return sessions;
}

// ============================================================================
// TRADE SIMULATOR
// ============================================================================
function simulateTrade(session, side, params) {
  const { stopLossPoints, takeProfitPoints, exitHourEST } = params;
  const candles = session.overnightCandles;
  const entry = session.overnightOpen;
  const isLong = side === 'buy';
  const stop = isLong ? entry - stopLossPoints : entry + stopLossPoints;
  const target = isLong ? entry + takeProfitPoints : entry - takeProfitPoints;
  let mfe = 0, mae = 0, exitPrice = null, exitReason = null;

  for (const c of candles) {
    if (exitHourEST && c.estHour >= exitHourEST && c.estHour < 18) {
      exitPrice = c.open; exitReason = 'time_exit'; break;
    }
    if (isLong) { mfe = Math.max(mfe, c.high - entry); mae = Math.max(mae, entry - c.low); }
    else { mfe = Math.max(mfe, entry - c.low); mae = Math.max(mae, c.high - entry); }

    if (stopLossPoints < 9000) {
      if (isLong && c.low <= stop) { exitPrice = stop; exitReason = 'stop_loss'; break; }
      if (!isLong && c.high >= stop) { exitPrice = stop; exitReason = 'stop_loss'; break; }
    }
    if (takeProfitPoints < 9000) {
      if (isLong && c.high >= target) { exitPrice = target; exitReason = 'take_profit'; break; }
      if (!isLong && c.low <= target) { exitPrice = target; exitReason = 'take_profit'; break; }
    }
  }
  if (!exitPrice) { exitPrice = candles[candles.length-1].close; exitReason = 'session_end'; }

  return {
    date: session.date, dayOfWeek: session.dayOfWeek, side,
    entryPrice: entry, exitPrice,
    pointsPnL: isLong ? exitPrice - entry : entry - exitPrice,
    mfePoints: mfe, maePoints: mae, exitReason,
  };
}

// ============================================================================
// SCORING ENGINE
// ============================================================================
function scoreSession(session, gex, lt, gexPercentiles) {
  let score = 0;
  let direction = 0; // +1 bullish, -1 bearish

  // === LT Sentiment (strongest single signal) ===
  if (lt?.sentiment === 'BULLISH') { score += 2; direction += 2; }
  else if (lt?.sentiment === 'BEARISH') { score += 2; direction -= 2; }
  else return { score: 0, direction: 0, factors: {} }; // No LT = no trade

  // === GEX Regime ===
  if (gex) {
    const posGex = gex.regime === 'positive' || gex.regime === 'strong_positive';
    const negGex = gex.regime === 'negative' || gex.regime === 'strong_negative';
    if (posGex && direction > 0) score += 2;      // GEX confirms bullish
    else if (negGex && direction < 0) score += 2;  // GEX confirms bearish
    else if (posGex && direction < 0) score -= 1;  // GEX contradicts
    else if (negGex && direction > 0) score -= 1;

    if (gex.regime === 'strong_positive' && direction > 0) score += 1; // Extra for strong
    if (gex.regime === 'strong_negative' && direction < 0) score += 1;
  }

  // === IBS ===
  if (direction > 0 && session.ibs < 0.3) score += 1;  // Low IBS + bullish = bounce expected
  if (direction < 0 && session.ibs > 0.7) score += 1;  // High IBS + bearish = drop expected
  if (direction > 0 && session.ibs > 0.8) score -= 1;  // Already extended
  if (direction < 0 && session.ibs < 0.2) score -= 1;

  // === Day of Week ===
  if (session.dayOfWeek === 'Thursday') score -= 1;  // Worst overnight
  if (session.dayOfWeek === 'Monday') score += 1;     // Historically good
  if (session.dayOfWeek === 'Wednesday') score += 1;

  // === GEX Magnitude (percentile) ===
  if (gex && gexPercentiles) {
    const absGex = Math.abs(gex.totalGex);
    if (absGex > gexPercentiles.p75) score += 1; // Strong gamma = more predictable
    if (absGex > gexPercentiles.p90) score += 1;
  }

  // === Last hour selling ===
  if (direction > 0 && session.lastHourReturn < -20) score += 1; // EOD selloff → overnight bounce
  if (direction < 0 && session.lastHourReturn > 20) score += 1;  // EOD rally → overnight fade

  // === Consecutive days ===
  if (direction > 0 && (session.consecutiveDown || 0) >= 2) score += 1; // 2+ down days → bounce
  if (direction < 0 && (session.consecutiveUp || 0) >= 2) score += 1;

  // === Above/below gamma flip ===
  if (gex?.gammaFlip && session.rthClose) {
    const aboveGF = session.rthClose > gex.gammaFlip;
    if (aboveGF && direction > 0) score += 1;  // Above gamma flip + bullish = stability
    if (!aboveGF && direction < 0) score += 1; // Below gamma flip + bearish = pressure
  }

  const side = direction > 0 ? 'buy' : 'sell';
  return { score, direction, side };
}

// ============================================================================
// METRICS
// ============================================================================
function computeMetrics(trades, label = '') {
  if (trades.length === 0) return null;
  const wins = trades.filter(t => t.pointsPnL > 0);
  const losses = trades.filter(t => t.pointsPnL <= 0);
  const totalPnL = trades.reduce((s, t) => s + t.pointsPnL, 0);
  const avgPnL = totalPnL / trades.length;
  const wr = wins.length / trades.length * 100;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pointsPnL, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pointsPnL, 0) / losses.length : 0;
  const pf = losses.length > 0 ? wins.reduce((s, t) => s + t.pointsPnL, 0) / Math.abs(losses.reduce((s, t) => s + t.pointsPnL, 0)) : Infinity;
  const std = Math.sqrt(trades.reduce((s, t) => s + Math.pow(t.pointsPnL - avgPnL, 2), 0) / trades.length);
  const sharpe = std > 0 ? avgPnL / std : 0;
  const avgMFE = trades.reduce((s, t) => s + t.mfePoints, 0) / trades.length;
  const avgMAE = trades.reduce((s, t) => s + t.maePoints, 0) / trades.length;
  let peak = 0, maxDD = 0, eq = 0;
  for (const t of trades) { eq += t.pointsPnL; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, peak - eq); }
  const longs = trades.filter(t => t.side === 'buy'), shorts = trades.filter(t => t.side === 'sell');
  const exits = {};
  for (const t of trades) exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;

  return { label, trades: trades.length, wins: wins.length, wr, totalPnL, avgPnL, avgWin, avgLoss, pf, std, sharpe, avgMFE, avgMAE, maxDD, eq, longs: longs.length, shorts: shorts.length, longPnL: longs.reduce((s,t)=>s+t.pointsPnL,0), shortPnL: shorts.reduce((s,t)=>s+t.pointsPnL,0), exits };
}

function printMetrics(m) {
  if (!m) { console.log('  No trades'); return; }
  console.log(`\n  ═══ ${m.label} ═══`);
  console.log(`  Trades: ${m.trades} (${m.longs}L/${m.shorts}S) | WR: ${m.wr.toFixed(1)}% | PF: ${m.pf === Infinity ? 'Inf' : m.pf.toFixed(2)}`);
  console.log(`  Total: ${m.totalPnL.toFixed(0)} pts | Avg: ${m.avgPnL.toFixed(1)} pts | Sharpe: ${m.sharpe.toFixed(3)}`);
  console.log(`  AvgWin: ${m.avgWin.toFixed(1)} | AvgLoss: ${m.avgLoss.toFixed(1)} | Std: ${m.std.toFixed(1)}`);
  console.log(`  Long: ${m.longs} → ${m.longPnL.toFixed(0)} pts (avg ${m.longs>0?(m.longPnL/m.longs).toFixed(1):'N/A'})`);
  console.log(`  Short: ${m.shorts} → ${m.shortPnL.toFixed(0)} pts (avg ${m.shorts>0?(m.shortPnL/m.shorts).toFixed(1):'N/A'})`);
  console.log(`  MFE: ${m.avgMFE.toFixed(1)} | MAE: ${m.avgMAE.toFixed(1)} | MaxDD: ${m.maxDD.toFixed(0)} | Equity: ${m.eq.toFixed(0)}`);
  console.log(`  Exits: ${Object.entries(m.exits).map(([k,v])=>`${k}=${v}`).join(', ')}`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT SCORING STRATEGY — NQ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const candles = loadOHLCV();
  const gexData = loadIntradayGEX();
  const dailyGex = loadDailyGEX();
  const ltData = loadLT();
  const sessions = buildSessions(candles);

  // Compute GEX magnitude percentiles
  const allGex = sessions.map(s => {
    const g = gexData[s.date] || dailyGex[s.date];
    return g ? Math.abs(g.totalGex) : null;
  }).filter(v => v != null).sort((a, b) => a - b);
  const gexPercentiles = {
    p50: allGex[Math.floor(allGex.length * 0.5)],
    p75: allGex[Math.floor(allGex.length * 0.75)],
    p90: allGex[Math.floor(allGex.length * 0.9)],
  };

  // Score all sessions
  const scoredSessions = sessions.map(s => {
    const gex = gexData[s.date] || dailyGex[s.date] || null;
    const lt = ltData[s.date] || null;
    const { score, direction, side } = scoreSession(s, gex, lt, gexPercentiles);
    return { ...s, score, direction, side, gexRegime: gex?.regime, ltSentiment: lt?.sentiment };
  });

  // Score distribution
  console.log('\n  Score distribution:');
  const scoreDist = {};
  for (const s of scoredSessions) {
    const k = s.score;
    if (!scoreDist[k]) scoreDist[k] = { n: 0, retSum: 0, wins: 0 };
    scoreDist[k].n++;
  }
  for (const [score, data] of Object.entries(scoreDist).sort((a,b) => +a[0] - +b[0])) {
    console.log(`    Score ${score.padStart(3)}: ${String(data.n).padStart(5)} sessions`);
  }

  // Test various score thresholds with various exit times and stops
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  SCORE THRESHOLD × EXIT TIME × STOP/TARGET SWEEP              ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  const thresholds = [3, 4, 5, 6, 7, 8];
  const exitHours = [2, 4, 8, 9.5];
  const stops = [
    { sl: 9999, tp: 9999, label: 'None' },
    { sl: 50, tp: 9999, label: 'SL50' },
    { sl: 100, tp: 9999, label: 'SL100' },
    { sl: 150, tp: 9999, label: 'SL150' },
    { sl: 200, tp: 9999, label: 'SL200' },
    { sl: 50, tp: 50, label: '50/50' },
    { sl: 100, tp: 100, label: '100/100' },
    { sl: 100, tp: 150, label: '100/150' },
    { sl: 150, tp: 150, label: '150/150' },
    { sl: 200, tp: 200, label: '200/200' },
  ];

  const results = [];

  for (const threshold of thresholds) {
    for (const exitHr of exitHours) {
      for (const { sl, tp, label: stoplabel } of stops) {
        const eligible = scoredSessions.filter(s => s.score >= threshold);
        if (eligible.length < 15) continue;

        const trades = eligible.map(s => {
          const t = simulateTrade(s, s.side, { stopLossPoints: sl, takeProfitPoints: tp, exitHourEST: exitHr });
          return { ...t, score: s.score };
        });

        const m = computeMetrics(trades);
        if (!m) continue;

        results.push({
          threshold, exitHr, stoplabel,
          trades: m.trades, wr: m.wr, totalPnL: m.totalPnL,
          avgPnL: m.avgPnL, sharpe: m.sharpe, pf: m.pf,
          maxDD: m.maxDD, avgMFE: m.avgMFE, avgMAE: m.avgMAE,
        });
      }
    }
  }

  // Sort by win rate, show top 50
  results.sort((a, b) => b.wr - a.wr || b.sharpe - a.sharpe);

  console.log(`  ${'Thr'.padStart(4)} ${'Exit'.padStart(6)} ${'Stop'.padStart(8)} ${'Trades'.padStart(6)} ${'WR%'.padStart(7)} ${'AvgPnL'.padStart(8)} ${'TotalPnL'.padStart(10)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(7)} ${'MaxDD'.padStart(7)} ${'MFE'.padStart(6)} ${'MAE'.padStart(6)}`);
  console.log(`  ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)}`);

  for (let i = 0; i < Math.min(60, results.length); i++) {
    const r = results[i];
    const exitStr = r.exitHr === 9.5 ? '9:30a' : `${r.exitHr}am`;
    const pfStr = r.pf === Infinity ? '  Inf' : r.pf.toFixed(1).padStart(7);
    console.log(`  ${String(r.threshold).padStart(4)} ${exitStr.padStart(6)} ${r.stoplabel.padStart(8)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(6)}% ${r.avgPnL.toFixed(1).padStart(8)} ${r.totalPnL.toFixed(0).padStart(10)} ${r.sharpe.toFixed(3).padStart(7)} ${pfStr} ${r.maxDD.toFixed(0).padStart(7)} ${r.avgMFE.toFixed(0).padStart(6)} ${r.avgMAE.toFixed(0).padStart(6)}`);
  }

  // Also show best by Sharpe with WR >= 80%
  const high80 = results.filter(r => r.wr >= 80).sort((a, b) => b.totalPnL - a.totalPnL);
  if (high80.length > 0) {
    console.log(`\n\n  ═══ WR >= 80% CONFIGURATIONS (${high80.length} found), sorted by Total PnL ═══`);
    console.log(`  ${'Thr'.padStart(4)} ${'Exit'.padStart(6)} ${'Stop'.padStart(8)} ${'Trades'.padStart(6)} ${'WR%'.padStart(7)} ${'AvgPnL'.padStart(8)} ${'TotalPnL'.padStart(10)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(7)} ${'MaxDD'.padStart(7)}`);
    console.log(`  ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)}`);

    for (const r of high80.slice(0, 30)) {
      const exitStr = r.exitHr === 9.5 ? '9:30a' : `${r.exitHr}am`;
      const pfStr = r.pf === Infinity ? '  Inf' : r.pf.toFixed(1).padStart(7);
      console.log(`  ${String(r.threshold).padStart(4)} ${exitStr.padStart(6)} ${r.stoplabel.padStart(8)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(6)}% ${r.avgPnL.toFixed(1).padStart(8)} ${r.totalPnL.toFixed(0).padStart(10)} ${r.sharpe.toFixed(3).padStart(7)} ${pfStr} ${r.maxDD.toFixed(0).padStart(7)}`);
    }
  }

  // Detailed analysis of the best 80%+ WR config
  if (high80.length > 0) {
    const best = high80[0];
    console.log(`\n\n╔══════════════════════════════════════════════════════════════════╗`);
    console.log(`║  DETAILED: Score>=${best.threshold}, exit ${best.exitHr===9.5?'9:30am':best.exitHr+'am'}, stop=${best.stoplabel}`.padEnd(66) + '║');
    console.log(`╚══════════════════════════════════════════════════════════════════╝`);

    const eligible = scoredSessions.filter(s => s.score >= best.threshold);
    const trades = eligible.map(s => {
      const t = simulateTrade(s, s.side, { stopLossPoints: best.stoplabel === 'None' ? 9999 : parseInt(best.stoplabel.split('/')[0]) || parseInt(best.stoplabel.replace('SL','')) || 9999, takeProfitPoints: best.stoplabel === 'None' ? 9999 : parseInt(best.stoplabel.split('/')[1]) || 9999, exitHourEST: best.exitHr });
      return { ...t, score: s.score, ibs: s.ibs, gexRegime: s.gexRegime, ltSentiment: s.ltSentiment, consecutiveDown: s.consecutiveDown, consecutiveUp: s.consecutiveUp };
    });

    printMetrics(computeMetrics(trades, `Score>=${best.threshold} Detailed`));

    // Long vs Short
    printMetrics(computeMetrics(trades.filter(t => t.side === 'buy'), 'LONG trades'));
    printMetrics(computeMetrics(trades.filter(t => t.side === 'sell'), 'SHORT trades'));

    // By score
    console.log('\n  By Score:');
    for (let s = best.threshold; s <= 12; s++) {
      const sub = trades.filter(t => t.score === s);
      if (sub.length > 0) {
        const m = computeMetrics(sub);
        console.log(`    Score=${s}: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avgPnL.toFixed(1)}pts, Total=${m.totalPnL.toFixed(0)}`);
      }
    }

    // By day
    console.log('\n  By Day of Week:');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      const sub = trades.filter(t => t.dayOfWeek === day);
      if (sub.length > 0) {
        const m = computeMetrics(sub);
        console.log(`    ${day.padEnd(12)}: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avgPnL.toFixed(1)}pts`);
      }
    }

    // Monthly PnL
    console.log('\n  Monthly PnL:');
    const byMonth = {};
    for (const t of trades) {
      const mo = t.date.substring(0, 7);
      if (!byMonth[mo]) byMonth[mo] = { n: 0, pnl: 0, w: 0 };
      byMonth[mo].n++;
      byMonth[mo].pnl += t.pointsPnL;
      if (t.pointsPnL > 0) byMonth[mo].w++;
    }
    let cum = 0;
    for (const [mo, d] of Object.entries(byMonth).sort()) {
      cum += d.pnl;
      const bar = d.pnl >= 0
        ? '+' + '█'.repeat(Math.min(Math.round(d.pnl / 10), 50))
        : '-' + '█'.repeat(Math.min(Math.round(-d.pnl / 10), 50));
      console.log(`    ${mo}: ${String(d.n).padStart(2)} trades, ${d.pnl.toFixed(0).padStart(6)}pts (WR ${(d.w/d.n*100).toFixed(0).padStart(3)}%), cum: ${cum.toFixed(0).padStart(7)}  ${bar}`);
    }

    // Print every trade
    console.log('\n  All trades:');
    console.log(`  ${'Date'.padEnd(12)} ${'Day'.padEnd(4)} ${'Score'.padStart(5)} ${'Side'.padEnd(5)} ${'Entry'.padStart(9)} ${'Exit'.padStart(9)} ${'PnL'.padStart(8)} ${'MFE'.padStart(6)} ${'MAE'.padStart(6)} ${'ExitReason'.padEnd(12)} ${'LT'.padEnd(8)} ${'GEX'.padEnd(16)}`);
    for (const t of trades) {
      const wr = t.pointsPnL > 0 ? '✓' : '✗';
      console.log(`  ${wr} ${t.date} ${t.dayOfWeek.substring(0,3).padEnd(4)} ${String(t.score).padStart(5)} ${t.side.padEnd(5)} ${t.entryPrice.toFixed(1).padStart(9)} ${t.exitPrice.toFixed(1).padStart(9)} ${t.pointsPnL.toFixed(1).padStart(8)} ${t.mfePoints.toFixed(0).padStart(6)} ${t.maePoints.toFixed(0).padStart(6)} ${t.exitReason.padEnd(12)} ${(t.ltSentiment||'?').padEnd(8)} ${(t.gexRegime||'?').padEnd(16)}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SCORING BACKTEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
