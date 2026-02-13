import { messageBus, CHANNELS, createLogger } from '../../../shared/index.js';

const logger = createLogger('dashboard-delivery');

/**
 * Publish briefing to Redis for dashboard consumption
 */
export async function publish(report) {
  if (!messageBus.isConnected) {
    return 'skipped (Redis not connected)';
  }

  const payload = {
    date: report.date,
    generatedAt: report.generatedAt,
    regimes: report.regimes,
    fullReport: report.fullReport,
    dataSources: report.dataSources
  };

  await messageBus.publish(CHANNELS.MACRO_BRIEFING, payload);
  logger.info('Published briefing to Redis');
  return 'published to Redis';
}
