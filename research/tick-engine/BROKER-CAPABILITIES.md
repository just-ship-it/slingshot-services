# Broker Capability Map — what Tradovate can hold server-side

Companion to `DESIGN.md`. Answers open question #3 ("Broker order palette").
Status 2026-08-19.

## Sources

| What | Where | Notes |
|---|---|---|
| **OpenAPI 3.0 spec, vendored — USE THIS ONE** | `/home/drew/projects/slingshot-services/tradovate-service/openapi.json` | 590 KB, dated 2025-12-02. Already in the repo, and **strictly richer than the live spec** — it carries `PreTradeRisk`, `PreTradeRiskParameter`, and `MarginSnapshot.positionMargin`, none of which appear in `spec.json`. |
| OpenAPI 3.0 spec, live | `https://api.tradovate.com/spec.json` | 489 KB. Schema-identical to the vendored copy for the order schemas, but trimmed on the risk schemas. |
| Rendered docs | `https://api.tradovate.com/#tag/Orders` | Swagger-UI SPA — `curl` returns an empty shell; the spec is the usable form. |
| Getting Started | `https://api.tradovate.com/pages/GettingStarted.md` | Requires a LIVE account >$1000 equity + API Access subscription + API key. |
| Rate limits (policy) | `https://github.com/tradovate/example-api-faq/blob/main/docs/HowDoesTradovateLimitRequestsAndData.md` · `.../HowToHandleRequestLimits.md` | |
| Time-penalty protocol | `https://github.com/tradovate/example-api-js/tree/main/tutorial/Access/EX-3-Time-Penalty` | |
| Order status definitions | `https://tradovate.zendesk.com/hc/en-us/articles/219454917-What-do-different-order-statuses-mean` | The legacy Zendesk help center is machine-readable; `support.tradovate.com` (Salesforce) is not. |
| Margin incl. working orders | `https://tradovate.zendesk.com/hc/en-us/articles/205815947-Can-I-place-trades-while-my-account-is-under-margined` · `https://tradovate.zendesk.com/hc/en-us/community/posts/360000475488` | |
| Margin time regimes | `https://tradovate.zendesk.com/hc/en-us/articles/115002511608-What-hours-are-day-night-and-initial-margins-available` · `https://www.tradovate.com/liquidation-policy/` | |
| Flatten & Cancel timer | `https://tradovate.zendesk.com/hc/en-us/articles/115009654847` | |
| Rate limit in practice | `https://community.tradovate.com/t/api-rate-limit-question/3545` · `https://support.flowbots.ninja/hc/en-us/articles/36160776166548-Frozen-orders` | |
| modifyOrder full-replace trap | `https://community.tradovate.com/t/order-modifyorder-response-successful-but-order-is-not-modified/4464` · `.../time-in-force-cannot-be-changed/6400` | |
| OSO/OCO in practice | `https://community.tradovate.com/t/oso-oco-bracket-orders/10272` · `.../trouble-with-order-placeoco/5823` · `.../need-help-with-a-simple-tp-sl-oso-oco/11370` | |
| `orderStrategyTypeId` | `https://community.tradovate.com/t/oso-order-in-api/3192` · `.../starting-strategies-through-api/2625/22` | |
| `activationTime` behavior | `https://community.tradovate.com/t/modifyorder-changing-status-from-suspended-to-working/10299` | |
| Mixed OCO/OSO topologies | `https://community.tradovate.com/t/orderstrategy-with-a-mix-of-oco-and-oso/3874` | |
| Connection limit / 408s | `https://community.tradovate.com/t/api-order-failures/4098` | |

> **The official doc examples are wrong about Stop price fields.** `placeOCO`'s doc
> example shows `{"orderType": "Stop", "price": 4100.00}`, and a Tradovate staff post shows
> `{"orderType": "TrailingStop", "price": 4480.00}`. Every *working* community example and
> our own production connector use **`stopPrice`** for the trigger. Trust the working code.

---

## 0. Executive summary

**Offloadable to the broker today, natively:** every single-level Watch. Stop entries,
limit entries, and same-side or opposite-side stop-limit entries are all one
`POST /order/placeorder`. A stop-entry *with an attached bracket* is one `POST /order/placeoso`.
Two-leg "A before B" straddles are one `POST /order/placeoco` (schema-legal; needs a demo
test). Time-voiding an arm (`GTD` + `expireTime`) and time-gating it (`activationTime`) are
**fields on the order itself** — we currently send neither, and this is the largest
unclaimed capability in the API.

**Not offloadable, ever:** anything whose predicate is not a price level — bar-close
confirmation, multi-leg conditions, cross-instrument triggers — and any mutual-cancel group
with more than 2 *entry* legs (OCO is structurally capped at 2).

**The fvg-bear blocker is ours, not Tradovate's.** Tradovate documents no working-order
count limit. Our orchestrator's `hasOpenOrPending()` and its `pendingOrders` Map key are
what enforce one-at-a-time. Measured requirement: **13 concurrent working sell-limits** at
peak (§5.1). Unblocking it is a re-keying job plus a `fill → orderVersion.text` attribution
join, not a broker negotiation.

**The three constraints that will actually shape the design**, none of them about which
order types exist:

1. **Working orders consume margin** (§5.2) — 13 resting 1-lots hold margin for 13
   contracts, at *full initial* margin from 16:45 ET onward. This, not the API, caps N.
2. **The rate limit is undisclosed, variable, and fails badly** (§2.9) — the consensus
   budget is ~1.4 actions/second sustained, and exceeding it can leave orders **frozen and
   un-cancellable except through the web UI**. Continuous re-pricing of many watches is the
   riskiest idea in `DESIGN.md` and needs a dead-band plus adaptive backoff, not a cadence.
3. **A 200 response is not a confirmation** (§2.7) — modifies are asynchronous, full-replace
   (omitted fields silently revert), and only the WebSocket event stream tells you what
   actually happened. Parity between the tick engine's model of the book and the broker's
   depends on consuming that stream, not on POST return values.

---

## 1. What our code already sends (authoritative for "known to work")

### 1.1 Call sites

| Path | File | Endpoint |
|---|---|---|
| `_placeSimple` | `/home/drew/projects/slingshot-services/shared/connectors/tradovate-connector.js:383` | `POST /order/placeorder` |
| `_placeBracket` | `…/tradovate-connector.js:409` | `POST /order/placeOSO` |
| `_placeTrailingStrategy` | `…/tradovate-connector.js:455` | `POST /orderStrategy/startOrderStrategy` |
| `cancelOrder` | `/home/drew/projects/slingshot-services/tradovate-service/TradovateClient.js:457` | `POST /order/cancelorder` |
| `modifyOrder` | `…/TradovateClient.js:481` | `POST /order/modifyorder` |
| `liquidatePosition` | `…/TradovateClient.js:1078` | `POST /order/liquidateposition` |
| **live demo probe** | `/home/drew/projects/slingshot-services/scripts/test-tradovate-tagging.js` | **ready-made harness for §7** |

`placeOCO` **is not called anywhere in the repo.** There is no OCO code path at all.

Demo base URL in use: **`https://demo.tradovateapi.com/v1`** (`TRADOVATE_DEMO_URL` in
`shared/.env`). Note this is *not* `demo-api-d.tradovate.com/v1`, which is only the
Swagger "try it" server listed in `spec.json`.

### 1.2 Fields we actually put on the wire

```
accountId, contractId, symbol, action, orderQty, orderType,
price, stopPrice, isAutomated, text, clOrdId,
bracket1{action,orderType,stopPrice,text,clOrdId},
bracket2{action,orderType,price,text,clOrdId}
```

Schema fields we **never send**: `accountSpec`, `timeInForce`, `expireTime`,
`activationTime`, `maxShow`, `pegDifference`, `customTag50`.

