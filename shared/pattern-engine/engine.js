/**
 * PatternEngine — one 1m raw-contract bar stream in, PatternEvents out, for a set of timeframes.
 *
 *   const eng = new PatternEngine({ product: 'NQ', timeframes: ['1m','3m','5m','15m','1h'], detectors: [...] });
 *   for (const bar1m of stream) for (const evt of eng.onBar1m(bar1m)) write(evt);
 *
 * Detector contract (see patterns/README.md):
 *   { id, family, tfs?: string[], params?: {}, create(ctx) -> { onBar(bar, f, ctx), onPivot?(pivot, gen, ctx) } }
 *   Detectors call ctx.emit({ patternId, family?, key, state, direction, levels, anchors, geometry, note })
 *   `key` = stable per-instance key (e.g. `${patternId}:${firstAnchorTs}`); engine builds instanceId,
 *   dedups repeated 'forming' emissions, tracks lifecycle after forming, and enriches context/parents.
 */
import { MultiTfAggregator } from './aggregator.js';
import { BarFeatures, Ring } from './features.js';
import { FractalPivots } from './pivots/fractal.js';
import { ZigZagPivots } from './pivots/zigzag.js';
import { PivotTrack } from './pivots/track.js';
import { LifecycleTracker } from './lifecycle.js';
import { NestingIndex } from './nesting.js';
import { tfMinutes, sessionLabel, etMinuteOfDay, tradeDow, sessionInfo } from './time.js';

const R = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : (typeof x === 'number' ? null : x));
const roundObj = (o) => { if (!o || typeof o !== 'object') return o; if (Array.isArray(o)) return o.map(roundObj); const r = {}; for (const k in o) { const v = o[k]; r[k] = typeof v === 'number' ? R(v) : (v && typeof v === 'object' ? roundObj(v) : v); } return r; };
const VALID = new Set(['candidate', 'forming', 'confirmed', 'triggered', 'resolved-up', 'resolved-down', 'invalidated', 'expired', 'false-break', 'throwback', 'busted']);
const TERMINAL = new Set(['resolved-up', 'resolved-down', 'invalidated', 'expired']);

class BarRing {
  constructor(n) { this.n = n; this.a = []; }
  push(b) { this.a.push(b); if (this.a.length > this.n) this.a.shift(); }
  get length() { return this.a.length; }
  at(i) { return i < 0 ? this.a[this.a.length + i] : this.a[i]; }   // at(-1) = latest
  last(n) { return this.a.slice(-n); }
}

export class PatternEngine {
  constructor(opts = {}) {
    this.product = opts.product || 'NQ';
    this.tfs = opts.timeframes || ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
    this.detectorDefs = opts.detectors || [];
    this.params = opts.params || {};
    this.keepBars = opts.keepBars || 400;
    this.agg = new MultiTfAggregator(this.tfs);
    this.nest = new NestingIndex(this.tfs, tfMinutes);
    this.symbol = null;
    this.session = { ssUtc: null, high: -Infinity, low: Infinity, open: NaN, rthOpen: NaN, prevHigh: NaN, prevLow: NaN, prevClose: NaN, prevRthClose: NaN, lastClose: NaN };
    this.tfState = new Map();
    for (const tf of this.tfs) this.tfState.set(tf, this._newTf(tf));
    this.stats = { bars1m: 0, events: 0, byState: {}, byPattern: {} };
  }

  _newTf(tf) {
    const tfMin = tfMinutes(tf);
    const p = this.params[tf] || {};
    const st = {
      tf, tfMin,
      bars: new BarRing(this.keepBars),
      features: new BarFeatures({ tfMin, ...(p.features || {}) }),
      fractal: new FractalPivots({ k: p.fractalK ?? (tfMin >= 60 ? 4 : 3) }),
      zigzag: new ZigZagPivots({ theta: p.zigzagTheta ?? 2.0 }),
      tracks: { fractal: new PivotTrack({ max: 64 }), zigzag: new PivotTrack({ max: 64 }) },
      lifecycle: new LifecycleTracker(p.lifecycle || {}),
      known: new Map(),        // instanceId -> last state (for dedup / prevState)
      barIdx: -1,
      detectors: [],
    };
    for (const def of this.detectorDefs) {
      if (def.tfs && !def.tfs.includes(tf)) continue;
      const inst = def.create({ tf, tfMin, product: this.product, params: { ...(def.params || {}), ...((p.detectors || {})[def.id] || {}) } });
      st.detectors.push({ def, inst });
    }
    return st;
  }

  reset() {
    this.agg.reset(); this.nest.reset();
    for (const tf of this.tfs) this.tfState.set(tf, this._newTf(tf));
  }

  /** feed one closed 1m bar {ts, open, high, low, close, volume, symbol}; returns PatternEvent[] */
  onBar1m(bar) {
    this.stats.bars1m++;
    if (this.symbol && bar.symbol !== this.symbol) {
      // contract roll: hard reset of all state (levels are in old-contract price space)
      this.reset();
    }
    this.symbol = bar.symbol;
    this._rollSession(sessionInfo(bar.ts).ssUtc, bar);
    const events = [];
    for (const tfBar of this.agg.add(bar)) {
      const st = this.tfState.get(tfBar.tf);
      this._onTfBar(st, tfBar, events);
    }
    return events;
  }

