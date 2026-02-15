#!/usr/bin/env node

/**
 * Standalone test script to attempt TradingView JWT token retrieval via HTTP login.
 *
 * Usage: node scripts/test-tv-auth.js
 *
 * Reads TRADINGVIEW_CREDENTIALS from shared/.env (base64-encoded JSON with username/password)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no dependencies needed)
function loadEnv() {
  try {
    const envPath = resolve(__dirname, '../shared/.env');
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (e) {
    console.error('Could not load .env:', e.message);
  }
}

loadEnv();

// Parse credentials
function getCredentials() {
  const b64 = process.env.TRADINGVIEW_CREDENTIALS;
  if (!b64) {
    console.error('TRADINGVIEW_CREDENTIALS not set in shared/.env');
    process.exit(1);
  }
  try {
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    const creds = JSON.parse(decoded);
    console.log(`Credentials loaded for: ${creds.username}`);
    return creds;
  } catch (e) {
    console.error('Failed to decode credentials:', e.message);
    process.exit(1);
  }
}

// Step 1: Login to TradingView
async function login(username, password) {
  console.log('\n--- Step 1: POST to /accounts/signin/ ---');

  const response = await fetch('https://www.tradingview.com/accounts/signin/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': 'https://www.tradingview.com',
      'Referer': 'https://www.tradingview.com/',
    },
    redirect: 'manual',
    body: new URLSearchParams({ username, password, remember: 'on' }).toString()
  });

  console.log(`Response status: ${response.status}`);
  console.log(`Response headers:`);
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie' || key.toLowerCase() === 'location') {
      console.log(`  ${key}: ${value.substring(0, 120)}...`);
    }
  }

  // Extract cookies
  const cookies = {};
  const setCookies = response.headers.getSetCookie?.() || [];

  // Fallback: some Node versions don't have getSetCookie
  if (setCookies.length === 0) {
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

  console.log(`\nCookies received: ${Object.keys(cookies).join(', ')}`);

  if (cookies.sessionid) {
    console.log(`  sessionid: ${cookies.sessionid.substring(0, 20)}...`);
  }
  if (cookies.sessionid_sign) {
    console.log(`  sessionid_sign: ${cookies.sessionid_sign.substring(0, 20)}...`);
  }

  // Check response body
  const body = await response.text();
  console.log(`\nResponse body (first 500 chars):\n${body.substring(0, 500)}`);

  // Check for CAPTCHA or error indicators
  if (body.includes('captcha') || body.includes('CAPTCHA') || body.includes('recaptcha')) {
    console.error('\n🚨 CAPTCHA detected! HTTP login may be blocked.');
  }
  if (body.includes('error') || body.includes('Error')) {
    console.warn('\n⚠️ Response may contain errors — check body above');
  }

  return { cookies, body, status: response.status };
}

// Step 2: Try to extract JWT from an authenticated page
async function extractJwt(cookies) {
  console.log('\n--- Step 2: Extract JWT from authenticated session ---');

  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  // Try fetching the main page with session cookies
  console.log('Fetching tradingview.com with session cookies...');
  const response = await fetch('https://www.tradingview.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Cookie': cookieStr
    }
  });

  console.log(`Response status: ${response.status}`);
  const html = await response.text();
  console.log(`Page size: ${html.length} chars`);

  // Look for JWT patterns in the HTML
  // TradingView embeds auth tokens in various script tags
  const patterns = [
    // Direct JWT in page data
    /\"auth_token\"\s*:\s*\"(eyJ[^"]+)\"/,
    // In window.__INITIAL_STATE__ or similar
    /authToken\"\s*:\s*\"(eyJ[^"]+)\"/,
    // set_auth_token in inline scripts
    /set_auth_token.*?\"(eyJ[^"]+)\"/,
    // Any JWT-looking token (eyJ prefix = base64 of {"alg"...)
    /\"(eyJ[A-Za-z0-9_-]{100,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\"/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const token = match[1];
      console.log(`\n✅ Found JWT token! (${token.length} chars)`);
      console.log(`   First 80 chars: ${token.substring(0, 80)}...`);

      // Try to decode and show expiry
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        console.log(`   User ID: ${payload.user_id}`);
        console.log(`   Plan: ${payload.plan}`);
        console.log(`   Expires: ${new Date(payload.exp * 1000).toISOString()}`);
        console.log(`   Issued: ${new Date(payload.iat * 1000).toISOString()}`);
      } catch (e) {
        console.log(`   (Could not decode payload: ${e.message})`);
      }

      return token;
    }
  }

  // If no JWT found, look for any interesting auth-related strings
  console.log('\n❌ No JWT found in page HTML. Searching for auth-related strings...');

  const authPatterns = [
    /auth[_-]?token/gi,
    /session[_-]?id/gi,
    /\"user\":\{[^}]{0,200}\}/gi,
  ];

  for (const p of authPatterns) {
    const matches = html.match(p);
    if (matches) {
      console.log(`  Pattern ${p}: ${matches.length} matches`);
      console.log(`    First: ${matches[0].substring(0, 100)}`);
    }
  }

  return null;
}

// Step 3: Try the chart auth endpoint
async function tryChartAuth(cookies) {
  console.log('\n--- Step 3: Try chart/token endpoints ---');

  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  // Some known endpoints that might return auth info
  const endpoints = [
    'https://www.tradingview.com/accounts/token/',
    'https://www.tradingview.com/api/v1/auth/token/',
  ];

  for (const url of endpoints) {
    try {
      console.log(`\nTrying ${url}...`);
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Cookie': cookieStr
        },
        redirect: 'manual'
      });
      console.log(`  Status: ${response.status}`);
      if (response.status === 200) {
        const body = await response.text();
        console.log(`  Body (first 300 chars): ${body.substring(0, 300)}`);

        // Check for JWT in response
        const jwtMatch = body.match(/(eyJ[A-Za-z0-9_-]{100,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
        if (jwtMatch) {
          console.log(`\n✅ Found JWT in ${url}!`);
          return jwtMatch[1];
        }
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  return null;
}

// Main
async function main() {
  console.log('=== TradingView Authentication Test ===\n');

  const creds = getCredentials();

  // Step 1: Login
  const { cookies, status } = await login(creds.username, creds.password);

  if (!cookies.sessionid) {
    console.error('\n❌ No sessionid cookie received. Login may have failed or been blocked.');
    console.log('\nNote: You could still try using sessionid from your browser.');
    console.log('Open TradingView in Chrome → F12 → Application → Cookies → copy sessionid value');
    process.exit(1);
  }

  // Step 2: Extract JWT from page
  let jwt = await extractJwt(cookies);

  // Step 3: Try alternate endpoints
  if (!jwt) {
    jwt = await tryChartAuth(cookies);
  }

  // Summary
  console.log('\n=== Summary ===');
  if (jwt) {
    console.log('✅ Successfully obtained JWT token!');
    console.log(`Token length: ${jwt.length} chars`);
    console.log(`\nTo use this token, set:`);
    console.log(`TRADINGVIEW_JWT_TOKEN=${jwt}`);
  } else {
    console.log('❌ Could not extract JWT token via HTTP login.');
    console.log('\nPossible reasons:');
    console.log('  1. CAPTCHA was triggered');
    console.log('  2. JWT is not embedded in page HTML (loaded dynamically via JS)');
    console.log('  3. TradingView changed their auth flow');
    console.log('\nNext steps:');
    console.log('  - Try Puppeteer/Playwright approach (runs real browser)');
    console.log('  - Or continue with manual token extraction');
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
