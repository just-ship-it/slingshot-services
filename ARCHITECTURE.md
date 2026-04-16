# Slingshot Architecture

This doc is the source of truth for role separation and event flow between
services. If code contradicts this doc, the doc wins until we update it
together.

## Role separation (strict)

### signal-generator — pure intent
- Consumes market data, evaluates strategies, emits `trade.signal`
- Knows nothing about accounts, routing, positions, or order state
- Generates a deterministic `signalId` per signal:
  `{strategy}-{direction}-{entryPrice}-{unixMs}`
- Time-based cooldown only. Cooldown starts the moment the signal is emitted,
  not when it fills or closes. 30-min default for `iv-skew-gex`.
- No `position.*` or `order.*` subscriptions. No reconciliation loop. No
  `inPosition` state.

### trade-orchestrator — routing + gating
- The only service that reasons about which accounts a signal goes to, and
  whether it should go at all.
- Consumes `trade.signal` (one message, no account).
- Resolves routes via `routes-store` to get a list of `accountId`s for the
  strategy.
- Per-account gate chain — all must pass to emit an order:
  1. `accountEnabled(accountId)` — from account-store
  2. `globalKillSwitchOff()` — from Redis flag owned by monitoring-service
  3. `noOpenPosition(accountId, strategy, symbol)` — from internal map
  4. `noPendingOrder(accountId, strategy, symbol)` — from internal map
  5. `passesSessionFilter(strategy, now)` — from strategy config
- Emits one `order.request` per passing account, stamped with `accountId` and
  carrying the `signalId` forward.
- Tracks state by listening to broker events:
  - `openPositions: Map<(accountId, strategy, symbol), {entryPrice, timestamp, signalId}>`
  - `pendingOrders: Map<(accountId, strategy, symbol), {signalId, timestamp}>`
    — set on `order.request` emission, cleared on `order.placed` (transitions to
    openPositions via `position.opened`) or `order.rejected` / `order.cancelled`.
- Pending counts as "in position" for gate purposes (first signal wins when
  two fire in quick succession).
- On broker startup, ingests `position.snapshot` events to rebuild open
  positions. Orchestrator maps positions → strategies using its internal
  strategy→account routing map.
- Owns Discord/Slack/email alerting. It has full context for "signal X routed
  to accounts [A, B], A accepted, B was blocked because kill-switch, A filled
  at Y."

### broker services (tradovate-service, future others) — execution + tracking
- Thin bootstrapper: load enabled accounts of its broker type from
  account-store, instantiate one connector per account, register with router.
- Each connector owns ONE account's reality:
  - Broker client (e.g. `TradovateClient` + WebSocket)
  - Order-strategy map, pending structural stops, bracket correlation, all
    state that describes "what this account is doing"
  - Reconciliation loop against the broker
  - Fill/cancel/bracket event handlers
  - Per-account Redis persistence key (e.g.
    `tradovate:${accountId}:order:strategy:mappings`)
- `handleOrderRequest(message)` is the only entry point the router calls.
- Every outbound event is stamped with `accountId`. No exceptions, no
  conditional paths.
- Emits `position.snapshot` after initial reconciliation on startup so the
  orchestrator can rebuild its open-position view.
- Knows nothing about strategies (except passing `strategy` through for
  attribution), routing, other accounts, or global kill switches.

### monitoring-service — passive observer + control plane
- Aggregates `position.*` / `order.*` events for the dashboard.
- Owns the global kill-switch flag in Redis.
- Owns accounts/routes CRUD API (`/api/accounts`, `/api/routes`,
  `/api/connectors/schemas`).
- No trading logic. No webhook ingestion (deleted).

## Event flow

```
  market data
      │
      ▼
  signal-generator ──► trade.signal  { signalId, strategy, symbol, direction,
      │                                 entryPrice, stopLoss, takeProfit, ... }
      │                         (no accountId)
      ▼
  trade-orchestrator
      │   resolve routes → [acct1, acct2, ...]
      │   apply gates per account
      │
      ├──► order.request  { signalId, accountId: acct1, strategy, ... }
      ├──► order.request  { signalId, accountId: acct2, strategy, ... }
      │
      ▼
  broker service (tradovate-service)
      │   router.dispatch(accountId → connector)
      │
      ▼
  TradovateConnector (per account)
      │   client.placeOrder(...)
      │   subscribe to broker fill/cancel events
      │
      ├──► order.placed       { signalId, accountId, orderId, ... }
      ├──► order.filled       { signalId, accountId, orderId, fillPrice, ... }
      ├──► position.opened    { signalId, accountId, strategy, symbol, netPos, ... }
      ├──► position.update    { accountId, strategy, symbol, netPos, ... }
      ├──► position.closed    { signalId, accountId, strategy, symbol, pnl, ... }
      └──► position.snapshot  { accountId, positions: [...] }     (on startup)
            │
            ▼
      ┌─────┴─────┬──────────────────┐
  orchestrator  monitoring-service   (no other consumers — signal-generator
   (updates      (dashboard          does not subscribe to position/order
   position      aggregation,         events anymore)
   view)         per-account rows)
```

