#!/usr/bin/env node

// Data Service - HTTP Server and Service Entry Point
process.setMaxListeners(20);

import express from 'express';
import { createLogger } from '../shared/index.js';
import config from './src/config.js';
import service from './src/main.js';

const logger = createLogger('data-service-server');
const app = express();

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  try {
    res.json(service.getHealth());
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({ service: 'data-service', status: 'error', error: error.message });
  }
});

// === GEX Endpoints ===

// GEX levels with product parameter
app.get('/gex/levels', async (req, res) => {
  try {
    const product = req.query.product || 'NQ';
    const levels = service.getGexLevels(product);
    if (!levels) return res.status(404).json({ error: `No GEX levels available for ${product}` });
    res.json(levels);
  } catch (error) {
    logger.error('GEX levels error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Convenience aliases
app.get('/gex/levels/nq', async (req, res) => {
  try {
    const levels = service.getGexLevels('NQ');
    if (!levels) return res.status(404).json({ error: 'No NQ GEX levels available' });
    res.json(levels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/gex/levels/es', async (req, res) => {
  try {
    const levels = service.getGexLevels('ES');
    if (!levels) return res.status(404).json({ error: 'No ES GEX levels available' });
    res.json(levels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GEX refresh
app.post('/gex/refresh', async (req, res) => {
  try {
    const product = req.query.product || 'NQ';
    const levels = await service.refreshGexLevels(product);
    res.json(levels);
  } catch (error) {
    logger.error('GEX refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GEX health (hybrid status)
app.get('/gex/health', async (req, res) => {
  try {
    const health = service.getHealth();
    res.json({
      gex: health.components.gex,
      hybridGex: health.connectionDetails.hybridGex,
      tradier: health.components.tradier
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Candle Endpoints ===

app.get('/candles', (req, res) => {
  try {
    const symbol = req.query.symbol || 'NQ';
    const count = parseInt(req.query.count) || 60;
    const candles = service.getCandles(symbol, count);
    res.json({
      symbol: symbol.toUpperCase(),
      timeframe: '1',
      count: candles.length,
      candles
    });
  } catch (error) {
    logger.error('Candles error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/candles/hourly', (req, res) => {
  try {
    const symbol = req.query.symbol || 'NQ';
    const count = parseInt(req.query.count) || 300;
    const candles = service.getHourlyCandles(symbol, count);
    res.json({
      symbol: symbol.toUpperCase(),
      timeframe: '60',
      count: candles.length,
      candles
    });
  } catch (error) {
    logger.error('Hourly candles error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === IV Skew Endpoints ===

app.get('/iv/skew', (req, res) => {
  try {
    const skewData = service.getIVSkew();
    if (!skewData) return res.status(404).json({ error: 'No IV skew data available' });
    res.json(skewData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/iv/history', (req, res) => {
  try {
    const history = service.getIVHistory();
    res.json({ count: history.length, history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Exposure Endpoints (Tradier) ===

app.get('/exposure/levels', async (req, res) => {
  try {
    const exposures = service.getExposureLevels();
    if (!exposures) {
      return res.status(404).json({
        error: 'Tradier exposure service not available',
        fallback: 'Use /gex/levels for CBOE-based GEX data'
      });
    }
    res.json(exposures);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/exposure/refresh', async (req, res) => {
  try {
    const exposures = await service.refreshExposure();
    res.json(exposures);
  } catch (error) {
    logger.error('Exposure refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/exposure/health', async (req, res) => {
  try {
    if (!service.tradierExposureService) {
      return res.status(404).json({ error: 'Tradier exposure service not available' });
    }
    res.json(service.tradierExposureService.getHealthStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === VEX/CEX Endpoints ===

app.get('/vex/levels', async (req, res) => {
  try {
    const vex = service.getVexLevels();
    if (!vex) return res.status(404).json({ error: 'No VEX data available' });
    res.json(vex);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/cex/levels', async (req, res) => {
  try {
    const cex = service.getCexLevels();
    if (!cex) return res.status(404).json({ error: 'No CEX data available' });
    res.json(cex);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === LT Levels Endpoints ===

app.get('/lt/levels', (req, res) => {
  try {
    const product = req.query.product || 'NQ';
    const levels = service.getLtLevels(product);
    if (!levels) return res.status(404).json({ error: `No LT levels for ${product}` });
    res.json(levels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/ls/sentiment', (req, res) => {
  try {
    const product = req.query.product || 'NQ';
    const sentiment = service.getLsSentiment(product);
    if (!sentiment) return res.status(404).json({ error: `No LS sentiment for ${product}` });
    res.json({ sentiment, product });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Tradier Control Endpoints ===

app.get('/tradier/status', (req, res) => {
  try {
    res.json(service.getTradierStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/tradier/enable', async (req, res) => {
  try {
    const result = await service.enableTradier();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/tradier/disable', async (req, res) => {
  try {
    const result = await service.disableTradier();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === TradingView Token Endpoint ===

app.post('/tradingview/token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || !token.startsWith('eyJ')) {
      return res.status(400).json({ error: 'Invalid token - must be a JWT string starting with eyJ' });
    }
    const result = await service.updateTradingViewToken(token);
    res.json(result);
  } catch (error) {
    logger.error('TradingView token update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start HTTP server
const PORT = config.HTTP_PORT;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
app.listen(PORT, BIND_HOST, () => {
  logger.info(`Data Service HTTP server listening on ${BIND_HOST}:${PORT}`);
});

// Start the data service
service.start().catch(error => {
  logger.error('Failed to start data service:', error);
  process.exit(1);
});

export default app;
