/**
 * Phase 2: Reaction classifier
 *
 * Read Phase-1 episodes JSON. For each episode, observe the forward window
 * starting AFTER the episode exits and classify what happened.
 *
 * USER DEFINITIONS (2026-05-14):
 *   - Penetrate = price moves PENETRATE_PTS+ past the level AND does NOT
 *     come back to retest the level within the full window. Bounces are
 *     quick; a sustained 20-40pt move past without pullback = penetration.
 *   - Reject = quick bounce back toward approach side; price stays on the
 *     "expected" side of the level for most of the window.
 *   - Chop = level keeps getting re-touched; no decisive break either way.
 *
 * Labels:
 *   penetrate_clean   — moved PENETRATE_PTS+ past the level, no retouch in window
 *   penetrate_reverse — moved PENETRATE_PTS+ past, but retouched the level later
 *   reject_strong    — stayed on approach side, max move away >= REJECT_PTS
 *   reject_weak      — stayed on approach side, max move away < REJECT_PTS
 *   chop             — re-touched the level >= CHOP_RETOUCH times, no clean penetration
 *
 * "Approach side" is determined by:
 *   - isResistance=true  → approach = below (price should stay below R for rejection)
 *   - isResistance=false → approach = above (price should stay above S for rejection)
 *   - isResistance=null  → use entryApproach (from_above → expected back above)
 *
 * Reaction window: starts at episode.exitTimestamp + reaction-start-min (default 5 min,
 * matches Phase-1 exit persistence). Window length: --reaction-window-min (default 60 min).
 *
 * Thresholds (configurable):
 *   --penetrate-pts   (default 20) — magnitude of move past level for penetration
 *   --reject-pts      (default 10) — magnitude of move back toward approach side
 *   --chop-retouch    (default 3)  — re-touch count to call chop
 *
 * Output: enriched episodes with `reaction` field + post-exit metrics.
 *
 * Usage:
 *   node research/level-reaction/02-classify-reactions.js \
 *     --in research/output/level-reaction-episodes-<TS>.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { toET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'research', 'output');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN_FILE = arg('in', null);
if (!IN_FILE) {
  console.error('Required: --in <phase1-episodes.json>');
  process.exit(1);
}
const REACTION_START_MIN = Number(arg('reaction-start-min', 5));
const REACTION_WINDOW_MIN = Number(arg('reaction-window-min', 60));
const PENETRATE_PTS = Number(arg('penetrate-pts', 20));
const REJECT_PTS = Number(arg('reject-pts', 10));
const CHOP_RETOUCH = Number(arg('chop-retouch', 3));
const MIN_WICK_PTS = Number(arg('min-wick-pts', 3));         // min wick size to count as rejection
const SCORE_WEIGHT_5M = Number(arg('score-weight-5m', 5));   // weight for 5m rejection wick
const SCORE_WEIGHT_15M = Number(arg('score-weight-15m', 15)); // weight for 15m rejection wick
const PRODUCT = arg('product', 'NQ').toUpperCase();

const inPath = path.isAbsolute(IN_FILE) ? IN_FILE : path.join(ROOT, IN_FILE);
console.log(`\n=== Reaction Classifier ===`);
console.log(`Input: ${inPath}`);
console.log(`Reaction window: starts +${REACTION_START_MIN}min after exit, length ${REACTION_WINDOW_MIN}min`);
console.log(`Penetrate=${PENETRATE_PTS}pt (and no retouch in window) | Reject=${REJECT_PTS}pt back | Chop>=${CHOP_RETOUCH} retouches`);
console.log(`Rejection-wick min size=${MIN_WICK_PTS}pt | Score weights: 1m=1, 5m=${SCORE_WEIGHT_5M}, 15m=${SCORE_WEIGHT_15M}\n`);

const inData = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
console.log(`Loaded ${inData.episodes.length.toLocaleString()} episodes`);

// Determine date range covered (used to load only relevant 1m candles)
const dates = new Set();
let minTs = Infinity, maxTs = -Infinity;
for (const e of inData.episodes) {
  dates.add(e.entryEtDate);
  if (e.entryTimestamp < minTs) minTs = e.entryTimestamp;
  if (e.exitTimestamp > maxTs) maxTs = e.exitTimestamp;
}
// Forward window can extend past last episode's exit
const windowMs = (REACTION_START_MIN + REACTION_WINDOW_MIN + 5) * 60000;
maxTs += windowMs;
console.log(`Loading 1m candles for range covering ${dates.size} dates...`);

async function loadRawNQRange(startTs, endTs) {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < startTs || ts > endTs) return;
        const c = {
          timestamp: ts,
          open: +row.open, high: +row.high, low: +row.low, close: +row.close,
          volume: +row.volume || 0, symbol: row.symbol,
        };
        if (isNaN(c.open) || isNaN(c.close)) return;
        candles.push(c);
      })
      .on('end', resolve).on('error', reject);
  });
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

function filterPrimaryContract(candles) {
  if (!candles.length) return candles;
  const hourVol = new Map();
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.symbol, (m.get(c.symbol) || 0) + (c.volume || 0));
  }
  const out = [];
  for (const c of candles) {
    const h = Math.floor(c.timestamp / 3600000);
    const m = hourVol.get(h);
    if (!m) { out.push(c); continue; }
    let bestSym = '', bestVol = 0;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    if (c.symbol === bestSym) out.push(c);
  }
  return out;
}

// --- Aggregate N 1m bars into a single bar (OHLCV) ---
function aggregateBars(bars) {
  if (!bars.length) return null;
  let high = -Infinity, low = Infinity, vol = 0;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    vol += b.volume || 0;
  }
  return {
    open: bars[0].open,
    high,
    low,
    close: bars[bars.length - 1].close,
    volume: vol,
  };
}

// Build aggregated bars (5m or 15m) covering [startMs, endMs]
function buildAggregatedBars(startMs, endMs, periodMin, byTs) {
  const periodMs = periodMin * 60000;
  const firstBucket = Math.floor(startMs / periodMs) * periodMs;
  const lastBucket = Math.floor(endMs / periodMs) * periodMs;
  const bars = [];
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += periodMs) {
    const subBars = [];
    for (let m = 0; m < periodMin; m++) {
      const ts = bucket + m * 60000;
      const c = byTs.get(ts);
      if (c) subBars.push(c);
    }
    const agg = aggregateBars(subBars);
    if (agg) bars.push({ timestamp: bucket, ...agg });
  }
  return bars;
}

// Is this bar a "rejection wick" of the level on the approach side?
//   approachSide='below' (resistance-like): bar high >= level AND close < level, with wick >= minWickPts
//   approachSide='above' (support-like):    bar low  <= level AND close > level, with wick >= minWickPts
//   approachSide=null:                       no rejection definition possible
function isRejectionWick(bar, levelPrice, approachSide, minWickPts) {
  if (!bar || approachSide == null) return false;
  if (approachSide === 'below') {
    if (bar.high < levelPrice) return false;
    if (bar.close >= levelPrice) return false;
    const bodyTop = Math.max(bar.open, bar.close);
    return (bar.high - bodyTop) >= minWickPts;
  }
  if (approachSide === 'above') {
    if (bar.low > levelPrice) return false;
    if (bar.close <= levelPrice) return false;
    const bodyBot = Math.min(bar.open, bar.close);
    return (bodyBot - bar.low) >= minWickPts;
  }
  return false;
}

// Count rejection wicks across an array of bars at a given level / approach
function countRejectionWicks(bars, levelPrice, approachSide, minWickPts) {
  let n = 0;
  for (const b of bars) if (isRejectionWick(b, levelPrice, approachSide, minWickPts)) n++;
  return n;
}

// --- Classify a single episode given the forward 1m candles ---
function classify(ep, forwardCandles) {
  if (forwardCandles.length === 0) {
    return { reaction: 'no_data', windowBars: 0 };
  }
  const levelPrice = ep.exitLevelPrice;
  // Approach side = side price came from = side a "rejection" returns to.
  // 'above' means we expect price to remain ABOVE the level (level is support-like).
  // 'below' means we expect price to remain BELOW the level (level is resistance-like).
  let approachSide;
  if (ep.isResistance === true) approachSide = 'below';
  else if (ep.isResistance === false) approachSide = 'above';
  else {
    if (ep.entryApproach === 'from_above') approachSide = 'above';
    else if (ep.entryApproach === 'from_below') approachSide = 'below';
    else approachSide = null;
  }

  // Walk the window. Track:
  //   - maxAbove / maxBelow (excursions on each side, including wicks)
  //   - retouchCount (bars whose range includes the level)
  //   - firstRetouchMin (1-based bar index of first retouch)
  //   - reachedPenetrationMin (first bar that closed PENETRATE_PTS+ past on opposite side)
  //   - retouchAfterPenetration (any retouch AFTER the first penetration bar)
  let maxAbove = 0, maxBelow = 0;
  let retouchCount = 0;
  let firstRetouchMin = null;
  let reachedPenetrationMin = null;
  let retouchAfterPenetration = false;
  let i = 0;
  const lastBar = forwardCandles[forwardCandles.length - 1];
  for (const c of forwardCandles) {
    i++;
    if (c.high > levelPrice && (c.high - levelPrice) > maxAbove) maxAbove = c.high - levelPrice;
    if (c.low < levelPrice && (levelPrice - c.low) > maxBelow) maxBelow = levelPrice - c.low;

    const touches = c.low <= levelPrice && levelPrice <= c.high;
    if (touches) {
      retouchCount++;
      if (firstRetouchMin == null) firstRetouchMin = i;
      if (reachedPenetrationMin != null) retouchAfterPenetration = true;
    }

    // Penetration check: has price moved PENETRATE_PTS+ past the level on the
    // side OPPOSITE the approach (i.e. the level was broken).
    if (reachedPenetrationMin == null && approachSide != null) {
      const oppositeMaxSoFar = approachSide === 'above' ? maxBelow : maxAbove;
      if (oppositeMaxSoFar >= PENETRATE_PTS) reachedPenetrationMin = i;
    } else if (reachedPenetrationMin == null && approachSide == null) {
      // Unsided level: penetration is whichever side reaches threshold first
      if (Math.max(maxAbove, maxBelow) >= PENETRATE_PTS) reachedPenetrationMin = i;
    }
  }
  const finalClose = lastBar.close;
  const finalDistance = Math.abs(finalClose - levelPrice);
  const finalSide = finalClose > levelPrice ? 'above' : finalClose < levelPrice ? 'below' : 'at';

  let reaction;
  if (approachSide == null) {
    // Unsided level + no clear approach: classify by absolute moves
    if (reachedPenetrationMin != null) {
      reaction = retouchAfterPenetration ? 'penetrate_reverse' : 'penetrate_clean';
    } else if (retouchCount >= CHOP_RETOUCH) {
      reaction = 'chop';
    } else {
      reaction = 'reject_weak';
    }
  } else {
    const approachSideMaxMove = approachSide === 'above' ? maxAbove : maxBelow;

    if (reachedPenetrationMin != null) {
      reaction = retouchAfterPenetration ? 'penetrate_reverse' : 'penetrate_clean';
    } else if (retouchCount >= CHOP_RETOUCH) {
      reaction = 'chop';
    } else if (approachSideMaxMove >= REJECT_PTS && finalSide === approachSide) {
      reaction = 'reject_strong';
    } else {
      reaction = 'reject_weak';
    }
  }

  return {
    reaction,
    approachSide,
    windowBars: forwardCandles.length,
    maxAbove: +maxAbove.toFixed(2),
    maxBelow: +maxBelow.toFixed(2),
    retouchCount,
    firstRetouchMin,
    reachedPenetrationMin,
    retouchAfterPenetration,
    finalClose,
    finalSide,
    finalDistance: +finalDistance.toFixed(2),
  };
}

async function run() {
  const raw = await loadRawNQRange(minTs, maxTs);
  console.log(`Loaded ${raw.length.toLocaleString()} raw 1m candles in episode range`);
  const candles = filterPrimaryContract(raw);
  console.log(`After primary-contract filter: ${candles.length.toLocaleString()} candles`);

  // Index by minute timestamp
  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);
  // Also keep a sorted timestamp array for window slicing
  const sortedTs = candles.map(c => c.timestamp);

  function forwardCandlesAfter(exitTs, startOffsetMs, windowMs) {
    const winStart = exitTs + startOffsetMs;
    const winEnd = winStart + windowMs;
    // Linear-scan from a binary search on sortedTs
    // For speed: binary search lower bound
    let lo = 0, hi = sortedTs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedTs[mid] < winStart) lo = mid + 1; else hi = mid;
    }
    const out = [];
    for (let i = lo; i < sortedTs.length; i++) {
      if (sortedTs[i] > winEnd) break;
      const c = byTs.get(sortedTs[i]);
      if (c) out.push(c);
    }
    return out;
  }

  const enriched = [];
  let processed = 0;
  const startMs = REACTION_START_MIN * 60000;
  const winMs = REACTION_WINDOW_MIN * 60000;
  const reactionCounts = new Map();
  const reactionByLevel = new Map();

  for (const ep of inData.episodes) {
    processed++;
    if (processed % 5000 === 0) {
      process.stdout.write(`\r  classifying: ${processed.toLocaleString()} / ${inData.episodes.length.toLocaleString()}`);
    }
    const fwd = forwardCandlesAfter(ep.exitTimestamp, startMs, winMs);
    const cls = classify(ep, fwd);

    // Multi-timeframe rejection metrics measured DURING the episode itself
    // (engagement period, from entryTimestamp to exitTimestamp).
    const approachSide = cls.approachSide;  // populated by classify()
    const lvl = ep.entryLevelPrice;
    // 1m: count 1m bars in the episode window that wicked + closed back on approach side
    // We can derive this directly via byTs since episode is short enough
    let rej1m = 0;
    for (let ts = ep.entryTimestamp; ts <= ep.exitTimestamp; ts += 60000) {
      const c = byTs.get(ts);
      if (c && isRejectionWick(c, lvl, approachSide, MIN_WICK_PTS)) rej1m++;
    }
    const bars5m = buildAggregatedBars(ep.entryTimestamp, ep.exitTimestamp, 5, byTs);
    const bars15m = buildAggregatedBars(ep.entryTimestamp, ep.exitTimestamp, 15, byTs);
    const rej5m = countRejectionWicks(bars5m, lvl, approachSide, MIN_WICK_PTS);
    const rej15m = countRejectionWicks(bars15m, lvl, approachSide, MIN_WICK_PTS);
    const rejectionScore = rej1m + SCORE_WEIGHT_5M * rej5m + SCORE_WEIGHT_15M * rej15m;

    enriched.push({
      ...ep,
      ...cls,
      rejectionWicks1m: rej1m,
      rejectionWicks5m: rej5m,
      rejectionWicks15m: rej15m,
      rejectionScore,
      bars5mTotal: bars5m.length,
      bars15mTotal: bars15m.length,
    });
    reactionCounts.set(cls.reaction, (reactionCounts.get(cls.reaction) || 0) + 1);
    const lk = ep.levelType + '|' + cls.reaction;
    reactionByLevel.set(lk, (reactionByLevel.get(lk) || 0) + 1);
  }
  process.stdout.write(`\r  classifying: ${inData.episodes.length.toLocaleString()} / ${inData.episodes.length.toLocaleString()}\n`);

  console.log('\nReaction distribution (all episodes):');
  const total = enriched.length;
  const sorted = [...reactionCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [r, n] of sorted) {
    console.log(`  ${r.padEnd(20)} ${String(n).padStart(7)}  ${(100 * n / total).toFixed(1).padStart(5)}%`);
  }

  // By-level breakdown for the structural levels we care about most
  const interestLevels = ['call_wall', 'put_wall', 'gamma_flip', 'R1', 'R2', 'R3', 'R4', 'R5', 'S1', 'S2', 'S3', 'S4', 'S5', 'PDH', 'PDL', 'SH', 'SL', 'DO', 'VWAP', 'PRH', 'PRL'];
  console.log('\nReaction breakdown by level type:');
  const reactionTypes = ['reject_strong', 'reject_weak', 'chop', 'penetrate_reverse', 'penetrate_clean', 'no_data'];
  console.log('  ' + 'level'.padEnd(12) + reactionTypes.map(r => r.padStart(13)).join(' '));
  for (const lt of interestLevels) {
    const cells = reactionTypes.map(r => reactionByLevel.get(lt + '|' + r) || 0);
    const tot = cells.reduce((a, b) => a + b, 0);
    if (tot === 0) continue;
    const pcts = cells.map(c => (100 * c / tot).toFixed(0) + '%');
    console.log('  ' + lt.padEnd(12) + pcts.map(p => p.padStart(13)).join(' ') + `  (n=${tot})`);
  }

  // --- Multi-timeframe rejection summary ---
  console.log('\nRejection wicks (during-episode) distribution:');
  const wicks1m = enriched.map(e => e.rejectionWicks1m).sort((a, b) => a - b);
  const wicks5m = enriched.map(e => e.rejectionWicks5m).sort((a, b) => a - b);
  const wicks15m = enriched.map(e => e.rejectionWicks15m).sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  console.log(`  1m wicks  : median=${pct(wicks1m, 0.5)}  p75=${pct(wicks1m, 0.75)}  p90=${pct(wicks1m, 0.9)}  p99=${pct(wicks1m, 0.99)}  max=${wicks1m[wicks1m.length-1]}`);
  console.log(`  5m wicks  : median=${pct(wicks5m, 0.5)}  p75=${pct(wicks5m, 0.75)}  p90=${pct(wicks5m, 0.9)}  p99=${pct(wicks5m, 0.99)}  max=${wicks5m[wicks5m.length-1]}`);
  console.log(`  15m wicks : median=${pct(wicks15m, 0.5)}  p75=${pct(wicks15m, 0.75)}  p90=${pct(wicks15m, 0.9)}  p99=${pct(wicks15m, 0.99)}  max=${wicks15m[wicks15m.length-1]}`);

  // Mean rejection-score by outcome label (does stronger rejection during T1 correlate with reject outcome?)
  console.log('\nMean rejection score (during-episode) by reaction label:');
  const scoreByReaction = new Map();
  for (const e of enriched) {
    if (!scoreByReaction.has(e.reaction)) scoreByReaction.set(e.reaction, { sum: 0, n: 0, sum5: 0, sum15: 0 });
    const s = scoreByReaction.get(e.reaction);
    s.sum += e.rejectionScore; s.n += 1;
    s.sum5 += e.rejectionWicks5m; s.sum15 += e.rejectionWicks15m;
  }
  const reactionLabels = ['reject_strong', 'reject_weak', 'chop', 'penetrate_reverse', 'penetrate_clean'];
  console.log('  ' + 'reaction'.padEnd(20) + 'n'.padStart(7) + 'avg_score'.padStart(12) + 'avg_5m_rej'.padStart(12) + 'avg_15m_rej'.padStart(13));
  for (const r of reactionLabels) {
    const s = scoreByReaction.get(r); if (!s) continue;
    console.log('  ' + r.padEnd(20)
      + String(s.n).padStart(7)
      + (s.sum / s.n).toFixed(2).padStart(12)
      + (s.sum5 / s.n).toFixed(2).padStart(12)
      + (s.sum15 / s.n).toFixed(2).padStart(13));
  }

  const outTs = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(OUT_DIR, `level-reaction-classified-${outTs}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    config: {
      input: IN_FILE,
      reactionStartMin: REACTION_START_MIN,
      reactionWindowMin: REACTION_WINDOW_MIN,
      penetratePts: PENETRATE_PTS,
      rejectPts: REJECT_PTS,
      chopRetouch: CHOP_RETOUCH,
      minWickPts: MIN_WICK_PTS,
      scoreWeight5m: SCORE_WEIGHT_5M,
      scoreWeight15m: SCORE_WEIGHT_15M,
    },
    summary: {
      totalEpisodes: enriched.length,
      reactionCounts: Object.fromEntries(sorted),
    },
    episodes: enriched,
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
