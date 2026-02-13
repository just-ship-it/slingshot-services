#!/usr/bin/env node

import express from 'express';
import cron from 'node-cron';
import { createLogger, configManager, messageBus, healthCheck } from '../shared/index.js';
import { generateBriefing, getLatestBriefing, loadLatestBriefing } from './src/main.js';

// Load .env before anything reads process.env
configManager.loadConfig('macro-briefing');

const logger = createLogger('macro-briefing');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3017;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const SCHEDULE = process.env.MACRO_BRIEFING_SCHEDULE || '30 6 * * 1-5'; // 6:30 AM ET weekdays

let lastGeneration = null;
let generating = false;

// Health check
app.get('/health', async (req, res) => {
  const health = await healthCheck('macro-briefing', {
    lastGeneration: lastGeneration?.date || null,
    generating,
    schedule: SCHEDULE
  }, messageBus);
  res.json(health);
});

// Get most recent briefing
app.get('/briefing/latest', (req, res) => {
  const briefing = getLatestBriefing();
  if (!briefing) {
    return res.status(404).json({ error: 'No briefing available. Trigger generation via POST /briefing/generate' });
  }
  res.json(briefing);
});

// Get latest briefing as rendered markdown
app.get('/briefing/latest/markdown', (req, res) => {
  const briefing = getLatestBriefing();
  if (!briefing) {
    return res.status(404).json({ error: 'No briefing available' });
  }
  res.type('text/markdown').send(briefing.fullReport);
});

// Generation status (for frontend polling)
app.get('/briefing/status', (req, res) => {
  res.json({ generating });
});

// On-demand generation (fire-and-forget — returns immediately)
app.post('/briefing/generate', (req, res) => {
  if (generating) {
    return res.status(429).json({ error: 'Briefing generation already in progress' });
  }

  generating = true;
  logger.info('On-demand briefing generation triggered');
  res.json({ message: 'Briefing generation started' });

  // Run in background
  generateBriefing()
    .then(report => {
      lastGeneration = { date: report.date, timestamp: new Date().toISOString() };
      logger.info(`Briefing generated for ${report.date}`);
    })
    .catch(error => {
      logger.error('Briefing generation failed:', error);
    })
    .finally(() => {
      generating = false;
    });
});

// Connect message bus and start
async function start() {
  try {
    await messageBus.connect();
    logger.info('Connected to Redis message bus');

    // Load latest briefing from Redis (survives restarts)
    const cached = await loadLatestBriefing();
    if (cached) {
      lastGeneration = { date: cached.date, timestamp: cached.generatedAt };
    }

    // Schedule daily generation
    cron.schedule(SCHEDULE, async () => {
      if (generating) {
        logger.warn('Skipping scheduled generation — already in progress');
        return;
      }
      try {
        generating = true;
        logger.info('Scheduled briefing generation starting');
        const report = await generateBriefing();
        lastGeneration = { date: report.date, timestamp: new Date().toISOString() };
        logger.info(`Scheduled briefing generated for ${report.date}`);
      } catch (error) {
        logger.error('Scheduled briefing generation failed:', error);
      } finally {
        generating = false;
      }
    }, { timezone: 'America/New_York' });

    logger.info(`Cron scheduled: ${SCHEDULE} (America/New_York)`);

    app.listen(PORT, BIND_HOST, () => {
      logger.info(`Macro Briefing service listening on ${BIND_HOST}:${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start macro-briefing service:', error);
    process.exit(1);
  }
}

start();

export default app;
