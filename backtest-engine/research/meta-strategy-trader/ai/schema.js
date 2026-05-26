/**
 * AI ruleset schema + strict validator.
 *
 * The AI emits one ruleset JSON per trading session. The meta-engine reads
 * the ruleset and gates signals accordingly. Schema is intentionally TIGHT
 * to prevent the AI from inventing fields the engine can't honor.
 *
 * Safety guardrails reject pathological rulesets (e.g., a 200-pt no-entry
 * zone that effectively halts trading); validation failures fall back to
 * plain FCFS for that session.
 */

const STRATEGY_KEYS = new Set([
  'ls-flip-trigger-bar',
  'gex-flip-ivpct',
  'gex-lt-3m-crossover',
  'gex-level-fade',
]);

// Limits — tuned to leave the AI useful freedom while preventing day-killers.
const MAX_NO_ENTRY_ZONES = 5;
const MAX_NO_ENTRY_ZONE_WIDTH_PTS = 30;
const MAX_DIRECTIONAL_GUARDS = 5;
const MAX_GUARD_PROXIMITY_PTS = 30;
const MAX_BLOCKED_HOURS_PER_STRATEGY = 18;
const ALLOWED_SIDES = new Set(['long', 'short']);

// Default schema-shaped ruleset (used as a starting point / fallback).
export function defaultRuleset() {
  return {
    rationale: 'fallback: FCFS no overrides',
    strategies: {
      'ls-flip-trigger-bar':  { enabled: true, priority: 4, allowedSides: ['long', 'short'], blockedHoursET: [] },
      'gex-flip-ivpct':       { enabled: true, priority: 1, allowedSides: ['long', 'short'], blockedHoursET: [] },
      'gex-lt-3m-crossover':  { enabled: true, priority: 2, allowedSides: ['long', 'short'], blockedHoursET: [] },
      'gex-level-fade':       { enabled: true, priority: 3, allowedSides: ['long', 'short'], blockedHoursET: [] },
    },
    directionalLevelGuards: [],
    noEntryZones: [],
  };
}

// Pretty-printed schema description, embedded in the system prompt so the AI
// knows the exact shape and constraints. Update both this string and the
// validator in lockstep.
export const SCHEMA_DESCRIPTION = `\
RULESET JSON SHAPE (emit exactly this — no extra fields, no missing required fields):

{
  "rationale": "<one short sentence on why these rules — for human review only>",
  "strategies": {
    "ls-flip-trigger-bar": {
      "enabled":        true|false,
      "priority":       <int 1-9, lower = wins ties when two signals arrive same ms>,
      "allowedSides":   ["long","short"],   // subset; ["long"] = longs only, [] = none (same as disabled=false)
      "blockedHoursET": [<int 0-23>, ...]   // ET clock hours during which NO entry accepted
    },
    "gex-flip-ivpct":      { ...same shape... },
    "gex-lt-3m-crossover": { ...same shape... },
    "gex-level-fade":      { ...same shape... }
  },
  "directionalLevelGuards": [
    { "price": <number>, "blockedSide": "long"|"short", "proximityPts": <number 1-${MAX_GUARD_PROXIMITY_PTS}>, "reason": "<text>" }
    // max ${MAX_DIRECTIONAL_GUARDS} entries. Means: reject any signal whose entryPrice is within proximityPts of price, on the blocked side.
    // Use to express "don't take SHORTS at major support" or "don't take LONGS at resistance".
  ],
  "noEntryZones": [
    { "low": <number>, "high": <number>, "reason": "<text>" }
    // max ${MAX_NO_ENTRY_ZONES} entries, each at most ${MAX_NO_ENTRY_ZONE_WIDTH_PTS} pts wide.
    // Means: reject ANY signal (either side) with entryPrice inside [low, high].
  ]
}

CONSTRAINTS the validator enforces (failure → fall back to plain FCFS for the day):
- All 4 strategies must be present in the "strategies" map with all 4 fields each.
- priority: integer 1-9. Lower wins ties.
- allowedSides: subset of ["long","short"]. Empty allowed (effectively disables side).
- blockedHoursET: each integer in [0, 23]; max ${MAX_BLOCKED_HOURS_PER_STRATEGY} entries per strategy.
- directionalLevelGuards: max ${MAX_DIRECTIONAL_GUARDS}. proximityPts ≤ ${MAX_GUARD_PROXIMITY_PTS}.
- noEntryZones: max ${MAX_NO_ENTRY_ZONES}. high > low, (high - low) ≤ ${MAX_NO_ENTRY_ZONE_WIDTH_PTS}.
`;

export class ValidationError extends Error {
  constructor(msg, field) {
    super(msg);
    this.field = field;
  }
}

/**
 * Validate a parsed ruleset against the schema. Throws ValidationError on
 * the first violation. Returns the (untouched) ruleset on success — callers
 * may want to also `defaultRuleset()` and merge missing fields, but the
 * strict mode used here treats any missing/wrong field as failure so the
 * AI is forced to emit clean output.
 */
