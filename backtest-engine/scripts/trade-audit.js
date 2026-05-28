#!/usr/bin/env node
/**
 * Trade-signal audit pipeline.
 *
 * Replays a list of trade signals (typically a dashboard export of rejected
 * or accepted signals from a given day) against historical 1m OHLCV to
 * estimate how the signals would have performed if executed. Pulls candles
 * either from the production monitoring-service or a local JSON file.
 *
 * Usage:
 *   node scripts/trade-audit.js --signals <path> --date YYYY-MM-DD \
 *     [--symbol NQ] [--output <path>] \
 *     [--candles <path> | --prod-url <url> --token <token>] \
 *     [--fill-timeout-min 5] [--include-rejected]
 *
 * Examples:
 *   # Pull candles from production, audit today's signals
 *   node scripts/trade-audit.js \
 *     --signals /mnt/c/temp/signals\ 5-20.txt --date 2026-05-20 \
 *     --prod-url https://monitoring-service-7p2i9.sevalla.app \
 *     --token $DASHBOARD_TOKEN
 *
 *   # Re-run an audit using cached candles
 *   node scripts/trade-audit.js \
 *     --signals /mnt/c/temp/signals\ 5-20.txt --date 2026-05-20 \
 *     --candles /tmp/nq-1m-5-20.json
 *
 * Output: prints summary table to stdout and writes per-trade JSON to
 * --output (default /tmp/trade-audit-<date>.json).
 *
 * Fill simulation:
 *   - LIMIT orders fill on the first 1m bar (within fill-timeout-min from
 *     signal time) where the bar's range crosses the limit price.
 *     BUY: low <= entry; SELL: high >= entry. Fill price = entry exactly.
 *   - Once filled, walk forward 1m bars starting at bar+1. First side to
 *     hit (stop or target) wins. The fill bar itself is NOT checked for
 *     stop/target to avoid same-bar ambiguity (mirrors the conservative
 *     reading the engine uses with 1m-only data).
 *   - Same-bar SL+TP collision after fill is marked AMBIGUOUS and resolved
 *     conservatively (SL first) — the report flags these so you can re-run
 *     with 1s data on the ambiguous trades if you need precision.
 *   - Max-hold per strategy from STRATEGY_DEFAULTS (or --max-hold-min global
 *     override).
 *
 * Strategy defaults reflect the W12 / v8 / tight-stop / 100-18 production
 * configs documented in CLAUDE.md. Override per-strategy via STRATEGY_DEFAULTS
 * map below if running against an older or experimental rule set.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const POINT_VALUE = 20; // NQ = $20/pt

// Per-strategy fill-timeout and max-hold conventions. The signal payload
// doesn't always carry these (they live in strategy config), so we apply
// defaults that match the documented production configs.
//
// Keyed primarily by "STRATEGY:ruleId" — the prod /api/alerts payload
// separates these fields. Falls back to "STRATEGY" if no rule-specific
// entry exists, then to DEFAULT_FALLBACK.
const STRATEGY_DEFAULTS = {
  // gex-lt-3m-crossover: 5-min limit timeout, max-hold varies per rule.
  'GEX_LT_3M_CROSSOVER:S_GF_SOLO': { fillTimeoutMin: 5, maxHoldMin: 90 },
  'GEX_LT_3M_CROSSOVER:S_CW':      { fillTimeoutMin: 5, maxHoldMin: 90 },
  'GEX_LT_3M_CROSSOVER:S_R4':      { fillTimeoutMin: 5, maxHoldMin: 60 },
  'GEX_LT_3M_CROSSOVER:L_S4':      { fillTimeoutMin: 5, maxHoldMin: 90 },
  'GEX_LT_3M_CROSSOVER':           { fillTimeoutMin: 5, maxHoldMin: 90 },
  // gex-flip-ivpct: tight-stop config, 600-min max hold (10h), eod cutoff 15:45.
  'GEX_FLIP_IVPCT': { fillTimeoutMin: 5, maxHoldMin: 600 },
  // gex-level-fade: 1-bar limit timeout, 180-min max hold.
  'GEX_LEVEL_FADE': { fillTimeoutMin: 1, maxHoldMin: 180 },
  // ls-flip-trigger-bar: 10-min limit timeout, 60-min max hold.
  'LS_FLIP_TRIGGER_BAR': { fillTimeoutMin: 10, maxHoldMin: 60 },
};

const DEFAULT_FALLBACK = { fillTimeoutMin: 5, maxHoldMin: 90 };

// Per-strategy DYNAMIC EXIT presets (BE/trail) reflecting the production-deployed
// configurations as of 2026-05-21:
//   GLF=v2, GFI=v2, GLX=v3, LSTB=v3 (candJ).
// Sources of truth: signal-generator/src/utils/config.js PRESETS maps.
// Keyed by "STRATEGY:ruleId" with fallback to "STRATEGY".
// Fields are in POINTS (NQ). Null = disabled.
//   - beTrigger / beOffset: when MFE >= beTrigger pts, move stop to entry +/- beOffset
//     (offset is "in profit" direction).
//   - trailTrigger / trailOffset: when MFE >= trailTrigger pts, start trailing stop at
//     (current best extreme) - trailOffset for LONG, + for SHORT.
// NOTE: This script does NOT simulate LS-BE-on-flip overlays or fib-retrace exits
// (those require LS 1m state data and per-bar MFE-trajectory data not in the audit
// pipeline). The dominant deployed dynamic is BE, which is captured here.
const DYNAMIC_EXIT_PRESETS = {
  'GEX_LEVEL_FADE':                 { beTrigger: 100, beOffset: 10, trailTrigger: null, trailOffset: null },
  'GEX_FLIP_IVPCT':                 { beTrigger: 160, beOffset: 10, trailTrigger: null, trailOffset: null },
  'GEX_LT_3M_CROSSOVER:S_CW':       { beTrigger: 80,  beOffset: 20, trailTrigger: null, trailOffset: null },
  'GEX_LT_3M_CROSSOVER:S_GF_SOLO':  { beTrigger: 80,  beOffset: 20, trailTrigger: null, trailOffset: null },
  'GEX_LT_3M_CROSSOVER:L_S4':       { beTrigger: 70,  beOffset: 20, trailTrigger: null, trailOffset: null },
  'GEX_LT_3M_CROSSOVER:S_R4':       { beTrigger: null,beOffset: 0,  trailTrigger: 70,   trailOffset: 25   },
  'GEX_LT_3M_CROSSOVER':            { beTrigger: 80,  beOffset: 20, trailTrigger: null, trailOffset: null }, // fallback
  'LS_FLIP_TRIGGER_BAR':            { beTrigger: 8,   beOffset: 2,  trailTrigger: null, trailOffset: null },
};
const NO_DYNAMIC = { beTrigger: null, beOffset: 0, trailTrigger: null, trailOffset: 0 };

function resolveDynamicExits(strategy, ruleId) {
  if (ruleId && DYNAMIC_EXIT_PRESETS[`${strategy}:${ruleId}`]) {
    return DYNAMIC_EXIT_PRESETS[`${strategy}:${ruleId}`];
  }
  return DYNAMIC_EXIT_PRESETS[strategy] || NO_DYNAMIC;
}

function resolveDefaults(strategy, ruleId) {
  if (ruleId && STRATEGY_DEFAULTS[`${strategy}:${ruleId}`]) {
    return STRATEGY_DEFAULTS[`${strategy}:${ruleId}`];
  }
  if (STRATEGY_DEFAULTS[strategy]) return STRATEGY_DEFAULTS[strategy];
  // Legacy text-format fallback (mashed strategy+ruleId): try prefix match
  for (const key of Object.keys(STRATEGY_DEFAULTS)) {
    if (strategy.startsWith(key.replace(':', ''))) return STRATEGY_DEFAULTS[key];
  }
  return DEFAULT_FALLBACK;
}

// EOD cutoff (per production env) — force-flat any open position at this ET time.
const EOD_CUTOFF_ET = '15:45';

// --------------------------- CLI parsing ---------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    }
  }
  return args;
}

function usage() {
  console.error('Usage: node scripts/trade-audit.js --date YYYY-MM-DD [options]');
  console.error('Signal source (one of):');
  console.error('  --signals <path>            text export from dashboard Alerts panel');
  console.error('  --alerts-from-prod          pull /api/alerts from monitoring-service (recommended)');
  console.error('  --alerts <path>             JSON file with /api/alerts payload');
  console.error('Candle source (one required):');
  console.error('  --candles <path>            cached candles JSON');
  console.error('  --prod-url <url> --token <token>   pull from monitoring-service');
  console.error('Other:');
  console.error('  --symbol NQ                 (default: NQ)');
  console.error('  --output <path>             (default: /tmp/trade-audit-<date>.json)');
  console.error('  --candle-count N            bars to fetch from prod (default 400)');
  console.error('  --fill-timeout-min N        override default fill timeout for all signals');
  console.error('  --max-hold-min N            override default max-hold for all signals');
  console.error('  --include-rejected          include REJECTED-severity alerts (default: true)');
  console.error('  --strategy <name>           filter to a single strategy constant');
  console.error('  --allow-parallel            disable the 1-position-at-a-time-per-strategy gate');
  console.error('                              (default: enforce — matches live orchestrator)');
  console.error('  --static-exits              disable BE/trail dynamic exits (legacy walk)');
  console.error('                              (default: simulate deployed v2/v3 BE/trail presets)');
  process.exit(2);
}

// --------------------------- Signals parsing ---------------------------

/**
 * Parse the dashboard-export signals format (legacy text):
 *   REJECTED
 *   12:55:00
 *   x
 *   GEX_LT_3M_CROSSOVERS_GF_SOLOSHORT@ 29268.75TP 29208.75 (+60pt)SL 29318.75 (-50pt)Resend
 *
 * Returns an array of normalized signal objects.
 */
