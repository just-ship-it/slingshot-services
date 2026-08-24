/**
 * TickBroker — honest fill simulation for the tick engine.
 *
 * Key idea: a working order IS a Watch. It lives in the same price-bucketed index as everything
 * else, so N concurrent working orders cost what one costs. That removes the structural limit that
 * killed fvg-bear (one working order at a time).
 *
 * Honesty rules (all enforced here, not by convention):
 *  - A resting LIMIT fills at its exact price, but only from the bar AFTER it was placed (it has to
 *    have been resting). Gap-through gives price improvement (fill at the bar open).
 *  - A resting STOP fills at level ± slipStop. Gap-through CHASES (fill at open ± slip) — stops
 *    never get price improvement.
 *  - An order that could not exist does not fill: a sell-stop requires the market ABOVE it at
 *    placement, a sell-limit requires the market BELOW it. Placing on the wrong side degrades to a
 *    MARKET order (fill at the next bar's open ± slipMkt) — this is precisely the case the
 *    bar-close research silently filled at a price that was already gone.
 *  - Software-reacted (non-resting) decisions pay `reactionSec`: they cannot fill before
 *    ts + reactionSec. Broker-resting conditional orders pay nothing — that is the whole point of
 *    pre-positioning.
 *  - Within one second, adverse resolves first: stop before target; void before arm.
 *  - Exits: stop = level ∓ slipStop; target = level exactly; time/market = next bar open ± slipMkt.
 *
 * Prices are INTEGER TICKS throughout. Costs are applied in ticks and converted at report time.
 */
export class TickBroker {
  constructor({ core, tickValue = 5.0, commissionRT = 5.0, slipStopTicks = 2, slipMktTicks = 1,
                reactionSec = 0, maxConcurrentOrders = 256, onEvent = null } = {}) {
    this.core = core;
    this.W = core.watches;
    this.tickValue = tickValue;              // $ per tick (NQ 0.25pt × $20/pt = $5)
    this.commissionRT = commissionRT;
    this.slipStop = slipStopTicks;
    this.slipMkt = slipMktTicks;
    this.reactionSec = reactionSec;
    this.maxOrders = maxConcurrentOrders;
    this.onEvent = onEvent;
    this.orders = new Map();                 // orderId → order
    this.groups = new Map();                 // groupId → Set(orderId)   (first fill cancels siblings)
    this.position = null;
    this.trades = [];
    this.nextId = 1;
    this.rejected = { wrongSide: 0, capacity: 0, busy: 0 };
  }

  get flat() { return this.position === null; }
  get workingCount() { return this.orders.size; }

  /**
   * Place a working order.
   * @param {{kind:'stop'|'limit'|'stop_limit'|'market', side:1|-1, price:number(ticks),
   *          trigger?:number, stopTicks?:number, targetTicks?:number, stopPrice?:number,
   *          targetPrice?:number, expirySec?:number, maxHoldSec?:number, group?:string,
   *          tag?:any, allowWhileInPosition?:boolean}} o
   */
  place(o) {
    if (this.orders.size >= this.maxOrders) { this.rejected.capacity++; return null; }
    if (this.position && !o.allowWhileInPosition) { this.rejected.busy++; return null; }
    const core = this.core, ts = core.ts, row = core.row;
    const mkt = core.cache.c[row];
    const id = this.nextId++;
    let kind = o.kind, armLevel = o.price, armSide;
    // wrong-side detection → degrade to market (no fantasy fills)
    if (kind === 'stop') {
      armSide = o.side > 0 ? 1 : -1;                       // buy-stop above, sell-stop below
      const valid = o.side > 0 ? mkt < o.price : mkt > o.price;
      if (!valid) { this.rejected.wrongSide++; kind = 'market'; }
    } else if (kind === 'limit') {
      armSide = o.side > 0 ? -1 : 1;                       // buy-limit below, sell-limit above
      const valid = o.side > 0 ? mkt > o.price : mkt < o.price;
      if (!valid) { this.rejected.wrongSide++; kind = 'market'; }
    } else if (kind === 'stop_limit') {
      armSide = o.side > 0 ? 1 : -1;                       // trigger side
      armLevel = o.trigger;
    }
    const ord = {
      id, kind, side: o.side, price: o.price, trigger: o.trigger,
      stopTicks: o.stopTicks, targetTicks: o.targetTicks, stopPrice: o.stopPrice, targetPrice: o.targetPrice,
      placedTs: ts, placedRow: row, notBefore: ts + (o.resting ? 0 : this.reactionSec),
      expiryTs: o.expirySec ? ts + o.expirySec : 0, maxHoldSec: o.maxHoldSec || 0,
      group: o.group || null, tag: o.tag, armed: false, slot: -1,
      restingFrom: kind === 'stop_limit' ? 0 : ts,          // stop-limit only rests after trigger
    };
    if (kind === 'market') {
      ord.marketFromRow = row + 1;                          // next bar's open
      this.orders.set(id, ord);
    } else {
      ord.slot = this.W.add({
        armLevel, armSide,
        voidLevel: o.voidLevel, voidSide: o.voidSide,
        expiry: ord.expiryTs || 0,
        meta: { _ord: id },
      });
      this.orders.set(id, ord);
    }
    if (ord.group) { if (!this.groups.has(ord.group)) this.groups.set(ord.group, new Set()); this.groups.get(ord.group).add(id); }
    return id;
  }

