#!/usr/bin/env node

// Signal Generator Service - HTTP Server and Service Entry Point
// Fix max listeners warning for process event emitters
process.setMaxListeners(20);

import express from 'express';
import { createLogger } from '../shared/index.js';
import config from './src/utils/config.js';
import service from './src/main.js';

const logger = createLogger('signal-generator-server');
const app = express();

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    const health = service.getHealth();
    res.json(health);
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({
      service: 'signal-generator',
      status: 'error',
      error: error.message
    });
  }
});

// GEX endpoints
app.get('/gex/levels', async (req, res) => {
  try {
    const levels = service.gexCalculator?.getCurrentLevels();
    if (!levels) {
      return res.status(404).json({ error: 'No GEX levels available' });
    }
    res.json(levels);
  } catch (error) {
    logger.error('GEX levels error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Hybrid GEX health endpoint
app.get('/gex/health', async (req, res) => {
  try {
    const healthData = {
      hybrid: !!service.hybridGexCalculator,
      tradier: !!service.tradierExposureService,
      cboe: true
    };

    if (service.hybridGexCalculator && typeof service.hybridGexCalculator.getHealthStatus === 'function') {
      healthData.details = service.hybridGexCalculator.getHealthStatus();
    }

    res.json(healthData);
  } catch (error) {
    logger.error('Hybrid GEX health error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/gex/refresh', async (req, res) => {
  try {
    if (!service.gexCalculator) {
      return res.status(503).json({ error: 'GEX calculator not initialized' });
    }

    const levels = await service.gexCalculator.calculateLevels(true);
    res.json(levels);
  } catch (error) {
    logger.error('GEX refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Enhanced exposure endpoints (Tradier-based)
app.get('/exposure/levels', async (req, res) => {
  try {
    if (!service.tradierExposureService) {
      return res.status(404).json({
        error: 'Tradier exposure service not available',
        fallback: 'Use /gex/levels for CBOE-based GEX data'
      });
    }

    const exposures = service.tradierExposureService.getCurrentExposures();
    if (!exposures) {
      return res.status(404).json({ error: 'No exposure data available' });
    }

    res.json(exposures);
  } catch (error) {
    logger.error('Exposure levels error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/exposure/refresh', async (req, res) => {
  try {
    if (!service.tradierExposureService) {
      return res.status(503).json({ error: 'Tradier exposure service not initialized' });
    }

    const exposures = await service.tradierExposureService.forceRefresh();
    res.json(exposures);
  } catch (error) {
    logger.error('Exposure refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// VEX endpoints
app.get('/vex/levels', async (req, res) => {
  try {
    if (!service.tradierExposureService) {
      return res.status(404).json({ error: 'Tradier exposure service not available' });
    }

    const exposures = service.tradierExposureService.getCurrentExposures();
    if (!exposures || !exposures.futures) {
      return res.status(404).json({ error: 'No VEX data available' });
    }

    // Return VEX-specific data
    const vexData = {};
    for (const [symbol, data] of Object.entries(exposures.futures)) {
      vexData[symbol] = {
        symbol,
        timestamp: exposures.timestamp,
        futuresPrice: data.futuresPrice,
        totalVex: data.totals.vex,
        regime: data.regime.vex,
        levels: data.levels
      };
    }

    res.json(vexData);
  } catch (error) {
    logger.error('VEX levels error:', error);
    res.status(500).json({ error: error.message });
  }
});

// CEX endpoints
app.get('/cex/levels', async (req, res) => {
  try {
    if (!service.tradierExposureService) {
      return res.status(404).json({ error: 'Tradier exposure service not available' });
    }

    const exposures = service.tradierExposureService.getCurrentExposures();
    if (!exposures || !exposures.futures) {
      return res.status(404).json({ error: 'No CEX data available' });
    }

    // Return CEX-specific data
    const cexData = {};
    for (const [symbol, data] of Object.entries(exposures.futures)) {
      cexData[symbol] = {
        symbol,
        timestamp: exposures.timestamp,
        futuresPrice: data.futuresPrice,
        totalCex: data.totals.cex,
        regime: data.regime.cex,
        levels: data.levels
      };
    }

    res.json(cexData);
  } catch (error) {
    logger.error('CEX levels error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Service health with exposure details
app.get('/exposure/health', async (req, res) => {
  try {
    if (!service.tradierExposureService) {
      return res.status(404).json({ error: 'Tradier exposure service not available' });
    }

    const health = service.tradierExposureService.getHealthStatus();
    res.json(health);
  } catch (error) {
    logger.error('Exposure health error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Strategy endpoints
app.post('/strategy/enable', (req, res) => {
  try {
    service.strategyEngine?.enable();
    res.json({ message: 'Strategy enabled' });
  } catch (error) {
    logger.error('Strategy enable error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/strategy/disable', (req, res) => {
  try {
    service.strategyEngine?.disable();
    res.json({ message: 'Strategy disabled' });
  } catch (error) {
    logger.error('Strategy disable error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Tradier control endpoints
app.get('/tradier/status', (req, res) => {
  try {
    const status = service.getTradierStatus();
    res.json(status);
  } catch (error) {
    logger.error('Tradier status error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/tradier/enable', async (req, res) => {
  try {
    const result = await service.enableTradier();
    res.json(result);
  } catch (error) {
    logger.error('Tradier enable error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/tradier/disable', async (req, res) => {
  try {
    const result = await service.disableTradier();
    res.json(result);
  } catch (error) {
    logger.error('Tradier disable error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Tradier chains data endpoint
app.get('/tradier/chains', (req, res) => {
  try {
    if (!service.tradierExposureService) {
      return res.status(404).json({ error: 'Tradier exposure service not available' });
    }

    // Get cached chain data from the chain manager
    const chainManager = service.tradierExposureService.chainManager;
    if (!chainManager) {
      return res.status(404).json({ error: 'Chain manager not available' });
    }

    const chainsData = chainManager.getAllCachedChains();
    res.json(chainsData);
  } catch (error) {
    logger.error('Tradier chains error:', error);
    res.status(500).json({ error: error.message });
  }
});

// IV Skew endpoints
app.get('/iv/skew', (req, res) => {
  try {
    if (!service.ivSkewCalculator) {
      return res.status(404).json({ error: 'IV Skew calculator not available' });
    }

    const skewData = service.ivSkewCalculator.getCurrentIVSkew();
    if (!skewData) {
      return res.status(404).json({
        error: 'No IV skew data available',
        message: 'IV skew data may not have been calculated yet'
      });
    }

    res.json(skewData);
  } catch (error) {
    logger.error('IV skew error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/iv/history', (req, res) => {
  try {
    if (!service.ivSkewCalculator) {
      return res.status(404).json({ error: 'IV Skew calculator not available' });
    }

    const history = service.ivSkewCalculator.getSkewHistory();
    res.json({
      count: history.length,
      history: history
    });
  } catch (error) {
    logger.error('IV history error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Candle history endpoint for chart initialization
app.get('/candles', (req, res) => {
  try {
    const count = parseInt(req.query.count) || 60;
    const buffer = service.strategyEngine?.candleBuffer;

    if (!buffer) {
      return res.status(404).json({ error: 'Candle buffer not available' });
    }

    const candles = buffer.getCandles(count) || [];
    res.json({
      symbol: buffer.symbol || 'NQ',
      timeframe: buffer.timeframe || '1',
      count: candles.length,
      candles: candles.map(c => c.toDict ? c.toDict() : c)
    });
  } catch (error) {
    logger.error('Candles endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start HTTP server
const PORT = config.HTTP_PORT || 3015;
app.listen(PORT, '127.0.0.1', () => {
  logger.info(`Signal Generator HTTP server listening on port ${PORT}`);
});

// Start the signal generator service (this was missing!)
service.start().catch(error => {
  logger.error('Failed to start signal generator service:', error);
  process.exit(1);
});

// Export for ecosystem.config.cjs
export default app;