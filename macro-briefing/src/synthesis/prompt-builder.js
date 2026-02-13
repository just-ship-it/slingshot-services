/**
 * Build structured prompt for Claude narrative synthesis
 */

const SYSTEM_PROMPT = `You are a senior macro strategist preparing a morning briefing for an active futures trader focused on NQ and ES. Your audience trades intraday and holds positions overnight — they need actionable context, not academic commentary.

## Reasoning Framework (FinCoT)
For each section, follow this internal chain:
1. STATE: What are the current levels and readings?
2. CONTEXTUALIZE: Where do these sit historically (use z-scores, percentiles)?
3. IDENTIFY CHANGES: What moved meaningfully since yesterday?
4. ASSESS: What does this mean for positioning and risk?
5. FLAG CONFLICTS: Are any signals contradicting each other?

## Rules
- Only reference data provided in the user message. Never fabricate numbers.
- Express rate changes in basis points (1bp = 0.01%).
- Be direct and opinionated. "The curve steepened 5bps" is better than "rates moved."
- Highlight regime changes or inflection points — those are what matter for positioning.
- Keep the total response under 3000 words.
- Use markdown formatting with headers, bullets, and bold for key levels/numbers.`;

/**
 * Build the full prompt from analytics data
 */
export function buildPrompt({ date, analytics, regimes, market, slingshot, priorSummary }) {
  const sections = [];

  sections.push(`## Today's Date: ${date}\n`);

  // === Section 1: Rates, Credit & Liquidity ===
  sections.push('---');
  sections.push('## Section 1: Rates, Credit & Liquidity\n');

  sections.push('### Treasury Yields');
  sections.push(formatTable(analytics.rates, ['DGS2', 'DGS5', 'DGS10', 'DGS30', 'DTB3']));

  sections.push('### Yield Curve Spreads');
  sections.push(formatTable(analytics.rates, ['T10Y2Y', 'T10Y3M']));

  sections.push('### Policy Rates');
  sections.push(formatTable(analytics.rates, ['DFF', 'SOFR']));

  sections.push('### Inflation Expectations');
  sections.push(formatTable(analytics.inflation, ['T5YIE', 'T10YIE', 'T5YIFR', 'DFII10']));

  sections.push('### Credit Spreads');
  sections.push(formatTable(analytics.credit, ['BAMLC0A0CM', 'BAMLH0A0HYM2']));

  sections.push('### Fed Liquidity');
  sections.push(formatTable(analytics.liquidity, ['WALCL', 'RRPONTSYD', 'WTREGEN']));

  sections.push(`### Regime Assessment`);
  sections.push(`- Yield Curve Regime: **${regimes.yieldCurve}**`);
  sections.push(`- Credit Regime: **${regimes.credit}**`);
  sections.push(`- Liquidity Regime: **${regimes.liquidity}**`);
  sections.push('');

  // === Section 2: Equity Strategy ===
  sections.push('---');
  sections.push('## Section 2: Equity Strategy\n');

  sections.push('### Major Indices');
  sections.push('*Note: ^IXIC is the Nasdaq Composite cash index, NOT NQ futures. ^GSPC is S&P 500 cash, NOT ES futures. Use the NQ/ES spot prices from the GEX Positioning section for futures levels.*');
  if (analytics.equities && Object.keys(analytics.equities).length > 0) {
    for (const [sym, data] of Object.entries(analytics.equities)) {
      sections.push(`- **${data.name}** (${sym}): ${data.formatted}`);
    }
  } else {
    sections.push('- Market data unavailable');
  }
  sections.push('');

  sections.push('### Sector Performance');
  if (analytics.sectors && Object.keys(analytics.sectors).length > 0) {
    const sorted = Object.entries(analytics.sectors)
      .sort((a, b) => (b[1].changePct || 0) - (a[1].changePct || 0));
    for (const [sym, data] of sorted) {
      sections.push(`- ${data.name} (${sym}): **${data.formatted}**`);
    }
  } else {
    sections.push('- Sector data unavailable');
  }
  sections.push('');

  sections.push('### Factor Performance');
  if (analytics.factors && Object.keys(analytics.factors).length > 0) {
    for (const [sym, data] of Object.entries(analytics.factors)) {
      sections.push(`- ${data.name} (${sym}): ${data.formatted}`);
    }
  } else {
    sections.push('- Factor data unavailable');
  }
  sections.push('');

  sections.push('### Volatility');
  sections.push(formatTable(analytics.volatility, ['VIXCLS', 'NFCI']));

  sections.push(`### VIX Regime: **${regimes.vix}**\n`);

  // Cross-asset
  if (market?.other) {
    sections.push('### Cross-Asset');
    for (const [sym, quote] of Object.entries(market.other)) {
      if (quote) {
        sections.push(`- ${quote.name} (${sym}): ${quote.price} (${quote.changePct >= 0 ? '+' : ''}${quote.changePct}%)`);
      }
    }
    sections.push('');
  }

  // GEX levels if available
  if (slingshot?.gex?.nq || slingshot?.gex?.es) {
    sections.push('### GEX Positioning (Slingshot)');
    if (slingshot.gex.nq) {
      const g = slingshot.gex.nq;
      const nqSpot = g.nqSpot || g.nq_spot || g.futures_spot || 'N/A';
      sections.push(`**NQ GEX**: Spot: ${nqSpot}, Gamma Flip: ${g.gammaFlip || g.gamma_flip || 'N/A'}, ` +
        `Call Wall: ${g.callWall || g.call_wall || 'N/A'}, ` +
        `Put Wall: ${g.putWall || g.put_wall || 'N/A'}, ` +
        `Regime: ${g.regime || 'N/A'}`);
    }
    if (slingshot.gex.es) {
      const g = slingshot.gex.es;
      const esSpot = g.esSpot || g.es_spot || g.futures_spot || 'N/A';
      sections.push(`**ES GEX**: Spot: ${esSpot}, Gamma Flip: ${g.gammaFlip || g.gamma_flip || 'N/A'}, ` +
        `Call Wall: ${g.callWall || g.call_wall || 'N/A'}, ` +
        `Put Wall: ${g.putWall || g.put_wall || 'N/A'}, ` +
        `Regime: ${g.regime || 'N/A'}`);
    }
    sections.push('');
  }

  // IV Skew if available
  if (slingshot?.ivSkew) {
    sections.push('### IV Skew (Slingshot)');
    const iv = slingshot.ivSkew;
    sections.push(`- Skew: ${iv.skew ?? 'N/A'}, ATM IV: ${iv.atmIv ?? iv.atm_iv ?? 'N/A'}`);
    sections.push('');
  }

  // === Section 3: Macro Outlook ===
  sections.push('---');
  sections.push('## Section 3: Macro Outlook\n');

  sections.push('### Economic Indicators');
  sections.push(formatTable(analytics.economy, ['UNRATE', 'ICSA', 'CPIAUCSL', 'PCEPILFE', 'CIVPART', 'DTWEXBGS']));

  sections.push(`### Overall Macro Regime: **${regimes.overall}**\n`);

  // Prior summary for continuity
  if (priorSummary) {
    sections.push('---');
    sections.push(`## Yesterday's Summary (for narrative continuity)\n`);
    sections.push(priorSummary);
    sections.push('');
  }

  // === Instructions ===
  sections.push('---');
  sections.push(`## Instructions

For each of the 3 sections, provide:

1. **Executive Summary** — 3 actionable bullets for a futures trader
2. **What Changed** — Key deltas from prior session with significance assessment
3. **Regime Assessment** — Current regime and whether it's shifting
4. **Key Levels / Risks to Watch** — Specific numbers and scenarios to monitor

End with a **Bottom Line** paragraph (3-4 sentences) synthesizing the overall macro setup and what it means for NQ/ES positioning today.`);

  return {
    system: SYSTEM_PROMPT,
    user: sections.join('\n')
  };
}

/**
 * Format analytics entries as a readable list
 */
function formatTable(category, keys) {
  if (!category || Object.keys(category).length === 0) return '- Data unavailable\n';

  const lines = [];
  for (const key of keys) {
    const entry = category[key];
    if (!entry) continue;
    lines.push(`- **${entry.name}** (${key}): ${entry.context || entry.formatted || 'N/A'}`);
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '- Data unavailable\n';
}
