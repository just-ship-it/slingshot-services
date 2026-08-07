# JV-ICT Mechanical Strategy Spec (v1)

Deterministic translation of the JV Trading "Unlock The Market" M/W sweep-shift-retest model
(see `01-METHODOLOGY.md` for the faithful extraction with page cites). Computable purely from
OHLCV (1s/1m and causal aggregations); no future information at any decision point.

Instrument: NQ futures (raw contract prices, `filterPrimaryContract()`), 1 contract base.
All clock times ET.

---

## 0. Parameters (defaults; sweepable unless marked fixed)

| Param | Default | Meaning |
|---|---|---|
| `TF_ENTRY` | 15m | timeframe for structure/model detection (book: 5/15/30m are entry TFs) |
| `TF_BIAS` | 1D | daily open / PDH / PDL source (fixed) |
| `PIVOT_N` | 2 | fractal half-width for candidate swings |
| `FIB_ENTRY_PCT` | 0.705 | limit-entry retracement ("Optimal") |
| `FIB_BAND` | [0.50, 0.79] | valid retest band (Discount..Premium) |
| `REQUIRE_ZONE_CONFLUENCE` | true | require IMB or OB overlap with fib band |
| `STOP_BUFFER_TICKS` | 4 | hard stop beyond the sweep extreme (1 pt) |
| `TARGET_MODE` | `leg_low` | `leg_low` (0% fib) vs `external` (next liquidity) |
| `BIAS_GATE` | `daily_open` | `daily_open` \| `none` |
| `SESSION_WINDOW` | 09:30–15:30 entry, flat 15:45 | trading window |
| `ORDER_TTL_BARS` | 24 | cancel unfilled entry after N entry-TF bars (6h at 15m) |
| `MAX_STOP_PTS` | 50 | skip setup if stop distance exceeds this (risk-cap proxy) |
| `SWEEP_LEVELS` | swing+PDH/PDL | which highs/lows count as sweepable liquidity |
| `MAX_CONTRACTS` | 1 (core) / 2 (scaled) | see §8 |

Tick = 0.25. One position at a time, per product. No pyramiding beyond §8.

## 1. Data & aggregation

- Base feed: 1s OHLCV (fills, stops, targets — per repo mandate). 1m bars aggregate to 15m
  (`:00/:15/:30/:45` boundaries), 1H, 4H, and 1D sessions.