## Event payload shapes (canonical)

### `trade.signal`
```
{
  signalId: "iv-skew-gex-long-25000-1713200000000",
  strategy: "IV_SKEW_GEX",
  symbol: "NQM6",
  direction: "long" | "short",
  orderType: "limit" | "market",
  entryPrice: 25000,
  stopLoss: 24900,
  takeProfit: 25100,
  trailingTrigger: 22,          // points, optional
  trailingOffset: 6,            // points, optional
  quantity: 1,                  // strategy hint; orchestrator may override per account
  timestamp: "ISO8601"
}
```

### `order.request` (orchestrator → broker)
```
{
  signalId: "...",
  accountId: "tradovate-live-1",
  strategy: "IV_SKEW_GEX",
  symbol: "NQM6",
  action: "buy" | "sell",
  orderType: "Limit" | "Market",
  price: 25000,
  stopLoss: 24900,
  takeProfit: 25100,
  trailingTrigger: 22,
  trailingOffset: 6,
  quantity: 1,                  // final quantity, orchestrator-decided
  timestamp: "ISO8601"
}
```

### `order.placed` / `order.filled` / `order.rejected` / `order.cancelled`
```
{
  signalId: "...",
  accountId: "...",
  orderId: "broker-order-id",
  strategy: "...",
  symbol: "...",
  action: "buy" | "sell",
  orderType: "Limit" | "Market",
  price, quantity,              // as appropriate
  fillPrice, fillQuantity,      // for order.filled
  reason,                       // for order.rejected / order.cancelled
  timestamp: "ISO8601"
}
```

### `position.opened` / `position.closed` / `position.update`
```
{
  signalId: "...",              // opened/closed only; update may omit
  accountId: "...",
  strategy: "...",              // for attribution; orchestrator is source of truth on open
  symbol: "...",
  side: "long" | "short" | "flat",
  netPos: 1,                    // signed
  entryPrice: 25000,
  exitPrice: 24950,             // closed only
  realizedPnl: -50,             // closed only
  timestamp: "ISO8601"
}
```

### `position.snapshot` (broker → orchestrator, on startup)
```
{
  accountId: "...",
  positions: [
    { symbol, netPos, entryPrice, contractId, ... }
  ],
  timestamp: "ISO8601"
}
```

### `signal.outcome` (deferred — not in this migration)
```
{
  signalId: "...",
  accountId: "...",
  outcome: "filled" | "stopped" | "target" | "rejected" | "cancelled",
  pnl: number,
  timestamp: "ISO8601"
}
```

## Redis keys

| Key | Owner | Purpose |
|-----|-------|---------|
| `accounts:index` | account-store | Set of account ids |
| `accounts:${id}` | account-store | Account record (encrypted credentials) |
| `routes:config` | routes-store | Strategy → [accountId] routing table |
| `trading:kill-switch` | monitoring-service | Global enable/disable flag |
| `tradovate:${accountId}:order:strategy:mappings` | TradovateConnector | Per-account order→strategy map |
| `orchestrator:open-positions` | trade-orchestrator | Snapshot of gate-tracking state (periodic checkpoint) |

## Startup order and sync

1. monitoring-service, data-service — no dependency on broker state
2. tradovate-service starts, each connector reconciles against Tradovate,
   emits `position.snapshot` per account
3. trade-orchestrator starts, subscribes to `position.*` events, waits for
   snapshots to arrive before accepting signals (or accepts signals with a
   "not ready" reject for first N seconds)
4. signal-generator starts and begins emitting signals freely

## Special case: PickMyTrade + Tradovate demo shadow

PMT is fire-and-forget — no fill events come back. To track positions for
PMT accounts, each PMT connector is paired with a Tradovate demo connector
configured to mirror the same order. The demo account's fill stream is the
canonical source of position state for the PMT account. This is
handled inside the PMT connector (not at the router level) and is invisible
to the orchestrator — the PMT connector emits `position.*` events that
appear to come from the PMT account, sourced from the demo fills.

Design detail to be specified when we implement the PMT connector refactor.

## Boundaries (explicit non-goals)

- Signal generator NEVER knows about accounts
- Orchestrator NEVER knows about broker-specific order details (bracket child
  ids, Tradovate account numbers, etc.)
- Broker services NEVER know about strategies' business logic or routing
- monitoring-service NEVER makes trading decisions
- No service listens to `trade.signal` except trade-orchestrator
- No service listens to `order.request` except broker services
- signal-generator listens to nothing (except market data inputs)