export function validate(ruleset) {
  if (!ruleset || typeof ruleset !== 'object') {
    throw new ValidationError('ruleset must be an object', 'root');
  }
  if (typeof ruleset.rationale !== 'string' || ruleset.rationale.length === 0) {
    throw new ValidationError('rationale must be a non-empty string', 'rationale');
  }
  if (!ruleset.strategies || typeof ruleset.strategies !== 'object') {
    throw new ValidationError('strategies must be an object', 'strategies');
  }
  for (const key of STRATEGY_KEYS) {
    const s = ruleset.strategies[key];
    if (!s || typeof s !== 'object') {
      throw new ValidationError(`strategies.${key} missing or wrong type`, `strategies.${key}`);
    }
    if (typeof s.enabled !== 'boolean') {
      throw new ValidationError(`strategies.${key}.enabled must be boolean`, `strategies.${key}.enabled`);
    }
    if (!Number.isInteger(s.priority) || s.priority < 1 || s.priority > 9) {
      throw new ValidationError(`strategies.${key}.priority must be int 1-9`, `strategies.${key}.priority`);
    }
    if (!Array.isArray(s.allowedSides)) {
      throw new ValidationError(`strategies.${key}.allowedSides must be array`, `strategies.${key}.allowedSides`);
    }
    for (const side of s.allowedSides) {
      if (!ALLOWED_SIDES.has(side)) {
        throw new ValidationError(`strategies.${key}.allowedSides contains ${side} (only "long"/"short" allowed)`, `strategies.${key}.allowedSides`);
      }
    }
    if (!Array.isArray(s.blockedHoursET)) {
      throw new ValidationError(`strategies.${key}.blockedHoursET must be array`, `strategies.${key}.blockedHoursET`);
    }
    if (s.blockedHoursET.length > MAX_BLOCKED_HOURS_PER_STRATEGY) {
      throw new ValidationError(`strategies.${key}.blockedHoursET >${MAX_BLOCKED_HOURS_PER_STRATEGY} entries`, `strategies.${key}.blockedHoursET`);
    }
    for (const h of s.blockedHoursET) {
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        throw new ValidationError(`strategies.${key}.blockedHoursET contains ${h} (must be int 0-23)`, `strategies.${key}.blockedHoursET`);
      }
    }
  }
  // Unknown strategy keys → reject (AI must not invent strategies).
  for (const key of Object.keys(ruleset.strategies)) {
    if (!STRATEGY_KEYS.has(key)) {
      throw new ValidationError(`strategies.${key} is not a known strategy`, `strategies.${key}`);
    }
  }
  // Optional: directionalLevelGuards
  if (ruleset.directionalLevelGuards != null) {
    if (!Array.isArray(ruleset.directionalLevelGuards)) {
      throw new ValidationError('directionalLevelGuards must be array', 'directionalLevelGuards');
    }
    if (ruleset.directionalLevelGuards.length > MAX_DIRECTIONAL_GUARDS) {
      throw new ValidationError(`directionalLevelGuards >${MAX_DIRECTIONAL_GUARDS} entries`, 'directionalLevelGuards');
    }
    for (const [i, g] of ruleset.directionalLevelGuards.entries()) {
      if (!Number.isFinite(g.price)) {
        throw new ValidationError(`directionalLevelGuards[${i}].price must be number`, `directionalLevelGuards[${i}].price`);
      }
      if (!ALLOWED_SIDES.has(g.blockedSide)) {
        throw new ValidationError(`directionalLevelGuards[${i}].blockedSide must be "long"/"short"`, `directionalLevelGuards[${i}].blockedSide`);
      }
      if (!Number.isFinite(g.proximityPts) || g.proximityPts <= 0 || g.proximityPts > MAX_GUARD_PROXIMITY_PTS) {
        throw new ValidationError(`directionalLevelGuards[${i}].proximityPts must be 0<x<=${MAX_GUARD_PROXIMITY_PTS}`, `directionalLevelGuards[${i}].proximityPts`);
      }
    }
  } else {
    ruleset.directionalLevelGuards = [];
  }
  // Optional: noEntryZones
  if (ruleset.noEntryZones != null) {
    if (!Array.isArray(ruleset.noEntryZones)) {
      throw new ValidationError('noEntryZones must be array', 'noEntryZones');
    }
    if (ruleset.noEntryZones.length > MAX_NO_ENTRY_ZONES) {
      throw new ValidationError(`noEntryZones >${MAX_NO_ENTRY_ZONES} entries`, 'noEntryZones');
    }
    for (const [i, z] of ruleset.noEntryZones.entries()) {
      if (!Number.isFinite(z.low) || !Number.isFinite(z.high)) {
        throw new ValidationError(`noEntryZones[${i}] low/high must be numbers`, `noEntryZones[${i}]`);
      }
      if (z.high <= z.low) {
        throw new ValidationError(`noEntryZones[${i}].high must be > low`, `noEntryZones[${i}]`);
      }
      if ((z.high - z.low) > MAX_NO_ENTRY_ZONE_WIDTH_PTS) {
        throw new ValidationError(`noEntryZones[${i}] width ${(z.high - z.low).toFixed(1)}pt > max ${MAX_NO_ENTRY_ZONE_WIDTH_PTS}`, `noEntryZones[${i}]`);
      }
    }
  } else {
    ruleset.noEntryZones = [];
  }
  return ruleset;
}
