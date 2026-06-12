// Phase 4 — Apples-to-apples comparison vs the FCFS gold-standard portfolio.
//
// Runs BOTH the FCFS portfolio and the move-of-the-day variants through ONE metrics
// function that mirrors research/multi-strategy-rules/lib/metrics.js exactly:
//   - Sharpe = annualized (√252) from the DAILY netPnL series (sample variance, N-1)
//   - maxDD on a $100k-notional equity curve, peak-relative %
//   - $5/trade commission (COMMISSION_NQ), netPnL = pointsPnL*20 - 5
// This neutralizes the Sharpe-basis mismatch (my one-trade/day series = its own daily series).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { etParts, inRTHEntryWindow, EOD_CUTOFF_MIN } from './lib/et.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GS = path.resolve(__dirname, '../../data/gold-standard');
const FCFS_OUT = path.resolve(__dirname, '../4strategy-portfolio/output');
const CSV = path.resolve(__dirname, '../../data/ohlcv/nq/NQ_ohlcv_1s.csv');
const IDXF = path.resolve(__dirname, '../../data/ohlcv/nq/NQ_ohlcv_1s.index.json');
const PV = 20, COMMISSION = 5, STOP_SLIP = 1.5, MKT_SLIP = 1.0, NOTIONAL = 100000;

// ---------- shared metrics (mirror of calculateMetrics) ----------
// trades: [{ netPnL, dayKey:'YYYY-MM-DD', sortKey:number|string }]
function book(trades) {
  if (!trades.length) return { trades: 0 };
  const sorted = [...trades].sort((a, b) => (a.sortKey > b.sortKey ? 1 : a.sortKey < b.sortKey ? -1 : 0));
  const winners = sorted.filter(t => t.netPnL > 0), losers = sorted.filter(t => t.netPnL <= 0);
  const grossProfit = winners.reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.netPnL, 0));
  let eq = NOTIONAL, peak = NOTIONAL, maxDDusd = 0, maxDDpct = 0;
  for (const t of sorted) {
    eq += t.netPnL; if (eq > peak) peak = eq;
    const ddu = peak - eq; if (ddu > maxDDusd) maxDDusd = ddu;
    const ddp = peak > 0 ? ddu / peak * 100 : 0; if (ddp > maxDDpct) maxDDpct = ddp;
  }
  const byDay = new Map();
  for (const t of sorted) byDay.set(t.dayKey, (byDay.get(t.dayKey) || 0) + t.netPnL);
  const daily = [...byDay.values()];
  let sharpe = 0;
  if (daily.length > 1) {
    const mean = daily.reduce((s, x) => s + x, 0) / daily.length;
    const variance = daily.reduce((s, x) => s + (x - mean) ** 2, 0) / (daily.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std === 0 ? 0 : (mean / std) * Math.sqrt(252);
  }
  return {
    trades: sorted.length, tradingDays: byDay.size,
    totalPnL: Math.round(grossProfit - grossLoss),
    perTrade: Math.round((grossProfit - grossLoss) / sorted.length),
    winRate: +(winners.length / sorted.length * 100).toFixed(1),
    profitFactor: grossLoss === 0 ? Infinity : +(grossProfit / grossLoss).toFixed(2),
    sharpe: +sharpe.toFixed(2),
    maxDDusd: Math.round(maxDDusd), maxDDpct: +maxDDpct.toFixed(2),
  };
}
const row = (label, m) => `${label.padEnd(34)} ${String(m.trades).padStart(5)} ${String('$' + m.totalPnL.toLocaleString()).padStart(11)} ${String('$' + m.perTrade).padStart(7)}/t  PF ${String(m.profitFactor).padStart(5)}  Sh ${String(m.sharpe).padStart(6)}  DD ${String(m.maxDDpct + '%').padStart(7)} ($${m.maxDDusd.toLocaleString()})  WR ${m.winRate}%  d=${m.tradingDays}`;

// ---------- load FCFS portfolio trades from CSV ----------
function loadFcfsCsv(file) {
  const lines = fs.readFileSync(path.join(FCFS_OUT, file), 'utf8').trim().split('\n');
  const trades = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const exitEt = c[5];                  // 'YYYY-MM-DD HH:MM:SS' ET
    trades.push({ netPnL: +c[8], dayKey: exitEt.slice(0, 10), sortKey: exitEt });
  }
  return trades;
}

// ---------- move-of-the-day picks + 1s exit sims (capture exit day) ----------
function loadTrades(file, strat) {
  const j = JSON.parse(fs.readFileSync(path.join(GS, file), 'utf8'));
  return (j.trades || []).map(t => {
    const sig = t.signal || {};
    const side = (t.side === 'buy' || t.side === 'long') ? 'long' : 'short';
    const entryTs = t.entryTime ?? sig.timestamp ?? t.timestamp;
    return { strat, side, entryTs, entryPrice: t.entryPrice ?? t.actualEntry ?? sig.price,
      initStop: t.stopLoss ?? sig.stopLoss, contract: t.signalContract ?? sig.signalContract,
      ownPnL: t.pointsPnL, ownExitTs: t.exitTime };
  }).filter(t => t.entryTs && t.contract && t.initStop != null && inRTHEntryWindow(t.entryTs));
}
const glxgfi = [...loadTrades('gex-lt-3m-crossover-v3.json', 'glx'),
                ...loadTrades('gex-flip-ivpct-v2.json', 'gfi')].sort((a, b) => a.entryTs - b.entryTs);
