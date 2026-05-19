/**
 * Phase 0 — LS edge sanity probe on dumper trades
 *
 * The LS dumper enters LONG on every flip and exits on the next flip.
 * Its gross PnL equals NQ buy-and-hold over the window (which we confirmed).
 *
 * The question this probe answers: does the LS state at trade entry
 * PREDICT the trade's PnL? If "long held during a B=1 (bullish-state) run"
 * has materially higher avg PnL than "long held during a B=0 (bearish-state)
 * run", then LS has a forward-looking directional signal we can exploit.
 *
 * Pairs each Entry row with its matching Exit row by Trade #, then groups
 * trade PnLs by entry-B value. Reports avg/median PnL, WR, duration per
 * (TF, entry-B) cell.
 *
 * Run: node research/ls-overlay/src/00-dumper-edge-probe.js
 * Output: research/ls-overlay/output/00-dumper-edge.json + console table
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';
import ExcelJS from 'exceljs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..', '..');

const FILES = [
  { tf: '1m',  path: path.join(ROOT, 'research/lt-extraction/exports/LS_Dumper_CME_MINI_NQ1!_2026-05-18_02f75.xlsx') },
  { tf: '3m',  path: path.join(ROOT, 'research/lt-extraction/exports/LS_Dumper_CME_MINI_NQ1!_2026-05-19_39215.csv')  },
  { tf: '15m', path: path.join(ROOT, 'research/lt-extraction/exports/LS_Dumper_CME_MINI_NQ1!_2026-05-19_f866e.csv')  },
];

function parseB(comment) {
  if (!comment || typeof comment !== 'string') return null;
  const m = comment.match(/B=([01])/);
  return m ? +m[1] : null;
}

async function readXlsx(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet('List of trades');
  const header = ws.getRow(1).values;
  const col = {};
  for (let i = 1; i < header.length; i++) {
    const lc = String(header[i] ?? '').toLowerCase();
    if (lc === 'trade #') col.tradeNum = i;
    else if (lc === 'type') col.type = i;
    else if (lc.includes('signal')) col.signal = col.signal ?? i;
    else if (lc.includes('price')) col.price = col.price ?? i;
    else if (lc.includes('date and time')) col.dt = i;
  }
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    rows.push({
      tradeNum: row.getCell(col.tradeNum).value,
      type: row.getCell(col.type).value,
      signal: row.getCell(col.signal).value,
      price: Number(row.getCell(col.price).value),
      dt: row.getCell(col.dt).value, // Date object
    });
  });
  return rows;
}

async function readCsvRows(filePath) {
  const rows = [];
  const colMap = {};
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('headers', (h) => {
        for (const c of h) {
          // Strip BOM and other non-ascii leading chars from header names
          const lc = c.replace(/^[^\w]+/, '').toLowerCase();
          if (lc === 'trade #') colMap.tradeNum = c;
          else if (lc === 'type') colMap.type = c;
          else if (lc.includes('signal') && !colMap.signal) colMap.signal = c;
          else if (lc.startsWith('price') && !colMap.price) colMap.price = c;
          else if (lc.includes('date and time')) colMap.dt = c;
        }
      })
      .on('data', (row) => {
        rows.push({
          tradeNum: +row[colMap.tradeNum],
          type: row[colMap.type],
          signal: row[colMap.signal],
          price: Number(row[colMap.price]),
          dt: row[colMap.dt],
        });
      })
      .on('end', resolve).on('error', reject);
  });
  return rows;
}

function parseDt(d) {
  // CSV gives "YYYY-MM-DD HH:MM" (assume UTC since TV exports in chart TZ
  // but we use the comment T= for canonical ts elsewhere). For duration
  // calc only the relative difference matters; treat as UTC.
  if (d instanceof Date) return d.getTime();
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], 0);
  }
  return null;
}

async function probe(tf, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const rows = ext === '.xlsx' ? await readXlsx(filePath) : await readCsvRows(filePath);

  // Group rows by tradeNum, pair entry + exit.
  const byTrade = new Map();
  for (const r of rows) {
    const tn = +r.tradeNum;
    if (!Number.isFinite(tn)) continue;
    if (!byTrade.has(tn)) byTrade.set(tn, {});
    const slot = byTrade.get(tn);
    const typeLc = String(r.type ?? '').toLowerCase();
    if (typeLc.includes('entry')) slot.entry = r;
    else if (typeLc.includes('exit')) slot.exit = r;
  }

  const trades = [];
  for (const [tn, slot] of byTrade) {
    if (!slot.entry || !slot.exit) continue;
    const B = parseB(slot.entry.signal);
    if (B === null) continue;
    // Always-long dumper: PnL points = exit - entry
    const pts = slot.exit.price - slot.entry.price;
    const pnl = pts * 20; // $20/pt for NQ
    const dEntry = parseDt(slot.entry.dt);
    const dExit = parseDt(slot.exit.dt);
    const durMin = (dEntry != null && dExit != null) ? (dExit - dEntry) / 60000 : null;
    trades.push({ tn, B, pts, pnl, durMin });
  }
  return trades;
}

function stats(trades, label) {
  if (!trades.length) return { label, n: 0, sumPnL: 0, avg: 0, med: 0, wr: 0, pf: 0, min: 0, max: 0, medDurMin: null };
  const n = trades.length;
  const pnls = trades.map(t => t.pnl).sort((a,b) => a - b);
  const wins = trades.filter(t => t.pnl > 0).length;
  const sumPnL = pnls.reduce((s,x) => s + x, 0);
  const avg = sumPnL / n;
  const med = pnls[Math.floor(n/2)];
  const max = pnls[n-1], min = pnls[0];
  const grossWin = trades.filter(t => t.pnl > 0).reduce((s,t) => s + t.pnl, 0);
  const grossLoss = -trades.filter(t => t.pnl < 0).reduce((s,t) => s + t.pnl, 0);
  const pf = grossLoss === 0 ? Infinity : grossWin / grossLoss;
  const durs = trades.map(t => t.durMin).filter(x => x != null).sort((a,b) => a - b);
  const medDur = durs.length ? durs[Math.floor(durs.length/2)] : null;
  return {
    label, n, sumPnL,
    avg: +avg.toFixed(2),
    med: +med.toFixed(2),
    wr: +(100 * wins/n).toFixed(2),
    pf: pf === Infinity ? 'inf' : +pf.toFixed(2),
    min, max, medDurMin: medDur,
  };
}

(async () => {
  const out = { byTf: {}, summary: [] };
  for (const f of FILES) {
    const trades = await probe(f.tf, f.path);
    const all = stats(trades, 'all');
    const b1  = stats(trades.filter(t => t.B === 1), 'B=1');
    const b0  = stats(trades.filter(t => t.B === 0), 'B=0');
    out.byTf[f.tf] = { all, b1, b0 };

    // Effect sizes
    const diff = b1.avg - b0.avg;
    const ratio = b0.avg !== 0 ? +(b1.avg / b0.avg).toFixed(2) : null;

    out.summary.push({ tf: f.tf, b1_avg: b1.avg, b0_avg: b0.avg, diff: +diff.toFixed(2), wr_b1: b1.wr, wr_b0: b0.wr, n_b1: b1.n, n_b0: b0.n });
  }

  fs.writeFileSync(
    path.join(__dirname, '..', 'output', '00-dumper-edge.json'),
    JSON.stringify(out, null, 2)
  );

  console.log('\n=== Phase 0: LS Dumper Edge Probe ===\n');
  for (const f of FILES) {
    const r = out.byTf[f.tf];
    console.log(`-- ${f.tf} --`);
    console.log(`  ALL  n=${r.all.n.toString().padStart(6)}  sumPnL=$${Math.round(r.all.sumPnL).toString().padStart(8)}  avg=$${r.all.avg.toString().padStart(8)}  med=$${r.all.med.toString().padStart(7)}  WR=${r.all.wr}%  PF=${r.all.pf}  medDur=${r.all.medDurMin}m`);
    console.log(`  B=1  n=${r.b1.n.toString().padStart(6)}  sumPnL=$${Math.round(r.b1.sumPnL).toString().padStart(8)}  avg=$${r.b1.avg.toString().padStart(8)}  med=$${r.b1.med.toString().padStart(7)}  WR=${r.b1.wr}%  PF=${r.b1.pf}  medDur=${r.b1.medDurMin}m`);
    console.log(`  B=0  n=${r.b0.n.toString().padStart(6)}  sumPnL=$${Math.round(r.b0.sumPnL).toString().padStart(8)}  avg=$${r.b0.avg.toString().padStart(8)}  med=$${r.b0.med.toString().padStart(7)}  WR=${r.b0.wr}%  PF=${r.b0.pf}  medDur=${r.b0.medDurMin}m`);
    console.log(`  diff (B=1 − B=0) = $${(r.b1.avg - r.b0.avg).toFixed(2)} avg, WR Δ=${(r.b1.wr - r.b0.wr).toFixed(1)}pp\n`);
  }
})().catch(e => { console.error(e); process.exit(1); });
