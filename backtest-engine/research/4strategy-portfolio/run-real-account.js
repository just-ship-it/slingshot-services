#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 4-strategy portfolio — REAL ACCOUNT simulation.
//
// WHY THIS EXISTS
// ---------------
// `run.js` scores the portfolio as an *infinite-tolerance* account: it sums each
// trade's pre-computed netPnL (in full-NQ $20/pt space), with no starting
// capital, no compounding, no contract sizing, no daily risk rules, and no ruin
// floor. Under that objective the fat-tail winners justify wide exits, so every
// optimization run says "don't touch the giveback." But the account Drew trades
// is a SMALL CASH account that ladders MNQ micros up/down with balance — a +$200
// giveback is 13% of a $1,500 account, and an early drawdown can end the account
// before any fat tail arrives. Sequence risk and giveback are first-class here.
//
// This simulator replays the SAME FCFS single-slot trade stream, but as a
// sequential, compounding, laddered equity curve on a real account, and reports
// a survival-focused scorecard instead of a 16-month terminal total.
//
// It deliberately does NOT re-price exits from mfe/mae (that would be a
// "theoretical" exit not validated on 1s data — exactly the trap CLAUDE.md warns
// about). It uses each trade's native, engine-simulated pointsPnL. Giveback is
// REPORTED here (from recorded mfePoints); giveback-PROTECTIVE exits are produced
// honestly by re-running the engine in Phase 2 and re-feeding their JSONs here.
//
// Usage:
//   node run-real-account.js                       # defaults below
//   node run-real-account.js --start 1500 --risk-pct 10 --max-contracts 10
//   node run-real-account.js --method fixed --qty 1
//   node run-real-account.js --commission-rt 1.50 --margin 100
//   node run-real-account.js --daily-loss 0 --giveback-lock 0   # disable daily rules
//   node run-real-account.js --strict-fill
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fmtET, fmtETDate } from '../multi-strategy-rules/lib/et-time.js';
import { fmtUsd, round } from '../multi-strategy-rules/lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..', '..');
const OUT_DIR   = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── CLI ──────────────────────────────────────────────────────────────────────
function argNum(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : def;
}
function argStr(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

const STRICT = process.argv.includes('--strict-fill');
const suf = STRICT ? '-strict-fill' : '';

// Balance-tier contract ladder — mirrors the dashboard account-tracker model
// (backtest-engine/research/no-trade-day/precompute-projection.py LADDER).
// (min_balance, n_mnq, n_nq). Below the first tier → 1 MNQ.
const LADDER = [
  [2000, 1, 0], [3500, 2, 0], [6000, 3, 0], [9000, 5, 0], [14000, 8, 0],
  [25000, 0, 1], [45000, 0, 2], [70000, 0, 3], [100000, 0, 4], [140000, 0, 5],
  [200000, 0, 7], [300000, 0, 10],
];

const CFG = {
  startBalance:   argNum('--start', 1500),
  mnqPointValue:  argNum('--mnq-pt', 2),           // MNQ micro = $2/pt
  nqPointValue:   argNum('--nq-pt', 20),           // NQ full   = $20/pt
  commMNQ:        argNum('--comm-mnq', 1.50),      // round-turn per MNQ (Tradovate all-in ≈ $1.20–1.50)
  commNQ:         argNum('--comm-nq', 5.00),       // round-turn per NQ
  marginMNQ:      argNum('--margin-mnq', 100),     // MNQ day-trade margin ≈ $100/ct
  marginNQ:       argNum('--margin-nq', 500),      // NQ day-trade margin ≈ $500/ct
  // Daily risk rules (0 disables). Defaults OFF here; the sweep script turns them on.
  // Expressed in POINTS (per contract) so thresholds scale automatically as the
  // ladder grows the account from $1.5k to six figures — a point is a point.
  dailyLossLimit: argNum('--daily-loss', 0),       // pts — stop for day if day's cumulative pts ≤ −X
  givebackLock:   argNum('--giveback-lock', 0),    // pts — stop for day after pts retrace ≥X from day peak
  givebackArm:    argNum('--giveback-arm', 0),     // pts — only arm the lock once day peak pts ≥X
};

// ── Strategy registry (same gold standards as run.js) ──────────────────────────
const STRATEGIES = [
  { key: 'lstb',           file: `data/gold-standard/ls-flip-trigger-bar-v3${suf}.json` },
  { key: 'gex-lt-3m',      file: `data/gold-standard/gex-lt-3m-crossover-v3${suf}.json` },
  { key: 'gex-flip-ivpct', file: `data/gold-standard/gex-flip-ivpct-v2${suf}.json` },
  { key: 'gex-level-fade', file: `data/gold-standard/gex-level-fade-v2${suf}.json` },
];

function normSide(s) {
  const l = String(s || '').toLowerCase();
  if (l === 'long' || l === 'buy') return 'long';
  if (l === 'short' || l === 'sell') return 'short';
  return null;
}

function loadTrades(def) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  return raw.trades
    .filter(t => t.status === 'completed' && t.entryTime != null && t.exitTime != null && normSide(t.side))
    .map(t => {
      const entryTime = t.entryTime;
      const rawExit = t.exitTime ?? (entryTime + (t.duration ?? 0));
      const exitTime = rawExit <= entryTime ? entryTime + 1 : rawExit;
      const stopPts = (t.entryPrice != null && t.stopLoss != null)
        ? Math.abs(t.entryPrice - t.stopLoss) : null;
      return {
        strategyKey: def.key,
        id: `${def.key}:${t.id}`,
        side: normSide(t.side),
        entryTime,
        exitTime,
        pointsPnL: t.pointsPnL,          // GROSS points, per 1 contract
        mfePoints: t.mfePoints ?? 0,     // peak favorable excursion (points)
        maePoints: t.maePoints ?? 0,     // peak adverse excursion (points)
        stopPts,
        exitReason: t.exitReason,
      };
    });
}

