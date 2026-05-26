/**
 * AI-driven meta-rule: takes a validated ruleset and produces the
 * shouldAccept/shouldPreempt callbacks the meta-engine consumes.
 *
 * Rule semantics:
 * - enabled=false OR side ∉ allowedSides OR ET hour ∈ blockedHoursET → reject.
 * - Signal's entry within any noEntryZones [low,high] → reject.
 * - Signal's entry within `proximityPts` of any directionalLevelGuards where
 *   guard.blockedSide === signal.side → reject.
 * - When flat: accept (if all gates pass).
 * - When in position: preempt only if (a) incoming priority < held priority,
 *   AND (b) all the same gates pass for the incoming signal.
 */

function etHour(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  for (const p of parts) if (p.type === 'hour') return parseInt(p.value, 10);
  return null;
}

function normSide(s) {
  const x = String(s || '').toLowerCase();
  if (x === 'long' || x === 'buy') return 'long';
  if (x === 'short' || x === 'sell') return 'short';
  return null;
}

function gatesPass(sig, ruleset) {
  const side = normSide(sig.side);
  if (!side) return { ok: false, reason: 'invalid_side' };

  const sCfg = ruleset.strategies[sig.strategy];
  if (!sCfg) return { ok: false, reason: 'unknown_strategy' };
  if (!sCfg.enabled) return { ok: false, reason: 'ai_disabled' };
  if (!sCfg.allowedSides.includes(side)) return { ok: false, reason: 'ai_side_blocked' };
  const h = etHour(sig.ts);
  if (sCfg.blockedHoursET.includes(h)) return { ok: false, reason: `ai_hour_blocked_${h}ET` };

  const entry = sig.entryPrice;
  if (Number.isFinite(entry)) {
    // No-entry zones
    for (const z of ruleset.noEntryZones) {
      if (entry >= z.low && entry <= z.high) {
        return { ok: false, reason: `ai_no_entry_zone_${z.low}-${z.high}` };
      }
    }
    // Directional level guards
    for (const g of ruleset.directionalLevelGuards) {
      if (g.blockedSide === side && Math.abs(entry - g.price) <= g.proximityPts) {
        return { ok: false, reason: `ai_level_guard_${g.blockedSide}@${g.price}` };
      }
    }
  }
  return { ok: true };
}

// Returns a copy of the ruleset with every strategy forced to enabled=true
// and allowedSides=['long','short']. Used by protect-strategies mode to block
// the AI's most destructive lever (disabling a strategy on a recent losing
// streak). 6-month run showed glf went from +$30,730 → -$9,193 entirely
// because the AI kept disabling it.
function forceStrategiesOpen(ruleset) {
  const out = { ...ruleset, strategies: {} };
  for (const k of Object.keys(ruleset.strategies)) {
    out.strategies[k] = {
      ...ruleset.strategies[k],
      enabled: true,
      allowedSides: ['long', 'short'],
    };
  }
  return out;
}

// Strip level guards + no-entry zones from a ruleset (used by priority-hours
// mode and lstb-only-guards mode's per-strategy filter).
function stripLevelGuards(ruleset) {
  return { ...ruleset, directionalLevelGuards: [], noEntryZones: [] };
}

// Filter a ruleset's level guards + no-entry zones to apply ONLY to the
// specified strategy. Other strategies see an empty guards/zones list.
function guardsOnlyForStrategy(ruleset, signalStrategy, targetStrategy) {
  if (signalStrategy === targetStrategy) return ruleset;
  return stripLevelGuards(ruleset);
}

