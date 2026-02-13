import { createLogger } from '../shared/index.js';

const logger = createLogger('cross-strategy-filter');

/**
 * Cross-strategy signal filtering rules.
 * Each rule defines when an incoming signal should be rejected or adjusted
 * based on existing positions in a different underlying.
 */
const CROSS_STRATEGY_RULES = [
  {
    name: 'nq-es-directional-veto',
    enabled: true,
    description: 'Veto ES signals when NQ has an opposite-direction position',
    incoming: { underlying: 'ES' },
    existing: { underlying: 'NQ' },
    relationship: 'opposite',   // 'opposite' | 'same' | 'any'
    action: 'reject',           // 'reject' | 'adjust_quantity'
    quantityMultiplier: null,
  },
  // Example: future confluence-boost rule (disabled)
  // {
  //   name: 'nq-es-confluence-boost',
  //   enabled: false,
  //   description: 'Increase ES quantity when NQ has a same-direction position',
  //   incoming: { underlying: 'ES' },
  //   existing: { underlying: 'NQ' },
  //   relationship: 'same',
  //   action: 'adjust_quantity',
  //   quantityMultiplier: 1.5,
  // },
];

const BYPASS_ACTIONS = new Set(['position_closed', 'cancel_limit', 'update_limit', 'modify_stop']);

/**
 * Evaluate cross-strategy rules against an incoming signal.
 *
 * @param {Object} signal - The parsed trade signal
 * @param {string} signalUnderlying - Normalized underlying (e.g. 'NQ', 'ES')
 * @param {string} signalDirection - 'long' or 'short'
 * @param {Map<string, {position: string, source: string}>} positions - strategyState.positions map
 * @returns {{ allowed: boolean, reason?: string, ruleName?: string, adjustments?: Object }}
 */
export function evaluateCrossStrategyRules(signal, signalUnderlying, signalDirection, positions) {
  // Global kill switch
  if (process.env.CROSS_STRATEGY_FILTER_ENABLED === 'false') {
    return { allowed: true };
  }

  // Non-entry actions bypass filter
  if (BYPASS_ACTIONS.has(signal.action)) {
    return { allowed: true };
  }

  for (const rule of CROSS_STRATEGY_RULES) {
    if (!rule.enabled) continue;

    // Does this rule apply to the incoming signal's underlying?
    if (rule.incoming.underlying !== signalUnderlying) continue;

    // Is there an existing position in the rule's target underlying?
    const existingPos = positions.get(rule.existing.underlying);
    if (!existingPos) continue;

    const existingDirection = existingPos.position; // 'long' or 'short'

    // Check direction relationship
    const directionsMatch = signalDirection === existingDirection;
    const relationshipTriggered =
      (rule.relationship === 'opposite' && !directionsMatch) ||
      (rule.relationship === 'same' && directionsMatch) ||
      (rule.relationship === 'any');

    if (!relationshipTriggered) continue;

    // Rule matched
    if (rule.action === 'reject') {
      const reason = `${rule.name}: ${signalUnderlying} ${signalDirection} signal vetoed — ${rule.existing.underlying} has ${existingDirection} position (${existingPos.source})`;
      logger.warn(`[CROSS-FILTER] ${reason}`);
      return { allowed: false, reason, ruleName: rule.name };
    }

    if (rule.action === 'adjust_quantity' && rule.quantityMultiplier != null) {
      const reason = `${rule.name}: quantity adjusted x${rule.quantityMultiplier} — ${rule.existing.underlying} has ${existingDirection} position`;
      logger.info(`[CROSS-FILTER] ${reason}`);
      return {
        allowed: true,
        reason,
        ruleName: rule.name,
        adjustments: { quantityMultiplier: rule.quantityMultiplier },
      };
    }
  }

  return { allowed: true };
}

/**
 * Return sanitized rules config for health/status endpoints.
 */
export function getCrossStrategyRules() {
  return CROSS_STRATEGY_RULES.filter(r => r.enabled).map(r => ({
    name: r.name,
    description: r.description,
    incoming: r.incoming.underlying,
    existing: r.existing.underlying,
    relationship: r.relationship,
    action: r.action,
  }));
}
