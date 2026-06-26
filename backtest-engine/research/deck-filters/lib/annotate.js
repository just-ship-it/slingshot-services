/**
 * Shared per-trade feature annotation layer for the deck-filter research (threads A1/A2/A3).
 *
 * Loads the 4 gold-standard strategy trade logs and attaches AS-OF-ENTRY (causal) features:
 *   vol regime  : ivPct (trailing-252 pctile of QQQ ATM IV), ivChg (5d IV momentum), slope (term struct)
 *   skew        : ivSkew = put_iv - call_iv at entry minute; ivSkewPct = trailing-252 pctile
 *   gamma       : gammaSign (+1/-1 from NQ total_gex), gammaImb (gamma_imbalance), nqSpot
 *   noise band  : atrNq (NQ 1m ATR-14 at entry), stopPts, stopAtr = stopPts/atrNq,
 *                 stopExpMove = stopPts / (nqSpot * ivNow/sqrt(252))  (IV-implied daily move)
 *   structure   : ltAlign (lstb only, from ls-flip features), levelType/gexType, distCallWall/distPutWall
 *   outcome     : netPnL, pointsPnL, mfePoints, win  (LABEL ONLY — never a filter feature)
 *
 * All sources are live-computable at signal time. Returns trades sorted by entryTime.
 * Usage: import { loadAnnotated, WIN_START, WIN_END, TRAIN_END } from './lib/annotate.js'
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');         // backtest-engine/
const DATA = path.join(ROOT, 'data');

export const WIN_START = '2025-01-13', WIN_END = '2026-04-23', TRAIN_END = '2025-09-30';
const SQRT252 = Math.sqrt(252);

function isDST(ms){const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();if(m>=3&&m<=9)return true;if(m===0||m===1||m===11)return false;if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}return false;}
export const etDate = ms => {const e=ms-(isDST(ms)?4:5)*3600000;const d=new Date(e);return`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;};

// ---- QQQ 1m ATM IV: minute maps for iv + skew; daily-close series for percentiles/momentum ----
const ivByMin = new Map(), skewByMin = new Map();
const dailyIV = {}, dailySkew = {};
{
  const lines = fs.readFileSync(path.join(DATA, 'iv/qqq/qqq_atm_iv_1m.csv'), 'utf8').split('\n');
  const H = lines[0].split(','); const tI = H.indexOf('timestamp'), vI = H.indexOf('iv'), cI = H.indexOf('call_iv'), pI = H.indexOf('put_iv');
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(','); if (p.length <= vI) continue;
    const ts = Date.parse(p[tI]); const iv = +p[vI]; if (isNaN(ts) || !(iv > 0)) continue;
    const mk = Math.floor(ts / 60000); ivByMin.set(mk, iv); dailyIV[etDate(ts)] = iv;
    const civ = +p[cI], piv = +p[pI];
    if (civ > 0 && piv > 0) { const sk = piv - civ; skewByMin.set(mk, sk); dailySkew[etDate(ts)] = sk; }
  }
}
const ivDates = Object.keys(dailyIV).sort(), ivVals = ivDates.map(d => dailyIV[d]);
const skDates = Object.keys(dailySkew).sort(), skVals = skDates.map(d => dailySkew[d]);

function carryFwd(map, ms, maxBack = 120) { let mk = Math.floor(ms / 60000); for (let k = 0; k < maxBack; k++) if (map.has(mk - k)) return map.get(mk - k); return null; }
function trailingPct(dates, vals, dateStr, val) { // pctile vs trailing-252 strictly before dateStr
  if (val == null) return null;
  let lo = 0, hi = dates.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] < dateStr) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx < 30) return null; const w = vals.slice(Math.max(0, idx - 251), idx + 1); return w.filter(x => x <= val).length / w.length;
}
function chg5(dates, vals, dateStr) { let lo = 0, hi = dates.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] < dateStr) { idx = m; lo = m + 1; } else hi = m - 1; } if (idx < 6) return null; return vals[idx] / vals[idx - 5] - 1; }

// ---- QQQ term slope (≤2026-01-28) ----
const slopeByDate = {};
{ const lines = fs.readFileSync(path.join(DATA, 'iv/qqq/qqq_short_dte_iv_daily.csv'), 'utf8').split('\n'); const H = lines[0].split(','); const sI = H.indexOf('term_slope');
  for (let i = 1; i < lines.length; i++) { const p = lines[i].split(','); if (p.length <= sI) continue; slopeByDate[p[0]] = +p[sI]; } }
const slDates = Object.keys(slopeByDate).sort();
function slopeAsOf(dateStr) { let lo = 0, hi = slDates.length - 1, r = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (slDates[m] < dateStr) { r = slDates[m]; lo = m + 1; } else hi = m - 1; } return r ? slopeByDate[r] : null; }

// ---- NQ GEX nq-cbbo: per-minute total_gex / regime / nq_spot ----
const gexByMin = new Map();
{
  const dir = path.join(DATA, 'gex/nq-cbbo');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const arr = Array.isArray(j) ? j : (j.data || []);
    for (const s of arr) { const ms = Date.parse(s.timestamp); if (isNaN(ms)) continue; gexByMin.set(Math.floor(ms / 60000), { totalGex: s.total_gex, regime: s.regime, imb: s.gamma_imbalance, nqSpot: s.nq_spot, callWall: s.call_wall, putWall: s.put_wall }); }
  }
}
function gexAt(ms, maxBack = 30) { let mk = Math.floor(ms / 60000); for (let k = 0; k < maxBack; k++) if (gexByMin.has(mk - k)) return gexByMin.get(mk - k); return null; }

// ---- NQ ATR-14 1m cache ----
const atrByMin = new Map();
{ const lines = fs.readFileSync(path.join(DATA, 'iv/nq/nq_atr_1m.csv'), 'utf8').split('\n');
  for (let i = 1; i < lines.length; i++) { const p = lines[i].split(','); if (p.length < 2) continue; atrByMin.set(+p[0], +p[1]); } }
function atrAt(ms, maxBack = 30) { let mk = Math.floor(ms / 60000); for (let k = 0; k < maxBack; k++) if (atrByMin.has(mk - k)) return atrByMin.get(mk - k); return null; }

// ---- ls-flip features: ltAlign + gexRegimePos by lstb tradeId ----
const lsFeat = new Map();
{ const fp = path.join(ROOT, 'research/ls-flip-metalabel/output/features.csv');
  if (fs.existsSync(fp)) { const lines = fs.readFileSync(fp, 'utf8').split('\n'); const H = lines[0].split(','); const idI = H.indexOf('tradeId'), aI = H.indexOf('ltAlign'), gI = H.indexOf('gexRegimePos');
    for (let i = 1; i < lines.length; i++) { const p = lines[i].split(','); if (p.length <= aI) continue; lsFeat.set(p[idI], { ltAlign: p[aI] === '' ? null : +p[aI], gexRegimePos: gI >= 0 && p[gI] !== '' ? +p[gI] : null }); } } }

const STRATEGIES = [
  { key: 'lstb', file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m', file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', file: 'data/gold-standard/gex-level-fade-v2.json' },
];
const normSide = s => { const l = String(s ?? '').toLowerCase(); return (l === 'long' || l === 'buy') ? 'long' : (l === 'short' || l === 'sell') ? 'short' : null; };

export function loadAnnotated() {
  const all = [];
  for (const def of STRATEGIES) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
    for (const t of raw.trades) {
      if (t.status !== 'completed' || t.entryTime == null || t.exitTime == null) continue;
      const side = normSide(t.side); if (!side) continue;
      const ed = etDate(t.entryTime); if (ed < WIN_START || ed > WIN_END) continue;
      const exitTime = t.exitTime <= t.entryTime ? t.entryTime + 1 : t.exitTime;
      const sig = t.signal || {};
      const entry = t.actualEntry ?? t.entryPrice ?? sig.price;
      const stopPts = sig.stopPoints ?? sig.stopDistance ?? (t.stopLoss != null && entry != null ? Math.abs(entry - t.stopLoss) : null);

      const ivNow = carryFwd(ivByMin, t.entryTime);
      const skNow = carryFwd(skewByMin, t.entryTime);
      const gx = gexAt(t.entryTime);
      const atrNq = atrAt(t.entryTime);
      const nqSpot = gx?.nqSpot ?? entry;
      const ls = lsFeat.get(t.id) || {};

      // structural distance to nearest wall (in the trade's adverse direction), normalized
      let distCallWall = null, distPutWall = null;
      const cw = sig.callWall ?? gx?.callWall, pw = sig.putWall ?? gx?.putWall;
      if (entry != null && Number.isFinite(cw)) distCallWall = +(cw - entry).toFixed(2);
      if (entry != null && Number.isFinite(pw)) distPutWall = +(entry - pw).toFixed(2);

      all.push({
        id: `${def.key}:${t.id}`, nativeId: t.id, strategyKey: def.key, side,
        entryTime: t.entryTime, exitTime, etDate: ed,
        actualEntry: entry, actualExit: t.actualExit, exitReason: t.exitReason,
        duration: t.duration, pointValue: t.pointValue ?? 20, commission: t.commission ?? 5,
        netPnL: t.netPnL, pointsPnL: t.pointsPnL, mfePoints: t.mfePoints, win: t.netPnL > 0 ? 1 : 0,
        // ---- causal features ----
        stopPts,
        ivPct: ivNow != null ? trailingPct(ivDates, ivVals, ed, ivNow) : null,
        ivChg: chg5(ivDates, ivVals, ed),
        slope: slopeAsOf(ed),
        ivSkew: skNow,
        ivSkewPct: skNow != null ? trailingPct(skDates, skVals, ed, skNow) : null,
        gammaSign: gx ? (gx.totalGex > 0 ? 1 : -1) : null,
        gammaImb: gx?.imb ?? null,
        regime: gx?.regime ?? null,
        nqSpot,
        atrNq,
        stopAtr: (stopPts != null && atrNq) ? +(stopPts / atrNq).toFixed(3) : null,
        stopExpMove: (stopPts != null && ivNow && nqSpot) ? +(stopPts / (nqSpot * ivNow / SQRT252)).toFixed(4) : null,
        ltAlign: ls.ltAlign ?? null,
        levelType: sig.levelType ?? null, gexType: sig.gexType ?? null,
        distCallWall, distPutWall,
      });
    }
  }
  return all.sort((a, b) => a.entryTime - b.entryTime);
}
