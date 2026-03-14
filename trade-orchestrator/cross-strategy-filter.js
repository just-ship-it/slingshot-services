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
 * Same-underlying multi-strategy alert rules.
 * These produce informational alerts (not rejections) when noteworthy
 * multi-strategy conditions are detected.
 */
const STRATEGY_ALERT_RULES = [
  {
    name: 'isg-long-sdiv-short-conflict',
    enabled: true,
    description: 'Flag when IV-SKEW-GEX goes long but SHORT-DTE-IV is short on same underlying',
    incoming: { strategy: 'IV_SKEW_GEX', direction: 'long' },
    conflicting: { strategy: 'SHORT_DTE_IV', direction: 'short' },
    sameUnderlying: true,
    severity: 'warning',
    message: 'ISG long contradicts active SDIV short — ISG WR drops to 48%, SDIV 72% WR (n=25)',
  },
  {
    name: 'isg-short-sdiv-long-conflict',
    enabled: true,
    description: 'Flag when IV-SKEW-GEX goes short but SHORT-DTE-IV is long on same underlying',
    incoming: { strategy: 'IV_SKEW_GEX', direction: 'short' },
    conflicting: { strategy: 'SHORT_DTE_IV', direction: 'long' },
    sameUnderlying: true,
    severity: 'warning',
    message: 'ISG short contradicts active SDIV long — ISG 75% WR, SDIV 83% WR (n=12)',
  },
  {
    name: 'sdiv-long-isg-short-conflict',
    enabled: true,
    description: 'Flag when SHORT-DTE-IV goes long but IV-SKEW-GEX is short on same underlying',
    incoming: { strategy: 'SHORT_DTE_IV', direction: 'long' },
    conflicting: { strategy: 'IV_SKEW_GEX', direction: 'short' },
    sameUnderlying: true,
    severity: 'warning',
    message: 'SDIV long contradicts active ISG short — ISG 75% WR, SDIV 83% WR (n=12)',
  },
  {
    name: 'sdiv-short-isg-long-conflict',
    enabled: true,
    description: 'Flag when SHORT-DTE-IV goes short but IV-SKEW-GEX is long on same underlying',
    incoming: { strategy: 'SHORT_DTE_IV', direction: 'short' },
    conflicting: { strategy: 'IV_SKEW_GEX', direction: 'long' },
    sameUnderlying: true,
    severity: 'warning',
    message: 'SDIV short contradicts active ISG long — ISG drops to 48% WR, SDIV 72% WR (n=25)',
  },
  {
    name: 'isg-sdiv-agreement-short',
    enabled: true,
    description: 'Both ISG and SDIV agree SHORT — highest confidence (ISG 100% WR, n=12)',
    incoming: { strategy: 'IV_SKEW_GEX', direction: 'short' },
    agreeing: { strategy: 'SHORT_DTE_IV', direction: 'short' },
    sameUnderlying: true,
    severity: 'info',
    message: 'ISG + SDIV both SHORT — ISG 100% WR / SDIV 92% WR when both short (n=12)',
  },
  {
    name: 'sdiv-isg-agreement-short',
    enabled: true,
    description: 'Both SDIV and ISG agree SHORT — highest confidence (ISG 100% WR, n=12)',
    incoming: { strategy: 'SHORT_DTE_IV', direction: 'short' },
    agreeing: { strategy: 'IV_SKEW_GEX', direction: 'short' },
    sameUnderlying: true,
    severity: 'info',
    message: 'SDIV + ISG both SHORT — ISG 100% WR / SDIV 92% WR when both short (n=12)',
  },
  {
    name: 'isg-sdiv-agreement-long',
    enabled: true,
    description: 'Both ISG and SDIV agree LONG — strong signal',
    incoming: { strategy: 'IV_SKEW_GEX', direction: 'long' },
    agreeing: { strategy: 'SHORT_DTE_IV', direction: 'long' },
    sameUnderlying: true,
    severity: 'info',
    message: 'ISG + SDIV both LONG — ISG 90% WR / SDIV 77% WR when both long (n=60)',
  },
  {
    name: 'sdiv-isg-agreement-long',
    enabled: true,
    description: 'Both SDIV and ISG agree LONG — strong signal',
    incoming: { strategy: 'SHORT_DTE_IV', direction: 'long' },
    agreeing: { strategy: 'IV_SKEW_GEX', direction: 'long' },
    sameUnderlying: true,
    severity: 'info',
    message: 'SDIV + ISG both LONG — ISG 90% WR / SDIV 77% WR when both long (n=60)',
  },
];

