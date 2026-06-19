// Phase 1 — "GEX level rejection near target" detector.
//
// Question (Drew, 2026-06-16): for the 3 NQ production strategies (GLF / GFI / GLX,
// excluding LS-Flip), how often do we LOSE or break even on a signal because price
// rallied/dropped almost to its target, stalled at a KNOWN GEX level sitting just
// short of the target, rejected there, and reversed into a stop/BE?
//
// Inputs (all 1s-honest already — these gold JSONs were produced by the engine's
// SecondDataProvider, so entry/exit/MFE are honest; we only overlay GEX geometry):
//   data/gold-standard/gex-level-fade-v2.json        (GLF)
//   data/gold-standard/gex-flip-ivpct-v2.json        (GFI)
//   data/gold-standard/gex-lt-3m-crossover-v3.json   (GLX)
// GEX levels: data/gex/nq-cbbo  (lookahead-corrected, date-matched to the gold range;
//   this is the source GLF/GLX actually ran against. RAW contract price space — matches
//   actualEntry / takeProfit / mfePrice which are also raw contract prices.)
//
// A trade is a "victim" when ALL hold:
//   (a) outcome is loss or break-even (pointsPnL <= BE_EPS, and it did NOT hit target)
//   (b) a GEX level G sits BETWEEN entry and target, within nearTolPts of the target
//   (c) the trade's MFE peak coincides with G (|mfePrice - G| <= touchTolPts) and
//       fell short of the target -> i.e. price reached the level near target & reversed
//   (d) G was KNOWN during the trade (snapshot ts within [entry-15m, exit])
//
// We also compute the key CONTROL: among trades whose MFE reached the near-target zone,
// what fraction with a coinciding GEX level rejected vs. those without one. If winners
// punch through these same levels just as often, the level isn't the cause.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GexLoader } from '../../src/data-loaders/gex-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

const POINT_VALUE = 20;       // NQ $/pt
const COMMISSION = 5;         // round-trip
const BE_EPS = 5;             // pointsPnL <= this counts as loss-or-BE (not a real win)

const SOURCES = {
  glf: 'data/gold-standard/gex-level-fade-v2.json',
  gfi: 'data/gold-standard/gex-flip-ivpct-v2.json',
  glx: 'data/gold-standard/gex-lt-3m-crossover-v3.json',
};

// ---- load trades --------------------------------------------------------------
function loadTrades() {
  const all = [];
  for (const [strat, file] of Object.entries(SOURCES)) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const t of j.trades || []) {
      if (t.status !== 'completed') continue;
      const entry = t.actualEntry ?? t.entryPrice;
      const tp = t.takeProfit;
      const mfePrice = t.mfePrice;
      if (entry == null || tp == null || mfePrice == null) continue;
      all.push({
        strat,
        id: `${strat}:${t.id}`,
        contract: t.signalContract || (t.entryCandle && t.entryCandle.symbol) || 'NQ',
        side: t.side,                 // 'long' | 'short'
        entry,
        tp,
        stop: t.stopLoss,
        entryTime: t.entryTime,
        exitTime: t.exitTime,
        mfePrice,
        mfePoints: t.mfePoints,
        pointsPnL: t.pointsPnL,
        netPnL: t.netPnL,
        exitReason: t.exitReason,
        targetDist: Math.abs(tp - entry),
      });
    }
  }
  return all;
}

// ---- GEX levels ---------------------------------------------------------------
function enumLevels(snap) {
  const out = [];
  if (snap.gamma_flip) out.push(['gamma_flip', snap.gamma_flip]);
  if (snap.call_wall) out.push(['call_wall', snap.call_wall]);
  if (snap.put_wall) out.push(['put_wall', snap.put_wall]);
  (snap.resistance || []).forEach((v, i) => { if (v) out.push([`R${i + 1}`, v]); });
  (snap.support || []).forEach((v, i) => { if (v) out.push([`S${i + 1}`, v]); });
  return out;
}

