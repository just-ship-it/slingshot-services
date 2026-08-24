/**
 * WatchIndex — the tick engine's hot structure.
 *
 * A Watch is a conditional trigger: "arm when price reaches A; void if it reaches B first".
 * Watches are stored in slot-parallel typed arrays (no per-watch objects in the hot path) and
 * indexed by PRICE BUCKET, so a 1s bar — whose range is typically a few ticks — only examines the
 * one or two buckets it spans, regardless of how many watches are live. This is what turns the
 * naive O(watches) scan (1.9M bars/s at 128 watches) into O(watches-near-price).
 *
 * All prices are INTEGER TICKS. Sides: +1 = "arm when high >= level", -1 = "arm when low <= level".
 * Same-bar arm+void ⇒ VOID wins (the conservative intra-second rule; 1s OHLC does not order H vs L).
 */
const EMPTY = [];

export class WatchIndex {
  /** @param {number} bucketTicks power-of-two bucket width in ticks (64 ticks = 16 NQ points) */
  constructor({ bucketTicks = 64, capacity = 4096 } = {}) {
    this.shift = Math.log2(bucketTicks) | 0;
    this.cap = capacity;
    // slot arrays
    this.armLvl = new Int32Array(capacity);
    this.armSide = new Int8Array(capacity);
    this.voidLvl = new Int32Array(capacity);
    this.voidSide = new Int8Array(capacity);
    this.state = new Uint8Array(capacity);       // 0 free, 1 live
    this.expiry = new Float64Array(capacity);    // epoch seconds; 0 = none
    this.meta = new Array(capacity);             // opaque payload (structure id, action, order plan)
    this.free = [];
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
    this.buckets = new Map();                    // bucketId → int slot array (arm entries)
    this.vbuckets = new Map();                   // bucketId → int slot array (void entries)
    this.live = 0;
    this.stats = { added: 0, armed: 0, voided: 0, expired: 0, bucketScans: 0, slotChecks: 0 };
  }

  _bucket(map, b) { let a = map.get(b); if (!a) { a = []; map.set(b, a); } return a; }
  _remove(map, b, slot) { const a = map.get(b); if (!a) return; const i = a.indexOf(slot); if (i >= 0) a.splice(i, 1); if (!a.length) map.delete(b); }

  /**
   * @param {{armLevel, armSide, voidLevel?, voidSide?, expiry?, meta?}} w
   * @returns {number} slot id (use to cancel)
   */
  add(w) {
    const slot = this.free.pop();
    if (slot === undefined) throw new Error('WatchIndex capacity exhausted');
    this.armLvl[slot] = w.armLevel; this.armSide[slot] = w.armSide;
    this.voidLvl[slot] = w.voidLevel ?? 0; this.voidSide[slot] = w.voidLevel != null ? w.voidSide : 0;
    this.expiry[slot] = w.expiry || 0;
    this.meta[slot] = w.meta;
    this.state[slot] = 1;
    this._bucket(this.buckets, w.armLevel >> this.shift).push(slot);
    if (w.voidLevel != null) this._bucket(this.vbuckets, w.voidLevel >> this.shift).push(slot);
    this.live++; this.stats.added++;
    return slot;
  }

  cancel(slot) {
    if (this.state[slot] !== 1) return false;
    this.state[slot] = 0;
    this._remove(this.buckets, this.armLvl[slot] >> this.shift, slot);
    if (this.voidSide[slot] !== 0) this._remove(this.vbuckets, this.voidLvl[slot] >> this.shift, slot);
    this.meta[slot] = undefined;
    this.free.push(slot); this.live--;
    return true;
  }

  /**
   * Evaluate one 1s bar. Returns nothing; calls onArm(slot, meta) / onVoid(slot, meta, reason).
   * Order of resolution within the bar: expiry → void → arm  (adverse-first, conservative).
   */
  step(lo, hi, ts, onArm, onVoid) {
    const s = this.shift;
    const b0 = lo >> s, b1 = hi >> s;
    // --- void pass first (a watch touched on both sides in one second is voided, not armed)
    for (let b = b0; b <= b1; b++) {
      const a = this.vbuckets.get(b);
      if (!a) continue;
      this.stats.bucketScans++;
      for (let i = a.length - 1; i >= 0; i--) {
        const slot = a[i];
        if (this.state[slot] !== 1) continue;
        this.stats.slotChecks++;
        const lvl = this.voidLvl[slot];
        if (this.voidSide[slot] > 0 ? hi >= lvl : lo <= lvl) {
          const m = this.meta[slot];
          this.cancel(slot); this.stats.voided++;
          if (onVoid) onVoid(slot, m, 'void-level');
        }
      }
    }
    // --- arm pass
    for (let b = b0; b <= b1; b++) {
      const a = this.buckets.get(b);
      if (!a) continue;
      this.stats.bucketScans++;
      for (let i = a.length - 1; i >= 0; i--) {
        const slot = a[i];
        if (this.state[slot] !== 1) continue;
        this.stats.slotChecks++;
        const lvl = this.armLvl[slot];
        if (this.armSide[slot] > 0 ? hi >= lvl : lo <= lvl) {
          const m = this.meta[slot];
          this.cancel(slot); this.stats.armed++;
          if (onArm) onArm(slot, m, lvl);
        }
      }
    }
  }

  /** Expire time-bounded watches (call once per bar or per minute — cheap linear over live slots only). */
  expireBefore(ts, onVoid) {
    if (!this.live) return;
    for (let slot = 0; slot < this.cap; slot++) {
      if (this.state[slot] !== 1) continue;
      const e = this.expiry[slot];
      if (e && ts >= e) {
        const m = this.meta[slot];
        this.cancel(slot); this.stats.expired++;
        if (onVoid) onVoid(slot, m, 'expiry');
      }
    }
  }
}
