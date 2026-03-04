/**
 * Sweep Reversal Entry & Stop Analysis
 *
 * Reads trade CSV from a baseline sweep-reversal backtest and computes
 * winner vs loser statistics to identify where entry and stop placement
 * can be improved.
 *
 * Usage:
 *   node research/sweep-reversal-entry-analysis.js <csv-path> [--json output.json]
 */

import fs from 'fs';
import { round } from './utils/analysis-helpers.js';

// --- DST-aware ET conversion ---

const DST_CACHE = {};

function getDSTTransitions(year) {
  if (DST_CACHE[year]) return DST_CACHE[year];
  let sundayCount = 0, dstStart;
  for (let d = 1; d <= 31; d++) {
    if (new Date(Date.UTC(year, 2, d)).getUTCDay() === 0 && ++sundayCount === 2) {
      dstStart = Date.UTC(year, 2, d, 7, 0, 0);
      break;
    }
  }
  let dstEnd;
  for (let d = 1; d <= 30; d++) {
    if (new Date(Date.UTC(year, 10, d)).getUTCDay() === 0) {
      dstEnd = Date.UTC(year, 10, d, 6, 0, 0);
      break;
    }
  }
  DST_CACHE[year] = { dstStart, dstEnd };
  return DST_CACHE[year];
}

function utcToETHour(isoString) {
  const d = new Date(isoString);
  const utcMs = d.getTime();
  const year = d.getUTCFullYear();
  const { dstStart, dstEnd } = getDSTTransitions(year);
  const offset = (utcMs >= dstStart && utcMs < dstEnd) ? -4 : -5;
  const etMs = utcMs + offset * 3600000;
  return new Date(etMs).getUTCHours();
}

// --- CSV Parsing ---

function parseCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  const trades = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = values[idx] || ''; });
    trades.push(obj);
  }
  return trades;
}

/**
 * Parse a CSV line respecting quoted fields (for StrategyMetadata JSON)
 */
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// --- Stats Helpers ---

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function statSummary(arr, label) {
  return {
    label,
    n: arr.length,
    mean: round(mean(arr), 2),
    median: round(median(arr), 2),
    std: round(stddev(arr), 2),
    p10: round(pct(arr, 0.1), 2),
    p25: round(pct(arr, 0.25), 2),
    p75: round(pct(arr, 0.75), 2),
    p90: round(pct(arr, 0.9), 2),
    min: round(Math.min(...arr), 2),
    max: round(Math.max(...arr), 2),
  };
}

function printStatRow(s) {
  return `  ${s.label.padEnd(30)} n=${String(s.n).padStart(4)} | mean=${String(s.mean).padStart(8)} | med=${String(s.median).padStart(8)} | std=${String(s.std).padStart(7)} | p10=${String(s.p10).padStart(8)} | p25=${String(s.p25).padStart(8)} | p75=${String(s.p75).padStart(8)} | p90=${String(s.p90).padStart(8)}`;
}

function printCompare(label, winnersArr, losersArr) {
  const w = statSummary(winnersArr, `Winners`);
  const l = statSummary(losersArr, `Losers`);
  console.log(`\n--- ${label} ---`);
  console.log(printStatRow(w));
  console.log(printStatRow(l));

  if (w.n > 0 && l.n > 0) {
    const diff = round(w.mean - l.mean, 2);
    console.log(`  Delta (W-L mean): ${diff > 0 ? '+' : ''}${diff}`);
  }
}

// --- Main Analysis ---

