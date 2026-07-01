/**
 * lib/book-with-fib.js -- the canonical 4-strategy FCFS book (via deck-filters loadAnnotated,
 * baseline-exact) with MTF-fib confluence features attached to the two mean-reversion strategies
 * (gex-level-fade, gex-flip-ivpct). Other strategies pass through untouched.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAnnotated } from '../../deck-filters/lib/annotate.js';
import { fibFeatures } from './fib-confluence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');           // backtest-engine/
export const MR_KEYS = new Set(['gex-level-fade', 'gex-flip-ivpct']);
const RAW = { 'gex-level-fade': 'data/gold-standard/gex-level-fade-v2.json', 'gex-flip-ivpct': 'data/gold-standard/gex-flip-ivpct-v2.json' };

function contractMap() {
  const m = new Map();
  for (const [key, file] of Object.entries(RAW)) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const t of d.trades) m.set(`${key}:${t.id}`, t.signalContract ?? t.signal?.signalContract ?? t.entryCandle?.symbol ?? null);
  }
  return m;
}

export function loadBookWithFib() {
  const trades = loadAnnotated();
  const cm = contractMap();
  for (const t of trades) {
    if (!MR_KEYS.has(t.strategyKey)) continue;
    t.contract = cm.get(t.id) ?? null;
    t.fib = fibFeatures({ entryTime: t.entryTime, side: t.side, price: t.actualEntry, contract: t.contract });
  }
  return trades;
}