// Collect every (levelName, value) known during [entryTime-15m, exitTime].
function levelsInWindow(gex, entryTime, exitTime) {
  const lo = entryTime - 15 * 60 * 1000;
  const seen = [];
  for (const ts of gex.sortedTimestamps) {
    if (ts < lo) continue;
    if (ts > exitTime) break;
    const snap = gex.loadedData.get(ts);
    for (const [name, val] of enumLevels(snap)) seen.push({ ts, name, val });
  }
  return seen;
}

// Levels known AT entry (for "newly formed" classification).
function levelsAtEntry(gex, entryTime) {
  const snap = gex.getGexLevels(new Date(entryTime));
  return snap ? enumLevels(snap).map(([, v]) => v) : [];
}

// ---- core test ----------------------------------------------------------------
// "Cap level": the GEX level nearest the MFE peak that sits BETWEEN the peak and the
// target (i.e. the level price stalled at, short of target), within touchTolPts.
// Returns the best match (or null). dir: +1 long, -1 short.
function findCapLevel(trade, windowLevels, touchTolPts) {
  const dir = trade.side === 'long' ? 1 : -1;
  const { entry, tp, mfePrice } = trade;
  // must have fallen short of target
  const shortOfTarget = dir === 1 ? mfePrice < tp : mfePrice > tp;
  if (!shortOfTarget) return null;
  let best = null;
  for (const { name, val, ts } of windowLevels) {
    // level is between entry and target, in trade direction
    const between = dir === 1 ? (val > entry && val < tp) : (val < entry && val > tp);
    if (!between) continue;
    // MFE peak coincides with the level
    const d = Math.abs(mfePrice - val);
    if (d > touchTolPts) continue;
    if (!best || d < best.dist) best = { name, val, ts, dist: d, gapToTarget: Math.abs(tp - val) };
  }
  return best;
}
const bucket = (x, edges) => { for (const e of edges) if (x < e) return `<${e}`; return `>=${edges[edges.length - 1]}`; };

// Did the trade's MFE reach the "near-target zone" at all (price came close to TP)?
function reachedNearTargetZone(trade, zonePts) {
  const dir = trade.side === 'long' ? 1 : -1;
  return dir === 1
    ? (trade.mfePrice >= trade.tp - zonePts && trade.mfePrice < trade.tp)
    : (trade.mfePrice <= trade.tp + zonePts && trade.mfePrice > trade.tp);
}

// Outcome by exitReason (a breakeven_stop exit at +offset is the user's "broke even
// after nearly hitting target" case — it must NOT be counted as a win).
function outcomeClass(t) {
  if (t.exitReason === 'take_profit') return 'win';
  if (t.exitReason === 'breakeven_stop') return 'be';
  if (t.exitReason === 'stop_loss') return 'loss';
  // market_close / eod_liquidation / time_exit / max_hold_time / trailing_stop / etc.
  if (t.pointsPnL > BE_EPS) return 'partialwin';
  return t.pointsPnL < -BE_EPS ? 'loss' : 'be';
}
const isLossOrBE = (t) => { const c = outcomeClass(t); return c === 'loss' || c === 'be'; };

