# Cutover Runbook

This is the step-by-step runbook for migrating from the old single-account
wiring to the new multi-account architecture. Read `ARCHITECTURE.md` first.

Stop all services and take a clean downtime window before starting.

## 0. Pre-flight on your dev machine

```bash
# Verify all services parse cleanly
cd /home/drew/projects/slingshot-services
for f in \
  shared/index.js shared/utils/order-router.js shared/utils/account-store.js \
  shared/utils/routes-store.js shared/connectors/tradovate-connector.js \
  trade-orchestrator/index.js tradovate-service/index.js \
  monitoring-service/index.js signal-generator/src/main.js \
  signal-generator/src/strategy/engine.js \
  signal-generator/src/strategy/multi-strategy-engine.js \
  signal-generator/src/ai/ai-strategy-engine.js \
  scripts/migrate-to-accounts.js; do
  node --check "$f" || echo "FAIL: $f"
done
```

## 1. Generate a master key

The account store encrypts credentials. You need ONE base64 32-byte key
shared by every service.

```bash
node scripts/dev-harness/generate-master-key.js
# Copy the output, add to shared/.env and to Sevalla env:
# SLINGSHOT_MASTER_KEY=<base64-32-bytes>
```

**Back it up somewhere permanent.** If you lose this key every encrypted
credential in Redis becomes unrecoverable.

## 2. Back up Redis before migration

```bash
# Local dev
redis-cli --rdb /tmp/slingshot-pre-migration.rdb

# Sevalla: use their managed backup flow; note the snapshot id before proceeding.
```

## 3. Run migration script (dry-run first)

```bash
# With production env loaded so env vars populate account records
SLINGSHOT_MASTER_KEY=<key> node scripts/migrate-to-accounts.js --dry-run

# Review the output — should list:
#   - tradovate-demo  (from TRADOVATE_DEMO_ACCOUNT_ID)
#   - tradovate-live  (from TRADOVATE_LIVE_ACCOUNT_ID)  if set
#   - pickmytrade-prop (from PICKMYTRADE_*)             if PICKMYTRADE_ENABLED=true
#   - routes config translated from shared/routing-config.json

# When satisfied:
SLINGSHOT_MASTER_KEY=<key> node scripts/migrate-to-accounts.js
```

The script also translates persisted order-strategy mappings from the old
`tradovate:demo:...` / `tradovate:live:...` keys to
`tradovate:<accountId>:...` so in-flight orders retain strategy attribution.

If you need to re-run, use `--force` to overwrite.

## 4. Deploy new service code

```bash
./deploy.sh              # or deploy.sh --all if you're doing a full cut
```

Ensure Sevalla env has `SLINGSHOT_MASTER_KEY` set BEFORE services start, or
they'll fail to decrypt credentials.

## 5. Bring services up one at a time (in this order)

Between each service, watch its logs and verify `/health` before moving to
the next.

### 5.1 monitoring-service (3014)

```bash
curl -s localhost:3014/health | jq
curl -s localhost:3014/api/accounts -H "Authorization: Bearer $DASHBOARD_SECRET" | jq
curl -s localhost:3014/api/routes   -H "Authorization: Bearer $DASHBOARD_SECRET" | jq
curl -s localhost:3014/api/connectors/schemas -H "Authorization: Bearer $DASHBOARD_SECRET" | jq
```

Expected: accounts list matches migration output; routes config matches;
schemas returns tradovate + pickmytrade entries.

### 5.2 data-service (3019)

Unchanged by this migration. Verify streams are flowing.

### 5.3 tradovate-service (3011)

```bash
curl -s localhost:3011/health | jq '.details.connectors'
curl -s localhost:3011/accounts | jq
curl -s localhost:3011/accounts/tradovate-demo/positions | jq
```

Expected: one connector per enabled Tradovate account, each reporting
`ok: true` and connected. Positions endpoint returns current open positions.

Watch the log for these lines:
- `[TV:<id>] connected (demo|live) broker=<numericId>`
- `[TV:<id>] loaded N order-strategy mappings from Redis`
- `[TV:<id>] reconcile (startup): published snapshot with N positions`

### 5.4 trade-orchestrator (3013)

