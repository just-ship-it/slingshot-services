import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('claude-client');

const MODEL = process.env.MACRO_BRIEFING_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = parseInt(process.env.MACRO_BRIEFING_MAX_TOKENS || '6000');

let client = null;

function getClient() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * Generate narrative briefing from structured prompt
 * @param {{ system: string, user: string }} prompt - System and user messages
 * @returns {string} Markdown narrative
 */
export async function generateNarrative(prompt) {
  const anthropic = getClient();

  logger.info(`Generating narrative with ${MODEL} (max ${MAX_TOKENS} tokens)`);
  const startTime = Date.now();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: prompt.system,
    messages: [
      { role: 'user', content: prompt.user }
    ]
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');

  const elapsed = Date.now() - startTime;
  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  logger.info(`Narrative generated in ${elapsed}ms (${inputTokens} input, ${outputTokens} output tokens)`);

  return text;
}