// ---- run ----------------------------------------------------------------------
async function main() {
  const trades = loadTrades();
  console.log(`Loaded ${trades.length} completed trades:`,
    Object.fromEntries(Object.keys(SOURCES).map(s => [s, trades.filter(t => t.strat === s).length])));
  const exHist = {}, ocHist = {};
  for (const t of trades) { exHist[t.exitReason] = (exHist[t.exitReason] || 0) + 1; ocHist[outcomeClass(t)] = (ocHist[outcomeClass(t)] || 0) + 1; }
  console.log('exitReason histogram:', exHist);
  console.log('outcome histogram:', ocHist);

  // load GEX once over the full range
  const gex = new GexLoader(path.join(ROOT, 'data/gex/nq-cbbo'), 'nq');
  const minTs = Math.min(...trades.map(t => t.entryTime));
  const maxTs = Math.max(...trades.map(t => t.exitTime));
  await gex.loadDateRange(new Date(minTs - 2 * 86400000), new Date(maxTs + 86400000));

  // precompute per-trade window levels + entry levels (reused across sweep)
  for (const t of trades) {
    t._winLevels = levelsInWindow(gex, t.entryTime, t.exitTime);
    t._entryLevels = levelsAtEntry(gex, t.entryTime);
  }

  // ----- touch sensitivity: how many loss/BE trades had their MFE peak stall at a
  //       GEX cap level (between peak and target), requiring meaningful MFE progress -----
  const MIN_FRAC = 0.4; // price must have traveled >=40% to target to be "rejected short"
  console.log(`\n=== loss/BE trades whose MFE peak (>= ${MIN_FRAC * 100}% of target) stalled at a GEX cap level ===`);
  for (const touch of [3, 5, 8, 12]) {
    let n = 0, lost = 0;
    for (const t of trades) {
      if (!isLossOrBE(t)) continue;
      if (t.mfePoints / t.targetDist < MIN_FRAC) continue;
      const m = findCapLevel(t, t._winLevels, touch);
      if (m) { n++; lost += t.netPnL; }
    }
    console.log(`  touchTol=${touch}pt: ${n} trades, net $${Math.round(lost)}`);
  }

  // ----- detailed run at chosen default touch tolerance -----
  const TOUCH = 10;
  console.log(`\n=== DETAIL @ touchTol=${TOUCH}pt, minFrac=${MIN_FRAC} ===`);

  const victims = [];
  const perStrat = {};
  for (const s of Object.keys(SOURCES)) {
    perStrat[s] = { total: trades.filter(t => t.strat === s).length, lossBE: 0, capped: 0, lostUSD: 0, recoverUSD: 0 };
  }
  const fracBuckets = {}, gapBuckets = {}, byLevel = {};

  for (const t of trades) {
    const lb = isLossOrBE(t);
    if (lb) perStrat[t.strat].lossBE++;
    if (!lb) continue;
    if (t.mfePoints / t.targetDist < MIN_FRAC) continue;
    const m = findCapLevel(t, t._winLevels, TOUCH);
    if (!m) continue;
    const isNew = !t._entryLevels.some(v => Math.abs(v - m.val) <= TOUCH);
    const counterfactualNet = t.targetDist * POINT_VALUE - COMMISSION;
    const recover = counterfactualNet - t.netPnL;
    const frac = t.mfePoints / t.targetDist;
    perStrat[t.strat].capped++;
    perStrat[t.strat].lostUSD += t.netPnL;
    perStrat[t.strat].recoverUSD += recover;
    fracBuckets[bucket(frac, [0.5, 0.7, 0.9, 1.0])] = (fracBuckets[bucket(frac, [0.5, 0.7, 0.9, 1.0])] || 0) + 1;
    gapBuckets[bucket(m.gapToTarget, [10, 20, 40])] = (gapBuckets[bucket(m.gapToTarget, [10, 20, 40])] || 0) + 1;
    byLevel[m.name] = (byLevel[m.name] || 0) + 1;
    victims.push({
      strat: t.strat, id: t.id, contract: t.contract, side: t.side, outcome: outcomeClass(t),
      entry: t.entry, tp: t.tp, stop: t.stop, targetDist: t.targetDist,
      entryTime: new Date(t.entryTime).toISOString(), exitTime: new Date(t.exitTime).toISOString(),
      mfePrice: t.mfePrice, mfePoints: t.mfePoints, exitReason: t.exitReason,
      pointsPnL: t.pointsPnL, netPnL: t.netPnL,
      capLevelName: m.name, capLevelVal: m.val, capLevelTs: new Date(m.ts).toISOString(),
      capLevelIsNew: isNew, capLevelDistFromPeak: +m.dist.toFixed(2), gapToTargetPts: +m.gapToTarget.toFixed(2),
      mfeFracOfTarget: +frac.toFixed(3), ptsFromTargetAtPeak: +Math.abs(t.tp - t.mfePrice).toFixed(2),
      counterfactualRecoverUSD: Math.round(recover),
    });
  }

  console.log('\nper-strategy (capped = loss/BE trade with MFE>=40% stalled at a GEX cap level):');
  console.table(Object.fromEntries(Object.entries(perStrat).map(([s, v]) => [s, {
    total: v.total, lossBE: v.lossBE, capped: v.capped,
    cappedPctOfLossBE: v.lossBE ? +(100 * v.capped / v.lossBE).toFixed(1) : 0,
    cappedPctOfAll: +(100 * v.capped / v.total).toFixed(1),
    lostUSD: Math.round(v.lostUSD), recoverIfTargetUSD: Math.round(v.recoverUSD),
  }])));

  const totV = victims.length;
  const totLost = victims.reduce((s, v) => s + v.netPnL, 0);
  const totRecover = victims.reduce((s, v) => s + v.counterfactualRecoverUSD, 0);
  console.log(`TOTAL capped: ${totV} | net on them: $${Math.round(totLost)} | upside if they'd hit target: $${Math.round(totRecover)}`);
  console.log('MFE-frac-of-target buckets:', fracBuckets);
  console.log('gap-from-cap-level-to-target buckets:', gapBuckets);
  console.log('cap level types:', byLevel);
  console.log('newly-formed cap level (appeared after entry):', victims.filter(v => v.capLevelIsNew).length, '/', totV);

  // strict "near target" subset (Drew's screenshot flavor: stalled within 20pt of TP)
  const nearTgt = victims.filter(v => v.gapToTargetPts <= 20);
  console.log(`\nNEAR-TARGET subset (cap level within 20pt of TP): ${nearTgt.length} trades, net $${Math.round(nearTgt.reduce((s, v) => s + v.netPnL, 0))}, upside $${Math.round(nearTgt.reduce((s, v) => s + v.counterfactualRecoverUSD, 0))}`);

  // ----- CONTROL: among trades whose MFE reached >=40% of target AND fell short,
  //       does a coinciding cap level raise the loss/BE rate vs no level? -----
  let withLvl = { n: 0, lossBE: 0 }, noLvl = { n: 0, lossBE: 0 };
  for (const t of trades) {
    if (t.mfePoints / t.targetDist < MIN_FRAC) continue;
    const dir = t.side === 'long' ? 1 : -1;
    const shortOfTarget = dir === 1 ? t.mfePrice < t.tp : t.mfePrice > t.tp;
    if (!shortOfTarget) continue; // exclude trades that reached target (definitionally wins)
    const m = findCapLevel(t, t._winLevels, TOUCH);
    const b = m ? withLvl : noLvl;
    b.n++;
    if (isLossOrBE(t)) b.lossBE++;
  }
  console.log(`\n=== CONTROL: trades with MFE>=40% of target that fell short ===`);
  console.log(`  WITH GEX cap level at peak: ${withLvl.n} trades, loss/BE rate ${withLvl.n ? (100 * withLvl.lossBE / withLvl.n).toFixed(1) : 0}%`);
  console.log(`  WITHOUT cap level:          ${noLvl.n} trades, loss/BE rate ${noLvl.n ? (100 * noLvl.lossBE / noLvl.n).toFixed(1) : 0}%`);
  console.log('  (if WITH >> WITHOUT, stalling at a GEX level genuinely predicts the reversal-to-loss)');

  // save
  victims.sort((a, b) => a.netPnL - b.netPnL);
  fs.writeFileSync(path.join(OUT, 'victims.json'), JSON.stringify({
    params: { TOUCH, MIN_FRAC, BE_EPS, gexDir: 'data/gex/nq-cbbo' },
    summary: { totalCapped: totV, netUSD: Math.round(totLost), upsideUSD: Math.round(totRecover), nearTargetSubset: nearTgt.length },
    perStrat, fracBuckets, gapBuckets, byLevel, victims,
  }, null, 2));
  console.log(`\nwrote ${path.join(OUT, 'victims.json')} (${totV} capped trades, sorted worst-loss first)`);
}

main();
