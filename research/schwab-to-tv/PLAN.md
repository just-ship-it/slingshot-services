# Migrate market data: Schwab → TradingView

## Why
Schwab's refresh token has a **hard 7-day life** (`schwab-client.js`: `const remainDays = 7 - ageDays`)
and renewing it needs an interactive browser login. That is a Schwab OAuth policy, not a bug we can
engineer around — any Schwab-fed system needs a human every week. In the 4-week shadow window it
produced `schwab_auth_expired` ×14 on 07-27 alone (plus 08-07, 08-14 ×5), `schwab_streamer_down` ×4,
and persistent `schwab_standby` (two data-service instances). TradingView's token refreshes
programmatically (`tradingview-auth.js: refreshToken`), the account has full real-time futures data,
and the WS instability that caused the May migration was subsequently fixed (session-ID init +
keep-alive) and has been stable since.

## What Schwab actually supplies today
| use | still needed? |
|---|---|
| real-time futures + equity quote/candle stream | **yes — this is the feed** |
| historical candle seeding (PCC / gap-fade ATR) | **yes** |
| options chains → GEX / VEX / CEX | no — strategies retired |
| short-DTE IV | no — strategy scrapped |
| TRIN/COR conditioner fetch | no — `conditionerMode: 'off'` live |

So only the feed and seeding matter; everything else is dead weight that can go with it.

## ⚠️ The one real risk: bar-close latency

`candle-manager.js` supports both feed semantics, but they differ in WHEN a close is published:

- **Schwab** (`quote.barClosed`) — delivers one finalized 1m bar ~2s after the close → publishes immediately.
- **TradingView** (forming bars) — the newest bar is still forming, so the close is only confirmed
  **once the NEXT bar's timestamp lands**, i.e. up to a full minute late.

All three live strategies fire on a specific bar close (PCC 15:00 ET, Monday 09:28, gap-fade 09:30),
so a naive revert makes every one of them a minute late.

**This is not hypothetical — it already happened.** The shadow audit found PCC stamping 15:01:02 ET
from 07-24 → 08-05 and 15:00:03 from 08-11. The late stamps are the forming-bar signature.

### The fix (required, and worth doing regardless)
Close a forming bar on the **wall clock** rather than on arrival of the next bar: when the clock
passes the bar boundary, publish the forming bar as closed. This removes the one-bar lag from the TV
path entirely and is a small, contained change in `candle-manager.js`. It also protects against a
quiet-market gap where the next bar simply never arrives.

## Change set (all feature-flagged, instantly reversible)
1. `data-service/src/config.js` — add `MARKET_DATA_SOURCE` (`schwab` | `tradingview`, default `schwab`).
2. `data-service/src/main.js` — when `tradingview`: open the TV WS (it is currently instantiated at
   L153 but deliberately never connected) and wire `quote` / `history_loaded` / `reconnected` to the
   SAME handlers Schwab uses (L178-196). The event surfaces already match 1:1; TV additionally emits
   `candle` and `lt_levels`. Skip `schwabStreamer.connect()` (L599, L1270) in this mode.
3. `data-service/src/candle-manager.js` — wall-clock bar close for forming feeds (above).
4. Leave `SCHWAB_ENABLED=false` once stable; that also removes the `schwab_standby` double-instance alerts.

## Validation before cutover (must all pass)
- Bar-close timing: PCC's decision bar must publish within ~2s of 15:00:00 ET, matching the Schwab path.
- Candle parity: run both feeds simultaneously for 2 sessions, diff 1m OHLCV bar-for-bar.
- Seeding: PCC/gap-fade ATR14 seeds correctly at startup (the audit showed re-seeds landing at ~09:31
  on Schwab reconnects — verify TV seeds before 09:28).
- LT monitors keep working (they already use TV WS; watch the one-series-per-session limit, commit b8ab8f0).
- One data-service replica only (`schwab-streamer-single-instance` memory applies to any streamer).

## Open questions for Drew
- Is data-service currently running 2 replicas? The `schwab_standby` alerts say yes; that must go to 1.
- Does anything still consume GEX/VEX/CEX or short-DTE IV in a way I have not found? If not, Schwab
  can be turned off entirely rather than left as a fallback.

---

## Implementation status — 2026-08-20

### Config flags (all default to the slim path; no env change needed to get it)

