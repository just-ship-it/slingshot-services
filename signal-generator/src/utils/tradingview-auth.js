// TradingView JWT Token Authentication & Auto-Refresh
//
// Handles HTTP login to TradingView, JWT extraction from page HTML,
// and token caching in Redis for sharing across service instances.

import { createLogger } from '../../../shared/index.js';
import Redis from 'ioredis';

const logger = createLogger('tradingview-auth');

const REDIS_TOKEN_KEY = 'tradingview:jwt_token';
const REDIS_TOKEN_TTL = 5 * 60 * 60; // 5 hours (tokens last ~4h, cache a bit longer)
const REDIS_SESSION_KEY = 'tradingview:session_cookies';
const REDIS_SESSION_TTL = 7 * 24 * 60 * 60; // 7 days (sessionid lasts days to weeks)

const TV_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * POST to TradingView /accounts/signin/ and return session cookies.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<Object>} cookies map
 */
async function login(username, password) {
  logger.info('Attempting TradingView HTTP login...');

  const response = await fetch('https://www.tradingview.com/accounts/signin/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': TV_USER_AGENT,
      'Origin': 'https://www.tradingview.com',
      'Referer': 'https://www.tradingview.com/',
    },
    redirect: 'manual',
    body: new URLSearchParams({ username, password, remember: 'on' }).toString()
  });

  // Extract cookies
  const cookies = {};
  const setCookies = response.headers.getSetCookie?.() || [];

  if (setCookies.length === 0) {
    // Fallback for older Node versions
    const raw = response.headers.raw?.()?.['set-cookie'] || [];
    for (const c of raw) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair.split('=');
      cookies[name.trim()] = rest.join('=').trim();
    }
  } else {
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair.split('=');
      cookies[name.trim()] = rest.join('=').trim();
    }
  }

  // Check for errors
  const body = await response.text();

  if (body.includes('captcha') || body.includes('CAPTCHA') || body.includes('recaptcha')) {
    throw new Error('CAPTCHA detected - TradingView is blocking automated login');
  }

  if (!cookies.sessionid) {
    throw new Error(`Login failed - no sessionid cookie received (status: ${response.status})`);
  }

  logger.info('TradingView login successful');
  return cookies;
}

/**
 * GET tradingview.com with session cookies and parse the JWT from the HTML.
 * TradingView embeds the auth_token in inline script tags.
 * @param {Object} cookies - Session cookies from login()
 * @returns {Promise<string|null>} JWT token or null
 */
async function extractJwtFromPage(cookies) {
  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  const response = await fetch('https://www.tradingview.com/', {
    headers: {
      'User-Agent': TV_USER_AGENT,
      'Cookie': cookieStr
    }
  });

  const html = await response.text();

  // JWT patterns in TradingView page HTML (ordered by specificity)
  const patterns = [
    /\"auth_token\"\s*:\s*\"(eyJ[^"]+)\"/,
    /authToken\"\s*:\s*\"(eyJ[^"]+)\"/,
    /set_auth_token.*?\"(eyJ[^"]+)\"/,
    /\"(eyJ[A-Za-z0-9_-]{100,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\"/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Decode a JWT and return its expiry timestamp (seconds since epoch).
 * @param {string} jwt
 * @returns {number|null} exp timestamp or null if decode fails
 */
function getTokenExpiry(jwt) {
  if (!jwt) return null;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp || null;
  } catch {
    return null;
  }
}

/**
 * Check how many seconds until a JWT expires. Returns negative if already expired.
 * @param {string} jwt
 * @returns {number|null} seconds until expiry, or null if can't determine
 */
function getTokenTTL(jwt) {
  const exp = getTokenExpiry(jwt);
  if (!exp) return null;
  return exp - Math.floor(Date.now() / 1000);
}

/**
 * Full refresh flow: decode credentials, login, extract JWT, return token.
 * After successful login, persists session cookies in Redis for future
 * CAPTCHA-free JWT extractions.
 * @param {string} credentialsB64 - Base64-encoded JSON with {username, password}
 * @param {string} [redisUrl] - Redis URL for persisting session cookies
 * @returns {Promise<string>} Fresh JWT token
 */
async function refreshToken(credentialsB64, redisUrl) {
  if (!credentialsB64) {
    throw new Error('No TRADINGVIEW_CREDENTIALS configured - cannot refresh token');
  }

  let creds;
  try {
    creds = JSON.parse(Buffer.from(credentialsB64, 'base64').toString('utf-8'));
  } catch (e) {
    throw new Error(`Failed to decode TRADINGVIEW_CREDENTIALS: ${e.message}`);
  }

  if (!creds.username || !creds.password) {
    throw new Error('TRADINGVIEW_CREDENTIALS missing username or password');
  }

  // Step 1: Login
  const cookies = await login(creds.username, creds.password);

  // Step 2: Persist session cookies for future CAPTCHA-free refreshes
  if (redisUrl) {
    await cacheSessionCookies(redisUrl, cookies);
  }

  // Step 3: Extract JWT from authenticated page
  const jwt = await extractJwtFromPage(cookies);

  if (!jwt) {
    throw new Error('Login succeeded but could not extract JWT from page HTML');
  }

  const ttl = getTokenTTL(jwt);
  const expiry = getTokenExpiry(jwt);
  logger.info(`Fresh JWT obtained via login - expires in ${Math.floor(ttl / 60)} minutes (${new Date(expiry * 1000).toISOString()})`);

  return jwt;
}

