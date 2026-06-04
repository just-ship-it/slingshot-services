/**
 * Optional gamma-regime trade filter (loser-reduction overlay for the FCFS portfolio).
 *
 * Validated in research/portfolio-filter (full 16mo + Feb-Apr 2026 future holdout): dropping
 * SHORTS in positive gamma and GEX-LEVEL-FADE in negative gamma raises win rate ~+4pts, cuts
 * drawdown ~22%, removes ~34% of losing trades (at a ~25% PnL cost — a deliberate small-account
 * trade). See memory/portfolio-filter-research.md.
 *
 * This module is PURE and is imported by BOTH the live trade-orchestrator and the backtest
 * harness, so live behavior is identical to the validated research (one source of truth).
 *
 * FAIL-OPEN: if the gamma regime is unknown/stale, the filter does NOT act (the trade is
 * allowed) — it is a quality overlay, not a safety gate, so a GEX outage must never silently
 * halt trading. The `degraded` flag flags the "enabled but couldn't act" case so the caller
 * can alert (you asked for this to be loud, not silent).
 */

export const FADE_STRATEGY = 'GEX_LEVEL_FADE';

// Entry actions only — exits/cancels/modifies always bypass the filter.
const NON_ENTRY_ACTIONS = new Set([
  'position_closed', 'cancel_limit', 'update_limit', 'modify_stop', 'close_position',
]);

export const GAMMA_FILTER_DEFAULTS = {
  enabled: false,                 // master flag — default OFF (deploy dark, flip on when ready)
  blockShortsInPositive: true,    // rule A: drop SHORT entries when net gamma is positive
  blockFadeInNegative: true,      // rule B: drop GEX_LEVEL_FADE entries when net gamma is negative
};

const bool = (v, d) => (v == null || v === '') ? d : String(v).toLowerCase() === 'true';

/** Build config from environment (call once at boot; overridable at runtime by the caller). */
export function readGammaFilterConfig(env = process.env) {
  return {
    enabled: bool(env.GAMMA_FILTER_ENABLED, GAMMA_FILTER_DEFAULTS.enabled),
    blockShortsInPositive: bool(env.GAMMA_FILTER_BLOCK_SHORTS_POS, GAMMA_FILTER_DEFAULTS.blockShortsInPositive),
    blockFadeInNegative: bool(env.GAMMA_FILTER_BLOCK_FADE_NEG, GAMMA_FILTER_DEFAULTS.blockFadeInNegative),
  };
}

function normSide(s) {
  const l = String(s ?? '').toLowerCase();
  if (l === 'long' || l === 'buy') return 'long';
  if (l === 'short' || l === 'sell') return 'short';
  return null;
}

/** Normalize a gamma regime input to 'positive' | 'negative' | null (unknown). */
export function normRegime(regime) {
  if (regime === 'positive' || regime === 'negative') return regime;
  return null;
}

/**
 * Decide whether to allow a signal under the gamma filter.
 *
 * @param {{strategy?:string, side?:string, action?:string}} signal
 * @param {'positive'|'negative'|null} regime  — net-gamma regime as-of signal time (null = unknown/stale)
 * @param {object} [config]                    — from readGammaFilterConfig(); defaults if omitted
 * @returns {{allowed:boolean, acted:boolean, ruleName?:string, reason:string, degraded:boolean}}
 *   allowed  — take the trade? (false only when a rule actively blocks)
 *   acted    — did the filter make a real decision? (false = disabled / non-entry / unknown regime)
 *   degraded — enabled but could NOT act because regime was unknown/stale → caller should alert
 */
export function evaluateGammaFilter(signal, regime, config = GAMMA_FILTER_DEFAULTS) {
  if (!config.enabled) return { allowed: true, acted: false, reason: 'disabled', degraded: false };

  const action = signal?.action;
  if (action && NON_ENTRY_ACTIONS.has(action)) return { allowed: true, acted: false, reason: 'non_entry_action', degraded: false };

  const reg = normRegime(regime);
  if (reg == null) {
    // FAIL-OPEN: take the trade, but flag degraded so the caller can alert.
    return { allowed: true, acted: false, reason: 'regime_unknown', degraded: true };
  }

  const side = normSide(signal?.side);
  const strat = String(signal?.strategy ?? '').toUpperCase();

  if (config.blockShortsInPositive && side === 'short' && reg === 'positive') {
    return { allowed: false, acted: true, ruleName: 'short_in_positive_gamma', reason: 'short entry blocked: positive gamma', degraded: false };
  }
  if (config.blockFadeInNegative && strat === FADE_STRATEGY && reg === 'negative') {
    return { allowed: false, acted: true, ruleName: 'fade_in_negative_gamma', reason: 'GEX_LEVEL_FADE blocked: negative gamma', degraded: false };
  }
  return { allowed: true, acted: true, reason: 'passed', degraded: false };
}
