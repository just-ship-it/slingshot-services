// Consecutive same-direction re-entry "chase" analysis.
//
// Question (Drew, 2026-06-16): when a strategy fires another signal of the SAME type
// shortly after the previous one closed, how often does that next signal enter at a
// price that is BEYOND the prior signal's target — i.e. a new SHORT at/below the last
// short's TP, or a new LONG at/above the last long's TP (chasing the move)? And does
// chasing past the prior TP make or lose money?
//
// Example: GLX CW_SHORT @ 30621.75, TP 30421.75 — entered below the prior signal's TP,
// near the day's low.
//
// Data: per-strategy gold JSONs (each = the sequence of trades that strategy actually
// took, one position at a time -> trade[i] fires after trade[i-1] closed). Entries/TPs/
// outcomes are already 1s-honest. LS-Flip excluded.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

const NEAR = 15; // pts: "near" the prior TP counts alongside "beyond"

const SOURCES = {
  glf: 'data/gold-standard/gex-level-fade-v2.json',
  gfi: 'data/gold-standard/gex-flip-ivpct-v2.json',
  glx: 'data/gold-standard/gex-lt-3m-crossover-v3.json',
};

function ruleKey(t) {
  const s = t.signal || {};
  return s.ruleId || s.levelType || s.ruleName || 'NA';
}

function loadTrades(strat, file) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const out = [];
  for (const t of j.trades || []) {
    if (t.status !== 'completed') continue;
    const entry = t.actualEntry ?? t.entryPrice;
    if (entry == null || t.takeProfit == null) continue;
    out.push({
      strat, id: t.id, side: t.side, rule: ruleKey(t),
      entry, tp: t.takeProfit, stop: t.stopLoss,
      entryTime: t.entryTime, exitTime: t.exitTime,
      exitReason: t.exitReason, netPnL: t.netPnL, pointsPnL: t.pointsPnL,
      hitTP: t.exitReason === 'take_profit',
    });
  }
  out.sort((a, b) => a.entryTime - b.entryTime);
  return out;
}

// PF / winrate helpers. `get` extracts net$ from each item (pairs use bNet).
function perf(items, get = (t) => t.bNet) {
  const n = items.length;
  if (!n) return { n: 0 };
  const v = items.map(get);
  const wins = v.filter(x => x > 0);
  const grossW = wins.reduce((s, x) => s + x, 0);
  const grossL = v.filter(x => x <= 0).reduce((s, x) => s + x, 0);
  const tot = v.reduce((s, x) => s + x, 0);
  return {
    n,
    winRate: +(100 * wins.length / n).toFixed(1),
    avgNet: Math.round(tot / n),
    totNet: Math.round(tot),
    pf: grossL === 0 ? Infinity : +(grossW / Math.abs(grossL)).toFixed(2),
  };
}