export function createAiRule(getRulesetForTs, mode = 'full') {
  // PRIORITY-HOURS mode: protect-strategies + strip level guards/zones too.
  // Tests whether glf recovers fully when the only AI levers are priority
  // and per-strategy blocked hours.
  if (mode === 'priority-hours') {
    return {
      name: 'ai-priority-hours',
      shouldAccept(sig, _state) {
        const ruleset = stripLevelGuards(forceStrategiesOpen(getRulesetForTs(sig.ts)));
        return gatesPass(sig, ruleset);
      },
      shouldPreempt(sig, position, _state) {
        const ruleset = stripLevelGuards(forceStrategiesOpen(getRulesetForTs(sig.ts)));
        const gate = gatesPass(sig, ruleset);
        if (!gate.ok) return gate;
        const incomingPri = ruleset.strategies[sig.strategy]?.priority ?? 9;
        const heldPri = ruleset.strategies[position.strategy]?.priority ?? 9;
        if (incomingPri < heldPri) return { ok: true };
        return { ok: false, reason: `ai_no_preempt_p${incomingPri}_vs_p${heldPri}` };
      },
    };
  }

  // LSTB-ONLY-GUARDS mode: protect-strategies + level guards/zones apply
  // ONLY to lstb signals. glf/glx/gfi see empty guards. Targets the
  // collision: glf IS the level-fade — AI's "no shorts at H" was killing
  // glf's intentional level-fade entries. By scoping guards to lstb only,
  // AI can still add structural noise filters where they help most without
  // colliding with strategies that own that pattern.
  if (mode === 'lstb-only-guards') {
    const TARGET = 'ls-flip-trigger-bar';
    return {
      name: 'ai-lstb-only-guards',
      shouldAccept(sig, _state) {
        const ruleset = guardsOnlyForStrategy(
          forceStrategiesOpen(getRulesetForTs(sig.ts)),
          sig.strategy,
          TARGET,
        );
        return gatesPass(sig, ruleset);
      },
      shouldPreempt(sig, position, _state) {
        const ruleset = guardsOnlyForStrategy(
          forceStrategiesOpen(getRulesetForTs(sig.ts)),
          sig.strategy,
          TARGET,
        );
        const gate = gatesPass(sig, ruleset);
        if (!gate.ok) return gate;
        const incomingPri = ruleset.strategies[sig.strategy]?.priority ?? 9;
        const heldPri = ruleset.strategies[position.strategy]?.priority ?? 9;
        if (incomingPri < heldPri) return { ok: true };
        return { ok: false, reason: `ai_no_preempt_p${incomingPri}_vs_p${heldPri}` };
      },
    };
  }

  // PROTECT-STRATEGIES mode: full ruleset honored EXCEPT enabled and
  // allowedSides — those are force-overridden to keep every strategy open
  // on both sides. AI can still adjust priority, blocked hours, level guards,
  // no-entry zones.
  if (mode === 'protect-strategies') {
    return {
      name: 'ai-protect-strategies',
      shouldAccept(sig, _state) {
        const ruleset = forceStrategiesOpen(getRulesetForTs(sig.ts));
        return gatesPass(sig, ruleset);
      },
      shouldPreempt(sig, position, _state) {
        const ruleset = forceStrategiesOpen(getRulesetForTs(sig.ts));
        const gate = gatesPass(sig, ruleset);
        if (!gate.ok) return gate;
        const incomingPri = ruleset.strategies[sig.strategy]?.priority ?? 9;
        const heldPri = ruleset.strategies[position.strategy]?.priority ?? 9;
        if (incomingPri < heldPri) return { ok: true };
        return { ok: false, reason: `ai_no_preempt_p${incomingPri}_vs_p${heldPri}` };
      },
    };
  }

  // PREEMPT-ONLY mode: ignore enabled/sides/hours/guards/zones. Only honor
  // priority. Used to test whether shifting slot ownership across strategies
  // alone adds value, independent of any blocking behavior.
  if (mode === 'preempt-only') {
    return {
      name: 'ai-preempt-only',
      shouldAccept: () => ({ ok: true }),  // always accept when flat
      shouldPreempt(sig, position, _state) {
        const ruleset = getRulesetForTs(sig.ts);
        const incomingPri = ruleset.strategies[sig.strategy]?.priority ?? 9;
        const heldPri = ruleset.strategies[position.strategy]?.priority ?? 9;
        if (incomingPri < heldPri) return { ok: true };
        return { ok: false, reason: `ai_no_preempt_p${incomingPri}_vs_p${heldPri}` };
      },
    };
  }

  // FULL mode (default): honor all fields.
  return {
    name: 'ai',
    shouldAccept(sig, _state) {
      const ruleset = getRulesetForTs(sig.ts);
      return gatesPass(sig, ruleset);
    },
    shouldPreempt(sig, position, _state) {
      const ruleset = getRulesetForTs(sig.ts);
      const gate = gatesPass(sig, ruleset);
      if (!gate.ok) return gate;
      const incomingPri = ruleset.strategies[sig.strategy]?.priority ?? 9;
      const heldPri = ruleset.strategies[position.strategy]?.priority ?? 9;
      // Lower priority value wins. Strictly lower (no equal-priority preempt).
      if (incomingPri < heldPri) return { ok: true };
      return { ok: false, reason: `ai_no_preempt_p${incomingPri}_vs_p${heldPri}` };
    },
  };
}