- Daily session boundary: 18:00 ET Globex open. Thus:
  - **Daily Open** = first trade price at/after 18:00 ET of the prior calendar evening
    (the current trading day's open).
  - **PDH/PDL** = high/low of the *previous completed* 18:00→17:00 trading day, wicks included.
  - **Weekly Open** = Sunday 18:00 ET open. (Used only if `BIAS_GATE=weekly_open` variant.)
- All structure logic runs on **closed** `TF_ENTRY` bars only. A level "breaks" only on bar
  CLOSE beyond it (book pp. 15, 33). Wick-throughs never change structure state; they DO count
  for sweeps (book p5: wick-off behavior) and for order fills (1s).
- Contract rollovers: force-flat any open position and reset all state (structure lists, zones,
  pending orders) at the roll; re-seed swings from post-roll bars only.

## 2. Swing (pivot) definitions

On closed `TF_ENTRY` bars:

- **Candidate swing high** at bar `i`: `high[i] > high[i±k]` for all `k = 1..PIVOT_N`
  (strict; ties → not a pivot). Confirmed at close of bar `i + PIVOT_N` (causal lag).
- **Candidate swing low**: mirror with lows.
- Maintain ordered lists `swingHighs[]`, `swingLows[]` (price, barIndex, bodyHigh/bodyLow where
  body = max/min(open, close)).
- A swing high is **broken** when a later bar CLOSES above its price; a swing low breaks on a
  CLOSE below. Broken swings stay in the lists (they become historical liquidity/targets) but
  are no longer "unswept".

This is the mechanical stand-in for the book's causal swings ("the low that caused the new
high", p10–13): at the moment a swing high is exceeded, the most recently confirmed swing low
IS the low that caused that break, and vice versa.

## 3. Zone definitions

- **Imbalance (IMB / 3-bar wick gap)** on `TF_ENTRY` (book p19 "gap between wicks"):
  - Bearish IMB at bar `i` (usable for shorts): `low[i-1] > high[i+1]`.
    Zone = `[high[i+1], low[i-1]]`. Exists from close of bar `i+1`.
  - Bullish IMB: `high[i-1] < low[i+1]`. Zone = `[high[i-1], low[i+1]]`.
  - An IMB is consumed (deleted) once a later bar's range fully covers it
    (`low <= zoneBottom` and `high >= zoneTop` for the opposing side is NOT required —
    delete when price *closes* beyond the far edge of the zone in the fill direction).
- **Order Block (OB)** (book p17 "the candle before that move"):
  - Bearish OB for a down-impulse ending in an MSS-down close at bar `m`: the most recent bar
    `j < m` with `close[j] > open[j]` (last up-close candle) scanning back from `m`, with
    `j` within the impulse leg (see §4). Zone = `[low[j], high[j]]` (full range, per p17 box).
  - Bullish OB: last down-close candle before the up-impulse; zone = its full range.
- **Fib retracement** (book p21, "Candle Body to Candle Body, not wicks"):
  - For a bearish (M) setup on leg from sweep-extreme bar `h` down to leg-low bar `l`:
    `fib100 = bodyHigh[h] = max(open[h], close[h])`, `fib0 = bodyLow[l] = min(open[l],
    close[l])`. `level(p) = fib0 + p * (fib100 − fib0)`.
  - Bullish mirror: `fib100 = bodyLow` of sweep-low bar, `fib0 = bodyHigh` of leg-high bar,
    `level(p) = fib0 − p * (fib0 − fib100)`.
  - Wicks are never anchors. 0% is the leg terminus, 100% the leg origin, so `p` = pullback
    depth (0.79 = "Premium", 0.705 = "Optimal", 0.50 = "Discount").

## 4. The M model state machine (short). W is the exact mirror.

States: `IDLE → SWEPT → SHIFTED → ARMED → FILLED → FLAT`.

1. **IDLE → SWEPT (liquidity sweep)** — book p23 steps 1–2.
   - Let `PH` = most recent *unbroken* confirmed swing high; if `SWEEP_LEVELS` includes PDH and
     `PDH > PH` is nearer above price, PDH is also a valid sweep level.
   - Sweep event: a `TF_ENTRY` bar with `high > level` (wick suffices; close-through also
     counts, both flavors logged for sweeping later).
   - Record `O` = most recent confirmed swing low at sweep time ("the New Low that caused the
     Shift Up", p23 step 3). Record running `NH` = highest high (and its bar) from the sweep
     bar onward ("New High that caused the Shift Down", p23 step 5; updates while price keeps
     pushing).
   - Abort → IDLE if a bar CLOSES above the swept level and then a further swing low forms
     above `O` and breaks... (no: keep simple) — abort if `O` is invalidated as "most recent
     low" by a *new* confirmed swing low forming above `O` before the MSS; then `O :=` that new
     swing low (re-anchor; the causal low tracks the latest pullback that "caused" the high).
2. **SWEPT → SHIFTED (MSS down)** — p23 step 4, p15.
   - Trigger: a `TF_ENTRY` bar CLOSES below `O.low`.
   - Freeze `NH` (sweep extreme). Define impulse leg = bars `[NH.bar .. mssBar]`, and running
     `legLow` = lowest low (and lowest body) from `NH.bar` forward, updated on each closed bar
     until the entry order is placed.
   - Timeout: if no MSS within 40 entry-TF bars of the sweep → IDLE.
3. **SHIFTED → ARMED (zone build + order placement)** — p23 step 6, p21, p17, p19.
   - Wait for the first bar after MSS whose close is above its open OR whose low is above the
     prior bar's low (first pause bar), or place immediately at MSS close (default: place at
     MSS bar close; `legLow`/fib anchors freeze at that close).
   - Build: fib over `[NH → legLow]` per §3; collect bearish IMBs and the bearish OB formed
     within the leg.
   - **Confluence gate** (default on): at least one of {bearish IMB, bearish OB} must overlap
     the price band `[level(0.50), level(0.79)]` (any partial overlap counts). Else → IDLE.
     (Encodes p23 "pieces of confluence"; the book never trades a naked fib.)
   - **Bias gate** (default `daily_open`, book p28): shorts require MSS-bar close < today's
     Daily Open. Else → IDLE.
   - **Session gate**: order may only be placed 09:30–15:30 ET. Setups completing outside the
     window are discarded (not queued).
   - Entry order: **limit SELL at `level(FIB_ENTRY_PCT)`** (default 70.5%). If a bearish IMB
     overlaps the band, snap the limit to `max(level(0.705), IMB.bottom)` — i.e., enter at the
     IMB proximal edge when it sits shallower than 70.5% but still ≥ 50% (p23 executes at the
     IMB tap; p21 optimal at 70.5%).
   - Stop (hard): `NH.high + STOP_BUFFER_TICKS * 0.25` (p23: "close above this High"; hard stop
     chosen for safety — see Ambiguity Register A7).
   - Skip if `(stop − limit) > MAX_STOP_PTS`.
4. **ARMED → FILLED / cancel**.
   - Fill simulation on 1s bars: first 1s bar after placement with `high >= limit` → filled at
     limit (repo fill rules).
   - Cancel (whichever first): (a) a `TF_ENTRY` bar CLOSES above `NH.high` (invalidated;
     p33 close-based); (b) a `TF_ENTRY` bar CLOSES below `legLow` before fill (momentum left
     without the retest — p21 "wait for retest" no longer possible at good price; the book's
     Momentum Trade continuation, p26, is explicitly out of scope for v1); (c) `ORDER_TTL_BARS`
     entry-TF bars elapse; (d) 15:30 ET.
5. **FILLED → FLAT**.
   - Target (`TARGET_MODE`):
     - `leg_low` (default): TP limit at `legLow + 1 tick` (0% fib). Geometry note: entry at
       70.5% with stop just past 100% yields ≈ 2.2R structurally.
     - `external`: TP at the nearest of {next confirmed swing low strictly below `legLow`
       (from `swingLows[]` history), PDL if below entry} — the book's "External Break Target"
       (p8); fallback `leg_low` if none exists within 2× leg height.
   - Stop: fixed at placement; never widened, never trailed (book teaches none). No break-even
     in the 1-lot core (book has no BE rule).
   - Exit walk: 1s bars chronologically from fill_ts; first side hit wins; stop is a stop-market
     (slippage per engine).
   - **EOD flat 15:45 ET** (market exit, slippage applied).
   - After exit → IDLE (state fully reset; the same sweep may not be re-traded).

**W model (long)**: mirror every comparison (sweep of swing low/PDL; MSS = close above the high
that caused the shift down; fib drawn low→high body-to-body; limit BUY at 70.5% pullback;
stop below the sweep low minus buffer; longs require close > Daily Open; TP at leg high /
external high).

Both models run concurrently; first fill wins the (single) position slot.

## 5. Pseudocode (per closed 15m bar; mirrored logic elided)

```
onBarClose(b):                      # b = closed TF_ENTRY bar
  updatePivots(b)                   # confirm pivots at lag PIVOT_N
  updateIMBs(b); expireZones(b)
  for model in [M, W]: step(model, b)

step(M, b):
  case IDLE:
    lvl = nearestUnsweptHigh()      # unbroken swing high; optionally PDH
    if b.high > lvl: state=SWEPT; O=lastConfirmedSwingLow(); NH=(b.high,b)
  case SWEPT:
    NH = maxBy(high)(NH, b)
    if newConfirmedSwingLowSince(O): O = it          # re-anchor causal low
    if b.close < O.low:  state=SHIFTED; mssBar=b
    elif barsSince(sweep) > 40: state=IDLE
  case SHIFTED:                     # acts on the MSS bar close itself
    legLow  = min(low over NH.bar..b)
    fib0    = minBody(NH.bar..b); fib100 = bodyHigh(NH.bar)
    band    = [lvl(.50), lvl(.79)]
    if not (anyBearishIMB ∩ band or bearishOB ∩ band): state=IDLE; return
    if b.close >= dailyOpen: state=IDLE; return       # bias gate
    if not inSession(09:30..15:30): state=IDLE; return
    limit = max(lvl(.705), IMB.bottom if IMB ∩ band else -inf)
    stop  = NH.high + 4*tick
    if stop-limit > MAX_STOP_PTS: state=IDLE; return
    placeLimitSell(limit, stop, tp=TARGET(legLow)); state=ARMED
  case ARMED:
    if b.close > NH.high or b.close < legLow: cancel(); state=IDLE
    if ttlExpired or afterHours: cancel(); state=IDLE
    # fills/stops/tps handled on the 1s stream, not here
```

## 6. Order & exit mechanics (fixed, engine-conformant)

- Entry: limit order, fills at exact limit on first qualifying 1s bar; no slippage.
- Stop: stop-market at stop price, slippage `stopOrderSlippage`.
- TP: limit, no slippage.
- 15:45 EOD flat: market, `marketOrderSlippage`.
- All exit evaluation walks 1s bars strictly from `fill_ts` onward (never the containing 1m/15m
  bar's earlier ticks).

## 7. Bias / filter add-ons (spec'd, default OFF, for later sweeps)

- `weekly_open` gate: also require same side of Weekly Open (p29, and p8 Step V confluence).
- `htf_structure` gate: last confirmed 1H-TF MSS direction must equal trade direction (p33 #1
  "align lower timeframe trades with higher timeframe structure").
- `inside_bar_boost` (p31): if yesterday was an inside day (range within prior day's PDH/PDL),
  allow entries in the direction of the eventual PDH/PDL break only.
- `pairs_confirm` (p33 #7): require ES 15m bar direction agreement at MSS bar. (Needs ES feed;
  OFF by default.)
- `news_blackout` (p33 #8): no order placement within ±10 min of scheduled red news. (Needs a
  calendar; OFF and unmodeled in v1.)
- PDH/PDL-only sweeps (`SWEEP_LEVELS=pdhpdl`): restrict step 1 to PDH/PDL sweeps — the book's
  "cleanest liquidity grabs" (p25). Fewer, higher-quality setups.

## 8. Position sizing

- **Core (default): 1 NQ contract, single target per `TARGET_MODE`.** The book prescribes %
  risk (0.5–1%, p33 #4) but no scaling; scaling out is NOT taught anywhere in the book, so the
  1-lot version is the faithful default.
- **Scaled variant (optional, max 2 contracts; book-compatible but book-silent):**
  - 2 contracts at the same limit. TP-A: 1 contract at `leg_low`. TP-B: 1 contract at
    `external`. After TP-A fills, runner stop stays at the ORIGINAL stop (no BE — the book has
    no BE rule; enabling BE is a sweep variant, and BE/trailing exits must take stop slippage
    per engine rules).
  - Never 3 contracts: nothing in the book motivates a third unit; cap respected.
- Risk % translation: with fixed contracts, `MAX_STOP_PTS` is the proxy for the 0.5–1% rule
  (50 pts ≈ $1,000/contract ≈ 1% of a $100k account; sweep 25/50/75).

## 9. Ambiguity Register

| # | Ambiguity | Chosen default | Alternatives | Severity |
|---|-----------|----------------|--------------|----------|
| A1 | "A+ setup" selectivity: how many confluences (OB, IMB, fib, PDH/PDL, opens, pairs) make a tradeable setup; the book aggregates them discretionarily (p23 "pieces of confluence", p8 "A+ setup") | require ≥1 of {IMB, OB} overlapping the 50–79% fib band | require both; require weekly-open confluence too; naked fib | **BLOCKING** — trade count and quality swing wildly with this choice; no book-derivable threshold exists |
| A2 | HTF bias construction: the book builds directional bias from PDH/PDL narrative + range position + opens + pairs with no combiner rule (pp. 5, 7, 28–29, 33) | single gate: side of Daily Open (p28 is the most rule-like statement in the book) | 1H structure direction; weekly open; range-break direction; no gate | **BLOCKING** — the mechanical gate is a thin proxy for the book's narrative bias; different proxies materially change which setups exist |
| A3 | Entry timeframe: "5min, 15min and 30min are fast entry timeframes" (p33) — no single TF chosen | 15m | 5m, 30m; 1H structure with 5m trigger | DEFAULTED (sweep all three) |
| A4 | Swing definition: book swings are causal, not N-bar (p10–13) | fractal `PIVOT_N=2`, close-based breaks | N=1, N=3; ZigZag %; "most recent low before break" without pivot confirmation | DEFAULTED (sweep 1–3) |
| A5 | Does the sweep (M step 2) require a close above the Previous High or only a wick? p23 labels it "Structure Shifted Bullish (Liquidity Sweep)" (suggests close), but p5 says liquidity levels "should wick off... not fully break and close through" | either counts (wick suffices) | require wick-only (close back below = cleaner sweep); require close-through | DEFAULTED (log both, filterable) |
| A6 | Entry price within the retest zone: book executes "at the imbalance tap" (p23) but the fib lesson names 70.5% "Optimal" (p21); charts show 50% and 70.5% taps | limit at max(70.5% fib, IMB bottom edge within band) | pure 70.5%; IMB midpoint; 50%; 79%; market on first 1m close back inside zone | DEFAULTED (sweep) |
| A7 | Stop semantics conflict: hard stop "close above this High" (p23) vs "you only get stopped out if the candle closes above/below your key level" (p33 #2) | hard stop at extreme + 4 ticks (conservative, prop-safe, bounded risk) | close-confirmed exit with catastrophic hard stop at 2× distance; 15m-close-based exit | DEFAULTED — but flag: close-based stops would change results materially and carry unbounded intrabar risk on NQ |
| A8 | Take-profit: never numeric in the book; "Enjoy Profits" (p23–24); structural "External Break Target" (p8) | TP at leg low (0% fib) ≈ 2.2R structural | external liquidity target; fixed 2R/3R; PDL/PDH magnet; opens magnet | DEFAULTED (two modes spec'd; sweep) |
| A9 | Session: none taught; 9:30 imagery only (p32) | entries 09:30–15:30 ET, flat 15:45 (repo live convention) | include Globex; London 03:00–05:00; first-hour only | DEFAULTED |
| A10 | Order lifetime / setup expiry: untaught | cancel on 6h TTL, opposite close beyond NH, or close beyond leg low pre-fill | no TTL; cancel on first touch of 0% | DEFAULTED |
| A11 | OB candle when the impulse has multiple opposite-color candles; body vs full range for the zone | last opposite-close candle before MSS bar; full high–low range (p17 box spans the candle range) | body-only zone; furthest opposite candle in leg; include wick-refined OB | DEFAULTED |
| A12 | Fib body anchors: "Candle Body to Candle Body" — which candle's body at each end when the extreme is a wick on one candle and the extreme body on a neighbor | body extreme of the leg: max/min(open,close) computed over the anchor bar at each end (leg-extreme bar) | body of the single highest/lowest-priced candle; highest body in a 3-bar window | DEFAULTED |
| A13 | Re-anchoring `O` (the causal low) if a newer swing low confirms before the MSS | re-anchor to the newest confirmed swing low | keep first `O`; require O = lowest low since sweep | DEFAULTED |
| A14 | News filter (p33 #8) needs an economic calendar — not OHLCV-computable | omitted in v1 | add calendar feed later | DEFAULTED (fidelity loss, noted) |
| A15 | Pairs confirmation (p33 #7) | omitted in v1 (OFF) | ES 15m agreement gate | DEFAULTED |
| A16 | Momentum Trades (p26) — a second, continuation entry model (IMB fill → break of low) | not implemented in v1; core = M/W retest model only | implement as separate strategy variant | DEFAULTED (scope) |

BLOCKING count: 2 (A1 confluence threshold, A2 bias construction). Both have defaults wired in
so the backtest runs, but results should be read as *one point in a family of strategies* the
book describes, and A1/A2 should be swept before any conclusion about "the book's edge".

## 10. Fidelity Risks (what mechanization loses)

1. **Narrative bias is the book's engine.** The trader stacks PDH/PDL reaction, range position,
   opens, and cross-market tone into a directional story before ever looking for an M/W. Our
   Daily-Open gate is a crude scalar stand-in. This is the largest infidelity (A2).
2. **Setup grading.** "These are the beautiful plays you should aim for. This is an A+ setup"
   (p8) implies most mechanical matches would be *rejected* by the author. Any mechanical PF
   likely underestimates the curated-discretion win rate and overestimates trade count (A1).
3. **Close-based stop philosophy** (p33) cannot be faithfully implemented with bounded risk;
   the hard stop will get "wicked out" of trades the author would have held (A7).
4. **Level selection is curated.** The book marks "the highs and lows that matter" (p7) — a
   human picks obvious, clean levels; fractal pivots generate many mediocre ones. PDH/PDL-only
   sweep mode (§7) is the closest low-noise approximation.
5. **News and correlation context** (p33 #7–8) are omitted in v1; the author would stand aside
   in conditions the algo will trade.
6. **Target ambiguity**: "Enjoy Profits" braces in the charts show holding well past the broken
   swing — a discretionary trail the book never articulates. Both spec'd target modes are
   conservative relative to the drawn examples.
7. **Chart-example survivorship**: all book charts are idealized/hand-drawn; no losing example
   is shown anywhere, so there is no book-sourced information about how the author manages
   failures beyond stop placement.
