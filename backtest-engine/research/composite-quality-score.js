/**
 * Composite Quality Score — iv-skew-gex
 *
 * Builds a 0-5 point quality score per trade based on features that
 * discriminated winners from losers in the wall-magnitude + imbalance
 * sub-analyses. Then tests score thresholds for PF / Sharpe / max DD
 * impact on the FULL strategy equity curve (not just one bucket).
 *
 * Evaluates longs and shorts separately since they have different
 * discriminating features.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GexLoader } from '../src/data-loaders/gex-loader.js';
import { IVLoader } from '../src/data-loaders/iv-loader.js';
import { ShortDTEIVLoader } from '../src/data-loaders/short-dte-iv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKTEST_JSON = '/tmp/ivskew-results.json';
const START_DATE = new Date('2025-01-13');
const END_DATE = new Date('2026-01-23');

// ─── Feature extraction (subset relevant to scoring) ──────────────
function extract(trade, gexLoader, ivLoader, sdivLoader) {
  const ts = trade.entryTime;
  const f = {};
  const snap = gexLoader.getGexLevels(new Date(ts));
  const price = trade.actualEntry || trade.entryPrice;

  if (snap) {
    f.gamma_imbalance = snap.gamma_imbalance;
    f.put_wall_gex = snap.put_wall_gex != null ? Math.abs(snap.put_wall_gex) : null;
    f.call_wall_gex = snap.call_wall_gex;
    // Concentration (primary vs avg of rest)
    if (Array.isArray(snap.support_gex) && snap.support_gex.length >= 2) {
      const top = Math.abs(snap.support_gex[0]);
      const rest = snap.support_gex.slice(1).reduce((s,v)=>s+Math.abs(v),0) / (snap.support_gex.length - 1);
      f.put_wall_concentration = rest > 0 ? top/rest : null;
    }
    if (Array.isArray(snap.resistance_gex) && snap.resistance_gex.length >= 2) {
      const top = Math.abs(snap.resistance_gex[0]);
      const rest = snap.resistance_gex.slice(1).reduce((s,v)=>s+Math.abs(v),0) / (snap.resistance_gex.length - 1);
      f.call_wall_concentration = rest > 0 ? top/rest : null;
    }
    // Trade-level gamma (picked side)
    const sig = trade.signal || {};
    if (sig.levelPrice != null) {
      const arr = sig.levelCategory === 'resistance' ? snap.resistance : snap.support;
      const gArr = sig.levelCategory === 'resistance' ? snap.resistance_gex : snap.support_gex;
      if (Array.isArray(arr) && Array.isArray(gArr)) {
        let bi = -1, bd = Infinity;
        for (let i = 0; i < arr.length; i++) {
          const d = Math.abs(arr[i] - sig.levelPrice);
          if (d < bd) { bd = d; bi = i; }
        }
        if (bi >= 0 && bd < 50) {
          f.trade_level_gex = Math.abs(gArr[bi]);
          f.trade_level_rank = bi;
        }
      }
    }
  }

  const sdiv = sdivLoader.getIVAtTime(ts);
  if (sdiv) f.dte0_skew = sdiv.dte0_skew;

  return f;
}

// ─── Scoring rules ────────────────────────────────────────────────
function scoreLong(f) {
  let s = 0;
  const details = [];
  // Not in the problem bucket (or if we are, the sub-features are favorable)
  if (f.gamma_imbalance != null) {
    if (Math.abs(f.gamma_imbalance) < 0.2) { s++; details.push('balanced_gamma'); }
    else if (f.gamma_imbalance < -0.5) {
      // In the bad bucket — but the following can rescue it
      if (f.put_wall_gex != null && f.put_wall_gex > 1e9) { s++; details.push('strong_put_wall_1B+'); }
      if (f.put_wall_concentration != null && f.put_wall_concentration > 2.5) { s++; details.push('put_wall_dominant'); }
      if (f.trade_level_gex != null && f.trade_level_gex > 500e6) { s++; details.push('high_level_gex'); }
      if (f.dte0_skew != null && f.dte0_skew >= -0.005) { s++; details.push('0dte_skew_not_inverted'); }
    } else {
      // Not in bad bucket — give lighter credit for decent structure
      if (f.put_wall_gex != null && f.put_wall_gex > 500e6) { s++; details.push('put_wall_solid'); }
      if (f.dte0_skew != null && f.dte0_skew >= -0.005) { s++; details.push('0dte_skew_ok'); }
    }
  }
  // Universal quality marker: primary-level trade
  if (f.trade_level_rank === 0) { s++; details.push('primary_wall'); }
  return { score: s, details };
}

function scoreShort(f) {
  let s = 0;
  const details = [];
  // Rank-0 wall was the huge winner (83% WR)
  if (f.trade_level_rank === 0) { s += 2; details.push('primary_wall_x2'); }
  else if (f.trade_level_rank === 2) { s += 1; details.push('rank2_wall'); }
  // Call wall magnitude
  if (f.call_wall_gex != null && f.call_wall_gex > 500e6) { s++; details.push('strong_call_wall'); }
  if (f.call_wall_concentration != null && f.call_wall_concentration > 2.5) { s++; details.push('call_wall_dominant'); }
  // 0-DTE skew positive (puts expensive, bearish flow confirmation)
  if (f.dte0_skew != null && f.dte0_skew > 0) { s++; details.push('0dte_skew_bearish'); }
  return { score: s, details };
}

// ─── Equity curve & risk metrics ──────────────────────────────────
function equityMetrics(trades) {
  const sorted = [...trades].sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0));
  let equity = 0, peak = 0, maxDD = 0, maxDDPct = 0;
  const curve = [];
  const dailyReturns = new Map();
  for (const t of sorted) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    if (peak > 0 && dd/peak > maxDDPct) maxDDPct = dd/peak;
    curve.push({ ts: t.entryTime, equity, peak, dd });
    const day = new Date(t.entryTime).toISOString().slice(0, 10);
    dailyReturns.set(day, (dailyReturns.get(day) || 0) + t.netPnL);
  }
  const dailyVals = Array.from(dailyReturns.values());
  const mean = dailyVals.reduce((s,v)=>s+v,0) / Math.max(1, dailyVals.length);
  const variance = dailyVals.reduce((s,v)=>s+(v-mean)**2,0) / Math.max(1, dailyVals.length);
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(252) : 0;

  const wins = sorted.filter(t => t.netPnL > 0);
  const losses = sorted.filter(t => t.netPnL <= 0);
  const wg = wins.reduce((s,t)=>s+t.netPnL,0);
  const lg = Math.abs(losses.reduce((s,t)=>s+t.netPnL,0));

  return {
    trades: sorted.length,
    wr: sorted.length ? wins.length/sorted.length*100 : 0,
    pf: lg > 0 ? wg/lg : Infinity,
    pnl: equity,
    maxDD, maxDDPct: maxDDPct*100,
    sharpe,
    tradingDays: dailyVals.length,
  };
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  COMPOSITE QUALITY SCORE — PF/Sharpe/DD evaluation        ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const results = JSON.parse(fs.readFileSync(BACKTEST_JSON, 'utf8'));
  const all = results.trades;
  const longs = all.filter(t => t.side === 'buy' || t.side === 'long');
  const shorts = all.filter(t => t.side === 'sell' || t.side === 'short');

  console.log('Loading data...');
  const gexLoader = new GexLoader(path.join(DATA_DIR, 'gex'), 'nq');
  await gexLoader.loadDateRange(START_DATE, END_DATE);
  const ivLoader = new IVLoader(DATA_DIR, { resolution: '1m' });
  await ivLoader.load(START_DATE, END_DATE);
  const sdivLoader = new ShortDTEIVLoader(DATA_DIR);
  await sdivLoader.load(START_DATE, END_DATE);
  console.log('Done.\n');

  // Tag trades with features + score
  const tagged = all.map(t => {
    const f = extract(t, gexLoader, ivLoader, sdivLoader);
    const side = (t.side === 'sell' || t.side === 'short') ? 'short' : 'long';
    const { score, details } = side === 'short' ? scoreShort(f) : scoreLong(f);
    return { ...t, _f: f, _score: score, _details: details, _side: side };
  });

  // Distribution
  console.log('══ SCORE DISTRIBUTION ═══════════════════════════════');
  const dist = { long: {}, short: {} };
  for (const t of tagged) {
    const d = dist[t._side];
    d[t._score] = (d[t._score] || 0) + 1;
  }
  console.log('Score | Longs | Shorts');
  for (let s = 0; s <= 6; s++) {
    const l = dist.long[s] || 0, sh = dist.short[s] || 0;
    if (l || sh) console.log(`  ${s}   |  ${String(l).padStart(4)} |  ${String(sh).padStart(4)}`);
  }

  // Baseline (full portfolio)
  console.log('\n══ BASELINE (ALL TRADES) ════════════════════════════');
  const base = equityMetrics(tagged);
  console.log(`  Trades: ${base.trades} | WR: ${base.wr.toFixed(1)}% | PF: ${base.pf.toFixed(2)} | PnL: $${base.pnl.toFixed(0)}`);
  console.log(`  Max DD: $${base.maxDD.toFixed(0)} (${base.maxDDPct.toFixed(1)}%) | Sharpe (daily, ann): ${base.sharpe.toFixed(2)}`);

  // Try threshold filters — suppress trades below score X per side
  console.log('\n══ THRESHOLD SWEEP (keep trades with score >= X per side) ═════');
  console.log('Min score (L/S) | Trades | WR% | PF | PnL | MaxDD% | Sharpe | vs Baseline');
  console.log('-'.repeat(105));

  const rows = [];
  // Combined sweep
  for (const longMin of [0, 1, 2, 3]) {
    for (const shortMin of [0, 1, 2, 3, 4]) {
      const kept = tagged.filter(t =>
        (t._side === 'long' ? t._score >= longMin : t._score >= shortMin)
      );
      if (kept.length < 20) continue;
      const m = equityMetrics(kept);
      const pnlDelta = m.pnl - base.pnl;
      const pfDelta = m.pf - base.pf;
      const ddDelta = m.maxDDPct - base.maxDDPct;
      const sharpeDelta = m.sharpe - base.sharpe;
      rows.push({ longMin, shortMin, m, pnlDelta, pfDelta, ddDelta, sharpeDelta });
    }
  }
  // Sort by a risk-adjusted score: prefer higher PF + lower DD, penalize PnL loss a little
  rows.sort((a, b) => {
    const aScore = a.pfDelta * 10 - a.ddDelta - a.pnlDelta/50000;
    const bScore = b.pfDelta * 10 - b.ddDelta - b.pnlDelta/50000;
    return bScore - aScore;
  });

  for (const r of rows.slice(0, 15)) {
    const marker = (r.pfDelta > 0 && r.ddDelta < 0) ? '✓ better risk' :
                   (r.pfDelta < 0 && r.ddDelta > 0) ? '✗ worse risk' :
                   (r.pfDelta > 0) ? '~ pf up, dd up' : '~ mixed';
    console.log(
      `L>=${r.longMin} S>=${r.shortMin}        | ${String(r.m.trades).padStart(4)} | ${r.m.wr.toFixed(1).padStart(4)} | ${r.m.pf.toFixed(2).padStart(5)} | $${r.m.pnl.toFixed(0).padStart(7)} | ${r.m.maxDDPct.toFixed(1).padStart(5)} | ${r.m.sharpe.toFixed(2).padStart(5)} | ` +
      `ΔPF ${(r.pfDelta>=0?'+':'')}${r.pfDelta.toFixed(2)} ΔDD ${(r.ddDelta>=0?'+':'')}${r.ddDelta.toFixed(1)}% ΔPnL ${(r.pnlDelta>=0?'+':'')}$${r.pnlDelta.toFixed(0)} ΔSharpe ${(r.sharpeDelta>=0?'+':'')}${r.sharpeDelta.toFixed(2)} ${marker}`
    );
  }

  // Per-score bucket analysis (what's the edge at each score level?)
  console.log('\n══ PER-SCORE BUCKETS ══════════════════════════════════');
  for (const side of ['long', 'short']) {
    console.log(`\n  ${side.toUpperCase()}S`);
    console.log('  Score |  N  |  WR%  |  PF  |  PnL   |  Avg$');
    console.log('  ' + '-'.repeat(54));
    for (let s = 0; s <= 6; s++) {
      const b = tagged.filter(t => t._side === side && t._score === s);
      if (b.length < 3) continue;
      const m = equityMetrics(b);
      console.log(`    ${s}   | ${String(b.length).padStart(3)} | ${m.wr.toFixed(1).padStart(5)} | ${m.pf.toFixed(2).padStart(4)} | $${m.pnl.toFixed(0).padStart(6)} | $${(m.pnl/b.length).toFixed(0).padStart(6)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
