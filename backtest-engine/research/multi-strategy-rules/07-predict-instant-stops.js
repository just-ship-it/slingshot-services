#!/usr/bin/env node
// 07: For every potential portfolio trade entry, compute the state of the OTHER two
// strategies at signal time (knowable LIVE: open? side? duration so far?). Then look
// for entry-time features that predict <5-min stop-outs.
//
// Drew's constraint: instant stop-outs lock in the full loss within minutes — a
// time-stop after entry doesn't help. The only useful filter is one that blocks
// the entry in the first place.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAll, STRATEGIES, priorityFor } from './lib/load-trades.js';
import { calculateMetrics, fmtUsd, round } from './lib/metrics.js';
import { fmtET, fmtETMonth } from './lib/et-time.js';
import { writeCsv } from './lib/csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');

function pad(s, n) { return String(s).padEnd(n); }
function hourET(ms) { return parseInt(fmtET(ms).slice(11, 13), 10); }

function isInstantStop(trade) {
  return (trade.exitTime - trade.entryTime) < 5 * 60000 && trade.netPnL <= 0;
}

// Run first-in-wins. For each ACCEPTED entry, also compute:
// - For each other strategy at signal time: { open: bool, side, ageMin } if open, else null
function simulateAndCapture(allTrades, byKey) {
  const events = [];
  for (const t of allTrades) {
    events.push({ ts: t.entryTime, kind: 'entry-signal', trade: t });
    events.push({ ts: t.exitTime,  kind: 'native-exit',  trade: t });
  }
  events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.trade.id === b.trade.id) return a.kind === 'entry-signal' ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'native-exit' ? -1 : 1;
    if (a.kind === 'entry-signal') return priorityFor(a.trade.strategyKey) - priorityFor(b.trade.strategyKey);
    return 0;
  });

  // Track each strategy's currently-open NATIVE trade (independent of portfolio slot).
  // i.e., what would each strategy be doing if it ran alone.
  const nativeActive = new Map();  // strategyKey -> open native trade
  const portfolioTrades = [];
  let position = null;

  for (const ev of events) {
    if (ev.kind === 'entry-signal') {
      // Snapshot the state of all OTHER strategies BEFORE updating nativeActive.
      const otherState = {};
      for (const def of STRATEGIES) {
        if (def.key === ev.trade.strategyKey) continue;
        const open = nativeActive.get(def.key);
        if (open) {
          otherState[def.key] = {
            open: true,
            side: open.side,
            ageMin: (ev.ts - open.entryTime) / 60000,
            sameSideAsNew: open.side === ev.trade.side,
          };
        } else {
          otherState[def.key] = { open: false };
        }
      }
      // Now update this strategy's native active.
      nativeActive.set(ev.trade.strategyKey, ev.trade);

      // First-in-wins decision: take if slot is empty.
      if (position == null) {
        position = ev.trade;
        portfolioTrades.push({
          ...ev.trade,
          otherState,
          accepted: true,
        });
      }
    } else {
      // native-exit
      const curr = nativeActive.get(ev.trade.strategyKey);
      if (curr && curr.id === ev.trade.id) nativeActive.delete(ev.trade.strategyKey);
      if (position && position.id === ev.trade.id) position = null;
    }
  }
  return portfolioTrades;
}

function statsForGroup(trades) {
  if (trades.length === 0) return { n: 0, instantStops: 0, instantStopRate: 0, totalPnL: 0, wr: 0, avgPnl: 0, pf: 0 };
  const instant = trades.filter(isInstantStop);
  const wins = trades.filter(t => t.netPnL > 0);
  const losses = trades.filter(t => t.netPnL <= 0);
  const gp = wins.reduce((s, t) => s + t.netPnL, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.netPnL, 0));
  return {
    n: trades.length,
    instantStops: instant.length,
    instantStopRate: (instant.length / trades.length) * 100,
    instantStopPnL: instant.reduce((s, t) => s + t.netPnL, 0),
    totalPnL: gp - gl,
    wr: (wins.length / trades.length) * 100,
    avgPnl: (gp - gl) / trades.length,
    pf: gl === 0 ? (gp > 0 ? Infinity : 0) : gp / gl,
  };
}

