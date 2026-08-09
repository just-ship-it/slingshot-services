/**
 * 09 — signal-parity harness for the live IntradayMomentumStrategy port.
 *
 * Streams raw ES 1m (primary contract per clock-hour by volume — same rule as
 * 02-precompute), feeds the shared strategy class chronologically, and
 * compares emitted signals (date + checkpoint) against the research trade
 * list (output/trades-recommended.ES.csv, 135 trades). Validates the ported
 * band math + decision-bar convention without the engine's 15h 1s replay.
 * (Exit fidelity is the engine's job — fixed-time exits are already validated
 * engine-wide via the PCC/Monday/gapfade ports.)
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { IntradayMomentumStrategy } from '../../../shared/strategies/intraday-momentum.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.join(__dirname, '..', '..', 'data', 'ohlcv', 'es', 'ES_ohlcv_1m.csv');
const TRADES = path.join(__dirname, 'output', 'trades-recommended.ES.csv');
const START = '2021-01-15', END = '2026-01-24';

async function pass1HourVolumes() {
  const hourVol = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(CSV, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let header = false;
  for await (const line of rl) {
    if (!header) { header = true; continue; }
    const p = line.split(',');
    if (p.length < 10) continue;
    const ts = p[0];
    if (ts < START) continue;
    if (ts > END + 'T23:59') break;
    const sym = p[9].trim();
    if (sym.includes('-')) continue;
    const hb = ts.slice(0, 13); // 'YYYY-MM-DDTHH'
    let hv = hourVol.get(hb);
    if (!hv) { hv = new Map(); hourVol.set(hb, hv); }
    hv.set(sym, (hv.get(sym) || 0) + (+p[8] || 0));
  }
  const primary = new Map();
  for (const [hb, hv] of hourVol) {
    let bs = '', bv = -1;
    for (const [s, v] of hv) if (v > bv) { bv = v; bs = s; }
    primary.set(hb, bs);
  }
  return primary;
}

async function main() {
  console.log('pass 1: hour-primary map ...');
  const primary = await pass1HourVolumes();

  console.log('pass 2: stream primary bars -> strategy ...');
  const strat = new IntradayMomentumStrategy({ debug: false });
  const signals = [];
  const rl = readline.createInterface({ input: fs.createReadStream(CSV, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let header = false;
  for await (const line of rl) {
    if (!header) { header = true; continue; }
    const p = line.split(',');
    if (p.length < 10) continue;
    const ts = p[0];
    if (ts < START) continue;
    if (ts > END + 'T23:59') break;
    const sym = p[9].trim();
    if (sym.includes('-')) continue;
    if (primary.get(ts.slice(0, 13)) !== sym) continue;
    const candle = {
      timestamp: new Date(ts).getTime(),
      open: +p[4], high: +p[5], low: +p[6], close: +p[7], volume: +p[8] || 0,
    };
    const sig = strat.evaluateSignal(candle, null, {}, {});
    if (sig) {
      signals.push({ date: sig.metadata.trading_date, cp: sig.metadata.checkpoint_min });
    }
  }

  const research = [];
  for (const line of fs.readFileSync(TRADES, 'utf8').trim().split('\n').slice(1)) {
    const [date, entryMin] = line.split(',');
    research.push({ date, cp: parseInt(entryMin, 10) });
  }

  const sigMap = new Map(signals.map(s => [s.date, s.cp]));
  const resMap = new Map(research.map(s => [s.date, s.cp]));
  let exact = 0, cpDiff = 0;
  const missing = [], extra = [];
  for (const r of research) {
    if (!sigMap.has(r.date)) missing.push(r.date);
    else if (sigMap.get(r.date) === r.cp) exact++;
    else { cpDiff++; }
  }
  for (const s of signals) if (!resMap.has(s.date)) extra.push(s.date);

  console.log(`\nresearch trades: ${research.length} | port signals: ${signals.length}`);
  console.log(`exact date+checkpoint matches: ${exact}`);
  console.log(`same date, different checkpoint: ${cpDiff}`);
  console.log(`research days MISSED by port: ${missing.length} ${missing.slice(0, 8).join(' ')}`);
  console.log(`port signals NOT in research: ${extra.length} ${extra.slice(0, 8).join(' ')}`);
  const ok = exact >= research.length * 0.95 && extra.length <= research.length * 0.05;
  console.log(ok ? '\nPARITY: PASS' : '\nPARITY: FAIL — investigate before deploy');
}

main();
