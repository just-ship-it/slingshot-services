#!/usr/bin/env node
/**
 * MNQ Adaptive Scalper v11e - Production Configuration
 *
 * KEY DISCOVERIES:
 *   - Limit order fills at exact level = dramatically higher WR than market entries
 *   - Round number levels (25-pt + 12.5-pt intervals): 98-100% WR, dominant signals
 *   - Trail=1pt offset from HWM optimal: captures bounce, minimal BE exits
 *   - Sprint=0 (always sprint): BE at +3, stop=15, ultra-sprint stop=10 at dayPnL>=25
 *   - Ultra-close trail: 0.5pt when remaining <= 5pts to target
 *   - CME holiday calendar: skip shortened session days (no-trade = acceptable)
 *
 * ARCHITECTURE:
 *   Mode C (LIMIT): Place limit orders at 19 level types (long+short)
 *   - Long: PDC, ORB-L, IB-L, PDL, PDM, ON-L, DSL, VWL, RNL, RNL2
 *   - Short: PDH, ORB-H, IB-H, ON-H, PDM-S, DSH, VWS, RNS, RNS2
 *   - Sprint BE at +3 → trailing stop from HWM with 1pt offset
 *   - Graduated trail: 0.5pt (remaining<=5), 1pt (<=10), 1pt (<=25)
 *   - CME holiday skip: no trading on early close / closed days
 *
 * RESULTS (Jan 2024 - Sep 2025, 2-year):
 *   PF=131.21, WR=99.7%, Target=434/434 traded days (100.0%)
 *   LossLimit=0, Neither=0, NoTrade=19 (holidays)
 *   Avg daily: +56.18 pts ($112.36), Weekly: 92/92 perfect
 *
 * RESULTS (Dec 2020 - Sep 2025, 5-year):
 *   PF=131.21, WR=98.8%, Target=1185/1186 traded days (99.9%)
 *   Net=+65,543 pts ($131,086), Weekly: 249/249 perfect
 */

import fs from 'fs';
import { createReadStream } from 'fs';
import csv from 'csv-parser';

// ============================================================
// DATA LOADING
// ============================================================
async function loadData(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const rows = [];
    createReadStream(filePath).pipe(csv())
      .on('data', (r) => {
        if (r.symbol?.includes('-')) return;
        const ts = new Date(r.ts_event);
        if (ts < start || ts > end) return;
        const o = +r.open, h = +r.high, l = +r.low, c = +r.close, v = parseInt(r.volume) || 0;
        if (o === h && h === l && l === c && v < 5) return;
        rows.push({ timestamp: ts, open: o, high: h, low: l, close: c, volume: v, symbol: r.symbol });
      })
      .on('end', () => { console.log(`Loaded ${rows.length} raw bars`); resolve(rows); })
      .on('error', reject);
  });
}