- `contractId` is **not in the `PlaceOrder` schema**. Tradovate resolves the instrument
  from `symbol`; our `contractId` is silently ignored. Harmless, but don't rely on it.
- `customTag50` is deliberately omitted — CME rejects it ("Unregistered Tag50") unless
  pre-registered, per our own note at `tradovate-connector.js:426`. Attribution rides on
  `text` (FIX 58) and `clOrdId` (FIX 11). Both are `maxLength: 64`; `_buildOrderTag`
  (`tradovate-connector.js:1470`) caps signalIds at 60 to leave room for `.sl`/`.tp`
  suffixes on children. Correct.
- `timeInForce` is omitted everywhere except the orderStrategy `params` blob, which
  hardcodes `"Day"` (`TradovateClient.js:540`). **Every order we place is a Day order.**
  GTC/GTD/IOC/FOK are entirely untested by us.
- `isAutomated: true` is correct and required — it is a **regulatory honesty flag**, not a
  hint. Official wording: if a human physically triggers via UI it must be `false`; if a
  bot or any impersonal process triggers it, it must be `true`.

### 1.3 Maturity ladder

| Capability | State | Evidence |
|---|---|---|
| `Market` / `Limit` entry, plain | **Production-proven** | The whole live book ran on these. |
| OSO bracket: Limit/Market primary + Stop SL + Limit TP | **Production-proven** | `_placeBracket`, plus the demo probe script. |
| `orderStrategy` bracket w/ `autoTrail` | **Production-proven** | `_placeTrailingStrategy`; trailing was live on the FCFS book. |
| `modifyOrder` on a **bracket stop leg** | **Production-proven** | BE / MFE ratchet (`modifyStop`, `tradovate-connector.js:565`). |
| `cancelOrder` on a working limit | **Production-proven** | `checkStaleLimits` (`trade-orchestrator/index.js:1646`). |
| `text` / `clOrdId` round-trip | **Production-proven** | `scripts/test-tradovate-tagging.js` was written to prove exactly this. |
| `Stop` entry (`place_stop`) | **CODE-COMPLETE, NEVER EXECUTED** | For `pattern-hs-top`. Uncommitted; strategy not in `strategy-config.json`. |
| `StopLimit` entry (`place_stop_limit`) | **CODE-COMPLETE, NEVER EXECUTED — CURRENTLY THROWS** | §1.4-1. For `pattern-retest-long`. |
| `modifyOrder` on a working **entry** order | **NEVER ATTEMPTED** | Only stop legs are ever modified. |
| OCO of any kind | **NO CODE EXISTS** | |
| `timeInForce` ≠ Day, `activationTime` | **NEVER SENT** | |
| >1 concurrent working entry | **STRUCTURALLY BLOCKED** | §3.7. |

### 1.4 Bugs found while auditing

All pre-existing. (1) and (2) block the tick engine directly.

1. **`hasTrailing` temporal-dead-zone crash — `StopLimit` cannot reach the broker.**
   `shared/connectors/tradovate-connector.js:244` reads `hasTrailing`, declared `const` at
   line 253. Any `StopLimit` order passing the line-240 guard throws
   `ReferenceError: Cannot access 'hasTrailing' before initialization`.
   Fix: hoist the `hasStop`/`hasTarget`/`hasTrailing` block above the validation gates.

2. **`modifyBracketStop` silently converts a Stop into a Limit.**
   `TradovateClient.js:811` calls `modifyOrder({ orderId: stopOrderId, stopPrice })` with
   **no `orderType`**. `modifyOrder` defaults it to `'Limit'` at line 489. Since
   `orderType` is *required* on every modify and the call is a full OrderVersion
   replacement rather than a patch, this turns the working stop into a limit order at an
   undefined price. Compounded by (3), the path is rarely reached — but it is a live
   money bug the moment it is.

3. **`modifyBracketStop` scans a field that does not exist.**
   `TradovateClient.js:797` matches `dep.ordType === 'Stop'`. Tradovate entities use
   **`orderType`**; `ordType` appears nowhere in the schema (`ordStatus` does, which is
   likely the source of the confusion). The scan never matches, so the trailing-strategy
   path always falls through to `interruptOrderStrategy`. The OSO path is unaffected
   because `modifyStop` short-circuits on the cached `stopOrderId` first.

4. **`placeOrder` ignores `failureReason`.**
   `POST /order/placeorder` returns **HTTP 200 with a `failureReason` enum** on rejection —
   it does not throw. `TradovateClient.placeOrder` (line 405) returns the body unexamined,
   so the connector notices only that `orderId` is undefined and the actual reason is
   discarded. `placeBracketOrder` tries `response.errorText`; the field is **`failureText`**.
   At high working-order counts `MaxPosLimitReached` and `RiskCheckTimeout` become the
   expected failure modes, and we currently cannot see either.

5. **`armTimeoutCandles` has no live implementation.**
   `pattern-retest-long` emits it to bound a StopLimit's *pre-trigger* window separately
   from its post-trigger limit window. Honored only in
   `backtest-engine/src/execution/trade-simulator.js:651,808`. The orchestrator's
   `checkStaleLimits` knows only `timeoutCandles`, measured from **placement**, not from
   **arming**. Live and backtest will disagree on when a StopLimit is pulled — exactly the
   parity class `DESIGN.md` exists to eliminate. Note `activationTime` + `GTD`/`expireTime`
   (§2.3) make the arm window broker-holdable, which is the better fix.

---

## 2. The Tradovate palette

### 2.1 Order types

One enum, shared by `PlaceOrder`, `PlaceOSO`, `PlaceOCO`, `ModifyOrder`, `OrderVersion`,
`RestrainedOrderVersion`:

```
Limit | MIT | Market | QTS | Stop | StopLimit | TrailingStop | TrailingStopLimit
```

- **`MOO` / `MOC` do not exist.** Confirmed by exhaustion of the enum.
- **`MIT`** = Market-If-Touched, the mirror of Stop: triggers on a *favorable* touch and
  becomes a market order. A genuinely useful Watch primitive we have never used — "buy at
  market once price trades **down** to A". ⚠️ Behaviorally suspect: the NinjaTrader vendor
  forum reports MIT mapping bugs on the Tradovate connection
  (`https://forum.ninjatrader.com/forum/ninjatrader-8/platform-technical-support-aa/1303030-tradovate-mit-orders-have-wrong-ordertype`).
- **`QTS`** — in the enum, zero documentation anywhere. Do not use.
- **`TrailingStop` / `TrailingStopLimit`** exist as standalone types, distinct from the
  `autoTrail`/`trailingStop` flag inside an orderStrategy `params` blob. Which field
  carries the trail distance is **UNCONFIRMED** (`pegDifference` is the only candidate and
  is itself undocumented).

Price-field convention (from working code, not doc prose — see the warning above):

| orderType | fields |
|---|---|
| `Market` | none |
| `Limit` | `price` |
| `Stop` | `stopPrice` (trigger) |
| `StopLimit` | `stopPrice` = trigger, `price` = limit |
| `MIT` | `stopPrice` (UNCONFIRMED) |

### 2.2 Time in force

`Day | FOK | GTC | GTD | IOC`, plus `expireTime` (`date-time`, ISO-8601).

Present on `PlaceOrder`, `ModifyOrder`, **and `RestrainedOrderVersion`** — so bracket/OCO
child legs carry their own TIF independently of the primary. `timeInForce` is not in any
`required` array; omitting it yields Day.

`expireTime` is not formally marked required-for-GTD but is required in practice. Both
forms are accepted in observed working payloads: `"2024-09-26T17:00:00-04:00"` and
`"2026-04-02T22:42:07.000Z"`.

**Session-close behavior differs sharply by TIF** — see §5.3. This is the finding that
makes GTC interesting for us.

### 2.3 `activationTime` — the sleeper feature

`date-time` on `PlaceOrder`, `ModifyOrder`, and `CancelOrder`. Absent from our code.