function parseSignalsText(rawText, { includeRejected = true } = {}) {
  const lines = rawText.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].trim();
    if (L !== 'REJECTED' && L !== 'ACCEPTED' && L !== 'FILLED') continue;
    const status = L;
    if (status === 'REJECTED' && !includeRejected) continue;
    const time = lines[i + 1]?.trim();
    const body = lines[i + 3]?.trim();
    if (!time || !body) continue;
    const sideMatch = body.match(/(SHORT|LONG)@/);
    if (!sideMatch) continue;
    const side = sideMatch[1];
    const m = body.match(/@ ([\d.]+)TP ([\d.]+)(?:.*?)SL ([\d.]+)/);
    if (!m) continue;
    const entry = parseFloat(m[1]);
    const tp = parseFloat(m[2]);
    const sl = parseFloat(m[3]);
    const strategy = body.slice(0, body.indexOf(side));
    out.push({ time, status, strategy, ruleId: null, side, entry, tp, sl, source: 'text',
      tpPts: side === 'SHORT' ? entry - tp : tp - entry,
      slPts: side === 'SHORT' ? sl - entry : entry - sl,
      timestampUtc: null,
    });
  }
  return out;
}

/**
 * Normalize an alert from monitoring-service /api/alerts JSON into the
 * common signal shape. Format:
 *   {
 *     ruleName: 'rejected',
 *     severity: 'rejected'|'accepted'|...,
 *     signal: { strategy, symbol, side, action, price, stop_loss, take_profit, ruleId, ... },
 *     timestamp: ISO,
 *   }
 */
