/**
 * LifecycleTracker — generic post-`forming` state machine for pattern instances on one tf.
 *
 * Detectors describe geometry + levels once (state 'forming'); the tracker then watches closed tf
 * bars and emits, in order of occurrence:
 *   triggered      first intrabar touch of the trigger level (directional patterns)
 *   confirmed      first CLOSE beyond trigger by eps (directional) / beyond upper|lower (bilateral)
 *   invalidated    close beyond invalidation before confirmation
 *   expired        maxFormingBars without confirmation, or maxHoldBars after confirmation
 *   false-break    (meta) after confirmed, close back through the trigger within ≤ fbBars
 *   throwback      (meta) after ≥ tbExcursionAtr beyond trigger, return to within tbTolAtr of it
 *   busted         (meta) after confirmed, < bustAtr follow-through then close through invalidation
 *   resolved-up / resolved-down   target hit (in direction) or invalidation hit (opposite) — coarse,
 *                  tf-bar resolution; the honest 1s walk is done offline by the labeler.
 * Sloped boundaries: levels.upperSlope/lowerSlope/triggerSlope in points per bar extend the level.
 * All decisions use the closed bar; the transition ts = bar.closeTs.
 */
export class LifecycleTracker {
  constructor(p = {}) {
    this.p = {
      epsAtr: 0.1, maxFormingBars: 60, maxHoldBars: 120, fbBars: 3, tbExcursionAtr: 1.0, tbTolAtr: 0.25,
      bustAtr: 3.0, ...p,
    };
    this.live = new Map();   // instanceId -> record
  }
  reset() { this.live.clear(); }

  /** register a forming instance (idempotent) */
  track(evt) {
    if (this.live.has(evt.instanceId)) return;
    const L = evt.levels || {};
    const bilateral = evt.direction === 'bilateral' || (L.trigger == null && L.upper != null && L.lower != null);
    this.live.set(evt.instanceId, {
      id: evt.instanceId, patternId: evt.patternId, family: evt.family, tf: evt.tf,
      dir: evt.direction, bilateral, L: { ...L }, formingBar: null, bars: 0,
      state: 'forming', triggered: false, confirmedBar: null, confDir: null,
      target: null, inv: null, trigger: null, ext: null, fbDone: false, tbDone: false, bustDone: false,
      atr: evt.context?.atr14 || NaN, anchors: evt.anchors, geometry: evt.geometry, spanStart: evt.anchors?.[0]?.ts,
      maxForming: evt.geometry?.maxFormingBars ?? this.p.maxFormingBars, maxHold: evt.geometry?.maxHoldBars ?? this.p.maxHoldBars,
    });
  }

  /** mark an instance ended by the detector itself (e.g., geometry invalidation) */
  drop(instanceId) { this.live.delete(instanceId); }
  has(instanceId) { return this.live.has(instanceId); }
  states() { return this.live; }

  _lvl(v, slope, k) { return v == null ? null : v + (slope || 0) * k; }

