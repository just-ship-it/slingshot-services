/**
 * Phase 3 — Post-event reaction: does the impulse CONTINUE from a realistic entry?
 *
 * Phase 1 showed corr(impulse_60, move_600)=0.82, but that's inflated: both are
 * measured from the same pre-release price, so they share the impulse displacement.
 * The tradable question is the FORWARD move: if we ENTER a minute or two after the
 * release (in the direction of the impulse), does price keep going FROM THERE?
 *
 * For each event:
 *   - impulse dir = sign(price@ENTRY - P_ref), where P_ref = last pre-release close.
 *   - entry_price = close of last 1s bar with rel <= ENTRY_SEC.
 *   - forward move (dir-adjusted) to each horizon = dir * (price@(ENTRY+h) - entry).
 *   - forward MFE/MAE (dir-adjusted) over [ENTRY, +90m] to inform target/stop.
 * A positive forward move = continuation (momentum); negative = the entry faded.
 *
 * Reports, per event type and per |impulse| filter, the forward directional edge.
 * This is 1s-honest: entry and all exits walk 1s bars from the entry instant on.
 *
 * Usage: node research/event-reaction/03-reaction-forward.js [--entry 60]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BARS = path.join(__dirname, 'output', 'event-windows-1s.csv');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const ENTRY_SEC = parseInt(arg('entry', '60'), 10);
const FWD_HZ = [30, 60, 120, 300, 600, 1200, 1800, 3600]; // seconds AFTER entry
const IMP_FILTERS = [0, 10, 20, 40]; // min |impulse| (pts) to take the trade

function loadEvents() {
  const lines = fs.readFileSync(BARS, 'utf8').trim().split('\n');
  const col = {};
  lines[0].split(',').forEach((h, i) => (col[h] = i));
  const events = new Map();
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    const id = c[col.event_id];
    if (!events.has(id)) events.set(id, { id, type: c[col.event_type], bars: [] });
    events.get(id).bars.push({ rel: +c[col.rel_sec], h: +c[col.high], l: +c[col.low], c: +c[col.close] });
  }
  for (const ev of events.values()) ev.bars.sort((a, b) => a.rel - b.rel);
  return [...events.values()];
}

const priceAt = (bars, r) => { let p = null; for (const b of bars) { if (b.rel <= r) p = b.c; else break; } return p; };
function extremes(bars, lo, hi) {
  let H = -Infinity, L = Infinity, n = 0;
  for (const b of bars) if (b.rel >= lo && b.rel <= hi) { if (b.h > H) H = b.h; if (b.l < L) L = b.l; n++; }
  return n ? { H, L } : null;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pctl = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// build per-event forward record
function build(events) {
  const recs = [];
  for (const ev of events) {
    const pre = ev.bars.filter((b) => b.rel < 0);
    const pRef = pre.length ? pre[pre.length - 1].c : null;
    const entry = priceAt(ev.bars, ENTRY_SEC);
    if (pRef == null || entry == null) continue;
    const dir = Math.sign(entry - pRef);
    if (dir === 0) continue;
    const rec = { id: ev.id, type: ev.type, dir, impulse: +(entry - pRef).toFixed(2), entry };
    for (const h of FWD_HZ) {
      const p = priceAt(ev.bars, ENTRY_SEC + h);
      rec[`fwd_${h}`] = p == null ? null : +(dir * (p - entry)).toFixed(2);
    }
    const ext = extremes(ev.bars, ENTRY_SEC, 5400);
    // dir-adjusted forward MFE / MAE
    rec.fwd_mfe = ext ? +(dir > 0 ? ext.H - entry : entry - ext.L).toFixed(2) : null;
    rec.fwd_mae = ext ? +(dir > 0 ? entry - ext.L : ext.H - entry).toFixed(2) : null; // >=0 = adverse excursion
    recs.push(rec);
  }
  return recs;
}

function report(recs) {
  const types = [...new Set(recs.map((r) => r.type))].sort();
  console.log(`\n=== FORWARD MOVE from entry at +${ENTRY_SEC}s, in impulse direction ===`);
  console.log('(positive fwd = continuation. mean pts, dir-adjusted. Cost ~1.5-2 pts roundtrip.)\n');

  for (const imp of IMP_FILTERS) {
    const sel = recs.filter((r) => Math.abs(r.impulse) >= imp);
    console.log(`--- |impulse| >= ${imp} pts  (n=${sel.length}) ---`);
    console.log(['group', 'n', 'mFwd300', 'mFwd600', 'mFwd1800', '%pos600', 'mMFE', 'mMAE'].join('\t'));
    const groups = { ALL: sel };
    for (const t of types) groups[t] = sel.filter((r) => r.type === t);
    for (const [g, rs] of Object.entries(groups)) {
      if (!rs.length) continue;
      const f = (h) => { const v = rs.map((r) => r[`fwd_${h}`]).filter((x) => x != null); return v.length ? mean(v).toFixed(1) : 'NA'; };
      const pos = (() => { const v = rs.map((r) => r.fwd_600).filter((x) => x != null); return v.length ? (v.filter((x) => x > 0).length / v.length * 100).toFixed(0) : 'NA'; })();
      const mfe = mean(rs.map((r) => r.fwd_mfe).filter((x) => x != null)).toFixed(0);
      const mae = mean(rs.map((r) => r.fwd_mae).filter((x) => x != null)).toFixed(0);
      console.log([g, rs.length, f(300), f(600), f(1800), pos, mfe, mae].join('\t'));
    }
    console.log('');
  }

  // Simple directional trade sim: enter at +ENTRY_SEC, hold to end of window (5400s cap),
  // exit at fixed target or stop (dir-adjusted), whichever the 1s path hits first.
  console.log('=== SIMPLE 1s-HONEST TRADE SIM (enter +' + ENTRY_SEC + 's, dir=impulse) ===');
  console.log('exit = first of {+target, -stop} on the 1s path, else last bar. PnL in points.\n');
  const grid = [[60, 40], [80, 40], [100, 50], [60, 30], [40, 20], [150, 60]];
  console.log(['tgt/stop', 'impFilt', 'n', 'WR%', 'avgPts', 'PF', 'totPts', '$@1NQ'].join('\t'));
  const evMap = new Map(EVENTS.map((e) => [e.id, e]));
  for (const [tgt, stop] of grid) {
    for (const impF of [0, 20]) {
      const sel = recs.filter((r) => Math.abs(r.impulse) >= impF);
      let wins = 0, gp = 0, gl = 0, tot = 0, n = 0;
      for (const r of sel) {
        const ev = evMap.get(r.id);
        const path = ev.bars.filter((b) => b.rel >= ENTRY_SEC);
        let pnl = null;
        for (const b of path) {
          const fav = r.dir > 0 ? b.h - r.entry : r.entry - b.l; // best-case this bar
          const adv = r.dir > 0 ? r.entry - b.l : b.h - r.entry; // worst-case this bar
          // conservative: check stop before target within a bar
          if (adv >= stop) { pnl = -stop; break; }
          if (fav >= tgt) { pnl = tgt; break; }
        }
        if (pnl == null) { const last = path[path.length - 1]; pnl = r.dir * (last.c - r.entry); }
        n++; tot += pnl;
        if (pnl > 0) { wins++; gp += pnl; } else gl += -pnl;
      }
      const pf = gl ? (gp / gl).toFixed(2) : '∞';
      console.log([`${tgt}/${stop}`, impF, n, (wins / n * 100).toFixed(0), (tot / n).toFixed(1), pf, tot.toFixed(0), `$${(tot * 20).toFixed(0)}`].join('\t'));
    }
  }
  console.log('\nNOTE: sim assumes stop-checked-before-target intrabar (conservative). Fills at exact');
  console.log('target/stop with no slippage on the point path; a real sim adds ~0.75pt each side.');
}

const EVENTS = loadEvents();
const recs = build(EVENTS);
console.log(`Built ${recs.length} event forward-records (entry +${ENTRY_SEC}s).`);
report(recs);
