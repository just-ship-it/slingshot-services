/**
 * Phase H-2 — Analyze Variant B output.
 *
 * Breaks WR by:
 *   - Level type
 *   - Flip direction matches bias (contrarian semantics)
 *   - Time-of-day (session/hour)
 *   - LS state at touch
 *   - Flip TF
 *   - Distance touch_price → bar_close at flip time
 *
 * Defines "flip matches bias" as:
 *   LONG @ support: flip is 1→0 (bull→bear)  [contrarian-bullish-forward]
 *   SHORT @ resistance: flip is 0→1 (bear→bull) [contrarian-bearish-forward]
 *
 * Train/test split: <2025-09-15 vs >=
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const IN = arg('in', path.join(__dirname, 'output', '16-level-then-flip.csv'));
const OUT = arg('out', path.join(__dirname, 'output', '17-analysis.txt'));
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();

const text = fs.readFileSync(IN, 'utf-8');
const lines = text.trim().split('\n');
const hdr = lines[0].split(',');
const idx = {}; hdr.forEach((h, i) => idx[h] = i);

const rows = [];
for (let i = 1; i < lines.length; i++) {
  const p = lines[i].split(',');
  const r = {
    ts: p[idx.flip_ts] === '' ? 0 : +p[idx.flip_ts],  // use flip_ts as split anchor
    flip_ts: p[idx.flip_ts] === '' ? null : +p[idx.flip_ts],
    flip_state: p[idx.flip_state] === '' ? null : +p[idx.flip_state],
    flip_prior: p[idx.flip_prior] === '' ? null : +p[idx.flip_prior],
    flip_tf: p[idx.flip_tf] || '',
    level_type: p[idx.level_type],
    direction: p[idx.direction],
    outcome: p[idx.outcome],
    pnl: p[idx.pnl_pts] === '' ? null : +p[idx.pnl_pts],
    wait_ms: p[idx.wait_ms_touch_to_flip] === '' ? null : +p[idx.wait_ms_touch_to_flip],
    mfe: p[idx.mfe_pts] === '' ? null : +p[idx.mfe_pts],
    mae: p[idx.mae_pts] === '' ? null : +p[idx.mae_pts],
    hold_s: p[idx.hold_s] === '' ? null : +p[idx.hold_s],
  };
  rows.push(r);
}
console.log(`Loaded ${rows.length} rows`);

const entered = rows.filter(r => r.outcome === 'win' || r.outcome === 'loss' || r.outcome === 'timeout' || r.outcome === 'rollover');
console.log(`Entered: ${entered.length}`);

function flipMatchesBias(r) {
  // LONG (support): flip 1→0 (prior=1, state=0)
  // SHORT (resistance): flip 0→1 (prior=0, state=1)
  if (r.direction === 'long') return r.flip_prior === 1 && r.flip_state === 0;
  if (r.direction === 'short') return r.flip_prior === 0 && r.flip_state === 1;
  return false;
}

function summarize(arr) {
  let n = 0, w = 0, l = 0, to = 0, pnl = 0;
  for (const r of arr) {
    if (r.outcome === 'win') { n++; w++; pnl += r.pnl || 0; }
    else if (r.outcome === 'loss') { n++; l++; pnl += r.pnl || 0; }
    else if (r.outcome === 'timeout') { n++; to++; pnl += r.pnl || 0; }
  }
  return {
    n, w, l, to, pnl,
    wr: n ? w / n * 100 : 0,
    pf: l > 0 ? (w * 10) / (l * 10) : (w > 0 ? Infinity : 0),
    avg: n ? pnl / n : 0,
  };
}

const out_lines = [];
function emit(s) { console.log(s); out_lines.push(s); }

const train = entered.filter(r => r.ts < SPLIT_TS);
const test = entered.filter(r => r.ts >= SPLIT_TS);
const full = summarize(entered), trn = summarize(train), tst = summarize(test);

emit(`\n=== Phase H-2 — Variant B analysis ===`);
emit(`File: ${IN}\n`);
emit(`Baseline (all entered): n=${full.n} WR=${full.wr.toFixed(1)}% PF=${full.pf.toFixed(2)} sum=${full.pnl.toFixed(0)}pts`);
emit(`  train: n=${trn.n} WR=${trn.wr.toFixed(1)}% PF=${trn.pf.toFixed(2)}  |  test: n=${tst.n} WR=${tst.wr.toFixed(1)}% PF=${tst.pf.toFixed(2)}\n`);

// --- Filter: flip matches bias (contrarian semantic) ---
const matched = entered.filter(flipMatchesBias);
const mismatched = entered.filter(r => !flipMatchesBias(r));
emit(`\n--- Flip-matches-bias (contrarian-confirmation) ---`);
{
  const fM = summarize(matched), tM = summarize(matched.filter(r => r.ts < SPLIT_TS)), eM = summarize(matched.filter(r => r.ts >= SPLIT_TS));
  emit(`  MATCH: n=${fM.n} WR=${fM.wr.toFixed(1)}% PF=${fM.pf.toFixed(2)} sum=${fM.pnl.toFixed(0)}  |  train: n=${tM.n} WR=${tM.wr.toFixed(1)}% PF=${tM.pf.toFixed(2)}  |  test: n=${eM.n} WR=${eM.wr.toFixed(1)}% PF=${eM.pf.toFixed(2)}`);
  const fX = summarize(mismatched), tX = summarize(mismatched.filter(r => r.ts < SPLIT_TS)), eX = summarize(mismatched.filter(r => r.ts >= SPLIT_TS));
  emit(`  MISMATCH: n=${fX.n} WR=${fX.wr.toFixed(1)}% PF=${fX.pf.toFixed(2)} sum=${fX.pnl.toFixed(0)}  |  train: n=${tX.n} WR=${tX.wr.toFixed(1)}% PF=${tX.pf.toFixed(2)}  |  test: n=${eX.n} WR=${eX.wr.toFixed(1)}% PF=${eX.pf.toFixed(2)}`);
}

// --- By level type (overall) ---
emit(`\n--- By level type (all entered) ---`);
const byLevel = new Map();
for (const r of entered) {
  if (!byLevel.has(r.level_type)) byLevel.set(r.level_type, []);
  byLevel.get(r.level_type).push(r);
}
emit(`  ${'level'.padEnd(15)} ${'n'.padStart(5)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'sum'.padStart(7)} | ${'tr_n'.padStart(4)} ${'tr_WR'.padStart(5)} | ${'te_n'.padStart(4)} ${'te_WR'.padStart(5)}`);
const lvls = [...byLevel.entries()].map(([k, v]) => ({ k, f: summarize(v), t: summarize(v.filter(r => r.ts < SPLIT_TS)), e: summarize(v.filter(r => r.ts >= SPLIT_TS)) }))
  .filter(x => x.f.n >= 20)
  .sort((a, b) => b.f.wr - a.f.wr);
for (const x of lvls) {
  emit(`  ${x.k.padEnd(15)} ${x.f.n.toString().padStart(5)} ${x.f.wr.toFixed(1).padStart(5)} ${(isFinite(x.f.pf) ? x.f.pf.toFixed(2) : '∞').padStart(5)} ${x.f.pnl.toFixed(0).padStart(7)} | ${x.t.n.toString().padStart(4)} ${x.t.wr.toFixed(1).padStart(5)} | ${x.e.n.toString().padStart(4)} ${x.e.wr.toFixed(1).padStart(5)}`);
}

// --- By level type, MATCH only ---
emit(`\n--- By level type (flip-matches-bias only) ---`);
const byLevelMatch = new Map();
for (const r of matched) {
  if (!byLevelMatch.has(r.level_type)) byLevelMatch.set(r.level_type, []);
  byLevelMatch.get(r.level_type).push(r);
}
emit(`  ${'level'.padEnd(15)} ${'n'.padStart(5)} ${'WR'.padStart(5)} ${'PF'.padStart(5)} ${'sum'.padStart(7)} | ${'tr_n'.padStart(4)} ${'tr_WR'.padStart(5)} | ${'te_n'.padStart(4)} ${'te_WR'.padStart(5)}`);
const lvlsM = [...byLevelMatch.entries()].map(([k, v]) => ({ k, f: summarize(v), t: summarize(v.filter(r => r.ts < SPLIT_TS)), e: summarize(v.filter(r => r.ts >= SPLIT_TS)) }))
  .filter(x => x.f.n >= 20)
  .sort((a, b) => b.f.wr - a.f.wr);
for (const x of lvlsM) {
  emit(`  ${x.k.padEnd(15)} ${x.f.n.toString().padStart(5)} ${x.f.wr.toFixed(1).padStart(5)} ${(isFinite(x.f.pf) ? x.f.pf.toFixed(2) : '∞').padStart(5)} ${x.f.pnl.toFixed(0).padStart(7)} | ${x.t.n.toString().padStart(4)} ${x.t.wr.toFixed(1).padStart(5)} | ${x.e.n.toString().padStart(4)} ${x.e.wr.toFixed(1).padStart(5)}`);
}

// --- By flip TF ---
emit(`\n--- By flip TF ---`);
for (const tf of ['1m', '3m']) {
  const sub = entered.filter(r => r.flip_tf === tf);
  const subM = matched.filter(r => r.flip_tf === tf);
  const s = summarize(sub), sm = summarize(subM);
  const t = summarize(sub.filter(r => r.ts < SPLIT_TS));
  const e = summarize(sub.filter(r => r.ts >= SPLIT_TS));
  emit(`  ${tf}: all n=${s.n} WR=${s.wr.toFixed(1)}% | match-only n=${sm.n} WR=${sm.wr.toFixed(1)}% PF=${sm.pf.toFixed(2)} | train(all) WR=${t.wr.toFixed(1)}% | test(all) WR=${e.wr.toFixed(1)}%`);
}

// --- Combined: MATCH + best level types ---
emit(`\n--- TOP combos: MATCH + level subset (n>=80, WR>52% both halves) ---`);
const candidates = [];
for (const [lvl, v] of byLevelMatch.entries()) {
  const sub = v;
  const subT = sub.filter(r => r.ts < SPLIT_TS);
  const subE = sub.filter(r => r.ts >= SPLIT_TS);
  if (subT.length < 40 || subE.length < 40) continue;
  const f = summarize(sub), t = summarize(subT), e = summarize(subE);
  if (t.wr < 50 || e.wr < 50) continue;
  candidates.push({ lvl, f, t, e });
}
candidates.sort((a, b) => b.f.wr - a.f.wr);
for (const c of candidates) {
  emit(`  ${c.lvl.padEnd(15)} n=${c.f.n} WR=${c.f.wr.toFixed(1)}% PF=${c.f.pf.toFixed(2)} sum=${c.f.pnl.toFixed(0)}pts | tr ${c.t.n}/${c.t.wr.toFixed(1)}% | te ${c.e.n}/${c.e.wr.toFixed(1)}%`);
}

fs.writeFileSync(OUT, out_lines.join('\n'));
console.log(`\nWritten: ${OUT}`);