Community evidence strongly suggests it does what the name implies: a user reported an
order sitting `Suspended` and being forced to `Working` when `activationTime` was included
on a **modify**, with the explanation that `activationTime` *"refers to when the state
should change to Working no matter what"*
(`https://community.tradovate.com/t/modifyorder-changing-status-from-suspended-to-working/10299`).
That implies the placement-side behavior is: **accepted → `Suspended` → `Working` at the
stated instant.**

If so, then combined with `GTD`+`expireTime` the Watch shape

> "arm at level A, but only between 09:45 and 10:15 ET"

is **broker-holdable in a single order**, with zero software involvement and surviving our
own downtime. Highest-leverage item in this document; §7-T1 confirms it.

🚨 **Never send `activationTime` on a modify.** It forces a `Suspended` order to `Working`
immediately. That is the exact accident in the cited thread.

### 2.4 OSO — `POST /order/placeoso`

```
PlaceOSO {
  required: action, symbol, orderQty, orderType, bracket1
  + every PlaceOrder field (accountSpec, accountId, clOrdId, price, stopPrice,
    maxShow, pegDifference, timeInForce, expireTime, text, activationTime,
    customTag50, isAutomated)
  bracket1: RestrainedOrderVersion   (REQUIRED)
  bracket2: RestrainedOrderVersion   (optional)
}
→ PlaceOsoResult { failureReason, failureText, orderId, oso1Id, oso2Id }

RestrainedOrderVersion {
  required: action, orderType
  clOrdId, price, stopPrice, maxShow, pegDifference, timeInForce, expireTime, text
}
```

**The OSO primary may be any type in the enum, including `Stop` and `StopLimit`.**
`PlaceOSO.orderType` is the identical unrestricted enum — nothing in the schema, the prose,
or the `failureReason` list restricts it to Limit/Market. **A stop-entry-with-attached-
bracket is one API call.** (Schema-confirmed; no doc states it in words, so §7-T7 confirms.)

Official note: *"If you specify both `bracket1` and `bracket2` the two orders will be
linked as an OCO, where filling one will cancel the other."*

