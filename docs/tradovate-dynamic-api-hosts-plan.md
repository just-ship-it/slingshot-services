# Tradovate / NinjaTrader Dynamic API Hosts — Implementation Plan

**Status:** **tickpilot DONE 2026-09-23** (see "tickpilot" below). **slingshot-services DONE + fully demo-verified 2026-09-24**
(see "slingshot-services" below). Not deployed: slingshot trading code is not running in prod (Drew, 2026-09-24), so
there is nothing to deploy yet. When it is deployed: confirm `/health` shows `hostSource: 'apiHosts'` and watch one renew.
**Hard deadline: Saturday 2026-10-03** (streaming must already be updated).
**Target deploy:** week of 2026-09-21, outside market hours.

## tickpilot (done 2026-09-23 — was out of the original scope)

Drew asked for the tick-engine CLI trader first. `/home/drew/projects/tickpilot`:
`src/broker/api-hosts.js` (resolver) · `src/broker/tradovate.js` (resolve on every auth + renew, 307 and 421 handling,
bootstrap fallback) · callers now use `tv.restUrl` · `npm run test:hosts` · `npm run verify:hosts` (`--stream` needs
the book stopped). Confirmed against live demo. The running `tickpilot-book` picks it up on its next restart.

Findings worth carrying into the slingshot work: apiHosts returns three keys the docs omit (`riskMonitorLive`,
`riskMonitorDemo`, `userContext`) so ignore-unknown is mandatory; fall back to the LAST RESOLVED host (not config)
when a renewal omits apiHosts; set `maxRedirects: 0` / `redirect: 'manual'` or a 307 silently becomes a 401.

## slingshot-services (done 2026-09-24)

Steps 1-6 done; 7 (rollout) deferred — no slingshot trading code is running in prod.

- `shared/connectors/tradovate-hosts.js` — `resolveHosts(apiHosts, purpose, current)`, same as tickpilot's.
- `tradovate-service/TradovateClient.js` — configured URLs are now `this.bootstrap`; `authenticate()` (single-flight)
  → `_applyAuthResponse()` stores the token AND re-resolves `baseUrl`/`wssUrl` on every auth, CAPTCHA retry and renew.
  Missing apiHosts → stay on the LAST RESOLVED host. Resolved host unreachable → one retry on bootstrap.
  REST: `maxRedirects: 0` everywhere; 3xx → one re-auth + one retry (`redirected` flag); bodyless 404 names the URL.
  WS: `unexpected-response` 421 → one re-auth + one redial (`_wrongHostRedialed`, reset only on a successful open).
  Renew that moves the host → `_redialOnNewHost` (only if a socket exists). Close/error from a retired socket is ignored,
  so a redial never starts a second reconnect chain; `connectWebSocket` also refuses to dial while one is handshaking.
- Fixed on the way (behaviour changes to know about at deploy):
  - `refreshToken()` now **re-arms the renewal timer**. Before, it renewed once per connect and then relied on the
    token expiring → 401 → failed renew → full `connect()`.
  - `refreshToken()` no longer falls back to `connect()` when called from inside `connect()` (loadAccounts → 401), which
    was a path that could re-enter itself; the scheduled refresh now `.catch`es instead of risking an unhandled rejection.
  - The CAPTCHA-in-error-response branch used to skip `connectWebSocket()`; it now goes through the same path.
  - A renew reply without `accessToken` is treated as a failure (it used to store `undefined` as the token).
- `TradovateConnector.healthCheck()` → `restUrl`, `wssUrl`, `hostSource`.
- `scripts/migrate-to-accounts.js` WSS defaults → trading host (was md host).
- Tests: `cd tradovate-service && npm test` (17 cases, incl. a real local server that 421s the first upgrade).
- Demo check: `node scripts/verify-tradovate-api-hosts.js [--stream]` — ALL checks PASSED 2026-09-24, incl. `--stream`
  (socket authorized on the returned demo host; run with tickpilot-book stopped — shared/.env's user is the same one
  the book trades on). apiHosts had the same 10 keys; hosts equal today's hard-coded ones, so the migration is a no-op
  until the org moves. The book's restart for this also picked up tickpilot's own api-hosts code (logged `(apiHosts)`).
- Not changed: `shared/utils/config.js` defaults (`wssDemoUrl` lacks `/websocket`; only used when env is unset and only
  by scripts — bootstrap-only now anyway). Note `TRADOVATE_USE_DEMO` is commented out in shared/.env, so
  `scripts/sync-pnl.js` bootstraps on LIVE.

## Background

NinjaTrader notice for registered apps **Slingshot Dev (8791)** and **Slingshot (8689)**: evaluation / dedicated-infra
organizations will reach the API on different hostnames. Authentication responses return an `apiHosts` object; clients
must build every REST and WebSocket URL from it.

Doc: https://docs.ninjatrader.com/api/dynamic-api-hosts

Key facts from the doc:
- `apiHosts` is returned by `accessTokenRequest`, social-login token, `renewAccessToken`, `modifyCredentials`,
  `modifyPassword`, `setSocialCredentials`.
- Keys (always): `live`, `demo`, `mdLive`, `mdDemo`, `replay`, `reportingLive`, `reportingDemo`. Admin-only: `adminLive`,
  `adminDemo`, `mdAdminLive`, `mdAdminDemo`. Ignore unknown keys.
