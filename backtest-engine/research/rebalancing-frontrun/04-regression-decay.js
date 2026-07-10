#!/usr/bin/env node
/**
 * 04-regression-decay.js — Replicate the paper's core predictive regressions
 * and compare the paper window vs the post-publication OOS window.
 *
 *   Ret[t+1] = γ0 + γ1·ThresholdSignal[t]                       (eq. 1)
 *   Ret[t+1] = β0 + β1·Cal[t] + β2·Cal[t]·week4[t] + β3·week4[t] (eq. 3)
 *
 * Ret = retE - retB (equity minus bond). Signals in percent (×100) so the
 * coefficients are directly comparable to Table 1/2 (paper: Threshold γ1
 * ≈ -0.33 to -0.48, Calendar·week4 β2 ≈ -0.30, in bps-per-bps terms both
 * returns and signals in %).
 * HC (White) standard errors.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');
const BOND = process.argv.includes('--bond') ? process.argv[process.argv.indexOf('--bond') + 1] : 'etf';

const lines = fs.readFileSync(path.join(OUT_DIR, `signals-${BOND}.csv`), 'utf8').trim().split('\n');
const rows = [];
for (let i = 1; i < lines.length; i++) {
  const [date, retE, retB, thr, cal, bdToME] = lines[i].split(',');
  rows.push({ date, xa: (+retE - +retB) * 100, thr: +thr * 100, cal: +cal * 100, week4: +bdToME <= 5 ? 1 : 0 });
}

/** OLS with White HC standard errors. X: array of arrays (no intercept col). */
function ols(y, X) {
  const n = y.length;
  const k = X[0].length + 1;
  const Xm = X.map((r) => [1, ...r]);
  // XtX, Xty
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += Xm[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += Xm[i][a] * Xm[i][b];
    }
  }
  // invert XtX (Gauss-Jordan)
  const inv = XtX.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(inv[r][col]) > Math.abs(inv[piv][col])) piv = r;
    [inv[col], inv[piv]] = [inv[piv], inv[col]];
    const d = inv[col][col];
    for (let j = 0; j < 2 * k; j++) inv[col][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = inv[r][col];
      for (let j = 0; j < 2 * k; j++) inv[r][j] -= f * inv[col][j];
    }
  }
  const XtXinv = inv.map((row) => row.slice(k));
  const beta = XtXinv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  // White HC0: (X'X)^-1 X' diag(e^2) X (X'X)^-1
  const resid = y.map((yi, i) => yi - Xm[i].reduce((s, v, j) => s + v * beta[j], 0));
  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++)
    for (let a = 0; a < k; a++)
      for (let b = 0; b < k; b++) meat[a][b] += Xm[i][a] * Xm[i][b] * resid[i] ** 2;
  const cov = Array.from({ length: k }, (_, a) =>
    Array.from({ length: k }, (_, b) => {
      let s = 0;
      for (let p = 0; p < k; p++) for (let q = 0; q < k; q++) s += XtXinv[a][p] * meat[p][q] * XtXinv[q][b];
      return s;
    })
  );
  return { beta, se: cov.map((row, i) => Math.sqrt(row[i])), n };
}

function runWindow(label, from, to) {
  const idx = [];
  for (let i = 0; i < rows.length - 1; i++) if (rows[i].date >= from && rows[i].date <= to) idx.push(i);
  const y = idx.map((i) => rows[i + 1].xa);
  // eq 1: Threshold
  const r1 = ols(y, idx.map((i) => [rows[i].thr]));
  // eq 3: Calendar + Cal*week4 + week4
  const r3 = ols(y, idx.map((i) => [rows[i].cal, rows[i].cal * rows[i].week4, rows[i].week4]));
  console.log(`\n${label}  (n=${r1.n})`);
  console.log(`  Threshold γ1        = ${r1.beta[1].toFixed(4)}  (t=${(r1.beta[1] / r1.se[1]).toFixed(2)})   [paper ≈ -0.33..-0.48, t≈-3]`);
  console.log(`  Calendar β1         = ${r3.beta[1].toFixed(4)}  (t=${(r3.beta[1] / r3.se[1]).toFixed(2)})   [paper ≈ +0.06, ns]`);
  console.log(`  Calendar·week4 β2   = ${r3.beta[2].toFixed(4)}  (t=${(r3.beta[2] / r3.se[2]).toFixed(2)})   [paper ≈ -0.30, t≈-3.7]`);
}

console.log(`=== Predictive-regression decay check — bond=${BOND} ===`);
runWindow('Paper window 1997-09-10 → 2023-03-17', '1997-09-10', '2023-03-17');
runWindow('OOS 2023-03-18 → present', '2023-03-18', '2099-01-01');
runWindow('Recent in-sample half 2010 → 2023-03', '2010-01-01', '2023-03-17');
runWindow('Pre-sample 1993 → 1997-09', '1993-01-01', '1997-09-09');