Structural facts:
- Exactly **two** children max — named fields, not an array.
- Children have **no `orderQty`**; they inherit the primary's. **You cannot scale out via
  OSO.** (`startOrderStrategy`'s `brackets[]` is the scale-out path — §2.6.)
- Children have no `isAutomated` / `customTag50` / `activationTime`, but **do** have
  `text`, `clOrdId`, `timeInForce`, `expireTime`.
- `bracket1` is **required** — there is no "OSO with only a take-profit". Our
  `_placeBracket` sets `bracket1: undefined` when `stopLoss` is null while still passing
  `bracket2`; that request is schema-invalid. Unreachable today (no target-only strategy)
  but it will fail when one appears.

⚠️ **`oso1Id` / `oso2Id` are frequently absent in practice.** Our own repo records this at
`tradovate-connector.js:1096`: *"`/order/placeOSO` does not return `oso1Id`/`oso2Id`
synchronously so the in-memory links never learn the bracket children's orderIds."*
Discover child ids via `GET /order/list` or the WebSocket feed, not from the POST response.

### 2.5 OCO — `POST /order/placeoco`

```
PlaceOCO {
  required: action, symbol, orderQty, orderType, other
  + every PlaceOrder field
  other: RestrainedOrderVersion   (REQUIRED, exactly one — not an array)
}
→ PlaceOcoResult { failureReason, failureText, orderId, ocoId }
```

- **OCO is strictly 2 legs.** `other` is one object; the result carries one `ocoId`; the
  `Order` entity has a single scalar `ocoId`. There is no `linkOrders` endpoint and no way
  to append a third leg. Confirmed by schema exhaustion.
- `other.action` is **required and independent** — the legs may be opposite sides.
- `other.orderType` is the full enum, so **an OCO of two `Stop` orders is schema-legal**.
- OCO legs **cannot themselves carry brackets** (no `bracket1` on `PlaceOCO`). A straddle
  entry with an attached stop is not expressible in one call.

### 2.6 Order strategies — `POST /orderStrategy/startorderstrategy`

```
StartOrderStrategy {
  required: symbol, orderStrategyTypeId, action
  accountId, accountSpec, params (STRING, maxLength 8192), uuid, customTag50
}
→ OrderStrategyStatusResponse { errorText, orderStrategy }
```

- **There is no `placeOrderStrategy` operation.** The surface is `startorderstrategy`,
  `modifyorderstrategy`, `interruptorderstrategy`, `item`, `items`, `list`, `deps`, `ldeps`.
- **`orderStrategyTypeId: 2` is the only valid value** ("multibracket"), per Tradovate
  staff: *"Currently, there is only one valid value for `orderStrategyTypeId`, and that
  value is `2`."* There is no `strategyType` string and no separate "Bracket" vs
  "TrailingStop" strategy type. Our hardcoded `2` is correct and there is nothing to
  enumerate.
- ⚠️ **`params` must be a stringified JSON blob, not an object.** Passing an object yields
  `"errorText": "Invalid or missed parameters"`.

`params` shape (reverse-engineered; our `TradovateClient.placeOrderStrategy` at line 530 is
the better reference than the docs, being production-validated):
```json
{"entryVersion":{"orderQty":1,"orderType":"Limit","price":24000.00,"timeInForce":"Day"},
 "brackets":[{"qty":1,"profitTarget":40,"stopLoss":-20,"trailingStop":true}]}
```
- `profitTarget` / `stopLoss` are **signed relative point offsets from entry, not absolute
  prices**. Buy → target positive, stop negative; Sell → reversed. Our code preserves the
  sign deliberately (`TradovateClient.js:570`).
- **`brackets` is an array with no documented cap** — this is the *only* path to more than
  2 exit legs and to true scale-out. Bounded practically by `params` ≤ 8192 chars.
- `autoTrail: {stopLoss, trigger, freq}` (what we send) is **UNCONFIRMED** in docs and was
  rejected in the one documented outside attempt — but it is production-proven for us.
- Tradovate's trailing is **trigger-based, not continuous**: it activates only after a
  set amount of profit.

⚠️ **OSO brackets are NOT OrderStrategy entities.** OrderStrategy lookups 404 for
OSO-placed brackets — our repo learned this at `tradovate-connector.js:566`. To move an OSO
bracket stop, call `/order/modifyorder` on the child orderId directly.

⚠️ Two more practical notes: staff advise sending `startOrderStrategy` **over the WebSocket
rather than REST** (REST returned bare 404s for some callers), and there is an undocumented
**cap on concurrent running order strategies** (§5.2). Both are reasons to prefer `placeOSO`
over `startOrderStrategy` for the tick engine wherever a 2-leg bracket suffices — which,
given fvg-bear and hs-top use stop-or-time exits with no scale-out, is everywhere so far.
OSO/OCO bracket prices must be **absolute**; there is no tick-offset form (that is
`startOrderStrategy`'s `params` only).

`ModifyOrderStrategy` = `{orderStrategyId, command: string ≤1024, customTag50}`; `command`
is another opaque stringified blob with **no documented vocabulary**. Modifying a running
strategy is generally reported as unsupported — cancel and re-send.

### 2.7 Modify — `POST /order/modifyorder`

```
ModifyOrder {
  required: orderId, orderQty, orderType
  clOrdId, price, stopPrice, maxShow, pegDifference, timeInForce,
  expireTime, text, activationTime, customTag50, isAutomated
}
→ CommandResult { failureReason, failureText, commandId }
```

**A working entry order's price can be changed in place.** Official doc: *"You can request
changes to an order, such as the trigger price for a Stop or Limit order."* Caveat
verbatim: *"This is no guarantee that the order can be modified in the way requests.
Market, exchange and logical rules apply."* Nothing forbids modifying a leg of an OSO/OCO —
that is our production breakeven mechanism.

🚨 **Semantics are full OrderVersion replacement, not a patch — and omitted fields revert to
defaults, producing a SILENT failure.** Documented case: a modify returned HTTP 200 with a
`commandId` and even emitted two `orderVersion Created` events carrying the new price, yet
the order never moved. Cause: `timeInForce` was omitted, defaulted to `Day`, and the target
order was `GTC` → the exchange rejected with *"cannot modify time-in-force"*. **Always
resend `orderQty`, `orderType`, AND `timeInForce`.** See §1.4-2 for our version of this bug.

🚨 **A 200 + `commandId` is NOT confirmation.** You must watch the WebSocket for
`Command.commandStatus` (`RiskPassed`, `RiskRejected`, `ExecutionRejected`, `Replaced`, …)
or `ExecutionReport.execType` (`Replaced` vs `Rejected`). A tick engine that re-prices on a
timer and assumes success will drift out of sync with the broker's actual book.

Constraints that matter:
- **`AnotherCommandPending`** — a modify issued while a prior command on that order is
  still in flight is rejected. Re-pricing must be a state machine that waits for the
  previous `CommandResult`, not a fire-and-forget loop.
- **`TrailingStopNonOrderQtyModify`** — on a `TrailingStop`, **only `orderQty` may be
  modified**. Trail parameters are immutable; changing them means cancel + replace.
- Returns `commandId`, **not** `orderId` — the modify is asynchronous and its outcome
  arrives over the WebSocket `order` / `orderVersion` stream.
- 🚨 Never include `activationTime` (§2.3).

### 2.8 Rejection reasons (29 values — worth wiring into logs)

```
AccountClosed, AdvancedTrailingStopUnsupported, AnotherCommandPending, BackMonthProhibited,
ExecutionProviderNotConfigured, ExecutionProviderUnavailable, InvalidContract, InvalidPrice,
LiquidationOnly, LiquidationOnlyBeforeExpiration, MaxOrderQtyIsNotSpecified,
MaxOrderQtyLimitReached, MaxPosLimitMisconfigured, MaxPosLimitReached, MaxTotalPosLimitReached,
MultipleAccountPlanRequired, NoQuote, NotEnoughLiquidity, OtherExecutionRelated, ParentRejected,
RiskCheckTimeout, SessionClosed, Success, TooLate, TradingLocked,
TrailingStopNonOrderQtyModify, Unauthorized, UnknownReason, Unsupported
```

The ones a tick engine at scale will meet: `MaxPosLimitReached` / `MaxTotalPosLimitReached`
(§5.2), `AnotherCommandPending` (§2.7), `RiskCheckTimeout` (pre-trade risk check timed out
under load), `SessionClosed`, `TooLate`, `InvalidPrice` (off-tick, wrong-side trigger, or
an illegal OCO combination).

`Order.ordStatus` enum (11 values):
```
Canceled, Completed, Expired, Filled, PendingCancel, PendingNew,
PendingReplace, Rejected, Suspended, Unknown, Working
```

### 2.9 Rate limits — deliberately undisclosed and *variable*

This is stated policy, not a documentation gap:

> *"there is no 'hard-cap' on request rate or data size limits. Instead these values are
> variable… one hour it could be 10 requests per minute on a given endpoint, and another
> time it could be 100."*
> — `HowDoesTradovateLimitRequestsAndData.md`

> *"There are request limits on the hour, minute, and second intervals. As soon as a limit
> reached, our server stops handling requests for a period of time and responds to each new
> request with 429 status code… Generally, the limits are high enough not to hit them
> during normal operations."*
> — `https://api.tradovate.com/#section/Request-rate-limits-and-time-penalty`

**Design consequence: you cannot calibrate a fixed order rate against a published number,
and a rate measured on demo today may not hold tomorrow.** The tick engine must be
adaptive — back off on 429/p-ticket rather than run open-loop at a constant cadence.

**Time-penalty protocol** (our client implements it correctly at
`TradovateClient.makeRequest`, lines 241-336): response carries `p-ticket` / `p-time` /
`p-captcha`; the request **was not handled**; retry after `p-time` **seconds** resending the
original body **plus `p-ticket` in the body** (not a header). `p-captcha: true` cannot be
resolved from a third-party app — the user must wait an hour.

Two useful nuances:
- The FAQ scopes the penalty ticket mainly to **"novel operations… known to be called
  infrequently"** — auth, signup, password change, contact change. The EX-3 tutorial
  nonetheless names *"too many order modifications over too short a time period"* as a
  trigger, so order modification is on the list. Treat it as real but secondary to the
  plain 429.
- **Connection limit, separate from request rate:** *"We have a limit for a number of one
  simultaneous client connection per customer… When a customer reaches their limit of
  connections, the server will disconnect the oldest ones."* This is the source of the
  408 errors discussed at `https://community.tradovate.com/t/api-order-failures/4098?page=2`,
  commonly hit when running multiple instances or distinct device IDs. **A tick engine
  running alongside the existing tradovate-service will contend for that single connection
  slot** unless extra connections are purchased.

**The number the whole ecosystem quotes: ~5,000 actions per rolling 60 minutes (~80/min).**
Not stated by Tradovate itself anywhere, but consistent across NinjaTrader-ecosystem docs
(`https://support.flowbots.ninja/hc/en-us/articles/36161235334676-Rate-Limit-Exceeded`),
prop-firm docs, and third-party integrators. Crucially: *"Placing, modifying, and canceling
orders are each separate actions."* **Budgeting against that implies ~1.4 actions/second
sustained** — an order of magnitude below our self-imposed `maxRequestsPerSecond = 10`
(`TradovateClient.js:29`, a guess). Any per-second burst ceiling on top is undocumented.

🚨 **The failure mode is worse than a 429: "frozen" / "golden" orders.** On exceeding the
limit, working orders stop responding to cancel/modify/flatten and must be cleared from the
Tradovate web UI by hand. NinjaTrader tracks this as NT-14091 and logs *"A rate limit for
too many order requests has been hit."*
(`https://support.flowbots.ninja/hc/en-us/articles/36160776166548-Frozen-orders`). **For an
unattended tick engine this is the single worst outcome in this document** — not a rejected
order, but a book you cannot cancel. Vendor guidance is explicit: *"Don't make multiple
price changes in a short period. Minimize order modifications during active trading."*
Recovery: the rolling window self-clears, and Tradovate support can reset request limits
(`https://tradovate.zendesk.com/hc/en-us/articles/21231586260243`).

**Do not poll REST for state.** Staff direct you to the WebSocket `user/syncrequest` entity
stream (`order`, `orderVersion`, `command`, `commandReport`, `executionReport`, `fill`,
`orderStrategy`, `orderStrategyLink`) for position/order state. A 1 Hz REST reconcile loop
across many watches will trip the limiter on its own, before any order activity.

**HTTP 408 is the connection limit, not a rate limit.** One simultaneous connection per
customer (two with the Dual Connections subscription); the server disconnects the oldest.
**A tick engine running alongside the existing tradovate-service — or anyone opening the
Trader web UI — will contend for that slot.** Reuse a single `accessToken` across REST and
WebSocket paths.

Minor inconsistency in our client: the order path injects `'p-ticket'` (hyphen), the auth
path uses `p_ticket` (underscore); the spec says hyphen.

---

## 3. Watch → order mapping

Legend: **(a)** natively broker-holdable · **(b)** holdable with a workaround ·
**(c)** must be orchestrated in software.

Payloads go to `POST /order/placeorder` unless noted.

### 3.1 `buy if price >= A` — stop entry — **(a)**

```json
{ "accountSpec": "YourUserName", "accountId": 1234567,
  "symbol": "MNQU6", "action": "Buy", "orderQty": 1,
  "orderType": "Stop", "stopPrice": 23500.00,
  "timeInForce": "Day", "isAutomated": true,
  "text": "wid-8f21", "clOrdId": "wid-8f21" }
```
Mirror for `sell if price <= A`: `"action": "Sell"`. The trigger must be on the correct
side of the market at placement or you get `InvalidPrice`. `_placeSimple` already builds
exactly this from `orderType: 'Stop'` + `message.price`.

### 3.2 `buy if price <= A` — limit entry — **(a)**

```json
{ "symbol": "MNQU6", "action": "Buy", "orderQty": 1,
  "orderType": "Limit", "price": 23400.00, "timeInForce": "Day", "isAutomated": true }
```
Production-proven. Alternative worth testing: `"orderType": "MIT"` with
`"stopPrice": 23400.00` gives *guaranteed fill at market on the touch* instead of
*guaranteed price, maybe no fill* — removing the queue-position risk fvg-bear's shadow was
meant to observe. Weigh against the MIT reliability caveat in §2.1.

### 3.3 `buy at A only after price first touches T` — stop-limit — **(a)**, one caveat

Same-side (trigger above, limit above — chase):
```json
{ "symbol": "MNQU6", "action": "Buy", "orderQty": 1, "orderType": "StopLimit",
  "stopPrice": 23500.00, "price": 23502.00, "timeInForce": "Day", "isAutomated": true }
```

Opposite-side — **our `retest-long` shape** (trigger above, limit below):
```json
{ "symbol": "MNQU6", "action": "Buy", "orderQty": 1, "orderType": "StopLimit",
  "stopPrice": 23500.00, "price": 23470.00, "timeInForce": "Day", "isAutomated": true }
```
The schema places no constraint between `stopPrice` and `price`, and FIX semantics allow a
buy stop-limit whose limit sits below its trigger. But brokers commonly add an "illogical
order" pre-trade validation the schema does not express, and this is the exact shape
`pattern-retest-long`'s whole edge depends on. **Demo test required** (§7-T2). Also §1.4-1:
this path currently throws before reaching the network.

### 3.4 `A before B` straddle — **(a)**, pending one test

`POST /order/placeoco`:
```json
{ "accountSpec": "YourUserName", "accountId": 1234567, "symbol": "MNQU6",
  "action": "Buy", "orderQty": 1, "orderType": "Stop", "stopPrice": 23520.00,
  "timeInForce": "Day", "isAutomated": true, "text": "wid-8f21", "clOrdId": "wid-8f21.up",
  "other": { "action": "Sell", "orderType": "Stop", "stopPrice": 23460.00,
             "timeInForce": "Day", "text": "wid-8f21", "clOrdId": "wid-8f21.dn" } }
```

Two forum threads *look* like "two stops are banned" but on inspection are **price-side
validation failures, not combination bans**:
- `community.tradovate.com/t/need-help-with-a-simple-tp-sl-oso-oco/11370` — a Sell Stop
  placed **above** market. Intrinsically invalid regardless of OCO.
- `community.tradovate.com/t/trouble-with-order-placeoco/5823` — Buy Stop + Sell Limit
  **below** market (immediately marketable), rejected with
  `{"failureReason": "InvalidPrice", "failureText": "Wrong OCO combination"}`.

Neither tested Buy-Stop-**above** + Sell-Stop-**below**, where both legs are individually
valid. Schema permits it; the observed rejections are explained. **Not confirmed working,
not confirmed broken — this is the single most important open item.** Watch for exactly
`failureReason: "InvalidPrice"` / `failureText: "Wrong OCO combination"` (§7-T3).

Encouraging signal: a standing feature request complains that *"The Tradovate DOM only
currently allows for a pair of **opposing** buy-sell OCO orders. I'd like to have a buy-buy,
or a sell-sell OCO pair"* (`https://community.tradovate.com/t/477`). The straddle is an
opposing buy-sell pair — i.e. precisely the case that *is* supported — and what is missing is
the same-side pairing we don't need. The UI also exposes OCO natively (order-ticket
"Advanced", DOM and Chart bracket entry), which establishes the underlying capability.

**Caveat regardless of outcome:** OCO legs cannot carry brackets (§2.5), so the surviving
fill has no broker-side stop until we place one reactively.

**We have zero OCO code.** This is new construction.

### 3.5 `arm only during a window / cancel at time X` — **(a)**

Cancel-at-time — **(a)** today, no unknowns:
```json
{ "symbol": "MNQU6", "action": "Buy", "orderQty": 1, "orderType": "Stop",
  "stopPrice": 23500.00, "timeInForce": "GTD",
  "expireTime": "2026-08-19T14:15:00.000Z", "isAutomated": true }
```
Arm-at-time — **(a)** if `activationTime` behaves as §2.3 indicates:
```json
{ "…": "…", "activationTime": "2026-08-19T13:45:00.000Z",
  "timeInForce": "GTD", "expireTime": "2026-08-19T14:15:00.000Z" }
```
Until §7-T1 confirms, treat the arm side as **(c)**.

We currently do all of this in software (`checkStaleLimits`, `computeSignalExpiry`) — a
polling loop with minute granularity that only fires while the orchestrator is alive. GTD
moves the void to the exchange and makes it survive our downtime.

### 3.6 `cancel if a 1m bar CLOSES beyond X` — **(c)**, no analog exists

Confirmed by exhaustion: no field in `PlaceOrder`, `RestrainedOrderVersion`, or the single
`orderStrategyTypeId: 2` params blob expresses a bar-close predicate, and the broker has no
concept of our bar boundaries. This is `fvg-bear`'s `cancelOnCloseBeyond` and it stays in
software permanently (`trade-orchestrator/src/pre-fill-cancel.js:154`).

Mitigation that removes most latency exposure: keep the order resting at the broker and let
the software watcher only ever *cancel* it. A late cancel costs a bad fill on an
invalidated setup; a late *placement* costs the whole trade. We are already on the right
side of that trade-off — stated explicitly so nobody "fixes" it by holding the order back
until the bar closes.

### 3.7 `N concurrent working entries, first fill cancels the rest` — **(b)** for N=2, **(c)** beyond

| N | Status |
|---|---|
| 1 | What we do today. |
| 2 | **(a)** — one OCO (pending §7-T3). |
| >2 | **(c)** for the mutual-cancel semantics. The *orders* rest fine; **first-fill-cancels-the-rest** must be ours, because `Order.ocoId` is a scalar and `PlaceOCO.other` is a single object. There is no 3-leg OCO. |

Note the asymmetry: `startOrderStrategy`'s `brackets[]` array *does* support N>2 legs, but
only for **exits** on a single entry. There is no N-entry equivalent.

Workaround for N>2: place N independent working orders, subscribe to the fill stream, issue
N−1 cancels on the first fill. Exposure window is one software round-trip (~100-300 ms) in
which two could both fill. Given fvg-bear's levels are tens of points apart, a double-fill
needs a fast sweep through two gap tops — real but rare, and it fails *into* a larger
position rather than into no position.

**fvg-bear may not need mutual-cancel at all.** Its N orders are same-side sell-limits at
*different* levels representing *different* FVGs. If each is an independent trade with its
own stop and time cap, they are not alternatives and there is nothing to cancel — the
constraint becomes position sizing (up to 13 contracts if all fill). That is a risk-budget
decision, not a broker capability question, and it should be settled before any OCO work.

**What actually blocks us is our own code**, in two places:
- `trade-orchestrator/index.js:534` — `hasOpenOrPending()` rejects any signal when *any*
  pending order or open position exists on `(accountId, symbol)`, deliberately
  strategy-agnostic, so one working order blocks everything on that instrument.
- `trade-orchestrator/index.js:121` — `pendingKey = accountId|strategy|symbol`. The
  `pendingOrders` Map physically cannot hold two entries for one strategy on one symbol; a
  second overwrites the first and orphans its watchers.

Both must become watch-id-keyed. That is the real T4/T6 work item, and `text`/`clOrdId`
(§5.4) is the identity mechanism that makes it recoverable.

### 3.8 `move a working order's price as a level updates` — **(a)**, rate-bounded

```json
{ "orderId": 1234567, "orderQty": 1, "orderType": "Stop",
  "stopPrice": 23505.00, "isAutomated": true }
```
`POST /order/modifyorder` → `CommandResult { commandId }`. Same endpoint we already use in
production for breakeven stop moves. **Always restate `orderQty` and `orderType`** (§1.4-2).

Constraints in order of severity:
1. **`AnotherCommandPending`** — serialize per order; the next modify waits for the
   WebSocket confirmation, not a timer.
2. **Undisclosed, variable rate ceiling** (§2.9), with `p-captcha` = 1-hour credential
   lockout as the tail risk. A per-second re-pricing loop across many watches is the most
   dangerous thing in this design. Budget globally, back off adaptively, and prefer a
   dead-band (re-price only when the level moves >K ticks) over a fixed cadence.
3. **Cancel+replace loses queue priority and has a naked window.** Prefer modify. For
   `TrailingStop` only, modify is unavailable (§2.7) — cancel+replace is forced.

---

## 4. Must be orchestrated in software (definitive list)

1. **Bar-close predicates** — `cancelOnCloseBeyond`, "confirm on close" arming.
2. **Mutual cancellation across >2 working entries** (§3.7).
3. **Multi-leg / conjunctive conditions** — "if A *and* B", "if A while VIX > X".
4. **Cross-instrument triggers** — an NQ order armed by an ES level. No linkage exists.
5. **Derived-level triggers** — VWAP, ATR bands, EMA. The broker holds a *number*; if the
   number moves, that is §3.8 with its rate budget.
6. **Sequencing beyond one hop** — OSO nests one level (primary → 2 children). "Watch
   spawns watch spawns watch" is ours.
7. **Attribution and reconciliation** — mapping fills back to watch ids.
8. **Position-level risk across watches** — the broker nets; it does not know that 13
   working sell-limits are 13 independent theses.
9. **Arm-window start**, until `activationTime` is verified (§3.5).
10. **Contract rollover** — no automatic order migration (§5.3).

---

## 5. Risk and practical notes

### 5.1 How many concurrent orders do we actually need?

Measured over the full NQ event corpus (`research/price-structures/analysis/`; 6,513
`fvg-bear` 15m forming events, each resting for its `maxFormingBars × 15` window):

| stat | concurrent working orders |
|---|---|
| median | 4 |
| p90 | 7 |
| p99 | 10 |
| **max** | **13** |

Design target: **~15 concurrent working orders on one instrument for one strategy**. If the
whole tick-engine book runs several strategies on NQ+ES, budget ~50. Both are modest — the
100+ regime in the original brief is not where we are, and none of the constraints below
bind at 15 except `exposedLimit`.

### 5.2 Margin and working orders — **working orders DO consume margin**

This is the constraint that most directly bounds the tick engine, and it is confirmed.

**Tradovate-authored statement:** Total Margin Used *"will include all positions **and
working orders**"*
(`https://tradovate.zendesk.com/hc/en-us/community/posts/360000475488`).

**And there is an explicit pre-trade risk check that rejects:** *"The Tradovate system runs
a pre-trade risk review of your account to determine if you have the available margin to
place the proposed trade. If you do not, the order will be rejected."*
(`https://tradovate.zendesk.com/hc/en-us/articles/205815947`). At the API level this shows
as `Command.commandStatus` ∈ `{RiskPassed, RiskRejected}`, and the vendored spec carries
dedicated `PreTradeRisk` / `PreTradeRiskParameter` schemas.

Relevant fields (vendored spec):
- `UserAccountPositionLimit` — `longLimit`, `shortLimit`, **`exposedLimit`**, keyed by
  `totalBy` ∈ `{Contract, ContractGroup, DiscountGroup, Exchange, Overall, Product,
  ProductType}`. "Exposed" = net position + all working orders, i.e. worst case if every
  working order fills.
- `UserAccountRiskParameter` / `PreTradeRiskParameter` — `maxOpeningOrderQty`,
  `maxClosingOrderQty`, `maxBackMonth`, `preExpirationDays`, `marginPercentage`,
  `marginDollarValue`, `hardLimit`.
- `MarginSnapshot` — `totalUsedMargin`, `fullInitialMargin`, and (**vendored spec only**)
  **`positionMargin`**. The delta `totalUsedMargin − positionMargin` is where working-order
  margin should appear; that is exactly what §7-T4 measures.

🚨 **There is no `InsufficientMargin` value in the `failureReason` enum.** Margin rejections
arrive as free text in `failureText` (maxLength 8192) or under a generic code. **Parse
`failureText`, not just the enum** — which our client currently discards entirely (§1.4-4).

🚨 **Margin is time-dependent, and this bites overnight working orders hardest.** Reduced
day margin applies 6:00 PM ET → 4:45 PM ET; **full exchange initial margin is required from
4:45 PM ET and for anything held over the close**
(`https://tradovate.zendesk.com/hc/en-us/articles/115002511608`,
`https://www.tradovate.com/liquidation-policy/`). A basket of 13 working orders that clears
the pre-trade check at midday can be a margin call at 16:45 ET. fvg-bear's working window is
up to 900 minutes, so this is not hypothetical — **any tick strategy resting orders across
16:45 ET must be sized on full initial margin, not day margin.**

Note that all `Max*PosLimitReached` / `MaxOrderQtyLimitReached` reasons are
**quantity/position** limits, not order-count limits. **Tradovate documents no cap on the
number of working orders.** Adjacent hard caps that do exist: 100 contracts per order
(platform limit); `liquidatePositions.positions` array capped at 100; `PreTradeRisk.parameters`
capped at 10. And there *is* an undocumented **cap on concurrent running order strategies** —
`"your limit of running order strategies reached. please cancel previous ones"`
(`https://community.tradovate.com/t/12773`) — which matters only if you hold many brackets
via `startOrderStrategy` rather than `placeOSO`. Exact number UNCONFIRMED.

**Consequence for the design:** 13 working 1-lot sell-limits read as 13 contracts of short
exposure against `exposedLimit` and consume margin for all 13, even though the strategy
expects 1-4 fills. On a default retail risk profile that will trip `MaxPosLimitReached` or
the margin check. The account's `exposedLimit` and funding must be raised deliberately — a
real risk decision, because 13 simultaneous fills in a fast sweep then becomes a permitted
outcome rather than a blocked one, at full overnight initial margin.

### 5.3 Session close, and why GTC matters

The daily session runs **5:00 PM CT → 3:45 PM CT** (6:00 PM ET → 4:45 PM ET). Our
production EOD cutoff of 15:45 ET sits inside it.

- **Day orders → `Expired`** at session end. Tradovate: *"Your order expired at the
  exchange, typically because a day order was not filled or cancelled before the trading
  session ended."*
- **GTC orders → `Suspended`, then auto-reactivated.** Tradovate: *"Suspended: Your order is
  contingent on a certain condition being met before it is sent to the exchange and changes
  to a working status. This is common for legs of OCO orders, time-released orders, or GTC
  orders placed outside of active trading hours."* GTC orders are **not** cancelled at the
  close — they go `Suspended` and return to `Working` next session.
- Placing into a closed session returns **`SessionClosed`**. A tick engine re-arming watches
  across the 17:00 ET break must treat this as "retry after reopen", not a hard failure.

🚨 **GTC does NOT survive the weekend by default.** At the CME level, unless weekend trading
is enabled in Globex Credit Controls, **all Good-Till orders (GTC and GTD) are eliminated at
Friday 4:00 PM CT**, with an FCM opt-in required to retain them. CME also cancels resting day
orders at the start of the Saturday maintenance window and resets iLink sequence numbers
(`https://cmegroupclientsite.atlassian.net/wiki/spaces/EPICSANDBOX/pages/1553563649/24-7+Technical+Market+Functionality`;
second-hand — the subsection did not render on direct fetch). **So GTC buys you overnight
persistence Monday-Thursday, not weekend persistence.** Verify empirically (§7-T5) before
any Watch design assumes a level survives to Sunday's open.

**Broker-side kill switches that cancel working orders — useful, and dangerous if unnoticed:**
- `UserAccountAutoLiq.flattenTimestamp` (spec description: **"Flatten & Cancel"**) — a
  user-set clock time at which Tradovate exits positions **and cancels all working orders**
  (`https://tradovate.zendesk.com/hc/en-us/articles/115009654847`). This is a genuine
  broker-held EOD safety net for the tick engine — worth adopting deliberately as a backstop
  under our own 15:45 ET cutoff, and worth *checking* in case one is already set on the
  account, since it would silently wipe a watch book.
- Daily / weekly loss limits: on trigger *"your working orders will be canceled and your
  position will be liquidated"*. Same entity also exposes `trailingMaxDrawdown`,
  `dailyLossAutoLiq`, `weeklyLossAutoLiq`, `dailyProfitAutoLiq`, `weeklyProfitAutoLiq`.
- There is **no fixed clock-based firm auto-liquidation** — Tradovate's auto-liq is
  margin/loss-driven and discretionary (`https://www.tradovate.com/liquidation-policy/`;
  $25 first liquidation, $50 subsequent).

🚨 **`Suspended` is a trap for our slot-occupancy invariant.** An OCO leg, a time-released
order, or an overnight GTC sitting `Suspended` is *not* `Working` but is very much alive.
Any reconciliation that treats `ordStatus !== "Working"` as "no live order" will
double-place. Our `_reconcileAndSnapshot` and `cancelAllOrdersForContract` both need
auditing against the full 11-value `ordStatus` enum before GTC or OCO is used.

### 5.4 Contract rollover

- **No automatic order migration.** Working orders on the expiring contract are not rolled.
  Combined with the repo's standing rollover rule (CLAUDE.md: force-close and re-level at
  symbol change), any working order on an expiring contract must be explicitly cancelled and
  re-placed on the new front month by us.