- Values are **bare hostnames** — client adds `https://<host>/v1` (REST) and `wss://<host>/v1/websocket` (WS).
- Route by purpose: demo trading → `demo`, live trading → `live`, market data → `mdDemo`/`mdLive`, replay → `replay`.
- `apiHosts` is **omitted** on error responses and MFA challenges → keep existing host resolution as fallback.
- Re-read on every authentication/renewal — an org can move between sessions.
- Treat `live`/`mdLive`/`replay` as authoritative too, even though they're currently the same for everyone.
- Wrong host consequences: **WebSocket rejected with 421** (no fallback); **REST gets 307** with `Location`, and many
  HTTP clients drop `Authorization` on cross-host redirects.
- Configuration endpoints are not part of `apiHosts` and keep using the existing base host.

## Scope decisions

- **In scope:** slingshot services only — `tradovate-service/TradovateClient.js`, `shared/connectors/tradovate-connector.js`,
  and scripts that construct `TradovateClient`.
- **Out of scope:** `james-bot`, `mnq-scalper`, `market-data-service/` (unused), reconnect-limit alerting.
- **Validation:** minimal — trust what NinjaTrader returns (non-empty string → use it).
- We don't use Tradovate market data (data-service uses TradingView), so only the `demo` / `live` hosts matter in practice.

## Current state (audited 2026-09-16)

Hard-coded host resolution:

| Location | Detail |
|---|---|
| `tradovate-service/TradovateClient.js:54-55` | Constructor fixes `baseUrl` / `wssUrl` from `useDemo`; all REST, renew, and WS use them forever |
| `shared/connectors/tradovate-connector.js:65-71` | Default demo/live REST + WSS URLs (these are what **prod** uses) |
| `shared/utils/config.js:46-49`, `shared/.env` | `TRADOVATE_*_URL` env vars |
| `scripts/migrate-to-accounts.js:79-80` | Latent bug: defaults trading WS to `md-demo`/`md` host (md 404s on `user/syncrequest`) |
| `scripts/sync-pnl.js` | Builds `TradovateClient` from env config (gets fix for free) |
| `scripts/verify-tagging.js`, `scripts/test-tradovate-tagging*.js` | Own base URL from env (test tooling; optional) |

Production Redis accounts (read-only check 2026-09-16):
- `tradovate-3c98375b` — **live**, account 761526, appId "Slingshot Dev"
- `tradovate-6eb0902c` — **demo**, account 33316485, appId "Slingshot Dev"
- **No URL overrides stored** → connector defaults are in effect. No data migration needed.
- Local dev record `accounts:tradovate-demo` does store URL fields (harmless; they become fallback only).

Auth code notes:
- Token-success handling is duplicated in 3 branches of `connect()` (normal, CAPTCHA retry, CAPTCHA-in-error-response).
- `refreshToken()` posts to `${baseUrl}/auth/renewaccesstoken` and only updates token/expiry.
- `makeRequest()` uses axios defaults (follows redirects) and refreshes on 401.

Deploy mapping: `deploy.config.json` maps `shared/connectors` → **tradovate-service only**, so this redeploys one service.

## Plan

### 1. Host resolver
Small helper next to the connector (e.g. `shared/connectors/tradovate-hosts.js`):
- Input: `apiHosts` (may be undefined), mode (`demo` | `live`), fallback URLs from config.
- Output: `{ restUrl: 'https://<host>/v1', wssUrl: 'wss://<host>/v1/websocket', source: 'apiHosts' | 'fallback' }`.
- Minimal validation: non-empty string → use; otherwise fallback. Ignore unknown keys.

### 2. `TradovateClient` changes
- Consolidate the 3 token-success branches into `_applyAuthResponse(data)`: store `accessToken`, `mdAccessToken`,
  `userId`, `tokenExpiry`, **`apiHosts`**, then recompute `baseUrl` / `wssUrl` via the resolver.
- Initial `accesstokenrequest` always goes to the configured (fallback) host.
- No `apiHosts` in response (error / CAPTCHA / MFA) → keep fallback, log one warning.
- `refreshToken()`: re-read `apiHosts`; if the trading host changed, close and reconnect the WebSocket on the new host.
- Every full `connect()` re-resolves hosts.

### 3. Wrong-host handling
- **WebSocket 421** (`ws` emits unexpected-response / "Unexpected server response: 421"): trigger full re-auth
  (re-reads hosts) instead of retrying the same URL.
- **REST:** set `maxRedirects: 0` on Tradovate axios calls. On 307: log, re-auth, re-resolve hosts, retry once.
  (Prevents the follow-redirect → stripped Authorization → 401 → renew against wrong host loop.)

### 4. Observability
- `TradovateConnector.healthCheck()` includes resolved `restUrl`, `wssUrl`, and `hostSource` (`apiHosts` | `fallback`).

### 5. Cleanup
- Fix `scripts/migrate-to-accounts.js` WSS defaults to the trading host (`demo.tradovateapi.com` / `live.tradovateapi.com`).
- Treat stored/env URL fields as fallback/bootstrap only (comment + naming in connector config).

### 6. Verification
- **First step before coding:** one read-only demo `accesstokenrequest` outside market hours; print `apiHosts` to confirm
  presence and shape. (Opens an extra session — don't run during market hours.)
- Unit tests:
  - resolver: `apiHosts` present / missing / partial
  - client auth with and without `apiHosts` (incl. CAPTCHA path)
  - renew that changes the host → WS reconnects to new host
  - REST 307 → re-auth + single retry
  - WS 421 → full re-auth

### 7. Rollout
- Deploy tradovate-service outside market hours, week of 2026-09-21.
- Confirm in prod both connectors report `hostSource: 'apiHosts'` (via `/health`, or Sevalla logs).
- Watch one full token-renew cycle.
- Note: Sevalla MCP was authed to the wrong company (flagsnap) on 2026-09-16 — re-run `/mcp` and select the slingshot
  company before relying on it for logs.