  cancel(id, reason = 'cancel') {
    const o = this.orders.get(id);
    if (!o) return false;
    if (o.slot >= 0) this.W.cancel(o.slot);
    this.orders.delete(id);
    if (o.group) this.groups.get(o.group)?.delete(id);
    this.onEvent?.({ type: 'cancel', id, reason, ts: this.core.ts, tag: o.tag });
    return true;
  }
  cancelAll(reason = 'cancel') { for (const id of [...this.orders.keys()]) this.cancel(id, reason); }

  /** Called by the strategy loop for every 1s bar, BEFORE watch evaluation. Handles market fills,
   *  position exits (stop/target/time) and expiry. */
  onTick() {
    const core = this.core, row = core.row, ts = core.ts;
    const O = core.cache.o, H = core.cache.h, L = core.cache.l, C = core.cache.c;
    // --- position exits first (adverse-first inside the second)
    if (this.position) {
      const p = this.position, hi = H[row], lo = L[row];
      const stopHit = p.stopPrice != null && (p.side > 0 ? lo <= p.stopPrice : hi >= p.stopPrice);
      const tgtHit = p.targetPrice != null && (p.side > 0 ? hi >= p.targetPrice : lo <= p.targetPrice);
      if (stopHit) { this._close(p.stopPrice - p.side * this.slipStop, 'stop'); }
      else if (tgtHit) { this._close(p.targetPrice, 'target'); }
      else if (p.maxHoldSec && ts - p.entryTs >= p.maxHoldSec) { this._close(C[row] - p.side * this.slipMkt, 'time'); }
      else if (core.sym !== p.sym) { this._close(C[row] - p.side * this.slipMkt, 'roll'); }
    }
    // --- market orders (placed last bar) and expiries
    for (const [id, o] of this.orders) {
      if (o.kind === 'market' && row >= o.marketFromRow && ts >= o.notBefore) {
        this._fill(o, O[row] + o.side * this.slipMkt, 'market');
        continue;
      }
      if (o.expiryTs && ts >= o.expiryTs) this.cancel(id, 'expiry');
    }
  }