| flag | default | effect |
|---|---|---|
| `MARKET_DATA_SOURCE` | `tradingview` | `schwab` restores the legacy feed verbatim |
| `GEX_ENABLED` | `false` | master switch for the whole options/exposure/GEX/IV stack |
| `LT_MONITORS_ENABLED` | `false` | LT/LS Pine study WS sessions |

No code was deleted. Every retired subsystem is behind a flag and restores by flipping it.

### What now runs in data-service under the defaults

Runs: TradingView WS (1m main series + 1h/1D history sessions), the TV JWT
auto-refresh schedule, the 1s forming-bar close sweep, candle manager, HTTP API.

Skipped: `initializeTradierService()` (this is the *Schwab* options client — the
`Tradier*` naming is pure legacy), `initializeGexCalculators()`, `SchwabStreamer`
(not even constructed), `createHistorySessions()` (self-gates on the null streamer),
LT monitors, `scheduleGexRefresh()`, `scheduleRTHOpenRefresh()`.

### Two defects found and fixed while wiring the cutover

1. **1h/1D history was never seeded on the TV path.** `connect()`/`startStreaming()`
   only establish the main 1m series; the hourly and daily bars are separate chart
   sessions. Nothing created them, and `preclose-continuation` derives ATR14 from the
   prior 14 full-session **daily** ranges (min 10) — so PCC would have produced no ATR
   and never traded. Added `createTvHistorySessions()` (60→300 bars, 1D→10 bars per
   symbol), called after connect **and** after every reconnect: both TV reconnect paths
   restart only the main series, and `reconnectWithNewToken()` clears `chartSessions`
   outright. Re-seed is debounced by the existing `RESEED_DEBOUNCE_MS` (2 min) so a flap
   can't trigger a DATA_READY storm.

2. **The manual token-update path would have stranded the primary feed.** Written when
   Schwab carried market data, it deliberately called `stopTokenRefreshSchedule()` and
   skipped `reconnectWithNewToken()`. With TV primary that stops auto-refresh and leaves
   the live WS on the old token. Now branches on `MARKET_DATA_SOURCE`.

### Corrections to earlier assumptions

- **data-service is already 1 replica** (`scaling_strategy.manual.instanceCount = 1`,
  verified via the Sevalla API). The earlier read that two replicas were running is
  wrong. The `schwab_standby` alerts are consistent with old+new pods overlapping during
  rolling deploys, which is expected and benign.

### Known tradeoff, needs a call before deploy

Disabling LT monitors removes the LT level overlay from the **dashboard chart**
(`ltLevels` / `lsStatus` props on `GexChart`). No enabled strategy consumes `lt.levels`,
so this costs nothing in execution, but it does remove discretionary context from the
chart. Set `LT_MONITORS_ENABLED=true` to keep the overlay while everything else stays slim.

### Dashboard (separate repo, NOT deployed)

`PlatformStatus.jsx` and `SignalGeneratorStatus.jsx`: removed the Schwab/CBOE/Hybrid-GEX
badges, detail rows, and the Schwab OAuth token form (−202 lines, +5). Both files parse
clean under `@babel/parser` with the jsx plugin.

`GexChart` was deliberately left in place — despite the name it is the **main price
chart**, not a GEX panel; it simply renders without overlays now. `IVSkewPanel` already
self-hides behind the disabled `iv-skew-gex` strategy.

That repo shows all 49 files as modified from WSL CRLF churn; only the two touched files
should ever be staged.

### Still to validate before cutover

- Bar closes land within ~2s of the wall clock (unit tests cover the sweep; needs a live session).
- Dual-feed candle parity for 2 sessions.
- ATR/daily seeding actually lands before 09:28 ET.
- TV one-series-per-session limit under 1m + 1h + 1D concurrently.

---

## Deployed 2026-08-21 — outcome

`8b7404f` (cutover) then `ae88732` (session-repair fix). data-service only; dry run
confirmed no other service was touched. master/production were identical beforehand, so
nothing else rode along.

### Verified live from runtime logs

- TV connected, streaming `CME_MINI:NQU2026`; quotes flowing.
- **1m 500 / 1h 300 / 1D 10 all seeded** — the 1D seed is the one PCC's ATR14 depends on.
- Zero schwab/cboe/gex/tradier lines after boot; LT monitors logged as disabled.
- Bar-close timing good: `00:37:00` bar published `00:38:00` (~1s after close), via the
  new forming-bar sweep.

### 🚨 Landmine found on the first production boot

