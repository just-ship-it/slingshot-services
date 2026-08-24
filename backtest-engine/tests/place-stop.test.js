/**
 * place_stop entry-order tests (stop-market entries).
 *
 * Run: node --test tests/place-stop.test.js   (from backtest-engine/)
 *
 * Covers: no premature fill, touch-fill at stopPrice ± stopOrderSlippage,
 * gap-through chase (open beyond stop → open ± slip, never improvement),
 * timeoutCandles cancel, stopDistance/targetDistance re-anchor from the
 * actual fill, 1s-path fill, and a place_limit regression check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeSimulator } from '../src/execution/trade-simulator.js';

const SLIP = { limitOrderSlippage: 0, marketOrderSlippage: 0.25, stopOrderSlippage: 0.5 };
// 10:00 ET on a Tuesday — clear of EOD/market-close force-flats
const T0 = Date.parse('2026-01-06T15:00:00Z');
const MIN = 60 * 1000;

function makeSim() {
  return new TradeSimulator({ commission: 5, slippage: { ...SLIP } });
}

function candle(i, open, high, low, close) {
  return { timestamp: T0 + i * MIN, open, high, low, close, symbol: 'NQH6', volume: 100 };
}

function sellStopSignal(extra = {}) {
  return {
    action: 'place_stop', side: 'sell', symbol: 'NQH6', price: 20000,
    quantity: 1, strategy: 'TEST', ...extra
  };
}

test('sell-stop below market does NOT fill while price stays above', () => {
  const sim = makeSim();
  sim.processSignal(sellStopSignal(), T0);
  for (let i = 1; i <= 3; i++) {
    const updates = sim.updateActiveTrades(candle(i, 20040, 20060, 20010, 20050));
    assert.equal(updates.length, 0, `no events expected on candle ${i}`);
  }
  assert.equal(sim.getPendingOrders().length, 1, 'order still pending');
});

test('sell-stop fills at stopPrice - stopOrderSlippage when low touches, and re-anchors from actual fill', () => {
  const sim = makeSim();
  sim.processSignal(sellStopSignal({ stopDistance: 20, targetDistance: 40 }), T0);
  sim.updateActiveTrades(candle(1, 20040, 20060, 20010, 20050)); // no touch
  const updates = sim.updateActiveTrades(candle(2, 20005, 20015, 19999, 20001)); // low 19999 <= 20000
  assert.equal(updates.length, 1);
  assert.equal(updates[0].event, 'entry_filled');
  assert.equal(updates[0].fillPrice, 19999.5, 'fills at 20000 - 0.5 slip');
  const trade = sim.getActiveTrades()[0];
  assert.equal(trade.actualEntry, 19999.5);
  assert.equal(trade.stopLoss, 20019.5, 'stopDistance re-anchored from actual fill');
  assert.equal(trade.takeProfit, 19959.5, 'targetDistance re-anchored from actual fill');
});

test('sell-stop gap-through chases: open below stop fills at open - slip (no improvement)', () => {
  const sim = makeSim();
  sim.processSignal(sellStopSignal(), T0);
  const updates = sim.updateActiveTrades(candle(1, 19990, 19995, 19980, 19985));
  assert.equal(updates[0].event, 'entry_filled');
  assert.equal(updates[0].fillPrice, 19989.5, 'fills at open 19990 - 0.5, NOT at stopPrice');
});

test('buy-stop above market fills at stopPrice + slip on touch; gap-through at open + slip', () => {
  const sim = makeSim();
  sim.processSignal({ action: 'place_stop', side: 'buy', symbol: 'NQH6', price: 20000, quantity: 1, strategy: 'TEST' }, T0);
  sim.updateActiveTrades(candle(1, 19950, 19980, 19940, 19970)); // below — no fill
  assert.equal(sim.getPendingOrders().length, 1);
  const updates = sim.updateActiveTrades(candle(2, 19995, 20001, 19990, 19998)); // high 20001 >= 20000
  assert.equal(updates[0].event, 'entry_filled');
  assert.equal(updates[0].fillPrice, 20000.5);

  const sim2 = makeSim();
  sim2.processSignal({ action: 'place_stop', side: 'buy', symbol: 'NQH6', price: 20000, quantity: 1, strategy: 'TEST' }, T0);
  const u2 = sim2.updateActiveTrades(candle(1, 20010, 20030, 20005, 20020)); // gaps above stop
  assert.equal(u2[0].fillPrice, 20010.5, 'chases from open 20010 + 0.5');
});

test('timeoutCandles cancels an unfilled pending stop entry', () => {
  const sim = makeSim();
  sim.processSignal(sellStopSignal({ timeoutCandles: 3 }), T0);
  let cancelled = null;
  for (let i = 1; i <= 3; i++) {
    const updates = sim.updateActiveTrades(candle(i, 20040, 20060, 20010, 20050));
    if (updates.length) cancelled = updates[0];
  }
  assert.ok(cancelled, 'expected a cancel event');
  assert.equal(cancelled.event, 'order_cancelled');
  assert.equal(cancelled.cancelReason, 'timeout');
  assert.equal(sim.getPendingOrders().length, 0);
});

test('1s path: sell-stop fills on the first second bar whose low touches', () => {
  const sim = makeSim();
  sim.processSignal(sellStopSignal({ stopDistance: 20 }), T0);
  const minuteCandle = candle(1, 20010, 20015, 19998, 20000);
  const secs = [
    { timestamp: T0 + MIN + 0, open: 20010, high: 20012, low: 20008, close: 20009, symbol: 'NQH6' },
    { timestamp: T0 + MIN + 1000, open: 20009, high: 20010, low: 20003, close: 20004, symbol: 'NQH6' },
    { timestamp: T0 + MIN + 2000, open: 20004, high: 20005, low: 19999, close: 20000, symbol: 'NQH6' }, // touch
  ];
  sim.updateActiveTradesWithSeconds(secs, minuteCandle);
  const trade = sim.getActiveTrades()[0];
  assert.equal(trade.status, 'active');
  assert.equal(trade.actualEntry, 19999.5);
  assert.equal(trade.entryTime, T0 + MIN + 2000, 'filled on the touching 1s bar');
  assert.equal(trade.stopLoss, 20019.5, 'stopDistance re-anchored on 1s fill');
});

test('regression: buy limit still fills at exact limit price with zero slippage', () => {
  const sim = makeSim();
  sim.processSignal({ action: 'place_limit', side: 'buy', symbol: 'NQH6', price: 20000, quantity: 1, strategy: 'TEST' }, T0);
  sim.updateActiveTrades(candle(1, 20010, 20020, 20005, 20015)); // above — no fill
  const updates = sim.updateActiveTrades(candle(2, 20005, 20010, 19999, 20002));
  assert.equal(updates[0].event, 'entry_filled');
  assert.equal(updates[0].fillPrice, 20000, 'limit fills at limit, no slip');
});
