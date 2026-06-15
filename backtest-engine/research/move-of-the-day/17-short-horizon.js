// Phase 10d — does the order book LEAD price at a SHORT (tradeable) horizon? The canonical
// "does OBI predict price" test: 30s-trailing book imbalance / flow predicting the NEXT 120s
// mid move, controlling for the PREVIOUS 30s move. If null even here → fully efficient at the
// horizons we can act on. Dense decision grid (every 60s while open) + day-split robustness.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANELS = path.resolve(__dirname, 'output/mbo-panels');
const TRAIL = 30, HORIZON = 120, STEP = 60;

const files = fs.readdirSync(PANELS).filter(f => f.endsWith('.json')).sort();
const aligned = (side, x) => side === 'long' ? x : -x;
const ratio = (a, b) => (a + b) > 0 ? (a - b) / (a + b) : 0;
function trailAvg(snaps, sEnd, fn) { let s = 0, n = 0; for (let i = snaps.length - 1; i >= 0; i--) { const sn = snaps[i]; if (sn.t > sEnd) continue; if (sn.t < sEnd - TRAIL) break; const v = fn(sn); if (isFinite(v)) { s += v; n++; } } return n ? s / n : null; }
const snapAt = (snaps, sEnd) => { let b = null; for (const sn of snaps) { if (sn.t <= sEnd) b = sn; else break; } return b; };

const rows = [];
for (const f of files) {
  const day = f.replace('.json', '');
  for (const t of JSON.parse(fs.readFileSync(path.join(PANELS, f), 'utf8'))) {
    if (!t.snaps || t.snaps.length < 60) continue;
    const t0 = t.snaps[0].t, tN = t.snaps[t.snaps.length - 1].t;
    for (let S = t0 + TRAIL; S + HORIZON <= tN; S += STEP) {
      const cur = snapAt(t.snaps, S), prev = snapAt(t.snaps, S - TRAIL), fut = snapAt(t.snaps, S + HORIZON);
      if (!cur || !prev || !fut) continue;
      const favImb1 = aligned(t.side, trailAvg(t.snaps, S, s => s.imb1));
      const favFlow = aligned(t.side, trailAvg(t.snaps, S, s => ratio(s.buy5, s.sell5)));
      if (favImb1 == null || favFlow == null) continue;
      rows.push({ day, recentMove: aligned(t.side, cur.mid - prev.mid), favImb1, favFlow,
        shortFut: aligned(t.side, fut.mid - cur.mid) });
    }
  }
}
console.log(`Short-horizon obs (every ${STEP}s, predict next ${HORIZON}s): ${rows.length}\n`);

function ols(data, yKey, xKeys) {
  const n = data.length, p = xKeys.length + 1;
  const X = data.map(d => [1, ...xKeys.map(k => d[k])]), y = data.map(d => d[yKey]);
  const XtX = Array.from({ length: p }, () => Array(p).fill(0)), Xty = Array(p).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  const inv = invert(XtX); if (!inv) return null;
  const beta = inv.map(r => r.reduce((s, v, j) => s + v * Xty[j], 0));
  let sse = 0; for (let i = 0; i < n; i++) { const yh = X[i].reduce((s, v, j) => s + v * beta[j], 0); sse += (y[i] - yh) ** 2; }
  const sigma2 = sse / (n - p), se = inv.map((r, j) => Math.sqrt(sigma2 * inv[j][j]));
  return { beta, se, t: beta.map((b, j) => b / se[j]), n, names: ['intercept', ...xKeys] };
}
function invert(Ain) { const n = Ain.length, A = Ain.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let i = 0; i < n; i++) { let p = A[i][i], pr = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(p)) { p = A[r][i]; pr = r; } if (Math.abs(p) < 1e-12) return null; [A[i], A[pr]] = [A[pr], A[i]]; const piv = A[i][i]; for (let j = 0; j < 2 * n; j++) A[i][j] /= piv; for (let r = 0; r < n; r++) if (r !== i) { const fct = A[r][i]; for (let j = 0; j < 2 * n; j++) A[r][j] -= fct * A[i][j]; } } return A.map(r => r.slice(n)); }

console.log(`OLS  next-${HORIZON}s move ~ recentMove + favImb1 + favFlow  (n=${rows.length}, obs autocorrelated → day-split is the real test)`);
const m = ols(rows, 'shortFut', ['recentMove', 'favImb1', 'favFlow']);
m.names.forEach((nm, j) => console.log(`   ${nm.padEnd(11)} beta ${m.beta[j].toFixed(3).padStart(9)}  t ${m.t[j].toFixed(2).padStart(7)}${Math.abs(m.t[j]) > 2.5 ? '  *' : ''}`));

const days = [...new Set(rows.map(r => r.day))].sort(), midD = days[Math.floor(days.length / 2)];
console.log(`\nDAY-SPLIT (does the favImb1 / favFlow coefficient replicate out-of-sample?):`);
for (const [lbl, d] of [['train', rows.filter(r => r.day < midD)], ['test', rows.filter(r => r.day >= midD)]]) {
  const mm = ols(d, 'shortFut', ['recentMove', 'favImb1', 'favFlow']);
  const i1 = mm.names.indexOf('favImb1'), i2 = mm.names.indexOf('favFlow');
  console.log(`   ${lbl} (n=${mm.n}): favImb1 beta ${mm.beta[i1].toFixed(2)} t ${mm.t[i1].toFixed(2)} | favFlow beta ${mm.beta[i2].toFixed(2)} t ${mm.t[i2].toFixed(2)}`);
}
// directional hit-rate: when favImb1 strongly toward us, does next-120s go our way more than base?
const base = rows.filter(r => r.shortFut > 0).length / rows.length;
const strong = rows.filter(r => r.favImb1 > 0.2), weak = rows.filter(r => r.favImb1 < -0.2);
console.log(`\nDirectional: base P(next move toward us) = ${(base * 100).toFixed(1)}%`);
console.log(`   favImb1>+0.2 (book toward us): ${(strong.filter(r => r.shortFut > 0).length / strong.length * 100).toFixed(1)}%  (n=${strong.length})`);
console.log(`   favImb1<-0.2 (book against us): ${(weak.filter(r => r.shortFut > 0).length / weak.length * 100).toFixed(1)}%  (n=${weak.length})`);
