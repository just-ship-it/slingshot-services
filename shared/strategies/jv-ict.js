/**
 * JV-ICT Strategy — "Unlock The Market" M/W sweep-shift-retest model
 *
 * Clean-room implementation of the mechanical spec in
 * backtest-engine/research/jv-ict-2026-07/02-STRATEGY-SPEC.md (v1).
 * Methodology background: 01-METHODOLOGY.md. Deviations/resolutions are
 * documented in 03-IMPLEMENTATION-NOTES.md.
 *
 * Model (M = short; W = exact mirror long):
 *   1. SWEEP: a bar's wick exceeds the most recent unbroken confirmed swing
 *      high (and/or PDH). Record O = most recent confirmed swing low (the
 *      "low that caused the high") and start tracking NH = running extreme.
 *   2. MSS: a bar CLOSES below O.low -> structure shifted.
 *   3. Build fib over the impulse leg (body-to-body: fib100 = sweep-extreme
 *      bar bodyHigh, fib0 = min body of leg), collect bearish IMB/OB zones
 *      formed within the leg, gate on confluence + daily-open bias + session.
 *   4. Rest a SELL limit at the entry level (default 70.5% "Optimal"),
 *      hard stop past the sweep extreme + buffer, TP at leg low (0% fib).
 *   5. Pre-fill cancels: close beyond sweep extreme, close beyond leg low,
 *      TTL, session end (via shouldInvalidatePendingOrder).
 *
 * Causality: pivots confirm only after PIVOT_N right-side bars have closed;
 * all zones/fibs derive from bars fully closed at decision time; decisions
 * happen only on closed run-TF candles. Fills/exits are handled by the
 * engine's 1s replay.
 *
 * All decisions on the run timeframe (default 15m). Daily context (daily
 * open, PDH/PDL on the 18:00 ET Globex session boundary) is built internally
 * from the closed intraday bars.
 */

import fs from 'fs';
import { BaseStrategy } from './base-strategy.js';
import { isValidCandle } from './strategy-utils.js';
import { CandleAggregator } from '../utils/candle-aggregator.js';

const TICK = 0.25;

function roundToTick(price) {
  return Math.round(price / TICK) * TICK;
}

