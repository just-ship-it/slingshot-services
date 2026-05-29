/**
 * Strategy-attribution exit policy.
 *
 * The exit policy for a trade (break-even, max-hold, trailing) belongs to the
 * (strategy, ruleId) that produced it — NOT to the particular inbound payload.
 * Signals emitted by the signal-generator carry this metadata, but signals that
 * are *replayed* do not: a manual dashboard "Resend" reconstructs the signal
 * from the persisted alert, whose payload omits the breakeven and max-hold
 * fields. Without this module such a resend would open a position with no
 * break-even and no max-hold, leaving its stop frozen at the original bracket.
 *
 * These helpers cache the canonical exit policy per (strategy, ruleId) from any
 * signal that carries it, and re-apply it by attribution to signals that arrive
 * without it. The cache is keyed per-rule (not per-strategy) so per-rule
 * strategies like gex-lt-3m-crossover (S_GF_SOLO ≠ S_CW ≠ L_S4 ≠ S_R4) keep
 * distinct policies.
 *
 * Pure functions over a caller-owned Map so they can be unit-tested and so the
 * orchestrator can persist/restore the Map across restarts.
 */

export function strategyRuleKey(strategy, ruleId) {
  return `${strategy}|${ruleId || '_'}`;
}

// Cache the canonical exit policy for a (strategy, ruleId) when a signal
// actually carries it. Skips empty captures so a stripped Resend can't clobber
// a good profile. The set stays tiny (one entry per live rule), so no eviction.
export function recordStrategyRuleProfile(map, signal, exitRules) {
  if (!map || !signal?.strategy) return;
  const hasMeta = (Array.isArray(exitRules) && exitRules.length > 0) || signal.maxHoldBars != null;
  if (!hasMeta) return;
  map.set(strategyRuleKey(signal.strategy, signal.ruleId), {
    maxHoldBars: signal.maxHoldBars ?? null,
    exitRules: Array.isArray(exitRules) ? exitRules : [],
    recordedAt: Date.now(),
  });
}

// Look up the canonical exit policy for an attributed (strategy, ruleId).
export function getStrategyRuleProfile(map, strategy, ruleId) {
  if (!map || !strategy || strategy === 'UNATTRIBUTED') return null;
  return map.get(strategyRuleKey(strategy, ruleId)) || null;
}

// Enforce the strategy's exit policy on a signal regardless of where it
// originated. Refreshes the profile from this signal first (so a full signal
// keeps the cache warm even when it's later gate-rejected), then backfills any
// missing exit rules / max-hold from the cached (strategy, ruleId) profile.
// Mutates `signal.maxHoldBars` and returns the effective exitRules array.
export function applyStrategyRuleProfile(map, signal, capturedRules, { logger, logId } = {}) {
  let exitRules = Array.isArray(capturedRules) ? capturedRules : [];
  recordStrategyRuleProfile(map, signal, exitRules);
  const profile = getStrategyRuleProfile(map, signal.strategy, signal.ruleId);
  if (!profile) return exitRules;
  const key = strategyRuleKey(signal.strategy, signal.ruleId);
  if (exitRules.length === 0 && profile.exitRules.length > 0) {
    exitRules = profile.exitRules;
    logger?.warn?.(`[${logId}] no exit rules on signal — backfilled ${exitRules.length} from ${key} profile (origin likely a resend/replay)`);
  }
  if (signal.maxHoldBars == null && profile.maxHoldBars != null) {
    signal.maxHoldBars = profile.maxHoldBars;
    logger?.info?.(`[${logId}] backfilled maxHoldBars=${signal.maxHoldBars} from ${key} profile`);
  }
  return exitRules;
}
