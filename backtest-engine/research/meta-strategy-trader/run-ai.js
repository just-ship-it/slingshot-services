#!/usr/bin/env node
/**
 * Phase 2 driver: session-by-session AI ruleset oracle on top of the
 * 4-strategy FCFS meta-engine.
 *
 * Flow per ET session:
 *   1. Build packet from prior 5 sessions' trades + rejected signals + daily OHLC.
 *   2. Call Claude → get + validate ruleset JSON.
 *   3. Apply the ruleset to this session's signals (only) via the meta-engine.
 *   4. Append this session's results to the rolling lookback.
 *
 * Cold-start: first 5 sessions use plain FCFS (no AI call — no lookback yet).
 *
 * Output:
 *   - output/ai-runs/{runId}/summary.json
 *   - output/ai-runs/{runId}/rulesets.json (per-session ruleset history)
 *   - output/ai-runs/{runId}/trades.json
 *   - output/ai-runs/{runId}/per-session.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SecondDataProvider } from '../../src/data/csv-loader.js';
import { MetaEngine, FCFS_RULE, DEFAULT_COOLDOWNS } from './meta-engine.js';
import { MetaTraderClient } from './ai/claude-client.js';
import { createAiRule } from './ai/ai-rule.js';
import { buildPacket, loadDailyBarsFromOhlcv1m, etDateKey } from './ai/packet-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SIGNALS_DIR = path.join(ROOT, 'research/meta-strategy-trader/output/signals');
const ONE_SEC_CSV = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1s.csv');
const ONE_MIN_CSV = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1m.csv');
const STRATS = ['lstb', 'gfi', 'glx', 'glf'];
const COLD_START_DAYS = 5;
const LOOKBACK_DAYS = 5;
const EOD_CUTOFF_ET = '15:45';

function fmtUsd(n) {
  if (!Number.isFinite(n)) return String(n);
  const s = Math.round(Math.abs(n)).toLocaleString();
  return n < 0 ? `-$${s}` : `$${s}`;
}

function loadSignals(signalSet) {
  const all = [];
  for (const k of STRATS) {
    const j = JSON.parse(fs.readFileSync(path.join(SIGNALS_DIR, `${k}-${signalSet}.json`), 'utf8'));
    all.push(...j.signals);
  }
  return all.sort((a, b) => a.ts - b.ts);
}

// Group signals by ET trading-day. A "session" in this design is one ET date
// — straightforward but slightly imperfect for futures (overnight session
// crosses midnight UTC). For NQ, RTH is 09:30-16:00 ET, and the bulk of our
// signal activity is during RTH, so ET-date bucketing is reasonable for v0.
function groupSignalsByEtDate(signals) {
  const byDate = new Map();
  for (const s of signals) {
    const dk = etDateKey(s.ts);
    if (!byDate.has(dk)) byDate.set(dk, []);
    byDate.get(dk).push(s);
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function runOneSession({ sessionDateKey, sessionSignals, ruleset, sdp, mode = 'full' }) {
  // ai-rule's getRulesetForTs ignores ts in this single-day mode — same
  // ruleset for every signal in the session.
  const metaRule = ruleset
    ? createAiRule(() => ruleset, mode)
    : FCFS_RULE;
  const engine = new MetaEngine({
    signals: sessionSignals,
    secondDataProvider: sdp,
    metaRule,
    cooldownConfig: DEFAULT_COOLDOWNS,
    enabledStrategies: null,
    eodCutoffEt: EOD_CUTOFF_ET,
    marketCloseEt: null,
    commission: 5,
    contractFilter: null,  // multi-contract bar matching handled per-position
    verbose: false,
  });
  return engine.run();
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const runId = args.includes('--run-id') ? args[args.indexOf('--run-id') + 1] : `run-${Date.now()}`;
  const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'full';
  const signalSet = args.includes('--signal-set') ? args[args.indexOf('--signal-set') + 1] : 'jan13-feb13';
  if (!['full', 'preempt-only', 'conservative', 'protect-strategies', 'priority-hours', 'lstb-only-guards'].includes(mode)) {
    console.error(`Invalid --mode: ${mode}.`);
    process.exit(1);
  }
  const outDir = path.join(ROOT, 'research/meta-strategy-trader/output/ai-runs', runId);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`run-id:     ${runId}`);
  console.log(`mode:       ${mode}`);
  console.log(`signal-set: ${signalSet}`);
  console.log(`dry-run:    ${dryRun ? 'YES (no Claude calls, uses defaultRuleset for non-cold-start days)' : 'no'}`);
  console.log(`output:     ${outDir}\n`);

  // Load signals + group by ET session.
  console.log('Loading signal streams...');
  const allSignals = loadSignals(signalSet);
  const sessions = groupSignalsByEtDate(allSignals);
  console.log(`Loaded ${allSignals.length} signals across ${sessions.length} ET sessions\n`);

  // Load daily OHLC for the packet builder.
  const firstDate = sessions[0][0];
  const lastDate = sessions[sessions.length - 1][0];
  console.log(`Loading daily OHLC for ${firstDate} → ${lastDate}...`);
  const dailyBars = await loadDailyBarsFromOhlcv1m(ONE_MIN_CSV, firstDate, lastDate);
  console.log(`Loaded ${dailyBars.length} daily bars\n`);

  // 1s OHLCV index (shared across all session runs).
  console.log('Loading 1s OHLCV index...');
  const sdp = new SecondDataProvider(ONE_SEC_CSV);
  await sdp.initialize();
  console.log('');

  // FCFS reference: load Test B's per-trade output and bucket by ET session.
  // This lets the packet builder tell the AI what "doing nothing" produced
  // in the prior session — the bar it must beat.
  const fcfsBaselinePath = path.join(ROOT, `research/meta-strategy-trader/output/test-b-fcfs-baseline-${signalSet}.json`);
  let fcfsBySession = new Map();
  if (fs.existsSync(fcfsBaselinePath)) {
    const fcfs = JSON.parse(fs.readFileSync(fcfsBaselinePath, 'utf8'));
    for (const t of fcfs.trades) {
      const dk = etDateKey(t.entryTs);
      if (!fcfsBySession.has(dk)) fcfsBySession.set(dk, []);
      fcfsBySession.get(dk).push(t);
    }
    console.log(`Loaded FCFS reference: ${fcfsBySession.size} sessions of baseline trades\n`);
  } else {
    console.warn(`⚠  No FCFS baseline found at ${fcfsBaselinePath} — packet will omit FCFS reference\n`);
  }

  // AI client. Skipped on dry-run — defaultRuleset is used instead.
  let client = null;
  if (!dryRun) {
    client = new MetaTraderClient({ mode });
  }

  // Rolling state across sessions.
  const allTrades = [];
  const allRejections = [];
  const perSessionRows = [];
  const rulesetHistory = [];

  for (let i = 0; i < sessions.length; i++) {
    const [sessionDateKey, sessionSignals] = sessions[i];
    const isColdStart = i < COLD_START_DAYS;

    // Build lookback window: trades + rejections from the prior LOOKBACK_DAYS sessions.
    const cutoffDate = sessions[Math.max(0, i - LOOKBACK_DAYS)][0];
    const lookbackTrades = allTrades.filter(t => etDateKey(t.entryTs) >= cutoffDate && etDateKey(t.entryTs) < sessionDateKey);
    const lookbackRej = allRejections.filter(r => etDateKey(r.ts) >= cutoffDate && etDateKey(r.ts) < sessionDateKey);

    let ruleset = null;
    let aiMeta = { mode: 'fcfs_cold_start' };
    if (!isColdStart) {
      // 10 days of OHLC context (longer than trade lookback — strategies see
      // the LAST 10 sessions' price structure for pivot identification).
      const dailyForPacket = dailyBars.filter(b => b.date < sessionDateKey).slice(-10);

      // FCFS reference for the packet — prior session + full lookback window.
      let fcfsRef = null;
      if (fcfsBySession.size > 0) {
        const prevDate = sessions[i - 1][0];
        const prevTrades = fcfsBySession.get(prevDate) || [];
        const prevPnL = prevTrades.reduce((s, t) => s + t.netPnL, 0);
        const lookbackDates = sessions.slice(Math.max(0, i - LOOKBACK_DAYS), i).map(s => s[0]);
        const lookbackFcfs = lookbackDates.flatMap(d => fcfsBySession.get(d) || []);
        const lookbackFcfsPnL = lookbackFcfs.reduce((s, t) => s + t.netPnL, 0);
        fcfsRef = {
          prevSessionPnL: prevPnL,
          prevSessionTrades: prevTrades.length,
          lookbackPnL: lookbackFcfsPnL,
          lookbackTradesCount: lookbackFcfs.length,
        };
      }

      const { packetText, stats } = buildPacket({
        sessionDateKey, lookbackTrades, lookbackRejections: lookbackRej, dailyBars: dailyForPacket, fcfsRef,
      });
      if (dryRun) {
        ruleset = null; // null → FCFS
        aiMeta = { mode: 'fcfs_dry_run', packetChars: stats.packetChars };
      } else {
        const result = await client.requestRuleset(packetText, { sessionDateKey });
        ruleset = result.ruleset;
        aiMeta = {
          mode: result.error ? `ai_fallback_${result.error}` : 'ai',
          rationale: ruleset.rationale,
          packetChars: stats.packetChars,
        };
        rulesetHistory.push({ sessionDateKey, ruleset, rawText: result.rawText, error: result.error });
      }
    }

    // Run session
    const sessionResult = await runOneSession({ sessionDateKey, sessionSignals, ruleset, sdp, mode });
    const ss = sessionResult.summary;
    const sessPnL = sessionResult.trades.reduce((s, t) => s + t.netPnL, 0);

    console.log(`[${i + 1}/${sessions.length}] ${sessionDateKey}  signals=${sessionSignals.length}  trades=${ss.totalTrades}  pnl=${fmtUsd(sessPnL)}  WR=${ss.winRate.toFixed(0)}%  ${aiMeta.mode}`);
    if (aiMeta.rationale) console.log(`             rationale: ${aiMeta.rationale.slice(0, 120)}`);

    allTrades.push(...sessionResult.trades);
    allRejections.push(...sessionResult.rejections);
    perSessionRows.push({
      sessionDateKey,
      mode: aiMeta.mode,
      signals: sessionSignals.length,
      trades: ss.totalTrades,
      pnl: sessPnL,
      winRate: ss.winRate,
      rejections: sessionResult.rejections.length,
    });
  }

  // ── Aggregate report ────────────────────────────────────────────────
  const totalPnL = allTrades.reduce((s, t) => s + t.netPnL, 0);
  const wins = allTrades.filter(t => t.netPnL > 0).length;
  const grossWin = allTrades.filter(t => t.netPnL > 0).reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.netPnL <= 0).reduce((s, t) => s + t.netPnL, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  // Sharpe + MaxDD across all sessions
  const byDay = new Map();
  for (const t of allTrades) {
    const dk = etDateKey(t.exitTs);
    byDay.set(dk, (byDay.get(dk) || 0) + t.netPnL);
  }
  const daily = [...byDay.values()];
  const mean = daily.reduce((s, x) => s + x, 0) / Math.max(1, daily.length);
  const stdev = Math.sqrt(daily.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, daily.length));
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(252) : 0;
  let peak = 0, eq = 0, mdd = 0;
  for (const t of allTrades) {
    eq += t.netPnL;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > mdd) mdd = dd;
  }

  const summary = {
    runId,
    dryRun,
    period: { first: sessions[0][0], last: sessions[sessions.length - 1][0], sessions: sessions.length },
    coldStartDays: COLD_START_DAYS,
    lookbackDays: LOOKBACK_DAYS,
    totalTrades: allTrades.length,
    wins,
    winRate: allTrades.length ? (wins / allTrades.length) * 100 : 0,
    totalPnL,
    profitFactor: pf,
    sharpe,
    maxDD_usd: mdd,
    maxDD_pct: peak > 0 ? (mdd / peak) * 100 : 0,
    byStrategy: (() => {
      const out = {};
      for (const t of allTrades) {
        if (!out[t.strategy]) out[t.strategy] = { trades: 0, pnl: 0 };
        out[t.strategy].trades += 1;
        out[t.strategy].pnl += t.netPnL;
      }
      return out;
    })(),
    cost: client ? client.costSummary() : { mode: 'dry-run' },
  };

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Run summary: ${runId}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Sessions: ${summary.period.sessions} (cold-start: ${COLD_START_DAYS}, AI-driven: ${summary.period.sessions - COLD_START_DAYS})`);
  console.log(`  Trades:   ${summary.totalTrades}  WR ${summary.winRate.toFixed(1)}%`);
  console.log(`  Total PnL: ${fmtUsd(summary.totalPnL)}  PF ${summary.profitFactor.toFixed(2)}  Sharpe ${summary.sharpe.toFixed(2)}  DD ${fmtUsd(summary.maxDD_usd)} (${summary.maxDD_pct.toFixed(2)}%)`);
  // FCFS baseline reference: total PnL of all FCFS trades from the same signal set.
  const fcfsTotalPnL = [...fcfsBySession.values()].flat().reduce((s, t) => s + t.netPnL, 0);
  if (fcfsTotalPnL !== 0) {
    console.log(`  vs FCFS baseline ${fmtUsd(fcfsTotalPnL)}: ${fmtUsd(summary.totalPnL - fcfsTotalPnL)} (${(summary.totalPnL / fcfsTotalPnL * 100).toFixed(1)}%)`);
  }
  console.log(`  Per-strategy:`);
  for (const [strat, info] of Object.entries(summary.byStrategy)) {
    console.log(`    ${strat.padEnd(24)} trades=${String(info.trades).padStart(4)}  pnl=${fmtUsd(info.pnl).padStart(10)}`);
  }
  if (client) {
    console.log(`  Claude API: ${summary.cost.callCount} calls, ${summary.cost.inputTokens} in / ${summary.cost.outputTokens} out / cache-rd ${summary.cost.cacheReadTokens} / cache-wr ${summary.cost.cacheCreateTokens}`);
    console.log(`  Total cost: $${summary.cost.totalCostUsd.toFixed(4)}`);
  }

  // Write artifacts
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'trades.json'), JSON.stringify(allTrades, null, 2));
  fs.writeFileSync(path.join(outDir, 'rulesets.json'), JSON.stringify(rulesetHistory, null, 2));
  // per-session CSV
  const csvHeader = ['sessionDateKey', 'mode', 'signals', 'trades', 'pnl', 'winRate', 'rejections'];
  const csvLines = [csvHeader.join(',')];
  for (const r of perSessionRows) {
    csvLines.push(csvHeader.map(c => r[c] ?? '').join(','));
  }
  fs.writeFileSync(path.join(outDir, 'per-session.csv'), csvLines.join('\n'));
  console.log(`\n  Artifacts written to ${outDir}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
