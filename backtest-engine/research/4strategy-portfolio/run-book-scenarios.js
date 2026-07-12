#!/usr/bin/env node
// Honest post-cleanup book scenarios (2026-07-11), Jan 2025 - Apr 2026 window.
// Question (Drew): what do GLX / +LSTB / +GLF combinations really look like on
// the single 1-NQ slot with gfi gone — including worst single DAY and worst
// calendar WEEK — and does v1-ES-causal add anything on top?
//
// Realized PnL is attributed to the trade's EXIT date (ET). Week = ISO Monday.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { calculateMetrics, fmtUsd, round } from '../multi-strategy-rules/lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const FILES = {
  lstb: 'data/gold-standard/ls-flip-trigger-bar-v3.json',
  glx:  'data/gold-standard/gex-lt-3m-crossover-v3.json',
  glf:  'data/gold-standard/gex-level-fade-v2.json',
  v1es: 'data/gold-standard/lt-gex-path-race-v1-es-causal.json',
  lstbA: 'data/gold-standard/ls-flip-trigger-bar-v3-ltalign.json',
};

function normSide(s) {
  const l = String(s || '').toLowerCase();
  return l === 'long' || l === 'buy' ? 'long' : l === 'short' || l === 'sell' ? 'short' : null;
}

function loadTrades(key) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, FILES[key]), 'utf8'));
  return raw.trades
    .filter(t => t.status === 'completed' && t.entryTime != null && t.exitTime != null && normSide(t.side))
    .map(t => ({
      id: `${key}:${t.id}`, nativeId: t.id, strategyKey: key,
      side: normSide(t.side),
      entryTime: t.entryTime,
      exitTime: t.exitTime <= t.entryTime ? t.entryTime + 1 : t.exitTime,
      duration: t.duration ?? (t.exitTime - t.entryTime),
      actualEntry: t.actualEntry ?? t.entryPrice, actualExit: t.actualExit,
      netPnL: t.netPnL, pointsPnL: t.pointsPnL, exitReason: t.exitReason,
      commission: t.commission ?? 5, pointValue: t.pointValue ?? 20,
      status: t.status,
    }));
}

const firstInWins = {
  name: 'first-in-wins',
  onSignal(state, trade) {
    if (state.position == null) open(state, trade);
    else reject(state);
  },
  onNativeExit(state, trade) {
    if (state.position && state.position.trade.id === trade.id) realizeNativeClose(state, trade);
  },
};

function etDateOf(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isoWeekOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;          // Mon=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);          // week's Monday
}

function scenario(keys, pools, winStart, winEnd, label) {
  const pool = keys.flatMap(k => pools[k])
    .filter(t => t.entryTime >= winStart && t.entryTime <= winEnd)
    .sort((a, b) => a.entryTime - b.entryTime);
  const state = simulate(pool, firstInWins);
  const rt = state.realizedTrades;
  const m = calculateMetrics(rt);

  const daily = new Map();
  for (const t of rt) {
    const d = etDateOf(t.exitTime);
    daily.set(d, (daily.get(d) || 0) + t.netPnL);
  }
  const weekly = new Map();
  for (const [d, v] of daily) {
    const w = isoWeekOf(d);
    weekly.set(w, (weekly.get(w) || 0) + v);
  }
  const worstDay = [...daily.entries()].sort((a, b) => a[1] - b[1])[0] || ['-', 0];
  const worstWeek = [...weekly.entries()].sort((a, b) => a[1] - b[1])[0] || ['-', 0];
  const negDays = [...daily.values()].filter(v => v < 0).length;

  const byOrigin = {};
  for (const t of rt) {
    (byOrigin[t.strategyKey] ??= { n: 0, pnl: 0 }).n++;
    byOrigin[t.strategyKey].pnl += t.netPnL;
  }

  console.log(`\n=== ${label} ===`);
  console.log(
    `n=${m.trades} pnl=${fmtUsd(m.totalPnL)} PF=${round(m.profitFactor, 2)} ` +
    `WR=${round(m.winRate, 1)}% Sharpe=${round(m.sharpe, 2)} ` +
    `maxDD=${fmtUsd(m.maxDD_usd)} (${round(m.maxDD_pct, 2)}%)`);
  console.log(
    `worstDay=${fmtUsd(worstDay[1])} (${worstDay[0]})  ` +
    `worstWeek=${fmtUsd(worstWeek[1])} (wk of ${worstWeek[0]})  ` +
    `negDays=${negDays}/${daily.size}`);
  for (const [k, v] of Object.entries(byOrigin)) {
    console.log(`  ${k.padEnd(6)} n=${String(v.n).padStart(4)} pnl=${fmtUsd(v.pnl)}`);
  }
  return m;
}

const pools = Object.fromEntries(Object.keys(FILES).map(k => [k, loadTrades(k)]));
const bookAll = ['lstb', 'glx', 'glf'].flatMap(k => pools[k]);
const winStart = Math.min(...bookAll.map(t => t.entryTime));
const winEnd = Math.max(...bookAll.map(t => t.entryTime));
console.log(`window: ${new Date(winStart).toISOString()} → ${new Date(winEnd).toISOString()}`);
for (const k of Object.keys(pools)) {
  const inWin = pools[k].filter(t => t.entryTime >= winStart && t.entryTime <= winEnd);
  console.log(`  ${k}: ${pools[k].length} trades, ${inWin.length} in window`);
}

scenario(['glx'], pools, winStart, winEnd, 'GLX alone');
scenario(['lstb'], pools, winStart, winEnd, 'LSTB alone');
scenario(['glf'], pools, winStart, winEnd, 'GLF alone');
scenario(['glx', 'lstb'], pools, winStart, winEnd, 'GLX + LSTB');
scenario(['glx', 'glf'], pools, winStart, winEnd, 'GLX + GLF');
scenario(['glx', 'lstb', 'glf'], pools, winStart, winEnd, 'GLX + LSTB + GLF (clean book)');
scenario(['glx', 'v1es'], pools, winStart, winEnd, 'GLX + v1-ES');
scenario(['glx', 'lstb', 'glf', 'v1es'], pools, winStart, winEnd, 'clean book + v1-ES');
scenario(['glx', 'lstbA'], pools, winStart, winEnd, 'GLX + LSTB-ltAlign');
scenario(['glx', 'lstbA', 'v1es'], pools, winStart, winEnd, 'GLX + LSTB-ltAlign + v1-ES');
scenario(['glx', 'lstbA', 'glf'], pools, winStart, winEnd, 'GLX + LSTB-ltAlign + GLF');