function analyze(trades) {
  // Parse metadata and numeric fields
  const enriched = trades.map(t => {
    let meta = {};
    try {
      if (t.StrategyMetadata) meta = JSON.parse(t.StrategyMetadata);
    } catch (e) { /* ignore parse errors */ }

    return {
      id: t.TradeID,
      side: t.Side,
      entry: parseFloat(t.EntryPrice),
      exit: parseFloat(t.ExitPrice),
      stopLoss: parseFloat(t.StopLoss),
      takeProfit: parseFloat(t.TakeProfit),
      netPnL: parseFloat(t.NetPnL),
      grossPnL: parseFloat(t.GrossPnL),
      pointsPnL: parseFloat(t.PointsPnL),
      mfe: parseFloat(t.MFEPoints),
      mae: parseFloat(t.MAEPoints),
      profitGiveBack: parseFloat(t.ProfitGiveBack),
      exitReason: t.ExitReason,
      entryTime: t.EntryTime,
      exitTime: t.ExitTime,
      duration: parseFloat(t.Duration),
      strategy: t.Strategy,
      // Metadata fields
      asianHigh: parseFloat(meta.asianHigh),
      asianLow: parseFloat(meta.asianLow),
      asianRange: parseFloat(meta.asianRange),
      sweepSide: meta.sweepSide,
      sweepExtreme: parseFloat(meta.sweepExtreme),
      predictionConfidence: parseFloat(meta.predictionConfidence),
      gexRegime: meta.gexRegime,
      gexDistToOppositeWall: parseFloat(meta.gexDistanceToOppositeWall),
      tradingDate: meta.tradingDate,
    };
  }).filter(t => !isNaN(t.entry) && !isNaN(t.exit));

  if (enriched.length === 0) {
    console.log('No valid trades found in CSV.');
    return null;
  }

  // Check if metadata is present
  const hasMetadata = enriched.some(t => !isNaN(t.asianHigh));
  if (!hasMetadata) {
    console.log('WARNING: No strategy metadata found — entry/stop quality analysis will be limited.');
    console.log('Re-run the backtest with the updated CSV export to include StrategyMetadata.\n');
  }

  // Split winners/losers
  const winners = enriched.filter(t => t.netPnL > 0);
  const losers = enriched.filter(t => t.netPnL <= 0);
  const stopOuts = enriched.filter(t => t.exitReason === 'stop_loss');
  const tpHits = enriched.filter(t => t.exitReason === 'take_profit');
  const trailingHits = enriched.filter(t => t.exitReason === 'trailing_stop');
  const marketCloses = enriched.filter(t => t.exitReason === 'market_close');

  console.log('='.repeat(90));
  console.log('SWEEP REVERSAL — ENTRY & STOP ANALYSIS');
  console.log('='.repeat(90));
  console.log(`Total trades: ${enriched.length} | Winners: ${winners.length} (${round(winners.length / enriched.length * 100, 1)}%) | Losers: ${losers.length}`);
  console.log(`Exit breakdown: stop_loss=${stopOuts.length} | take_profit=${tpHits.length} | trailing=${trailingHits.length} | market_close=${marketCloses.length}`);

  const totalPnL = round(enriched.reduce((s, t) => s + t.netPnL, 0), 2);
  const avgWin = winners.length ? round(mean(winners.map(t => t.netPnL)), 2) : 0;
  const avgLoss = losers.length ? round(mean(losers.map(t => t.netPnL)), 2) : 0;
  console.log(`Total P&L: $${totalPnL} | Avg win: $${avgWin} | Avg loss: $${avgLoss}`);

  // ============================================================
  // 1. ENTRY QUALITY
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('1. ENTRY QUALITY');
  console.log('='.repeat(90));

  if (hasMetadata) {
    // Distance from entry to Asian boundary
    // For longs (after low sweep): entry - asianLow (smaller = better entry, closer to support)
    // For shorts (after high sweep): asianHigh - entry (smaller = better entry, closer to resistance)
    const entryDistances = enriched.map(t => {
      if (t.sweepSide === 'low') return { ...t, entryDist: t.entry - t.asianLow };
      if (t.sweepSide === 'high') return { ...t, entryDist: t.asianHigh - t.entry };
      return null;
    }).filter(Boolean);

    const winEntryDist = entryDistances.filter(t => t.netPnL > 0).map(t => t.entryDist);
    const loseEntryDist = entryDistances.filter(t => t.netPnL <= 0).map(t => t.entryDist);
    printCompare('Entry Distance from Asian Boundary (pts) — lower = better entry', winEntryDist, loseEntryDist);

    // Entry distance as % of Asian range
    const winEntryPct = entryDistances.filter(t => t.netPnL > 0 && t.asianRange > 0).map(t => round(t.entryDist / t.asianRange * 100, 1));
    const loseEntryPct = entryDistances.filter(t => t.netPnL <= 0 && t.asianRange > 0).map(t => round(t.entryDist / t.asianRange * 100, 1));
    printCompare('Entry Distance as % of Asian Range — lower = better entry', winEntryPct, loseEntryPct);

    // Entry hour analysis
    const hourBuckets = {};
    enriched.forEach(t => {
      if (!t.entryTime) return;
      const etHour = utcToETHour(t.entryTime);
      if (!hourBuckets[etHour]) hourBuckets[etHour] = { wins: 0, losses: 0, totalPnL: 0 };
      if (t.netPnL > 0) hourBuckets[etHour].wins++;
      else hourBuckets[etHour].losses++;
      hourBuckets[etHour].totalPnL += t.netPnL;
    });

    console.log('\n--- Entry Hour Breakdown (approx ET) ---');
    console.log('  Hour   Wins  Losses  WinRate    TotalPnL');
    Object.keys(hourBuckets).sort((a, b) => a - b).forEach(h => {
      const b = hourBuckets[h];
      const total = b.wins + b.losses;
      const wr = round(b.wins / total * 100, 1);
      console.log(`  ${String(h).padStart(4)}   ${String(b.wins).padStart(4)}   ${String(b.losses).padStart(5)}   ${String(wr).padStart(5)}%   $${round(b.totalPnL, 0)}`);
    });
  }

  // ============================================================
  // 2. STOP QUALITY
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('2. STOP QUALITY');
  console.log('='.repeat(90));

  // Risk taken (entry to stop, always positive)
  const riskPts = enriched.map(t => {
    if (isNaN(t.stopLoss) || isNaN(t.entry)) return null;
    return Math.abs(t.entry - t.stopLoss);
  }).filter(v => v !== null);

  const winRisk = winners.map(t => Math.abs(t.entry - t.stopLoss)).filter(v => !isNaN(v));
  const loseRisk = losers.map(t => Math.abs(t.entry - t.stopLoss)).filter(v => !isNaN(v));
  printCompare('Risk Taken (entry-to-stop, pts)', winRisk, loseRisk);

  if (hasMetadata) {
    // Risk as % of Asian range
    const winRiskPct = winners.filter(t => t.asianRange > 0).map(t => round(Math.abs(t.entry - t.stopLoss) / t.asianRange * 100, 1));
    const loseRiskPct = losers.filter(t => t.asianRange > 0).map(t => round(Math.abs(t.entry - t.stopLoss) / t.asianRange * 100, 1));
    printCompare('Risk as % of Asian Range', winRiskPct, loseRiskPct);

    // Sweep excursion beyond Asian boundary (how far price went past the range)
    const sweepExcursion = enriched.map(t => {
      if (isNaN(t.sweepExtreme)) return null;
      if (t.sweepSide === 'low') return { ...t, excursion: t.asianLow - t.sweepExtreme };
      if (t.sweepSide === 'high') return { ...t, excursion: t.sweepExtreme - t.asianHigh };
      return null;
    }).filter(Boolean);

    const winExcursion = sweepExcursion.filter(t => t.netPnL > 0).map(t => t.excursion);
    const loseExcursion = sweepExcursion.filter(t => t.netPnL <= 0).map(t => t.excursion);
    printCompare('Sweep Excursion Beyond Asian Boundary (pts)', winExcursion, loseExcursion);
  }

  // Stop-outs: how far past the stop did price go? (MAE - risk)
  const stopOutOvershoot = stopOuts.map(t => {
    const risk = Math.abs(t.entry - t.stopLoss);
    if (isNaN(risk) || isNaN(t.mae)) return null;
    return t.mae - risk; // how much farther than the stop price was hit
  }).filter(v => v !== null);

  if (stopOutOvershoot.length > 0) {
    const s = statSummary(stopOutOvershoot, 'Stop overshoot (MAE - risk)');
    console.log('\n--- Stop Overshoot on Stop-Outs (pts past stop level) ---');
    console.log(printStatRow(s));
    console.log(`  Interpretation: positive = price blew through stop; near-zero = barely clipped`);
  }

  // MAE distribution: winners vs losers
  const winMAE = winners.map(t => t.mae).filter(v => !isNaN(v));
  const loseMAE = losers.map(t => t.mae).filter(v => !isNaN(v));
  printCompare('MAE (max adverse excursion, pts)', winMAE, loseMAE);

  // ============================================================
  // 3. OPPORTUNITY METRICS
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('3. OPPORTUNITY METRICS');
  console.log('='.repeat(90));

  // MFE on losers (how much profit was available before the trade lost?)
  const loserMFE = losers.map(t => t.mfe).filter(v => !isNaN(v));
  if (loserMFE.length > 0) {
    const s = statSummary(loserMFE, 'Loser MFE (available profit)');
    console.log('\n--- MFE on Losing Trades (pts) ---');
    console.log(printStatRow(s));

    // How many losers had meaningful MFE?
    const mfe5 = loserMFE.filter(v => v >= 5).length;
    const mfe10 = loserMFE.filter(v => v >= 10).length;
    const mfe20 = loserMFE.filter(v => v >= 20).length;
    console.log(`  Losers with MFE >= 5pts: ${mfe5} (${round(mfe5 / loserMFE.length * 100, 1)}%)`);
    console.log(`  Losers with MFE >= 10pts: ${mfe10} (${round(mfe10 / loserMFE.length * 100, 1)}%)`);
    console.log(`  Losers with MFE >= 20pts: ${mfe20} (${round(mfe20 / loserMFE.length * 100, 1)}%)`);
  }

  // Profit give-back on winners (trailing stop efficiency)
  const winnerGiveBack = winners.map(t => t.profitGiveBack).filter(v => !isNaN(v));
  if (winnerGiveBack.length > 0) {
    const s = statSummary(winnerGiveBack, 'Winner profit give-back');
    console.log('\n--- Profit Give-Back on Winners (pts) ---');
    console.log(printStatRow(s));
  }

  // MFE overall: winners vs losers
  const winMFE = winners.map(t => t.mfe).filter(v => !isNaN(v));
  printCompare('MFE (max favorable excursion, pts)', winMFE, loserMFE);

  if (hasMetadata) {
    // Asian range size: winners vs losers
    const winRange = winners.map(t => t.asianRange).filter(v => !isNaN(v));
    const loseRange = losers.map(t => t.asianRange).filter(v => !isNaN(v));
    printCompare('Asian Range Size (pts)', winRange, loseRange);

    // Prediction confidence: winners vs losers
    const winConf = winners.map(t => t.predictionConfidence).filter(v => !isNaN(v));
    const loseConf = losers.map(t => t.predictionConfidence).filter(v => !isNaN(v));
    printCompare('Prediction Confidence', winConf, loseConf);

    // Win rate by prediction confidence bucket
    const confBuckets = {};
    enriched.forEach(t => {
      if (isNaN(t.predictionConfidence)) return;
      const conf = t.predictionConfidence;
      if (!confBuckets[conf]) confBuckets[conf] = { wins: 0, losses: 0, totalPnL: 0 };
      if (t.netPnL > 0) confBuckets[conf].wins++;
      else confBuckets[conf].losses++;
      confBuckets[conf].totalPnL += t.netPnL;
    });

    console.log('\n--- Win Rate by Prediction Confidence ---');
    console.log('  Conf   Wins  Losses  WinRate    TotalPnL     AvgPnL');
    Object.keys(confBuckets).sort((a, b) => a - b).forEach(c => {
      const b = confBuckets[c];
      const total = b.wins + b.losses;
      const wr = round(b.wins / total * 100, 1);
      console.log(`  ${String(c).padStart(4)}   ${String(b.wins).padStart(4)}   ${String(b.losses).padStart(5)}   ${String(wr).padStart(5)}%   $${String(round(b.totalPnL, 0)).padStart(8)}   $${round(b.totalPnL / total, 0)}`);
    });

    // Sweep side: longs vs shorts
    const sideBuckets = {};
    enriched.forEach(t => {
      const side = t.side || (t.sweepSide === 'low' ? 'Buy' : 'Sell');
      if (!sideBuckets[side]) sideBuckets[side] = { wins: 0, losses: 0, totalPnL: 0 };
      if (t.netPnL > 0) sideBuckets[side].wins++;
      else sideBuckets[side].losses++;
      sideBuckets[side].totalPnL += t.netPnL;
    });

    console.log('\n--- Win Rate by Trade Side ---');
    console.log('  Side    Wins  Losses  WinRate    TotalPnL     AvgPnL');
    Object.keys(sideBuckets).forEach(s => {
      const b = sideBuckets[s];
      const total = b.wins + b.losses;
      const wr = round(b.wins / total * 100, 1);
      console.log(`  ${s.padEnd(6)} ${String(b.wins).padStart(4)}   ${String(b.losses).padStart(5)}   ${String(wr).padStart(5)}%   $${String(round(b.totalPnL, 0)).padStart(8)}   $${round(b.totalPnL / total, 0)}`);
    });

    // GEX regime breakdown
    const regimeBuckets = {};
    enriched.forEach(t => {
      const regime = t.gexRegime || 'unknown';
      if (!regimeBuckets[regime]) regimeBuckets[regime] = { wins: 0, losses: 0, totalPnL: 0 };
      if (t.netPnL > 0) regimeBuckets[regime].wins++;
      else regimeBuckets[regime].losses++;
      regimeBuckets[regime].totalPnL += t.netPnL;
    });

    console.log('\n--- Win Rate by GEX Regime ---');
    console.log('  Regime                Wins  Losses  WinRate    TotalPnL     AvgPnL');
    Object.keys(regimeBuckets).sort().forEach(r => {
      const b = regimeBuckets[r];
      const total = b.wins + b.losses;
      const wr = round(b.wins / total * 100, 1);
      console.log(`  ${r.padEnd(20)} ${String(b.wins).padStart(4)}   ${String(b.losses).padStart(5)}   ${String(wr).padStart(5)}%   $${String(round(b.totalPnL, 0)).padStart(8)}   $${round(b.totalPnL / total, 0)}`);
    });
  }

  // ============================================================
  // 4. R:R ANALYSIS
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('4. RISK-REWARD ANALYSIS');
  console.log('='.repeat(90));

  // Actual R:R achieved
  const actualRR = enriched.map(t => {
    const risk = Math.abs(t.entry - t.stopLoss);
    if (isNaN(risk) || risk === 0) return null;
    return { ...t, rr: t.pointsPnL / risk };
  }).filter(Boolean);

  if (actualRR.length > 0) {
    const winRR = actualRR.filter(t => t.netPnL > 0).map(t => t.rr);
    const loseRR = actualRR.filter(t => t.netPnL <= 0).map(t => t.rr);
    printCompare('Actual R:R Achieved', winRR, loseRR);

    // Planned R:R (target / risk)
    const plannedRR = enriched.map(t => {
      const risk = Math.abs(t.entry - t.stopLoss);
      const reward = Math.abs(t.takeProfit - t.entry);
      if (isNaN(risk) || risk === 0 || isNaN(reward)) return null;
      return reward / risk;
    }).filter(Boolean);

    if (plannedRR.length > 0) {
      const s = statSummary(plannedRR, 'Planned R:R (target/risk)');
      console.log('\n--- Planned R:R Distribution ---');
      console.log(printStatRow(s));
    }
  }

  // ============================================================
  // 5. WHAT-IF: TIGHTER STOPS
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('5. WHAT-IF: ALTERNATIVE STOP DISTANCES');
  console.log('='.repeat(90));

  // For each alternative stop distance, count how many current winners would become losers
  // and how many current losers would still be losers
  if (riskPts.length > 0) {
    const currentMedianRisk = round(median(riskPts), 1);
    console.log(`\nCurrent median risk: ${currentMedianRisk} pts`);

    // Simulate tighter stops using MAE data
    const stopDistances = [5, 8, 10, 12, 15, 20, 25, 30, 35, 40, 50];
    console.log('\n  StopDist  SavedStops  LostWinners  NetSaved  EstPnLChange');

    const tradesWithMAE = enriched.filter(t => !isNaN(t.mae));
    stopDistances.forEach(stopDist => {
      // Current stop-outs that would be saved (their MAE didn't reach the tighter stop)
      // Actually the opposite: tighter stop means MORE stop-outs, not fewer
      // Let's think about it differently:
      // - Trades where MAE < stopDist: would survive with this stop
      // - Trades where MAE >= stopDist: would be stopped out

      let survived = 0;
      let stoppedOut = 0;
      let currentWinnersLost = 0;
      let currentLosersAvoided = 0;
      let pnlDelta = 0;

      tradesWithMAE.forEach(t => {
        const currentRisk = Math.abs(t.entry - t.stopLoss);
        if (isNaN(currentRisk)) return;

        if (t.mae >= stopDist && t.mae < currentRisk) {
          // Would be stopped out at new stop but survived current stop
          // This is a winner that becomes a loser (or a loser that exits earlier)
          if (t.netPnL > 0) {
            currentWinnersLost++;
            pnlDelta -= t.netPnL; // lose the winning P&L
            pnlDelta -= stopDist * 5; // lose stopDist * $5/pt (MNQ) instead
          }
        } else if (t.mae >= currentRisk && t.mae >= stopDist) {
          // Still stopped out, but maybe at a tighter level
          if (stopDist < currentRisk) {
            // Exits earlier at tighter stop — saves some loss
            const saved = (currentRisk - stopDist) * 5; // $5/pt for MNQ
            pnlDelta += saved;
            currentLosersAvoided++;
          }
        }
      });

      console.log(`  ${String(stopDist).padStart(7)}pts  ${String(currentLosersAvoided).padStart(10)}  ${String(currentWinnersLost).padStart(11)}  ${String(currentLosersAvoided - currentWinnersLost).padStart(8)}  $${round(pnlDelta, 0)}`);
    });
  }

  // ============================================================
  // 6. DURATION ANALYSIS
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('6. DURATION ANALYSIS');
  console.log('='.repeat(90));

  const winDurMin = winners.map(t => t.duration / 60000).filter(v => !isNaN(v));
  const loseDurMin = losers.map(t => t.duration / 60000).filter(v => !isNaN(v));
  printCompare('Trade Duration (minutes)', winDurMin, loseDurMin);

  // Stop-outs vs TP hits duration
  const stopDur = stopOuts.map(t => t.duration / 60000).filter(v => !isNaN(v));
  const tpDur = tpHits.map(t => t.duration / 60000).filter(v => !isNaN(v));
  if (stopDur.length > 0 && tpDur.length > 0) {
    printCompare('Duration: TP Hits vs Stop-Outs (minutes)', tpDur, stopDur);
  }

  console.log('\n' + '='.repeat(90));
  console.log('END OF ANALYSIS');
  console.log('='.repeat(90));

  return {
    totalTrades: enriched.length,
    winners: winners.length,
    losers: losers.length,
    winRate: round(winners.length / enriched.length * 100, 1),
    totalPnL,
  };
}

// --- CLI ---
const args = process.argv.slice(2);
const csvPath = args.find(a => !a.startsWith('--'));
const jsonIdx = args.indexOf('--json');
const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

if (!csvPath) {
  console.log('Usage: node research/sweep-reversal-entry-analysis.js <csv-path> [--json output.json]');
  process.exit(1);
}

if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

console.log(`Loading trades from: ${csvPath}\n`);
const trades = parseCSV(csvPath);
console.log(`Parsed ${trades.length} trades\n`);

const result = analyze(trades);

if (jsonPath && result) {
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  console.log(`\nSummary saved to: ${jsonPath}`);
}