const pickByDay = new Map();
for (const c of glxgfi) { const d = etParts(c.entryTs).dateET; if (!pickByDay.has(d)) pickByDay.set(d, c); }
const picks = [...pickByDay.values()].sort((a, b) => a.entryTs - b.entryTs);

// 1s reader
const idx = JSON.parse(fs.readFileSync(IDXF, 'utf8')).minutes;
const fd = fs.openSync(CSV, 'r');
function readBars(p) {
  const startMin = Math.floor(p.entryTs / 60000) * 60000, dateET = etParts(p.entryTs).dateET, bars = [];
  for (let m = startMin, g = 0; g < 480; m += 60000, g++) {
    const meta = idx[m]; if (!meta) continue;
    const et = etParts(m); if (et.minutesOfDay > EOD_CUTOFF_MIN || et.dateET !== dateET) break;
    const buf = Buffer.allocUnsafe(meta.length); fs.readSync(fd, buf, 0, meta.length, meta.offset);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue; const c = line.split(',');
      if (c[9] !== p.contract) continue;
      const ts = Date.parse(c[0]); if (ts < p.entryTs) continue;
      const high = +c[5], low = +c[6], open = +c[4];
      if (isFinite(high) && isFinite(low)) bars.push({ ts, open, high, low });
    }
  }
  bars.sort((a, b) => a.ts - b.ts); return bars;
}
for (const p of picks) p._bars = readBars(p);
fs.closeSync(fd);

// exit sims → {pts, exitTs}
function simFixed(p, T) {
  const bars = p._bars; if (!bars.length) return { pts: p.ownPnL, exitTs: p.ownExitTs };
  const long = p.side === 'long', e = p.entryPrice, stop = p.initStop, tgt = long ? e + T : e - T;
  for (const b of bars) {
    if (long) { if (b.low <= stop) return { pts: stop - STOP_SLIP - e, exitTs: b.ts }; if (b.high >= tgt) return { pts: tgt - e, exitTs: b.ts }; }
    else { if (b.high >= stop) return { pts: e - stop - STOP_SLIP, exitTs: b.ts }; if (b.low <= tgt) return { pts: e - tgt, exitTs: b.ts }; }
  }
  const l = bars[bars.length - 1]; return { pts: long ? l.open - MKT_SLIP - e : e - l.open - MKT_SLIP, exitTs: l.ts };
}
function simEOD(p) {
  const bars = p._bars; if (!bars.length) return { pts: p.ownPnL, exitTs: p.ownExitTs };
  const long = p.side === 'long', e = p.entryPrice, stop = p.initStop;
  for (const b of bars) { if (long && b.low <= stop) return { pts: stop - STOP_SLIP - e, exitTs: b.ts }; if (!long && b.high >= stop) return { pts: e - stop - STOP_SLIP, exitTs: b.ts }; }
  const l = bars[bars.length - 1]; return { pts: long ? l.open - MKT_SLIP - e : e - l.open - MKT_SLIP, exitTs: l.ts };
}
const toTrade = (pts, exitTs) => ({ netPnL: Math.round(pts * PV) - COMMISSION, dayKey: etParts(exitTs).dateET, sortKey: exitTs });
const ownTrades   = picks.map(p => toTrade(p.ownPnL, p.ownExitTs));
const t150Trades  = picks.map(p => { const r = simFixed(p, 150); return toTrade(r.pts, r.exitTs); });
const eodTrades   = picks.map(p => { const r = simEOD(p); return toTrade(r.pts, r.exitTs); });

// also: "first ANY signal/day" naive baseline (uses all 4 strats, own exits) for context
const allSessions = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'output/sessions.json'), 'utf8'));
const firstAny = Object.keys(allSessions).sort().map(d => {
  const s = [...allSessions[d]].sort((a, b) => a.entryTs - b.entryTs)[0];
  return toTrade(s.outcome.pointsPnL, s.outcome.exitTs ?? s.entryTs);
});

// ---------- report ----------
console.log('═══════════════════════════════════════════════════════════════════════════════════');
console.log('  COMPARISON — same metrics engine (daily √252 Sharpe, $100k-notional DD, $5 comm)');
console.log('═══════════════════════════════════════════════════════════════════════════════════');
console.log('label                              trades       totalPnL    $/trade   PF      Sharpe    DD%            WR    days\n');
console.log('  ── FCFS gold-standard portfolio (many trades/day) ──');
console.log(' ', row('4-strat FCFS (WITH lstb)', book(loadFcfsCsv('A-with-lstb-trades.csv'))));
console.log(' ', row('3-strat FCFS (WITHOUT lstb)', book(loadFcfsCsv('B-without-lstb-trades.csv'))));
console.log('\n  ── Move-of-the-day (ONE trade/day, RTH) ──');
console.log(' ', row('first ANY signal/day (naive)', book(firstAny)));
console.log(' ', row('first glx+gfi, own exit', book(ownTrades)));
console.log(' ', row('first glx+gfi, target 150pt', book(t150Trades)));
console.log(' ', row('first glx+gfi, hold-to-EOD', book(eodTrades)));
