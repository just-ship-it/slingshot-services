/**
 * Pattern Registry
 *
 * Central registry for all micro-structure patterns.
 * Each pattern is a self-contained module with detection logic,
 * filters, and exit parameters.
 */

// Engulfing Patterns
import { BullishEngulfingPattern } from './bullish-engulfing.js';
import { BearishEngulfingPattern } from './bearish-engulfing.js';

// Fair Value Gap Patterns
import { BullishFVGPattern } from './bullish-fvg.js';
import { BearishFVGPattern } from './bearish-fvg.js';

// Liquidity Sweep Patterns
import { SwingLowSweepPattern } from './swing-low-sweep.js';
import { SwingHighSweepPattern } from './swing-high-sweep.js';

// Pin Bar / Rejection Patterns
import { BullishPinBarPattern } from './bullish-pin-bar.js';
import { BearishPinBarPattern } from './bearish-pin-bar.js';
import { HammerPattern } from './hammer.js';
import { ShootingStarPattern } from './shooting-star.js';

// Consolidation Patterns
import { InsideBarPattern } from './inside-bar.js';
import { OutsideBarPattern } from './outside-bar.js';
import { DojiPattern } from './doji.js';

// Multi-Candle Patterns
import { ThreeWhiteSoldiersPattern } from './three-white-soldiers.js';
import { ThreeBlackCrowsPattern } from './three-black-crows.js';
import { MorningStarPattern } from './morning-star.js';
import { EveningStarPattern } from './evening-star.js';

/**
 * Pattern Registry - All available patterns
 * Key is the pattern identifier, value is the pattern module
 */
export const PATTERNS = {
  // Engulfing Patterns
  bullish_engulfing: BullishEngulfingPattern,
  bearish_engulfing: BearishEngulfingPattern,

  // Fair Value Gap Patterns
  bullish_fvg: BullishFVGPattern,
  bearish_fvg: BearishFVGPattern,

  // Liquidity Sweep Patterns
  swing_low_sweep: SwingLowSweepPattern,
  swing_high_sweep: SwingHighSweepPattern,

  // Pin Bar / Rejection Patterns
  bullish_pin_bar: BullishPinBarPattern,
  bearish_pin_bar: BearishPinBarPattern,
  hammer: HammerPattern,
  shooting_star: ShootingStarPattern,

  // Consolidation Patterns
  inside_bar: InsideBarPattern,
  outside_bar: OutsideBarPattern,
  doji: DojiPattern,

  // Multi-Candle Patterns
  three_white_soldiers: ThreeWhiteSoldiersPattern,
  three_black_crows: ThreeBlackCrowsPattern,
  morning_star: MorningStarPattern,
  evening_star: EveningStarPattern
};

/**
 * Default active patterns - patterns that have shown edge in analysis
 * Can be overridden in strategy configuration
 */
export const DEFAULT_ACTIVE_PATTERNS = [
  // High-confidence patterns (to be refined based on analysis)
  'bullish_engulfing',
  'bearish_engulfing',
  'swing_low_sweep',
  'swing_high_sweep',
  'hammer',
  'shooting_star'
];

/**
 * Get all long-biased patterns
 */
export function getLongPatterns() {
  return Object.entries(PATTERNS)
    .filter(([_, pattern]) => pattern.side === 'long')
    .map(([name, _]) => name);
}

/**
 * Get all short-biased patterns
 */
export function getShortPatterns() {
  return Object.entries(PATTERNS)
    .filter(([_, pattern]) => pattern.side === 'short')
    .map(([name, _]) => name);
}

/**
 * Get neutral patterns (can go either direction based on context)
 */
export function getNeutralPatterns() {
  return Object.entries(PATTERNS)
    .filter(([_, pattern]) => pattern.side === 'neutral')
    .map(([name, _]) => name);
}

/**
 * Validate pattern configuration
 * @param {string[]} patternNames - Array of pattern names to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validatePatterns(patternNames) {
  const errors = [];

  for (const name of patternNames) {
    if (!PATTERNS[name]) {
      errors.push(`Unknown pattern: ${name}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export default PATTERNS;
