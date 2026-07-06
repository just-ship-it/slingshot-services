#!/usr/bin/env node
/**
 * 02-build-signals.js — Construct the Threshold and Calendar rebalancing
 * signals exactly per Harvey/Mazzoleni/Melone (NBER w33554) Appendix B.
 *
 * Simulated 60/40 equity-bond portfolio, daily weight drift:
 *   drift(w, rE, rB) = w(1+rE) / ( w(1+rE) + (1-w)(1+rB) )
 *
 * Threshold sim (per δ): W[i] = |W[i-1]-0.60| >= δ ? 0.60 : drift(W[i-1], r[i])
 *   signal^δ[i] = drift(W[i-1], r[i]) - 0.60          (B.1)
 *   Aggregate Threshold signal = mean over δ ∈ {0, 0.001, ..., 0.025}   (eq. 2)
 *
 * Calendar sim: W[i] = (i-1 was last business day of month) ? 0.60 : drift(...)
 *   signal[i] = drift(W[i-1], r[i]) - 0.60            (B.2)
 *
 * Equity leg: SPY total return (adjclose). Bond leg variants:
 *   etf   : VFITX total return until IEF inception, IEF total return after
 *   dgs10 : 10Y par-bond daily total return from FRED DGS10 (revalue a par
 *           bond issued at yesterday's yield at today's yield + carry)
 *
 * Output: output/signals-<bond>.csv with
 *   date,retE,retB,thresholdSignal,calendarSignal,bdToMonthEnd,isFirstBD
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const OUT_DIR = path.join(__dirname, 'output');

function loadCsv(file, dateCol, valCol) {
  const lines = fs.readFileSync(path.join(DATA_DIR, file), 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const di = header.indexOf(dateCol);
  const vi = header.indexOf(valCol);
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const v = parseFloat(parts[vi]);
    if (!isNaN(v)) map.set(parts[di], v);
  }
  return map;
}

function toReturns(priceMap) {
  const dates = [...priceMap.keys()].sort();
  const ret = new Map();
  for (let i = 1; i < dates.length; i++) {
    ret.set(dates[i], priceMap.get(dates[i]) / priceMap.get(dates[i - 1]) - 1);
  }
  return ret;
}

/** 10Y par-bond daily total return from constant-maturity yields (decimal). */
function dgs10Returns() {
  const lines = fs.readFileSync(path.join(DATA_DIR, 'DGS10.csv'), 'utf8').trim().split('\n');
  const yields = [];
  for (let i = 1; i < lines.length; i++) {
    const [d, v] = lines[i].split(',');
    const y = parseFloat(v);
    if (!isNaN(y)) yields.push([d, y / 100]);
  }
  const ret = new Map();
  for (let i = 1; i < yields.length; i++) {
    const [, y0] = yields[i - 1];
    const [d, y1] = yields[i];
    // Par bond issued at y0 (semiannual coupon y0/2, 20 periods), revalued at y1
    const n = 20;
    const disc = Math.pow(1 + y1 / 2, -n);
    const annuity = (1 - disc) / (y1 / 2);
    const price = (y0 / 2) * annuity + disc; // per $1 face
    ret.set(d, price - 1 + y0 / 252); // price return + daily carry
  }
  return ret;
}

function buildBondReturns(variant) {
  if (variant === 'dgs10') return dgs10Returns();
  const vfitx = toReturns(loadCsv('VFITX.csv', 'date', 'adjclose'));
  const ief = toReturns(loadCsv('IEF.csv', 'date', 'adjclose'));
  const iefStart = [...ief.keys()].sort()[0];
  const merged = new Map();
  for (const [d, r] of [...vfitx.entries()].sort()) if (d < iefStart) merged.set(d, r);
  for (const [d, r] of [...ief.entries()].sort()) merged.set(d, r);
  return merged;
}

function drift(w, rE, rB) {
  const num = w * (1 + rE);
  return num / (num + (1 - w) * (1 + rB));
}

function build(variant) {
  const retE = toReturns(loadCsv('SPY.csv', 'date', 'adjclose'));
  const retB = buildBondReturns(variant);
  const dates = [...retE.keys()].filter((d) => retB.has(d)).sort();
  console.log(`[${variant}] aligned days: ${dates.length} (${dates[0]} → ${dates[dates.length - 1]})`);

  // Business-day calendar features from the aligned series itself
  const month = (d) => d.slice(0, 7);
  const bdToMonthEnd = new Array(dates.length); // 1 = last business day of month
  const isFirstBD = new Array(dates.length);
  for (let i = 0; i < dates.length; i++) {
    isFirstBD[i] = i === 0 ? true : month(dates[i]) !== month(dates[i - 1]);
    let cnt = 1;
    for (let j = i + 1; j < dates.length && month(dates[j]) === month(dates[i]); j++) cnt++;
    bdToMonthEnd[i] = cnt; // days remaining in month including today
  }

  // Threshold sims: δ = 0..2.5% step 0.1% (26 sims)
  const deltas = [];
  for (let k = 0; k <= 25; k++) deltas.push(k * 0.001);
  const W = deltas.map(() => 0.6);
  let Wcal = 0.6;

  const rows = ['date,retE,retB,thresholdSignal,calendarSignal,bdToMonthEnd,isFirstBD'];
  for (let i = 1; i < dates.length; i++) {
    const d = dates[i];
    const rE = retE.get(d);
    const rB = retB.get(d);

    let sum = 0;
    for (let k = 0; k < deltas.length; k++) {
      const drifted = drift(W[k], rE, rB);
      sum += drifted - 0.6;
      W[k] = Math.abs(W[k] - 0.6) >= deltas[k] ? 0.6 : drifted;
    }
    const thresholdSignal = sum / deltas.length;

    const driftedCal = drift(Wcal, rE, rB);
    const calendarSignal = driftedCal - 0.6;
    Wcal = bdToMonthEnd[i - 1] === 1 ? 0.6 : driftedCal;

    rows.push(`${d},${rE.toFixed(8)},${rB.toFixed(8)},${thresholdSignal.toFixed(8)},${calendarSignal.toFixed(8)},${bdToMonthEnd[i]},${isFirstBD[i] ? 1 : 0}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `signals-${variant}.csv`), rows.join('\n') + '\n');
  console.log(`[${variant}] wrote ${rows.length - 1} signal rows`);
}

build('etf');
build('dgs10');