- **GTC orders die with the contract**: GTC *"will continue to work until the order is
  filled, canceled, or the contract expires."* **Whether Tradovate emits an explicit
  `Canceled`/`Expired` event to the WebSocket at that moment is UNCONFIRMED — do not rely on
  it. Reconcile by symbol.**
- Two dedicated failure codes fire as expiry approaches: **`LiquidationOnlyBeforeExpiration`**
  (*"Liquidation only, contract is about to be expired"* — new opening orders refused) and
  **`BackMonthProhibited`**. Community/vendor reports put the liquidation-only flip at
  **9:30 AM ET on expiration day**, with positions allowed to remain until the close
  (second-hand; the authoritative article is Cloudflare-blocked).
- ⚠️ **Tradovate's "Autoroll Contracts" preference moves the CHART, not your position or
  orders.** From a 2026-08-19 community post: *"tradovate flips the chart over to the new
  contract by itself. it does not touch open positions… next order goes into the dead
  contract."* (`https://community.tradovate.com/t/12801`).
- `/contract/rollcontract` and `/contract/rollcontracts` endpoints exist with
  `RollContractResponse` schemas, but their semantics are **UNCONFIRMED** — no prose in the
  spec. Worth a look before hand-rolling the logic.
- Default entitlement is front month + next active back month; more requires a Trade Desk
  request.

