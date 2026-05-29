import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  strategyRuleKey,
  recordStrategyRuleProfile,
  getStrategyRuleProfile,
  applyStrategyRuleProfile,
} from '../src/strategy-rule-profile.js';

// A full signal-generator-emitted signal carries its exit policy.
function fullSignal(over = {}) {
  return {
    strategy: 'GEX_LT_3M_CROSSOVER',
    ruleId: 'S_GF_SOLO',
    side: 'short',
    breakevenStop: true,
    breakevenTrigger: 80,
    breakevenOffset: 20,
    maxHoldBars: 120,
    ...over,
  };
}

// A dashboard "Resend" reconstructs from the alert payload, which omits
// breakeven_*/maxHoldBars — so the replayed signal has no exit policy.
function resendSignal(over = {}) {
  return {
    strategy: 'GEX_LT_3M_CROSSOVER',
    ruleId: 'S_GF_SOLO',
    side: 'short',
    stop_loss: 30561.25,
    take_profit: 30311.25,
    ...over,
  };
}

const BE_RULE = { type: 'breakeven', trigger: 80, offset: 20 };

test('key is per-rule, not per-strategy', () => {
  assert.equal(strategyRuleKey('GEX_LT_3M_CROSSOVER', 'S_CW'), 'GEX_LT_3M_CROSSOVER|S_CW');
  assert.notEqual(
    strategyRuleKey('GEX_LT_3M_CROSSOVER', 'S_CW'),
    strategyRuleKey('GEX_LT_3M_CROSSOVER', 'S_GF_SOLO'),
  );
  assert.equal(strategyRuleKey('LS_FLIP_TRIGGER_BAR', undefined), 'LS_FLIP_TRIGGER_BAR|_');
});

test('records profile only when signal carries exit metadata', () => {
  const map = new Map();
  recordStrategyRuleProfile(map, resendSignal(), []); // no meta → no record
  assert.equal(map.size, 0);
  recordStrategyRuleProfile(map, fullSignal(), [BE_RULE]);
  assert.equal(map.size, 1);
  const p = getStrategyRuleProfile(map, 'GEX_LT_3M_CROSSOVER', 'S_GF_SOLO');
  assert.equal(p.maxHoldBars, 120);
  assert.deepEqual(p.exitRules, [BE_RULE]);
});

test('a stripped resend cannot clobber a good profile', () => {
  const map = new Map();
  recordStrategyRuleProfile(map, fullSignal(), [BE_RULE]);
  recordStrategyRuleProfile(map, resendSignal(), []); // must be ignored
  assert.deepEqual(getStrategyRuleProfile(map, 'GEX_LT_3M_CROSSOVER', 'S_GF_SOLO').exitRules, [BE_RULE]);
});

test('resend backfills BE + maxHold from the (strategy, ruleId) profile', () => {
  const map = new Map();
  // 1) full signal warms the cache
  applyStrategyRuleProfile(map, fullSignal(), [BE_RULE], {});
  // 2) resend arrives with no exit policy
  const resend = resendSignal();
  const effective = applyStrategyRuleProfile(map, resend, [], {});
  assert.deepEqual(effective, [BE_RULE], 'exit rules backfilled');
  assert.equal(resend.maxHoldBars, 120, 'maxHoldBars backfilled onto the signal');
});

test('per-rule isolation: S_CW resend does not inherit S_GF_SOLO policy', () => {
  const map = new Map();
  applyStrategyRuleProfile(map, fullSignal({ ruleId: 'S_GF_SOLO', maxHoldBars: 120 }), [BE_RULE], {});
  const cwResend = resendSignal({ ruleId: 'S_CW' });
  const effective = applyStrategyRuleProfile(map, cwResend, [], {});
  assert.deepEqual(effective, [], 'no S_CW profile yet → no cross-rule bleed');
  assert.equal(cwResend.maxHoldBars, undefined);
});

test('a signal that carries its own rules is left intact (no override)', () => {
  const map = new Map();
  applyStrategyRuleProfile(map, fullSignal({ maxHoldBars: 120 }), [BE_RULE], {});
  // a fresh full signal with a DIFFERENT explicit maxHold keeps its own value
  const fresh = fullSignal({ maxHoldBars: 90 });
  const ownRule = { type: 'breakeven', trigger: 60, offset: 10 };
  const effective = applyStrategyRuleProfile(map, fresh, [ownRule], {});
  assert.deepEqual(effective, [ownRule], 'own rules preserved');
  assert.equal(fresh.maxHoldBars, 90, 'own maxHold preserved');
});

test('UNATTRIBUTED never resolves a profile', () => {
  const map = new Map();
  recordStrategyRuleProfile(map, fullSignal(), [BE_RULE]);
  assert.equal(getStrategyRuleProfile(map, 'UNATTRIBUTED', undefined), null);
});

console.log('strategy-rule-profile: all scenarios passed');
