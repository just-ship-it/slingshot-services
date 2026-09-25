/**
 * Dynamic API host resolution for Tradovate / NinjaTrader (mandatory from 2026-10-03).
 *
 * Evaluation and dedicated-infrastructure organisations reach the API on their OWN hostnames. Every
 * authentication response (`accesstokenrequest`, `renewaccesstoken`, social login, modifyCredentials,
 * modifyPassword, setSocialCredentials) carries an `apiHosts` object, and clients must build every REST and
 * WebSocket URL from it rather than from a stored hostname.
 * Spec: https://docs.ninjatrader.com/api/dynamic-api-hosts
 *
 * Getting it wrong is not a soft failure:
 *   - WebSocket to the wrong host is rejected with 421 and there is NO fallback.
 *   - REST to the wrong host answers 307, and axios/fetch strip the Authorization header on a cross-origin
 *     redirect — which shows up as a 401, not as a routing problem. Some wrong hosts answer a BODYLESS 404
 *     instead (md-demo / rpt-demo, probed 2026-09-24).
 *
 * Observed shape (demo, 2026-09-24) — note three keys the published docs do not list, hence "ignore unknown":
 *   live live.tradovateapi.com · demo demo.tradovateapi.com · mdLive md.tradovateapi.com
 *   mdDemo md-demo.tradovateapi.com · replay replay.tradovateapi.com · reportingLive/Demo rpt-*.tradovateapi.com
 *   riskMonitorLive/Demo *.ninjatrader.com · userContext user-context-api.ninjatrader.com
 *
 * Validation is deliberately minimal: a non-empty string is used as given. NinjaTrader is the authority on its
 * own hostnames, and a client that second-guesses them fails closed on the day they change something.
 *
 * Same resolver as tickpilot's src/broker/api-hosts.js.
 */

/** purpose -> apiHosts key. Trading ('demo' | 'live') is all slingshot uses; the rest are stated once here. */
export const HOST_KEYS = {
  demo: 'demo', live: 'live',
  mdDemo: 'mdDemo', mdLive: 'mdLive',
  replay: 'replay',
  reportingDemo: 'reportingDemo', reportingLive: 'reportingLive',
};

/** Values are BARE hostnames. Tolerate a scheme or a trailing slash anyway — cheap, and harmless if never needed. */
const bare = (h) => String(h).trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');

/**
 * @param apiHosts  the object from the auth response; may be undefined (errors, CAPTCHA and MFA omit it)
 * @param purpose   a key of HOST_KEYS — 'demo' or 'live' for trading
 * @param current   {restUrl, wssUrl} to keep when apiHosts is absent or lacks the key. This is the LAST RESOLVED
 *                  pair, not the configured one: a renewal that omits apiHosts must not drag us back to a
 *                  bootstrap host the org has already moved off.
 * @returns {{restUrl, wssUrl, host: string|null, source: 'apiHosts'|'fallback'}}
 */
export function resolveHosts(apiHosts, purpose = 'demo', current = {}) {
  const key = HOST_KEYS[purpose] ?? purpose;
  const raw = apiHosts?.[key];
  const host = typeof raw === 'string' ? bare(raw) : '';
  if (!host) return { restUrl: current.restUrl, wssUrl: current.wssUrl, host: null, source: 'fallback' };
  return { restUrl: `https://${host}/v1`, wssUrl: `wss://${host}/v1/websocket`, host, source: 'apiHosts' };
}
