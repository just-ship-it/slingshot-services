/**
 * Phase 3 — QQQ 0DTE options flow as a precursor to NQ explosions (Drew's idea).
 * Mechanism: a large 0DTE QQQ options print forces dealer hedging that drives QQQ/NQ. A single
 * options trade is a telegraph a small fish can act on without disrupting it.
 *
 * For each NQ explosion onset (09 logic), aggregate QQQ 0DTE options trades in the leadup
 * [onset-LEAD, onset] vs a calm baseline [onset-360, onset-300]: call vs put premium, premium
 * spike, large prints. Test: does call/put imbalance ALIGN with explosion direction > chance,
 * and does 0DTE premium SPIKE before explosions? Targeted streaming (only needed seconds).
 *
 * LOOKAHEAD-safe: options features use only trades BEFORE the onset. OOS 60/40.
 * node --max-old-space-size=8192 research/orderflow-sweep/12-qqq-options-leadup.js --panel data/features/nq_panel_1s_full.csv
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = path.join(ROOT, 'data');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const PANEL = arg('panel', 'data/features/nq_panel_1s_full.csv');
const WSTART = arg('wstart', '2025-01-01'), WEND = arg('wend', '2025-12-31');
const THRESH = +arg('thresh', 15), W = +arg('w', 60), COIL = +arg('coil', 8), COOLDOWN = +arg('cooldown', 120);
const LEAD = +arg('lead', 60), BIGPRINT = +arg('bigprint', 50);
const panelPath = path.isAbsolute(PANEL) ? PANEL : path.join(ROOT, PANEL);
const wsTs = new Date(WSTART).getTime(), weTs = new Date(WEND).getTime() + 864e5;
console.log(`\n=== QQQ 0DTE options leadup to NQ explosions, ${WSTART}→${WEND} (lead ${LEAD}s) ===\n`);

// ---- onsets from panel ----
let cap = 1 << 22, n = 0;
let TS = new Float64Array(cap), Hh = new Float64Array(cap), Ll = new Float64Array(cap), Cc = new Float64Array(cap);
const SYM = [];
function grow() { cap <<= 1; const g = a => { const b = new Float64Array(cap); b.set(a); return b; }; TS = g(TS); Hh = g(Hh); Ll = g(Ll); Cc = g(Cc); }
{ const rl = readline.createInterface({ input: fs.createReadStream(panelPath), crlfDelay: Infinity }); let ci = null; for await (const line of rl) { if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; } if (n >= cap) grow(); const f = line.split(','); TS[n] = new Date(f[ci.ts]).getTime(); SYM.push(f[ci.symbol]); Hh[n] = +f[ci.high]; Ll[n] = +f[ci.low]; Cc[n] = +f[ci.close]; n++; } }
const N = n;
const seg = new Int32Array(N); { let s = 0; for (let i = 0; i < N; i++) { if (i > 0 && (SYM[i] !== SYM[i - 1] || TS[i] - TS[i - 1] > 2000)) s = i; seg[i] = s; } }
function slide(src, w, isMax) { const out = new Float64Array(N).fill(NaN); const dq = new Int32Array(N); let h = 0, t = 0; for (let i = 0; i < N; i++) { if (i === 0 || seg[i] !== seg[i - 1]) h = t = 0; while (t > h && (isMax ? src[dq[t - 1]] <= src[i] : src[dq[t - 1]] >= src[i])) t--; dq[t++] = i; const lo = i - w + 1; while (h < t && (dq[h] < lo || dq[h] < seg[i])) h++; if (lo >= seg[i]) out[i] = src[dq[h]]; } return out; }
const HI30 = slide(Hh, 30, true), LO30 = slide(Ll, 30, false);
function explode(i) { const c = Cc[i], hm = W * 1000; for (let j = i + 1; j < N; j++) { if (SYM[j] !== SYM[i] || TS[j] - TS[i] > hm) break; if (Hh[j] - c >= THRESH) return 1; if (c - Ll[j] >= THRESH) return -1; } return 0; }
const onsets = []; let last = -1e18;
for (let i = 31; i < N; i++) { if (i - 30 < seg[i]) continue; if (!(HI30[i] - LO30[i] < COIL)) continue; if (TS[i] - last < COOLDOWN * 1000) continue; const d = explode(i); if (!d) continue; last = TS[i]; if (TS[i] >= wsTs && TS[i] <= weTs) onsets.push({ ts: TS[i], dir: d }); }
console.log(`onsets in window: ${onsets.length.toLocaleString()}`);

// ---- needed seconds: [onset-360, onset] for each ----
const need = new Set();
for (const o of onsets) for (let s = 360; s >= 0; s--) need.add(o.ts - s * 1000);
console.log(`needed seconds: ${need.size.toLocaleString()}`);

// ---- stream QQQ options day files, aggregate 0DTE call/put premium per needed second ----
const flow = new Map(); // secMs -> {cP,pP,cV,pV,maxC,maxP}
const dir = path.join(DATA, 'options-trades/qqq');
const files = fs.readdirSync(dir).filter(f => /opra-pillar-(\d{8})\.trades\.csv/.test(f)).filter(f => { const d = f.match(/(\d{8})/)[1]; const t = new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`).getTime(); return t >= wsTs && t <= weTs; }).sort();
console.log(`QQQ option files to scan: ${files.length}`);
let scanned = 0, t0 = Date.now();
for (const fn of files) {
  const dstr = fn.match(/(\d{8})/)[1]; const yymmdd = dstr.slice(2);  // 0DTE = symbol expiry == file date
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, fn)), crlfDelay: Infinity });
  let ci = null;
  for await (const line of rl) {
    if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; }
    const f = line.split(',');
    const ts = new Date(f[ci.ts_event]).getTime(); const secMs = Math.floor(ts / 1000) * 1000;
    if (!need.has(secMs)) continue;
    const sym = f[ci.symbol]; if (!sym || sym.length < 21) continue;
    if (sym.slice(6, 12) !== yymmdd) continue;        // 0DTE only
    const cp = sym[12];                                // 'C' or 'P'
    const prem = (+f[ci.price]) * (+f[ci.size]) * 100; const sz = +f[ci.size];
    let b = flow.get(secMs); if (!b) { b = { cP: 0, pP: 0, cV: 0, pV: 0, maxC: 0, maxP: 0 }; flow.set(secMs, b); }
    if (cp === 'C') { b.cP += prem; b.cV += sz; if (prem > b.maxC) b.maxC = prem; }
    else if (cp === 'P') { b.pP += prem; b.pV += sz; if (prem > b.maxP) b.maxP = prem; }
  }
  scanned++; if (scanned % 30 === 0) console.log(`  ${scanned}/${files.length} (${((Date.now()-t0)/1000).toFixed(0)}s) flow secs ${flow.size.toLocaleString()}`);
}
console.log(`captured option-flow seconds: ${flow.size.toLocaleString()}\n`);

// ---- per-onset features ----
function agg(o, fromS, toS) { let cP = 0, pP = 0, cV = 0, pV = 0, mx = 0; for (let s = fromS; s >= toS; s--) { const b = flow.get(o.ts - s * 1000); if (!b) continue; cP += b.cP; pP += b.pP; cV += b.cV; pV += b.pV; mx = Math.max(mx, b.maxC, b.maxP); } return { cP, pP, cV, pV, mx }; }
const rows = [];
for (const o of onsets) {
  const lead = agg(o, LEAD, 0), base = agg(o, 360, 300);
  const tot = lead.cP + lead.pP;
  rows.push({ ts: o.ts, dir: o.dir, cpImb: tot > 0 ? (lead.cP - lead.pP) / tot : NaN, leadPrem: tot, basePrem: base.cP + base.pP, mx: lead.mx, hasFlow: tot > 0 });
}
const withFlow = rows.filter(r => r.hasFlow);
console.log(`onsets with ANY 0DTE flow in lead: ${withFlow.length.toLocaleString()} / ${rows.length.toLocaleString()}\n`);
const mid = onsets.length ? onsets[Math.floor(onsets.length / 2)].ts : 0;

// (1) directional alignment: does call/put premium imbalance point the explosion way?
function alignStats(sub) { let m = 0, match = 0; for (const r of sub) { if (!Number.isFinite(r.cpImb) || Math.abs(r.cpImb) < 0.05) continue; m++; if (Math.sign(r.cpImb) === r.dir) match++; } return { m, p: m ? match / m : NaN }; }
const al = alignStats(withFlow), alTr = alignStats(withFlow.filter(r => r.ts < mid)), alTe = alignStats(withFlow.filter(r => r.ts >= mid));
console.log(`(1) call/put premium imbalance aligns with explosion direction:`);
console.log(`    all ${(al.p*100).toFixed(1)}% (n=${al.m})   train ${(alTr.p*100).toFixed(1)}% → test ${(alTe.p*100).toFixed(1)}%   [50% = no signal]`);
// strong-imbalance subset
const strong = withFlow.filter(r => Math.abs(r.cpImb) >= 0.5); const alS = alignStats(strong);
console.log(`    strong imbalance |cpImb|>=0.5: ${(alS.p*100).toFixed(1)}% (n=${alS.m})`);

// (2) premium spike before explosion vs baseline
let spike = 0, m2 = 0; for (const r of withFlow) { if (r.basePrem > 0 || r.leadPrem > 0) { m2++; if (r.leadPrem > r.basePrem) spike++; } }
const leadMed = withFlow.map(r => r.leadPrem).sort((a, b) => a - b)[Math.floor(withFlow.length / 2)];
const baseMed = withFlow.map(r => r.basePrem).sort((a, b) => a - b)[Math.floor(withFlow.length / 2)];
console.log(`\n(2) 0DTE premium spike: lead > baseline in ${(100*spike/m2).toFixed(1)}% of onsets`);
console.log(`    median lead premium $${(leadMed/1000).toFixed(1)}k vs baseline $${(baseMed/1000).toFixed(1)}k`);

// (3) big-print presence in lead
const bigShare = withFlow.filter(r => r.mx >= BIGPRINT * 100 * 1).length / withFlow.length; // mx is premium $, rough
console.log(`\n(3) onsets with a >=$${(BIGPRINT*100/1000).toFixed(0)}k+ single 0DTE print in lead: (premium-based) ${(100*bigShare).toFixed(1)}%`);
console.log(`\nRead: alignment >55% (esp. strong subset) AND premium spike >>50% = QQQ 0DTE options telegraph NQ moves.`);
console.log(`Then a large directional 0DTE print → enter NQ in that direction is a small-fish precursor trade.\n`);
