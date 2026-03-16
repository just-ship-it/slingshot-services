/**
 * Composite Overnight Trading Engine
 *
 * Runs multiple entry sub-strategies per overnight session, all sharing
 * the same LT-derived directional bias. Max 1 position at a time.
 *
 * Entry phases (in order of priority):
 *   Phase 1: LT Pullback — wait for price to pull back N pts against LT direction
 *   Phase 2: Momentum Confirm — after 60 bars, if first-hour confirms LT, enter
 *   Phase 3: Fallback Hold — if no entry by cutoff, enter at market in LT direction
 *
 * Exit: 2 AM EST time exit (primary), 100-200pt stop loss (safety net)
 *
 * Usage: node backtest-engine/research/overnight-composite-engine.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// ============================================================================
// TIMEZONE
// ============================================================================
function isDST(ms) {
  const d=new Date(ms),y=d.getUTCFullYear(),m=d.getUTCMonth();
  if(m>=3&&m<=9) return true;
  if(m===0||m===1||m===11) return false;
  if(m===2){const fd=new Date(Date.UTC(y,2,1)).getUTCDay();return ms>=Date.UTC(y,2,fd===0?8:15-fd,7);}
  if(m===10){const fd=new Date(Date.UTC(y,10,1)).getUTCDay();return ms<Date.UTC(y,10,fd===0?1:8-fd,6);}
  return false;
}
function utcToEST(ms){return ms+(isDST(ms)?-4:-5)*3600000;}
function getESTHour(ts){const d=new Date(utcToEST(ts));return d.getUTCHours()+d.getUTCMinutes()/60;}
function getESTDateStr(ts){const d=new Date(utcToEST(ts));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}
function getDayOfWeek(ds){return new Date(ds+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'long'});}

// ============================================================================
// DATA LOADING
// ============================================================================
function loadOHLCV() {
  console.log('Loading NQ OHLCV...');
  const raw=fs.readFileSync(path.join(DATA_DIR,'ohlcv/nq/NQ_ohlcv_1m_continuous.csv'),'utf-8');
  const lines=raw.split('\n').filter(l=>l.trim());
  const c=[];
  for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<6)continue;c.push({timestamp:new Date(p[0]).getTime(),open:+p[1],high:+p[2],low:+p[3],close:+p[4],volume:+p[5]||0});}
  console.log(`  ${c.length} candles`);
  return c;
}

function loadGEX() {
  console.log('Loading GEX...');
  const dir=path.join(DATA_DIR,'gex/nq');
  const files=fs.readdirSync(dir).filter(f=>f.startsWith('nq_gex_')&&f.endsWith('.json'));
  const g={};
  for(const f of files){try{const d=JSON.parse(fs.readFileSync(path.join(dir,f),'utf-8'));if(!d.metadata?.date||!d.data?.length)continue;const last=d.data[d.data.length-1];g[d.metadata.date]={regime:last.regime,totalGex:last.total_gex};}catch(e){}}
  console.log(`  ${Object.keys(g).length} dates`);
  return g;
}

function loadLT() {
  console.log('Loading LT...');
  const raw=fs.readFileSync(path.join(DATA_DIR,'liquidity/nq/NQ_liquidity_levels.csv'),'utf-8');
  const lines=raw.split('\n').filter(l=>l.trim());
  const lt={};
  for(let i=1;i<lines.length;i++){const p=lines[i].split(',');if(p.length<8)continue;lt[p[0].split(' ')[0]]={sentiment:p[2]};}
  console.log(`  ${Object.keys(lt).length} dates`);
  return lt;
}

// ============================================================================
// SESSION BUILDER
// ============================================================================
function buildSessions(candles) {
  console.log('Building sessions...');
  const byDate={};
  for(const c of candles){const d=getESTDateStr(c.timestamp);if(!byDate[d])byDate[d]=[];byDate[d].push({...c,estHour:getESTHour(c.timestamp)});}
  const dates=Object.keys(byDate).sort();
  const sessions=[];
  for(let i=0;i<dates.length-1;i++){
    const today=dates[i],tomorrow=dates[i+1];
    const tc=byDate[today]||[],nc=byDate[tomorrow]||[];
    const rth=tc.filter(c=>c.estHour>=9.5&&c.estHour<16);
    if(rth.length<30)continue;
    const rthClose=rth[rth.length-1].close;
    const rthHigh=Math.max(...rth.map(c=>c.high));
    const rthLow=Math.min(...rth.map(c=>c.low));
    const ibs=rthHigh>rthLow?(rthClose-rthLow)/(rthHigh-rthLow):0.5;
    const dayOfWeek=getDayOfWeek(today);
    if(dayOfWeek==='Friday'||dayOfWeek==='Saturday')continue;

    const on=[...tc.filter(c=>c.estHour>=18),...nc.filter(c=>c.estHour<8)];
    if(on.length<30)continue;

    sessions.push({date:today,dayOfWeek,rthClose,ibs,overnightCandles:on,overnightOpen:on[0].open});
  }
  console.log(`  ${sessions.length} sessions`);
  return sessions;
}

// ============================================================================
// COMPOSITE STRATEGY ENGINE
// ============================================================================
function runComposite(sessions, ltData, gexData, params) {
  const {
    // Phase 1: Pullback
    pullbackEnabled, pullbackPts, pullbackMaxWait,
    // Phase 2: Momentum confirmation
    momentumEnabled, momentumLookback, momentumMinMove,
    // Phase 3: Fallback hold
    fallbackEnabled, fallbackAfterBars,
    // Risk management
    stopLoss, takeProfit, exitHour, maxHoldBars,
    // Filters
    requireGexConfirm, blockedDays,
  } = params;

  const allTrades = [];

  for (const s of sessions) {
    const lt = ltData[s.date];
    if (!lt?.sentiment) continue;
    if (blockedDays?.includes(s.dayOfWeek)) continue;

    const gex = gexData[s.date];
    const ltSide = lt.sentiment === 'BULLISH' ? 'buy' : 'sell';
    const isLong = ltSide === 'buy';

    // GEX regime filter
    if (requireGexConfirm && gex) {
      const posGex = gex.regime === 'positive' || gex.regime === 'strong_positive';
      const negGex = gex.regime === 'negative' || gex.regime === 'strong_negative';
      if (isLong && !posGex) continue;
      if (!isLong && !negGex) continue;
    }

    const cn = s.overnightCandles;
    const openPrice = cn[0].open;
    let entryBar = null;
    let entryPrice = null;
    let entryReason = null;

    // === Phase 1: Pullback entry ===
    if (pullbackEnabled) {
      const waitEnd = Math.min(pullbackMaxWait, cn.length);
      for (let i = 1; i < waitEnd; i++) {
        if (isLong && cn[i].low <= openPrice - pullbackPts) {
          entryBar = i;
          entryPrice = openPrice - pullbackPts; // Limit fill at pullback level
          entryReason = 'pullback';
          break;
        }
        if (!isLong && cn[i].high >= openPrice + pullbackPts) {
          entryBar = i;
          entryPrice = openPrice + pullbackPts;
          entryReason = 'pullback';
          break;
        }
      }
    }

    // === Phase 2: Momentum confirmation (only if no pullback fill) ===
    if (!entryBar && momentumEnabled && cn.length > momentumLookback + 10) {
      const firstHourRet = cn[momentumLookback - 1].close - cn[0].open;
      if (Math.abs(firstHourRet) >= momentumMinMove) {
        const momSide = firstHourRet > 0 ? 'buy' : 'sell';
        if (momSide === ltSide) {
          entryBar = momentumLookback;
          entryPrice = cn[momentumLookback].close;
          entryReason = 'momentum';
        }
      }
    }

    // === Phase 3: Fallback hold entry ===
    if (!entryBar && fallbackEnabled && cn.length > fallbackAfterBars) {
      entryBar = fallbackAfterBars;
      entryPrice = cn[fallbackAfterBars].close;
      entryReason = 'fallback';
    }

    if (!entryBar) continue;

    // === Trade simulation from entry point ===
    const stop = isLong ? entryPrice - stopLoss : entryPrice + stopLoss;
    const target = takeProfit < 9000 ? (isLong ? entryPrice + takeProfit : entryPrice - takeProfit) : null;
    let mfe = 0, mae = 0, exitPrice = null, exitReason = null, exitBar = entryBar;

    for (let j = entryBar + 1; j < cn.length; j++) {
      const c = cn[j];
      // Time exit
      if (exitHour && c.estHour >= exitHour && c.estHour < 18) {
        exitPrice = c.open; exitReason = 'time_exit'; exitBar = j; break;
      }
      // MFE/MAE
      if (isLong) { mfe = Math.max(mfe, c.high - entryPrice); mae = Math.max(mae, entryPrice - c.low); }
      else { mfe = Math.max(mfe, entryPrice - c.low); mae = Math.max(mae, c.high - entryPrice); }
      // Stop
      if (isLong && c.low <= stop) { exitPrice = stop; exitReason = 'stop'; exitBar = j; break; }
      if (!isLong && c.high >= stop) { exitPrice = stop; exitReason = 'stop'; exitBar = j; break; }
      // Target
      if (target) {
        if (isLong && c.high >= target) { exitPrice = target; exitReason = 'target'; exitBar = j; break; }
        if (!isLong && c.low <= target) { exitPrice = target; exitReason = 'target'; exitBar = j; break; }
      }
      // Max hold
      if (maxHoldBars > 0 && (j - entryBar) >= maxHoldBars) {
        exitPrice = c.close; exitReason = 'max_hold'; exitBar = j; break;
      }
    }
    if (!exitPrice) {
      const last = cn[cn.length - 1];
      exitPrice = last.close; exitReason = 'session_end'; exitBar = cn.length - 1;
    }

    const pnl = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
    allTrades.push({
      date: s.date, dayOfWeek: s.dayOfWeek, side: ltSide,
      entryPrice, exitPrice, pnl, mfe, mae,
      entryReason, exitReason,
      entryBar, exitBar, holdBars: exitBar - entryBar,
      lt: lt.sentiment, gexRegime: gex?.regime || 'unknown', ibs: s.ibs,
    });
  }

  return allTrades;
}

// ============================================================================
// METRICS
// ============================================================================
function metrics(trades, label) {
  if (!trades.length) return null;
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const avg = total / trades.length;
  const wr = w.length / trades.length * 100;
  const avgW = w.length ? w.reduce((s, t) => s + t.pnl, 0) / w.length : 0;
  const avgL = l.length ? l.reduce((s, t) => s + t.pnl, 0) / l.length : 0;
  const pf = l.length ? w.reduce((s, t) => s + t.pnl, 0) / Math.abs(l.reduce((s, t) => s + t.pnl, 0)) : Infinity;
  const std = Math.sqrt(trades.reduce((s, t) => s + Math.pow(t.pnl - avg, 2), 0) / trades.length);
  const sharpe = std > 0 ? avg / std : 0;
  const mfe = trades.reduce((s, t) => s + t.mfe, 0) / trades.length;
  const mae = trades.reduce((s, t) => s + t.mae, 0) / trades.length;
  let peak = 0, maxDD = 0, eq = 0;
  for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, peak - eq); }
  const exits = {};
  for (const t of trades) exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
  const entries = {};
  for (const t of trades) entries[t.entryReason] = (entries[t.entryReason] || 0) + 1;
  const longs = trades.filter(t => t.side === 'buy'), shorts = trades.filter(t => t.side === 'sell');
  return { label, n: trades.length, wr, total, avg, avgW, avgL, pf, sharpe, std, mfe, mae, maxDD, eq, exits, entries, longs: longs.length, shorts: shorts.length, longPnL: longs.reduce((s, t) => s + t.pnl, 0), shortPnL: shorts.reduce((s, t) => s + t.pnl, 0) };
}

function printMetrics(m) {
  if (!m) { console.log('  No trades'); return; }
  console.log(`\n  ═══ ${m.label} ═══`);
  console.log(`  Trades: ${m.n} (${m.longs}L/${m.shorts}S) | WR: ${m.wr.toFixed(1)}% | PF: ${m.pf === Infinity ? 'Inf' : m.pf.toFixed(2)}`);
  console.log(`  Total: ${m.total.toFixed(0)} pts | Avg: ${m.avg.toFixed(1)} pts | Sharpe: ${m.sharpe.toFixed(3)}`);
  console.log(`  AvgWin: ${m.avgW.toFixed(1)} | AvgLoss: ${m.avgL.toFixed(1)} | Std: ${m.std.toFixed(1)}`);
  console.log(`  Long: ${m.longPnL.toFixed(0)} pts | Short: ${m.shortPnL.toFixed(0)} pts`);
  console.log(`  MFE: ${m.mfe.toFixed(1)} | MAE: ${m.mae.toFixed(1)} | MaxDD: ${m.maxDD.toFixed(0)} | Equity: ${m.eq.toFixed(0)}`);
  console.log(`  Entries: ${Object.entries(m.entries).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  Exits: ${Object.entries(m.exits).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

function printRow(m) {
  if (!m) return;
  const pfStr = m.pf >= 99 ? '  Inf' : m.pf.toFixed(1).padStart(6);
  const entStr = Object.entries(m.entries).map(([k, v]) => `${k[0]}${v}`).join('/');
  console.log(`  ${m.label.padEnd(58)} ${String(m.n).padStart(4)} ${m.wr.toFixed(1).padStart(6)}% ${m.avg.toFixed(1).padStart(7)} ${m.total.toFixed(0).padStart(8)} ${m.sharpe.toFixed(3).padStart(7)} ${pfStr} ${m.maxDD.toFixed(0).padStart(6)} ${entStr.padStart(14)}`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  COMPOSITE OVERNIGHT STRATEGY ENGINE — NQ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const candles = loadOHLCV();
  const gexData = loadGEX();
  const ltData = loadLT();
  const sessions = buildSessions(candles);

  const header = `  ${'Config'.padEnd(58)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'Entries'.padStart(14)}`;
  const divider = `  ${'─'.repeat(58)} ${'─'.repeat(4)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(14)}`;

  // ════════════════════════════════════════════════════════════
  // INDIVIDUAL SUB-STRATEGIES (baselines)
  // ════════════════════════════════════════════════════════════
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  INDIVIDUAL SUB-STRATEGY BASELINES                           ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  // Pullback only
  for (const pb of [15, 20, 25, 30]) {
    const t = runComposite(sessions, ltData, gexData, {
      pullbackEnabled: true, pullbackPts: pb, pullbackMaxWait: 240,
      momentumEnabled: false, fallbackEnabled: false,
      stopLoss: 100, takeProfit: 9999, exitHour: 2, maxHoldBars: 600,
    });
    printRow(metrics(t, `Pullback only ${pb}pt, SL100, ex2am`));
  }

  // Momentum only
  for (const mm of [10, 20, 30]) {
    const t = runComposite(sessions, ltData, gexData, {
      pullbackEnabled: false, momentumEnabled: true, momentumLookback: 60, momentumMinMove: mm,
      fallbackEnabled: false,
      stopLoss: 100, takeProfit: 9999, exitHour: 2, maxHoldBars: 600,
    });
    printRow(metrics(t, `Momentum only 60bar min${mm}, SL100, ex2am`));
  }

  // Hold only (fallback at bar 0)
  {
    const t = runComposite(sessions, ltData, gexData, {
      pullbackEnabled: false, momentumEnabled: false,
      fallbackEnabled: true, fallbackAfterBars: 0,
      stopLoss: 100, takeProfit: 9999, exitHour: 2, maxHoldBars: 600,
    });
    printRow(metrics(t, `Hold only (immediate), SL100, ex2am`));
  }

  // ════════════════════════════════════════════════════════════
  // COMPOSITE CONFIGURATIONS
  // ════════════════════════════════════════════════════════════
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  COMPOSITE STRATEGY SWEEP                                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  const results = [];

  for (const pb of [15, 20, 25, 30, 40]) {
    for (const pbWait of [120, 180, 240]) {
      for (const momEnabled of [true, false]) {
        for (const momMin of momEnabled ? [10, 20, 30] : [0]) {
          for (const fbEnabled of [true, false]) {
            for (const fbAfter of fbEnabled ? [120, 180, 240] : [0]) {
              // Skip configs where fallback fires before momentum check
              if (fbEnabled && momEnabled && fbAfter <= 60) continue;
              for (const sl of [70, 100, 150, 200]) {
                for (const exitHr of [2, 4]) {
                  for (const gexConfirm of [false, true]) {
                    const t = runComposite(sessions, ltData, gexData, {
                      pullbackEnabled: true, pullbackPts: pb, pullbackMaxWait: pbWait,
                      momentumEnabled: momEnabled, momentumLookback: 60, momentumMinMove: momMin,
                      fallbackEnabled: fbEnabled, fallbackAfterBars: fbAfter,
                      stopLoss: sl, takeProfit: 9999, exitHour: exitHr, maxHoldBars: 600,
                      requireGexConfirm: gexConfirm,
                    });
                    if (t.length < 50) continue;
                    const m = metrics(t, '');
                    results.push({
                      ...m,
                      pb, pbWait, momEnabled, momMin, fbEnabled, fbAfter, sl, exitHr, gexConfirm,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Sort by Sharpe
  results.sort((a, b) => b.sharpe - a.sharpe);

  console.log(`\n  ═══ TOP 40 BY SHARPE (min 50 trades) ═══  [${results.length} configs tested]`);
  console.log(`  ${'PB'.padStart(3)} ${'Wait'.padStart(4)} ${'Mom'.padStart(4)} ${'FB'.padStart(4)} ${'SL'.padStart(4)} ${'Ex'.padStart(3)} ${'GEX'.padStart(4)} ${'N'.padStart(5)} ${'WR%'.padStart(6)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'Entries'.padStart(16)}`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(16)}`);

  for (let i = 0; i < Math.min(40, results.length); i++) {
    const r = results[i];
    const momStr = r.momEnabled ? String(r.momMin) : '-';
    const fbStr = r.fbEnabled ? String(r.fbAfter) : '-';
    const gStr = r.gexConfirm ? 'Y' : 'N';
    const entStr = Object.entries(r.entries).map(([k, v]) => `${k[0]}${v}`).join('/');
    console.log(`  ${String(r.pb).padStart(3)} ${String(r.pbWait).padStart(4)} ${momStr.padStart(4)} ${fbStr.padStart(4)} ${String(r.sl).padStart(4)} ${String(r.exitHr).padStart(3)} ${gStr.padStart(4)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)} ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${r.sharpe.toFixed(3).padStart(7)} ${(r.pf >= 99 ? 'Inf' : r.pf.toFixed(1)).padStart(6)} ${r.maxDD.toFixed(0).padStart(6)} ${entStr.padStart(16)}`);
  }

  // Top by total PnL (min 200 trades for frequency)
  const highFreq = results.filter(r => r.n >= 200).sort((a, b) => b.sharpe - a.sharpe);
  console.log(`\n\n  ═══ TOP 30 BY SHARPE, MIN 200 TRADES (high frequency) ═══  [${highFreq.length} configs]`);
  console.log(`  ${'PB'.padStart(3)} ${'Wait'.padStart(4)} ${'Mom'.padStart(4)} ${'FB'.padStart(4)} ${'SL'.padStart(4)} ${'Ex'.padStart(3)} ${'GEX'.padStart(4)} ${'N'.padStart(5)} ${'WR%'.padStart(6)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'Entries'.padStart(16)}`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(16)}`);

  for (let i = 0; i < Math.min(30, highFreq.length); i++) {
    const r = highFreq[i];
    const momStr = r.momEnabled ? String(r.momMin) : '-';
    const fbStr = r.fbEnabled ? String(r.fbAfter) : '-';
    const gStr = r.gexConfirm ? 'Y' : 'N';
    const entStr = Object.entries(r.entries).map(([k, v]) => `${k[0]}${v}`).join('/');
    console.log(`  ${String(r.pb).padStart(3)} ${String(r.pbWait).padStart(4)} ${momStr.padStart(4)} ${fbStr.padStart(4)} ${String(r.sl).padStart(4)} ${String(r.exitHr).padStart(3)} ${gStr.padStart(4)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)} ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${r.sharpe.toFixed(3).padStart(7)} ${(r.pf >= 99 ? 'Inf' : r.pf.toFixed(1)).padStart(6)} ${r.maxDD.toFixed(0).padStart(6)} ${entStr.padStart(16)}`);
  }

  // ════════════════════════════════════════════════════════════
  // DETAILED ANALYSIS OF TOP CONFIG
  // ════════════════════════════════════════════════════════════
  if (highFreq.length > 0) {
    const best = highFreq[0];
    console.log(`\n\n╔════════════════════════════════════════════════════════════════╗`);
    console.log(`║  DETAILED: PB=${best.pb} Wait=${best.pbWait} Mom=${best.momEnabled?best.momMin:'-'} FB=${best.fbEnabled?best.fbAfter:'-'} SL=${best.sl} Ex=${best.exitHr}am GEX=${best.gexConfirm?'Y':'N'}`.padEnd(65) + '║');
    console.log(`╚════════════════════════════════════════════════════════════════╝`);

    const trades = runComposite(sessions, ltData, gexData, {
      pullbackEnabled: true, pullbackPts: best.pb, pullbackMaxWait: best.pbWait,
      momentumEnabled: best.momEnabled, momentumLookback: 60, momentumMinMove: best.momMin,
      fallbackEnabled: best.fbEnabled, fallbackAfterBars: best.fbAfter,
      stopLoss: best.sl, takeProfit: 9999, exitHour: best.exitHr, maxHoldBars: 600,
      requireGexConfirm: best.gexConfirm,
    });

    printMetrics(metrics(trades, 'Best High-Freq Composite'));

    // By entry reason
    console.log('\n  By Entry Reason:');
    for (const reason of ['pullback', 'momentum', 'fallback']) {
      const sub = trades.filter(t => t.entryReason === reason);
      if (sub.length > 0) {
        const m = metrics(sub, reason);
        console.log(`    ${reason.padEnd(12)}: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avg.toFixed(1)}pts, Total=${m.total.toFixed(0)}, Sharpe=${m.sharpe.toFixed(3)}`);
      }
    }

    // By day
    console.log('\n  By Day:');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      const sub = trades.filter(t => t.dayOfWeek === day);
      if (sub.length > 0) {
        const m = metrics(sub, day);
        console.log(`    ${day.padEnd(12)}: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avg.toFixed(1)}pts`);
      }
    }

    // By side
    console.log('\n  By Side:');
    for (const side of ['buy', 'sell']) {
      const sub = trades.filter(t => t.side === side);
      if (sub.length > 0) {
        const m = metrics(sub, side);
        console.log(`    ${side.padEnd(6)}: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avg.toFixed(1)}pts, Total=${m.total.toFixed(0)}`);
      }
    }

    // Monthly PnL
    console.log('\n  Monthly PnL:');
    const byMonth = {};
    for (const t of trades) {
      const mo = t.date.substring(0, 7);
      if (!byMonth[mo]) byMonth[mo] = { n: 0, pnl: 0, w: 0 };
      byMonth[mo].n++; byMonth[mo].pnl += t.pnl; if (t.pnl > 0) byMonth[mo].w++;
    }
    let cum = 0;
    for (const [mo, d] of Object.entries(byMonth).sort()) {
      cum += d.pnl;
      const bar = d.pnl >= 0
        ? '+' + '█'.repeat(Math.min(Math.round(d.pnl / 20), 40))
        : '-' + '█'.repeat(Math.min(Math.round(-d.pnl / 20), 40));
      console.log(`    ${mo}: ${String(d.n).padStart(3)} trades, ${d.pnl.toFixed(0).padStart(7)}pts (WR ${(d.w / d.n * 100).toFixed(0).padStart(3)}%), cum: ${cum.toFixed(0).padStart(8)}  ${bar}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  COMPOSITE ENGINE COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