  _rollSession(ssUtc, bar) {
    const s = this.session;
    if (s.ssUtc !== ssUtc) {
      if (s.ssUtc != null) { s.prevHigh = s.high; s.prevLow = s.low; s.prevClose = s.lastSessionClose; s.prevRthClose = s.rthClose; }
      s.ssUtc = ssUtc; s.high = -Infinity; s.low = Infinity; s.open = bar.open; s.rthOpen = NaN; s.rthClose = NaN;
    }
    if (bar.high > s.high) s.high = bar.high;
    if (bar.low < s.low) s.low = bar.low;
    const m = etMinuteOfDay(bar.ts);
    if (m === 9 * 60 + 30 && !Number.isFinite(s.rthOpen)) s.rthOpen = bar.open;
    if (m === 15 * 60 + 59) s.rthClose = bar.close;
    s.lastSessionClose = bar.close;
  }

  _onTfBar(st, bar, events) {
    st.barIdx++;
    const f = st.features.describe(bar);
    bar.f = f; bar.i = st.barIdx;
    st.bars.push(bar);
    const now = bar.closeTs;
    const ctx = this._ctx(st, bar, f, now, events);

    // 1) pivots (confirmed at this bar's close)
    const newPivots = [];
    for (const p of st.fractal.push(bar)) { const r = st.tracks.fractal.add(p); if (r.major) newPivots.push(['fractal', r.major]); }
    for (const p of st.zigzag.push(bar, f.atr)) { const r = st.tracks.zigzag.add(p); if (r.major) newPivots.push(['zigzag', r.major]); }

    // 2) lifecycle of live instances (uses this closed bar)
    for (const t of st.lifecycle.onBar(bar, f.atr)) this._emit(st, t, bar, now, events, /*fromLifecycle*/ true);

    // 3) detectors
    if (f.warm) {
      for (const { inst } of st.detectors) {
        for (const [gen, p] of newPivots) if (inst.onPivot) inst.onPivot(p, gen, ctx);
        if (inst.onBar) inst.onBar(bar, f, ctx);
      }
    }
    // 4) update normalizers AFTER the bar has been described/used
    st.features.update(bar);
  }

  _ctx(st, bar, f, now, events) {
    const eng = this;
    return {
      tf: st.tf, tfMin: st.tfMin, product: this.product, symbol: this.symbol, now, bar, f, barIdx: st.barIdx,
      bars: st.bars, features: st.features, pivots: st.tracks, zigzagProvisional: st.zigzag.provisional(),
      session: this.session,
      emit(e) { eng._emit(st, e, bar, now, events, false); },
    };
  }

  _emit(st, e, bar, now, events, fromLifecycle) {
    if (!VALID.has(e.state)) throw new Error(`invalid state ${e.state}`);
    const patternId = e.patternId;
    const instanceId = e.instanceId || `${this.product}:${st.tf}:${patternId}:${e.key ?? (e.anchors?.[0]?.ts ?? now)}`;
    const prev = st.known.get(instanceId) ?? null;
    if (e.state === 'forming' && prev) return;                 // dedup repeated forming
    if (e.state !== 'forming' && !prev && !fromLifecycle && e.state !== 'candidate') {
      // detector-emitted transition for an unknown instance: allow only if it carries anchors (self-contained event)
      if (!e.anchors) return;
    }
    if (prev && TERMINAL.has(prev)) return;                    // append-only: nothing after a terminal state
    // knowability guard: anchors' confirmedAt must be <= now
    if (e.anchors) for (const a of e.anchors) if (a.confirmedAt > now) throw new Error(`lookahead: anchor ${a.role} confirmedAt ${new Date(a.confirmedAt).toISOString()} > now ${new Date(now).toISOString()} (${patternId})`);
    const evt = {
      v: 0, ts: new Date(now).toISOString(), symbol: this.symbol, product: this.product, tf: st.tf,
      patternId, family: e.family || 'structure', instanceId, state: e.state, prevState: prev,
      direction: e.direction || 'bilateral',
      levels: roundObj(e.levels || { trigger: null, invalidation: null }),
      anchors: fromLifecycle ? [] : (e.anchors || []), geometry: fromLifecycle ? {} : roundObj(e.geometry || {}),   // transitions: join on instanceId
      context: roundObj(this._context(bar, bar.f)),
    };
    if (e.note) evt.note = e.note;
    if (e.state === 'forming') evt.context.parents = this.nest.parents(evt);   // transitions: join on instanceId
    st.known.set(instanceId, e.state);
    if (e.state === 'forming') st.lifecycle.track(evt);
    if (!fromLifecycle && (e.state === 'invalidated' || e.state.startsWith('resolved') || e.state === 'expired')) st.lifecycle.drop(instanceId);
    this.nest.update(evt);
    events.push(evt);
    this.stats.events++;
    this.stats.byState[e.state] = (this.stats.byState[e.state] || 0) + 1;
    this.stats.byPattern[patternId] = (this.stats.byPattern[patternId] || 0) + 1;
    return evt;
  }

  _context(bar, f) {
    const s = this.session; const a = f.atr;
    const d = (x) => Number.isFinite(x) && a ? +(((bar.close - x) / a).toFixed(3)) : null;
    return {
      session: sessionLabel(bar.ts), minuteOfDayEt: etMinuteOfDay(bar.ts), dow: tradeDow(bar.ts), tradeDate: bar.tradeDate,
      atr14: a, atrPctile: f.atrPctile, relVol: f.relVol,
      trend: { ema20Slope: f.emaSlope, emaDist: f.emaDist },
      distToRthOpenAtr: d(s.rthOpen), distToSessOpenAtr: d(s.open), distToPdhAtr: d(s.prevHigh), distToPdlAtr: d(s.prevLow), distToPdcAtr: d(s.prevClose),
      distToSessHighAtr: d(s.high), distToSessLowAtr: d(s.low),
    };
  }
}