`reconnectWithNewToken()` **clears `chartSessions`**. The startup JWT auto-refresh fires
~7s after start (even at a healthy 207m TTL) and — now that the token path reconnects the
WS — that wiped the 60m/1D sessions created seconds earlier. The reconnect handler tried
to rebuild them and the 2-minute debounce refused:

```
00:32:39  Created 1D history session for CME_MINI:NQU2026 (TV)
00:32:46  TradingView WebSocket DISCONNECTED - Code: 1005
00:32:47  Skipping TV history re-seed (last 9s ago)
```

That would have recurred on **every boot**, leaving 1h/1D permanently dead. The seeded
buffers survive the wipe, so PCC still had its 10 daily ranges — luck (the damage lands
after seeding), not design.

Fix (`ae88732`): `createTvHistorySessions()` is idempotent by presence — it re-creates
only sessions actually missing from `chartSessions`. Confirmed in production:

```
00:37:54  Skipping TV history re-seed (last 9s ago) — checking for dropped sessions
00:37:54  Creating history session for CME_MINI:NQU2026 @ 60m   <- repaired
00:37:55  Creating history session for CME_MINI:NQU2026 @ 1Dm   <- repaired
00:37:59  Skipping TV history re-seed (last 5s ago) — checking for dropped sessions
          (no creation — idempotent no-op)
```

**Rule for anyone touching this path:** any code that reconnects the TV WS must assume
`chartSessions` is gone afterwards and re-assert the 1h/1D sessions. A debounce guarding
DATA_READY storms must never gate session *repair*.

### Still unvalidated

- **TV daily-bar date labeling** — TV labels futures daily bars by session-OPEN date. The
  10 daily bars are seeded but their dates have NOT been checked against what PCC's
  day_range accumulation expects. First place to look if PCC misbehaves with ATR present.
- Dual-feed parity never ran; deploying replaced the feed outright, so the open is the
  validation run.
- Revert lever: `MARKET_DATA_SOURCE=schwab` (no redeploy needed), though Schwab's token
  will likely need a manual re-auth.

---

## OPEN ISSUE: TV closes the socket every ~65-75s (unresolved 2026-08-21)

Since the cutover, TV closes the WS with **code 1000 (clean, server-initiated)** at a
consistent 65-75s uptime, while the connection is demonstrably healthy at the moment of
close: `quoteAge 0-2s, heartbeatAge 5-9s, jwtTTL 236m+`. Reconnect takes ~5s and the
client re-seeds 500 1m bars, so bar data stays accurate and candle.close kept publishing
at 0-2s lag throughout. Functional, but not something to run a book on.

### Ruled out (do not re-investigate)

| candidate | evidence against |
|---|---|
| multi-series / session limit | flaps identically at `chartSessions=1` and `=3` |
| JWT expiry | TTL 236-240m at every close |
| our health monitor forcing it | forced reconnect logs `🧟 STALE`; no such line, heartbeats 5-9s fresh |
| missing client keepalive | `handleOpen()` → `startKeepalivePing()` confirmed wired to `ws.on('open')`; zero "skipped"/"send failed" warnings (the guard logs both); frame format `~m~4~m~~h~1` matches protocol |
| keepalive being wrong in general | `lt-monitor.js` uses a byte-identical keepalive and ran 14 days with 0 disconnects |
| a second data-service pod | Sevalla instance-count metric = 1 for every minute across the whole flap window; scaling is manual/1 |

Note the code comment in `tradingview-client.js` attributes a ~65-75s cut to a MISSING
client keepalive — the fingerprint matches exactly, but the keepalive is verifiably
present and running, so the comment is a red herring here.

### Leading remaining hypothesis (needs Drew, unverified)

**Sessionid collision.** TV pins one JWT per sessionid; a second client using the same one
displaces us. `bootstrapTradingViewSession()` warns about exactly this and says to
bootstrap from an incognito login, NOT the daily-driver tab. Only data-service opens a TV
socket in prod (LT monitors are off), so any competitor is external — i.e. a browser
session on the same login. This is the leading candidate mainly *because* every internal
cause above is eliminated, not because it has direct evidence.

Test: re-bootstrap the session from an incognito window (or a second TV account) and see
whether the 70s cycle stops.

### Side effect to watch

The reconnect fix force-rebuilds 1h/1D on every reconnect. Combined with a ~70s flap that
is ~3 DATA_READY publishes per 70s into signal-generator. Memory warns a DATA_READY storm
can freeze the strategy engine. Tolerable at this rate, but it disappears once the flap is
fixed — and it is a reason to fix the flap rather than live with it.