// Balance-tier ladder → which contract & how many at the current balance.
// Returns { n, pointValue, commission, margin, type }. n=0 means margin can't
// cover even one contract (account effectively dead).
function ladderFor(balance, cfg) {
  let nMnq = 1, nNq = 0; // floor: 1 MNQ below the first tier
  for (let i = LADDER.length - 1; i >= 0; i--) {
    if (balance >= LADDER[i][0]) { nMnq = LADDER[i][1]; nNq = LADDER[i][2]; break; }
  }
  if (nNq > 0) {
    const n = Math.min(nNq, Math.floor(balance / cfg.marginNQ));
    return { n, pointValue: cfg.nqPointValue, commission: cfg.commNQ, type: 'NQ' };
  }
  const n = Math.min(nMnq, Math.floor(balance / cfg.marginMNQ));
  return { n, pointValue: cfg.mnqPointValue, commission: cfg.commMNQ, type: 'MNQ' };
}

// ── Core simulation ────────────────────────────────────────────────────────────
function simulate(trades, cfg) {
  // Single FCFS slot, time-ordered. Sequential compounding balance.
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);

  let balance = cfg.startBalance;
  let peakEquity = balance;
  let maxDD$ = 0, maxDDpct = 0;
  let slotFreeAt = -Infinity;

  // Per-ET-day state for daily risk rules (tracked in POINTS, size-agnostic).
  let curDay = null;
  let dayPoints = 0, dayPeakPoints = 0, dayLocked = false;
  let lockedDays = 0, lossLimitDays = 0;

  let blown = null;            // { date, balance } once balance can't trade
  const realized = [];         // accepted+closed trades with $ pnl
  const equityCurve = [{ t: sorted.length ? sorted[0].entryTime : 0, balance }];
  const ctSizes = [];
  let givebackPts = 0;         // Σ max(0, mfe) − pointsPnL  over accepted trades
  let rejBusy = 0, rejDaily = 0;

  for (const tr of sorted) {
    if (blown) break;

    // Roll daily state at ET-day boundary.
    const day = fmtETDate(tr.entryTime);
    if (day !== curDay) {
      curDay = day;
      dayPoints = 0; dayPeakPoints = 0; dayLocked = false;
    }

    // FCFS slot: reject if a position is still open.
    if (tr.entryTime < slotFreeAt) { rejBusy++; continue; }

    // Daily risk-rule gating (points-based; checks trades already closed THIS day).
    if (!dayLocked) {
      if (cfg.dailyLossLimit > 0 && dayPoints <= -cfg.dailyLossLimit) {
        dayLocked = true; lossLimitDays++;
      } else if (cfg.givebackLock > 0 && dayPeakPoints >= (cfg.givebackArm || 0)
                 && (dayPeakPoints - dayPoints) >= cfg.givebackLock) {
        dayLocked = true; lockedDays++;
      }
    }
    if (dayLocked) { rejDaily++; continue; }

    // Size via balance-tier ladder on CURRENT balance.
    const lot = ladderFor(balance, cfg);
    if (lot.n < 1) {
      blown = { date: day, balance, reason: 'margin < 1 contract' };
      break;
    }

    // Realize the native trade.
    const grossPnL = tr.pointsPnL * lot.pointValue * lot.n;
    const commission = lot.commission * lot.n;
    const netPnL = grossPnL - commission;

    balance += netPnL;
    slotFreeAt = tr.exitTime;
    dayPoints += tr.pointsPnL;
    if (dayPoints > dayPeakPoints) dayPeakPoints = dayPoints;

    givebackPts += Math.max(0, tr.mfePoints) - tr.pointsPnL;
    ctSizes.push(`${lot.n}${lot.type === 'NQ' ? 'N' : 'M'}`);
    realized.push({ ...tr, contracts: lot.n, lotType: lot.type, netPnL, balanceAfter: balance });
    equityCurve.push({ t: tr.exitTime, balance });

    // Drawdown tracking on realized equity.
    if (balance > peakEquity) peakEquity = balance;
    const dd$ = peakEquity - balance;
    const ddpct = dd$ / peakEquity;
    if (dd$ > maxDD$) maxDD$ = dd$;
    if (ddpct > maxDDpct) maxDDpct = ddpct;

    // Ruin check (can't cover one MNQ margin).
    if (balance < cfg.marginMNQ) {
      blown = { date: day, balance, reason: 'balance < 1-contract margin' };
      break;
    }
  }

  return {
    cfg, balance, peakEquity, maxDD$, maxDDpct, blown,
    realized, equityCurve, ctSizes,
    givebackUsd: givebackPts * cfg.mnqPointValue, // 1-MNQ-scale lower bound
    rejBusy, rejDaily, lockedDays, lossLimitDays,
    nSignals: sorted.length,
  };
}