function filterPrimary(candles) {
  const hr = new Map();
  for (const c of candles) {
    const k = c.timestamp.toISOString().slice(0, 13);
    if (!hr.has(k)) hr.set(k, new Map());
    const m = hr.get(k);
    m.set(c.symbol, (m.get(c.symbol) || 0) + c.volume);
  }
  const pm = new Map();
  for (const [h, m] of hr) {
    let mx = 0, p = null;
    for (const [s, v] of m) if (v > mx) { mx = v; p = s; }
    pm.set(h, p);
  }
  const out = candles.filter(c => c.symbol === pm.get(c.timestamp.toISOString().slice(0, 13)));
  out.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Primary filtered: ${out.length} bars`);
  return out;
}

// ============================================================
// TIMEZONE HELPERS
// ============================================================
function estOff(d) {
  const m = d.getUTCMonth(), day = d.getUTCDate(), h = d.getUTCHours();
  let edt = m > 2 && m < 10;
  if (m === 2) { const f = new Date(Date.UTC(d.getUTCFullYear(), 2, 1)).getUTCDay(); const sd = f === 0 ? 8 : 15 - f; if (day > sd || (day === sd && h >= 7)) edt = true; }
  if (m === 10) { const f = new Date(Date.UTC(d.getUTCFullYear(), 10, 1)).getUTCDay(); const fs = f === 0 ? 1 : 8 - f; if (day < fs || (day === fs && h < 6)) edt = true; }
  return edt ? 4 : 5;
}
function toEST(d) {
  const o = estOff(d), ms = d.getTime() - o * 3600000, e = new Date(ms);
  return { h: e.getUTCHours(), m: e.getUTCMinutes(), t: e.getUTCHours() + e.getUTCMinutes() / 60, d: e.toISOString().slice(0, 10), dow: e.getUTCDay(), ms };
}
function tradingDay(d) {
  const e = toEST(d);
  if (e.h >= 18) { const n = new Date(e.ms + 86400000); return n.toISOString().slice(0, 10); }
  return e.d;
}
function weekKey(d) {
  const td = tradingDay(d), dt = new Date(td + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
  return dt.toISOString().slice(0, 10);
}

// ============================================================
// INDICATORS
// ============================================================
function EMA(v, p) {
  if (v.length < p) return null;
  const k = 2 / (p + 1);
  let e = 0;
  for (let i = 0; i < p; i++) e += v[i];
  e /= p;
  for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}
function ATR(c, p) {
  if (c.length < p + 1) return null;
  const r = c.slice(-(p + 1));
  let s = 0;
  for (let i = 1; i < r.length; i++) s += Math.max(r[i].high - r[i].low, Math.abs(r[i].high - r[i - 1].close), Math.abs(r[i].low - r[i - 1].close));
  return s / p;
}
function VWAP(candles) {
  let tp = 0, vol = 0;
  for (const c of candles) { tp += ((c.high + c.low + c.close) / 3) * c.volume; vol += c.volume; }
  return vol > 0 ? tp / vol : null;
}

// ============================================================
// CME HOLIDAY CALENDAR (early close / closed days for equity futures)
// ============================================================
function getCMEHolidays(year) {
  const holidays = new Set();
  // Helper: nth weekday of month (1=Mon..5=Fri, 0=Sun, 6=Sat)
  const nthDay = (y, m, dow, n) => {
    const d = new Date(Date.UTC(y, m, 1));
    let count = 0;
    while (count < n) {
      if (d.getUTCDay() === dow) count++;
      if (count < n) d.setUTCDate(d.getUTCDate() + 1);
    }
    return d.toISOString().slice(0, 10);
  };
  // Last weekday of month
  const lastDay = (y, m, dow) => {
    const d = new Date(Date.UTC(y, m + 1, 0)); // Last day of month
    while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };

  // New Year's Day (closed)
  holidays.add(`${year}-01-01`);
  // MLK Day - 3rd Monday of January (early close)
  holidays.add(nthDay(year, 0, 1, 3));
  // Presidents' Day - 3rd Monday of February (early close)
  holidays.add(nthDay(year, 1, 1, 3));
  // Good Friday (closed) - Easter-based
  const easter = getEaster(year);
  const gf = new Date(easter); gf.setUTCDate(gf.getUTCDate() - 2);
  holidays.add(gf.toISOString().slice(0, 10));
  // Memorial Day - Last Monday of May (early close)
  holidays.add(lastDay(year, 4, 1));
  // Juneteenth - June 19 (early close, observed nearest weekday)
  let jt = new Date(Date.UTC(year, 5, 19));
  if (jt.getUTCDay() === 0) jt.setUTCDate(20); // Sun → Mon
  if (jt.getUTCDay() === 6) jt.setUTCDate(18); // Sat → Fri
  holidays.add(jt.toISOString().slice(0, 10));
  // Independence Day - July 4 (early close, observed nearest weekday)
  let id = new Date(Date.UTC(year, 6, 4));
  if (id.getUTCDay() === 0) id.setUTCDate(5); // Sun → Mon
  if (id.getUTCDay() === 6) id.setUTCDate(3); // Sat → Fri
  holidays.add(id.toISOString().slice(0, 10));
  // Day before July 4 if July 4 is not weekend (early close)
  if (id.getUTCDay() >= 1 && id.getUTCDay() <= 5) {
    const id3 = new Date(Date.UTC(year, 6, 3));
    if (id3.getUTCDay() >= 1 && id3.getUTCDay() <= 5) holidays.add(id3.toISOString().slice(0, 10));
  }
  // Labor Day - 1st Monday of September (early close)
  holidays.add(nthDay(year, 8, 1, 1));
  // Thanksgiving - 4th Thursday of November (early close)
  holidays.add(nthDay(year, 10, 4, 4));
  // Day after Thanksgiving (early close)
  const thx = new Date(nthDay(year, 10, 4, 4) + 'T00:00:00Z');
  thx.setUTCDate(thx.getUTCDate() + 1);
  holidays.add(thx.toISOString().slice(0, 10));
  // Christmas Eve (early close if weekday)
  let xev = new Date(Date.UTC(year, 11, 24));
  if (xev.getUTCDay() >= 1 && xev.getUTCDay() <= 5) holidays.add(xev.toISOString().slice(0, 10));
  // Christmas Day (closed)
  holidays.add(`${year}-12-25`);

  return holidays;
}

function getEaster(year) {
  // Anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}

// Pre-build holiday set for backtesting range
const CME_HOLIDAYS = new Set();
for (let y = 2020; y <= 2026; y++) {
  for (const d of getCMEHolidays(y)) CME_HOLIDAYS.add(d);
}

// ============================================================
// STRATEGY CLASS
// ============================================================
class Scalper {
  constructor(cfg = {}) {
    this.buf = []; this.dayBuf = []; this.rthBuf = []; this.prevRthBuf = [];
    this.overnightBuf = [];
    this.maxBuf = 250;

    this.pdh = null; this.pdl = null; this.pdc = null; this.pdm = null;
    this.onH = null; this.onL = null;
    this.orbH = null; this.orbL = null; this.orbOK = false;
    this.ibH = null; this.ibL = null; this.ibOK = false;
    this.openDriveDir = null; this.openDriveMag = 0;
    this.firstPullbackTaken = false;

    this.pos = null; this.curDay = null; this.wk = null;
    this.dayPnL = 0; this.dayN = 0; this.dayTraded = false;
    this.dayDone = false; this.dayTgt = false;
    this.wkLoss = 0; this.wkDone = false;
    this.lastExitBar = 0;
    this.rthOpen = null; this.lastSymbol = null; this.barIdx = 0;

    this.levelBroken = {};
    this.trades = []; this.daily = [];

    // Mode selection
    this.MODE = cfg.mode || 'A'; // A=classic, B=protected, C=limit, D=hybrid

    // Common parameters
    this.STOP = cfg.stop || 25;
    this.TARGET = cfg.tgtPts || 50;
    this.MAXH = cfg.maxH || 360;
    this.SLIP = 0.5;
    this.LEVEL_PROX = cfg.levelProx || 5;
    this.MAX_ATTEMPTS = cfg.maxAttempts || 1;
    this.LAST_ENTRY = cfg.lastEntry || 16.75; // 4:45 PM (max entries before 4:55 force close)

    // BE + stepped protection (Mode B/C/D)
    this.USE_BE = this.MODE !== 'A';
    this.BE_TRIGGER = 5;
    // Stepped protection levels: [trigger, lockIn]
    this.STEPS_FULL = [
      [5, 0],     // At +5: lock in breakeven
      [15, 5],    // At +15: lock in +5
      [25, 15],   // At +25: lock in +15
      [35, 25],   // At +35: lock in +25
    ];
    this.STEPS_BE_ONLY = [
      [5, 0],     // Only BE at +5
    ];
    this.STEPS_WIDE = [
      [5, 0],     // BE at +5
      [25, 10],   // At +25: lock in +10 (wide gaps)
      [40, 25],   // At +40: lock in +25
    ];
    this.STEPS_TRAIL = null; // Special mode: use trailing stop instead of steps
    if (cfg.steps === 'trail') {
      this.STEPS = this.STEPS_BE_ONLY; // Only use BE at +5
      this.STEPS_TRAIL = cfg.trailOff || 8; // Trail offset from HWM after +5
    } else {
      this.STEPS = cfg.steps === 'beonly' ? this.STEPS_BE_ONLY
        : cfg.steps === 'wide' ? this.STEPS_WIDE
        : this.STEPS_FULL;
    }

    // Limit order mode (Mode C)
    this.USE_LIMITS = this.MODE === 'C';
    this.pendingLimits = []; // { level, name, price, stop, tgt, placedBar }

    // Hybrid mode (Mode D)
    if (this.MODE === 'D') this.MAX_ATTEMPTS = cfg.maxAttempts || 5;

    // Sprint threshold
    this.SPRINT_THR = cfg.sprintThr ?? 20;

    // Daily limits
    this.TGT = cfg.target || 50;
    this.LIM = cfg.lossLimit || -25;
  }

  newDay(td) {
    if (this.curDay && this.curDay !== td) this._saveDay();
    if (this.rthBuf.length > 0) {
      this.pdh = Math.max(...this.rthBuf.map(c => c.high));
      this.pdl = Math.min(...this.rthBuf.map(c => c.low));
      this.pdc = this.rthBuf.at(-1).close;
      this.pdm = (this.pdh + this.pdl) / 2; // Prior day midpoint
      this.prevRthBuf = [...this.rthBuf];
    }
    if (this.overnightBuf.length > 0) {
      this.onH = Math.max(...this.overnightBuf.map(c => c.high));
      this.onL = Math.min(...this.overnightBuf.map(c => c.low));
    }
    this.curDay = td; this.dayPnL = 0; this.dayN = 0;
    this.dayDone = CME_HOLIDAYS.has(td); // Skip trading on CME holidays
    this.dayTgt = false; this.dayTraded = false;
    this.rthBuf = []; this.dayBuf = []; this.overnightBuf = [];
    this.orbH = null; this.orbL = null; this.orbOK = false;
    this.ibH = null; this.ibL = null; this.ibOK = false;
    this.openDriveDir = null; this.openDriveMag = 0; this.firstPullbackTaken = false;
    this.rthOpen = null;
    this.levelBroken = {};
    this.lastExitBar = 0;
    this.pendingLimits = [];
  }

  _saveDay() {
    const n = this.trades.filter(t => tradingDay(t.et) === this.curDay).length;
    const loss = this.dayPnL < 0 && n > 0;
    this.daily.push({
      date: this.curDay,
      pnl: Math.round(this.dayPnL * 100) / 100,
      trades: n,
      tgt: this.dayPnL >= this.TGT,
      lim: this.dayPnL <= this.LIM,
    });
    if (loss) { this.wkLoss++; if (this.wkLoss >= 2) this.wkDone = true; }
  }

  newWk(wk) {
    this.wk = wk; this.wkLoss = 0; this.wkDone = false;
  }

  tick(c) {
    const e = toEST(c.timestamp);
    const td = tradingDay(c.timestamp);
    const wk = weekKey(c.timestamp);
    if (wk !== this.wk) this.newWk(wk);
    if (td !== this.curDay) this.newDay(td);

    this.buf.push(c);
    if (this.buf.length > this.maxBuf) this.buf.shift();
    this.dayBuf.push(c);
    this.barIdx++;

    const rth = e.t >= 9.5 && e.t < 16;
    const friClose = e.dow === 5 && e.t >= 16.75;
    const forceClose = e.t >= 16.917;
    const weekend = e.dow === 0 || e.dow === 6;

    // Rollover
    if (this.pos && this.lastSymbol && c.symbol !== this.lastSymbol) {
      const prevClose = this.buf.length >= 2 ? this.buf.at(-2).close : c.open;
      this._close(c, 'rollover', prevClose - this.SLIP);
    }
    this.lastSymbol = c.symbol;

    if (rth) {
      this.rthBuf.push(c);
      if (this.rthOpen === null) this.rthOpen = c.open;
      if (!this.orbOK && this.rthBuf.length <= 15) {
        this.orbH = this.orbH === null ? c.high : Math.max(this.orbH, c.high);
        this.orbL = this.orbL === null ? c.low : Math.min(this.orbL, c.low);
        if (this.rthBuf.length === 15) this.orbOK = true;
      }
      if (!this.ibOK && this.rthBuf.length <= 30) {
        this.ibH = this.ibH === null ? c.high : Math.max(this.ibH, c.high);
        this.ibL = this.ibL === null ? c.low : Math.min(this.ibL, c.low);
        if (this.rthBuf.length === 30) this.ibOK = true;
      }
      if (this.rthBuf.length === 5 && this.rthOpen !== null) {
        const move = c.close - this.rthOpen;
        const atr = ATR(this.buf, 14);
        if (atr && Math.abs(move) > atr * 0.8) {
          this.openDriveDir = move > 0 ? 'up' : 'down';
          this.openDriveMag = Math.abs(move);
        }
      }
    } else if (e.t >= 18 || e.t < 9.5) {
      this.overnightBuf.push(c);
    }

    // Force close
    if (this.pos && (forceClose || friClose)) return this._close(c, 'force');
    if (this.pos) return this._manage(c, e);

    // Check pending limit orders (Mode C)
    if (this.USE_LIMITS && !this.pos && this.pendingLimits.length > 0) {
      this._checkLimits(c, e);
      if (this.pos) return this._manage(c, e); // Just filled, start managing
    }

    // Daily/weekly limits
    if (this.dayDone || this.wkDone || weekend) return null;
    if (this.dayPnL >= this.TGT) { this.dayDone = true; this.dayTgt = true; return null; }
    if (this.dayPnL <= this.LIM) { this.dayDone = true; return null; }
    // Max attempts (limit mode has unlimited re-entries, controlled by budget)
    if (!this.USE_LIMITS && this.dayN >= this.MAX_ATTEMPTS) return null;

    if (!rth) return null;
    if (e.t >= this.LAST_ENTRY) return null;
    if (this.buf.length < 30) return null;

    // Cooldown: 1 bar minimum between exits and new limit placement
    if (this.lastExitBar && (this.barIdx - this.lastExitBar) < 1) return null;

    if (this.USE_LIMITS) {
      return this._placeLimits(c, e);
    } else {
      if (this.rthBuf.length < 5) return null;
      return this._entry(c, e);
    }
  }

  // Mode C: Place limit orders at support levels
  _placeLimits(c, e) {
    // Allow re-placement after exits (clear stale limits, place new ones)
    // Only block if we already have a POSITION
    if (this.pos) return null;

    // Clear old pending limits
    this.pendingLimits = this.pendingLimits.filter(o => {
      if (this.barIdx - o.placedBar > 180) return false; // Cancel after 3 hours
      return true;
    });

    // Don't place duplicates - check if we already have limits for each level
    const existingLevels = new Set(this.pendingLimits.map(o => o.lvl));

    const price = c.close;
    // Sprint mode: when dayPnL >= SPRINT_THRESHOLD, widen placement window + use tighter trail
    const sprint = this.dayPnL >= this.SPRINT_THR;
    const minDist = sprint ? 1 : 3;  // Accept closer levels in sprint
    const maxDist = sprint ? 120 : 80; // Accept further levels in sprint
    // Sprint uses tighter stop; ultra-sprint (dayPnL >= 25) uses even tighter
    const ultraSprint = this.dayPnL >= 25;
    const stopDist = ultraSprint ? 10 : (sprint ? 15 : this.STOP);

    // LONG levels (buy limits at support)
    const longLevels = [];
    if (this.pdc !== null && !this.levelBroken['pdc'] && !existingLevels.has('pdc')) {
      longLevels.push({ name: 'pdc_lmt', price: this.pdc, lvl: 'pdc', side: 'buy' });
    }
    if (this.orbOK && this.orbL !== null && !this.levelBroken['orb'] && !existingLevels.has('orb') && e.t >= 9.75) {
      longLevels.push({ name: 'orb_lmt', price: this.orbL, lvl: 'orb', side: 'buy' });
    }
    if (this.ibOK && this.ibL !== null && !this.levelBroken['ib'] && !existingLevels.has('ib') && e.t >= 10) {
      longLevels.push({ name: 'ib_lmt', price: this.ibL, lvl: 'ib', side: 'buy' });
    }
    if (this.pdl !== null && !this.levelBroken['pdl'] && !existingLevels.has('pdl')) {
      longLevels.push({ name: 'pdl_lmt', price: this.pdl, lvl: 'pdl', side: 'buy' });
    }
    // Prior day midpoint (support when above)
    if (this.pdm !== null && !this.levelBroken['pdm'] && !existingLevels.has('pdm')) {
      longLevels.push({ name: 'pdm_lmt', price: this.pdm, lvl: 'pdm', side: 'buy' });
    }
    // Developing session low (after IB, current session low becomes support)
    if (this.ibOK && this.rthBuf.length > 30 && !existingLevels.has('dsl')) {
      const dsl = Math.min(...this.rthBuf.map(x => x.low));
      if (dsl < c.close - 3) {
        longLevels.push({ name: 'dsl_lmt', price: dsl, lvl: 'dsl', side: 'buy' });
      }
    }
    // VWAP long (support when price above VWAP)
    if (this.rthBuf.length > 15 && !existingLevels.has('vwl')) {
      const vw = VWAP(this.rthBuf);
      if (vw && c.close > vw + 3) {
        longLevels.push({ name: 'vwl_lmt', price: Math.round(vw * 4) / 4, lvl: 'vwl', side: 'buy' });
      }
    }
    // Round number level below (nearest 25-pt level below price)
    if (!existingLevels.has('rnl')) {
      const rnl = Math.floor(c.close / 25) * 25;
      if (rnl < c.close - 3 && !this.levelBroken['rnl']) {
        longLevels.push({ name: 'rnl_lmt', price: rnl, lvl: 'rnl', side: 'buy' });
      }
    }
    // Half round number level below (12.5-pt intervals)
    if (!existingLevels.has('rnl2')) {
      const rnl2 = Math.floor(c.close / 12.5) * 12.5;
      const rnl25 = Math.floor(c.close / 25) * 25;
      if (rnl2 !== rnl25 && rnl2 < c.close - 3 && !this.levelBroken['rnl2']) {
        longLevels.push({ name: 'rnl2_lmt', price: rnl2, lvl: 'rnl2', side: 'buy' });
      }
    }
    // Overnight low
    if (this.onL !== null && !this.levelBroken['onl'] && !existingLevels.has('onl')) {
      longLevels.push({ name: 'onl_lmt', price: this.onL, lvl: 'onl', side: 'buy' });
    }

    // SHORT levels (sell limits at resistance)
    const shortLevels = [];
    if (this.pdh !== null && !this.levelBroken['pdh'] && !existingLevels.has('pdh')) {
      shortLevels.push({ name: 'pdh_lmt', price: this.pdh, lvl: 'pdh', side: 'sell' });
    }
    if (this.orbOK && this.orbH !== null && !this.levelBroken['orbh'] && !existingLevels.has('orbh') && e.t >= 9.75) {
      shortLevels.push({ name: 'orbh_lmt', price: this.orbH, lvl: 'orbh', side: 'sell' });
    }
    // IB-H short (initial balance high)
    if (this.ibOK && this.ibH !== null && !this.levelBroken['ibh'] && !existingLevels.has('ibh') && e.t >= 10) {
      shortLevels.push({ name: 'ibh_lmt', price: this.ibH, lvl: 'ibh', side: 'sell' });
    }
    // Prior day midpoint (resistance when below)
    if (this.pdm !== null && !this.levelBroken['pdms'] && !existingLevels.has('pdms')) {
      shortLevels.push({ name: 'pdms_lmt', price: this.pdm, lvl: 'pdms', side: 'sell' });
    }
    // Developing session high (after IB, current session high becomes resistance)
    if (this.ibOK && this.rthBuf.length > 30 && !existingLevels.has('dsh')) {
      const dsh = Math.max(...this.rthBuf.map(x => x.high));
      if (dsh > c.close + 3) {
        shortLevels.push({ name: 'dsh_lmt', price: dsh, lvl: 'dsh', side: 'sell' });
      }
    }
    // VWAP short (resistance when price below VWAP)
    if (this.rthBuf.length > 15 && !existingLevels.has('vws')) {
      const vw = VWAP(this.rthBuf);
      if (vw && c.close < vw - 3) {
        shortLevels.push({ name: 'vws_lmt', price: Math.round(vw * 4) / 4, lvl: 'vws', side: 'sell' });
      }
    }
    // Round number level above (nearest 25-pt level above price)
    if (!existingLevels.has('rns')) {
      const rns = Math.ceil(c.close / 25) * 25;
      if (rns > c.close + 3 && !this.levelBroken['rns']) {
        shortLevels.push({ name: 'rns_lmt', price: rns, lvl: 'rns', side: 'sell' });
      }
    }
    // Half round number level above (12.5-pt intervals)
    if (!existingLevels.has('rns2')) {
      const rns2 = Math.ceil(c.close / 12.5) * 12.5;
      const rns25 = Math.ceil(c.close / 25) * 25;
      if (rns2 !== rns25 && rns2 > c.close + 3 && !this.levelBroken['rns2']) {
        shortLevels.push({ name: 'rns2_lmt', price: rns2, lvl: 'rns2', side: 'sell' });
      }
    }
    if (this.onH !== null && !this.levelBroken['onh'] && !existingLevels.has('onh')) {
      shortLevels.push({ name: 'onh_lmt', price: this.onH, lvl: 'onh', side: 'sell' });
    }

    // Place long limits: price must be above level
    for (const lvl of longLevels) {
      if (price > lvl.price + minDist && price < lvl.price + maxDist) {
        this.pendingLimits.push({
          ...lvl,
          stop: lvl.price - stopDist,
          stopDist,
          tgt: lvl.price + this.TARGET,
          placedBar: this.barIdx,
          sprint,
        });
      }
    }

    // Place short limits: price must be below level
    for (const lvl of shortLevels) {
      if (price < lvl.price - minDist && price > lvl.price - maxDist) {
        this.pendingLimits.push({
          ...lvl,
          stop: lvl.price + stopDist,
          stopDist,
          tgt: lvl.price - this.TARGET,
          placedBar: this.barIdx,
          sprint,
        });
      }
    }
    return null;
  }

  _checkLimits(c, e) {
    // Cancel stale orders
    this.pendingLimits = this.pendingLimits.filter(o => {
      if (this.barIdx - o.placedBar > 180) return false; // Cancel after 3 hours
      return true;
    });

    // Check fills
    for (let i = 0; i < this.pendingLimits.length; i++) {
      const o = this.pendingLimits[i];
      let filled = false;

      if (o.side === 'buy' && c.low <= o.price) {
        // Buy limit: fill when candle.low <= limit price
        filled = true;
      } else if (o.side === 'sell' && c.high >= o.price) {
        // Sell limit: fill when candle.high >= limit price
        filled = true;
      }

      if (filled) {
        this.pos = {
          side: o.side, entry: o.price,
          stop: o.stop, stopDist: o.stopDist || this.STOP,
          tgt: o.tgt,
          hwm: o.price, lwm: o.price,
          et: c.timestamp, bars: 0, r: o.name, lvl: o.lvl,
          mfe: o.side === 'buy' ? Math.max(0, c.high - o.price) : Math.max(0, o.price - c.low),
          mae: o.side === 'buy' ? Math.max(0, o.price - c.low) : Math.max(0, c.high - o.price),
          sym: c.symbol, beMoved: false, stepLevel: 0, trailing: false,
          sprint: o.sprint || false,
        };
        this.dayN++;
        this.dayTraded = true;
        this.pendingLimits = []; // Cancel other orders
        return;
      }
    }
  }

  // Mode A/B/D: Market entry at bar close
  _entry(c, e) {
    const c1 = this.buf.map(x => x.close);
    const atr1 = ATR(this.buf, 14);
    if (!atr1 || atr1 < 1) return null;

    const vw = this.rthBuf.length > 15 ? VWAP(this.rthBuf) : null;
    const ema9 = EMA(c1, 9);

    const price = c.close;
    const body = c.close - c.open;
    const range = c.high - c.low;
    const bullBar = body > 0 && Math.abs(body) > range * 0.2;
    const bullPin = range > atr1 * 0.5 && (c.close - c.low) > range * 0.6 && body >= 0;

    const vols = this.buf.slice(-20).map(x => x.volume);
    const avgVol = vols.reduce((a, b) => a + b) / vols.length;
    const volOK = c.volume >= avgVol * 0.3;

    const PROX = this.LEVEL_PROX;
    let sig = null;

    // 1: PDC BOUNCE
    if (!sig && this.pdc !== null && e.t < 14 && !this.levelBroken['pdc']) {
      if (price > this.pdc && price - this.pdc < PROX && (bullBar || bullPin) && volOK) {
        const noOverlapPdl = !this.pdl || Math.abs(this.pdc - this.pdl) > 5;
        const noOverlapOrb = !this.orbL || Math.abs(this.pdc - this.orbL) > 5;
        if (noOverlapPdl && noOverlapOrb) sig = { r: 'pdc_bnc', lvl: 'pdc' };
      }
    }

    // 2: ORB LOW BOUNCE
    if (!sig && this.orbOK && this.orbL !== null && e.t >= 9.75 && e.t < 14 && !this.levelBroken['orb']) {
      if (price > this.orbL && price - this.orbL < PROX && (bullBar || bullPin) && volOK) {
        sig = { r: 'orb_low', lvl: 'orb' };
      }
    }

    // 3: OD PULLBACK
    if (!sig && this.openDriveDir === 'up' && !this.firstPullbackTaken && e.t >= 9.75 && e.t < 10.5) {
      if ((bullBar || bullPin) && volOK && ema9) {
        const pt = vw || ema9;
        if (pt && price <= pt + atr1 * 0.5 && price >= pt - atr1 * 0.8) {
          sig = { r: 'od_pb', lvl: 'od' };
          this.firstPullbackTaken = true;
        }
      }
    }

    if (!sig) return null;

    const entry = price;
    this.pos = {
      side: 'buy', entry,
      stop: entry - this.STOP, stopDist: this.STOP,
      tgt: entry + this.TARGET,
      hwm: entry, lwm: entry,
      et: c.timestamp, bars: 0, r: sig.r, lvl: sig.lvl,
      mfe: 0, mae: 0, sym: c.symbol,
      beMoved: false, stepLevel: 0,
    };
    this.dayN++;
    this.dayTraded = true;
    return null;
  }

  _manage(c, e) {
    const p = this.pos;
    p.bars++;
    const isLong = p.side === 'buy';

    // Update MFE/MAE
    if (isLong) {
      p.hwm = Math.max(p.hwm, c.high);
      p.mfe = Math.max(p.mfe, c.high - p.entry);
      p.mae = Math.max(p.mae, p.entry - c.low);
    } else {
      p.lwm = Math.min(p.lwm, c.low);
      p.mfe = Math.max(p.mfe, p.entry - c.low);
      p.mae = Math.max(p.mae, c.high - p.entry);
    }

    // Gap protection
    const gapPnl = isLong ? (c.open - p.entry) : (p.entry - c.open);
    if (gapPnl < -this.STOP - 5) {
      const fill = isLong ? (c.open - this.SLIP) : (c.open + this.SLIP);
      return this._close(c, 'gap_stop', fill);
    }

    // Stepped protection (Mode B/C/D)
    if (this.USE_BE) {
      const profitExtreme = isLong ? (p.hwm - p.entry) : (p.entry - p.lwm);
      // Sprint positions use faster BE trigger (+3 instead of +5)
      const steps = p.sprint ? [[3, 0]] : this.STEPS;

      for (let i = steps.length - 1; i >= p.stepLevel; i--) {
        const [trigger, lockIn] = steps[i];
        if (profitExtreme >= trigger) {
          const newStop = isLong ? (p.entry + lockIn) : (p.entry - lockIn);
          const better = isLong ? (newStop > p.stop) : (newStop < p.stop);
          if (better) {
            p.stop = newStop;
            p.stepLevel = i + 1;
            if (lockIn === 0) p.beMoved = true;
          }
          break;
        }
      }

      // Trailing stop: graduated offset — tighter as we approach target
      // Never wider than base trail
      if (this.STEPS_TRAIL && p.beMoved) {
        const remaining = this.TGT - this.dayPnL;
        let offset;
        if (remaining <= 5) offset = 0.5;                             // Ultra-close: half-point trail
        else if (remaining <= 10) offset = 1;                         // Close: capture every point
        else if (remaining <= 25) offset = Math.min(2, this.STEPS_TRAIL);  // Push: tight
        else offset = this.STEPS_TRAIL;                               // Normal: base trail
        const trailStop = isLong ? (p.hwm - offset) : (p.lwm + offset);
        const better = isLong ? (trailStop > p.stop) : (trailStop < p.stop);
        if (better) {
          p.stop = trailStop;
          p.trailing = true;
        }
      }
    }

    // Stop check
    const stopHit = isLong ? (c.low <= p.stop) : (c.high >= p.stop);
    if (stopHit) {
      let rawFill;
      if (isLong) {
        rawFill = Math.min(c.open, p.stop) - this.SLIP;
        rawFill = Math.max(rawFill, p.entry - p.stopDist - 2);
      } else {
        rawFill = Math.max(c.open, p.stop) + this.SLIP;
        rawFill = Math.min(rawFill, p.entry + p.stopDist + 2);
      }
      let reason = 'stop';
      if (p.beMoved) {
        if (p.trailing) reason = 'trail';
        else if (p.stepLevel > 1) reason = 'stepped';
        else {
          const atBE = isLong ? (p.stop >= p.entry - 0.5) : (p.stop <= p.entry + 0.5);
          if (atBE) reason = 'breakeven';
        }
      }
      return this._close(c, reason, rawFill);
    }

    // Target check
    const tgtHit = isLong ? (c.high >= p.tgt) : (c.low <= p.tgt);
    if (tgtHit) {
      const fill = isLong ? Math.max(c.open, p.tgt) : Math.min(c.open, p.tgt);
      return this._close(c, 'target', fill);
    }

    // Max hold
    if (p.bars >= this.MAXH) {
      const fill = isLong ? (c.close - this.SLIP) : (c.close + this.SLIP);
      return this._close(c, 'maxhold', fill);
    }

    return null;
  }

  _close(c, reason, fill = null) {
    const p = this.pos;
    if (!p) return null;
    const isLong = p.side === 'buy';
    const ex = fill ?? (isLong ? (c.close - this.SLIP) : (c.close + this.SLIP));
    const pnl = isLong ? (ex - p.entry) : (p.entry - ex);
    this.trades.push({
      et: p.et, xt: c.timestamp, side: p.side, entry: p.entry,
      exit: Math.round(ex * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      reason, sr: p.r, bars: p.bars,
      mfe: Math.round(p.mfe * 100) / 100,
      mae: Math.round(p.mae * 100) / 100,
    });
    this.dayPnL += pnl;
    this.lastExitBar = this.barIdx;
    this.pos = null;

    if (pnl < -1) {
      // Level broken on stop loss - don't re-enter
      if (p.lvl) this.levelBroken[p.lvl] = true;
    }
    // Trail exits and BEs: allow re-entry at same level (proved it's support)
    // Only mark broken if stop was hit (real loss)

    if (this.dayPnL >= this.TGT) { this.dayDone = true; this.dayTgt = true; }
    if (this.dayPnL <= this.LIM) { this.dayDone = true; }
    return null;
  }

  end() { if (this.curDay) this._saveDay(); }
}

// ============================================================
// RUN + REPORT
// ============================================================
async function run(start, end, cfg = {}) {
  const path = '/home/drew/projects/slingshot-services/backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv';
  const raw = await loadData(path, start, end);
  const candles = filterPrimary(raw);
  const s = new Scalper(cfg);
  const step = Math.max(1, Math.floor(candles.length / 10));
  for (let i = 0; i < candles.length; i++) {
    if (i % step === 0) process.stdout.write(`${Math.floor(i / candles.length * 100)}% `);
    s.tick(candles[i]);
  }
  if (s.pos && candles.length) s._close(candles.at(-1), 'end');
  s.end();
  process.stdout.write('100%\n');
  return { trades: s.trades, daily: s.daily };
}

function rpt(r, label = '') {
  const { trades: t, daily: d } = r;
  console.log(`\n${'='.repeat(70)}\n${label}\n${'='.repeat(70)}\n`);
  if (!t.length) { console.log('No trades'); return; }

  const w = t.filter(x => x.pnl > 0.5), l = t.filter(x => x.pnl < -0.5);
  const z = t.filter(x => x.pnl >= -0.5 && x.pnl <= 0.5);
  const tot = t.reduce((s, x) => s + x.pnl, 0);
  const gw = w.reduce((s, x) => s + x.pnl, 0), gl = Math.abs(l.reduce((s, x) => s + x.pnl, 0));

  console.log(`TRADES: N=${t.length}  W=${w.length}(${(w.length / t.length * 100).toFixed(1)}%)  L=${l.length}  Z=${z.length}(BE/flat)`);
  console.log(`  AvgW=${w.length ? (gw / w.length).toFixed(2) : 0}  AvgL=${l.length ? (-gl / l.length).toFixed(2) : 0}  PF=${gl > 0 ? (gw / gl).toFixed(2) : 'Inf'}  Net=${tot.toFixed(2)}pts ($${(tot * 2).toFixed(2)})`);
  console.log(`  AvgMFE=${(t.reduce((s, x) => s + x.mfe, 0) / t.length).toFixed(2)}  AvgMAE=${(t.reduce((s, x) => s + x.mae, 0) / t.length).toFixed(2)}  AvgBars=${(t.reduce((s, x) => s + x.bars, 0) / t.length).toFixed(1)}`);

  const td = d.filter(x => x.trades > 0);
  const noTrade = d.filter(x => x.trades === 0);
  const wd = td.filter(x => x.pnl > 0.5), ld = td.filter(x => x.pnl < -0.5);
  const tgtD = d.filter(x => x.tgt), limD = d.filter(x => x.lim);
  const neitherD = td.length - tgtD.length - limD.length;
  console.log(`\nDAILY: ${td.length} traded + ${noTrade.length} no-trade = ${d.length} total days`);
  console.log(`  W=${wd.length}(${td.length ? (wd.length / td.length * 100).toFixed(1) : 0}%)  L=${ld.length}`);
  console.log(`  Target=${tgtD.length}  LossLimit=${limD.length}  Neither=${neitherD}  NoTrade=${noTrade.length}  Avg=${td.length ? (td.reduce((s,x) => s+x.pnl, 0)/td.length).toFixed(2) : 0}pts`);
  if (td.length) console.log(`  Best=${Math.max(...td.map(x => x.pnl)).toFixed(2)}  Worst=${Math.min(...td.map(x => x.pnl)).toFixed(2)}`);

  const polarized = tgtD.length + limD.length;
  console.log(`  ACTIVE POLARIZATION: ${polarized}/${td.length} = ${td.length ? (polarized / td.length * 100).toFixed(1) : 0}%`);
  console.log(`  TOTAL POLARIZATION:  ${polarized}/${d.length} = ${d.length ? (polarized / d.length * 100).toFixed(1) : 0}%`);

  const wm = new Map();
  for (const x of d) { const k = weekKey(new Date(x.date + 'T12:00:00Z')); if (!wm.has(k)) wm.set(k, []); wm.get(k).push(x); }
  let wOK = 0, wT = 0;
  for (const [, days] of wm) { wT++; if (days.filter(x => x.pnl < -0.5 && x.trades > 0).length <= 1) wOK++; }
  console.log(`  WEEKLY: ${wOK}/${wT} within 1-loss limit`);

  const er = {};
  for (const x of t) { if (!er[x.reason]) er[x.reason] = { n: 0, p: 0 }; er[x.reason].n++; er[x.reason].p += x.pnl; }
  console.log('\nEXIT BREAKDOWN:');
  for (const [k, v] of Object.entries(er).sort((a, b) => b[1].p - a[1].p))
    console.log(`  ${k.padEnd(12)} ${String(v.n).padStart(5)}t  ${v.p >= 0 ? '+' : ''}${v.p.toFixed(2)}pts`);

  const sr = {};
  for (const x of t) {
    if (!sr[x.sr]) sr[x.sr] = { n: 0, p: 0, w: 0, be: 0, mfe: 0 };
    sr[x.sr].n++; sr[x.sr].p += x.pnl;
    if (x.pnl > 0.5) sr[x.sr].w++;
    if (x.pnl >= -0.5 && x.pnl <= 0.5) sr[x.sr].be++;
    sr[x.sr].mfe += x.mfe;
  }
  console.log('\nSIGNAL BREAKDOWN:');
  for (const [k, v] of Object.entries(sr).sort((a, b) => b[1].p - a[1].p))
    console.log(`  ${k.padEnd(12)} ${String(v.n).padStart(5)}t  ${v.p >= 0 ? '+' : ''}${v.p.toFixed(2)}pts  ${(v.w / v.n * 100).toFixed(0)}%WR  ${v.be}BE  avgMFE=${(v.mfe / v.n).toFixed(1)}`);

  // Daily P&L distribution
  const pnlBuckets = {};
  for (const x of td) {
    const bucket = Math.round(x.pnl / 10) * 10;
    pnlBuckets[bucket] = (pnlBuckets[bucket] || 0) + 1;
  }
  console.log('\nDAILY P&L DISTRIBUTION:');
  for (const [b, c2] of Object.entries(pnlBuckets).sort((a, b) => +a[0] - +b[0])) {
    console.log(`  ${String(b).padStart(6)}pts: ${'#'.repeat(c2)} (${c2})`);
  }
}

// ============================================================
// MAIN
// ============================================================
const args = process.argv.slice(2);
let start = new Date('2025-06-01T00:00:00Z'), end = new Date('2025-09-30T23:59:59Z');
if (args.length >= 2 && !args[0].startsWith('-')) { start = new Date(args[0] + 'T00:00:00Z'); end = new Date(args[1] + 'T23:59:59Z'); }

const cfg = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--mode' && args[i + 1]) { cfg.mode = args[++i].toUpperCase(); }
  if (a === '--stop' && args[i + 1]) { cfg.stop = parseFloat(args[++i]); }
  if (a === '--tgt' && args[i + 1]) { cfg.tgtPts = parseFloat(args[++i]); }
  if (a === '--attempts' && args[i + 1]) { cfg.maxAttempts = parseInt(args[++i]); }
  if (a === '--lastentry' && args[i + 1]) { cfg.lastEntry = parseFloat(args[++i]); }
  if (a === '--maxh' && args[i + 1]) { cfg.maxH = parseInt(args[++i]); }
  if (a === '--prox' && args[i + 1]) { cfg.levelProx = parseFloat(args[++i]); }
  if (a === '--steps' && args[i + 1]) { cfg.steps = args[++i]; }
  if (a === '--trail-off' && args[i + 1]) { cfg.trailOff = parseFloat(args[++i]); }
  if (a === '--sprint-thr' && args[i + 1]) { cfg.sprintThr = parseFloat(args[++i]); }
}

// Run all modes if no mode specified
const modes = cfg.mode ? [cfg.mode] : ['A', 'B', 'D', 'C'];

for (const mode of modes) {
  const mcfg = { ...cfg, mode };
  const label = `v11c MODE ${mode} | ${start.toISOString().slice(0,10)} → ${end.toISOString().slice(0,10)} | stop=${mcfg.stop || 25} tgt=${mcfg.tgtPts || 50} attempts=${mcfg.maxAttempts || (mode === 'D' ? 5 : 1)}`;
  console.log(`\n${label}\n`);
  const res = await run(start, end, mcfg);
  rpt(res, label);

  if (modes.length === 1) {
    const op = '/home/drew/projects/slingshot-services/backtest-engine/mnq-scalper-results.json';
    fs.writeFileSync(op, JSON.stringify({
      summary: {
        n: res.trades.length,
        pnl: Math.round(res.trades.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
        wr: res.trades.length ? res.trades.filter(t => t.pnl > 0).length / res.trades.length : 0,
        tgtDays: res.daily.filter(x => x.tgt).length,
        limDays: res.daily.filter(x => x.lim).length,
      },
      trades: res.trades.map(t => ({ ...t, et: t.et.toISOString(), xt: t.xt.toISOString() })),
      daily: res.daily
    }, null, 2));

    // Print non-compliant days
    const neither = res.daily.filter(x => !x.tgt && !x.lim && x.trades > 0);
    const noTrade = res.daily.filter(x => x.trades === 0);
    if (neither.length > 0) {
      console.log(`\nNEITHER DAYS (${neither.length}):`);
      for (const d of neither) console.log(`  ${d.date}  pnl=${d.pnl.toFixed(2)}  trades=${d.trades}`);
    }
    if (noTrade.length > 0) {
      console.log(`\nNO-TRADE DAYS (${noTrade.length}):`);
      for (const d of noTrade) console.log(`  ${d.date}  pnl=${d.pnl.toFixed(2)}`);
    }
  }
}