function parseSignalsJson(alerts, { includeRejected = true, dateFilter } = {}) {
  const out = [];
  for (const a of alerts) {
    const s = a.signal || {};
    if (!s.strategy || !s.side || s.price == null) continue;
    if (a.severity === 'rejected' && !includeRejected) continue;
    if (dateFilter && !String(a.timestamp).startsWith(dateFilter)) continue;
    const side = String(s.side).toUpperCase();
    if (side !== 'LONG' && side !== 'SHORT' && side !== 'BUY' && side !== 'SELL') continue;
    const normSide = (side === 'BUY' || side === 'LONG') ? 'LONG' : 'SHORT';
    const ts = new Date(a.timestamp);
    const time = ts.toLocaleTimeString('en-US', {
      timeZone: ET_TZ, hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const entry = parseFloat(s.price);
    const tp = parseFloat(s.take_profit);
    const sl = parseFloat(s.stop_loss);
    out.push({
      time, status: (a.severity || 'unknown').toUpperCase(),
      strategy: s.strategy, ruleId: s.ruleId || null,
      side: normSide, entry, tp, sl,
      source: 'prod-api',
      tpPts: normSide === 'SHORT' ? entry - tp : tp - entry,
      slPts: normSide === 'SHORT' ? sl - entry : entry - sl,
      timestampUtc: ts.getTime(),
      _alert: a,
    });
  }
  return out;
}

async function fetchAlerts({ prodUrl, token, date, useHistorical }) {
  if (!prodUrl || !token) throw new Error('prod URL and credentials required to pull alerts (see --help)');
  const base = prodUrl.replace(/\/$/, '');
  const url = useHistorical
    ? `${base}/api/alerts/historical?date=${date}`
    : `${base}/api/alerts`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`monitoring-service alerts HTTP ${res.status} (${url}): ${body.slice(0, 200)}`);
  }
  return await res.json();
}

// --------------------------- Candle fetch ---------------------------