  /** process a closed tf bar; returns transition events (partial, engine enriches) */
  onBar(bar, atr) {
    const out = [];
    for (const r of this.live.values()) {
      r.bars++;
      const k = r.bars;
      const a = Number.isFinite(atr) && atr > 0 ? atr : (r.atr || 1);
      const eps = this.p.epsAtr * a;
      const emit = (state, extra = {}) => out.push({ instanceId: r.id, patternId: r.patternId, family: r.family, tf: r.tf,
        state, prevState: r.state, direction: extra.direction || r.confDir || r.dir, levels: this._levelsNow(r, k), anchors: r.anchors,
        geometry: r.geometry, note: extra.note });

      if (r.state === 'forming') {
        if (r.bilateral) {
          const up = this._lvl(r.L.upper, r.L.upperSlope, k), lo = this._lvl(r.L.lower, r.L.lowerSlope, k);
          if (up != null && bar.close > up + eps) this._confirm(r, 'up', up, r.L.targetUp ?? r.L.target, r.L.invalidationUp ?? lo, bar, k, emit);
          else if (lo != null && bar.close < lo - eps) this._confirm(r, 'down', lo, r.L.targetDown ?? r.L.target, r.L.invalidationDown ?? up, bar, k, emit);
          else if (k >= r.maxForming) { emit('expired'); this.live.delete(r.id); }
        } else {
          const trig = this._lvl(r.L.trigger, r.L.triggerSlope, k);
          const inv = this._lvl(r.L.invalidation, r.L.invalidationSlope, k);
          const above = (r.L.triggerSide || (r.dir === 'up' ? 'above' : 'below')) === 'above';
          if (!r.triggered && trig != null && (above ? bar.high >= trig : bar.low <= trig)) { r.triggered = true; emit('triggered'); }
          if (inv != null && (above ? bar.close < inv - eps : bar.close > inv + eps)) { emit('invalidated'); this.live.delete(r.id); continue; }
          if (trig != null && (above ? bar.close > trig + eps : bar.close < trig - eps)) this._confirm(r, above ? 'up' : 'down', trig, r.L.target, inv, bar, k, emit);
          else if (k >= r.maxForming) { emit('expired'); this.live.delete(r.id); }
        }
        continue;
      }
      if (r.state === 'confirmed') {
        const up = r.confDir === 'up';
        const kc = k - r.confirmedBar;
        // excursion beyond trigger
        const exc = up ? bar.high - r.trigger : r.trigger - bar.low;
        if (exc > (r.ext ?? -Infinity)) r.ext = exc;
        // false break: close back through trigger within fbBars
        if (!r.fbDone && kc <= this.p.fbBars && (up ? bar.close < r.trigger : bar.close > r.trigger)) { r.fbDone = true; emit('false-break'); }
        // throwback: after >= tbExcursionAtr excursion, return to within tbTolAtr of trigger
        if (!r.tbDone && r.ext >= this.p.tbExcursionAtr * a && (up ? bar.low <= r.trigger + this.p.tbTolAtr * a : bar.high >= r.trigger - this.p.tbTolAtr * a)) { r.tbDone = true; emit('throwback'); }
        // resolution: target vs invalidation (same-bar both → invalidation wins, conservative)
        const hitInv = r.inv != null && (up ? bar.low <= r.inv : bar.high >= r.inv);
        const hitTgt = r.target != null && (up ? bar.high >= r.target : bar.low <= r.target);
        if (hitInv) {
          if (r.ext < this.p.bustAtr * a && !r.bustDone) { r.bustDone = true; emit('busted'); }
          emit(up ? 'resolved-down' : 'resolved-up', { note: 'invalidation-hit' }); this.live.delete(r.id); continue;
        }
        if (hitTgt) { emit(up ? 'resolved-up' : 'resolved-down', { note: 'target-hit' }); this.live.delete(r.id); continue; }
        if (kc >= r.maxHold) { emit('expired', { note: 'hold-timeout' }); this.live.delete(r.id); }
      }
    }
    return out;
  }

  _confirm(r, dir, trig, target, inv, bar, k, emit) {
    r.state = 'confirmed'; r.confDir = dir; r.confirmedBar = k; r.trigger = trig; r.target = target ?? null; r.inv = inv ?? null; r.ext = 0;
    emit('confirmed', { direction: dir });
  }

  _levelsNow(r, k) {
    const L = r.L;
    return {
      trigger: r.trigger ?? this._lvl(L.trigger, L.triggerSlope, k), triggerSide: L.triggerSide ?? null,
      invalidation: r.inv ?? this._lvl(L.invalidation, L.invalidationSlope, k), target: r.target ?? L.target ?? null,
      target2: L.target2 ?? null, midline: L.midline ?? null,
      upper: this._lvl(L.upper, L.upperSlope, k), lower: this._lvl(L.lower, L.lowerSlope, k),
      upperSlope: L.upperSlope ?? null, lowerSlope: L.lowerSlope ?? null, extra: L.extra ?? undefined,
    };
  }
}
