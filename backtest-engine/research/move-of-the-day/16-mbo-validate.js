// Phase 10c — VALIDATE the favImb1 needle. Is best-level book imbalance a real LEADING signal,
// or a proxy for depth-of-underwater / recent drift / multiple-comparisons noise?
// Tests: (1) one obs/trade (independent), OLS future ~ unrl + recentMove + favImb1 with t-stats;
//        (2) DAY-SPLIT out-of-sample replication; (3) cut-rule economics.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANELS = path.resolve(__dirname, 'output/mbo-panels');
const M = 15, TRAIL = 30;

const files = fs.readdirSync(PANELS).filter(f => f.endsWith('.json')).sort();
const aligned = (side, x) => side === 'long' ? x : -x;
const ratio = (a, b) => (a + b) > 0 ? (a - b) / (a + b) : 0;
function trailAvg(snaps, sEnd, fn) { let s = 0, n = 0; for (let i = snaps.length - 1; i >= 0; i--) { const sn = snaps[i]; if (sn.t > sEnd) continue; if (sn.t < sEnd - TRAIL) break; const v = fn(sn); if (isFinite(v)) { s += v; n++; } } return n ? s / n : null; }
const snapAt = (snaps, sEnd) => { let b = null; for (const sn of snaps) { if (sn.t <= sEnd) b = sn; else break; } return b; };

// one observation per trade at M=15min
const rows = [];
for (const f of files) {
  const day = f.replace('.json', '');
  for (const t of JSON.parse(fs.readFileSync(path.join(PANELS, f), 'utf8'))) {
    if (!t.snaps || !t.snaps.length) continue;
    const entrySec = Math.floor(t.entryTs / 1000), exitSec = Math.floor(t.exitTs / 1000);
    const S = entrySec + M * 60;
    if (S >= exitSec - 30) continue;
    const cur = snapAt(t.snaps, S), prev = snapAt(t.snaps, S - TRAIL); if (!cur) continue;
    const favImb1 = aligned(t.side, trailAvg(t.snaps, S, s => s.imb1));
    if (favImb1 == null) continue;
    const unrl = aligned(t.side, cur.mid - t.entry);
    const recentMove = prev ? aligned(t.side, cur.mid - prev.mid) : 0;
    rows.push({ day, id: t.id, side: t.side, unrl, recentMove, favImb1, finalPts: t.finalPts, future: t.finalPts - unrl, win: t.finalPts > 0 });
  }
}
console.log(`One-obs-per-trade at M=${M}min: ${rows.length} trades\n`);

// ---- OLS: future ~ 1 + unrl + recentMove + favImb1 ----
function ols(data, yKey, xKeys) {
  const n = data.length, p = xKeys.length + 1;
  const X = data.map(d => [1, ...xKeys.map(k => d[k])]), y = data.map(d => d[yKey]);
  // normal equations XtX b = Xty
  const XtX = Array.from({ length: p }, () => Array(p).fill(0)), Xty = Array(p).fill(0);
  for (let i = 0; i < n; i++) { for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; } }
  const inv = invert(XtX); if (!inv) return null;
  const beta = inv.map(r => r.reduce((s, v, j) => s + v * Xty[j], 0));
  // residual variance + se
  let sse = 0; for (let i = 0; i < n; i++) { const yh = X[i].reduce((s, v, j) => s + v * beta[j], 0); sse += (y[i] - yh) ** 2; }
  const sigma2 = sse / (n - p);
  const se = inv.map((r, j) => Math.sqrt(sigma2 * inv[j][j]));
  return { beta, se, t: beta.map((b, j) => b / se[j]), n, names: ['intercept', ...xKeys] };
}
function invert(Ain) { const n = Ain.length, A = Ain.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let i = 0; i < n; i++) { let p = A[i][i], pr = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(p)) { p = A[r][i]; pr = r; } if (Math.abs(p) < 1e-12) return null; [A[i], A[pr]] = [A[pr], A[i]];
    const piv = A[i][i]; for (let j = 0; j < 2 * n; j++) A[i][j] /= piv; for (let r = 0; r < n; r++) if (r !== i) { const fct = A[r][i]; for (let j = 0; j < 2 * n; j++) A[r][j] -= fct * A[i][j]; } }
  return A.map(r => r.slice(n)); }

const m = ols(rows, 'future', ['unrl', 'recentMove', 'favImb1']);
console.log('OLS  future ~ unrl + recentMove + favImb1   (n=' + m.n + ')');
m.names.forEach((nm, j) => console.log(`   ${nm.padEnd(11)} beta ${m.beta[j].toFixed(2).padStart(9)}   t ${m.t[j].toFixed(2).padStart(6)}${Math.abs(m.t[j]) > 2 ? '  *' : ''}`));
console.log('   (favImb1 t-stat is the test: is touch-book imbalance predictive AFTER controlling for price & drift?)');

// ---- DAY-SPLIT out-of-sample ----
const days = [...new Set(rows.map(r => r.day))].sort();
const mid = days[Math.floor(days.length / 2)];
const tr = rows.filter(r => r.day < mid), te = rows.filter(r => r.day >= mid);
console.log(`\nDAY-SPLIT: train ${tr.length} (days<${mid}), test ${te.length}`);
for (const [lbl, d] of [['train', tr], ['test', te]]) {
  const mm = ols(d, 'future', ['unrl', 'recentMove', 'favImb1']);
  if (mm) { const j = mm.names.indexOf('favImb1'); console.log(`   ${lbl}: favImb1 beta ${mm.beta[j].toFixed(2)}  t ${mm.t[j].toFixed(2)}`); }
}

// ---- CUT-RULE economics: among under+flat trades, cut if favImb1 in bottom group ----
console.log('\nCUT-RULE: among underwater/flat trades at 15min, cut if favImb1 below threshold (exit at unrl@15).');
const af = rows.filter(r => r.unrl <= 10);
const thrs = [-0.5, -0.3, -0.1, 0];
console.log(`   actionable (under+flat) trades: ${af.length}`);
for (const thr of thrs) {
  const cut = af.filter(r => r.favImb1 < thr);
  if (!cut.length) continue;
  // benefit per cut = exit-now(unrl) - finalPts  (positive ⇒ cutting beat holding)
  const benefit = cut.reduce((s, r) => s + (r.unrl - r.finalPts), 0);
  const recovered = cut.filter(r => r.finalPts > r.unrl).length; // would-have-improved (cut was wrong)
  console.log(`   favImb1<${thr}: cut ${cut.length} trades | net pts saved ${benefit.toFixed(0)} ($${(benefit * 20).toLocaleString()}) | ${recovered}/${cut.length} would've recovered`);
}