function main() {
  const all = {};
  for (const [s, f] of Object.entries(SOURCES)) all[s] = loadTrades(s, f);

  // build same-direction consecutive pairs (B = trade[i], A = trade[i-1] same strat)
  const pairs = [];
  for (const s of Object.keys(all)) {
    const ts = all[s];
    for (let i = 1; i < ts.length; i++) {
      const A = ts[i - 1], B = ts[i];
      if (A.side !== B.side) continue;        // same direction only
      const gapMin = (B.entryTime - A.exitTime) / 60000;
      // "beyond" = how far B entered PAST A's target, in the trade direction
      const beyond = B.side === 'short' ? (A.tp - B.entry) : (B.entry - A.tp);
      pairs.push({
        strat: s, side: B.side, sameRule: A.rule === B.rule, rule: B.rule, priorRule: A.rule,
        gapMin: +gapMin.toFixed(1),
        priorEntry: A.entry, priorTP: A.tp, priorHitTP: A.hitTP, priorExit: A.exitReason,
        bEntry: B.entry, bTP: B.tp, beyond: +beyond.toFixed(2),
        atOrBeyond: beyond >= 0, nearOrBeyond: beyond >= -NEAR,
        bNet: B.netPnL, bPts: B.pointsPnL, bWin: B.netPnL > 0, bExit: B.exitReason,
        bId: `${s}:${B.id}`, aId: `${s}:${A.id}`,
      });
    }
  }

  // ---- frequency table ----
  console.log(`=== Same-direction consecutive re-entries (B fires after A closed) ===`);
  console.log(`NEAR buffer = ${NEAR}pt above prior TP\n`);
  const strats = [...Object.keys(SOURCES), 'ALL'];
  const freqRows = {};
  for (const s of strats) {
    const ps = s === 'ALL' ? pairs : pairs.filter(p => p.strat === s);
    if (!ps.length) { freqRows[s] = { pairs: 0 }; continue; }
    const beyond = ps.filter(p => p.atOrBeyond);
    const near = ps.filter(p => p.nearOrBeyond);
    freqRows[s] = {
      samedirPairs: ps.length,
      atOrBeyondTP: beyond.length,
      pctBeyond: +(100 * beyond.length / ps.length).toFixed(1),
      nearOrBeyond: near.length,
      pctNear: +(100 * near.length / ps.length).toFixed(1),
      medGapMin: median(ps.map(p => p.gapMin)),
    };
  }
  console.table(freqRows);

  // ---- does chasing past the prior TP pay? (B outcomes) ----
  console.log('\n=== B outcome: chase (entered at/beyond prior TP) vs non-chase (same-dir) ===');
  const outRows = {};
  for (const s of strats) {
    const ps = s === 'ALL' ? pairs : pairs.filter(p => p.strat === s);
    if (!ps.length) continue;
    const chase = perf(ps.filter(p => p.atOrBeyond));
    const nonchase = perf(ps.filter(p => !p.atOrBeyond));
    outRows[`${s} CHASE`] = chase;
    outRows[`${s} non-chase`] = nonchase;
  }
  console.table(outRows);

  // ---- split chase by whether the PRIOR trade hit its TP ----
  console.log('\n=== chase entries split by whether prior trade hit TP (ALL strats) ===');
  const chaseAll = pairs.filter(p => p.atOrBeyond);
  console.table({
    'prior HIT TP': perf(chaseAll.filter(p => p.priorHitTP)),
    'prior MISSED TP (stop/BE/eod)': perf(chaseAll.filter(p => !p.priorHitTP)),
  });

  // ---- beyondness buckets: deeper past TP -> better or worse? ----
  console.log('\n=== B outcome by how far past prior TP it entered (ALL strats, same-dir) ===');
  const buckets = [
    ['< -15 (well short of TP)', p => p.beyond < -15],
    ['-15..0 (near, short of TP)', p => p.beyond >= -15 && p.beyond < 0],
    ['0..50 past TP', p => p.beyond >= 0 && p.beyond < 50],
    ['50..150 past TP', p => p.beyond >= 50 && p.beyond < 150],
    ['>=150 past TP', p => p.beyond >= 150],
  ];
  const bk = {};
  for (const [label, fn] of buckets) bk[label] = perf(pairs.filter(fn));
  console.table(bk);

  // ---- gap sensitivity: only "shortly after" ----
  console.log('\n=== chase rate & EV by gap (A.exit -> B.entry) (ALL strats, same-dir) ===');
  const gaps = [['<=15min', 15], ['<=60min', 60], ['<=240min', 240], ['any', Infinity]];
  const gk = {};
  for (const [label, lim] of gaps) {
    const ps = pairs.filter(p => p.gapMin <= lim);
    const chase = ps.filter(p => p.atOrBeyond);
    gk[label] = {
      pairs: ps.length, chase: chase.length,
      pctChase: ps.length ? +(100 * chase.length / ps.length).toFixed(1) : 0,
      ...perf(chase),
    };
  }
  console.table(gk);

  // save
  pairs.sort((a, b) => b.beyond - a.beyond);
  fs.writeFileSync(path.join(OUT, 'pairs.json'), JSON.stringify({
    NEAR, total: pairs.length,
    freq: freqRows, outcomes: outRows, byBeyond: bk, byGap: gk,
    pairs,
  }, null, 2));
  console.log(`\nwrote ${path.join(OUT, 'pairs.json')} (${pairs.length} same-dir consecutive pairs)`);
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return +(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2).toFixed(1);
}

main();