/** Deterministic 32-bit PRNG (research placebo mode only). */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class JvIctStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: true,
      gex: false,
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // --- Ambiguity axes (see spec §9 / task) ---
      // Which zone must overlap the 50-79% fib band:
      // 'either' (default) | 'imb' | 'ob' | 'both' | 'none'
      confluenceMode: 'either',
      // Directional gate at MSS bar close:
      // 'dailyOpen' (short: close < daily open) | 'pdhpdl' (short: close < PDL,
      // i.e. genuine break below prior day range per book p5) | 'htf1h'
      // (book p33 #1: align with 1H structure — shorts need 1H bearish, longs
      // 1H bullish, per last close-confirmed break of a confirmed 1H swing) |
      // 'htf4h' (same on 4H, diagnostic) | 'none'
      biasMode: 'dailyOpen',
      // 'hard' (stop-market at sweep extreme + buffer)
      // 'close' (close-confirmed: softStopPoints at 1m closes + catastrophic
      //          hard stop at 2x distance; see implementation notes)
      stopMode: 'hard',
      // 'legLow' (0% fib terminus + 1 tick) | 'external' (next external
      // liquidity below/above leg terminus, PDL/PDH; fallback legLow)
      tpMode: 'legLow',
      // 'optimal' (70.5%) | 'imbEdge' (max/min of 70.5% and band-overlapping
      // IMB proximal edge, spec A6 default) | 'discount' (50%) | 'premium' (79%)
      entryLevel: 'optimal',

      // --- Fixed-ish spec params ---
      pivotN: 2,                 // fractal half-width; confirm lag = pivotN bars
      fibEntryPct: 0.705,
      fibBandLow: 0.50,
      fibBandHigh: 0.79,
      stopBufferTicks: 4,        // 1 pt beyond the sweep extreme
      maxStopPoints: 50,         // skip setups with wider structural risk
      mssTimeoutBars: 40,        // sweep must shift within N entry-TF bars
      orderTtlBars: 24,          // cancel unfilled entry after N entry-TF bars
      closeStopCatastrophicMult: 2, // stopMode 'close': hard backup at N x dist
      // Which levels count as sweepable liquidity: 'swing+pdhpdl' | 'swing' | 'pdhpdl'
      sweepLevels: 'swing+pdhpdl',
      // External-TP: candidate must sit within N x leg height beyond the leg terminus
      externalTpMaxLegMult: 2,

      // --- Session (ET, minutes since midnight; gate uses bar CLOSE time) ---
      sessionStartMin: 9 * 60 + 30,   // 09:30
      sessionEndMin: 15 * 60 + 30,    // 15:30 (exclusive)
      // Optional narrower SIGNAL-EMISSION window inside the session (ET min
      // since midnight). null = use session bounds. Pending-order lifecycle
      // (fills/cancels) still runs to sessionEndMin.
      entryStartMin: null,
      entryEndMin: null,

      // --- Sides ---
      // 'both' | 'long' (W only) | 'short' (M only). Overrides allowShorts/
      // allowLongs when set to non-'both'.
      sides: 'both',
      allowShorts: true,   // M model
      allowLongs: true,    // W model

      // --- SMT / pairs confirmation (spec §7, book p33 #7) ---
      // 'off' | 'require' (setup needs SMT DIVERGENCE at the sweep: NQ sweeps
      // its level while ES fails to sweep its own — classic SMT reversal
      // signal) | 'avoid' (setup needs AGREEMENT: ES swept its own level too —
      // book p33 "moves confirmed when pairs move together").
      // ES structure is mirrored from a prepared, deduped ES 15m CSV
      // (smtEsFile: ts_ms,open,high,low,close) using the SAME pivot/break
      // discipline as the run symbol. Only ES bars fully closed at the
      // current run-TF close are consumed. Divergence is evaluated on the
      // ES bar with the same period-start as each NQ sweep-push bar
      // (re-evaluated on new extreme pushes; the final push before MSS
      // gates). Run-TF must be 15m when smtMode != 'off'.
      smtMode: 'off',
      smtEsFile: null,

      // --- PLACEBO MODE (research-only; round-3 kill test) ---
      // When true, ALL sweep/MSS/fib/zone logic is bypassed. Instead the
      // strategy replays a harvested per-trade geometry catalog (time-of-day,
      // limit offset from current close, stop distance, TP distance — taken
      // from a real run's emitted signals) on RANDOM weekdays in
      // [placeboStart, placeboEnd], chosen by a seeded deterministic PRNG.
      // Same TTL, same pre-fill cancel rules (synthesized extreme/terminus),
      // same session gate, same engine execution path. This isolates
      // "sweep/MSS structure" from "time-of-day + geometry + NQ drift".
      placeboMode: false,
      placeboSeed: 1,
      placeboCatalogFile: null,  // JSON: [{m: etMinOfDayAtEmit, off, stop, tp, side}]
      placeboStart: null,        // 'YYYY-MM-DD' (weekday pool start)
      placeboEnd: null,          // 'YYYY-MM-DD' (weekday pool end, inclusive)

      // --- Housekeeping ---
      maxSwings: 300,      // cap swing lists (pruned oldest)
      maxImbs: 200,        // cap IMB list
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      debug: false,
      debugGates: false
    };

    this.params = { ...this.defaultParams, ...params };
    if (this.params.sides === 'long') {
      this.params.allowLongs = true;
      this.params.allowShorts = false;
    } else if (this.params.sides === 'short') {
      this.params.allowLongs = false;
      this.params.allowShorts = true;
    }
    this._initState();
    if (this.params.placeboMode) this._initPlacebo();
    if (this.params.smtMode !== 'off') this._initSmt();
  }

  /**
   * Load the prepared ES 15m series and precompute, per ES bar, whether that
   * bar swept ES's own most-recent-unbroken confirmed swing high/low —
   * using exactly the run-symbol structure discipline (pivotN-lagged
   * confirmation usable at its confirming close; sweep checked against
   * levels as of the prior close; broken-marking after).
   */
  _initSmt() {
    const p = this.params;
    if (!p.smtEsFile) throw new Error('smtMode requires smtEsFile');
    const lines = fs.readFileSync(p.smtEsFile, 'utf8').trim().split('\n');
    this.esBars = [];
    for (let i = 1; i < lines.length; i++) {
      const [ts, o, h, l, c] = lines[i].split(',');
      this.esBars.push({ ts: +ts, open: +o, high: +h, low: +l, close: +c });
    }
    this.esIdx = 0;              // consumed count
    this.esSwingHighs = [];
    this.esSwingLows = [];
    this.esInfoByTs = new Map(); // period-start ts -> {sweptHigh, sweptLow, hasHigh, hasLow}
  }

  _processEsBar(i) {
    const n = this.params.pivotN;
    const b = this.esBars;
    const bar = b[i];
    // 1. Confirm pivots (candidate i-n, usable this same close)
    const cand = i - n;
    if (cand >= n) {
      let isHigh = true, isLow = true;
      for (let k = 1; k <= n; k++) {
        if (!(b[cand].high > b[cand - k].high && b[cand].high > b[cand + k].high)) isHigh = false;
        if (!(b[cand].low < b[cand - k].low && b[cand].low < b[cand + k].low)) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) {
        this.esSwingHighs.push({ price: b[cand].high, broken: false });
        if (this.esSwingHighs.length > this.params.maxSwings) this.esSwingHighs.shift();
      }
      if (isLow) {
        this.esSwingLows.push({ price: b[cand].low, broken: false });
        if (this.esSwingLows.length > this.params.maxSwings) this.esSwingLows.shift();
      }
    }
    // 2. Sweep info vs last unbroken confirmed swing (pre-broken-marking)
    const sh = this._lastUnbroken(this.esSwingHighs);
    const sl = this._lastUnbroken(this.esSwingLows);
    this.esInfoByTs.set(bar.ts, {
      hasHigh: !!sh,
      hasLow: !!sl,
      sweptHigh: !!(sh && bar.high > sh.price),
      sweptLow: !!(sl && bar.low < sl.price)
    });
    // 3. Mark broken by this close
    for (let k = this.esSwingHighs.length - 1; k >= 0; k--) {
      const s = this.esSwingHighs[k];
      if (!s.broken && bar.close > s.price) s.broken = true;
    }
    for (let k = this.esSwingLows.length - 1; k >= 0; k--) {
      const s = this.esSwingLows[k];
      if (!s.broken && bar.close < s.price) s.broken = true;
    }
  }

  /** Consume ES bars fully closed at closeTs (ES file is 15m). */
  _updateSmt(closeTs) {
    while (this.esIdx < this.esBars.length &&
           this.esBars[this.esIdx].ts + 900000 <= closeTs) {
      this._processEsBar(this.esIdx);
      this.esIdx++;
    }
  }

  /**
   * SMT status for a run-symbol sweep push on the bar starting at barStartTs:
   * 'divergent' (NQ swept, ES did not sweep its own), 'agree' (both swept),
   * or null (no ES bar / no ES structure yet).
   */
  _smtStatus(isShort, barStartTs) {
    const info = this.esInfoByTs.get(barStartTs);
    if (!info) return null;
    if (isShort) {
      if (!info.hasHigh) return null;
      return info.sweptHigh ? 'agree' : 'divergent';
    }
    if (!info.hasLow) return null;
    return info.sweptLow ? 'agree' : 'divergent';
  }

  /**
   * Build the placebo schedule: each catalog entry is assigned a uniformly
   * random weekday in [placeboStart, placeboEnd] (seeded PRNG → reproducible)
   * and fires at the first run-TF close at/after its original ET
   * minute-of-day on that day. Entries landing on holidays never fire
   * (counted as unfired). Time-of-day and geometry marginals are preserved
   * exactly; only the DAY (and hence market state) is randomized.
   */
  _initPlacebo() {
    const p = this.params;
    if (!p.placeboCatalogFile || !p.placeboStart || !p.placeboEnd) {
      throw new Error('placeboMode requires placeboCatalogFile, placeboStart, placeboEnd');
    }
    const catalog = JSON.parse(fs.readFileSync(p.placeboCatalogFile, 'utf8'));
    const days = [];
    let d = new Date(`${p.placeboStart}T00:00:00Z`);
    const end = new Date(`${p.placeboEnd}T00:00:00Z`);
    while (d <= end) {
      const dow = d.getUTCDay();
      if (dow >= 1 && dow <= 5) days.push(d.toISOString().slice(0, 10));
      d = new Date(d.getTime() + 86400000);
    }
    const rand = mulberry32(p.placeboSeed | 0);
    this.placeboSchedule = new Map(); // dateKey -> entries (sorted by m)
    catalog.forEach((e, i) => {
      const day = days[Math.floor(rand() * days.length)];
      if (!this.placeboSchedule.has(day)) this.placeboSchedule.set(day, []);
      this.placeboSchedule.get(day).push({ ...e, idx: i, fired: false });
    });
    for (const arr of this.placeboSchedule.values()) arr.sort((a, b) => a.m - b.m);
    this.placeboStats = { catalog: catalog.length, emitted: 0, skipped_guard: 0 };
  }

  _initState() {
    // Closed run-TF bars (chronological). Index = bar id used everywhere.
    this.bars = [];
    // Inferred run-TF duration (min positive diff between consecutive bars).
    this.tfMs = null;

    // Confirmed swings: { price, bar, bodyHigh, bodyLow, ts, broken }
    this.swingHighs = [];
    this.swingLows = [];

    // IMB zones: { type: 'bearish'|'bullish', top, bottom, bar, ts }
    this.imbs = [];

    // Daily (18:00 ET Globex session) tracking
    this.curDayKey = null;
    this.curDayPartial = true; // first observed day may start mid-session
    this.curDayHigh = null;
    this.curDayLow = null;
    this.dailyOpen = null;     // current trading day's open (18:00 ET)
    this.pdh = null;           // previous COMPLETED day's high (wicks)
    this.pdl = null;

    // Model state machines
    this.mState = this._freshModelState(); // short model (sweep of highs)
    this.wState = this._freshModelState(); // long model (sweep of lows)

    // HTF structure tracking (biasMode 'htf1h'/'htf4h'). Built from run-TF
    // candles via CandleAggregator; only fully-CLOSED HTF bars are consumed.
    this.htfAggregator = new CandleAggregator();
    this.htfBars = [];          // closed HTF bars {ts, open, high, low, close}
    this.htfSwingHighs = [];    // confirmed HTF swings (pivotN-lagged)
    this.htfSwingLows = [];
    this.htfStructure = null;   // 'bullish' | 'bearish' | null (no break yet)
    this.htfProcessedCount = 0; // index into aggregator's output array

    // Gate rejection stats
    this.gateStats = {
      sweeps_m: 0, sweeps_w: 0,
      mss_m: 0, mss_w: 0,
      no_causal_swing: 0,
      mss_timeout: 0,
      degenerate_leg: 0,
      confluence_fail: 0,
      bias_fail: 0,
      bias_warmup: 0,
      smt_fail: 0,
      smt_nodata: 0,
      session_fail: 0,
      limit_through_price: 0,
      stop_too_wide: 0,
      both_models_same_bar: 0,
      signals_emitted: 0
    };
  }

  _freshModelState() {
    return {
      state: 'IDLE',          // IDLE | SWEPT
      sweepBar: null,
      sweepTs: null,
      sweptLevel: null,
      sweptLevelType: null,   // 'swing' | 'pdh' | 'pdl'
      sweepClosedThrough: null,
      O: null,                // causal opposing swing at sweep time
      extreme: null,          // { price, bar } running NH (M) / NL (W)
      smt: null               // 'divergent' | 'agree' | null (latest sweep push)
    };
  }

  getETTime(timestamp) {
    const date = new Date(typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime());
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const [datePart, timePart] = estString.split(', ');
    const [month, day, year] = datePart.split('/');
    const [hour, minute] = timePart.split(':');
    return {
      year: parseInt(year),
      month: parseInt(month),
      day: parseInt(day),
      hour: parseInt(hour) % 24, // toLocaleString can emit "24" for midnight
      minute: parseInt(minute),
      dateKey: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    };
  }

  /**
   * Trading-day key on the 18:00 ET Globex boundary: bars at/after 18:00 ET
   * belong to the NEXT calendar day's trading session.
   */
  _tradingDayInfo(timestamp) {
    const et = this.getETTime(timestamp);
    let key = et.dateKey;
    if (et.hour >= 18) {
      const d = new Date(Date.UTC(et.year, et.month - 1, et.day));
      d.setUTCDate(d.getUTCDate() + 1);
      key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    return { et, key, isSessionOpenBar: et.hour === 18 && et.minute === 0 };
  }

  // ---------------------------------------------------------------------
  // Per-bar bookkeeping
  // ---------------------------------------------------------------------

  _updateDaily(candle, ts) {
    const { key, isSessionOpenBar } = this._tradingDayInfo(ts);

    if (key !== this.curDayKey) {
      // Roll: previous day completes
      if (this.curDayKey !== null && !this.curDayPartial) {
        this.pdh = this.curDayHigh;
        this.pdl = this.curDayLow;
      } else if (this.curDayKey !== null && this.curDayPartial) {
        // partial first day: do not trust its extremes
        this.pdh = null;
        this.pdl = null;
      }
      this.curDayKey = key;
      this.curDayHigh = candle.high;
      this.curDayLow = candle.low;
      // Daily open only trustworthy if the day starts at the 18:00 session open
      this.curDayPartial = !isSessionOpenBar;
      this.dailyOpen = isSessionOpenBar ? candle.open : null;

      if (this.params.debugGates) {
        this._printGateStats(`day ${key}`);
      }
    } else {
      this.curDayHigh = Math.max(this.curDayHigh, candle.high);
      this.curDayLow = Math.min(this.curDayLow, candle.low);
    }
  }

  _updatePivots(idx) {
    const n = this.params.pivotN;
    const i = idx - n; // candidate bar, confirmed at close of idx
    if (i < n) return;
    const b = this.bars;

    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= n; k++) {
      if (!(b[i].high > b[i - k].high && b[i].high > b[i + k].high)) isHigh = false;
      if (!(b[i].low < b[i - k].low && b[i].low < b[i + k].low)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) {
      this.swingHighs.push({
        price: b[i].high, bar: i, ts: b[i].ts,
        bodyHigh: b[i].bodyHigh, bodyLow: b[i].bodyLow, broken: false
      });
      if (this.swingHighs.length > this.params.maxSwings) this.swingHighs.shift();
    }
    if (isLow) {
      this.swingLows.push({
        price: b[i].low, bar: i, ts: b[i].ts,
        bodyHigh: b[i].bodyHigh, bodyLow: b[i].bodyLow, broken: false
      });
      if (this.swingLows.length > this.params.maxSwings) this.swingLows.shift();
    }
  }

  _updateImbs(idx) {
    const b = this.bars;

    // Consume existing zones FIRST (a just-created zone cannot be consumed by
    // its own creation bar; see notes).
    // Bearish IMB (gap above price) is consumed when a bar CLOSES above its
    // top (far edge in the fill direction). Bullish mirror: close below bottom.
    const close = b[idx].close;
    this.imbs = this.imbs.filter(z =>
      z.type === 'bearish' ? close <= z.top : close >= z.bottom
    );

    // New IMB with middle bar i = idx-1 (3-bar wick gap), exists from close of idx
    if (idx >= 2) {
      // Bearish (formed in a down impulse, sits above price): low[i-1] > high[i+1]
      if (b[idx - 2].low > b[idx].high) {
        this.imbs.push({
          type: 'bearish',
          top: b[idx - 2].low,
          bottom: b[idx].high,
          bar: idx - 1,
          ts: b[idx - 1].ts
        });
      }
      // Bullish (sits below price): high[i-1] < low[i+1]
      if (b[idx - 2].high < b[idx].low) {
        this.imbs.push({
          type: 'bullish',
          top: b[idx].low,
          bottom: b[idx - 2].high,
          bar: idx - 1,
          ts: b[idx - 1].ts
        });
      }
      if (this.imbs.length > this.params.maxImbs) {
        this.imbs.splice(0, this.imbs.length - this.params.maxImbs);
      }
    }
  }

  _markBrokenSwings(candle) {
    // A swing high breaks when a later bar CLOSES above it; low mirror.
    // Called AFTER model steps so a close-through sweep still sees the level.
    for (let i = this.swingHighs.length - 1; i >= 0; i--) {
      const s = this.swingHighs[i];
      if (!s.broken && candle.close > s.price) s.broken = true;
    }
    for (let i = this.swingLows.length - 1; i >= 0; i--) {
      const s = this.swingLows[i];
      if (!s.broken && candle.close < s.price) s.broken = true;
    }
  }

  _lastUnbroken(list) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].broken) return list[i];
    }
    return null;
  }

  _last(list) {
    return list.length ? list[list.length - 1] : null;
  }

  // ---------------------------------------------------------------------
  // HTF structure (biasMode 'htf1h' / 'htf4h')
  // ---------------------------------------------------------------------

  _htfTf() {
    return this.params.biasMode === 'htf4h' ? '4h' : '1h';
  }

  _usingHtfBias() {
    return this.params.biasMode === 'htf1h' || this.params.biasMode === 'htf4h';
  }

  /**
   * Feed the just-closed run-TF candle into the HTF aggregation and consume
   * any HTF bars that are fully closed at `closeTs` (an HTF bar whose period
   * ends exactly at the current run-TF close is closed — every constituent
   * bar has closed — and is usable on this same decision, mirroring the
   * pivot-usable-at-confirmation-close convention).
   */
  _updateHtf(candle, ts, closeTs) {
    const tf = this._htfTf();
    const htfMs = this.htfAggregator.getIntervalMinutes(tf) * 60 * 1000;
    const all = this.htfAggregator.addCandleIncremental({
      timestamp: ts,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume || 0,
      symbol: candle.symbol
    }, tf, 'jvhtf');

    while (this.htfProcessedCount < all.length) {
      const hb = all[this.htfProcessedCount];
      if (hb.timestamp + htfMs > closeTs) break; // still in progress
      this._processClosedHtfBar(hb);
      this.htfProcessedCount++;
    }
  }

  /**
   * Exactly the run-TF structure discipline, on closed HTF bars:
   * pivotN-lagged fractal pivots, close-confirmed breaks of the most recent
   * unbroken confirmed swing. Structure state = direction of last break.
   */
  _processClosedHtfBar(hb) {
    const n = this.params.pivotN;
    this.htfBars.push({
      ts: hb.timestamp,
      open: hb.open,
      high: hb.high,
      low: hb.low,
      close: hb.close
    });
    const idx = this.htfBars.length - 1;
    const b = this.htfBars;

    // Confirm pivots (candidate = idx - n, confirmed at this close)
    const i = idx - n;
    if (i >= n) {
      let isHigh = true;
      let isLow = true;
      for (let k = 1; k <= n; k++) {
        if (!(b[i].high > b[i - k].high && b[i].high > b[i + k].high)) isHigh = false;
        if (!(b[i].low < b[i - k].low && b[i].low < b[i + k].low)) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) {
        this.htfSwingHighs.push({ price: b[i].high, bar: i, ts: b[i].ts, broken: false });
        if (this.htfSwingHighs.length > this.params.maxSwings) this.htfSwingHighs.shift();
      }
      if (isLow) {
        this.htfSwingLows.push({ price: b[i].low, bar: i, ts: b[i].ts, broken: false });
        if (this.htfSwingLows.length > this.params.maxSwings) this.htfSwingLows.shift();
      }
    }

    // Close-confirmed structure break vs the levels as of the PRIOR close
    // (broken-marking runs after, same ordering as the run-TF machine).
    const sh = this._lastUnbroken(this.htfSwingHighs);
    const sl = this._lastUnbroken(this.htfSwingLows);
    const brokeUp = !!(sh && hb.close > sh.price);
    const brokeDown = !!(sl && hb.close < sl.price);
    if (brokeUp && brokeDown) {
      // Giant bar broke both — resolve by the bar's own direction
      this.htfStructure = hb.close >= hb.open ? 'bullish' : 'bearish';
    } else if (brokeUp) {
      this.htfStructure = 'bullish';
    } else if (brokeDown) {
      this.htfStructure = 'bearish';
    }

    // Mark swings broken by this close
    for (let k = this.htfSwingHighs.length - 1; k >= 0; k--) {
      const s = this.htfSwingHighs[k];
      if (!s.broken && hb.close > s.price) s.broken = true;
    }
    for (let k = this.htfSwingLows.length - 1; k >= 0; k--) {
      const s = this.htfSwingLows[k];
      if (!s.broken && hb.close < s.price) s.broken = true;
    }
  }

  // ---------------------------------------------------------------------
  // Model step (dir = 'short' for M, 'long' for W)
  // ---------------------------------------------------------------------

  _stepModel(dir, ms, candle, idx, closeTs) {
    const p = this.params;
    const isShort = dir === 'short';

    if (ms.state === 'IDLE') {
      // Sweep detection: wick beyond the most recent unbroken confirmed swing
      // extreme and/or PDH/PDL (per sweepLevels).
      const useSwing = p.sweepLevels !== 'pdhpdl';
      const usePd = p.sweepLevels !== 'swing';

      let sweptLevel = null;
      let sweptType = null;

      if (useSwing) {
        const sw = this._lastUnbroken(isShort ? this.swingHighs : this.swingLows);
        if (sw && (isShort ? candle.high > sw.price : candle.low < sw.price)) {
          sweptLevel = sw.price;
          sweptType = 'swing';
        }
      }
      if (usePd) {
        const pd = isShort ? this.pdh : this.pdl;
        if (pd != null && (isShort ? candle.high > pd : candle.low < pd)) {
          // If both swept on this bar, record the more extreme level
          if (sweptLevel === null || (isShort ? pd > sweptLevel : pd < sweptLevel)) {
            sweptLevel = pd;
            sweptType = sweptType ? 'swing+pd' : (isShort ? 'pdh' : 'pdl');
          }
        }
      }

      if (sweptLevel === null) return null;

      // O = most recent confirmed opposing swing ("the low that caused the high")
      const O = this._last(isShort ? this.swingLows : this.swingHighs);
      if (!O) {
        this.gateStats.no_causal_swing++;
        return null;
      }

      ms.state = 'SWEPT';
      ms.sweepBar = idx;
      ms.sweepTs = closeTs;
      ms.sweptLevel = sweptLevel;
      ms.sweptLevelType = sweptType;
      ms.sweepClosedThrough = isShort ? candle.close > sweptLevel : candle.close < sweptLevel;
      ms.O = O;
      ms.extreme = { price: isShort ? candle.high : candle.low, bar: idx };
      if (p.smtMode !== 'off') {
        ms.smt = this._smtStatus(isShort, this.bars[idx].ts);
      }
      this.gateStats[isShort ? 'sweeps_m' : 'sweeps_w']++;

      if (p.debug) {
        console.log(`[JV-ICT] ${new Date(closeTs).toISOString()} ${dir} SWEEP of ${sweptType}@${sweptLevel} (extreme=${ms.extreme.price}, O=${O.price})`);
      }
      return null;
    }

    if (ms.state === 'SWEPT') {
      // Update running extreme (NH for M, NL for W)
      if (isShort ? candle.high > ms.extreme.price : candle.low < ms.extreme.price) {
        ms.extreme = { price: isShort ? candle.high : candle.low, bar: idx };
        // New sweep push: re-evaluate SMT on this bar (final push gates)
        if (p.smtMode !== 'off') {
          ms.smt = this._smtStatus(isShort, this.bars[idx].ts);
        }
      }

      // Re-anchor O (spec A13): a NEWER opposing swing that confirmed since,
      // formed at/before the extreme bar (it must be able to have "caused"
      // the extreme), and on the pullback side of the current O.
      const latestOpp = this._last(isShort ? this.swingLows : this.swingHighs);
      if (latestOpp && latestOpp.bar > ms.O.bar && latestOpp.bar <= ms.extreme.bar &&
          (isShort ? latestOpp.price > ms.O.price : latestOpp.price < ms.O.price)) {
        ms.O = latestOpp;
      }

      // MSS: bar CLOSES beyond O
      const mss = isShort ? candle.close < ms.O.price : candle.close > ms.O.price;
      if (mss) {
        this.gateStats[isShort ? 'mss_m' : 'mss_w']++;
        const signal = this._buildSetup(dir, ms, candle, idx, closeTs);
        // Setup consumed either way — same sweep is never re-traded
        Object.assign(ms, this._freshModelState());
        return signal;
      }

      // Timeout
      if (idx - ms.sweepBar > p.mssTimeoutBars) {
        this.gateStats.mss_timeout++;
        Object.assign(ms, this._freshModelState());
      }
      return null;
    }

    return null;
  }

  // ---------------------------------------------------------------------
  // SHIFTED: build fib/zones, run gates, emit limit order signal
  // ---------------------------------------------------------------------

  _buildSetup(dir, ms, candle, idx, closeTs) {
    const p = this.params;
    const isShort = dir === 'short';
    const b = this.bars;
    const extBar = ms.extreme.bar; // NH.bar (M) / NL.bar (W)

    // Leg = bars [extremeBar .. mssBar]
    let legTerminus = isShort ? Infinity : -Infinity;  // legLow (M) / legHigh (W), wicks
    let legTerminusBar = idx;
    let terminusBody = isShort ? Infinity : -Infinity; // min body (M) / max body (W)
    for (let i = extBar; i <= idx; i++) {
      if (isShort) {
        if (b[i].low < legTerminus) { legTerminus = b[i].low; legTerminusBar = i; }
        if (b[i].bodyLow < terminusBody) terminusBody = b[i].bodyLow;
      } else {
        if (b[i].high > legTerminus) { legTerminus = b[i].high; legTerminusBar = i; }
        if (b[i].bodyHigh > terminusBody) terminusBody = b[i].bodyHigh;
      }
    }

    // Fib anchors, body-to-body (spec §3, pseudocode §5):
    // M: fib100 = bodyHigh(extreme bar), fib0 = min body of leg
    // W: fib100 = bodyLow(extreme bar),  fib0 = max body of leg
    const fib100 = isShort ? b[extBar].bodyHigh : b[extBar].bodyLow;
    const fib0 = terminusBody;
    const range = isShort ? fib100 - fib0 : fib0 - fib100;
    if (range <= 0) {
      this.gateStats.degenerate_leg++;
      return null;
    }
    const level = (pct) => isShort ? fib0 + pct * (fib100 - fib0) : fib0 - pct * (fib0 - fib100);

    // Retest band [50%, 79%] in price terms
    const bandA = level(p.fibBandLow);
    const bandB = level(p.fibBandHigh);
    const bandLow = Math.min(bandA, bandB);
    const bandHigh = Math.max(bandA, bandB);

    // Zones formed within the leg
    const wantImbType = isShort ? 'bearish' : 'bullish';
    const legImbs = this.imbs.filter(z =>
      z.type === wantImbType && z.bar >= extBar && z.bar <= idx
    );
    const overlapImbs = legImbs.filter(z => z.bottom <= bandHigh && z.top >= bandLow);

    // OB: last opposite-close candle before the MSS bar, within the leg
    let ob = null;
    for (let j = idx - 1; j >= extBar; j--) {
      const up = b[j].close > b[j].open;
      if (isShort ? up : (b[j].close < b[j].open)) {
        ob = { low: b[j].low, high: b[j].high, bar: j, ts: b[j].ts };
        break;
      }
    }
    const obOverlaps = ob ? (ob.low <= bandHigh && ob.high >= bandLow) : false;

    // --- Confluence gate ---
    const hasImb = overlapImbs.length > 0;
    let confluenceOk;
    switch (p.confluenceMode) {
      case 'imb': confluenceOk = hasImb; break;
      case 'ob': confluenceOk = obOverlaps; break;
      case 'both': confluenceOk = hasImb && obOverlaps; break;
      case 'none': confluenceOk = true; break;
      case 'either':
      default: confluenceOk = hasImb || obOverlaps; break;
    }
    if (!confluenceOk) {
      this.gateStats.confluence_fail++;
      return null;
    }

    // --- Bias gate (at MSS bar close) ---
    if (p.biasMode === 'dailyOpen') {
      if (this.dailyOpen == null) {
        this.gateStats.bias_warmup++;
        return null;
      }
      const ok = isShort ? candle.close < this.dailyOpen : candle.close > this.dailyOpen;
      if (!ok) {
        this.gateStats.bias_fail++;
        return null;
      }
    } else if (p.biasMode === 'pdhpdl') {
      // Genuine break of the prior day's range in trade direction (book p5:
      // full close through PDL/PDH = real break; interpretation documented).
      const ref = isShort ? this.pdl : this.pdh;
      if (ref == null) {
        this.gateStats.bias_warmup++;
        return null;
      }
      const ok = isShort ? candle.close < ref : candle.close > ref;
      if (!ok) {
        this.gateStats.bias_fail++;
        return null;
      }
    } else if (this._usingHtfBias()) {
      // Book p33 #1: align with 1H (or 4H) structure. Shorts need bearish
      // HTF structure, longs bullish, per the last close-confirmed break.
      if (this.htfStructure === null) {
        this.gateStats.bias_warmup++;
        return null;
      }
      const ok = isShort ? this.htfStructure === 'bearish' : this.htfStructure === 'bullish';
      if (!ok) {
        this.gateStats.bias_fail++;
        return null;
      }
    }

    // --- SMT / pairs gate (evaluated at the final sweep push bar) ---
    if (p.smtMode !== 'off') {
      if (ms.smt === null) {
        this.gateStats.smt_nodata++;
        return null;
      }
      const want = p.smtMode === 'require' ? 'divergent' : 'agree';
      if (ms.smt !== want) {
        this.gateStats.smt_fail++;
        return null;
      }
    }

    // --- Session gate (order placement moment = MSS bar close time, ET) ---
    // entryStartMin/entryEndMin (if set) narrow the EMISSION window within
    // the session; pending-order lifecycle still runs to sessionEndMin.
    const etClose = this.getETTime(closeTs);
    const closeMin = etClose.hour * 60 + etClose.minute;
    const emitStart = Math.max(p.sessionStartMin, p.entryStartMin ?? -Infinity);
    const emitEnd = Math.min(p.sessionEndMin, p.entryEndMin ?? Infinity);
    if (closeMin < emitStart || closeMin >= emitEnd) {
      this.gateStats.session_fail++;
      return null;
    }

    // --- Entry level ---
    let entry;
    let entryMode = p.entryLevel;
    switch (p.entryLevel) {
      case 'discount': entry = level(0.50); break;
      case 'premium': entry = level(0.79); break;
      case 'imbEdge': {
        // Spec A6 default: snap to the IMB proximal edge when a band-
        // overlapping IMB sits deeper than the 70.5% level.
        // M: limit = max(level(.705), max overlapping imb.bottom)
        // W: limit = min(level(.705), min overlapping imb.top)
        entry = level(p.fibEntryPct);
        if (hasImb) {
          if (isShort) {
            const edge = Math.max(...overlapImbs.map(z => z.bottom));
            entry = Math.max(entry, edge);
          } else {
            const edge = Math.min(...overlapImbs.map(z => z.top));
            entry = Math.min(entry, edge);
          }
        }
        break;
      }
      case 'optimal':
      default:
        entry = level(p.fibEntryPct);
        entryMode = 'optimal';
        break;
    }
    entry = roundToTick(entry);

    // Limit must rest on the retracement side of current price
    if (isShort ? entry <= candle.close : entry >= candle.close) {
      this.gateStats.limit_through_price++;
      return null;
    }

    // --- Stop ---
    const buffer = p.stopBufferTicks * TICK;
    const stopLevel = roundToTick(isShort ? ms.extreme.price + buffer : ms.extreme.price - buffer);
    const stopDist = isShort ? stopLevel - entry : entry - stopLevel;
    if (stopDist <= 0 || stopDist > p.maxStopPoints) {
      this.gateStats.stop_too_wide++;
      return null;
    }

    let stopLoss, softStopPoints = 0;
    if (p.stopMode === 'close') {
      // Close-confirmed exit (1m close PnL check via softStopPoints) with a
      // catastrophic wick-based hard stop at N x the structural distance.
      softStopPoints = stopDist;
      stopLoss = roundToTick(isShort
        ? entry + p.closeStopCatastrophicMult * stopDist
        : entry - p.closeStopCatastrophicMult * stopDist);
    } else {
      stopLoss = stopLevel;
    }

    // --- Take profit ---
    let takeProfit = roundToTick(isShort ? legTerminus + TICK : legTerminus - TICK);
    let tpModeUsed = 'legLow';
    if (p.tpMode === 'external') {
      const legHeight = isShort ? ms.extreme.price - legTerminus : legTerminus - ms.extreme.price;
      const candidates = [];
      const swings = isShort ? this.swingLows : this.swingHighs;
      for (const s of swings) {
        if (isShort ? s.price < legTerminus : s.price > legTerminus) candidates.push(s.price);
      }
      const pd = isShort ? this.pdl : this.pdh;
      if (pd != null && (isShort ? pd < entry : pd > entry)) candidates.push(pd);
      // nearest external level beyond the leg terminus, capped at 2x leg height
      const valid = candidates.filter(c =>
        (isShort ? legTerminus - c : c - legTerminus) <= p.externalTpMaxLegMult * legHeight
      );
      if (valid.length > 0) {
        const chosen = isShort ? Math.max(...valid) : Math.min(...valid);
        // only accept if it actually sits beyond price in the profit direction
        if (isShort ? chosen < entry : chosen > entry) {
          takeProfit = roundToTick(chosen);
          tpModeUsed = 'external';
        }
      }
    }
    if (isShort ? takeProfit >= entry : takeProfit <= entry) {
      // degenerate target (can happen if terminus ~ entry); reject
      this.gateStats.degenerate_leg++;
      return null;
    }

    // --- Emit ---
    this.gateStats.signals_emitted++;
    this.updateLastSignalTime(closeTs);

    const ttlMs = p.orderTtlBars * (this.tfMs || 15 * 60 * 1000);

    if (p.debug) {
      console.log(`[JV-ICT] ${new Date(closeTs).toISOString()} ${dir.toUpperCase()} SIGNAL entry=${entry} stop=${stopLoss} tp=${takeProfit} (fib0=${fib0.toFixed(2)} fib100=${fib100.toFixed(2)} imb=${hasImb} ob=${obOverlaps})`);
    }

    return {
      strategy: 'JV_ICT',
      side: isShort ? 'sell' : 'buy',
      action: 'place_limit',
      symbol: p.tradingSymbol,
      price: entry,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      quantity: p.defaultQuantity,
      maxHoldBars: 0,          // no time stop taught; EOD cutoff handles the day
      timeoutCandles: 0,       // TTL handled in shouldInvalidatePendingOrder
      softStopPoints,          // 0 unless stopMode 'close'
      trailing_trigger: null,
      trailing_offset: null,
      timestamp: new Date(closeTs).toISOString(),
      metadata: {
        strategy: 'JV_ICT',
        model: isShort ? 'M' : 'W',
        direction: dir,
        // sweep
        swept_level: ms.sweptLevel,
        swept_level_type: ms.sweptLevelType,
        sweep_ts: new Date(ms.sweepTs).toISOString(),
        sweep_closed_through: ms.sweepClosedThrough,
        // causal swing (O)
        causal_swing_price: ms.O.price,
        causal_swing_ts: new Date(ms.O.ts).toISOString(),
        // extremes / leg
        sweep_extreme: ms.extreme.price,
        sweep_extreme_ts: new Date(b[extBar].ts).toISOString(),
        mss_close_ts: new Date(closeTs).toISOString(),
        mss_close: candle.close,
        leg_terminus: legTerminus,
        leg_terminus_ts: new Date(b[legTerminusBar].ts).toISOString(),
        // fib
        fib0,
        fib100,
        band_low: bandLow,
        band_high: bandHigh,
        entry_level_mode: entryMode,
        entry_pct_price: level(p.fibEntryPct),
        // zones
        imb_overlaps: overlapImbs.map(z => ({ bottom: z.bottom, top: z.top, ts: new Date(z.ts).toISOString() })),
        ob_zone: ob ? { low: ob.low, high: ob.high, ts: new Date(ob.ts).toISOString(), overlaps: obOverlaps } : null,
        // context
        daily_open: this.dailyOpen,
        pdh: this.pdh,
        pdl: this.pdl,
        stop_mode: p.stopMode,
        stop_level_structural: stopLevel,
        stop_distance: stopDist,
        tp_mode: tpModeUsed,
        confluence_mode: p.confluenceMode,
        bias_mode: p.biasMode,
        htf_structure: this._usingHtfBias() ? this.htfStructure : null,
        smt_mode: p.smtMode,
        smt_status: p.smtMode !== 'off' ? ms.smt : null,
        // cancellation bookkeeping (read by shouldInvalidatePendingOrder)
        jv_cancel: {
          dir,
          extreme: ms.extreme.price,
          legTerminus,
          placedCloseTs: closeTs,
          ttlMs,
          placedDayKey: this.curDayKey
        }
      }
    };
  }

  // ---------------------------------------------------------------------
  // Placebo emission (research-only; see _initPlacebo)
  // ---------------------------------------------------------------------

  _placeboStep(candle, closeTs) {
    const p = this.params;
    const et = this.getETTime(closeTs);
    const closeMin = et.hour * 60 + et.minute;
    // Same emission window as the real strategy's session gate
    if (closeMin < p.sessionStartMin || closeMin >= p.sessionEndMin) return null;
    const list = this.placeboSchedule.get(et.dateKey);
    if (!list) return null;

    for (const e of list) {
      if (e.fired || e.m > closeMin) continue;
      e.fired = true; // consumed whether or not the guard passes (mirrors real gate consumption)

      const isShort = e.side === 'short';
      const entry = roundToTick(isShort ? candle.close + e.off : candle.close - e.off);
      // Limit must rest on the retracement side of current price (same guard as real)
      if (isShort ? entry <= candle.close : entry >= candle.close) {
        this.placeboStats.skipped_guard++;
        continue;
      }
      const stopLoss = roundToTick(isShort ? entry + e.stop : entry - e.stop);
      const takeProfit = roundToTick(isShort ? entry - e.tp : entry + e.tp);
      // Synthesized cancel anchors, inverse of the real construction:
      // real long: stop = extreme - buffer, TP = legTerminus - tick
      const buffer = p.stopBufferTicks * TICK;
      const extreme = isShort ? stopLoss - buffer : stopLoss + buffer;
      const legTerminus = isShort ? takeProfit - TICK : takeProfit + TICK;
      const ttlMs = p.orderTtlBars * (this.tfMs || 15 * 60 * 1000);

      this.placeboStats.emitted++;
      this.updateLastSignalTime(closeTs);
      if (p.debug) {
        console.log(`[JV-ICT placebo] ${new Date(closeTs).toISOString()} ${e.side} entry=${entry} stop=${stopLoss} tp=${takeProfit} (cat#${e.idx} m=${e.m})`);
      }

      return {
        strategy: 'JV_ICT',
        side: isShort ? 'sell' : 'buy',
        action: 'place_limit',
        symbol: p.tradingSymbol,
        price: entry,
        stop_loss: stopLoss,
        take_profit: takeProfit,
        quantity: p.defaultQuantity,
        maxHoldBars: 0,
        timeoutCandles: 0,
        softStopPoints: 0,
        trailing_trigger: null,
        trailing_offset: null,
        timestamp: new Date(closeTs).toISOString(),
        metadata: {
          strategy: 'JV_ICT',
          placebo: true,
          placebo_seed: p.placeboSeed,
          placebo_catalog_idx: e.idx,
          placebo_m: e.m,
          model: isShort ? 'M' : 'W',
          direction: e.side,
          off: e.off,
          stop_distance: e.stop,
          tp_distance: e.tp,
          jv_cancel: {
            dir: e.side,
            extreme,
            legTerminus,
            placedCloseTs: closeTs,
            ttlMs,
            placedDayKey: this.curDayKey
          }
        }
      };
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Engine hooks
  // ---------------------------------------------------------------------

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const ts = this.toMs(candle.timestamp);

    // Infer run-TF duration from bar spacing (min positive diff)
    const prev = this._last(this.bars);
    if (prev) {
      const diff = ts - prev.ts;
      if (diff > 0 && (this.tfMs === null || diff < this.tfMs)) this.tfMs = diff;
    }

    const closeTs = ts + (this.tfMs || 15 * 60 * 1000);

    // 1. Daily / session context (uses bar START time for day-keying)
    this._updateDaily(candle, ts);

    // 2. Append bar
    const idx = this.bars.length;
    this.bars.push({
      ts,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      bodyHigh: Math.max(candle.open, candle.close),
      bodyLow: Math.min(candle.open, candle.close)
    });

    // PLACEBO branch: bypass all structure logic, replay scheduled geometry.
    if (this.params.placeboMode) {
      return this._placeboStep(candle, closeTs);
    }

    // 3. Confirm pivots (lag pivotN) — usable this same close per spec
    this._updatePivots(idx);

    // 4. IMB creation/consumption
    this._updateImbs(idx);

    // 4a. SMT: consume ES bars fully closed at this run-TF close
    if (this.params.smtMode !== 'off') {
      this._updateSmt(closeTs);
    }

    // 4b. HTF structure (only when an HTF bias mode is active). Uses only
    //     HTF bars fully closed at this run-TF close — no in-progress bar
    //     ever influences a decision.
    if (this._usingHtfBias()) {
      this._updateHtf(candle, ts, closeTs);
    }

    // 5. Model steps (levels' broken-state is as of the PRIOR close; the
    //    broken-marking for THIS close runs after, so close-through sweeps
    //    still see their level)
    let signal = null;
    if (this.params.allowShorts) {
      signal = this._stepModel('short', this.mState, candle, idx, closeTs);
    }
    if (this.params.allowLongs) {
      const wSignal = this._stepModel('long', this.wState, candle, idx, closeTs);
      if (wSignal && !signal) {
        signal = wSignal;
      } else if (wSignal && signal) {
        // Single position slot: deterministic M-first; W setup discarded
        this.gateStats.both_models_same_bar++;
      }
    }

    // 6. Mark swings broken by this bar's close
    this._markBrokenSwings(candle);

    return signal;
  }

  /**
   * Pre-fill invalidation, evaluated once per closed run-TF candle:
   *  (a) close beyond the sweep extreme (setup invalidated)
   *  (b) close beyond the leg terminus before fill (retest never came)
   *  (c) TTL expiry
   *  (d) session end / trading-day rollover
   */
  shouldInvalidatePendingOrder(signal, candle /*, historicalCandles */) {
    const jc = signal?.metadata?.jv_cancel;
    if (!jc) return null;

    const ts = this.toMs(candle.timestamp);
    const closeTs = ts + (this.tfMs || 15 * 60 * 1000);
    const isShort = jc.dir === 'short';

    // (a) close beyond sweep extreme
    if (isShort ? candle.close > jc.extreme : candle.close < jc.extreme) {
      return { shouldCancel: true, reason: 'close_beyond_sweep_extreme' };
    }
    // (b) close beyond leg terminus pre-fill
    if (isShort ? candle.close < jc.legTerminus : candle.close > jc.legTerminus) {
      return { shouldCancel: true, reason: 'close_beyond_leg_terminus' };
    }
    // (c) TTL
    if (closeTs - jc.placedCloseTs >= jc.ttlMs) {
      return { shouldCancel: true, reason: 'order_ttl_expired' };
    }
    // (d) session end (15:30 ET) or day rollover
    const et = this.getETTime(closeTs);
    const closeMin = et.hour * 60 + et.minute;
    if (closeMin >= this.params.sessionEndMin && closeMin < 18 * 60) {
      return { shouldCancel: true, reason: 'session_end' };
    }
    if (this.curDayKey !== jc.placedDayKey) {
      return { shouldCancel: true, reason: 'day_rollover' };
    }
    return null;
  }

  _printGateStats(label) {
    console.log(`[JV-ICT gates @ ${label}] ${JSON.stringify(this.gateStats)}`);
  }

  getGateStats() {
    return { ...this.gateStats };
  }

  reset() {
    super.reset();
    this._initState();
    if (this.params.placeboMode) this._initPlacebo();
    if (this.params.smtMode !== 'off') this._initSmt();
  }

  getName() { return 'JV_ICT'; }
  getDescription() {
    return 'JV-ICT - M/W liquidity sweep -> structure shift -> fib/zone retest limit entries (JV Trading "Unlock The Market")';
  }
  getRequiredMarketData() { return []; }
}

export default JvIctStrategy;
