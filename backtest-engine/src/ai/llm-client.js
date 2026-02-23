/**
 * LLM Client - Anthropic SDK wrapper with JSON parsing and cost tracking.
 */

import Anthropic from '@anthropic-ai/sdk';

// Pricing per million tokens (as of early 2025)
const MODEL_PRICING = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4 },
  'claude-opus-4-6': { input: 15, output: 75 },
};

export class LLMClient {
  constructor({ model = 'claude-sonnet-4-20250514', maxTokens = 1024, apiKey } = {}) {
    this.model = model;
    this.maxTokens = maxTokens;

    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    });

    // Cost tracking
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCalls = 0;
  }

  /**
   * Send a prompt to Claude and parse JSON response.
   * Retries once on JSON parse failure.
   */
  async query(systemPrompt, userPrompt) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        });

        // Track usage
        this.totalCalls++;
        if (response.usage) {
          this.totalInputTokens += response.usage.input_tokens || 0;
          this.totalOutputTokens += response.usage.output_tokens || 0;
        }

        // Extract text
        const text = response.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('');

        // Parse JSON — handle markdown code blocks
        const parsed = this._parseJSON(text);
        return parsed;
      } catch (e) {
        lastError = e;
        if (attempt === 0 && e.name === 'JSONParseError') {
          // Retry with a nudge
          userPrompt += '\n\nIMPORTANT: Your previous response was not valid JSON. Please respond with ONLY a JSON object, no markdown fences or extra text.';
          continue;
        }
        throw e;
      }
    }

    throw lastError;
  }

  /**
   * Parse JSON from LLM response text.
   * Handles bare JSON, markdown ```json blocks, and extra whitespace.
   */
  _parseJSON(text) {
    let cleaned = text.trim();

    // Strip markdown code fences
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    // Try direct parse
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      // Try to find JSON object in the text
      const objMatch = cleaned.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          return JSON.parse(objMatch[0]);
        } catch (e2) {
          // Fall through
        }
      }

      const err = new Error(`Failed to parse JSON from LLM response: ${cleaned.slice(0, 200)}`);
      err.name = 'JSONParseError';
      err.rawText = cleaned;
      throw err;
    }
  }

  /**
   * Get cumulative cost summary.
   */
  getCostSummary() {
    const pricing = MODEL_PRICING[this.model] || { input: 3, output: 15 };
    const inputCost = (this.totalInputTokens / 1_000_000) * pricing.input;
    const outputCost = (this.totalOutputTokens / 1_000_000) * pricing.output;

    return {
      model: this.model,
      totalCalls: this.totalCalls,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      estimatedCostUSD: Math.round((inputCost + outputCost) * 10000) / 10000,
      breakdown: {
        inputCostUSD: Math.round(inputCost * 10000) / 10000,
        outputCostUSD: Math.round(outputCost * 10000) / 10000,
      },
    };
  }

  /**
   * Dry-run mode — logs prompts without calling the API.
   * Returns a mock response.
   */
  dryRun(systemPrompt, userPrompt, type = 'bias') {
    this.totalCalls++;
    console.log('\n' + '='.repeat(80));
    console.log(`DRY RUN — ${type.toUpperCase()} PROMPT`);
    console.log('='.repeat(80));
    console.log('\n--- SYSTEM ---');
    console.log(systemPrompt);
    console.log('\n--- USER ---');
    console.log(userPrompt);
    console.log('\n--- TOKEN ESTIMATE ---');
    const tokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
    console.log(`~${tokens} input tokens`);
    console.log('='.repeat(80));

    if (type === 'bias') {
      return {
        bias: 'neutral',
        conviction: 1,
        key_levels_to_watch: [],
        reasoning: 'Dry run — no LLM call made.',
        avoid_conditions: [],
        preferred_session_window: '10:00-11:30 ET',
      };
    } else if (type === 'reassessment') {
      return {
        bias: 'neutral',
        conviction: 2,
        key_levels_to_watch: [],
        reasoning: 'Dry run — reassessment mock.',
        avoid_conditions: [],
        preferred_session_window: '13:00-15:00 ET',
      };
    } else {
      return {
        action: 'pass',
        reasoning: 'Dry run — no LLM call made.',
      };
    }
  }
}