/**
 * Evaluate informational multi-strategy alerts for an incoming signal.
 * Returns an array of alert objects (may be empty).
 *
 * @param {Object} signal - The parsed trade signal
 * @param {string} signalUnderlying - Normalized underlying (e.g. 'NQ', 'ES')
 * @param {string} signalDirection - 'long' or 'short'
 * @param {Map<string, {position: string, source: string}>} positions - strategyState.positions map
 * @returns {Array<{ruleName: string, severity: string, message: string}>}
 */
export function evaluateStrategyAlerts(signal, signalUnderlying, signalDirection, positions) {
  if (process.env.STRATEGY_ALERTS_ENABLED === 'false') {
    return [];
  }

  // Non-entry actions don't trigger alerts
  if (BYPASS_ACTIONS.has(signal.action)) {
    return [];
  }

  const incomingStrategy = (signal.strategy || '').toUpperCase();
  const alerts = [];

  for (const rule of STRATEGY_ALERT_RULES) {
    if (!rule.enabled) continue;

    // Check if the incoming signal matches this rule's incoming strategy
    if (rule.incoming.strategy !== incomingStrategy) continue;

    // For conflict rules: check if opposing strategy has a position in the opposite direction
    if (rule.conflicting) {
      if (rule.incoming.direction && rule.incoming.direction !== signalDirection) continue;

      // Find any position from the conflicting strategy
      for (const [underlying, posInfo] of positions) {
        if (!rule.sameUnderlying || underlying === signalUnderlying) {
          const source = (posInfo.source || '').toUpperCase();
          if (source === rule.conflicting.strategy && posInfo.position === rule.conflicting.direction) {
            alerts.push({
              ruleName: rule.name,
              severity: rule.severity,
              message: rule.message,
              underlying: signalUnderlying,
              incomingStrategy: incomingStrategy,
              incomingDirection: signalDirection,
              conflictingStrategy: rule.conflicting.strategy,
              conflictingDirection: posInfo.position,
            });
            logger.info(`[STRATEGY-ALERT] ${rule.name}: ${rule.message}`);
          }
        }
      }
    }

    // For agreement rules: check if the other strategy has a position in the same direction
    if (rule.agreeing) {
      // If the rule specifies a direction for the incoming signal, it must match
      if (rule.incoming.direction && rule.incoming.direction !== signalDirection) continue;

      for (const [underlying, posInfo] of positions) {
        if (!rule.sameUnderlying || underlying === signalUnderlying) {
          const source = (posInfo.source || '').toUpperCase();
          // If the rule specifies a direction for the agreeing strategy, check it
          const directionMatch = rule.agreeing.direction
            ? posInfo.position === rule.agreeing.direction
            : posInfo.position === signalDirection;
          if (source === rule.agreeing.strategy && directionMatch) {
            alerts.push({
              ruleName: rule.name,
              severity: rule.severity,
              message: rule.message,
              underlying: signalUnderlying,
              incomingStrategy: incomingStrategy,
              incomingDirection: signalDirection,
              agreeingStrategy: rule.agreeing.strategy,
              agreeingDirection: posInfo.position,
            });
            logger.info(`[STRATEGY-ALERT] ${rule.name}: ${rule.message}`);
          }
        }
      }
    }
  }

  return alerts;
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
