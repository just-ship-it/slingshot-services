#!/usr/bin/env node
// Audit: how does the deployed 4-strategy FCFS book behave on trades that were
// HELD ACROSS a major economic-event release instant?
//
// "Held into an event" = position OPEN at the release timestamp, i.e.
//   entryTime <= release_ts_ms <= exitTime   (entered before, exited after).
//
// We reproduce the live book = the "WITH lstb" FCFS scenario (single 1-NQ slot,
// first-in-wins) exactly as research/4strategy-portfolio/run.js does, then split
// the realized trades into:
//   - EVENT trades   : held across >=1 event release
//   - NON-EVENT trades: no event release during the hold
// and compare WR / PF / Sharpe / DD / avg-PnL, plus a per-event-type breakdown
// and a two-proportion z-test on win rate.
//
// Run:  node 02-audit-fcfs.js
// Depends on 01-build-event-calendar.js having written output/event-calendar.csv.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics, fmtUsd, round, proportionZTest } from '../multi-strategy-rules/lib/metrics.js';
import { fmtET } from '../multi-strategy-rules/lib/et-time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..', '..');
const OUT_DIR   = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

const POINT_VALUE_NQ = 20;
const COMMISSION_NQ  = 5;

// Same registry/priority as the live FCFS book (4strategy-portfolio/run.js).
const STRATEGIES = [
  { key: 'lstb',           file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m',      file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];

function normSide(s) {
  if (!s) return null;
  const l = String(s).toLowerCase();
  if (l === 'long' || l === 'buy') return 'long';
  if (l === 'short' || l === 'sell') return 'short';
  return null;
}

function normalize(trade, strategyKey) {
  const entryTime = trade.entryTime;
  const rawExit   = trade.exitTime ?? (entryTime + (trade.duration ?? 0));
  const exitTime  = rawExit <= entryTime ? entryTime + 1 : rawExit;
  return {
    id: `${strategyKey}:${trade.id}`,
    nativeId: trade.id,
    strategyKey,
    side: normSide(trade.side),
    entryTime,
    exitTime,
    duration: trade.duration ?? (exitTime - entryTime),
    actualEntry: trade.actualEntry ?? trade.entryPrice,
    actualExit: trade.actualExit,
    netPnL: trade.netPnL,
    pointsPnL: trade.pointsPnL,
    exitReason: trade.exitReason,
    commission: trade.commission ?? COMMISSION_NQ,
    pointValue: trade.pointValue ?? POINT_VALUE_NQ,
    status: trade.status,
  };
}

function loadStrategy(def) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  return raw.trades
    .filter(t => t.status === 'completed')
    .filter(t => t.entryTime != null && t.exitTime != null)
    .filter(t => normSide(t.side) != null)
    .map(t => normalize(t, def.key));
}

const firstInWins = {
  name: 'first-in-wins',
  onSignal(state, trade) {
    if (state.position == null) open(state, trade);
    else reject(state);
  },
  onNativeExit(state, trade) {
    if (state.position && state.position.trade.id === trade.id) {
      realizeNativeClose(state, trade);
    }
  },
};

// ── Load event calendar ─────────────────────────────────────────────────────
function loadEvents() {
  const csv = fs.readFileSync(path.join(OUT_DIR, 'event-calendar.csv'), 'utf8').trim().split('\n');
  const hdr = csv[0].split(',');
  const iType = hdr.indexOf('event_type');
  const iTs   = hdr.indexOf('release_ts_ms');
  const iDate = hdr.indexOf('date');
  return csv.slice(1).map(line => {
    const c = line.split(',');
    return { type: c[iType], ts: Number(c[iTs]), date: c[iDate] };
  }).sort((a, b) => a.ts - b.ts);
}

// Tag a trade with the events whose release instant falls within its hold.
function eventsDuringHold(trade, events) {
  const hit = [];
  for (const e of events) {
    if (e.ts < trade.entryTime) continue;
    if (e.ts > trade.exitTime) break;        // events sorted asc → no later event can match
    hit.push(e);
  }
  return hit;
}

function pct(n, d) { return d ? round((n / d) * 100, 1) : 0; }

function printMetricsRow(label, m) {
  console.log('  ' +
    label.padEnd(26) +
    String(m.trades).padEnd(8) +
    `${round(m.winRate, 1)}%`.padEnd(8) +
    round(m.profitFactor, 2).toString().padEnd(7) +
    round(m.sharpe, 2).toString().padEnd(8) +
    `${round(m.maxDD_pct, 2)}%`.padEnd(8) +
    fmtUsd(m.avgPnL).padEnd(10) +
    fmtUsd(m.totalPnL).padEnd(13));
}

function main() {
  // Reproduce live book.
  const all = [];
  for (const def of STRATEGIES) all.push(...loadStrategy(def));
  all.sort((a, b) => a.entryTime - b.entryTime);
  const state = simulate(all, firstInWins);
  const realized = state.realizedTrades;

  const events = loadEvents();
  // Clip events to the book's traded span so per-type "n events" is meaningful.
  const spanLo = Math.min(...realized.map(t => t.entryTime));
  const spanHi = Math.max(...realized.map(t => t.exitTime));
  const eventsInSpan = events.filter(e => e.ts >= spanLo && e.ts <= spanHi);

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Event-Positioning Audit — 4-strat FCFS book (deployed, WITH lstb)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Book span: ${fmtET(spanLo).slice(0,10)} → ${fmtET(spanHi).slice(0,10)}   realized trades: ${realized.length}`);
  console.log(`  Events in span: ${eventsInSpan.length}`);
  console.log();

  // Tag each realized trade.
  const eventTrades = [];
  const nonEventTrades = [];
  const heldByType = {};   // type -> trades held across >=1 of that type
  for (const t of realized) {
    const hit = eventsDuringHold(t, eventsInSpan);
    t._events = hit;
    if (hit.length) {
      eventTrades.push(t);
      const types = new Set(hit.map(e => e.type));
      for (const ty of types) (heldByType[ty] ||= []).push(t);
    } else {
      nonEventTrades.push(t);
    }
  }

  const mAll   = calculateMetrics(realized);
  const mEvent = calculateMetrics(eventTrades);
  const mNon   = calculateMetrics(nonEventTrades);

  console.log('  ' + 'group'.padEnd(26) + 'trades'.padEnd(8) + 'WR'.padEnd(8) + 'PF'.padEnd(7) + 'Sharpe'.padEnd(8) + 'maxDD'.padEnd(8) + 'avgPnL'.padEnd(10) + 'totalPnL'.padEnd(13));
  printMetricsRow('ALL (book)', mAll);
  printMetricsRow('held-into-event', mEvent);
  printMetricsRow('no-event-during-hold', mNon);
  console.log();

  // Win-rate significance: event vs non-event.
  const zt = proportionZTest(mEvent.winners, mEvent.trades, mNon.winners, mNon.trades);
  console.log(`  Event vs non-event WR: ${round(mEvent.winRate,1)}% vs ${round(mNon.winRate,1)}%  ` +
              `(z=${round(zt.z,2)}, p=${round(zt.p,3)}${zt.p < 0.05 ? '  *significant*' : ''})`);
  console.log(`  Event trades are ${pct(eventTrades.length, realized.length)}% of the book by count, ` +
              `${pct(mEvent.totalPnL, mAll.totalPnL)}% of total PnL.`);
  console.log();

  // ── Per-event-type breakdown (a trade can appear under multiple types) ─────
  console.log('  Per-event-type (trades HELD ACROSS that release):');
  console.log('  ' + 'event'.padEnd(10) + '#evts'.padEnd(7) + 'trades'.padEnd(8) + 'WR'.padEnd(8) + 'PF'.padEnd(7) + 'avgPnL'.padEnd(10) + 'totalPnL'.padEnd(13));
  const typeOrder = ['FOMC','CPI','NFP','PCE','PPI','GDP','RETAIL'];
  const evtCountByType = {};
  for (const e of eventsInSpan) evtCountByType[e.type] = (evtCountByType[e.type] || 0) + 1;
  for (const ty of typeOrder) {
    const ts = heldByType[ty] || [];
    const m = calculateMetrics(ts);
    console.log('  ' +
      ty.padEnd(10) +
      String(evtCountByType[ty] || 0).padEnd(7) +
      String(m.trades).padEnd(8) +
      `${round(m.winRate,1)}%`.padEnd(8) +
      round(m.profitFactor,2).toString().padEnd(7) +
      fmtUsd(m.avgPnL).padEnd(10) +
      fmtUsd(m.totalPnL).padEnd(13));
  }
  console.log();

  // ── Per-strategy: which strategies hold into events most? ──────────────────
  console.log('  Held-into-event trades by origin strategy:');
  console.log('  ' + 'strategy'.padEnd(18) + 'evt-trades'.padEnd(12) + 'evt-PnL'.padEnd(13) + 'evt-WR'.padEnd(8) + 'nonevt-WR'.padEnd(10));
  for (const def of STRATEGIES) {
    const evt = eventTrades.filter(t => t.strategyKey === def.key);
    const non = nonEventTrades.filter(t => t.strategyKey === def.key);
    const me = calculateMetrics(evt), mn = calculateMetrics(non);
    console.log('  ' +
      def.key.padEnd(18) +
      String(evt.length).padEnd(12) +
      fmtUsd(me.totalPnL).padEnd(13) +
      `${round(me.winRate,1)}%`.padEnd(8) +
      `${round(mn.winRate,1)}%`.padEnd(10));
  }
  console.log();

  // ── Counterfactual: book WITHOUT the held-into-event trades ────────────────
  // (Crude proxy for "flatten before every event" — removes those trades' PnL.
  //  Not a true re-sim, since freeing the slot earlier could admit other trades,
  //  but bounds the first-order effect.)
  console.log(`  Counterfactual (drop all held-into-event trades, no re-sim):`);
  console.log(`    book PnL ${fmtUsd(mAll.totalPnL)}  →  ${fmtUsd(mNon.totalPnL)}  ` +
              `(Δ ${fmtUsd(mNon.totalPnL - mAll.totalPnL)}), maxDD ${round(mAll.maxDD_pct,2)}% → ${round(mNon.maxDD_pct,2)}%`);
  console.log();

  // ── Write tagged trade CSV ─────────────────────────────────────────────────
  const HDR = ['strategyKey','nativeId','side','entry_et','exit_et','durationMin','netPnL','exitReason','heldEvents','eventTypes'];
  const lines = [HDR.join(',')];
  for (const t of realized) {
    lines.push([
      t.strategyKey, t.nativeId, t.side,
      fmtET(t.entryTime), fmtET(t.exitTime),
      round((t.duration || 0) / 60000, 1),
      round(t.netPnL),
      t.exitReason,
      t._events.length,
      `"${[...new Set(t._events.map(e => e.type))].join('|')}"`,
    ].join(','));
  }
  const outPath = path.join(OUT_DIR, 'fcfs-trades-event-tagged.csv');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`✓ Wrote ${outPath} (${realized.length} rows)`);
}

main();