```bash
curl -s localhost:3013/health | jq
curl -s localhost:3013/api/positions | jq
curl -s localhost:3013/trading/status | jq
```

Expected: `tradingEnabled` reflects the old `trading:kill_switch` value;
`openPositions` is populated from the `position.snapshot` events that
tradovate-service just emitted during step 5.3.

### 5.5 signal-generator (3015)

```bash
curl -s localhost:3015/health | jq
```

Expected: engine is evaluating candles. No `inPosition` fields anywhere in
the response. First signal emitted should carry a `signalId` like
`IV_SKEW_GEX-long-25000-1745084400000`.

### 5.6 Verify end-to-end with a synthetic signal

Publish a test `trade.signal` manually (remember the envelope):

```bash
redis-cli PUBLISH trade.signal '{"timestamp":"2026-04-15T20:00:00Z","channel":"trade.signal","data":{"signalId":"TEST-long-25000-1745084400000","strategy":"IV_SKEW_GEX","symbol":"NQM6","side":"buy","action":"place_limit","price":25000,"stop_loss":24900,"take_profit":25100,"quantity":1}}'
```

Watch `pm2 logs`:

1. Orchestrator log: `[TEST-long-...] routing IV_SKEW_GEX long MNQM6 → [tradovate-demo, pickmytrade-prop]`
2. tradovate-service log: `[Router] order.request TEST-long-... [IV_SKEW_GEX] → tradovate-demo`
3. TradovateConnector log: `[TV:tradovate-demo] ORDER_PLACED ...`
4. Monitoring: position.opened received, dashboard updated

Re-publishing the exact same signal within 60s should log:
`[DEDUP] TEST-long-... — duplicate within 60s, skipping`

### 5.7 Hot-reload verification

```bash
# Disable an account via API
curl -X PUT localhost:3014/api/accounts/tradovate-demo \
  -H "Authorization: Bearer $DASHBOARD_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# tradovate-service log should show:
#   [tradovate-demo] disabled — tearing down connector
#   [Router] unregistered connector: tradovate-demo

# Orchestrator log for a new signal should skip this account:
#   [<sid>] per-account rejects: tradovate-demo(account_disabled_or_missing)

# Re-enable:
curl -X PUT localhost:3014/api/accounts/tradovate-demo \
  -H "Authorization: Bearer $DASHBOARD_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# Connector should be brought back up automatically.
```

### 5.8 Export backup snapshot

```bash
curl -s localhost:3014/api/routes/export \
  -H "Authorization: Bearer $DASHBOARD_SECRET" \
  > /tmp/slingshot-config-$(date +%Y%m%d).json
```

This captures the account records (credentials redacted) and routes table as
a JSON document. Keep it with your Redis backup.

## 6. Post-cutover cleanup

Once the system has run for at least one successful trading session:

1. Delete `shared/routing-config.json` (Redis is source of truth now)
2. Remove the legacy `TRADOVATE_*`, `PICKMYTRADE_*`, `WEBHOOK_SECRET` env
   vars from Sevalla config (they're already gone from `.env.example`)

## Rollback

If something breaks during the window:

1. Redeploy previous git SHA.
2. Restore Redis from the backup you took in step 2.
3. Old env vars are still on Sevalla during step 6 is skipped, so the old
   code path works unchanged.

## Known gaps carried forward (not blockers)

- **Time-based trailing stops** (TB rules) for iv-skew-gex live in the old
  orchestrator and are NOT yet re-implemented on the broker side. The
  strategy will still enter with breakeven rules in place, but bar-based
  time trailing won't trigger. Flag as a first follow-up before running
  live size.
- **`signal.outcome` wiring** — strategies don't yet learn when their
  signals fill or stop out. Cooldown is purely time-based for now, which
  is sufficient for iv-skew-gex.
- **PMT shadow tracking** — PickMyTradeConnector currently fires
  webhook-only. The "track via demo Tradovate" shadow behavior is the next
  design item — PMT orders will not appear in position views until that's
  wired up.
- **Discord alerting** — orchestrator has the context to emit rich alerts
  but no alerting module is yet wired. Existing position Discord hooks in
  monitoring-service still work off `position.opened` / `position.closed`
  events, so you'll still see fills.