// ── Reporting helpers ──────────────────────────────────────────────────────────
function dailyPnL(realized) {
  const m = new Map();
  for (const t of realized) {
    const d = fmtETDate(t.exitTime);
    m.set(d, (m.get(d) || 0) + t.netPnL);
  }
  return m;
}

function summarize(res) {
  const wins = res.realized.filter(t => t.netPnL > 0).length;
  const losses = res.realized.filter(t => t.netPnL < 0).length;
  const grossWin = res.realized.filter(t => t.netPnL > 0).reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = -res.realized.filter(t => t.netPnL < 0).reduce((s, t) => s + t.netPnL, 0);
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const days = dailyPnL(res.realized);
  const dayVals = [...days.values()];
  const greenDays = dayVals.filter(v => v > 0).length;
  const redDays = dayVals.filter(v => v < 0).length;
  const worstDay = dayVals.length ? Math.min(...dayVals) : 0;
  const bestDay = dayVals.length ? Math.max(...dayVals) : 0;
  const ctDist = {};
  for (const c of res.ctSizes) ctDist[c] = (ctDist[c] || 0) + 1;
  const ctSummary = Object.entries(ctDist).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`).join(' ');
  return {
    trades: res.realized.length, wins, losses,
    wr: res.realized.length ? (100 * wins / res.realized.length) : 0,
    pf, greenDays, redDays, worstDay, bestDay, ctSummary, days: days.size,
  };
}

function pad(s, n) { return String(s).padEnd(n); }

function report(res, label) {
  const s = summarize(res);
  const ret = res.balance - res.cfg.startBalance;
  const retPct = 100 * ret / res.cfg.startBalance;
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  ${label}`);
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Account model : $${res.cfg.startBalance} start · MNQ $${res.cfg.mnqPointValue}/pt ($${res.cfg.commMNQ} RT) · NQ $${res.cfg.nqPointValue}/pt ($${res.cfg.commNQ} RT)`);
  console.log(`  Sizing        : balance-tier ladder (1 MNQ → 8 MNQ → 1–10 NQ), starts 1 MNQ`);
  if (res.cfg.dailyLossLimit > 0 || res.cfg.givebackLock > 0) {
    console.log(`  Daily rules   : loss-limit ${res.cfg.dailyLossLimit || '—'}pt · giveback-lock ${res.cfg.givebackLock || '—'}pt${res.cfg.givebackArm ? ` (arm ≥${res.cfg.givebackArm}pt)` : ''}`);
  }
  console.log();
  if (res.blown) {
    console.log(`  ☠  ACCOUNT BLEW UP on ${res.blown.date} — balance $${round(res.blown.balance)} (${res.blown.reason})`);
    console.log(`     Survived ${s.trades} trades / ${s.days} trading days before ruin.`);
  } else {
    console.log(`  ✓  SURVIVED full history.`);
  }
  console.log();
  console.log(`  Final balance : ${fmtUsd(res.balance)}   (${ret >= 0 ? '+' : ''}${fmtUsd(ret)}, ${round(retPct, 0)}% on start)`);
  console.log(`  Peak equity   : ${fmtUsd(res.peakEquity)}`);
  console.log(`  Max drawdown  : ${fmtUsd(res.maxDD$)}  (${round(100 * res.maxDDpct, 1)}% of peak)`);
  console.log(`  Trades taken  : ${s.trades}  ·  WR ${round(s.wr, 1)}%  ·  PF ${round(s.pf, 2)}`);
  console.log(`  Ladder usage  : ${s.ctSummary}`);
  console.log(`  Daily         : ${s.greenDays} green / ${s.redDays} red days · worst ${fmtUsd(s.worstDay)} · best ${fmtUsd(s.bestDay)}`);
  console.log(`  Giveback      : ${fmtUsd(res.givebackUsd)} of favorable excursion handed back (≥1-contract floor)`);
  console.log(`  Rejected      : ${res.rejBusy} slot-busy · ${res.rejDaily} daily-rule${res.lockedDays ? ` (${res.lockedDays} giveback-locked days)` : ''}${res.lossLimitDays ? ` (${res.lossLimitDays} loss-limit days)` : ''}`);
  console.log();
  return { res, s, ret, retPct };
}

function writeEquityCsv(file, curve) {
  const lines = ['ts_et,balance'];
  for (const p of curve) lines.push(`${fmtET(p.t)},${round(p.balance, 2)}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const all = [];
  for (const def of STRATEGIES) all.push(...loadTrades(def));
  console.log(`\nLoaded ${all.length} completed trades across ${STRATEGIES.length} strategies${STRICT ? ' (strict-fill)' : ''}.\n`);

  const res = simulate(all, CFG);
  report(res, '4-Strategy Portfolio — REAL ACCOUNT (FCFS, single slot)');

  writeEquityCsv(path.join(OUT_DIR, 'real-account-equity.csv'), res.equityCurve);
  console.log(`✓ Wrote ${OUT_DIR}/real-account-equity.csv (${res.equityCurve.length} points)\n`);

  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { simulate, loadTrades, ladderFor, summarize, STRATEGIES, CFG, LADDER };
