import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGammaFilter, readGammaFilterConfig, GAMMA_FILTER_DEFAULTS } from './gamma-filter.js';

const ON = { enabled: true, blockShortsInPositive: true, blockFadeInNegative: true };

test('disabled → never acts, always allows', () => {
  const r = evaluateGammaFilter({ strategy: 'LS_FLIP_TRIGGER_BAR', side: 'short' }, 'positive', { ...ON, enabled: false });
  assert.equal(r.allowed, true); assert.equal(r.acted, false); assert.equal(r.degraded, false);
});

test('non-entry action bypasses even when enabled', () => {
  const r = evaluateGammaFilter({ strategy: 'GEX_LEVEL_FADE', side: 'short', action: 'position_closed' }, 'negative', ON);
  assert.equal(r.allowed, true); assert.equal(r.acted, false);
});

test('FAIL-OPEN + degraded when regime unknown and enabled', () => {
  for (const reg of [null, undefined, 'neutral', '']) {
    const r = evaluateGammaFilter({ strategy: 'GEX_FLIP_IVPCT', side: 'short' }, reg, ON);
    assert.equal(r.allowed, true, `allowed for regime=${reg}`);
    assert.equal(r.acted, false);
    assert.equal(r.degraded, true, `degraded for regime=${reg}`);
  }
});

test('Rule A: short blocked in positive gamma (any strategy)', () => {
  for (const strat of ['LS_FLIP_TRIGGER_BAR', 'GEX_LT_3M_CROSSOVER', 'GEX_FLIP_IVPCT', 'GEX_LEVEL_FADE']) {
    const r = evaluateGammaFilter({ strategy: strat, side: 'short' }, 'positive', ON);
    assert.equal(r.allowed, false, strat); assert.equal(r.acted, true); assert.equal(r.ruleName, 'short_in_positive_gamma');
  }
});

test('Rule A does NOT block longs in positive gamma', () => {
  const r = evaluateGammaFilter({ strategy: 'LS_FLIP_TRIGGER_BAR', side: 'long' }, 'positive', ON);
  assert.equal(r.allowed, true); assert.equal(r.acted, true); assert.equal(r.reason, 'passed');
});

test('Rule A does NOT block shorts in negative gamma', () => {
  const r = evaluateGammaFilter({ strategy: 'GEX_LT_3M_CROSSOVER', side: 'short' }, 'negative', ON);
  assert.equal(r.allowed, true); assert.equal(r.acted, true);
});

test('Rule B: GEX_LEVEL_FADE blocked in negative gamma (either side)', () => {
  for (const side of ['long', 'short']) {
    const r = evaluateGammaFilter({ strategy: 'GEX_LEVEL_FADE', side }, 'negative', ON);
    assert.equal(r.allowed, false, side); assert.equal(r.ruleName, 'fade_in_negative_gamma');
  }
});

test('Rule B does NOT block level-fade in positive gamma (long)', () => {
  const r = evaluateGammaFilter({ strategy: 'GEX_LEVEL_FADE', side: 'long' }, 'positive', ON);
  assert.equal(r.allowed, true); assert.equal(r.acted, true);
});

test('per-rule toggles work independently', () => {
  const onlyFade = { enabled: true, blockShortsInPositive: false, blockFadeInNegative: true };
  assert.equal(evaluateGammaFilter({ strategy: 'LS_FLIP_TRIGGER_BAR', side: 'short' }, 'positive', onlyFade).allowed, true);
  assert.equal(evaluateGammaFilter({ strategy: 'GEX_LEVEL_FADE', side: 'long' }, 'negative', onlyFade).allowed, false);
});

test('side synonyms (buy/sell) normalize', () => {
  assert.equal(evaluateGammaFilter({ strategy: 'X', side: 'sell' }, 'positive', ON).allowed, false);
  assert.equal(evaluateGammaFilter({ strategy: 'X', side: 'buy' }, 'positive', ON).allowed, true);
});

test('config reader: defaults OFF, env parses', () => {
  assert.equal(readGammaFilterConfig({}).enabled, false);
  const c = readGammaFilterConfig({ GAMMA_FILTER_ENABLED: 'true', GAMMA_FILTER_BLOCK_SHORTS_POS: 'false' });
  assert.equal(c.enabled, true); assert.equal(c.blockShortsInPositive, false); assert.equal(c.blockFadeInNegative, true);
});