function reportGroupBy(label, trades, keyFn, sortFn) {
  const groups = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const rows = [...groups.entries()].map(([k, ts]) => ({ key: k, ...statsForGroup(ts) }));
  rows.sort(sortFn || ((a, b) => String(a.key).localeCompare(String(b.key))));
  console.log();
  console.log(`── ${label} ──`);
  console.log('  ' + pad('key', 36) + pad('n', 6) + pad('inst.stops', 12) + pad('inst.rate', 11) + pad('inst.PnL', 12) + pad('totalPnL', 12) + pad('WR%', 7));
  for (const r of rows) {
    console.log('  ' +
      pad(r.key, 36) +
      pad(r.n, 6) +
      pad(r.instantStops, 12) +
      pad(r.instantStopRate.toFixed(1) + '%', 11) +
      pad(fmtUsd(r.instantStopPnL), 12) +
      pad(fmtUsd(r.totalPnL), 12) +
      pad(r.wr.toFixed(1), 7));
  }
  return rows;
}

export function main() {
  const { byKey, allFlat } = loadAll();
  const trades = simulateAndCapture(allFlat, byKey);

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Step 07: Predicting instant stop-outs from entry-time state');
  console.log('═══════════════════════════════════════════════════════════════════');
  const overall = statsForGroup(trades);
  console.log();
  console.log(`Baseline: ${overall.n} trades, ${overall.instantStops} instant stops (${overall.instantStopRate.toFixed(1)}%), instant stops cost ${fmtUsd(overall.instantStopPnL)}, total PnL ${fmtUsd(overall.totalPnL)}`);

  // ── Feature: what is the SAME strategy's other-strategies state at entry? ──
  // For each accepted entry, characterize the state of the OTHER 2 strategies.
  for (const t of trades) {
    const others = STRATEGIES.filter(s => s.key !== t.strategyKey);
    const sA = t.otherState[others[0].key];
    const sB = t.otherState[others[1].key];
    const openSame = [sA, sB].filter(s => s.open && s.sameSideAsNew).length;
    const openOpp  = [sA, sB].filter(s => s.open && !s.sameSideAsNew).length;
    t.openSame = openSame;
    t.openOpp = openOpp;
    t.anyOpen = openSame + openOpp;
    t.signedState = openSame > 0 && openOpp === 0 ? 'confluence' :
                    openOpp  > 0 && openSame === 0 ? 'conflict' :
                    openSame > 0 && openOpp > 0    ? 'mixed' :
                    'flat-others';
    t.hourET = hourET(t.entryTime);
  }

  reportGroupBy('By origin strategy', trades, t => t.strategyKey);
  reportGroupBy('By signed state of other strategies at entry', trades, t => t.signedState);
  reportGroupBy('By origin × signed state', trades, t => `${t.strategyKey} / ${t.signedState}`);
  reportGroupBy('By origin × side × signed state', trades, t => `${t.strategyKey} / ${t.side} / ${t.signedState}`);

  // ── Critical: for level-fade specifically, when does it fail vs succeed?  ──
  const fade = trades.filter(t => t.strategyKey === 'gex-level-fade');
  console.log();
  console.log('═══ Deep dive: gex-level-fade entries (the instant-stop source) ═══');
  console.log(`  total level-fade entries kept by first-in-wins: ${fade.length}`);
  reportGroupBy('  level-fade × signed state', fade, t => t.signedState);
  reportGroupBy('  level-fade × side × signed state', fade, t => `${t.side} / ${t.signedState}`);
  reportGroupBy('  level-fade × hour', fade, t => String(t.hourET).padStart(2,'0'),
    (a, b) => parseInt(a.key) - parseInt(b.key));
  reportGroupBy('  level-fade × hour × signed state', fade, t => `${String(t.hourET).padStart(2,'0')} / ${t.signedState}`,
    (a, b) => a.key.localeCompare(b.key));

  // Look at concurrent OPEN strategy at the moment of level-fade entry: WHICH strategy?
  for (const t of fade) {
    const others = STRATEGIES.filter(s => s.key !== t.strategyKey);
    const openSameWith = [];
    const openOppWith = [];
    for (const o of others) {
      const s = t.otherState[o.key];
      if (!s.open) continue;
      if (s.sameSideAsNew) openSameWith.push(o.key);
      else openOppWith.push(o.key);
    }
    t.openSameWith = openSameWith.join('+') || 'none';
    t.openOppWith = openOppWith.join('+') || 'none';
  }
  reportGroupBy('  level-fade × which-other-strategy-is-LONG-when-we-go-SHORT', fade.filter(t => t.side === 'short'),
    t => t.openSameWith === 'none' && t.openOppWith === 'none' ? 'all flat' :
         t.openOppWith !== 'none' ? `opp-side open: ${t.openOppWith}` :
         t.openSameWith !== 'none' ? `same-side open: ${t.openSameWith}` : 'mixed');
  reportGroupBy('  level-fade × which-other-strategy-is-SHORT-when-we-go-LONG', fade.filter(t => t.side === 'long'),
    t => t.openSameWith === 'none' && t.openOppWith === 'none' ? 'all flat' :
         t.openOppWith !== 'none' ? `opp-side open: ${t.openOppWith}` :
         t.openSameWith !== 'none' ? `same-side open: ${t.openSameWith}` : 'mixed');

  // ── Filter experiments: what happens if we REJECT level-fade entries when fighting? ──
  console.log();
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  Entry-gate experiments — what if we REJECT at signal time?');
  console.log('══════════════════════════════════════════════════════════════════');

  function gate(label, predicate) {
    const kept = trades.filter(t => !predicate(t));
    const dropped = trades.filter(t => predicate(t));
    const droppedInstant = dropped.filter(isInstantStop);
    const m = calculateMetrics(kept);
    console.log();
    console.log(`  ${label}`);
    console.log(`    dropped ${dropped.length} entries (${droppedInstant.length} instant stops worth ${fmtUsd(droppedInstant.reduce((s, t) => s + t.netPnL, 0))})`);
    console.log(`    overall: total ${fmtUsd(dropped.reduce((s, t) => s + t.netPnL, 0))} of dropped PnL`);
    console.log(`    kept ${m.trades}: PnL=${fmtUsd(m.totalPnL)} (${m.totalPnL >= overall.totalPnL ? '+' : ''}${fmtUsd(m.totalPnL - overall.totalPnL)} vs base), PF=${m.profitFactor.toFixed(2)}, Sharpe=${m.sharpe.toFixed(2)}, DD%=${m.maxDD_pct.toFixed(2)} (${fmtUsd(m.maxDD_usd)}), WR=${m.winRate.toFixed(1)}%`);
  }

  gate('GATE-1) reject level-fade when ANY other strategy has opposite-side position open',
    t => t.strategyKey === 'gex-level-fade' && t.openOpp > 0);
  gate('GATE-2) reject level-fade when ANY other strategy has same-side position open (we are confirming the move we are trying to fade)',
    t => t.strategyKey === 'gex-level-fade' && t.openSame > 0);
  gate('GATE-3) reject any trade when 2 others have an opposite-side position open',
    t => t.openOpp >= 2);
  gate('GATE-4) reject lt-3m when level-fade has opposite side open',
    t => t.strategyKey === 'gex-lt-3m' && t.openOpp > 0);
  gate('GATE-5) reject any strategy when ANY other strategy has opp-side position open',
    t => t.openOpp > 0);
  gate('GATE-6) reject any trade when ANY other strategy has SAME-side position open already (this is the inverse of confluence-only)',
    t => t.openSame > 0);

  // Pre-existing "open NATIVE position" gating: i.e., even though the slot is empty,
  // we shouldn't enter if another strategy is already holding a native opposite-side trade.
  gate('GATE-7) FOCUSED: reject level-fade SHORT entries when EITHER other strategy is currently LONG-native',
    t => t.strategyKey === 'gex-level-fade' && t.side === 'short' && t.openOpp > 0);
  gate('GATE-8) FOCUSED: reject level-fade LONG entries when EITHER other strategy is currently SHORT-native',
    t => t.strategyKey === 'gex-level-fade' && t.side === 'long' && t.openOpp > 0);

  // What if we filter level-fade by hour AND by other-strategies state?
  gate('GATE-9) reject level-fade entries 09 ET when other strategies are in opposite-side',
    t => t.strategyKey === 'gex-level-fade' && t.hourET === 9 && t.openOpp > 0);
  gate('GATE-10) reject level-fade in 09-10 ET when other strategies are in opposite-side',
    t => t.strategyKey === 'gex-level-fade' && (t.hourET === 9 || t.hourET === 10) && t.openOpp > 0);

  // Write feature CSV for downstream eyeballing.
  const HDR = ['entry_et','strategyKey','side','netPnL','durationMin','instant','hourET','signedState','openSame','openOpp','openSameWith','openOppWith'];
  const rows = trades.map(t => ({
    entry_et: fmtET(t.entryTime),
    strategyKey: t.strategyKey,
    side: t.side,
    netPnL: round(t.netPnL),
    durationMin: round((t.exitTime - t.entryTime) / 60000, 1),
    instant: isInstantStop(t) ? 1 : 0,
    hourET: t.hourET,
    signedState: t.signedState,
    openSame: t.openSame,
    openOpp: t.openOpp,
    openSameWith: t.openSameWith ?? 'none',
    openOppWith: t.openOppWith ?? 'none',
  }));
  writeCsv(path.join(OUT_DIR, 'instant-stop-prediction.csv'), HDR, rows);
  console.log();
  console.log('✓ Wrote output/instant-stop-prediction.csv');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