### 5.5 Tags and attribution

All three tag fields are `maxLength: 64` (yes, including `customTag50`). What matters most
is **which entity each one persists on**, verified against the vendored spec:

| Field | Accepted on | **Readable back from** |
|---|---|---|
| `text` | `PlaceOrder`, `PlaceOSO`, `PlaceOCO`, `ModifyOrder`, `RestrainedOrderVersion` | **`OrderVersion`** |
| `clOrdId` | same, plus `CancelOrder` | **`Command`** |
| `customTag50` | same, plus `StartOrderStrategy`, `LiquidatePosition(s)` | **`Command`**, `OrderStrategy` |

🚨 **None of the three appear on the `Order` entity or on `Fill`.** Verified:
`Order` = `{id, accountId, contractId, spreadDefinitionId, timestamp, action, ordStatus,
ocoId, parentId, linkedId, admin}`; `Fill` = `{id, orderId, contractId, timestamp,
tradeDate, action, qty, price, active, finallyPaired}`. **To recover a watch id on a fill you
must join `fill.orderId → orderVersion` (for `text`) or `→ command` (for `clOrdId`).** With
one working order at a time this never mattered; with 13 it is the whole attribution path,
and it must be built before N>1 goes live.

⚠️ **`ExecutionReport.text` / `CommandReport.text` are a different field** — `maxLength: 8192`,
carrying exchange/broker reject text. Do not confuse it with the 64-char order `text`.

