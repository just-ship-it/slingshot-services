/**
 * Phase 1 — Enrich gold-standard trades with LS features
 *
 * For each trade in each of the 3 gold-standard JSONs, compute LS features
 * at 1m/3m/15m using the sparse flip files from research/lt-extraction/output.
 *
 * Per-trade columns added (× 3 TFs):
 *   ls_state_at_entry_{tf}        0|1
 *   ls_state_at_exit_{tf}         0|1
 *   ls_favorable_at_entry_{tf}    bool — contrarian alignment per Phase 0:
 *                                   LONG  + state=0 → favorable
 *                                   SHORT + state=1 → favorable
 *   bars_since_last_flip_{tf}     minutes since last LS flip (entry)
 *   flips_in_prev_60m_{tf}        count of flips in [entry-60m, entry]
 *   flips_during_trade_{tf}       count of flips in (entry, exit)
 *   adverse_flips_during_{tf}     count of flips that went against position
 *                                   (LONG sees state→1, SHORT sees state→0)
 *   first_adverse_flip_ts_{tf}    timestamp of the first adverse flip (or null)
 *   bars_to_first_adverse_{tf}    minutes from entry to first adverse flip
 *
 * Outputs:
 *   enriched/{strategy}.json    — full enriched trades JSON
 *   output/01-enriched-summary.csv — flat-table version for fast slicing
 *
 * Run: node research/ls-overlay/src/01-enrich-trades.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..', '..');

const STRATEGIES = [
  { name: 'gex-flip-ivpct',       file: 'data/gold-standard/gex-flip-ivpct-tight-s60t200be70.json' },
  { name: 'gex-lt-3m-crossover',  file: 'data/gold-standard/gex-lt-3m-crossover.json' },
  { name: 'gex-level-fade',       file: 'data/gold-standard/gex-level-fade.json' },
];

const LS_FILES = [
  { tf: '1m',  file: 'research/lt-extraction/output/nq_ls_1m_raw.csv' },
  { tf: '3m',  file: 'research/lt-extraction/output/nq_ls_3m_raw.csv' },
  { tf: '15m', file: 'research/lt-extraction/output/nq_ls_15m_raw.csv' },
];

async function loadFlips(filePath) {
  const flips = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('data', (row) => {
        flips.push({ ts: +row.unix_ms, state: +row.state });
      })
      .on('end', resolve).on('error', reject);
  });
  flips.sort((a, b) => a.ts - b.ts);
  return flips;
}

// Binary search: largest idx where flips[idx].ts <= target. Returns -1 if none.
function findIdxAtOrBefore(flips, target) {
  let lo = 0, hi = flips.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flips[mid].ts <= target) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}

// First idx where flips[idx].ts >= target.
function findIdxAtOrAfter(flips, target) {
  let lo = 0, hi = flips.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (flips[mid].ts < target) lo = mid + 1;
    else hi = mid;
  }
  return lo < flips.length ? lo : -1;
}

function enrichTrade(trade, flipsByTf) {
  // Entry/exit timestamps in this codebase are stored as unix ms.
  const entryTs = trade.entryTime;
  const exitTs  = trade.exitTime;
  if (!entryTs || !exitTs) return; // skip incomplete trade
  const side = (trade.side || '').toLowerCase();
  const isLong = side === 'long' || side === 'buy';
  const isShort = side === 'short' || side === 'sell';

  for (const tf of Object.keys(flipsByTf)) {
    const flips = flipsByTf[tf];

    // Entry-side features
    const idxEntry = findIdxAtOrBefore(flips, entryTs);
    const stateEntry = idxEntry >= 0 ? flips[idxEntry].state : null;
    const barsSinceLast = idxEntry >= 0 ? (entryTs - flips[idxEntry].ts) / 60000 : null;
    let favorable = null;
    if (stateEntry !== null) {
      if (isLong)  favorable = (stateEntry === 0);
      if (isShort) favorable = (stateEntry === 1);
    }

    // Flip counts in lookback / during trade
    const lb60 = entryTs - 60 * 60_000;
    const idxLb = findIdxAtOrAfter(flips, lb60);
    const flipsPrev60 = idxLb < 0 ? 0 : Math.max(0, (idxEntry + 1) - idxLb);

    // First-adverse flip during the trade
    let flipsDuring = 0;
    let adverseFlipsDuring = 0;
    let firstAdverseTs = null;
    for (let i = idxEntry + 1; i < flips.length; i++) {
      const f = flips[i];
      if (f.ts <= entryTs) continue;
      if (f.ts >= exitTs) break;
      flipsDuring++;
      // "Adverse" = new state is the unfavorable side per Phase 0.
      // For LONG, adverse = state→1; for SHORT, adverse = state→0.
      const adverse = (isLong && f.state === 1) || (isShort && f.state === 0);
      if (adverse) {
        adverseFlipsDuring++;
        if (firstAdverseTs == null) firstAdverseTs = f.ts;
      }
    }

    // Exit-side state
    const idxExit = findIdxAtOrBefore(flips, exitTs);
    const stateExit = idxExit >= 0 ? flips[idxExit].state : null;

    trade[`ls_state_at_entry_${tf}`]    = stateEntry;
    trade[`ls_state_at_exit_${tf}`]     = stateExit;
    trade[`ls_favorable_at_entry_${tf}`] = favorable;
    trade[`bars_since_last_flip_${tf}`] = barsSinceLast != null ? +barsSinceLast.toFixed(1) : null;
    trade[`flips_in_prev_60m_${tf}`]    = flipsPrev60;
    trade[`flips_during_trade_${tf}`]   = flipsDuring;
    trade[`adverse_flips_during_${tf}`] = adverseFlipsDuring;
    trade[`first_adverse_flip_ts_${tf}`] = firstAdverseTs;
    trade[`bars_to_first_adverse_${tf}`] = firstAdverseTs != null ? +((firstAdverseTs - entryTs) / 60000).toFixed(1) : null;
  }
}

(async () => {
  const flipsByTf = {};
  for (const ls of LS_FILES) {
    flipsByTf[ls.tf] = await loadFlips(path.join(ROOT, ls.file));
    console.log(`Loaded ${ls.tf}: ${flipsByTf[ls.tf].length} flips`);
  }

  const summary = [];
  // CSV header for flat-table summary
  const csvCols = [
    'strategy', 'id', 'entryTime', 'exitTime', 'side', 'ruleId', 'netPnL', 'pointsPnL',
    'mfePoints', 'maePoints', 'exitReason',
  ];
  for (const tf of ['1m','3m','15m']) {
    csvCols.push(
      `ls_state_at_entry_${tf}`, `ls_state_at_exit_${tf}`, `ls_favorable_at_entry_${tf}`,
      `bars_since_last_flip_${tf}`, `flips_in_prev_60m_${tf}`,
      `flips_during_trade_${tf}`, `adverse_flips_during_${tf}`,
      `bars_to_first_adverse_${tf}`
    );
  }
  const csvLines = [csvCols.join(',')];

  for (const s of STRATEGIES) {
    const fp = path.join(ROOT, s.file);
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const trades = Array.isArray(raw) ? raw : (raw.trades || raw);
    console.log(`\n${s.name}: ${trades.length} trades`);

    for (const trade of trades) enrichTrade(trade, flipsByTf);

    fs.writeFileSync(
      path.join(__dirname, '..', 'enriched', `${s.name}.json`),
      JSON.stringify(trades, null, 0)
    );

    for (const t of trades) {
      const ruleId = (t.signal && t.signal.ruleId) || '';
      const row = [
        s.name, t.id, t.entryTime, t.exitTime, t.side, ruleId,
        t.netPnL, t.pointsPnL, t.mfePoints, t.maePoints, t.exitReason,
      ];
      for (const tf of ['1m','3m','15m']) {
        row.push(
          t[`ls_state_at_entry_${tf}`],
          t[`ls_state_at_exit_${tf}`],
          t[`ls_favorable_at_entry_${tf}`],
          t[`bars_since_last_flip_${tf}`],
          t[`flips_in_prev_60m_${tf}`],
          t[`flips_during_trade_${tf}`],
          t[`adverse_flips_during_${tf}`],
          t[`bars_to_first_adverse_${tf}`],
        );
      }
      csvLines.push(row.map(x => x == null ? '' : x).join(','));
    }

    summary.push({ strategy: s.name, n: trades.length });
  }

  fs.writeFileSync(
    path.join(__dirname, '..', 'output', '01-enriched-summary.csv'),
    csvLines.join('\n') + '\n'
  );

  console.log('\n=== Phase 1 done ===');
  console.log('Enriched JSONs in enriched/');
  console.log('Flat-table CSV: output/01-enriched-summary.csv');
})().catch(e => { console.error(e); process.exit(1); });
