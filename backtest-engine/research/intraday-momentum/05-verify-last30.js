/**
 * VERIFY candidate #2/#3 against roll-spread contamination.
 *
 * 04-last30.js priced entries/exits from days.<ticker>.json's mClose matrix, which was NOT
 * strict-primary-contract filtered (pass-1 last-write-wins across contract months). On roll days
 * the 15:30 and 16:00 prices could straddle a ~70pt NQ (or ~10pt ES) roll spread → phantom PnL.
 *
 * This re-derives the anchor prices (10:00, 15:30, 15:45, 16:00, prev-close) from the strict
 * PRIMARY-FILTERED 1s store (rth1s.<ticker>.bin) and reruns Gao/rROD long-only. If the headline
 * (esp. NQ Gao long exit16:00) holds within ~10%, it's real; if it collapses, it was roll noise.
 *
 * Usage: node 05-verify-last30.js --ticker NQ
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'output');
const argv = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const TICKER = argv('ticker', 'NQ').toUpperCase();
const PV = TICKER === 'NQ' ? 20 : 50, COMMISSION = 5.0, MKT_SLIP = 1.0;
const S_1000 = 1800, S_1530 = 21600, S_1545 = 22500, S_1559 = 23399;

const meta = JSON.parse(fs.readFileSync(path.join(OUT, `days.${TICKER}.json`), 'utf8'));
const DAYS = meta.days;
const bin = fs.readFileSync(path.join(OUT, `rth1s.${TICKER}.bin`));
const ROW = 12, N = bin.length / ROW;

// Extract per-day anchor prices = close of last primary 1s bar at/<= each target second.
const anchors = DAYS.map(() => ({ c1000: NaN, c1530: NaN, c1545: NaN, c1559: NaN }));
let curDay = -1, a = null;
for (let i = 0; i < N; i++) {
  const dayIdx = bin.readUInt16LE(i * ROW), sec = bin.readUInt16LE(i * ROW + 2), close = bin.readFloatLE(i * ROW + 4);
  if (dayIdx !== curDay) { curDay = dayIdx; a = anchors[dayIdx]; }
  if (sec <= S_1000) a.c1000 = close;
  if (sec <= S_1530) a.c1530 = close;
  if (sec <= S_1545) a.c1545 = close;
  if (sec <= S_1559) a.c1559 = close;
}

function run(cfg) {
  const { predictor, exitSel, side = 'long', startDate = null } = cfg; // exitSel: 'c1559'|'c1545'
  const trades = [];
  for (let i = 1; i < DAYS.length; i++) {
    if (startDate && DAYS[i].date < startDate) continue;
    const prevClose = anchors[i - 1].c1559;
    const A = anchors[i];
    if (!(prevClose > 0) || !(A.c1530 > 0) || !(A[exitSel] > 0)) continue;
    const predRef = predictor === 'gao' ? A.c1000 : A.c1530;
    if (!(predRef > 0)) continue;
    const pred = predRef / prevClose - 1;
    let dir = pred > 0 ? 1 : -1;
    if (side === 'long' && dir < 0) continue;
    if (side === 'short' && dir > 0) continue;
    const pnl = (((A[exitSel] - A.c1530) * dir) - 2 * MKT_SLIP) * PV - COMMISSION;
    trades.push({ dayIdx: i, pnl, side: dir });
  }
  return metrics(trades, cfg);
}
function metrics(trades, cfg) {
  const n = trades.length, wins = trades.filter(t => t.pnl > 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = -trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0), pf = gl > 0 ? gw / gl : Infinity;
  let eq = 0, peak = 0, mdd = 0; const dv = [];
  for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; if (peak - eq > mdd) mdd = peak - eq; dv.push(t.pnl); }
  const mean = dv.reduce((s, v) => s + v, 0) / (dv.length || 1);
  const sd = Math.sqrt(dv.reduce((s, v) => s + (v - mean) ** 2, 0) / (dv.length || 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  return { cfg, n, pnl: Math.round(pnl), wr: n ? wins.length / n : 0, pf, sharpe, mdd: Math.round(mdd) };
}

console.log(`\n=== ${TICKER} last-30-min VERIFY (strict primary 1s prices) ===`);
console.log('config                          n    PF   Sharpe   pnl$    DD$    WR');
const rows = [];
for (const predictor of ['gao', 'rrod'])
  for (const exitSel of ['c1559', 'c1545'])
    for (const [wn, sd] of [['full', null], ['2024-26', '2024-01-01'], ['gold_25-26', '2025-01-01']]) {
      const r = run({ predictor, exitSel, side: 'long', startDate: sd });
      const exLbl = exitSel === 'c1559' ? '16:00' : '15:45';
      console.log(`${predictor} long exit${exLbl} ${wn}`.padEnd(30),
        String(r.n).padStart(4), r.pf.toFixed(2).padStart(6), r.sharpe.toFixed(2).padStart(6),
        String(r.pnl).padStart(7), String(r.mdd).padStart(6), (r.wr * 100).toFixed(1).padStart(5));
      rows.push(r);
    }
fs.writeFileSync(path.join(OUT, `verify-last30-${TICKER}.json`), JSON.stringify(rows, null, 2));
