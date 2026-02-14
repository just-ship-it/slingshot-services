import axios from 'axios';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('slingshot-client');

const NQ_SIGGEN_URL = process.env.SIGNAL_GENERATOR_URL || 'http://localhost:3015';
const ES_SIGGEN_URL = process.env.SIGNAL_GENERATOR_ES_URL || 'http://localhost:3016';

/**
 * Fetch GEX levels from signal generator
 */
async function fetchGexLevels(baseUrl, label) {
  try {
    const response = await axios.get(`${baseUrl}/gex/levels`, { timeout: 5000 });
    return response.data;
  } catch (error) {
    logger.warn(`${label} GEX levels unavailable: ${error.message}`);
    return null;
  }
}

/**
 * Fetch strategy status from signal generator
 */
async function fetchStrategyStatus(baseUrl, label) {
  try {
    const response = await axios.get(`${baseUrl}/strategy/status`, { timeout: 5000 });
    return response.data;
  } catch (error) {
    logger.warn(`${label} strategy status unavailable: ${error.message}`);
    return null;
  }
}

/**
 * Fetch exposure data (Tradier-based GEX/VEX/CEX)
 */
async function fetchExposureLevels(baseUrl, label) {
  try {
    const response = await axios.get(`${baseUrl}/exposure/levels`, { timeout: 5000 });
    return response.data;
  } catch (error) {
    logger.warn(`${label} exposure levels unavailable: ${error.message}`);
    return null;
  }
}

/**
 * Fetch IV skew data
 */
async function fetchIVSkew(baseUrl, label) {
  try {
    const response = await axios.get(`${baseUrl}/iv/skew`, { timeout: 5000 });
    return response.data;
  } catch (error) {
    logger.warn(`${label} IV skew unavailable: ${error.message}`);
    return null;
  }
}

/**
 * Fetch all available Slingshot internal data
 */
export async function fetchAll() {
  const [nqGex, esGex, nqStrategy, esStrategy, nqExposure, nqIVSkew] = await Promise.allSettled([
    fetchGexLevels(NQ_SIGGEN_URL, 'NQ'),
    fetchGexLevels(ES_SIGGEN_URL, 'ES'),
    fetchStrategyStatus(NQ_SIGGEN_URL, 'NQ'),
    fetchStrategyStatus(ES_SIGGEN_URL, 'ES'),
    fetchExposureLevels(NQ_SIGGEN_URL, 'NQ'),
    fetchIVSkew(NQ_SIGGEN_URL, 'NQ')
  ]);

  const result = {
    gex: {
      nq: nqGex.status === 'fulfilled' ? nqGex.value : null,
      es: esGex.status === 'fulfilled' ? esGex.value : null
    },
    strategy: {
      nq: nqStrategy.status === 'fulfilled' ? nqStrategy.value : null,
      es: esStrategy.status === 'fulfilled' ? esStrategy.value : null
    },
    exposure: nqExposure.status === 'fulfilled' ? nqExposure.value : null,
    ivSkew: nqIVSkew.status === 'fulfilled' ? nqIVSkew.value : null
  };

  const available = [
    result.gex.nq && 'NQ GEX',
    result.gex.es && 'ES GEX',
    result.strategy.nq && 'NQ Strategy',
    result.strategy.es && 'ES Strategy',
    result.exposure && 'Exposure',
    result.ivSkew && 'IV Skew'
  ].filter(Boolean);

  logger.info(`Slingshot data available: ${available.length > 0 ? available.join(', ') : 'none'}`);
  return result;
}
