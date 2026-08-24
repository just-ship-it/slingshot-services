import { test } from 'node:test';
import assert from 'node:assert';
import { TradeSimulator } from '../src/execution/trade-simulator.js';

function sim() {
  return new TradeSimulator({ slippage: { marketOrderSlippage: 0.25, stopOrderSlippage: 0.5, limitOrderSlippage: 0 } });
}
const C = (ts, o, h, l, c) => ({ timestamp: ts, open: o, high: h, low: l, close: c, volume: 1, symbol: 'NQZ5' });

test('stop-limit BUY: inert below trigger; arms on trigger touch; no same-1m-bar fill; fills at limit later', () => {
  const s = sim();
  const sig = { action: 'place_stop_limit', side: 'buy', price: 20000, stopTrigger: 20010, stop_loss: 19980, take_profit: 20040, timeoutCandles: 120 };
  const r = s.processSignal(sig, C(0, 19990, 19995, 19985, 19992));
  const id = r.id;
  const t = s.activeTrades.get(id);
  // below trigger: nothing
  let f = s.checkOrderFill(t, C(60000, 19995, 20005, 19990, 20000));
  assert.equal(f.filled, false); assert.ok(!t.armed);
  // touches trigger AND retraces through limit on the SAME 1m bar: arms but must NOT fill
  f = s.checkOrderFill(t, C(120000, 20005, 20012, 19998, 20006));
  assert.equal(f.filled, false); assert.ok(t.armed);
  // next bar retraces to limit → fills at exact limit, no slip
  f = s.checkOrderFill(t, C(180000, 20006, 20008, 19999, 20003));
  assert.equal(f.filled, true); assert.equal(f.fillPrice, 20000);
});

test('stop-limit BUY: same-bar arm+fill allowed on 1s bars', () => {
  const s = sim();
  const sig = { action: 'place_stop_limit', side: 'buy', price: 20000, stopTrigger: 20010, timeoutCandles: 120 };
  const r = s.processSignal(sig, C(0, 19990, 19995, 19985, 19992));
  const t = s.activeTrades.get(r.id);
  const f = s.checkOrderFill(t, { ...C(60000, 20005, 20012, 19998, 20006), _is1s: true });
  assert.equal(f.filled, true); assert.equal(f.fillPrice, 20000);
});

test('stop-limit SELL mirror + gap-through improvement after armed', () => {
  const s = sim();
  const sig = { action: 'place_stop_limit', side: 'sell', price: 20000, stopTrigger: 19990, timeoutCandles: 120 };
  const r = s.processSignal(sig, C(0, 20010, 20015, 20005, 20008));
  const t = s.activeTrades.get(r.id);
  // arm: low <= 19990
  let f = s.checkOrderFill(t, C(60000, 20000, 20002, 19988, 19992));
  assert.equal(f.filled, false); assert.ok(t.armed);
  // gap-open ABOVE the sell limit → fill at open (price improvement)
  f = s.checkOrderFill(t, C(120000, 20004, 20006, 19998, 20001));
  assert.equal(f.filled, true); assert.equal(f.fillPrice, 20004);
});

test('unarmed stop-limit does not count as fillable for pre-fill invalidation', () => {
  const s = sim();
  const sig = { action: 'place_stop_limit', side: 'buy', price: 20000, stopTrigger: 20010, timeoutCandles: 120 };
  const r = s.processSignal(sig, C(0, 19990, 19995, 19985, 19992));
  const t = s.activeTrades.get(r.id);
  assert.equal(s._entryFillReached(t, C(60000, 19995, 20005, 19990, 20000), true), false);
});