`customTag50` is unusable in practice (CME rejects it as an unregistered Tag50). Round-trip
of `text` and `clOrdId` is **already proven on demo** by
`scripts/test-tradovate-tagging.js`, which reads back via `GET /orderVersion/deps` and
`GET /command/deps` — exactly the joins described above. Allowed characters are
UNCONFIRMED (no `pattern` in the schema); assume printable ASCII, no delimiters or newlines.

For the tick engine, `text` = watch id is the right call: it lands on the OrderVersion,
survives modifies, and `_recoverFromOrderText` (`tradovate-connector.js:1507`) already
reconstructs attribution from it after a restart. `(account, strategy, symbol)` cannot
disambiguate 13 orders; the tag can.

---

## 6. PickMyTrade (prop-account route)

`/home/drew/projects/slingshot-services/shared/connectors/pickmytrade-connector.js`

Payload built by `_buildOrderPayload` (line 431):
```json
{ "symbol": "MNQ", "data": "buy", "quantity": 1, "price": 23400.0,
  "order_type": "LMT", "sl": 23380.0, "tp": 23450.0, "token": "…",
  "account_id": "…", "trail": 1, "trail_trigger": 22, "trail_stop": 6 }
```

| Watch shape | PMT |
|---|---|
| Limit entry | ✅ `order_type: "LMT"` |
| Market entry | ✅ `order_type: "MKT"` |
| Stop entry | ❌ **explicitly rejected** at line 224 → `stop_entry_unsupported` |
| StopLimit entry | ❌ no mapping — falls through to `LMT` and places a plain limit. **Silently wrong**: only `Market` maps to `MKT`, everything else maps to `LMT`. |
| Attached SL/TP | ✅ as `sl`/`tp` scalars (not real OSO legs) |
| Trailing stop | ✅ `trail` / `trail_trigger` / `trail_stop` |
| OCO / straddle | ❌ no concept |
| N concurrent orders | ❌ no order-id model at all |
| Cancel one order | ❌ `cancelOrder` returns `{skipped: true}` (line 305); only `cancelBySignalId` works, sending `data: "close"` for the whole **symbol** |
| Modify entry price | ❌ only `modifyStop` (sl) exists |
| GTD / activationTime | ❌ not in the payload |

**Verdict:** PMT routes roughly the 2021-era subset of the Watch vocabulary — one resting
limit with a bracket. It cannot route the tick engine. Two consequences:

1. Tick-engine strategies must be **excluded from PMT routing**, not degraded onto it,
   because the StopLimit degradation is silent. Add an explicit `StopLimit` reject next to
   the existing `Stop` reject at line 224.