async function fetchCandles({ prodUrl, token, symbol, count, date, useHistorical }) {
  if (!prodUrl || !token) {
    throw new Error('prod URL and credentials are required when --candles is not provided (see --help)');
  }
  const base = prodUrl.replace(/\/$/, '');
  // Use the date-keyed archive when the requested date isn't today (ET).
  // Today's audit can still hit the historical endpoint — bars accumulate
  // there throughout the session — but the live ring buffer is also fine.
  const url = useHistorical
    ? `${base}/api/candles/historical?symbol=${encodeURIComponent(symbol)}&date=${date}`
    : `${base}/api/candles?symbol=${encodeURIComponent(symbol)}&count=${count || 400}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`monitoring-service candles HTTP ${res.status} (${url}): ${body.slice(0, 200)}`);
  }
  return await res.json();
}

function loadCandlesFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// --------------------------- Audit core ---------------------------

const ET_TZ = 'America/New_York';

/**
 * Convert a HH:MM:SS ET wall-clock string + a YYYY-MM-DD date into a UTC
 * epoch millis. Uses Intl to resolve the ET offset (handles DST).
 */
function etTimeToUtcMs(dateStr, timeStr) {
  // Build a date with arbitrary "as if UTC" anchor, then subtract the ET
  // offset to get true UTC. Easier: construct via UTC string and find the
  // offset that, when added, makes the resulting Intl-formatted ET match.
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm, ss = 0] = timeStr.split(':').map(Number);
  // We want a Date whose ET wall clock = (y-m-d hh:mm:ss). Strategy:
  // start with a candidate UTC = the same year/month/day/h/m/s, then adjust
  // by the ET offset at that instant.
  const candidate = Date.UTC(y, m - 1, d, hh, mm, ss);
  // Figure out what ET hour that UTC instant maps to.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(candidate));
  const get = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  const etY = get('year'), etM = get('month'), etD = get('day');
  const etH = get('hour'), etMin = get('minute'), etS = get('second');
  const etAsUtc = Date.UTC(etY, etM - 1, etD, etH, etMin, etS);
  const offsetMs = candidate - etAsUtc;
  return candidate + offsetMs;
}

function etHHMMtoUtcMs(dateStr, hhmm) {
  return etTimeToUtcMs(dateStr, hhmm + ':00');
}

/**
 * Run the fill+exit simulation for a single signal against the 1m bar array.
 * bars is sorted by timestamp ascending. timestamps are millis (number).
 */
function auditOneSignal(signal, bars, dateStr, opts) {
  const defaults = resolveDefaults(signal.strategy, signal.ruleId);
  const fillTimeoutMin = opts.fillTimeoutMin ?? defaults.fillTimeoutMin;
  const maxHoldMin = opts.maxHoldMin ?? defaults.maxHoldMin;
  const eodCutoffUtc = etHHMMtoUtcMs(dateStr, EOD_CUTOFF_ET);

  // Use the ISO timestamp from prod alerts if available, otherwise derive
  // from the ET wall-clock string in the dashboard text export.
  const signalUtc = signal.timestampUtc ?? etTimeToUtcMs(dateStr, signal.time);
  // Signal fires at bar close (the strategy's signal.timestamp = candle.timestamp + 1m).
  // Fill window opens at the NEXT 1m bar.
  const fillWindowStart = signalUtc;
  const fillWindowEnd = signalUtc + fillTimeoutMin * 60_000;

  let fillBarIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.ts < fillWindowStart) continue;
    if (b.ts >= fillWindowEnd) break;
    const filled = signal.side === 'SHORT'
      ? b.high >= signal.entry
      : b.low <= signal.entry;
    if (filled) { fillBarIdx = i; break; }
  }
  if (fillBarIdx === -1) {
    return { ...signal, outcome: 'no_fill', signalUtc, exitReason: 'no_fill',
      fillTime: null, exitTime: null, exitPrice: null,
      pnlPts: 0, pnlDollars: 0, ambiguous: false };
  }

  const fillBar = bars[fillBarIdx];
  const maxHoldEndUtc = Math.min(fillBar.ts + maxHoldMin * 60_000, eodCutoffUtc);

  // Dynamic exit setup. Set opts.staticExits = true to disable (legacy walk).
  const dyn = opts.staticExits ? NO_DYNAMIC : resolveDynamicExits(signal.strategy, signal.ruleId);
  const isShort = signal.side === 'SHORT';
  let currentStop = signal.sl;
  let beActive = false;
  let trailActive = false;
  let bestExtreme = signal.entry; // running max-favorable price reached
  // MFE in points, always positive when in-profit.
  const mfeFromPrice = (price) => isShort ? (signal.entry - price) : (price - signal.entry);

  // Walk forward starting from the bar AFTER fill — fill bar itself can't
  // be evaluated for stop/target with 1m precision (we don't know if the
  // limit filled before or after the bar's high/low extremes).
  for (let i = fillBarIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.ts >= maxHoldEndUtc) {
      // Max-hold / EOD cutoff hit before SL or TP.
      const reason = b.ts >= eodCutoffUtc ? 'eod_cutoff' : 'max_hold';
      const exitPrice = b.open;
      const pnlPts = isShort ? signal.entry - exitPrice : exitPrice - signal.entry;
      return { ...signal, outcome: reason, signalUtc, exitReason: reason,
        fillTime: fillBar.ts, exitTime: b.ts, exitPrice,
        pnlPts, pnlDollars: pnlPts * POINT_VALUE, ambiguous: false,
        finalStop: currentStop, beActivated: beActive, trailActivated: trailActive };
    }

    // Intrabar MFE for this bar (favorable extreme).
    const barFavorableExtreme = isShort ? b.low : b.high;
    const barMfe = mfeFromPrice(barFavorableExtreme);

    // Will BE / trail activate intrabar on this bar? Compute pre-stop check
    // so a same-bar MFE-trigger + (old-stop hit) becomes a same-bar BE-protected hit.
    const beTriggeredThisBar = !beActive && dyn.beTrigger !== null && barMfe >= dyn.beTrigger;
    const trailTriggeredThisBar = !trailActive && dyn.trailTrigger !== null && barMfe >= dyn.trailTrigger;

    // Compute the effective stop FOR THIS BAR given intrabar BE/trail activation.
    // Optimistic intrabar model: assumes MFE was reached before the bar's pullback
    // to stop (matches live tick-level orchestrator behavior). Flag the case where
    // BOTH the old stop AND BE-triggered-MFE were touched on the same bar.
    let effectiveStop = currentStop;
    let intrabarBeAmbiguous = false;
    if (beTriggeredThisBar) {
      const beStop = isShort ? signal.entry - dyn.beOffset : signal.entry + dyn.beOffset;
      // Only TIGHTEN the stop (never widen it).
      const tighter = isShort ? Math.min(beStop, currentStop) : Math.max(beStop, currentStop);
      // Ambiguity check: would the OLD stop have hit on this bar?
      const oldStopHitThisBar = isShort ? b.high >= currentStop : b.low <= currentStop;
      if (oldStopHitThisBar) intrabarBeAmbiguous = true;
      effectiveStop = tighter;
    }
    if (trailTriggeredThisBar || trailActive) {
      // Trail anchors to running best extreme INCLUDING this bar's intrabar extreme.
      const updatedExtreme = isShort
        ? Math.min(bestExtreme, barFavorableExtreme)
        : Math.max(bestExtreme, barFavorableExtreme);
      const trailStop = isShort ? updatedExtreme + dyn.trailOffset : updatedExtreme - dyn.trailOffset;
      effectiveStop = isShort ? Math.min(trailStop, effectiveStop) : Math.max(trailStop, effectiveStop);
    }

    // Evaluate hits with the bar-effective stop.
    const slHit = isShort ? b.high >= effectiveStop : b.low <= effectiveStop;
    const tpHit = isShort ? b.low <= signal.tp : b.high >= signal.tp;

    if (slHit && tpHit) {
      // Same-bar SL+TP — conservative SL-first.
      const pnlPts = isShort ? signal.entry - effectiveStop : effectiveStop - signal.entry;
      const reason = beTriggeredThisBar ? 'breakeven_stop' : (trailActive || trailTriggeredThisBar ? 'trail_stop' : 'stop_loss');
      return { ...signal, outcome: reason, signalUtc, exitReason: reason,
        fillTime: fillBar.ts, exitTime: b.ts, exitPrice: effectiveStop,
        pnlPts, pnlDollars: pnlPts * POINT_VALUE, ambiguous: true,
        finalStop: effectiveStop, beActivated: beTriggeredThisBar || beActive,
        trailActivated: trailTriggeredThisBar || trailActive,
        intrabarBeAmbiguous };
    }
    if (slHit) {
      const pnlPts = isShort ? signal.entry - effectiveStop : effectiveStop - signal.entry;
      const reason = (beTriggeredThisBar || beActive) && effectiveStop !== signal.sl
        ? 'breakeven_stop'
        : (trailActive || trailTriggeredThisBar) && effectiveStop !== signal.sl
          ? 'trail_stop'
          : 'stop_loss';
      return { ...signal, outcome: reason, signalUtc, exitReason: reason,
        fillTime: fillBar.ts, exitTime: b.ts, exitPrice: effectiveStop,
        pnlPts, pnlDollars: pnlPts * POINT_VALUE, ambiguous: false,
        finalStop: effectiveStop, beActivated: beTriggeredThisBar || beActive,
        trailActivated: trailTriggeredThisBar || trailActive,
        intrabarBeAmbiguous };
    }
    if (tpHit) {
      const pnlPts = Math.abs(signal.tp - signal.entry);
      return { ...signal, outcome: 'take_profit', signalUtc, exitReason: 'take_profit',
        fillTime: fillBar.ts, exitTime: b.ts, exitPrice: signal.tp,
        pnlPts, pnlDollars: pnlPts * POINT_VALUE, ambiguous: false,
        finalStop: effectiveStop, beActivated: beTriggeredThisBar || beActive,
        trailActivated: trailTriggeredThisBar || trailActive };
    }

    // Bar survived. Commit BE/trail activations and update running extreme.
    if (beTriggeredThisBar) {
      beActive = true;
      currentStop = effectiveStop;
    }
    if (trailTriggeredThisBar) trailActive = true;
    if (trailActive) {
      bestExtreme = isShort
        ? Math.min(bestExtreme, barFavorableExtreme)
        : Math.max(bestExtreme, barFavorableExtreme);
      const trailStop = isShort ? bestExtreme + dyn.trailOffset : bestExtreme - dyn.trailOffset;
      currentStop = isShort ? Math.min(trailStop, currentStop) : Math.max(trailStop, currentStop);
    }
  }
  // Ran out of bars before a resolution — partial data.
  const lastBar = bars[bars.length - 1];
  return { ...signal, outcome: 'data_truncated', signalUtc, exitReason: 'data_truncated',
    fillTime: fillBar.ts, exitTime: lastBar.ts, exitPrice: lastBar.close,
    pnlPts: signal.side === 'SHORT' ? signal.entry - lastBar.close : lastBar.close - signal.entry,
    pnlDollars: 0, ambiguous: false,
    finalStop: currentStop, beActivated: beActive, trailActivated: trailActive };
}

// --------------------------- Reporting ---------------------------

function fmtTime(ms) {
  if (ms == null) return '—';
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: ET_TZ, hour12: false, hour: '2-digit', minute: '2-digit',
  });
}
function fmtDollars(d) {
  const s = d >= 0 ? '+' : '-';
  return `${s}$${Math.abs(d).toFixed(0)}`;
}

function summarize(results) {
  const total = results.length;
  const skipped = results.filter(r => r.outcome === 'skipped_position_active').length;
  const filled = results.filter(r => r.outcome !== 'no_fill' && r.outcome !== 'skipped_position_active').length;
  // "Wins" = profitable closes (take_profit, plus BE/trail exits that happened
  // to land in profit). "Losses" = unprofitable closes (stop_loss, plus BE/trail
  // exits that landed at-or-below entry). Counts trade PnL sign, not exit kind.
  const wins = results.filter(r => r.pnlDollars > 0).length;
  const losses = results.filter(r => r.pnlDollars < 0).length;
  const ambiguous = results.filter(r => r.ambiguous).length;
  const noFill = results.filter(r => r.outcome === 'no_fill').length;
  const beStops = results.filter(r => r.outcome === 'breakeven_stop').length;
  const trailStops = results.filter(r => r.outcome === 'trail_stop').length;
  const intrabarBeAmb = results.filter(r => r.intrabarBeAmbiguous).length;
  const sumPnL = results.reduce((s, r) => s + r.pnlDollars, 0);
  const sumPts = results.reduce((s, r) => s + r.pnlPts, 0);
  const gross = results.reduce((acc, r) => {
    if (r.pnlDollars > 0) acc.gp += r.pnlDollars;
    else if (r.pnlDollars < 0) acc.gl += Math.abs(r.pnlDollars);
    return acc;
  }, { gp: 0, gl: 0 });
  const pf = gross.gl > 0 ? gross.gp / gross.gl : (gross.gp > 0 ? Infinity : 0);
  const wr = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
  return { total, skipped, filled, wins, losses, ambiguous, noFill,
    beStops, trailStops, intrabarBeAmb, sumPts, sumPnL, pf, wr };
}

function printResults(results, dateStr, candleRange) {
  console.log(`\n=== Trade-Signal Audit ${dateStr} (1m bars, ${candleRange}) ===\n`);

  console.log('PER-TRADE OUTCOMES:');
  const widths = [7, 22, 11, 6, 9, 9, 9, 6, 6, 14, 9];
  const hdr = ['time','strategy','rule','side','entry','tp','sl','fill','exit','reason','pnl ($)'];
  console.log(hdr.map((h, i) => h.padEnd(widths[i])).join(''));
  console.log('-'.repeat(widths.reduce((a, b) => a + b, 0)));
  for (const r of results) {
    const row = [
      r.time.slice(0, 5),
      r.strategy.slice(0, 22),
      (r.ruleId || '').slice(0, 11),
      r.side,
      String(r.entry),
      String(r.tp),
      String(r.sl),
      fmtTime(r.fillTime),
      fmtTime(r.exitTime),
      r.exitReason + (r.ambiguous ? '*' : ''),
      fmtDollars(r.pnlDollars),
    ];
    console.log(row.map((c, i) => String(c).padEnd(widths[i])).join(''));
  }

  console.log('\nPER-STRATEGY ROLLUP:');
  const byStrat = {};
  for (const r of results) {
    const key = r.ruleId ? `${r.strategy}:${r.ruleId}` : r.strategy;
    if (!byStrat[key]) byStrat[key] = [];
    byStrat[key].push(r);
  }
  console.log('strategy'.padEnd(36), 'n'.padStart(4), 'fill'.padStart(5), 'wr'.padStart(7), 'pf'.padStart(6), 'sum$'.padStart(10), 'amb'.padStart(4));
  for (const [name, arr] of Object.entries(byStrat)) {
    const s = summarize(arr);
    const pfStr = isFinite(s.pf) ? s.pf.toFixed(2) : '∞';
    console.log(
      name.slice(0, 36).padEnd(36),
      String(s.total).padStart(4),
      String(s.filled).padStart(5),
      (s.wr.toFixed(1) + '%').padStart(7),
      pfStr.padStart(6),
      fmtDollars(s.sumPnL).padStart(10),
      String(s.ambiguous).padStart(4),
    );
  }

  console.log('\nTOTAL:');
  const t = summarize(results);
  const pfStr = isFinite(t.pf) ? t.pf.toFixed(2) : '∞';
  console.log(`  signals: ${t.total}  filled: ${t.filled}  no-fill: ${t.noFill}  skipped (slot busy): ${t.skipped}  ambiguous: ${t.ambiguous}`);
  console.log(`  wins: ${t.wins}  losses: ${t.losses}  WR: ${t.wr.toFixed(1)}%  PF: ${pfStr}`);
  console.log(`  net PnL: ${fmtDollars(t.sumPnL)}  (${t.sumPts.toFixed(1)} pts × $${POINT_VALUE}/pt)`);
  if (t.beStops > 0 || t.trailStops > 0) {
    console.log(`  dynamic exits: ${t.beStops} breakeven_stop, ${t.trailStops} trail_stop`);
    if (t.intrabarBeAmb > 0) {
      console.log(`    ⚠ ${t.intrabarBeAmb} trade(s) had BE-trigger + old-stop hit on the same 1m bar`);
      console.log(`      — modeled optimistically (BE saved the trade). Re-run on 1s for precision.`);
    }
  }
  if (t.skipped > 0) {
    console.log(`  ${t.skipped} signal(s) skipped — same-strategy slot was still occupied by an earlier`);
    console.log(`    pending/open trade. Matches live orchestrator's 1-position-at-a-time rule per`);
    console.log(`    (strategy, symbol). Re-run with --allow-parallel to ignore this gate.`);
  }
  if (t.ambiguous > 0) {
    console.log(`  * ${t.ambiguous} ambiguous bar(s) — same-1m-bar SL+TP collision; resolved conservatively (SL first).`);
    console.log(`    Re-run with 1s bars for those specific signals if precision matters.`);
  }
}