### A/B RESULT 2026-08-21 03:15-03:20 — cause is client-side, NOT environmental

Ran both TV sockets simultaneously (`LT_MONITORS_ENABLED=true`) in ONE process, ONE
account, ONE cookie jar — the historically normal pre-Schwab topology.

| socket | connects | disconnects | data |
|---|---|---|---|
| `lt-monitor` | 1 (03:15:38) | **0** | LT levels flowing continuously |
| `tradingview-client` | — | **4** (03:15:43, 03:17:04, 03:18:19, 03:19:29) | flowing but cycling ~70s |

**This kills the sessionid-collision hypothesis** (and account limits, credentials, and any
TV-side policy change): a collision or account-level cap would hit both sockets. The cause
is specific to `tradingview-client`'s post-handshake behavior.

Also verified identical between the two clients, so NOT the cause:
- URL builder — byte-identical (`prodata`, `from=chart/4NTS38Zt/`, `date`, `type=chart`, `auth=sessionid`)
- Handshake headers — byte-identical (Origin, UA Chrome/148, Accept-Language, Accept-Encoding, Cookie)
- Handshake messages — `set_auth_token`, `set_locale`, `quote_create_session`,
  `quote_set_fields`, `quote_fast_symbols`; neither hibernates, neither tears down sessions

Health is perfect right up to the cut, with no TV-side error:
```
03:18:09  ✅ HEALTH: Connection active - last quote 0s ago, authState: authenticated
03:18:19  ❌ DISCONNECTED - Code: 1000   uptime=69s  chartSessions=3
```

### Leading candidate: the extra 1h/1D chart sessions

Every steady-state cut carries `chartSessions=3` (1m + 60m + 1D) created within ~1s of
connect. `lt-monitor` runs 1-2 chart sessions and survives. The documented cap family is
exactly chart-session churn ("rapid create+delete ... trips TV's polling-cap ~63-67s").
The main client's historically stable config had ONE chart session per symbol; 1h/1D
sessions were an ai-trader add-on.

**Counter-evidence (unresolved):** the 00:34:06 cut had `chartSessions=1` and still died at
80s — marginally longer than the 59-75s seen at 3 sessions, but still cut. Either the cap
has a per-session cooldown that outlives one reconnect, or session count is not the trigger.

**Next test (needs a deploy):** env-gate `createTvHistorySessions()`, run with it off, and
watch whether uptime clears ~80s. If it stabilizes, the fix is to fetch 1h/1D history over
a SEPARATE short-lived connection (as a browser would) and keep the persistent market-data
socket at exactly one chart session — NOT to delete sessions on the live socket, which is
itself a documented trigger.

**Do not disable history sessions permanently as the "fix":** preclose-continuation needs
the 10 daily ranges seeded or it never produces an ATR and never trades.

### Elimination complete 2026-08-21 03:20-03:55 — and the fix is already running

All tests below ran with `lt-monitor` alongside in the SAME process/account/cookies.
**lt-monitor: 0 disconnects across ~38 minutes. Market-data socket: cut ~32 times.**

| hypothesis | test | result |
|---|---|---|
| sessionid / account / credentials | both sockets, one account | **DEAD** — LT stable, other cuts |
| WS URL + handshake headers | source diff | **DEAD** — byte-identical |
| client keepalive not reaching TV | added `pingsSent` to diagnostic | **DEAD** — `pingsSent=7` at `uptime=75s` |
| extra 1h/1D chart sessions | `TV_HISTORY_SESSIONS=none` | **DEAD** — still cut at 60-75s with `chartSessions=1` |
| missing `create_study` | attached `Volume@tv-basicstudies-241` | **DEAD** — attached clean, still cut at 75s/69s |
| `NASDAQ:QQQ` on the quote session | `quotes=[]` | **DEAD** — still cut at 75s/70s |

Caveat on the study test: no `study_error` was logged, but this client never parses
study output, so "attached and didn't help" cannot be fully distinguished from "never
attached". Treat as probable-dead, not certain.

Still untested: series bar count (LT 700 vs 500 — not env-settable, `options` beats env)
and the `from=` chart slug (both clients claim the SAME `chart/4NTS38Zt/`; `TV_FROM_CHART`
now exists but needs a second real chart slug Drew owns).

### ★ The pragmatic fix: lt-monitor ALREADY streams NQ 1m OHLCV

