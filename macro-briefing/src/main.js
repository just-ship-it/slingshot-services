import moment from 'moment-timezone';
import { createLogger, messageBus } from '../../shared/index.js';
import * as fredClient from './data/fred-client.js';
import * as marketClient from './data/market-client.js';
import * as slingshotClient from './data/slingshot-client.js';
import { computeAllAnalytics } from './analytics/statistics.js';
import { detectAllRegimes } from './analytics/regime-detector.js';
import { generateNarrative } from './synthesis/claude-client.js';
import { buildPrompt } from './synthesis/prompt-builder.js';
import * as fileDelivery from './delivery/file-delivery.js';
import * as emailDelivery from './delivery/email-delivery.js';
import * as dashboardDelivery from './delivery/dashboard-delivery.js';

const logger = createLogger('macro-briefing-main');

const BRIEFING_REDIS_KEY = 'briefing:latest';
const BRIEFING_ARCHIVE_PREFIX = 'briefing:archive:';
const PRIOR_SUMMARY_KEY = 'briefing:prior-summary';

let latestBriefing = null;

export function getLatestBriefing() {
  return latestBriefing;
}

export async function loadLatestBriefing() {
  try {
    const data = await messageBus.publisher.get(BRIEFING_REDIS_KEY);
    if (data) {
      latestBriefing = JSON.parse(data);
      logger.info(`Loaded latest briefing from Redis (${latestBriefing.date})`);
      return latestBriefing;
    }
    logger.info('No briefing found in Redis');
  } catch (error) {
    logger.warn('Failed to load briefing from Redis:', error.message);
  }
  return null;
}

async function loadPriorSummary() {
  // Try Redis first, fall back to local file
  try {
    const data = await messageBus.publisher.get(PRIOR_SUMMARY_KEY);
    if (data) {
      const parsed = JSON.parse(data);
      logger.info(`Loaded prior summary from Redis (${parsed.date})`);
      return parsed.summary || null;
    }
  } catch (error) {
    logger.warn('Failed to load prior summary from Redis:', error.message);
  }
  // Fall back to local file (for dev/backward compat)
  return fileDelivery.loadPriorSummary();
}

export async function generateBriefing() {
  const date = moment().tz('America/New_York').format('YYYY-MM-DD');
  const startTime = Date.now();
  logger.info(`Starting briefing generation for ${date}`);

  // 1. Collect data in parallel
  const [fredData, marketData, slingshotData] = await Promise.allSettled([
    fredClient.fetchAllSeries(),
    marketClient.fetchAllQuotes(),
    slingshotClient.fetchAll()
  ]);

  const fred = fredData.status === 'fulfilled' ? fredData.value : new Map();
  const market = marketData.status === 'fulfilled' ? marketData.value : {};
  const slingshot = slingshotData.status === 'fulfilled' ? slingshotData.value : {};

  if (fredData.status === 'rejected') logger.error('FRED data fetch failed:', fredData.reason);
  if (marketData.status === 'rejected') logger.error('Market data fetch failed:', marketData.reason);
  if (slingshotData.status === 'rejected') logger.error('Slingshot data fetch failed:', slingshotData.reason);

  // 2. Compute analytics
  const analytics = computeAllAnalytics(fred, market);
  const regimes = detectAllRegimes(fred, market);

  // 3. Build prompt and call Claude for narrative
  const priorSummary = await loadPriorSummary();
  const prompt = buildPrompt({ date, analytics, regimes, market, slingshot, priorSummary });

  let narrative;
  try {
    narrative = await generateNarrative(prompt);
  } catch (error) {
    logger.error('Claude narrative generation failed, using data-only report:', error);
    narrative = buildDataOnlyReport(analytics, regimes);
  }

  // 4. Assemble final report
  const report = {
    date,
    generatedAt: new Date().toISOString(),
    generationTimeMs: Date.now() - startTime,
    fullReport: narrative,
    analytics,
    regimes,
    dataSources: {
      fred: fredData.status === 'fulfilled',
      market: marketData.status === 'fulfilled',
      slingshot: slingshotData.status === 'fulfilled'
    }
  };

  // 5. Deliver in parallel
  const deliveryResults = await Promise.allSettled([
    fileDelivery.save(report),
    emailDelivery.send(report),
    dashboardDelivery.publish(report)
  ]);

  deliveryResults.forEach((result, i) => {
    const names = ['file', 'email', 'dashboard'];
    if (result.status === 'rejected') {
      logger.error(`${names[i]} delivery failed:`, result.reason);
    } else {
      logger.info(`${names[i]} delivery: ${result.value}`);
    }
  });

  // 6. Console output
  console.log('\n' + '='.repeat(80));
  console.log(`MACRO BRIEFING — ${date}`);
  console.log('='.repeat(80));
  console.log(narrative);
  console.log('='.repeat(80));
  console.log(`Generated in ${Date.now() - startTime}ms\n`);

  latestBriefing = report;

  // Persist to Redis so it survives restarts
  try {
    const reportJson = JSON.stringify(report);
    await messageBus.publisher.set(BRIEFING_REDIS_KEY, reportJson);

    // Archive with date key for backtesting
    await messageBus.publisher.set(`${BRIEFING_ARCHIVE_PREFIX}${date}`, reportJson);

    // Save prior summary for next day's narrative continuity
    const summaryMatch = report.fullReport.match(/## Bottom Line[\s\S]*?(?=\n---|\n##|$)/i)
      || report.fullReport.match(/\*\*Bottom Line\*\*[\s\S]*?(?=\n---|\n##|$)/i);
    if (summaryMatch) {
      await messageBus.publisher.set(PRIOR_SUMMARY_KEY, JSON.stringify({
        date: report.date,
        summary: summaryMatch[0].trim()
      }));
    }

    logger.info(`Briefing persisted to Redis (latest + archive:${date})`);
  } catch (error) {
    logger.warn('Failed to persist briefing to Redis:', error.message);
  }

  logger.info(`Briefing generation completed in ${Date.now() - startTime}ms`);
  return report;
}

function buildDataOnlyReport(analytics, regimes) {
  const lines = ['# Macro Briefing (Data Only — Claude unavailable)\n'];

  lines.push('## Regimes');
  lines.push(`- Yield Curve: ${regimes.yieldCurve}`);
  lines.push(`- VIX: ${regimes.vix}`);
  lines.push(`- Credit: ${regimes.credit}`);
  lines.push(`- Liquidity: ${regimes.liquidity}`);
  lines.push(`- Overall: **${regimes.overall}**\n`);

  if (analytics.rates) {
    lines.push('## Rates');
    for (const [key, val] of Object.entries(analytics.rates)) {
      lines.push(`- ${key}: ${val.formatted}`);
    }
    lines.push('');
  }

  if (analytics.credit) {
    lines.push('## Credit');
    for (const [key, val] of Object.entries(analytics.credit)) {
      lines.push(`- ${key}: ${val.formatted}`);
    }
    lines.push('');
  }

  if (analytics.equities) {
    lines.push('## Equities');
    for (const [key, val] of Object.entries(analytics.equities)) {
      lines.push(`- ${key}: ${val.formatted}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