// --------------------------- Main ---------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (!args.date) usage();

  const symbol = args.symbol || 'NQ';
  const outputPath = args.output || `/tmp/trade-audit-${args.date}.json`;
  const prodUrl = args['prod-url'];
  const token = args.token || process.env.DASHBOARD_TOKEN;

  // Auto-route: use the historical endpoints when --date is not today (ET).
  // Same-day audits still work via the historical endpoint (bars + alerts
  // accumulate there throughout the session) — fall back to live ring if
  // historical comes back empty for today's date.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const isToday = args.date === today;

  // ---------- Load signals ----------
  let signals = [];
  if (args['alerts-from-prod']) {
    if (!prodUrl || !token) {
      console.error('--alerts-from-prod requires prod URL and credentials (see --help)');
      process.exit(1);
    }
    const useHistorical = !isToday;
    const endpoint = useHistorical ? `/api/alerts/historical?date=${args.date}` : '/api/alerts';
    console.log(`Pulling alerts from ${prodUrl}${endpoint}...`);
    let alertsPayload = await fetchAlerts({ prodUrl, token, date: args.date, useHistorical });
    // Both endpoints return slightly different shapes. Normalize to array.
    let alerts = Array.isArray(alertsPayload) ? alertsPayload : (alertsPayload.alerts || []);
    // Fallback for today's date: if historical archive is empty (maybe the
    // archive subscriber hasn't been deployed yet), try the live ring.
    if (alerts.length === 0 && isToday && useHistorical) {
      console.log('Historical archive empty for today — falling back to live /api/alerts ring buffer');
      alertsPayload = await fetchAlerts({ prodUrl, token, useHistorical: false });
      alerts = Array.isArray(alertsPayload) ? alertsPayload : (alertsPayload.alerts || []);
    }
    const cachePath = `/tmp/alerts-${args.date}.json`;
    fs.writeFileSync(cachePath, JSON.stringify(alerts, null, 2));
    console.log(`Cached ${alerts.length} alerts to ${cachePath}`);
    signals = parseSignalsJson(alerts, { includeRejected: true, dateFilter: args.date });
  } else if (args.alerts) {
    const alerts = JSON.parse(fs.readFileSync(args.alerts, 'utf-8'));
    const arr = Array.isArray(alerts) ? alerts : (alerts.alerts || []);
    signals = parseSignalsJson(arr, { includeRejected: true, dateFilter: args.date });
  } else if (args.signals) {
    if (!fs.existsSync(args.signals)) {
      console.error(`signals file not found: ${args.signals}`);
      process.exit(1);
    }
    signals = parseSignalsText(fs.readFileSync(args.signals, 'utf-8'), { includeRejected: true });
  } else {
    console.error('Need one of: --signals <path>, --alerts <path>, --alerts-from-prod');
    process.exit(1);
  }
  if (args.strategy) {
    signals = signals.filter(s => s.strategy === args.strategy);
  }
  console.log(`Parsed ${signals.length} signals${args.strategy ? ` (filtered to ${args.strategy})` : ''}`);

  // ---------- Load candles ----------
  let candlesPayload;
  if (args.candles) {
    candlesPayload = loadCandlesFile(args.candles);
    console.log(`Loaded ${candlesPayload.candles?.length || candlesPayload.length} candles from ${args.candles}`);
  } else {
    if (!prodUrl || !token) {
      console.error('Need --candles <path> OR a prod URL with credentials to fetch candles (see --help)');
      process.exit(1);
    }
    const useHistorical = !isToday;
    const endpoint = useHistorical ? `/api/candles/historical?date=${args.date}` : '/api/candles';
    console.log(`Pulling candles from ${prodUrl}${endpoint}...`);
    candlesPayload = await fetchCandles({
      prodUrl, token, symbol,
      count: parseInt(args['candle-count'] || '400', 10),
      date: args.date, useHistorical,
    });
    let candleCount = candlesPayload.candles?.length || 0;
    if (candleCount === 0 && isToday && useHistorical) {
      console.log('Historical candle archive empty for today — falling back to live /api/candles ring buffer');
      candlesPayload = await fetchCandles({
        prodUrl, token, symbol,
        count: parseInt(args['candle-count'] || '400', 10),
        useHistorical: false,
      });
      candleCount = candlesPayload.candles?.length || 0;
    }
    const cachePath = `/tmp/candles-${symbol}-${args.date}.json`;
    fs.writeFileSync(cachePath, JSON.stringify(candlesPayload, null, 2));
    console.log(`Cached ${candleCount} candles to ${cachePath}`);
  }

  const rawCandles = candlesPayload.candles || candlesPayload;
  // Normalize timestamp to numeric ms; sort ascending by ts.
  const bars = rawCandles
    .map(c => ({
      ts: typeof c.timestamp === 'number' ? c.timestamp : Date.parse(c.timestamp),
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }))
    .filter(c => Number.isFinite(c.ts))
    .sort((a, b) => a.ts - b.ts);

  if (bars.length === 0) {
    console.error('No candles loaded. Aborting.');
    process.exit(1);
  }

  // Filter bars to the date in question (+ small grace for EOD exit eval)
  const dayStartUtc = etTimeToUtcMs(args.date, '00:00:00');
  const dayEndUtc = etTimeToUtcMs(args.date, '23:59:59');
  const dayBars = bars.filter(b => b.ts >= dayStartUtc && b.ts <= dayEndUtc);
  console.log(`Candles available: ${bars.length} total, ${dayBars.length} on ${args.date}`);
  const firstBar = dayBars[0], lastBar = dayBars[dayBars.length - 1];
  const candleRange = firstBar && lastBar
    ? `${fmtTime(firstBar.ts)} → ${fmtTime(lastBar.ts)} ET`
    : 'no bars on date';

  // Optional global overrides
  const opts = {
    fillTimeoutMin: args['fill-timeout-min'] ? parseInt(args['fill-timeout-min'], 10) : null,
    maxHoldMin: args['max-hold-min'] ? parseInt(args['max-hold-min'], 10) : null,
    staticExits: args['static-exits'] === true,
  };
  if (!opts.staticExits) {
    console.log('Dynamic exits ENABLED (BE/trail per deployed v2/v3 presets). Use --static-exits to disable.');
  } else {
    console.log('Static SL/TP walk (no BE/trail dynamics).');
  }

  // Audit each signal in time order, enforcing the live "one trade at a time
  // per strategy" rule. Live orchestrator's pendingOrders is keyed by
  // (accountId, strategy, symbol), so a new signal from the same strategy
  // gets rejected while a previous signal from that strategy is still
  // pending-limit or in an open position. Mirrors that here.
  signals.sort((a, b) => a.time.localeCompare(b.time));
  // strategy -> blockedUntilMs (signal's strategy slot is occupied through this ts)
  const blockedUntil = new Map();
  const results = [];
  for (const s of signals) {
    const signalUtc = s.timestampUtc ?? etTimeToUtcMs(args.date, s.time);
    const slotKey = s.strategy; // matches live pendingKey's strategy component
    const blockedTs = blockedUntil.get(slotKey) || 0;
    if (args['allow-parallel'] !== true && signalUtc < blockedTs) {
      // Live orchestrator would reject this as a duplicate-pending. Record
      // it for visibility (so the user sees which signals got eaten by the
      // 1-at-a-time rule), but don't simulate fill/exit.
      results.push({ ...s, outcome: 'skipped_position_active', signalUtc,
        exitReason: 'skipped_position_active',
        fillTime: null, exitTime: null, exitPrice: null,
        pnlPts: 0, pnlDollars: 0, ambiguous: false,
        blockedBy: { strategy: slotKey, blockedUntilMs: blockedTs } });
      continue;
    }
    const result = auditOneSignal(s, dayBars, args.date, opts);
    results.push(result);
    // Reserve the strategy slot until the trade resolves. Use exit time if
    // it filled and exited; if it never filled, the slot is held through
    // the limit-order's timeout window (mirrors how pendingOrders persists
    // until order.cancelled fires).
    const defaults = resolveDefaults(s.strategy, s.ruleId);
    const fillTimeoutMin = opts.fillTimeoutMin ?? defaults.fillTimeoutMin;
    let releaseMs;
    if (result.exitTime) releaseMs = result.exitTime;
    else if (result.outcome === 'no_fill') releaseMs = signalUtc + fillTimeoutMin * 60_000;
    else releaseMs = signalUtc + fillTimeoutMin * 60_000;
    blockedUntil.set(slotKey, Math.max(blockedTs, releaseMs));
  }

  printResults(results, args.date, candleRange);

  // Write per-trade JSON
  fs.writeFileSync(outputPath, JSON.stringify({
    date: args.date, symbol,
    candleSource: args.candles ? `file:${args.candles}` : `prod:${args['prod-url']}`,
    candleCount: dayBars.length,
    signalCount: results.length,
    summary: summarize(results),
    trades: results,
  }, null, 2));
  console.log(`\nPer-trade JSON written to ${outputPath}`);
}

main().catch(err => {
  console.error(`Audit failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
