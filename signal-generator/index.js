#!/usr/bin/env node

// Signal Generator Service - HTTP Server and Service Entry Point
// Refactored: multi-strategy engine + AI trader mode
process.setMaxListeners(20);

import express from 'express';
import { createLogger } from '../shared/index.js';
import config from './src/utils/config.js';
import service from './src/main.js';
import { isInTradingWindow, getTradingWindowName } from '../backtest-engine/src/ai/session-utils.js';

const logger = createLogger('signal-generator-server');
const app = express();

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    res.json(service.getHealth());
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({ service: 'signal-generator', status: 'error', error: error.message });
  }
});

// === Multi-Strategy Endpoints ===

// List all strategies with status
app.get('/strategies', (req, res) => {
  try {
    const engine = service.multiStrategyEngine;
    if (!engine) {
      return res.status(503).json({ error: 'Multi-strategy engine not initialized (AI trader mode?)' });
    }
    res.json({ strategies: engine.getStrategiesStatus(), timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Strategy status - backward compatible (returns all strategies)
app.get('/strategy/status', (req, res) => {
  try {
    const engine = service.multiStrategyEngine;
    if (!engine) {
      return res.status(503).json({ error: 'Multi-strategy engine not initialized' });
    }
    const strategies = engine.getStrategiesStatus();
    // For backward compatibility, also include top-level fields from first strategy
    const primary = strategies[0] || null;
    res.json({
      strategy: primary ? {
        name: primary.name,
        type: primary.name,
        constant: primary.constant,
        enabled: primary.enabled,
        session: primary.session,
        cooldown: primary.cooldown
      } : null,
      internals: primary?.internals || null,
      gex_levels: primary?.gex_levels || null,
      position: primary?.position || null,
      lt_levels: primary?.lt_levels || null,
      evaluation_readiness: primary?.evaluation_readiness || null,
      strategies,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Strategy status by name
app.get('/strategy/status/:name', (req, res) => {
  try {
    const engine = service.multiStrategyEngine;
    if (!engine) {
      return res.status(503).json({ error: 'Multi-strategy engine not initialized' });
    }
    const strategies = engine.getStrategiesStatus();
    const found = strategies.find(s => s.name === req.params.name || s.constant === req.params.name);
    if (!found) {
      return res.status(404).json({ error: `Strategy ${req.params.name} not found` });
    }
    res.json(found);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Enable/disable specific strategy
app.post('/strategy/enable', (req, res) => {
  try {
    const engine = service.multiStrategyEngine;
    if (!engine) {
      return res.status(503).json({ error: 'Multi-strategy engine not initialized' });
    }

    const { strategy } = req.body;
    if (strategy) {
      const found = engine.enableStrategy(strategy);
      if (!found) return res.status(404).json({ error: `Strategy ${strategy} not found` });
      res.json({ message: `Strategy ${strategy} enabled` });
    } else {
      engine.enable();
      res.json({ message: 'All strategies enabled' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/strategy/disable', (req, res) => {
  try {
    const engine = service.multiStrategyEngine;
    if (!engine) {
      return res.status(503).json({ error: 'Multi-strategy engine not initialized' });
    }

    const { strategy } = req.body;
    if (strategy) {
      const found = engine.disableStrategy(strategy);
      if (!found) return res.status(404).json({ error: `Strategy ${strategy} not found` });
      res.json({ message: `Strategy ${strategy} disabled` });
    } else {
      engine.disable();
      res.json({ message: 'All strategies disabled' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === AI Trader Endpoint (legacy) ===

// AI Trader status — enriched snapshot for dashboard panel
app.get('/ai/status', (req, res) => {
  try {
    if (!service.aiEngine) {
      return res.status(404).json({ error: 'AI Strategy Engine not available' });
    }

    const engine = service.aiEngine;
    const gexLevels = engine.gexCalculator?.getCurrentLevels();

    res.json({
      strategy: {
        name: 'AI Trader',
        type: 'ai-trader',
        constant: engine.strategyConstant,
        enabled: engine.enabled,
        dryRun: engine.dryRun,
        observationMode: engine.observationMode,
        model: engine.llm.model,
      },
      data_readiness: {
        history_1m: engine.history1mReady,
        history_1h: engine.history1hReady,
        gex: engine.gexReady,
        all_ready: engine.isDataReady(),
      },
      trading_day: {
        date: engine.currentTradingDay,
        bias: engine.activeBias ? {
          direction: engine.activeBias.bias,
          conviction: engine.activeBias.conviction,
          reasoning: engine.activeBias.reasoning,
          key_levels_to_watch: engine.activeBias.key_levels_to_watch || [],
        } : null,
        biasFormed: engine.biasFormed,
        entries: engine.totalEntriesToday,
        losses: engine.totalLossesToday,
        llmCalls: engine.llmCallsToday,
        biasHistory: engine.biasHistory,
        lastEntryEvaluation: engine.lastEntryEvaluation,
      },
      position: {
        in_position: engine.inPosition,
        current: engine.currentPosition ? {
          symbol: engine.currentPosition.symbol,
          side: engine.currentPosition.side,
          entry_price: engine.currentPosition.entryPrice,
          entry_time: engine.currentPosition.entryTime,
        } : null,
      },
      trading_window: (() => {
        const now = Date.now();
        const window = getTradingWindowName(now);
        const inWindow = isInTradingWindow(now);
        const blockers = [];
        if (window === 'midday_break') blockers.push('Midday break (11:00-1:00 ET)');
        if (window === 'outside') blockers.push('Outside trading hours');
        if (engine.inPosition) blockers.push('In position');
        if (engine.totalEntriesToday >= engine.maxEntriesPerDay) blockers.push(`Daily entry limit (${engine.maxEntriesPerDay})`);
        if (engine.totalLossesToday >= engine.maxLossesPerDay) blockers.push(`Daily loss limit (${engine.maxLossesPerDay})`);
        if (engine.lastStopTimestamp > 0 && now - engine.lastStopTimestamp < engine.stopCooldownMs) {
          const remaining = Math.ceil((engine.stopCooldownMs - (now - engine.lastStopTimestamp)) / 60000);
          blockers.push(`Post-stop cooldown (${remaining}m remaining)`);
        }
        if (engine.lastManagedExitTimestamp > 0 && now - engine.lastManagedExitTimestamp < engine.managedExitCooldownMs) {
          const remaining = Math.ceil((engine.managedExitCooldownMs - (now - engine.lastManagedExitTimestamp)) / 60000);
          blockers.push(`Post-managed-exit cooldown (${remaining}m remaining)`);
        }
        if (engine.observationMode) {
          blockers.push('Observation mode (signals blocked)');
        }
        return { window, in_trading_window: inWindow, blockers };
      })(),
      cost: engine.llm.getCostSummary(),
      gex_levels: gexLevels ? {
        put_wall: gexLevels.putWall,
        call_wall: gexLevels.callWall,
        support: gexLevels.support || [],
        resistance: gexLevels.resistance || [],
        regime: gexLevels.regime,
      } : null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('AI status error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/ai/test-cycle', async (req, res) => {
  try {
    if (!service.aiEngine) {
      return res.status(404).json({ error: 'AI Strategy Engine not available' });
    }
    const results = await service.aiEngine.testCycle();
    res.json(results);
  } catch (error) {
    logger.error('AI test cycle error:', error);
    res.status(500).json({ error: error.message, stack: error.stack?.split('\n').slice(0, 5) });
  }
});

app.post('/ai/reassess-bias', async (req, res) => {
  try {
    if (!service.aiEngine) {
      return res.status(404).json({ error: 'AI Strategy Engine not available' });
    }
    const result = await service.aiEngine.reassessBias();
    if (result.error) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (error) {
    logger.error('AI reassess bias error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/ai/observation-mode', async (req, res) => {
  try {
    if (!service.aiEngine) {
      return res.status(404).json({ error: 'AI Strategy Engine not available' });
    }
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Missing required field: enabled (boolean)' });
    }
    service.aiEngine.observationMode = enabled;
    await service.aiEngine._saveState();
    logger.info(`AI Trader observation mode ${enabled ? 'ENABLED' : 'DISABLED'} (persisted to Redis)`);
    res.json({
      success: true,
      observationMode: enabled,
      message: enabled
        ? 'AI Trader in observation-only mode — will NOT publish trade signals'
        : 'AI Trader in normal mode — will publish trade signals',
    });
  } catch (error) {
    logger.error('AI observation mode error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start HTTP server
const PORT = process.env.PORT || config.HTTP_PORT || 3015;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
app.listen(PORT, BIND_HOST, () => {
  logger.info(`Signal Generator HTTP server listening on ${BIND_HOST}:${PORT}`);
});

// Start the service
service.start().catch(error => {
  logger.error('Failed to start signal generator service:', error);
  process.exit(1);
});

export default app;