  /** Called from the WatchIndex arm callback when meta carries an order id. */
  onArm(meta, level) {
    const id = meta && meta._ord;
    if (!id) return false;
    const o = this.orders.get(id);
    if (!o) return true;
    const core = this.core, row = core.row, ts = core.ts;
    const O = core.cache.o, H = core.cache.h, L = core.cache.l;
    if (ts < o.notBefore) {                       // software-reaction latency not yet paid: re-arm
      o.slot = this.W.add({ armLevel: level, armSide: o.side > 0 ? 1 : -1, expiry: o.expiryTs || 0, meta: { _ord: id } });
      return true;
    }
    if (o.kind === 'stop') {
      const gapped = o.side > 0 ? O[row] >= o.price : O[row] <= o.price;
      const base = gapped ? O[row] : o.price;     // stops chase, never improve
      this._fill(o, base + o.side * this.slipStop, 'stop-entry');
    } else if (o.kind === 'limit') {
      if (row <= o.placedRow) {                   // must have been resting for at least one bar
        o.slot = this.W.add({ armLevel: level, armSide: o.side > 0 ? -1 : 1, expiry: o.expiryTs || 0, meta: { _ord: id } });
        return true;
      }
      const gapped = o.side > 0 ? O[row] <= o.price : O[row] >= o.price;
      this._fill(o, gapped ? O[row] : o.price, 'limit');    // limits DO get price improvement
    } else if (o.kind === 'stop_limit') {
      if (!o.armed) {                             // trigger touched → the limit starts resting NOW
        o.armed = true; o.restingFrom = ts;
        o.slot = this.W.add({ armLevel: o.price, armSide: o.side > 0 ? -1 : 1, expiry: o.expiryTs || 0, meta: { _ord: id } });
        return true;
      }
      const gapped = o.side > 0 ? O[row] <= o.price : O[row] >= o.price;
      this._fill(o, gapped ? O[row] : o.price, 'stop-limit');
    }
    return true;
  }

  _fill(o, px, how) {
    this.orders.delete(o.id);
    if (o.group) {                                 // first fill cancels the siblings
      const g = this.groups.get(o.group);
      if (g) { for (const sid of [...g]) if (sid !== o.id) this.cancel(sid, 'sibling-filled'); this.groups.delete(o.group); }
    }
    if (this.position) return;                     // safety: never stack
    const core = this.core;
    this.position = {
      side: o.side, entry: px, entryTs: core.ts, entryRow: core.row, sym: core.sym, tag: o.tag, how,
      stopPrice: o.stopPrice != null ? o.stopPrice : (o.stopTicks ? px - o.side * o.stopTicks : null),
      targetPrice: o.targetPrice != null ? o.targetPrice : (o.targetTicks ? px + o.side * o.targetTicks : null),
      maxHoldSec: o.maxHoldSec || 0,
    };
    this.onEvent?.({ type: 'fill', ts: core.ts, side: o.side, px, how, tag: o.tag });
  }

  _close(px, why) {
    const p = this.position, core = this.core;
    const ticks = (px - p.entry) * p.side;
    this.trades.push({
      side: p.side, entryTs: p.entryTs, exitTs: core.ts, entry: p.entry, exit: px, ticks,
      usd: ticks * this.tickValue - this.commissionRT, why, how: p.how, tag: p.tag,
      holdSec: core.ts - p.entryTs, sym: core.cache.meta.symbols[p.sym],
    });
    this.position = null;
    this.onEvent?.({ type: 'exit', ts: core.ts, px, why, ticks });
  }

  summary() {
    const t = this.trades;
    if (!t.length) return { n: 0 };
    const usd = t.map((x) => x.usd);
    const w = usd.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const l = -usd.filter((x) => x < 0).reduce((a, b) => a + b, 0);
    let eq = 0, peak = 0, dd = 0;
    for (const u of usd) { eq += u; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
    const byYear = {};
    for (const x of t) { const y = new Date(x.entryTs * 1000).getUTCFullYear(); (byYear[y] ??= [0, 0]); byYear[y][0]++; byYear[y][1] += x.usd; }
    return {
      n: t.length, wr: usd.filter((x) => x > 0).length / t.length, pf: l > 0 ? w / l : Infinity,
      usd: Math.round(usd.reduce((a, b) => a + b, 0)), maxDD: Math.round(dd),
      medHoldMin: Math.round(t.map((x) => x.holdSec).sort((a, b) => a - b)[t.length >> 1] / 60),
      exits: t.reduce((m, x) => ((m[x.why] = (m[x.why] || 0) + 1), m), {}),
      byYear: Object.fromEntries(Object.entries(byYear).map(([y, [n, u]]) => [y, `${n}t $${Math.round(u).toLocaleString()}`])),
      rejected: this.rejected,
    };
  }
}
