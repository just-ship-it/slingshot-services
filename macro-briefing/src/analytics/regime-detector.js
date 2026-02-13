import { createLogger } from '../../../shared/index.js';

const logger = createLogger('regime-detector');

/**
 * Detect yield curve regime from spread data
 */
export function detectYieldCurveRegime(t10y2y, t10y3m) {
  // Use 10Y-2Y as primary, 10Y-3M as secondary
  const spread = t10y2y ?? t10y3m;
  if (spread == null) return 'unknown';

  if (spread < -0.50) return 'deeply_inverted';
  if (spread < 0) return 'inverted';
  if (spread < 0.25) return 'flat';
  if (spread < 1.00) return 'normal';
  return 'steep';
}

/**
 * Detect VIX regime
 */
export function detectVixRegime(vix) {
  if (vix == null) return 'unknown';

  if (vix < 13) return 'complacent';
  if (vix < 18) return 'low';
  if (vix < 25) return 'normal';
  if (vix < 35) return 'elevated';
  return 'crisis';
}

/**
 * Detect credit regime from IG and HY OAS
 */
export function detectCreditRegime(igOas, hyOas) {
  // Use HY OAS as primary signal — more sensitive to risk
  if (hyOas == null && igOas == null) return 'unknown';

  const hy = hyOas ?? 0;
  const ig = igOas ?? 0;

  // HY OAS thresholds (historical context)
  if (hy < 300 && ig < 100) return 'tight';
  if (hy < 400 && ig < 150) return 'normal';
  if (hy < 600 && ig < 200) return 'widening';
  return 'stress';
}

/**
 * Detect Fed liquidity regime from balance sheet components
 * WALCL = Fed balance sheet (total assets) in millions
 * RRPONTSYD = Reverse repo in billions
 * WTREGEN = Treasury General Account in millions
 * Net liquidity ≈ WALCL - RRP - TGA
 */
export function detectLiquidityRegime(walcl, rrp, tga) {
  if (walcl == null) return 'unknown';

  // Simple heuristic: look at direction of Fed balance sheet
  // In reality you'd want to compute net liquidity and its rate of change
  // For now, use TGA and RRP movements as signals

  // Convert to comparable units (all in billions)
  const fedBillions = walcl / 1000; // WALCL is in millions
  const rrpBillions = rrp || 0; // RRP is already in billions
  const tgaBillions = (tga || 0) / 1000; // WTREGEN is in millions

  // Net liquidity proxy
  const netLiquidity = fedBillions - rrpBillions - tgaBillions;

  // These thresholds are rough — would need historical context for proper detection
  if (netLiquidity > 6000) return 'abundant';
  if (netLiquidity > 5000) return 'normal';
  if (netLiquidity > 4000) return 'tightening';
  return 'draining';
}

/**
 * Composite macro regime assessment
 */
export function detectOverallRegime(yieldCurve, vix, credit, liquidity) {
  let riskScore = 0;

  // Yield curve
  const ycScores = { deeply_inverted: -2, inverted: -1, flat: 0, normal: 1, steep: 1, unknown: 0 };
  riskScore += ycScores[yieldCurve] || 0;

  // VIX
  const vixScores = { complacent: 1, low: 1, normal: 0, elevated: -1, crisis: -2, unknown: 0 };
  riskScore += vixScores[vix] || 0;

  // Credit
  const creditScores = { tight: 1, normal: 0, widening: -1, stress: -2, unknown: 0 };
  riskScore += creditScores[credit] || 0;

  // Liquidity
  const liqScores = { abundant: 1, normal: 0, tightening: -1, draining: -2, unknown: 0 };
  riskScore += liqScores[liquidity] || 0;

  if (riskScore >= 3) return 'risk-on';
  if (riskScore >= 1) return 'tilted-risk-on';
  if (riskScore >= -1) return 'neutral';
  if (riskScore >= -3) return 'tilted-risk-off';
  return 'risk-off';
}

/**
 * Run all regime detections from FRED + market data
 */
export function detectAllRegimes(fredData, marketData) {
  const getValue = (id) => fredData.get(id)?.value ?? null;

  const yieldCurve = detectYieldCurveRegime(getValue('T10Y2Y'), getValue('T10Y3M'));
  const vix = detectVixRegime(getValue('VIXCLS'));
  const credit = detectCreditRegime(getValue('BAMLC0A0CM'), getValue('BAMLH0A0HYM2'));
  const liquidity = detectLiquidityRegime(getValue('WALCL'), getValue('RRPONTSYD'), getValue('WTREGEN'));
  const overall = detectOverallRegime(yieldCurve, vix, credit, liquidity);

  logger.info(`Regimes — YC: ${yieldCurve}, VIX: ${vix}, Credit: ${credit}, Liquidity: ${liquidity}, Overall: ${overall}`);

  return {
    yieldCurve,
    vix,
    credit,
    liquidity,
    overall
  };
}
