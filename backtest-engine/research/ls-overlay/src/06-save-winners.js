/**
 * Phase 6 — Save final winning composite trade JSONs and sanity-check
 *
 * For each strategy, emit the recommended LS-overlay variant trades JSON
 * so the user can inspect, diff, and feed back into the live system.
 *
 * Also: pick 5 BE-replaced trades per strategy and pretty-print:
 *   gold exit price/time → BE catches at $0 (entry price)
 * to spot-check the heuristic.
 *
 * Run: node research/ls-overlay/src/06-save-winners.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..', '..');

const STRATEGIES = ['gex-flip-ivpct', 'gex-lt-3m-crossover', 'gex-level-fade'];
const TF_DELAY_MS = { '1m': 60_000, '3m': 180_000, '15m': 900_000 };
const POINT_VALUE = 20;

// Recommended winners — see SUMMARY.md
const WINNERS = {
  'gex-flip-ivpct':       { filter: 'none',                    exitTf: '1m', label: 'BE_1m only (PnL-max)' },
  'gex-lt-3m-crossover':  { filter: 'DROP_long_15m_state_0',   exitTf: '1m', label: 'DROP long/15m/state=0 + BE_1m (balanced)' },
  'gex-level-fade':       { filter: 'DROP_composite',          exitTf: '1m', label: 'DROP_composite + BE_1m (PnL-max)' },
};

function side(t) { return (t.side || '').toLowerCase(); }
function bucket(v, kind) {
  if (v == null) return 'na';
  if (kind === 'bs') { if (v === 0) return '0'; if (v <= 5) return '1-5'; if (v <= 15) return '6-15'; if (v <= 60) return '16-60'; return '60+'; }
  if (kind === 'fp') { if (v <= 2) return '0-2'; if (v <= 5) return '3-5'; if (v <= 10) return '6-10'; return '11+'; }
  return 'na';
}

const FILTERS = {
  'none':                    () => true,
  'DROP_long_15m_state_0':   t => !(side(t) === 'long' && t.ls_state_at_entry_15m === 0),
  'DROP_composite':          t => !(side(t)==='long' && bucket(t.bars_since_last_flip_3m,'bs') === '6-15')
                                && !(side(t)==='short' && bucket(t.flips_in_prev_60m_1m,'fp') === '11+'),
};

function loadEnriched(name) { return JSON.parse(fs.readFileSync(path.join(__dirname,'..','enriched',`${name}.json`), 'utf-8')); }

function collectTargets() {
  const targets = new Set();
  for (const strat of STRATEGIES) {
    for (const t of loadEnriched(strat)) {
      for (const tf of ['1m']) { // only 1m for winners
        const flipTs = t[`first_adverse_flip_ts_${tf}`];
        if (flipTs == null) continue;
        targets.add(flipTs + TF_DELAY_MS[tf]);
      }
    }
  }
  return targets;
}

async function load1mPrimaryAt(targets) {
  const filePath = path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1m.csv');
  const hourVol = new Map();
  const candidates = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let isFirst = true;
  for await (const line of rl) {
    if (isFirst) { isFirst = false; continue; }
    if (!line) continue;
    const p = line.split(',');
    const tsStr = p[0]; const symbol = p[9];
    if (!symbol || symbol.includes('-')) continue;
    const m = tsStr.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (!m) continue;
    const ts = Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
    if (ts < 1735689600000) continue;
    const volume = +p[8] || 0;
    const hourKey = Math.floor(ts / 3600000);
    if (!hourVol.has(hourKey)) hourVol.set(hourKey, new Map());
    const h = hourVol.get(hourKey);
    h.set(symbol, (h.get(symbol) || 0) + volume);
    if (targets.has(ts)) {
      const open = +p[4];
      if (!candidates.has(ts)) candidates.set(ts, []);
      candidates.get(ts).push({ symbol, open, volume });
    }
  }
  const out = new Map();
  for (const [ts, bars] of candidates) {
    const hourKey = Math.floor(ts / 3600000);
    const h = hourVol.get(hourKey);
    let primary = '', maxV = -1;
    for (const [sym, v] of h.entries()) { if (v > maxV) { maxV = v; primary = sym; } }
    const match = bars.find(b => b.symbol === primary);
    if (match) out.set(ts, { open: match.open });
  }
  return out;
}

function applyBeOnFlip(trade, tf, primaryByTs) {
  if (!tf) return { ...trade, _ls_overlay: null };
  const flipTs = trade[`first_adverse_flip_ts_${tf}`];
  if (flipTs == null) return { ...trade, _ls_overlay: null };
  const exitTsTarget = flipTs + TF_DELAY_MS[tf];
  const bar = primaryByTs.get(exitTsTarget);
  if (!bar) return { ...trade, _ls_overlay: null };
  const entryPrice = trade.actualEntry ?? trade.entryPrice;
  const isLong = side(trade) === 'long';
  const dir = isLong ? 1 : -1;
  const lsExitPrice = bar.open;
  const pointsAtFlip = (lsExitPrice - entryPrice) * dir;
  const goldExit = trade.actualExit;
  const goldExitDir = (goldExit - entryPrice) * dir;
  if (pointsAtFlip > 0 && goldExitDir < 0) {
    return {
      ...trade,
      netPnL: 0,
      pointsPnL: 0,
      _ls_overlay: {
        type: 'be_on_flip', tf,
        flipTs, beTriggerTs: exitTsTarget,
        pointsAtFlip: +pointsAtFlip.toFixed(2),
        goldExit, goldPointsPnL: trade.pointsPnL, goldNetPnL: trade.netPnL,
        beExitPrice: entryPrice, beExitTime: 'between flip and gold exit (price retraced)',
      },
    };
  }
  return { ...trade, _ls_overlay: null };
}

(async () => {
  console.log('Phase 6 — Saving winning composite trade JSONs\n');
  const targets = collectTargets();
  console.log(`Loading 1m OHLCV (${targets.size.toLocaleString()} targets)...`);
  const primaryByTs = await load1mPrimaryAt(targets);

  for (const strat of STRATEGIES) {
    const winner = WINNERS[strat];
    const raw = loadEnriched(strat);
    const filterFn = FILTERS[winner.filter];
    const filtered = raw.filter(filterFn);
    const final = filtered.map(t => applyBeOnFlip(t, winner.exitTf, primaryByTs));

    const sum = final.reduce((s,t) => s + (t.netPnL || 0), 0);
    const dropped = raw.length - filtered.length;
    const replaced = final.filter(t => t._ls_overlay).length;

    const outPath = path.join(__dirname, '..', 'output', `winner-${strat}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      meta: {
        strategy: strat,
        variant: winner.label,
        filter: winner.filter,
        exitTf: winner.exitTf,
        n_before_filter: raw.length,
        n_after_filter: filtered.length,
        n_dropped_by_filter: dropped,
        n_be_replaced: replaced,
        final_sumPnL: +sum.toFixed(2),
      },
      trades: final,
    }, null, 0));
    console.log(`  ${strat}: ${final.length} trades, sumPnL=$${sum.toFixed(2)}, BE replacements=${replaced}, filter dropped=${dropped}`);
  }

  // ── Sanity check: spot-print 3 BE replacements per strategy ─────────────
  console.log('\n=== Sanity check — 3 BE replacements per strategy ===\n');
  for (const strat of STRATEGIES) {
    const winner = WINNERS[strat];
    const raw = loadEnriched(strat);
    const filterFn = FILTERS[winner.filter];
    const filtered = raw.filter(filterFn);
    const final = filtered.map(t => applyBeOnFlip(t, winner.exitTf, primaryByTs));
    const replacements = final.filter(t => t._ls_overlay);

    console.log(`# ${strat}: ${replacements.length} BE replacements`);
    for (const t of replacements.slice(0, 3)) {
      const ov = t._ls_overlay;
      const isLong = side(t) === 'long';
      console.log(`  id=${t.id} side=${t.side} entry=${t.actualEntry} (${new Date(t.entryTime).toISOString()})`);
      console.log(`    gold:    exit @${ov.goldExit}  pts=${ov.goldPointsPnL}  net=$${ov.goldNetPnL}  reason=${t.exitReason}`);
      console.log(`    ls-flip: ${new Date(ov.flipTs).toISOString()}  next-bar open=${ov.beExitPrice + (isLong?ov.pointsAtFlip:-ov.pointsAtFlip)} (pts@flip=${ov.pointsAtFlip})`);
      console.log(`    be-result: exit @entry=${ov.beExitPrice}  pts=0  net=$0`);
      console.log(`    Δ pnl saved: $${(-ov.goldNetPnL).toFixed(2)}`);
    }
    console.log('');
  }
})().catch(e => { console.error(e); process.exit(1); });
