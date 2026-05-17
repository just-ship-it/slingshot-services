# BE Handler — Live Implementation (Stage 1)

Built the orchestrator-side post-fill rule enforcement that was missing per
`live-deployment-gap.md`. Strategy emits the rule on its signal; orchestrator
captures it, tracks MFE per open position, fires `modify_stop` when the
trigger is hit. Forward-looking shape supports the ratchet variants we
swept overnight (Stage 2).

## Files changed

- `trade-orchestrator/src/exit-rule-manager.js` — new module. Generic Rule
  consumer, per-position state, MFE tracking, idempotent firing.
  Stage-1 supports `type: 'breakeven'`; ratchet branch is reserved.
- `trade-orchestrator/index.js`
  - Import `createExitRuleManager` and `captureRuleFromSignal`.
  - Instantiate the manager near the top of the file (single instance).
  - `handleTradeSignal`: capture rule via `captureRuleFromSignal(signal)`
    and stash on the `pendingOrders` entry.
  - `handlePositionOpened`: pull rule off pending, attach to `openPositions`,
    register with the manager (entry price comes from the fill event).
  - `handlePositionClosed` / `handlePositionUpdate` (flat): unregister.
  - `restoreOpenPositions`: re-register positions whose checkpoint carries
    a rule (so an orchestrator restart doesn't lose BE state).
  - Subscribe to `CHANNELS.PRICE_UPDATE`, forward each tick to
    `exitRuleManager.onPriceTick(msg)`.
  - `publishModifyStop` impl: HTTP POST to the tradovate-service endpoint
    (same pattern as `checkStaleLimits` uses for cancel).
- `tradovate-service/index.js`
  - New endpoint `POST /accounts/:accountId/modify-stop/:signalId`.
  - Body `{ newStopPrice: number, reason?: string }`. Calls
    `connector.modifyStopBySignalId(signalId, newStopPrice, hint)`.
- `shared/connectors/tradovate-connector.js`
  - New method `modifyStopBySignalId(signalId, newStopPrice, hint)`.
    Reverse-looks-up `orderSignalMap` for the strategyId, then calls
    `modifyStop(strategyId, newStopPrice)` which hits
    `client.modifyBracketStop`.
- `shared/connectors/pickmytrade-connector.js`
  - New `modifyStopBySignalId` method that delegates to `modifyStop` using
    the symbol hint (PMT doesn't track per-signal order IDs).
- `trade-orchestrator/test/exit-rule-manager.test.js` — new smoke test
  covering the lifecycle scenarios. Passes.

## What it does

1. Strategy emits `breakeven_stop=true, breakeven_trigger=70, breakeven_offset=5`
   on the trade signal (gex-flip-ivpct already does this — no strategy change).
2. Orchestrator captures the rule and stores it on the pending order entry.
3. Tradovate-service places the bracket. The connector publishes
   `order.placed` carrying the strategyId (broker bracket-order ID), which
   is mapped to the signalId by the connector's internal `orderSignalMap`.
4. On fill, broker emits `position.opened` with `entryPrice`. The
   orchestrator transfers the rule onto the open position entry and
   registers it with the exit-rule manager.
5. On every `price.update` for the position's underlying (matched via
   `extractUnderlying(symbol)` ↔ `baseSymbol`), the manager updates the
   running high/low water mark and computes MFE.
6. When `MFE >= rule.trigger` (70 pts for the live gex-flip-ivpct config),
   the manager:
   - Marks `beTriggered = true` (idempotent — won't fire again).
   - Computes `newStop` as `entry ± rule.offset` (+5 for shorts means
     stop = entry − 5, locks +5 of profit; same for longs).
   - Calls `publishModifyStop({...})` which POSTs to
     tradovate-service's modify-stop endpoint.
   - Tradovate-service calls `connector.modifyStopBySignalId(signalId, newStopPrice)`,
     which calls `client.modifyBracketStop(strategyId, newStopPrice)`.
7. The broker moves the stop. The position rides on the new stop until it
   either hits the moved stop, the target, EOD flatten, or max-hold.
8. On position close, the manager unregisters and drops state.

## Behavior matches the backtest engine's BE

The backtest engine in `trade-simulator.js:1057-1093` defines BE as:
- long: stop = `entryPrice + protectionOffset`
- short: stop = `entryPrice - protectionOffset`

The new live handler computes the same value. So now a backtest run with
`--gfi-breakeven-stop --gfi-breakeven-trigger 70 --gfi-breakeven-offset 5`
should produce equivalent live behavior on Tradovate.

## Forward-looking for ratchet

`captureRuleFromSignal` already recognizes `mfeRatchet: true` and stashes
the tier config on the rule. The manager's `evaluate()` function has a
guarded branch for `RULE_TYPES.MFE_RATCHET` that is intentionally left
unimplemented for Stage 2. To wire ratchet support, only the evaluator
needs to grow tier-iteration logic — the lifecycle (register/track/fire/
unregister) is identical.

When Drew picks a ratchet config from the overnight sweep, the wiring is:
1. Strategy already emits `mfeRatchetConfig.tiers` on signals when
   `--gfi-magnet-ratchet` or `--mfe-ratchet` flags are on (live config
   would map to env vars: `GFI_MFE_RATCHET=true`, `GFI_MFE_RATCHET_TIERS=...`).
2. `captureRuleFromSignal` already builds the rule shape.
3. Add ratchet evaluator (~30 lines) — same math as the engine's
   `updateMFERatchetStop` at `trade-simulator.js:1138`, but publishing
   `modify_stop` instead of mutating local state.

## Operational notes

- **Idempotency**: BE fires exactly once per position. If a `modify_stop`
  HTTP call fails (network blip, broker reject), the rule does NOT retry.
  This is intentional for Stage 1 — adding retries can come later if we
  see real failures in production. Tradovate's stop bracket is already
  there as the original SL; failure to BE-modify just means the trade
  stays on its initial SL.
- **No-op pass-through**: positions with no exit rule (strategies that
  don't emit BE/ratchet fields) skip the manager entirely. Zero overhead.
- **Restart safety**: checkpointed open positions carry their rule. On
  orchestrator restart, `restoreOpenPositions` re-registers them with the
  manager. The high/low water marks reset to entry price — so a stop
  that should have triggered DURING the restart may not fire until MFE
  re-crosses the threshold. Worst case: trade rides original SL.
- **Subscription cost**: orchestrator now subscribes to `price.update`.
  This is a high-volume channel. `onPriceTick` short-circuits when no
  positions match the underlying, so the cost when no rules are active
  is negligible (one map lookup per tick).
- **Symbol matching**: `price.update` is keyed by `baseSymbol` (e.g. NQ).
  Open positions hold the broker symbol (e.g. MNQM6). The manager uses
  `extractUnderlying` (already defined in `trade-orchestrator/index.js`)
  to convert.

## Test plan before deploy

1. ✓ Unit test the manager (done — all scenarios pass).
2. **Local smoke**: start the full stack locally with kill switch ON
   (no real trades). Inject a synthetic position.opened + price.update
   stream via redis-cli. Verify orchestrator logs the BE fire and the
   modify-stop HTTP call goes out.
3. **Demo account**: enable on Tradovate demo, run gex-flip-ivpct, take
   a trade, watch in the Tradovate web UI for the stop to move when MFE
   crosses 70.
4. **Production rollout**: deploy with `EOD_CUTOFF_ET` and the kill
   switch as safety nets. Monitor one session before scaling.

## Limitations / things deliberately not done

- **No retry on modify-stop failure**. Add if we see prod blips.
- **No live MFE ratchet evaluator**. Stage 2 work — wait until Drew
  picks the ratchet config.
- **No partial-fill awareness**. Assumes one fill per signal at the
  reported entryPrice. If a limit order fills partial, current logic
  uses the first fill's reported entry. Acceptable for futures.
- **No symbol-rollover handling within an open trade**. If a position
  is open across contract rollover, the manager would keep tracking
  the same symbol; it's the broker's bracket that matters here, not
  the manager's MFE math.
- **PMT support is best-effort**. `modifyStopBySignalId` for PMT needs
  the symbol hint to route; current code passes it but PMT can't
  guarantee the right order is modified. Tradovate path is the
  primary target.