`LT_NQ_SYMBOL = CME_MINI:NQU2026`, `LT_NQ_TIMEFRAME = '1'`, series created with **700
bars**, and `du` / `timescale_update` are already parsed (lt-monitor.js:386,410). It emits
only `lt_levels` / `ls_status` — the OHLC bars are decoded and discarded.

So the "merge the two clients" question answers itself: the stable socket is already
carrying the exact feed we need. Emitting those bars as `candle` / `quote` events is a far
smaller change than porting OHLCV onto the capped client, and it sidesteps the cap
entirely rather than continuing to bisect it.

Open risks for that path:
- 1h/1D history for preclose-continuation's ATR would need extra chart sessions on LT's
  socket. `chartSessions=3` was eliminated as a cap trigger, so this *should* be safe —
  but it is unproven ON LT's socket, and destabilising our only known-good reference
  would be costly. Add them behind a flag and watch.
- `price.update` currently derives from quote events; the 1m `du` stream gives the live
  forming bar, which is what the main client already uses to synthesise quotes for 1m
  sessions. Equivalent, but needs wiring.

---

## ✅ RESOLVED 2026-08-21 — one socket, all data, zero disconnects

`MARKET_DATA_SOURCE=lt` + `LT_EMIT_OHLCV=true` + `LT_MONITORS_ENABLED=true`.
OHLCV, LT levels and LS state all ride the LT monitor's single TradingView socket.
The separate market-data client is never opened.

```
04:36:25  OHLCV source: LT monitor socket (no separate TradingView market-data WS)
04:36:26  History loaded (LT): 700 1 candles / 25 1D candles / 300 60 candles for NQ
04:36:26  Strategy preclose-continuation (NQ) is now data-ready
04:36:26  Strategy gapup-fade (NQ) is now data-ready
```

Verified: 0 lt-monitor disconnects; **0 tradingview-client disconnects after cutover**
(last 04:27:05 = dying old pod); candle.close once per minute at ~1s lag; one duplicate
bar at 04:27:00 from two-pod rollout overlap only; 4 chart sessions (1m/15m/60m/1D)
coexisting with no `critical_error`; all 7 strategies data-ready.

The ~70s cap was never root-caused — six hypotheses eliminated (see table above), the last
untested differences being series bar count (700 vs 500) and the shared `from=` chart slug.
This route sidesteps it. Drew's own theory — TV culling duplicate claims on one chart
layout, oldest wins — remains the best unverified explanation and fits everything except
the 00:32-03:14 single-socket window (which it survives only if a browser held the claim).

### 🚨 Two long-standing bugs found, unrelated to the cutover

1. **PCC and gapup-fade could NEVER seed an ATR.** Both call
   `/candles/daily?count=atrPeriod+6` (20) and bail unless they get `atrMinPeriods+1`
   (11); every seed site requested exactly **10**. `isSeeded()` stayed false so
   `checkStrategyDataReady()` never marked them ready — they sat in "warming up" with
   "need >= — pts". Any ATR seen came from slow live `_recordDayRange` accumulation that
   every restart wiped. Fixed via `DAILY_SEED_BARS = 25` (hoisted in both files so the
   three sites cannot drift). **This explains the note that gapup-fade never fired live.**
2. **Dashboard forming candle stopped building.** `quote.candleTimestamp` is Unix
   SECONDS; `GexChart` passed it to `new Date()`, which reads a bare number as
   milliseconds → Jan 1970 → `candleTime` never matched the live bar. Masked under Schwab
   (its 1Hz L1 ticks carried no `candleTimestamp` and drove the working branch); TV's `du`
   sets it on every update, so the broken branch became the common case — chart moved
   ~1/min while the top-bar ticker updated normally. That is the top-bar/chart desync.
   Fixed in slingshot-web `02736b4` (seconds/ms/ISO all accepted).

### Follow-ups

- **slingshot-web needs `git push origin master`** (Drew, from Windows): `9591709`
  (Schwab/CBOE/GEX UI removal + GEX overlay no longer covers the chart) and `02736b4`
  (forming-candle fix).
- Sanity-check the `du` rate at the RTH open. It measured 0.7-2.0/s alongside the old
  feed; overnight it sits at 0.26-0.44/s, which tracks market activity, but the
  side-by-side comparison is gone now that the old client is off.
- `tradingview-client` is retained and reachable via `MARKET_DATA_SOURCE=tradingview`.