2. The prop-firm path stays on the bar-close book (PCC / Monday / gap-fade), unaffected by
   this design (DESIGN.md open question #4).

---

## 7. Demo-account verification tests

Prereqs are already in place: `TRADOVATE_DEMO_URL` (`https://demo.tradovateapi.com/v1`) and
`TRADOVATE_DEMO_ACCOUNT_ID` in `shared/.env`, and **`scripts/test-tradovate-tagging.js` is a
working auth + place + read-back + cancel harness** — clone it per test rather than starting
from scratch. Run against a quiet market so resting orders don't fill. Record
`failureReason` + `failureText` verbatim, and read status back from `GET /order/item?id=`
and `GET /orderVersion/deps`.

**T1 — `activationTime` semantics.** *(highest value: unlocks §3.5 entirely)*
Place a Buy Stop 100 pts above market with `activationTime` = now + 3 min, `timeInForce:
"GTD"`, `expireTime` = now + 8 min.
*Pass:* `ordStatus` is `Suspended` until the activation instant, then `Working`, then
`Expired` at `expireTime`.
*Fail:* immediately `Working` → arm windows stay in software.

**T2 — Opposite-side StopLimit.** *(blocks `pattern-retest-long`)*
`{action:"Buy", orderType:"StopLimit", stopPrice: mkt+50, price: mkt−20}`.
*Pass:* `orderId` returned, `ordStatus: Working`.
*Fail:* `failureReason: "InvalidPrice"` → the retest-long shape must be synthesized as
Stop-armed software placement of a limit, and its edge estimate needs re-deriving with that
latency. **Fix §1.4-1 first, or call the API directly — our connector throws before it
sends.**

**T3 — OCO of two Stops (the straddle).** *(most important open item; unlocks §3.4)*
`POST /order/placeoco`, primary Buy Stop at mkt+50, `other` Sell Stop at mkt−50 — i.e. both
legs on the *correct* side of the market, which is what the two forum failures never tested.
*Pass:* `{orderId, ocoId}` both non-null, both legs `Working` in `GET /order/list`. Then
cancel one and confirm the other auto-cancels.
*Fail:* `failureReason: "InvalidPrice"`, `failureText: "Wrong OCO combination"` → straddles
are software.

**T4 — Working-order margin and exposure accounting.** *(sizes §5.2, gates fvg-bear)*
First read `GET /userAccountPositionLimit/items` and `GET /userAccountAutoLiq/…` — check
whether a `flattenTimestamp` is already set, which would silently wipe a watch book.
Snapshot `MarginSnapshot` (`totalUsedMargin`, `positionMargin`, `fullInitialMargin`). Place
13 Sell Limits, 1 lot each, 20 pts apart above market. Re-snapshot.
*Measure:* `totalUsedMargin − positionMargin` before vs after — that delta is the
working-order margin, and it settles the last open question in §5.2 empirically.
*Pass:* all 13 `Working`.
*Fail:* an order is rejected → note **which N**, and capture `failureText` verbatim (margin
rejections do **not** have a `failureReason` enum value — §5.2). That N is the account's
real ceiling and must be raised before fvg-bear can run.
Repeat once after 16:45 ET to see the full-initial-margin regime change.

**T5 — GTC across the session break and the weekend.** *(settles §5.3)*
Part A (weeknight): at ~16:30 ET place two far-from-market Limits, one `timeInForce: "GTC"`,
one `"Day"`. Check `GET /order/list` at ~18:30 ET.
*Expect:* Day → `Expired`; GTC → `Suspended` at 17:30, back to `Working` after the reopen.
Part B (weekend): leave a GTC resting over Friday 16:00 CT and check Sunday evening. This is
the part that is **contradicted by CME's Good-Till elimination rule** — do not skip it.
Also confirm our `_reconcileAndSnapshot` classifies a `Suspended` order as live, not absent.

**T6 — Modify cadence before penalty.** *(sets the §3.8 rate budget — do this LAST)*
Place one working Limit. Modify its price by 1 tick in a loop, resending `orderQty`,
`orderType` **and `timeInForce`** each call (§2.7), and logging every response *plus* the
resulting `commandStatus` / `executionReport` — not just the HTTP 200.
Ramp 1/s → 2/s → 5/s, 60 s per step. Stop at the first `p-ticket`, 429, or
`AnotherCommandPending`.
*Record:* the rate each first appears at, and the `p-time` value. Per §2.9 the true limit is
variable, so treat the result as an order of magnitude, not a constant — and design the
engine to back off adaptively rather than to run at whatever number this returns.
🚨 **Abort the instant a `p-ticket` appears.** Two tail risks make this the most dangerous
test here: `p-captcha` is a one-hour credential lockout with no programmatic recovery, and
exceeding the hourly budget can leave orders **frozen and un-cancellable except via the web
UI** (§2.9). Run it on demo, with nothing else live on the account.

**T7 — OSO with a Stop primary.** *(schema says yes; cheap to confirm)*
`POST /order/placeoso`, primary `{action:"Buy", orderType:"Stop", stopPrice: mkt+50}`,
`bracket1` Sell Stop, `bracket2` Sell Limit.
*Pass:* `orderId` non-null and both children appear in `GET /order/list` (do **not** rely on
`oso1Id`/`oso2Id` — §2.4). Confirms `hs-top` can rest fully bracketed.

**T8 — `MIT` and `pegDifference`.** *(exploratory)*
Place an `MIT` and a standalone `TrailingStop`; inspect the resulting `OrderVersion` to learn
which field carries the trail distance and whether MIT's `orderType` round-trips correctly
(the NinjaTrader bug report suggests it may not). Skip `QTS`.
Do **not** bother enumerating `orderStrategyType` — `2` is the only valid value (§2.6).

---

## 8. Open items this document could not settle

| Unknown | Impact | Test |
|---|---|---|
| Does `activationTime` gate the arm on placement? | Whole arm-window class moves broker-side | T1 |
| Is an opposite-side StopLimit accepted? | `pattern-retest-long`'s edge | T2 |
| Is a correct-side two-Stop OCO accepted? | All straddle Watches | T3 |
| How much margin does a working order actually hold, and what is our ceiling? | Hard cap on concurrent watches | T4 |
| Actual request/modify rate ceiling | Re-pricing loop design; `p-captcha` = 1 h outage; frozen orders | T6 |
| Does GTC survive the weekend (CME GT elimination)? | Whether voids can be broker-held past Friday | T5 |
| `Suspended` handling in our reconciler | Double-placement risk | T5 |
| Concurrent running-order-strategy cap (numeric) | Only if using `startOrderStrategy` at scale | avoid; prefer `placeOSO` |
| Does Tradovate emit a cancel event when a contract expires? | Rollover reconciliation | reconcile by symbol regardless |
| `pegDifference` semantics; `MIT` reliability | Possible extra primitives | T8 |
| `QTS` semantics | — | none; in the enum, zero documentation anywhere. Do not use. |
| `/contract/rollcontract` semantics | Rollover automation | read vendored spec + demo probe |
| `modifyOrderStrategy` `command` vocabulary | Trailing-strategy edits | undocumented free-form string ≤1024 |
| Tag allowed-character set | Watch-id encoding | no `pattern` in schema; assume printable ASCII |
| Exact liquidation-only window before expiry | Rollover timing | support article is Cloudflare-blocked |

## 9. Recommended next actions

1. **Fix §1.4-1 and §1.4-2 before anything else.** `StopLimit` cannot reach the broker at
   all, and `modifyBracketStop` can convert a live Stop into a Limit. Both are small edits.
2. **Wire `failureReason` + `failureText` into the client** (§1.4-4). Every test in §7 is
   near-useless without it, and margin rejections are text-only.
3. **Run T1, T2, T3** — three cheap tests that between them decide how much of the Watch
   vocabulary is broker-holdable. Everything else in the design flows from their answers.
4. **Re-key `pendingOrders` and `hasOpenOrPending` by watch id** (§3.7) and build the
   `fill.orderId → orderVersion.text` attribution join (§5.5). This is the actual
   fvg-bear unblock; the broker was never the constraint.
5. **Settle the fvg-bear sizing question** (§3.7) — 13 independent theses or 13 alternatives?
   — before writing any OCO code, since the answer may make OCO unnecessary.