/**
 * Save TradingView session cookies to Redis for future JWT extractions
 * without needing to POST to /accounts/signin/ (avoids CAPTCHA).
 * @param {string} redisUrl
 * @param {Object} cookies - Cookie map from login()
 */
async function cacheSessionCookies(redisUrl, cookies) {
  let redis;
  try {
    redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await redis.connect();
    await redis.setex(REDIS_SESSION_KEY, REDIS_SESSION_TTL, JSON.stringify(cookies));
    logger.info('Session cookies cached in Redis (TTL: 7 days)');
  } catch (error) {
    logger.warn('Failed to cache session cookies in Redis:', error.message);
  } finally {
    if (redis) redis.disconnect();
  }
}

/**
 * Read cached TradingView session cookies from Redis.
 * @param {string} redisUrl
 * @returns {Promise<Object|null>} Cookie map or null
 */
async function getCachedSessionCookies(redisUrl) {
  let redis;
  try {
    redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await redis.connect();
    const raw = await redis.get(REDIS_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    logger.warn('Failed to read session cookies from Redis:', error.message);
    return null;
  } finally {
    if (redis) redis.disconnect();
  }
}

/**
 * Attempt to extract a fresh JWT using cached session cookies (no login POST).
 * This avoids CAPTCHA by reusing the long-lived sessionid cookie.
 * @param {string} redisUrl
 * @returns {Promise<string|null>} Fresh JWT token, or null if cookies are expired/missing
 */
async function refreshJwtFromSession(redisUrl) {
  const cookies = await getCachedSessionCookies(redisUrl);
  if (!cookies || !cookies.sessionid) {
    logger.info('No cached session cookies available');
    return null;
  }

  logger.info('Attempting JWT extraction from cached session cookies (no login)...');

  const jwt = await extractJwtFromPage(cookies);
  if (!jwt) {
    logger.warn('Cached session cookies did not yield a JWT - sessionid may be expired');
    return null;
  }

  const ttl = getTokenTTL(jwt);
  const expiry = getTokenExpiry(jwt);

  if (ttl !== null && ttl <= 0) {
    logger.warn('JWT extracted from session cookies is already expired');
    return null;
  }

  logger.info(`Refreshed JWT from cached session (no login) - expires in ${Math.floor(ttl / 60)} minutes (${new Date(expiry * 1000).toISOString()})`);
  return jwt;
}

/**
 * Cache a JWT token in Redis so multiple service instances share it.
 * @param {string} redisUrl
 * @param {string} jwt
 */
async function cacheTokenInRedis(redisUrl, jwt) {
  let redis;
  try {
    redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await redis.connect();
    await redis.setex(REDIS_TOKEN_KEY, REDIS_TOKEN_TTL, jwt);
    logger.info('JWT token cached in Redis');
  } catch (error) {
    logger.warn('Failed to cache JWT in Redis:', error.message);
  } finally {
    if (redis) {
      redis.disconnect();
    }
  }
}

/**
 * Read a cached JWT token from Redis.
 * @param {string} redisUrl
 * @returns {Promise<string|null>} cached token or null
 */
async function getCachedToken(redisUrl) {
  let redis;
  try {
    redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await redis.connect();
    const token = await redis.get(REDIS_TOKEN_KEY);
    return token || null;
  } catch (error) {
    logger.warn('Failed to read JWT from Redis:', error.message);
    return null;
  } finally {
    if (redis) {
      redis.disconnect();
    }
  }
}

/**
 * Get the best available token: compare env var token vs Redis cached token,
 * return whichever expires later.
 * @param {string} envToken - Token from TRADINGVIEW_JWT_TOKEN env var
 * @param {string} redisUrl
 * @returns {Promise<{token: string, source: string, ttl: number}|null>}
 */
async function getBestAvailableToken(envToken, redisUrl) {
  const cachedToken = await getCachedToken(redisUrl);

  const envTTL = getTokenTTL(envToken) || -Infinity;
  const cachedTTL = getTokenTTL(cachedToken) || -Infinity;

  // Always prefer Redis token (set via UI "Set Token") over env token
  if (cachedToken) {
    const status = cachedTTL > 0 ? `TTL: ${Math.floor(cachedTTL / 60)}min` : `expired ${Math.floor(-cachedTTL / 60)}min ago`;
    logger.info(`Using Redis-cached token (${status})`);
    return { token: cachedToken, source: cachedTTL > 0 ? 'redis' : 'redis (expired)', ttl: cachedTTL };
  }

  if (envToken) {
    const status = envTTL > 0 ? `TTL: ${Math.floor(envTTL / 60)}min` : `expired ${Math.floor(-envTTL / 60)}min ago`;
    logger.info(`Using env token (${status}) — no Redis token available`);
    return { token: envToken, source: envTTL > 0 ? 'env' : 'env (expired)', ttl: envTTL };
  }

  return null;
}

export {
  login,
  extractJwtFromPage,
  refreshToken,
  refreshJwtFromSession,
  getTokenExpiry,
  getTokenTTL,
  cacheTokenInRedis,
  getCachedToken,
  getBestAvailableToken,
  cacheSessionCookies,
  getCachedSessionCookies,
  REDIS_TOKEN_KEY
};
