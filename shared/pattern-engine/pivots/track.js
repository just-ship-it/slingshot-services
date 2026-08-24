/**
 * PivotTrack — ordered, alternating pivot history for one (tf, generator).
 * Enforces H/L alternation: a same-kind pivot replaces the previous one if more extreme
 * (the displaced one is kept as `minor`), otherwise it is stored as minor. Bounded length.
 * Every pivot keeps confirmedAt; consumers must only use pivots with confirmedAt <= now.
 */
export class PivotTrack {
  constructor({ max = 64 } = {}) { this.max = max; this.majors = []; this.minors = []; this.seq = 0; }
  reset() { this.majors = []; this.minors = []; this.seq = 0; }
  /** returns { major: pivot|null, displaced: pivot|null } */
  add(p) {
    p = { ...p, id: ++this.seq };
    const last = this.majors[this.majors.length - 1];
    let displaced = null;
    if (last && last.kind === p.kind) {
      const better = p.kind === 'H' ? p.price >= last.price : p.price <= last.price;
      if (better) { displaced = this.majors.pop(); this._minor({ ...displaced, minor: true }); this.majors.push(p); }
      else { this._minor({ ...p, minor: true }); return { major: null, displaced: null }; }
    } else {
      this.majors.push(p);
    }
    if (this.majors.length > this.max) this.majors.shift();
    return { major: p, displaced };
  }
  _minor(p) { this.minors.push(p); if (this.minors.length > this.max) this.minors.shift(); }
  last(n = 1) { return this.majors.slice(-n); }
  get length() { return this.majors.length; }
  /** last n majors, oldest first, all confirmed at or before `now` (they always are, by construction) */
  window(n) { return this.majors.length >= n ? this.majors.slice(-n) : null; }
}
