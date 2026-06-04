#!/usr/bin/env node
/**
 * Portfolio-filter research, step 01 — compile the UNION of all signals from the 4
 * production strategies (no FCFS), one row per completed trade, with causal signal-time
 * features + outcomes. This is the substrate for the oracle study (02) and the causal
 * meta-label filter (03).
 *
 * Production presets (match research/4strategy-portfolio/run.js):
 *   lstb-v3, gex-lt-3m-crossover-v3, gex-flip-ivpct-v2, gex-level-fade-v2
 *
 * Outcome fields (netPnL, win, mfePoints, ...) are for LABELING/oracle only — never to be
 * used as filter features (that would be lookahead). Step 03 enforces the causal subset.
 *
 * Usage: node research/portfolio-filter/01-compile-signals.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fmtET } from '../multi-strategy-rules/lib/et-time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

const STRICT = process.argv.includes('--strict-fill');
const suf = STRICT ? '-strict-fill' : '';
const STRATEGIES = [
  { key: 'lstb',           file: `data/gold-standard/ls-flip-trigger-bar-v3${suf}.json` },
  { key: 'gex-lt-3m',      file: `data/gold-standard/gex-lt-3m-crossover-v3${suf}.json` },
  { key: 'gex-flip-ivpct', file: `data/gold-standard/gex-flip-ivpct-v2${suf}.json` },
  { key: 'gex-level-fade', file: `data/gold-standard/gex-level-fade-v2${suf}.json` },
];

const normSide = s => { const l = String(s ?? '').toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : (l === 'short' || l === 'sell') ? 'short' : null; };
function etParts(ms) {
  const s = fmtET(ms);                       // "YYYY-MM-DD HH:MM:SS" in ET
  const hh = parseInt(s.slice(11, 13), 10), mm = parseInt(s.slice(14, 16), 10);
  const d = new Date(s.slice(0, 10) + 'T00:00:00Z');
  const dow = d.getUTCDay();                  // 0=Sun..6=Sat
  const minOfDay = hh * 60 + mm;
  const minFromOpen = minOfDay - 570;         // 9:30 ET = 570
  const session = hh < 9 || (hh === 9 && mm < 30) ? (hh >= 4 ? 'premarket' : 'overnight')
                : (minOfDay >= 570 && minOfDay < 960) ? 'rth'                 // 9:30-16:00
                : 'afterhours';
  return { hourET: hh, dow, minFromOpen, session, etDate: s.slice(0, 10) };
}

function num(x) { return (x === null || x === undefined || x === '') ? '' : x; }

const rows = [];
for (const def of STRATEGIES) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  let kept = 0;
  for (const t of j.trades) {
    if (t.status !== 'completed') continue;
    if (t.entryTime == null || t.exitTime == null) continue;
    const side = normSide(t.side); if (!side) continue;
    const sig = t.signal || {};
    const entry = t.actualEntry ?? t.entryPrice ?? sig.price;
    const et = etParts(t.entryTime);
    const stopPts = sig.stopPoints ?? sig.stopDistance ?? (t.stopLoss != null && entry != null ? Math.abs(entry - t.stopLoss) : '');
    const tgtPts = sig.targetPoints ?? sig.targetDistance ?? (t.takeProfit != null && entry != null ? Math.abs(t.takeProfit - entry) : '');
    const rr = (stopPts && tgtPts) ? +(tgtPts / stopPts).toFixed(2) : '';
    // distance of entry to the nearest structural reference each strategy provides
    const refs = [sig.callWall, sig.putWall, sig.gammaFlip, sig.gexPrice, sig.ltPrice, sig.levelPrice].filter(v => Number.isFinite(v));
    let distRef = ''; if (entry != null && refs.length) distRef = +Math.min(...refs.map(r => Math.abs(entry - r))).toFixed(2);
    const distCallWall = (entry != null && Number.isFinite(sig.callWall)) ? +(sig.callWall - entry).toFixed(2) : '';
    const distPutWall = (entry != null && Number.isFinite(sig.putWall)) ? +(entry - sig.putWall).toFixed(2) : '';

    rows.push({
      strategy: def.key, id: t.id, entryTime: t.entryTime, exitTime: t.exitTime,
      entryET: fmtET(t.entryTime), durationMin: +(((t.exitTime - t.entryTime) / 60000)).toFixed(1),
      side, dow: et.dow, hourET: et.hourET, minFromOpen: et.minFromOpen, session: et.session, etDate: et.etDate,
      // causal signal-time features
      stopPts: num(stopPts), tgtPts: num(tgtPts), rr: num(rr), maxHoldBars: num(sig.maxHoldBars),
      gexRegime: num(sig.gexRegime), ivPercentile: num(sig.ivPercentile), ivSkew: num(sig.ivSkew),
      ruleId: num(sig.ruleId), gexType: num(sig.gexType), ltIdx: num(sig.ltIdx), levelType: num(sig.levelType),
      distRef: num(distRef), distCallWall: num(distCallWall), distPutWall: num(distPutWall), entryPrice: num(entry),
      // OUTCOMES (label / oracle only — NOT filter features)
      netPnL: t.netPnL, pointsPnL: num(t.pointsPnL), win: t.netPnL > 0 ? 1 : 0,
      mfePoints: num(t.mfePoints), maePoints: num(t.maePoints), profitGiveBack: num(t.profitGiveBack),
      exitReason: t.exitReason ?? '',
    });
    kept++;
  }
  console.log(`${def.key.padEnd(16)} ${kept} completed trades`);
}
rows.sort((a, b) => a.entryTime - b.entryTime);

const HDR = Object.keys(rows[0]);
const out = fs.createWriteStream(path.join(OUT_DIR, 'signals.csv'));
out.write(HDR.join(',') + '\n');
for (const r of rows) out.write(HDR.map(h => r[h]).join(',') + '\n');
out.end();

// quick summary
const byStrat = {};
for (const r of rows) { const k = r.strategy; (byStrat[k] ??= { n: 0, w: 0, pnl: 0 }); byStrat[k].n++; byStrat[k].w += r.win; byStrat[k].pnl += r.netPnL; }
console.log(`\nUNION: ${rows.length.toLocaleString()} signals  ${new Date(rows[0].entryTime).toISOString().slice(0,10)} → ${new Date(rows[rows.length-1].entryTime).toISOString().slice(0,10)}`);
for (const [k, s] of Object.entries(byStrat)) console.log(`  ${k.padEnd(16)} n=${String(s.n).padStart(5)}  WR ${(100*s.w/s.n).toFixed(1)}%  stacked PnL $${Math.round(s.pnl).toLocaleString()}`);
console.log(`\n✓ wrote ${path.join(OUT_DIR, 'signals.csv')} (${rows.length} rows, ${HDR.length} cols)`);
