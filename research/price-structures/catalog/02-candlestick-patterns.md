# 02 — Candlestick Patterns: code-ready catalog (1–5 bar OHLCV formations)

Status: research catalog, 2026-08-18. Companion to the price-structures series. Scope = every formation
detectable from OHLC(V) of ≤5 bars, with formal rules, tradable levels, known statistics, and an explicit
verdict on intraday-futures (NQ/ES 1m–1h) observability. Nothing here is a validated edge; see §9 for the
evidence verdict and §10 for the test protocol that any use of this catalog must go through (1s fills,
side-matched placebo, day-weighted reporting — per CLAUDE.md / KNOWABILITY.md).

Sources used
- Nison, *Japanese Candlestick Charting Techniques* (2nd ed. 2001) — canonical definitions and context rules.
- Bulkowski, *Encyclopedia of Candlestick Charts* (Wiley 2008) + thepatternsite.com per-pattern pages
  (103 candles; "Important Results" blocks scraped 2026-08-18: theoretical vs tested direction, %,
  frequency rank, overall performance rank; all ranks out of 103, 1 = best). Bulkowski's sample:
  US stocks, daily bars, ~4.7M candles, 1990s–2000s; "reversal/continuation %" = fraction of times price
  broke out of the pattern in the named direction and continued (breakout = close above pattern high /
  below pattern low). It is NOT a trade win-rate.
- TA-Lib 0.4/0.6 `ta_CDL*.c` (61 `CDL*` functions) + `ta_global.c` `TA_CandleDefaultSettings`.
- Morris, *Candlestick Charting Explained* (3rd ed. 2006) — the source of most TA-Lib rule choices.
- Academic: Caginalp & Laurent 1998 (Applied Math. Finance); Fock, Klein & Zwergel 2005 (J. Derivatives
  13(1):28-40) — 5-min DAX + Bund futures; Marshall, Young & Rose 2006 (JBF 30:2303-23) — DJIA daily;
  Marshall, Young & Cahan 2008 (Japan); Goo, Chen & Chang 2007 (Taiwan); Lu, Shiu & Liu 2012 (Rev. Fin.
  Econ. 21:63-68) + Lu & Shiu 2012 (Taiwan); Duvinage, Mazza & Petitjean 2013 (Quant. Finance 13(7):
  1059-70) — 5-min DJIA stocks; Chen & Tsai 2020 (Financial Innovation 6:26) — GAF-CNN pattern
  classification; Zhu, Atri & Yegen 2016 (China); Horton 2009 (US stocks).
- Crabel 1990 (NR4/NR7/ID), Brooks (*Trading Price Action* trilogy), Fuller (pin bar), Chaikin (CLV).

Notation (used in every rule)
```
O,H,L,C           bar i (the last bar of the pattern) ; O1,H1,L1,C1 = bar i-1 ; O2.. = bar i-2 etc.
body   = |C-O|                     range = H-L
up     = H - max(O,C)              lo    = min(O,C) - L        (upper / lower shadow)
bTop   = max(O,C)                  bBot  = min(O,C)
white  = C > O ; black = C < O ; color = sign(C-O)
mid1   = (O1+C1)/2                 (midpoint of prior real body)
avgB(n)= mean(body[i-n..i-1])      avgR(n)= mean(range[i-n..i-1])   avgS(n)= mean(up+lo over i-n..i-1)
ATR(n) = Wilder ATR over n prior bars ; medB(n) = median body over n prior bars
tick   = instrument tick (NQ 0.25, ES 0.25) ; T = threshold expressed in ticks
```
Every threshold in this document is written as one of the eleven TA-Lib `CandleSettings` names so the same
rule text can be compiled against either the TA-Lib defaults or the intraday-adapted scheme in §1.3.

---------------------------------------------------------------------------------------------------------

## 1. Normalization & parameterization

### 1.1 TA-Lib `CandleSettings` (defaults from `ta_global.c`, `TA_CandleDefaultSettings`)

| Setting          | RangeType | avgPeriod | factor | Meaning of the threshold `TA_CANDLEAVERAGE(x)`                          |
|------------------|-----------|-----------|--------|-------------------------------------------------------------------------|
| BodyLong         | RealBody  | 10        | 1.0    | body >  1.0 × avgB(10)  → "long body"                                    |
| BodyVeryLong     | RealBody  | 10        | 3.0    | body >  3.0 × avgB(10)  → "very long" (used by 3-line-strike, kicking-by-length etc.) |
| BodyShort        | RealBody  | 10        | 1.0    | body <  1.0 × avgB(10)  → "short body" (NB: same cut as long → every bar is one or the other) |
| BodyDoji         | HighLow   | 10        | 0.1    | body <= 0.1 × avgR(10)  → "doji"                                         |
| ShadowLong       | RealBody  | 0         | 1.0    | shadow > 1.0 × **own** body (period 0 = current bar, no averaging)       |
| ShadowVeryLong   | RealBody  | 0         | 2.0    | shadow > 2.0 × own body                                                  |
| ShadowShort      | Shadows   | 10        | 1.0    | shadow < avgS(10) (average of up+lo over 10)                             |
| ShadowVeryShort  | HighLow   | 10        | 0.1    | shadow < 0.1 × avgR(10)                                                  |
| Near             | HighLow   | 5         | 0.2    | |a-b| <= 0.2 × avgR(5)                                                   |
| Far              | HighLow   | 5         | 0.6    | |a-b| >  0.6 × avgR(5)                                                   |
| Equal            | HighLow   | 5         | 0.05   | |a-b| <= 0.05 × avgR(5)                                                  |

`TA_CANDLEAVERAGE(set, sum, i)` = `factor × (period ? sum/period : rangeOf(i))` where `rangeOf` is
RealBody / HighLow / Shadows of the *current* bar when period = 0. Averages are simple means over the
`avgPeriod` bars **strictly before** the bar being tested (TA-Lib maintains running sums; the pattern bar
itself is excluded — important: the lookback is causal). Gap helpers used by the C code:
```
REALBODYGAPUP(i,j)   : bBot_i > bTop_j          REALBODYGAPDOWN(i,j): bTop_i < bBot_j
CANDLEGAPUP(i,j)     : L_i > H_j                CANDLEGAPDOWN(i,j)  : H_i < L_j     (true window / shadow gap)
```
Two functions take an extra `penetration` argument: MORNINGSTAR/EVENINGSTAR/(DOJI)STAR/ABANDONEDBABY
(default 0.3 = 3rd bar must close ≥30% into 1st body), DARKCLOUDCOVER (0.5), MATHOLD (0.5).

Weaknesses of the TA-Lib scheme (must fix for intraday):
1. `BodyShort` and `BodyLong` share the same cut (1.0×avg): there is no neutral band, so ~50% of bars are
   "long". A three-tier scheme (short/normal/long) with hysteresis is better.
2. Ten-bar averages on 1m data are dominated by the last 10 minutes; a single 1m spike bar (news, open)
   makes the next 10 minutes see everything as "short". Use a longer, robust baseline (median or ATR over
   ≥60 bars) **plus** a session-time normaliser (see 1.3).
3. `Equal` = 5% of avg range. On NQ 1m with avg range ~15 pts that is 0.75 pt = 3 ticks; on a quiet 1m
   (range 4 pts) it is 0.2 pt < 1 tick → "equal" degenerates to exact-tick equality. Always floor thresholds
   at k ticks.
4. TA-Lib has **no trend/context test** except in HAMMER/HANGINGMAN (body position vs prior bar) and the
   "star" gaps. Nison/Bulkowski require a preceding trend. Context must be added (see §2).

### 1.2 The core problem: what "long"/"short"/"doji" mean across timeframes
- A daily NQ bar has range ≈ 1.2–1.5% of price and is the aggregate of ~1,400 minutes of two-sided
  auction; its OHLC summarize a lot of information (Bulkowski's whole database is dailies).
- A 1m NQ bar has range ≈ 3–15 pts (0.02–0.07%), i.e. 12–60 ticks; typical body 2–8 ticks; the bid-ask
  bounce (1 tick) and price discreteness are a material fraction of the shape. Roll (1984) bid-ask bounce
  and tick discreteness mean that a "doji" at 1m (body ≤ 1 tick) is the *modal* bar in quiet minutes; the
  shape carries little information beyond "nothing happened". Fock et al. (2005) and Duvinage et al. (2013)
  are the two studies that tested candles at 5-min: both find no exploitable value; Duvinage explicitly finds
  the *shape* has short-horizon predictive content but not enough to survive costs — consistent with
  1m–5m shapes being mostly microstructure.
- Rule of thumb from the volatility-estimator literature (Garman-Klass 1980, Rogers-Satchell 1991,
  Yang-Zhang 2000): OHLC-range statistics are unbiased/efficient only when the bar contains many
  price changes; when the number of trades per bar is small (thin 1m NQ overnight, or any bar of ≤ ~30
  ticks range), the range is biased low and shadows are systematically understated. Practical corollary:
  **express every threshold in ticks-and-ATR jointly and refuse to classify shape on bars whose range <
  ~8 ticks** (`range_ticks < MIN_RANGE_TICKS → shape = "flat", no pattern`).
- The same doji on 1h/daily is information (a full session's auction ended where it began); on 1m it is
  noise unless it occurs at an extreme with high volume (then it is an "absorption" bar — see
  `memory/wick-fade-absorption-research.md`: absorption ≥ 40 → 64% reject — that is a *volume*
  conditioning, not shape).

### 1.3 Recommended parameterization scheme (what to implement)
Compute a per-bar **feature vector** once, then all patterns become boolean expressions over it.
```
// baseline scales (all causal, exclude bar i)
scaleR = max( ATR(20)  , medR(60) )               // range scale for the bar's own timeframe
scaleB = medB(60)                                  // robust body scale (median, not mean)
scaleS = medS(60)                                  // robust shadow scale
floorT = k_tf * tick                               // k_tf: 1m=4, 5m=3, 15m=2, 1h/daily=1
// session-time normaliser (intraday only): divide by the median range for that minute-of-day
// over the last 20 sessions, so 09:31 and 12:30 bars are compared to their own peers
tod    = medR_by_minute_of_day(60 sessions)[minuteOfDay(i)]
scaleR_tod = tod>0 ? tod : scaleR

// per-bar shape features (dimensionless, in [0,1] where possible)
bodyRel   = body / range               // 0 = doji, 1 = marubozu
upRel     = up   / range
loRel     = lo   / range
clv       = ((C-L) - (H-C)) / range    // Chaikin close-location value ∈ [-1,1]
closePos  = (C-L)/range                // ∈ [0,1]; "close in top third" = closePos >= 2/3
bodyZ     = body / scaleB              // relative body vs recent bars
rangeZ    = range / scaleR_tod         // relative range vs recent bars & time-of-day
gapBodyUp = bBot - bTop1               // >0 = real-body gap up   (in ticks: /tick)
gapWinUp  = L - H1                     // >0 = true window (shadow gap)

// tier thresholds — the eleven TA-Lib names, re-based
BodyDoji         : body <= max(0.10*range , floorT)                // NB: own range, not avg (Nison: "open≈close")
BodyShort        : body <  0.5 * scaleB
BodyLong         : body >  1.5 * scaleB   AND rangeZ > 0.8         // long = long vs peers AND not a tiny bar
BodyVeryLong     : body >  3.0 * scaleB
ShadowVeryShort  : shadow <= max(0.10*range , floorT)              // "little or no shadow"
ShadowShort      : shadow <  scaleS
ShadowLong       : shadow >  max(1.0*body , 0.5*range)             // TA-Lib: >1×body ; add range clause for doji-ish bars
ShadowVeryLong   : shadow >  max(2.0*body , 0.66*range)            // Fuller pin bar = tail ≥ 2/3 of range
Near             : |a-b| <= max(0.20*scaleR , floorT)
Far              : |a-b| >  0.60*scaleR
Equal            : |a-b| <= max(0.05*scaleR , floorT)
MIN_RANGE_TICKS  : 8 (1m NQ), 6 (5m), 4 (15m+) — below this no shape label is emitted
```
Everything above transfers 1m → daily unchanged because every cut is relative to `scaleB`/`scaleR` and
floored in ticks; the only tf-specific knob is `k_tf` and the time-of-day table.

Recommended: store the tier as a **3-state** (`-1 short, 0 normal, +1 long`) with hysteresis 10% so a
bar flickering around 1.5×scaleB doesn't toggle patterns on tiny changes; and store `bodyZ`,`rangeZ`,`clv`
as continuous features so patterns can also be scored softly (needed for ML/meta-labeling later).

---------------------------------------------------------------------------------------------------------

## 2. Context (trend) requirements — how to quantify them

Nison: reversal patterns are only meaningful after a trend; continuation patterns only within one.
Bulkowski uses "price trend leading to the candle" = direction of the closing price over the prior days
(he judges visually; his stats condition on the *breakout* direction, not on trend quality). Formalize as
one of these (pick one per study, log which):
```
T1  slope   : sign of linear-regression slope of C over last N bars (N=10 intraday, 5–10 daily), |slope| > eps*ATR
T2  net     : (C1 - C_{1+N}) < -m*ATR(N)  → downtrend ; > +m*ATR → uptrend   (m = 1.0)
T3  count   : at least k of the last N closes lower than the close N bars back / k of N bars are lower-lows
T4  MA      : C1 < EMA(20) < EMA(50)  (down) — Fock et al. used a 5-min moving-average filter variant
T5  swing   : bar i-1 made a new N-bar low (L1 == min(L[i-N..i-1]))   ← the cheapest, and what "at support/after decline" means operationally
T6  extreme : L1 <= min(L over prior N) + Near   (a "test" of the extreme rather than a break)
```
For intraday futures use T5/T6 with N = 20–30 bars (1m) or session-based (prior-day low, ONH/ONL, VWAP,
opening range) — those are the levels the price-structures series treats elsewhere. Reversal patterns
should be evaluated **only** with a context flag; the unconditional frequency of TA-Lib hammers on 1m NQ is
several % of bars (measure it), of which the vast majority are mid-range noise.

---------------------------------------------------------------------------------------------------------

## 3. Single-bar patterns

Common fields: bars=1. "TA-Lib" = the CDL function that implements it (or none). Stats = Bulkowski
(theoretical → tested behaviour %, frequency rank F, overall performance rank P; out of 103, 1 = best).

### 3.1 doji (standard)  — TA-Lib `CDLDOJI`
- direction: neutral / indecision; Nison: reversal warning only after a trend (Northern doji in uptrend =
  bearish, Southern doji in downtrend = bullish).
- context: none required for detection; for signal, require T2/T5.
- rule: `body <= BodyDoji`  (TA-Lib: body <= 0.1×avgR(10)). Sub-labels: `up>ShadowLong && lo>ShadowLong` →
  long-legged (3.2); `lo>ShadowLong && up<=ShadowVeryShort` → dragonfly (3.3); reverse → gravestone (3.4).
- levels: trigger = close beyond the doji's H (bull) / L (bear) next bar (Nison "confirmation");
  invalidation = close beyond opposite extreme; stop beyond doji extreme; no target convention.
- stats: Northern doji: theory bearish rev → tested bullish **continuation 51%** (F6, P83). Southern doji:
  bullish rev 52% (F8, P78). i.e. random. Frequency: dojis are among the most common candles.
- pitfalls: on 1m NQ a 1-tick body is the modal bar; use `range_ticks >= MIN_RANGE_TICKS` and the
  time-of-day range table or you will flag thousands of "dojis" at lunch. **Intraday viable only as a
  component** (doji star, harami cross, tri-star) or as an absorption bar with volume.

### 3.2 long-legged doji / rickshaw man — TA-Lib `CDLLONGLEGGEDDOJI`, `CDLRICKSHAWMAN`
- direction: indecision; Nison treats it as a top signal after an extended advance.
- rule: `body <= BodyDoji AND (up > ShadowLong OR lo > ShadowLong)`. Rickshaw man adds body centred:
  `|(O+C)/2 - (H+L)/2| <= Near`. High-wave = same idea with a non-doji small body (3.11).
- levels: same as 3.1; the extremes are wider so stops are wider (time-as-risk: bad R:R intraday).
- stats: long-legged doji: bullish continuation 51% (F41, P37). Rickshaw man: continuation 51% (F55, P35).
- pitfalls: on 1m these are the "vacuum"/news bars — see `memory/vacuum-program.md`; shape alone has no
  direction (confirmed there). Not a stand-alone signal.

### 3.3 dragonfly doji / takuri line — TA-Lib `CDLDRAGONFLYDOJI`, `CDLTAKURI`
- direction: bullish reversal (in decline); Nison: also a top when at a high.
- rule: `body <= BodyDoji AND up <= ShadowVeryShort AND lo > ShadowLong` (takuri: `lo > ShadowVeryLong`).
- levels: trigger = close > H (or > bTop for aggressive); stop below L; invalidation = close < L.
- stats: dragonfly: reversal **50%** (F44, P98 — one of the worst); takuri: bullish reversal 66% (F28, P47).
- pitfalls: on intraday it is the "sweep-and-reclaim" bar; the *lower-shadow-vs-level* relation
  (§ price-structures 01) matters, not the doji body per se. Prefer the hammer/pin-bar family with a
  level condition.

### 3.4 gravestone doji — TA-Lib `CDLGRAVESTONEDOJI`
- direction: bearish reversal (in advance).
- rule: `body <= BodyDoji AND lo <= ShadowVeryShort AND up > ShadowLong`.
- levels: trigger = close < L; stop above H.
- stats: bearish reversal 51% (F42, P77) — random.

### 3.5 four-price doji — no TA-Lib
- rule: `H == L` (or `range <= 1 tick`). Only occurs on illiquid/halted bars or 1s bars.
- Not a signal; treat as data-quality flag (missing bar / halt). On NQ 1m appears only overnight holidays.

### 3.6 hammer — TA-Lib `CDLHAMMER`
- direction: bullish reversal. context: downtrend (Nison), price near a low.
- rule (TA-Lib): `body < BodyShort AND lo > ShadowLong AND up <= ShadowVeryShort AND bBot <= L1 + Near`
  (last term = the small body sits at/below the prior bar's low → the "in a decline" proxy). Colour free.
  Nison: lower shadow ≥ 2× body ("2–3×"), little/no upper shadow. Bulkowski adds: in downtrend.
- levels: trigger = close above hammer H (Nison prefers confirmation bar); aggressive = buy at close;
  stop below hammer L (Nison) or below L − Near; invalidation = close < L. Target: none formal
  (Bulkowski measures to next resistance; his "best % meeting price target 88%" is for the *height*
  projected from breakout).
- stats: bullish reversal 60% (F36, P65) — "not far from random". Best variant: white hammer near yearly
  low. Caginalp & Laurent 1998 did **not** test single-bar patterns. Fock et al. 2005 tested hammer/
  hanging man on 5-min DAX/Bund → no value.
- pitfalls: on 24h futures the "in a decline" test must be intraday-explicit (T5 with N≥20 or a level).
  Distinguish from **pin bar** (7.7): pin bar rules use tail ≥ 2/3 range and require the tail to
  *protrude* beyond neighbouring bars — that protrusion is the useful part.
- intraday verdict: **viable as a level-reaction descriptor** (sweep + reclaim), not as a bare shape.

### 3.7 hanging man — TA-Lib `CDLHANGINGMAN`
- direction: bearish reversal after advance. rule: same shape as hammer but
  `bBot >= H1 - Near` (body at/above prior bar's high). Nison requires bearish confirmation (next close
  below hanging-man body).
- levels: trigger = close < L (Nison: below the real body); stop above H.
- stats: theory bearish → tested **bullish continuation 59%** (F16, P87). Bulkowski: "near random";
  hanging man without confirmation is a continuation pattern in his data.
- intraday: same as hammer, mirrored; the long lower tail after an advance is usually a buy-the-dip that
  succeeded — treat as continuation unless next bar closes below the tail's midpoint.

### 3.8 inverted hammer — TA-Lib `CDLINVERTEDHAMMER`
- direction (theory): bullish reversal after decline; **Bulkowski: bearish continuation 65%, P6** (one of
  the best performers — *in the opposite direction to theory*).
- rule (TA-Lib, 2-bar): `body < BodyShort AND up > ShadowLong AND lo <= ShadowVeryShort AND
  REALBODYGAPDOWN(i, i-1)` (body gaps below prior body). Nison: needs bullish confirmation next bar.
- levels: bull use = close > H next bar; bear use (Bulkowski) = close < L.
- pitfalls: the TA-Lib gap-down requirement is nearly never satisfied on 1m futures except at the RTH
  open — replace with `bTop <= C1` (body below prior close) or drop, and record which.

### 3.9 shooting star — TA-Lib `CDLSHOOTINGSTAR`
- direction: bearish reversal after advance. rule (TA-Lib): `body < BodyShort AND up > ShadowLong AND
  lo <= ShadowVeryShort AND REALBODYGAPUP(i,i-1)`. Nison: upper shadow ≥ 2× body, small body near low.
- levels: trigger = close < L (or below body); stop above H; invalidation close > H.
- stats: 1-line: bearish reversal 59% (F37, P55) "looks better than it performs"; 2-line (with gap):
  bullish continuation 61% (F51, P52).
- intraday: mirror of hammer; the "gap up" clause must be relaxed (`bBot >= C1`). Viable only with a level.

### 3.10 marubozu family — TA-Lib `CDLMARUBOZU`, `CDLCLOSINGMARUBOZU`, `CDLBELTHOLD` (opening marubozu ≈ belt-hold)
- direction: continuation (colour direction); belt-hold = reversal by theory (white belt-hold after
  decline / black after advance).
- rules: full marubozu `body > BodyLong AND up <= ShadowVeryShort AND lo <= ShadowVeryShort`;
  closing marubozu `body > BodyLong AND (white ? up : lo) <= ShadowVeryShort`; opening marubozu /
  belt-hold `body > BodyLong AND (white ? lo : up) <= ShadowVeryShort` (TA-Lib CDLBELTHOLD exactly this;
  no trend test).
- levels: continuation use = trade in colour direction on next bar open with stop beyond the marubozu's
  opposite end; belt-hold reversal = same, in colour direction, but requires prior opposite trend.
- stats: white marubozu continuation 56% (F27, P71); black marubozu continuation 53% (F30, P57);
  closing white 55% (F15, P70); closing black 52% (F18, P43); opening white 54% (F7, P75); opening
  black 52% (F5, P58); bullish belt-hold: reversal 71% (F22, P62); bearish belt-hold: reversal 68%
  (F19, P63). Long white day: continuation 58% (F10, P53); long black day 53% (F9, P19).
- intraday: **viable as a feature** ("wide-range trend bar", closePos ≥ 0.9). Brooks' "trend bar" and
  Crabel's WRB are the same object (§7). Marubozu at 1m is a common momentum bar; its information is in
  `rangeZ` and `closePos`, and in *where* it prints (breakout of range vs mid-range).

### 3.11 spinning top / high-wave / short line / long line — TA-Lib `CDLSPINNINGTOP`, `CDLHIGHWAVE`, `CDLSHORTLINE`, `CDLLONGLINE`
- rules: spinning top `body < BodyShort AND up > body AND lo > body`; high wave `body < BodyShort AND
  (up > ShadowVeryLong OR lo > ShadowVeryLong)` (TA-Lib uses OR; Morris/Nison describe both shadows very
  long — use AND for the strict form); short line `body < BodyShort AND up < ShadowShort AND lo <
  ShadowShort`; long line `body > BodyLong AND up < ShadowShort AND lo < ShadowShort`.
- stats: black spinning top: reversal 51% (F1 — the most common candle, P73); white spinning top 50%
  (F2, P69); high wave: reversal 51% (F17, P67); short black 52% (F50, P66); short white 52% (F54, P85).
- intraday: pure noise descriptors; useful only as "small bar" component of multi-bar patterns and for
  NR/ii detection (§7).

### 3.12 belt-hold — see 3.10 (opening marubozu). TA-Lib `CDLBELTHOLD`.

Single-bar summary: none of the 12 shapes has a Bulkowski tested rate materially above 60% except
belt-holds (68–71%), takuri (66%) and inverted-hammer-as-continuation (65%); the two "famous" reversal
bars (hammer 60%, shooting star 59%) are near coin-flip in daily stocks and Fock et al. found nothing at
5-min futures.

---------------------------------------------------------------------------------------------------------

## 4. Two-bar patterns

### 4.1 bullish / bearish engulfing — TA-Lib `CDLENGULFING`
- direction: reversal (bull after decline, bear after advance). context: trend (Nison: "clearly definable
  trend"); TA-Lib has none.
- rule (TA-Lib `ta_CDLENGULFING.c`, real bodies only): bull: `black1 AND white AND ((C >= O1 AND O < C1)
  OR (C > O1 AND O <= C1))` and NOT (`O == C1 AND C == O1`) — i.e. the 2nd body covers the 1st with at
  least one strict side; bear: mirror (`O >= C1 AND C < O1` or `O > C1 AND C <= O1`).
  Nison adds: 2nd body "engulfs" (shadows irrelevant); stronger if 1st is small and 2nd very large, or 2nd
  engulfs several bodies, or on heavy volume. Bulkowski: uses bodies, opposite colours.
  Recommended intraday variant: also require `body > BodyLong` for the engulfing bar and
  `body1 >= BodyDoji` (a doji cannot be "engulfed" meaningfully) — TA-Lib would flag a 1-tick prior body.
- levels: trigger = close beyond engulfing bar's extreme (H for bull) — or aggressive: entry at close of
  engulfing bar; stop beyond the pattern's extreme (min(L,L1) for bull); invalidation = close back inside
  the 1st body's far side. Nison: pattern extremes become S/R.
- stats: bearish engulfing: reversal **79%** but overall performance **P91** (reversal happens, then the
  move is short-lived; frequency F11); bullish engulfing: reversal 63%, P84 (F12) — "post-breakout
  performance can be dreadful". Academic: Marshall-Young-Rose 2006 (DJIA daily, bootstrap) — no value for
  bull/bear engulfing; Lu & Shiu 2012 (Taiwan) find bullish engulfing/harami profitable with 3-day
  hold; Goo et al. 2007 similar; Duvinage 2013 (5-min US stocks): a third beat B&H raw, none after
  costs+snooping; Fock 2005: engulfing among the 19 tested on DAX/Bund 5-min → no value.
- intraday: the *observable* object is Brooks' "outside bar / reversal bar" — engulfing at 1m is common
  (order of a few % of bars — estimate, verify). Only worth testing conditioned on a level + T5. Note: on 24h futures the 2nd bar opens ≈
  1st close, so the "O < C1" clause is satisfied by 1 tick almost always → engulfing degenerates to
  "opposite colour and bigger". Require `O <= C1 - floorT`? No — that reintroduces a gap that doesn't
  exist; instead require `body >= 1.2×body1` and `body > BodyLong`.

### 4.2 harami / harami cross — TA-Lib `CDLHARAMI`, `CDLHARAMICROSS`
- direction: reversal by theory (Nison: "loss of momentum", not necessarily reversal).
- rule (TA-Lib): `body1 > BodyLong AND body <= BodyShort AND bTop < bTop1 AND bBot > bBot1` (2nd body
  strictly inside 1st body; TA-Lib does not require opposite colours but Nison does; direction from 1st
  colour: black1 → bullish harami). Harami cross: 2nd bar `body <= BodyDoji`.
- levels: trigger = close beyond the *1st* bar's extreme in reversal direction (that is "three inside
  up/down", 5.4); tight trigger = beyond 2nd bar's range; stop beyond 1st bar's opposite extreme (wide) or
  2nd bar's (tight, often stopped).
- stats: bullish harami: reversal 53% (F25, P38); bearish harami: **bullish continuation 53%** (F26,
  P72); harami cross bull: bearish continuation 55% (F47, P50); harami cross bear: bullish continuation
  57% (F45, P80). Random. Marshall et al 2006: harami no value; Lu & Shiu 2012 Taiwan: bullish harami
  significant (short hold); Goo 2007: harami among "profitable" in Taiwan.
- intraday: harami on 1m = an inside bar after a big bar = **"ii"/inside-bar** language (§7.1) — this is
  the one place candle and price-action vocab coincide. Viable as *setup* (breakout of the mother bar
  range), not as direction. Hikkake (TA-Lib `CDLHIKKAKE`) is exactly the inside-bar false-breakout
  variant (see 5.19).

### 4.3 piercing line — TA-Lib `CDLPIERCING`
- direction: bullish reversal after decline.
- rule (TA-Lib): `black1 AND body1 > BodyLong AND white AND body > BodyLong AND O < L1 AND C > mid1 AND
  C < O1`. Nison: open below prior **low** (gap), close > 50% into prior body; ideal on second bar heavy
  volume. Morris allows open below prior close.
- levels: trigger = close > H1 (or entry at C with stop < min(L,L1)); invalidation close < L.
- stats: bullish reversal 64%, **P13** (F40) — one of the better two-bar performers.
- intraday: `O < L1` requires a gap → essentially only at RTH open (09:30 bar vs 09:29) or across the
  16:00–18:00 halt. **Intraday-adapted**: replace with `O <= C1` (opens at/below prior close — trivial on
  24h) so the rule becomes "long black then long white closing above mid1 but below O1". Note this makes it
  a subset of "bullish reversal bar with close in top half of a two-bar range". Distinguish from bullish
  engulfing by `C < O1`.

### 4.4 dark cloud cover — TA-Lib `CDLDARKCLOUDCOVER` (penetration 0.5)
- direction: bearish reversal after advance.
- rule: `white1 AND body1 > BodyLong AND black AND O > H1 AND C < mid1 AND C > O1` (TA-Lib open must be
  above prior HIGH; Nison same; some texts allow above prior close).
- levels: trigger close < L1; stop > max(H,H1).
- stats: bearish reversal 60%, **P22** (F46) — good post-breakout trend for its reversal rate.
- intraday: same gap problem as piercing → adapt with `O >= C1`.

### 4.5 tweezer top / bottom — no TA-Lib
- direction: reversal (weak; Nison: "not usually vital", stronger with other signal).
- rule: two consecutive (or nearby) bars with equal extremes: bottom `|L - L1| <= Equal` after decline;
  top `|H - H1| <= Equal` after advance. Bulkowski adds: bars can be any colour/shape.
- levels: trigger = close beyond the two-bar range in reversal direction; stop just beyond the tweezer
  level (tight; the level is the point).
- stats: tweezers bottom: **bearish continuation 52%** (F39, P44); tweezers top: bullish continuation
  56% (F35, P81) → random / mildly counter-theory.
- intraday: on NQ 1m "equal lows" within 1–2 ticks is a double-tap of a level; that is a **level** event
  (price-structures 01) not a candle. Set Equal floor at 2 ticks; require the two lows to be the N-bar
  minimum (T5).

### 4.6 kicking (bull/bear) — TA-Lib `CDLKICKING`, `CDLKICKINGBYLENGTH`
- direction: reversal in direction of 2nd marubozu (Nison: strongest 2-bar signal, no trend needed).
- rule (TA-Lib): both bars `body > BodyLong AND up < ShadowVeryShort AND lo < ShadowVeryShort`
  (marubozu), opposite colours, and a **shadow** gap: bull `black1 AND L > H1`; bear `white1 AND H < L1`.
  BYLENGTH: same test, direction = colour of the longer body.
- stats: bullish kicking: reversal 53% (F100, P96); bearish 54% (F102, P102) — rare and bad.
- intraday: **unobservable** on 24h futures (needs a real gap between two consecutive bars). Adapted
  variant "kicking-lite": two opposite full-body bars each `body > BodyLong`, second's open within
  Equal of first's close (no gap) — that is just a V-reversal of two trend bars; label distinctly.

### 4.7 matching low / matching high — TA-Lib `CDLMATCHINGLOW` (no high variant)
- rule (TA-Lib): `black1 AND black AND |C - C1| <= Equal` (two black candles with equal closes; TA-Lib
  has no body-size test; Morris: 1st long). Matching high = mirror (two whites, equal closes).
- direction (theory): support at the equal closes → bullish; **Bulkowski: bearish continuation 61%, P8**.
- intraday: equal closes within a tick on 1m are common and meaningless without a level; the equal
  *lows* version (tweezer) is more relevant. Set Equal floor at 2 ticks.

### 4.8 homing pigeon — TA-Lib `CDLHOMINGPIGEON`
- rule: `black1 AND body1 > BodyLong AND black AND body <= BodyShort AND bTop < bTop1 AND bBot > bBot1`
  (a same-colour black harami). direction (theory) bullish; **Bulkowski: bearish continuation 56%, P21**.
- intraday: same as harami — inside-bar setup.

### 4.9 on-neck / in-neck / thrusting — TA-Lib `CDLONNECK`, `CDLINNECK`, `CDLTHRUSTING`
- Nison: three degrees of failed bullish penetration in a downtrend → bearish continuation.
- rules (all: `black1 AND body1 > BodyLong AND white AND O < L1`):
  on-neck `|C - L1| <= Equal` (closes at prior low); in-neck `C >= C1 AND C <= C1 + Equal` (closes
  barely into prior body); thrusting `C > C1 + Equal AND C < mid1` (closes below midpoint; ≥ mid1 = piercing).
- levels: continuation short trigger = close < L (Nison: below the white bar's low); stop > H1.
- stats: on-neck: bearish continuation 56% (F70, P33); in-neck: 53% (F62, P17); thrusting: **bullish
  reversal 57%** (F56, P15) — thrusting acts opposite to theory in Bulkowski.
- intraday: `O < L1` gap clause unobservable → adapt to `O <= C1`. Then the family is "weak pullback bar
  in a down-move classified by close location within the prior body" — good as a *continuous* feature
  (`(C - C1)/body1` = penetration ratio) rather than three booleans.

### 4.10 separating lines — TA-Lib `CDLSEPARATINGLINES`
- direction: continuation (colour of 2nd bar = trend colour).
- rule: opposite colours, `|O - O1| <= Equal` (same open), 2nd is a belt-hold in trend direction:
  `body > BodyLong AND (white ? lo : up) <= ShadowVeryShort`.
- stats: bullish separating lines: continuation **72%** (F76, P36); bearish 63% (F82, P40).
- intraday: needs the 2nd bar to open at the *1st bar's open*, i.e. a gap back to that level; on 24h
  data this happens only when bar 1's close ≈ open (doji) → degenerate. **Effectively unobservable**;
  adapted variant: 2nd bar *trades through* O1 and closes as a belt-hold beyond it (`white: O <= O1 AND
  C > O1 + body1`), i.e. full retrace + continuation within one bar.

### 4.11 meeting lines / counterattack — TA-Lib `CDLCOUNTERATTACK`
- direction: reversal (bull: black long then white long with equal close).
- rule: opposite colours, both `body > BodyLong`, `|C - C1| <= Equal`. Nison: the 2nd opens with a gap
  in trend direction and comes back to the prior close (weaker than piercing/dark cloud).
- stats: bullish meeting lines: reversal 56% (F72, P18); bearish: **bullish continuation 51%** (F63, P16).
- intraday: requires a gap-open then full retrace inside one bar; without the gap the 2nd bar's O ≈ C1
  and C ≈ C1 → it is a doji, contradiction. **Unobservable** intraday except at RTH open / after halts.

### 4.12 doji star (bull/bear) — TA-Lib `CDLDOJISTAR`
- rule: `body1 > BodyLong AND body <= BodyDoji AND (white1 ? REALBODYGAPUP : REALBODYGAPDOWN)(i,i-1)`.
  A doji whose body gaps away from a long body in the trend direction; first two bars of morning/evening
  doji star.
- stats: bearish doji star: **bullish continuation 69%** (F43, P51); bullish doji star: bearish
  continuation 64% (F53, P49) — both act as continuation (the 3rd bar is what matters).
- intraday: body-gap of a doji after a long bar: doji body ≈ 1 tick sits at bar-1's close → body gap up
  requires bBot > bTop1 = C1, i.e. the doji's O and C both > C1 — happens (bar opens 1 tick above prior
  close and closes there) but the "gap" is 1 tick and meaningless. Use "range separation" variant:
  `bBot >= C1 + Near` for a real star, else label "star-lite".

### 4.13 last engulfing top / bottom — no TA-Lib
- Bulkowski: engulfing pattern that appears in the *trend* direction (bullish engulfing in an uptrend =
  "last engulfing top", theory bearish). rule = engulfing (4.1) with context flag inverted.
- stats: last engulfing top: bullish continuation 68% (F14, P79); bottom: bearish continuation 65%
  (F13, P48). Interpretation: engulfing bars *with* trend continue → the same fact as 4.1's context need.

### 4.14 above the stomach / below the stomach — no TA-Lib
- Bulkowski (Morris-derived): bull: black1, then white bar that opens **and** closes at/above mid1
  (`O >= mid1 AND C >= mid1`, white); bear mirror. A weak engulfing/piercing hybrid.
- stats: above the stomach: bullish reversal 66% (F32, P31); below the stomach: bearish reversal 60%
  (F38, P59). Better than tweezers/harami and no gap needed → **intraday-observable as written**
  (open at/above mid1 is common when C1 ≈ mid1... careful: on 24h data O ≈ C1, so "O ≥ mid1" ⇔ prior
  bar closed in its upper half — a black bar closing in its upper half is a bar with a long lower shadow.
  So intraday, above-the-stomach ≈ "hammer-ish black bar followed by white bar closing above mid1".)

### 4.15 two black gapping — no TA-Lib
- Bulkowski: after an up-move, a gap down then two black candles (2nd lower high). Continuation 68%,
  **P10**, F29. Requires a true window → intraday only across session boundaries. Adapted: after an
  N-bar high, two consecutive black bars with lower highs where the first opens below the prior close by
  ≥ Near.

### 4.16 hikkake (2-bar core, 3–5 bar confirmation) — see 5.19.

### 4.17 rising / falling window (gap) — no TA-Lib
- rule: `L > H1` (rising) / `H < L1` (falling). Nison: windows are support/resistance; continuation.
- stats: rising window: bullish continuation 75%, "stopped in gap 20%" (F20); falling window: bearish
  continuation 67%, stopped in gap 25% (F23). Intraday NQ/ES: **only** overnight (18:00 reopen vs 16:00
  close on the ETH session — Globex reopen gap) and Monday. Treat as session-gap events, not candles.

---------------------------------------------------------------------------------------------------------

## 5. Three-bar patterns

### 5.1 morning star / evening star — TA-Lib `CDLMORNINGSTAR`, `CDLEVENINGSTAR` (penetration 0.3)
- direction: reversal (morning = bull after decline).
- rule (TA-Lib `ta_CDLMORNINGSTAR.c`, morning): `black2 AND body2 > BodyLong AND body1 <= BodyShort AND
  REALBODYGAPDOWN(1,2) [bTop1 < bBot2] AND white AND body > BodyShort AND C > C2 + body2*penetration`
  (3rd closes ≥30% up into the 1st body; 3rd need only be "not short"; no gap required between star and
  3rd bar). Evening: mirror. Nison: star body gaps below 1st body; 3rd closes "well into" 1st body; ideal
  has gap on both sides. Morris: 3rd should close above mid2 (penetration 0.5).
- levels: trigger = close of 3rd bar (pattern complete) or close > H2/H; stop below star L1; invalidation
  = close < L1. Target: pattern height (Bulkowski) or the origin of the decline.
- stats: morning star: reversal **78%, P12** (F66); evening star: **72%, P4** (F71). Caginalp &
  Laurent 1998: morning/evening star among the 8 three-day patterns tested on S&P500 stocks 1992–96 with
  significant 2-day forward returns (~0.9% avg for bull patterns); Lu, Shiu & Liu 2012 (Taiwan) also find
  three-day patterns more reliable than two-day.
- intraday: the star's **body gap** is the problem. On 1m NQ the star opens at C2 ± 1 tick, so
  `REALBODYGAPDOWN` requires the star's whole body below C2 — a 1-tick "gap". Two adaptations:
  (a) *star-lite*: drop the gap, keep `body1 <= BodyShort AND bTop1 <= C2 + Near` (star sits at the
  bottom of bar 2's range); (b) *range-separation*: `H1 < C2 - Near` (star's whole range below the prior
  close). Report both. **Viable intraday as star-lite** — it becomes "long down bar, small bar at the low,
  long up bar" = the classic 3-bar V.

### 5.2 morning / evening doji star — TA-Lib `CDLMORNINGDOJISTAR`, `CDLEVENINGDOJISTAR`
- rule: as 5.1 with `body1 <= BodyDoji`. stats: morning doji star: reversal 76% (F78, P25); evening doji
  star: 71% (F81, P30). Same intraday adaptation. Also "collapsing doji star" (Bulkowski): bearish rev
  63%, F101, P97 — ignore.

### 5.3 abandoned baby — TA-Lib `CDLABANDONEDBABY` (penetration 0.3)
- rule: 5.2 with **shadow** gaps on both sides: `CANDLEGAPDOWN(1,2) AND CANDLEGAPUP(0,1)` (bull), i.e.
  `H1 < L2 AND L > H1`. Rarest Nison pattern.
- stats: bullish: reversal 70%, **P9** (F92); bearish: 69% (F96, P64).
- intraday: **unobservable** on continuous futures except across the 16:00–18:00 halt or weekend
  (island doji). Adapted "island-lite": star bar's range fully below both neighbours' *closes* by ≥
  Near (`H1 < min(C2,O) - Near`) — rare but observable; label separately.

### 5.4 three inside up / down — TA-Lib `CDL3INSIDE`
- rule (TA-Lib `ta_CDL3INSIDE.c`): `body2 > BodyLong AND body1 <= BodyShort AND bTop1 < bTop2 AND bBot1 >
  bBot2` (strict harami, any colour for bar 1) then confirmation by a 3rd bar of the colour opposite to
  bar 2 that closes beyond bar 2's open: up `black2 AND white AND C > O2`; down `white2 AND black AND C <
  O2`. Nison doesn't name it (Morris does).
- levels: trigger = 3rd close (pattern completes at confirmation) or breakout of H2; stop < min(L1,L2).
- stats: three inside up: reversal 65%, **P20** (F31); down: 60% (F33, P56).
- intraday: **observable as written** (no gap). This is inside-bar → breakout with close confirmation
  ("ii breakout" in Brooks); the natural futures form.

### 5.5 three outside up / down — TA-Lib `CDL3OUTSIDE`
- rule: engulfing (4.1) then confirmation close beyond engulfing bar's close: up: `C > C1`; down: `C < C1`.
- stats: three outside up: reversal **75%** (F24, P34); down: 69% (F21, P39). Caginalp & Laurent 1998
  tested "three outside" variants (engulfing + confirmation) — significant.
- intraday: observable as written; = "outside bar + follow-through bar". Candidate for testing with level
  + T5 context.

### 5.6 three white soldiers / three black crows — TA-Lib `CDL3WHITESOLDIERS`, `CDL3BLACKCROWS`
- rule (TA-Lib `ta_CDL3WHITESOLDIERS.c`): three white, `up < ShadowVeryShort` on all three, `C > C1 >
  C2`, each opens inside/near the prior body (`O1 > O2 AND O1 <= C2 + Near`, `O > O1 AND O <= C1 + Near`),
  bodies not shrinking much (`body1 > body2 - Far AND body > body1 - Far`) and `body > BodyShort`.
  Crows (`ta_CDL3BLACKCROWS.c`, 4 bars): bar i-3 white; three black with `lo < ShadowVeryShort`; `O1 < O2
  AND O1 > C2` and `O < O1 AND O > C1` (each opens inside prior black body); `H3 > C2` (1st crow closes
  under the white bar's high); `C2 > C1 > C`. Nison: soldiers "gradual, steady rise" with closes near
  highs; crows after advance with opens inside prior body.
- levels: continuation entry on 4th bar; stop under the 3rd soldier's low (wide). Nison warns: overextended
  soldiers = advance block / stalled (5.7).
- stats: soldiers: reversal **82%, P32** (F67); crows: reversal 78%, **P3** (F~60); identical three
  crows: 79%, P24 (F83). Caginalp & Laurent 1998: three white soldiers / three black crows significant
  (their strongest results); Lu-Shiu-Liu 2012 Taiwan: three-day patterns hold up.
- intraday: observable as written; on 1m it is a 3-bar momentum run. Bulkowski's "reversal" label
  applies to daily context (start of new trend); intraday it is a continuation/breakout feature. Very
  short-shadow requirement (≤ 0.1×avgR) is strict on 1m — use `up <= max(0.1×range, floorT)`.

### 5.7 advance block / deliberation (stalled) — TA-Lib `CDLADVANCEBLOCK`, `CDLSTALLEDPATTERN`
- rules (TA-Lib): advance block: three white, `C > C1 > C2`, opens inside/near prior body (`O1 > O2 AND O1
  <= C2 + Near`; same for bar i), `body2 > BodyLong AND up2 < ShadowShort`, and ANY of: (a) `body1 <
  body2 - Far AND body < body1 + Near`; (b) `body < body1 - Far`; (c) `body < body1 < body2 AND (up >
  ShadowShort OR up1 > ShadowShort)`; (d) `body < body1 AND up > ShadowLong`. Stalled/deliberation:
  `white2 AND white1 AND white`, `C > C1 > C2`, `body2 > BodyLong AND body1 > BodyLong AND up1 <
  ShadowVeryShort`, `O1 > O2 AND O1 <= C2 + Near`, 3rd `body < BodyShort AND O >= C1 - body - Near`
  (small body "riding on the shoulder" of bar 2).
- stats: advance block: **bullish continuation 64%** (F65, P54); deliberation: **bullish continuation
  77%** (F48, P93) — both act opposite to theory (theory: bearish reversal warnings).
- intraday: observable; the "shrinking body / growing upper shadow" test is a decent **exhaustion feature**
  (bodyZ decreasing over 3 bars) but Bulkowski says it doesn't reverse. Use as continuous feature.

### 5.8 three stars in the south — TA-Lib `CDL3STARSINSOUTH`
- rule (TA-Lib): three black; `body2 > BodyLong AND lo2 > ShadowLong`; `body1 < body2 AND O1 > C2 AND
  O1 <= H2 AND L1 < C2 AND L1 >= L2 AND lo1 > ShadowVeryShort` (2nd opens higher inside 1st range,
  trades below 1st close but not below 1st low, has a lower shadow); 3rd `body < BodyShort AND lo <
  ShadowVeryShort AND up < ShadowVeryShort AND L > L1 AND H < H1` (small marubozu inside 2nd range).
- stats: reversal **86%** — highest reversal rate — but P103 (worst performer, F99). Rare.
- intraday: observable but the pattern is basically three shrinking down bars with a shadow — noise.

### 5.9 identical three crows — TA-Lib `CDLIDENTICAL3CROWS`
- rule: three black long bodies, each opening at (Equal) the prior close, `lo <= ShadowVeryShort`.
- stats: reversal 79% (F83, P24). Intraday: opening at prior close is *the default* on 24h data → on
  1m this is just "three long black bars in a row"; distinguish from crows only by the open test which is
  vacuous. Fold into "N consecutive trend bars" feature.

### 5.10 tri-star — TA-Lib `CDLTRISTAR`
- rule: three dojis; middle gaps (`REALBODYGAPUP(1,2) AND REALBODYGAPDOWN(0,1)` for bearish).
- stats: bullish: reversal 60% (F79, P28); bearish 52% (F77, P76).
- intraday: three consecutive 1m dojis = lunch chop; the body gap of 1-tick dojis is meaningless.
  **Unobservable in useful form.**

### 5.11 unique three river bottom — TA-Lib `CDLUNIQUE3RIVER`
- rule (TA-Lib): `black2 AND body2 > BodyLong`, `black1 AND C1 > C2 AND O1 <= O2 AND L1 < L2` (body inside
  1st body but with a lower low = long lower shadow), `white AND body < BodyShort AND O > L1`. Nison also
  wants the 3rd to close below the 2nd's close (TA-Lib omits).
- stats: **bearish continuation 60%** (F89, P60). Rare, wrong-way. Observable intraday but pointless.

### 5.12 two crows / upside gap two crows — TA-Lib `CDL2CROWS`, `CDLUPSIDEGAP2CROWS`
- rule (TA-Lib): two crows: `white2 AND body2 > BodyLong`, `black1 AND bBot1 > bTop2` (body gap up),
  `black AND O < O1 AND O > C1` (opens inside 2nd body) `AND C > O2 AND C < C2` (closes inside 1st body).
  Upside-gap two crows: same first two bars with `body1 <= BodyShort`, 3rd `black AND O > O1 AND C < C1`
  (engulfs the 2nd body) `AND C > C2` (still closes above the 1st close — gap not fully closed).
- stats: two crows: bearish reversal 54% (F64, P61); upside gap two crows: **bullish continuation 60%**
  (F75, P74).
- intraday: needs a body gap up after a long white — 1-tick gaps only. Unobservable in meaningful form.

### 5.13 stick sandwich — TA-Lib `CDLSTICKSANDWICH`
- rule: `black2, white1 with L1 > C2 (white trades above 1st close), black with |C - C2| <= Equal`.
- stats: **bearish continuation 62%** (F59, P14) — wrong-way vs theory (bullish).
- intraday: `L1 > C2` requires the white bar to open above the prior close (gap) — on 24h data the white
  bar's low is typically ≤ C2. Adapt: `bBot1 > C2` (body above). Equal closes floor at 2 ticks.

### 5.14 side-by-side white lines — TA-Lib `CDLGAPSIDESIDEWHITE`
- rule: 2nd and 3rd white with similar bodies (`|body-body1| <= Near`) and equal opens (`|O-O1| <=
  Equal`), both gapping (real-body gap) up from bar 2 (bull) or down (bear).
- stats: bullish: continuation 66% (F73, P46); bearish: 56% (F86, P29).
- intraday: two consecutive white bars with equal opens ⇒ bar 1 must be a doji (O1 ≈ C1 ≈ O). Unobservable.

### 5.15 upside / downside gap three methods — TA-Lib `CDLXSIDEGAP3METHODS`
- rule: two same-colour bars with a real-body gap between them, then opposite-colour 3rd opening inside
  the 2nd body and closing inside the 1st body (fills the gap). Continuation by theory.
- stats: upside gap three methods: **bearish reversal 59%** (F85, P27); downside: **bullish reversal
  62%** (F84, P26) — both wrong-way.
- intraday: gap required → unobservable; nearest analogue = 3-bar "pullback into a prior thrust" —
  measured better by structure (01) than shape.

### 5.16 upside / downside tasuki gap — TA-Lib `CDLTASUKIGAP`
- rule: real-body gap between bar 2 and bar 1 (same colour), 3rd opposite colour opens within bar-1 body
  and closes inside the gap without closing it (`C < bBot1 AND C > bTop2` for upside; TA-Lib also
  requires similar body sizes: `|body - body1| < Near`).
- stats: upside tasuki gap: continuation 57%, **P5** (F74); downside: **bullish reversal 54%** (F68, P23).
- intraday: unobservable (gap). Note Bulkowski's high P-rank is on stocks with real gaps.

### 5.17 in-neck / on-neck confirmations, thrusting → see 4.9 (2-bar).

### 5.18 three-bar "inside/outside" combos used by price-action traders (Brooks): ioi (inside-outside-
  inside), ii, iii → §7.

### 5.19 hikkake / modified hikkake — TA-Lib `CDLHIKKAKE`, `CDLHIKKAKEMOD` (3–5 bars incl. confirmation)
- Chesler 2004 pattern. rule: bar i-1 is an **inside bar** (`H1 < H2 AND L1 > L2`); bar i breaks out one
  side (`H > H1 AND L >= L1` = up-break, or `L < L1 AND H <= H1` = down-break); the *signal* fires when
  within the next 3 bars price closes back through the opposite side of the inside bar (`C < L1` after
  up-break → bearish; `C > H1` after down-break → bullish). TA-Lib `CDLHIKKAKE`: `H1 < H2 AND L1 > L2` (inside), bar i `H < H1 AND L < L1` → bull setup (+100
  on confirmation) or `H > H1 AND L > L1` → bear; confirmation = within 3 bars a close beyond the inside
  bar's opposite extreme. `CDLHIKKAKEMOD` (4 bars): bar i-2 inside bar i-3 **and** bar i-1 inside bar i-2
  (an "ii"), the first inside bar closing near its extreme (`C2 <= L2 + Near` for the bull version), then
  bar i breaks the second inside bar the wrong way; same 3-bar confirmation.
- Bulkowski (out of 105 in his newer set): bear hikkake: bearish continuation 50% (F18, P83); bull: bullish
  continuation 52% (F16, P84) — random in daily stocks.
- intraday: **fully observable** (no gaps) and is exactly the "failed inside-bar breakout" trade of
  Brooks. Candidate for level-conditioned testing (failed breakout of an inside bar *at* a level).

---------------------------------------------------------------------------------------------------------

## 6. Four- and five-bar patterns

### 6.1 rising / falling three methods — TA-Lib `CDLRISEFALL3METHODS`
- rule (TA-Lib `ta_CDLRISEFALL3METHODS.c`, rising): `white4 AND body4 > BodyLong`; bars 3,2,1 all black
  with `body < BodyShort`, each body **partly** inside bar 4's range (`bBot < H4 AND bTop > L4` — TA-Lib
  does NOT require full containment; Nison does), closes falling (`C2 < C3 AND C1 < C2`); 5th `white AND
  body > BodyLong AND O > C1 AND C > C4`. Falling: mirror. For the strict Nison form add `max(H3,H2,H1)
  <= H4 AND min(L3,L2,L1) >= L4`.
- stats: rising: continuation 74% (F88, **P94**); falling: 71% (F91, P89). Good rate, poor follow-through.
- intraday: observable; = "3-bar pullback inside a wide-range bar then breakout" — a natural NQ 1m
  object; the "close > C4" is the trigger.

### 6.2 mat hold — TA-Lib `CDLMATHOLD` (penetration 0.5)
- rule (TA-Lib `ta_CDLMATHOLD.c`, penetration 0.5): `white4 AND body4 > BodyLong`; `black3 AND body3 <
  BodyShort AND bBot3 > bTop4` (real-body gap up); bars 2,1 `body < BodyShort`, any colour, bodies falling
  (`bTop2 < O3 AND bTop1 < bTop2`) but bottoms staying above `C4 - body4*penetration` and below `C4`;
  5th `white AND O > C1 AND C > max(H3,H2,H1)`. Bulkowski/Morris: similar, three reaction candles of
  any colour, first gaps up.
- stats: continuation **78% (top continuation rate) but P86**, F93 (rare).
- intraday: gap in bar 3 → adapt to `bBot3 >= C4 - Near`. Rare in either form.

### 6.3 concealing baby swallow — TA-Lib `CDLCONCEALBABYSWALL`
- rule: two black marubozu, 3rd black gaps down (`REALBODYGAPDOWN`) with an upper shadow reaching into
  prior body (`H > C2`), 4th black engulfs 3rd including shadow (`H > H1 AND L < L1`). Theory bullish.
- stats: **bearish continuation 75%** (F103 rarest, P101). Unobservable intraday (gap) and wrong-way. Skip.

### 6.4 ladder bottom — TA-Lib `CDLLADDERBOTTOM`
- rule (TA-Lib): bars 4,3,2 black with `O4 > O3 > O2 AND C4 > C3 > C2`; 4th (bar 1) black with an upper
  shadow (`up1 > ShadowVeryShort`); 5th white with `O > O1` (opens above the 4th's body top) `AND C > H1`
  (closes above its high). stats: reversal 56% (F80, P41).
- intraday: `O > bTop1` gap → adapt to `C > H1` (5th closes above 4th's high). Observable then; it is a
  4-bar decline + reversal bar — generic.

### 6.5 breakaway (bull/bear) — TA-Lib `CDLBREAKAWAY`
- rule (TA-Lib `ta_CDLBREAKAWAY.c`, bull): bars 4,3,1 same colour (black), 5th opposite (white); `body4 >
  BodyLong`; `bTop3 < bBot4` (real-body gap down); `H2 < H3 AND L2 < L3 AND H1 < H2 AND L1 < L2` (bars 2
  and 1 make lower highs and lows, bar 2 any colour); 5th `C > O3 AND C < C4` (closes inside the gap:
  above the top of bar 3's body, below the bottom of bar 4's body). Bear: mirror.
- stats: bearish breakaway: reversal 63%, **P11** (F98); bullish: 59% (F97, P45).
- intraday: gap in bar 3 → unobservable in strict form; adapted = 4-bar decline where the 5th bar closes
  above the 4th-from-last body top (a "reversal bar that recovers 3 bars"). Rare.

### 6.6 three-line strike (bull/bear) — TA-Lib `CDL3LINESTRIKE`
- rule (TA-Lib `ta_CDL3LINESTRIKE.c`, bull): three white with `C1 > C2 > C3`, `O2` and `O1` each within
  the prior body ± Near (`O2 >= bBot3 - Near AND O2 <= bTop3 + Near`, same for O1 vs bar 2), 4th black
  with `O > C1 AND C < O3` (opens above the 3rd close, closes below the 1st open — one bar erases three).
  Bear: mirror. No body-length requirement in TA-Lib. Theory (Morris): bullish
  continuation. **Bulkowski: bullish 3LS acts as bearish reversal 65%, P2; bearish 3LS acts as bullish
  reversal 84%, P1** — the top two performers in his book, in the *counter*-theory direction (i.e. the
  strike bar's direction wins).
- levels: trade in the strike bar's direction: trigger = close of strike bar (or break of its extreme);
  stop beyond the strike bar's opposite extreme (which is beyond the whole 3-bar run: wide).
- intraday: needs the 4th bar to open beyond C1 (a gap in trend direction) — on 24h data O ≈ C1 so the
  clause is satisfied by ≤1 tick; the strict `O > C1` fails half the time by a tick. Adapt: `O >= C1 - Equal
  AND C < O3` (a single bar that fully retraces three trend bars, i.e. an "outside bar of the 3-bar run").
  **Observable and worth testing** — it is a pure exhaustion-reversal read (3 momentum bars then a full
  engulf), no gap semantic actually needed.

### 6.7 eight / ten / twelve / thirteen new price lines — no TA-Lib
- rule: N consecutive bars each making a new high (Nison: "8–10 new record highs → overbought").
  Formal: run-length `k` = number of consecutive bars with `H > H_prev` (Bulkowski: each bar posts a
  higher high than the previous, no pauses); pattern fires when `k` reaches 8/10/12/13. Nison counts
  "new highs" loosely (closes or highs); use highs and log the convention.
- stats: 8 lines: **bullish continuation 53%** (F52, P90); 10: bearish rev 51% (F69, P100); 12: bullish
  cont 51% (F87, P99); 13: bearish rev 57% (F90, P95). All random.
- intraday: observable; on NQ 1m 8 consecutive higher highs happen in trend legs; the memory note
  `greenfield-firsthour-program.md` ("first-15m CONTINUES not reverses") argues against fading runs.
  Use run-length as a *feature* (§7.9), not a signal.

### 6.8 hikkake modified (5 bars) → 5.19.

---------------------------------------------------------------------------------------------------------

## 7. Modern price-action descriptors (single/dual-bar, timeframe-agnostic)

These are what intraday futures traders actually use; each is a *feature* first and a *setup* second.

### 7.1 inside bar (IB), ii, iii, "ID/NR4"
- rule: `H <= H1 AND L >= L1` (some require strict `<`/`>` on both; TA-Lib hikkake uses strict). ii = two
  consecutive inside bars (`inside(i) AND inside(i-1)`); iii = three. Crabel ID/NR4 = inside bar that is
  also the narrowest of the last 4.
- meaning: contraction; the *mother bar* (bar i-1, or the outermost bar of an ii cluster) defines the
  breakout range. Brooks: ii after a strong move = continuation setup; ii at a level = reversal setup;
  "always a breakout mode".
- levels: trigger = stop order 1 tick beyond mother-bar H (long) / L (short); stop = opposite side of the
  mother bar (or of the inside bar for tight); invalidation = the hikkake (5.19) — a break that closes
  back inside → reverse. Target: mother-bar height ×1–2 (Brooks "measured move").
- stats: no Bulkowski (he has hikkake and harami). Academic: Crabel's ID/NR4 tests (1990, ORB context)
  are in-sample; no modern out-of-sample futures test known. Harami stats (random) apply loosely.
- intraday: fully observable; frequency on 1m NQ ≈ 10–14% of bars (rough estimate — verify on `NQ_ohlcv_1m.csv` before use). **The most useful
  candle-adjacent object for futures because it defines levels, not direction.**

### 7.2 outside bar (OB) / engulfing bar / "reversal bar" (Brooks)
- rule: `H > H1 AND L < L1` (both sides). Brooks' *reversal bar*: bull = bar with lower tail ≥ ~1/3 of
  range and close in upper third (`loRel >= 0.33 AND closePos >= 0.66`) or close above prior close;
  strong if `body > BodyLong`. Engulfing bar in Brooks/Fuller = OB whose close is beyond prior extreme.
- meaning: expansion/two-sided; direction = close location (clv). Brooks: an OB that closes near its
  extreme in the trend direction after a pullback = strong signal bar; an OB in the middle of a range =
  noise; second bar after OB often inside (ioi setup).
- levels: trigger = break of the OB's extreme in close direction; stop = opposite extreme of the OB (wide
  → Brooks: many traders enter on the OB's close with stop beyond, or wait for the next inside bar and use
  its extreme). 
- stats: none formal; Bulkowski engulfing/last-engulfing (4.1/4.13) are the daily analogue.
- intraday: fully observable; a few % of 1m bars (estimate, verify).

### 7.3 NR4 / NR7 (Crabel) and range percentile
- rule: `range == min(range[i-3..i])` (NR4) / `min(range[i-6..i])` (NR7). Better as continuous:
  `rangePct = percentile rank of range among last N bars`, plus `rangeZ` (1.3).
- meaning: volatility contraction → expansion; Crabel used with opening-range breakout on dailies.
- levels: trigger = break of NR bar H/L (Crabel: next-day ORB with stop-and-reverse); stop = other side.
- stats: Crabel 1990 (S&P, bonds etc., in-sample); vol-clustering is the strongest fact in this repo's
  census (memory: greenfield-wave-a-census: "vol clustering #1"), and `vol→vol sizing` survives (R3) —
  i.e. narrow range predicts *lower* subsequent range in the short run, not a breakout. NR7 as a
  breakout timing device intraday is not established.
- intraday: observable; on 1m NQ the NR7 bar is typically a lunch/quiet bar; the daily NR7 (compression
  day) is a legitimate regime feature for the daily book (see macro/breadth work).

### 7.4 wide range bar (WRB) / "trend bar" / "climax bar"
- rule: `range > k × scaleR_tod` (k = 2–3) — or `rangeZ > 2`; trend bar adds `bodyRel >= 0.7`; climax
  bar adds "largest of last N and after a run of ≥3 same-colour bars".
- meaning: information/urgency; Brooks: a big trend bar breaking out = follow-through likely for 1–2 bars
  then pullback ("breakout, then measured move"); a big bar at the *end* of a run = climax/exhaustion.
  Repo evidence: `greenfield-r3-volume-signatures.md` — thrust-fade DEAD (day-weighting artifact); the
  vacuum-program shows 40–100pt 1m bars are thin-book events with no directional read.
- levels: continuation entry on next bar open or on 50% pullback of the WRB (Brooks); stop beyond WRB's
  opposite extreme; fade entry only with next-bar failure (close back inside WRB range).
- intraday: observable; the single most information-rich single-bar feature at 1m (range and close
  location) but *directional* value depends entirely on where it prints.

### 7.5 pin bar (Fuller / Brooks vs hammer)
- Fuller: tail ≥ 2/3 of range (`max(upRel,loRel) >= 0.66`), body inside the opposite third and small,
  the tail must **protrude** beyond surrounding bars (`L < min(L1, L2)` for bull pin — some use L <
  min(L over last 3–5)), best at a level or after a pullback in trend. Brooks' "signal bar with a tail" is
  looser: any bar with a tail ≥ 1/3 and close in the correct third at a plausible reversal point.
  vs hammer: hammer (TA-Lib) uses `lo > 1× body` (tail merely longer than the body) and no protrusion; a
  Fuller pin is a stricter hammer with a *level* clause. The protrusion is the sweep — the useful part.
- levels: Fuller: entry stop 1 tick beyond the nose (H for bull), or 50% retrace limit into the pin's
  range; stop beyond the tail; targets 1:2+. Brooks: entry on break of signal-bar high, stop below its low.
- stats: none academic; hammer stats (60%, random) apply for the shape; the sweep-and-reclaim of a level
  is measured in price-structures 01 (memory: liquidity-research: post-sweep reversal 67.6% on some
  configs).
- intraday: observable; on the order of 1–2% of 1m NQ bars satisfy the 2/3-tail + protrusion rule (estimate, verify).

### 7.6 "signal bar" / "entry bar" (Brooks)
- Not a shape — a *role*: the signal bar is the bar whose extreme is the entry trigger; entry bar is the
  bar in which the stop order fills. Formalize as a small state machine: `signal_bar = i` when a setup
  fires; `entry_bar = first j > i with H_j > H_i + tick` (long); `stop = L_i - tick`; `cancel if L_j < L_i
  before fill` (Brooks: cancel a buy-stop when the signal bar's low breaks) — identical to the
  orchestrator's limit/stop bracket semantics; must be simulated on 1s (CLAUDE.md).

### 7.7 close-location value (CLV) and close-in-third
- `clv = ((C-L)-(H-C))/(H-L) ∈ [-1,1]`; `closePos = (C-L)/(H-L)`. "Close in top third" = closePos ≥ 2/3.
  Continuous, so use it instead of hammer/shooting-star booleans in any model. Larry Williams' "close
  above midpoint" and Chaikin A/D use it. Bulkowski's "close near the high" is `closePos >= 0.75`?
  (his text: "close near the high" — no numeric).
- intraday: with `range_ticks >= 8` gate.

### 7.8 body/range ratio and shadow ratios — `bodyRel`, `upRel`, `loRel` (1.3). Marubozu = bodyRel ≥ 0.9;
  doji = bodyRel ≤ 0.1; spinning top = bodyRel ≤ 0.33 with both shadows ≥ body.

### 7.9 run-length / consecutive-colour count and consecutive higher-high/lower-low count — feature
  behind 3 soldiers, 8 new price lines, Brooks' "consecutive trend bars" (climax after ≥ 5).

### 7.10 gap-relative descriptors for 24h futures — replace "gap" everywhere with the pair
  `gapBody = bBot - bTop1` (real-body gap, in ticks) and `gapWin = L - H1` (window). On NQ 1m
  `gapWin > 0` is rare outside 09:30/18:00 and `gapBody > 0` is common but almost always ≤ 1 tick
  (measure the actual distribution on the 1m file as step zero of any gap-adapted pattern). Use `gapBody >= Near` ("body separation ≥ 0.2×scaleR") as the intraday "star" gap.

---------------------------------------------------------------------------------------------------------

## 8. Intraday-futures observability of gap-dependent patterns

Legend: OBS = observable as written on 24h NQ/ES 1m–1h; ADAPT = observable only with the stated
substitution; NO = effectively unobservable (only at 09:30 RTH open bar, 18:00 Globex reopen, or after
halts) — treat any hit as a session-boundary event, not a candle.

| Pattern | Gap clause | Verdict | Adaptation |
|---|---|---|---|
| Kicking (4.6) | body gap between two marubozu | NO | two opposite BodyLong full-body bars, opens within Equal — label "V2" |
| Abandoned baby (5.3) | shadow gaps both sides of doji | NO | island-lite: star range below/above both neighbours' closes by ≥ Near |
| Morning/evening (doji) star (5.1/5.2) | body gap star | ADAPT | star-lite (no gap, star at extreme of bar 2 range) or body separation ≥ Near |
| Doji star (4.12) | body gap | ADAPT | body separation ≥ Near |
| Tasuki gap (5.16), gap three methods (5.15), side-by-side white (5.14), two black gapping (4.15), upside gap two crows (5.12) | window/body gap | NO | none faithful; use structure (pullback into thrust) instead |
| Piercing / dark cloud (4.3/4.4) | open beyond prior L/H | ADAPT | O ≤ C1 (bull) / O ≥ C1 (bear); keep penetration test |
| On/in-neck, thrusting (4.9) | open below prior L | ADAPT | O ≤ C1; use penetration ratio as continuous feature |
| Separating lines (4.10), meeting lines (4.11) | 2nd opens at 1st open / gap then equal close | NO | "full retrace + belt-hold through O1" |
| Inverted hammer / shooting star (3.8/3.9) | body gap vs prior bar | ADAPT | body beyond prior close (bTop ≤ C1 / bBot ≥ C1) |
| Mat hold (6.2), breakaway (6.5), concealing baby swallow (6.3), ladder bottom (6.4) | gap in one bar | ADAPT/NO | replace with Near separation or close-through-high |
| Three-line strike (6.6) | 4th opens beyond 3rd close | ADAPT | O ≥ C1 − Equal AND closes beyond O3 |
| Tri-star (5.10) | doji body gaps | NO | — |
| Rising/falling window (4.17) | window | NO | session gaps only |
| Hammer/hanging man, engulfing, harami(+cross), tweezers, matching low, homing pigeon, above/below stomach, 3 inside/outside, soldiers/crows, advance block, deliberation, 3 stars south, unique 3 river, stick sandwich (with bBot1>C2), rising/falling 3 methods, 8-13 new price lines, hikkake, all §7 | none | OBS | as written (with tick floors) |

Effective count: of the 61 TA-Lib functions, ~24 depend on a gap; ~14 of those are NO, ~10 ADAPT.

---------------------------------------------------------------------------------------------------------

## 9. Evidence verdict

Daily equities (Bulkowski, 103 patterns, US stocks): most patterns' tested behaviour is 50–60% —
statistically distinguishable from 50% at his sample sizes, but not economically. Consistent themes:
1. **Confirmation-type 3-bar patterns** (three outside up 75%, three inside up 65%, morning star 78%,
   evening star 72%, morning doji star 76%, three white soldiers 82%, three black crows 78%) have the
   highest reversal rates. Caginalp & Laurent 1998 (S&P500 stocks 1992–96) independently found the same
   3-day reversal patterns significant with 2-day forward returns; Lu-Shiu-Liu 2012 (Taiwan) same.
2. **Two-bar and single-bar reversal shapes are ~random** (hammer 60, shooting star 59, harami 53,
   tweezers 52–56, doji variants 50–52). Marshall-Young-Rose 2006 (DJIA 1992–2002, bootstrapped null,
   28 patterns incl. hammer/engulfing/harami/stars): **no value**; Marshall-Young-Cahan 2008 Japan: none;
   Horton 2009 US: none. Taiwan/China papers (Goo 2007; Lu & Shiu 2012; Zhu 2016) find some two-bar
   bullish patterns profitable — emerging-market, short-hold, and mostly not out-of-sample.
3. **A quarter of patterns act opposite to their textbook direction** in Bulkowski's data (inverted
   hammer, hanging man, bearish/bullish harami cross, doji stars, thrusting, matching low, stick
   sandwich, homing pigeon, unique three river, advance block, deliberation, concealing baby swallow,
   both three-line strikes, both gap-three-methods, upside-gap two crows, downside tasuki). Lesson: the
   *direction* attached to a shape is folklore; only the shape+context+breakout-direction is data.
4. High reversal % ≠ tradable: bearish engulfing 79% reversal but P91; three stars in the south 86%
   but P103. Bulkowski's "performance rank" (post-breakout move over 10 days) is the closer proxy for
   trading value; the top of that list is dominated by patterns that are rare (frequency rank > 60):
   3-line strikes, three black crows, evening star, upside tasuki, inverted hammer, matching low,
   bullish abandoned baby, two black gapping, bearish breakaway.

Intraday, and intraday **futures** specifically:
- **Fock, Klein & Zwergel 2005** (J. Derivatives): 19 patterns (hammer, hanging man, engulfing, harami,
  piercing, dark cloud, stars, three soldiers/crows, etc.) on **5-min DAX and Bund futures**, tested
  against a randomization benchmark: **no forecasting value; combining with oscillator filters helped
  marginally**. This is the only published futures-intraday test of candles at this resolution.
- **Duvinage, Mazza & Petitjean 2013** (Quant. Finance): 83 candle rules on **5-min DJIA-30 stocks**
  (5-min bars, several years), SSPA data-snooping correction: about a third beat buy-and-hold before costs, a few after
  costs, **none after both costs and snooping**; automated systems combining the best rules also fail. They
  do note short-horizon predictive content in some shapes — the value is smaller than the spread.
- Bulkowski (thepatternsite FAQ): his candle stats are daily-only; he does not claim intraday validity.
- Chen & Tsai 2020 (GAF-CNN) and similar ML papers demonstrate that CNNs can *recognise* labelled patterns
  (~90% on 8 classes) — a detection result, not a profitability result. Later "candlestick + ML" papers
  that report profits (various 2019–2023) generally lack transaction costs / snooping control.
- This repo's own results (memory): shape-only readers at 1m are dead (thrust-fade, wick-fade without
  absorption volume, vacuum precursors, C1 S/R placebo-equivalence); the survivors are always
  shape **× level × flow/volume** (absorption ≥ 40, LT damping, arrival-speed reversal .65 vs .42).

Net verdict: **candlestick shapes on 1m–1h futures are not a signal source; they are a feature
vocabulary.** Expect any bare-shape strategy to fail the side-matched placebo. The defensible uses are:
(a) confirmation/exit logic (a hikkake / three-outside as the trigger for a level thesis already held),
(b) continuous shape features (`clv`, `bodyRel`, `rangeZ`, run-length, inside/outside flags) fed to a
meta-labeler, (c) daily-bar filters for the daily book (three-bar patterns and NR7 compression days are
the only ones with any external support).

Futures-intraday-viable list (observable + best prior): inside bar / ii / hikkake (5.19, 7.1);
outside bar / three outside up-down (5.5, 7.2); three-line-strike-lite (6.6); star-lite morning/evening
(5.1); rising/falling three methods (6.1); pin bar with protrusion at a level (7.5); WRB/trend bar and
climax count (7.4, 7.9); piercing/dark-cloud-lite as a "reversal bar closing beyond mid1" (4.3/4.4);
tweezers-as-double-tap of a level (4.5). Everything gap-based, all dojis, harami direction, hanging
man/hammer without a level: not viable.

---------------------------------------------------------------------------------------------------------

## 10. Implementation notes for this repo

### 10.1 Feature-vector-first detector (JS sketch; place under `shared/indicators/candles/`)
```js
// features(bars, i, cfg) -> per-bar dict; all lookbacks exclude bar i
function candleFeatures(b, i, cfg) {
  const o=b[i].open,h=b[i].high,l=b[i].low,c=b[i].close;
  const range=h-l, body=Math.abs(c-o), up=h-Math.max(o,c), lo=Math.min(o,c)-l;
  const scaleR=Math.max(atr(b,i,20), medianRange(b,i,60)), scaleB=medianBody(b,i,60), scaleS=medianShadow(b,i,60);
  const tod=cfg.todTable ? cfg.todTable[minuteOfDay(b[i].ts)] : scaleR;
  const floorT=cfg.kTf*cfg.tick;
  const T={
    doji: body<=Math.max(0.10*range,floorT),
    bodyShort: body<0.5*scaleB, bodyLong: body>1.5*scaleB && range/tod>0.8, bodyVeryLong: body>3*scaleB,
    upVShort: up<=Math.max(0.10*range,floorT), loVShort: lo<=Math.max(0.10*range,floorT),
    upShort: up<scaleS, loShort: lo<scaleS,
    upLong: up>Math.max(body,0.5*range), loLong: lo>Math.max(body,0.5*range),
    upVLong: up>Math.max(2*body,0.66*range), loVLong: lo>Math.max(2*body,0.66*range),
    near: Math.max(0.20*scaleR,floorT), far: 0.60*scaleR, equal: Math.max(0.05*scaleR,floorT),
  };
  return { o,h,l,c,range,body,up,lo, color:Math.sign(c-o), bTop:Math.max(o,c), bBot:Math.min(o,c),
    bodyRel:body/range, upRel:up/range, loRel:lo/range, clv:((c-l)-(h-c))/range, closePos:(c-l)/range,
    bodyZ:body/scaleB, rangeZ:range/tod, rangeTicks:range/cfg.tick, ok: range/cfg.tick>=cfg.minRangeTicks,
    inside: h<=b[i-1].high && l>=b[i-1].low, outside: h>b[i-1].high && l<b[i-1].low,
    gapBody: Math.min(o,c)-Math.max(b[i-1].open,b[i-1].close), gapWin: l-b[i-1].high, T };
}
// pattern = pure function of (F[i], F[i-1], ..., ctx[i]) returning {id, dir:+1|-1, trigger, stop, invalid}
```
Patterns then live in a table `{id, nBars, fn, dir, ctxRequired, gapClass:'OBS'|'ADAPT'|'NO'}` so the
same detector can run in TA-Lib-default mode (for cross-checking against `talib` in Python on a sample —
do this once: TA-Lib output for CDLENGULFING/CDLHARAMI/CDL3OUTSIDE etc. on a 10-day slice must match the
`talibMode=true` path bar-for-bar) and in intraday-adapted mode.

### 10.2 Test protocol (non-negotiable, per CLAUDE.md / KNOWABILITY.md)
1. Signal at bar close i; entry = trigger (stop order at pattern extreme ± tick, or next-bar open) —
   simulate fills on the 1s file from the placement instant; exits walk 1s from fill_ts.
2. Context flag T5/T6 (N-bar extreme or a named level) logged with every hit; report with and without.
3. **Side-matched placebo**: same-direction random bars (or same-direction bars matched on rangeZ and
   time-of-day) — candles must beat *that*, not 50%.
4. Report pooled AND day-weighted; count trades/day; frame $/yr at 1–5 MNQ (capacity-constrained target).
5. Because ~25% of Bulkowski's patterns act counter-theory, run every pattern *unsigned* first: measure
   forward return by breakout direction, then assign direction OOS.
6. Suspect fill-bar optimism first if any candle result exceeds PF ~1.3.

### 10.3 Suggested first experiments (cheap, high prior relative to the rest)
- E1: three-outside / hikkake / three-line-strike-lite at N=30 1m extremes vs side-matched placebo, RTH.
- E2: pin bar (Fuller 2/3 tail + protrusion) at prior-day H/L, ONH/ONL, VWAP ±; entry stop beyond nose,
  1s fills; compare with the existing sweep-reversal numbers (liquidity-research).
- E3: `clv`, `bodyRel`, `rangeZ`, run-length as added features to the PCC/Monday/gap-fade meta-labeler —
  do they add anything on top of the level/flow features already there? (Expectation: little.)
- E4 (daily book): NR7 compression day + three-bar reversal on the daily NQ/ES series as regime/timing
  filters for the daily sleeves.

---------------------------------------------------------------------------------------------------------

## Appendix A — Bulkowski table (all 103 + hikkake pair), scraped 2026-08-18 from thepatternsite.com

Columns: pattern | theoretical | tested behaviour | frequency rank | overall performance rank |
best avg 10-day move (market, breakout). Ranks out of 103 (hikkake out of 105), 1 = best.

| pattern | theory | tested | F | P | best 10d |
|---|---|---|---|---|---|
| 8 new price lines | bear rev | bull cont 53% | 52 | 90 | −3.41% (bear, down) |
| 10 new price lines | bear rev | bear rev 51% | 69 | 100 | −1.95% (bear, down) |
| 12 new price lines | bear rev | bull cont 51% | 87 | 99 | +2.07% (bull, up) |
| 13 new price lines | bear rev | bear rev 57% | 90 | 95 | −4.38% (bear, down) |
| abandoned baby, bearish | bear rev | bear rev 69% | 96 | 64 | +5.34% (bear, up) |
| abandoned baby, bullish | bull rev | bull rev 70% | 92 | 9 | −10.31% (bear, down) |
| above the stomach | bull rev | bull rev 66% | 32 | 31 | −4.86% (bear, down) |
| advance block | bear rev | bull cont 64% | 65 | 54 | −4.76% (bear, down) |
| belt hold, bearish | bear rev | bear rev 68% | 19 | 63 | +4.58% (bear, up) |
| belt hold, bullish | bull rev | bull rev 71% | 22 | 62 | −5.20% (bear, down) |
| breakaway, bearish | bear rev | bear rev 63% | 98 | 11 | +6.66% (bull, up) |
| breakaway, bullish | bull rev | bull rev 59% | 97 | 45 | −5.79% (bear, down) |
| candle, black | rev or cont | cont 52% | 3 | 82 | −6.00% (bear, down) |
| candle, white | rev or cont | cont 51% | 4 | 68 | −4.82% (bear, down) |
| candle, short black | rev or cont | rev 52% | 50 | 66 | +3.61% (bear, up) |
| candle, short white | rev or cont | rev 52% | 54 | 85 | −2.62% (bear, down) |
| collapsing doji star | bear rev | bear rev 63% | 101 | 97 | +7.32% (bull, up) |
| concealing baby swallow | bull rev | bear cont 75% | 103 | 101 | −7.10% (bull, down) |
| dark cloud cover | bear rev | bear rev 60% | 46 | 22 | +5.36% (bear, up) |
| deliberation | bear rev | bull cont 77% | 48 | 93 | −6.72% (bear, down) |
| doji, dragonfly | bull rev/indecision | rev 50% | 44 | 98 | −5.02% (bear, down) |
| doji, gapping down | bear cont | bull rev 56% | 57 | 88 | +2.52% (bull, up) |
| doji, gapping up | bull cont | bear rev 57% | 49 | 92 | +2.35% (bull, up) |
| doji, gravestone | indecision/bear rev | bear rev 51% | 42 | 77 | +5.09% (bear, up) |
| doji, long-legged | indecision | bull cont 51% | 41 | 37 | +4.62% (bear, up) |
| doji, northern | bear rev | bull cont 51% | 6 | 83 | +3.17% (bull, up) |
| doji, southern | bull rev | bull rev 52% | 8 | 78 | +3.51% (bear, up) |
| doji star, bearish | bear rev | bull cont 69% | 43 | 51 | −5.77% (bear, down) |
| doji star, bullish | bull rev | bear cont 64% | 53 | 49 | +5.46% (bear, up) |
| downside gap three methods | bear cont | bull rev 62% | 84 | 26 | −5.02% (bear, down) |
| downside tasuki gap | bear cont | bull rev 54% | 68 | 23 | +4.69% (bear, up) |
| engulfing, bearish | bear rev | bear rev 79% | 11 | 91 | −5.92% (bear, down) |
| engulfing, bullish | bull rev | bull rev 63% | 12 | 84 | −6.31% (bear, down) |
| evening doji star | bear rev | bear rev 71% | 81 | 30 | +6.20% (bear, up) |
| evening star | bear rev | bear rev 72% | 71 | 4 | +8.77% (bear, up) |
| falling three methods | bear cont | bear cont 71% | 91 | 89 | +4.58% (bull, up) |
| falling window | bear cont | bear cont 67% (stopped in gap 25%) | 23 | — | — |
| hammer | bull rev | bull rev 60% | 36 | 65 | −4.12% (bear, down) |
| hammer, inverted | bull rev | bear cont 65% | 61 | 6 | +7.74% (bear, up) |
| hanging man | bear rev | bull cont 59% | 16 | 87 | −3.60% (bear, down) |
| harami, bearish | bear rev | bull cont 53% | 26 | 72 | −4.01% (bear, down) |
| harami, bullish | bull rev | bull rev 53% | 25 | 38 | +4.05% (bear, up) |
| harami cross, bearish | bear rev | bull cont 57% | 45 | 80 | −3.13% (bear, down) |
| harami cross, bullish | bull rev | bear cont 55% | 47 | 50 | +4.52% (bear, up) |
| high wave | indecision | rev 51% | 17 | 67 | −3.38% (bear, down) |
| hikkake, bearish | bear (confirmed) | bear cont 50% | 18 | 83/105 | −5.65% (bear, down) |
| hikkake, bullish | bull (confirmed) | bull cont 52% | 16 | 84/105 | +4.97% (bear, up) |
| homing pigeon | bull rev | bear cont 56% | 34 | 21 | +4.76% (bear, up) |
| identical three crows | bear rev | bear rev 79% | 83 | 24 | +10.03% (bear, up) |
| in neck | bear cont | bear cont 53% | 62 | 17 | +6.34% (bear, up) |
| kicking, bearish | bear rev | bear rev 54% | 102 | 102 | +3.90% (bull, up) |
| kicking, bullish | bull rev | bull rev 53% | 100 | 96 | +2.78% (bull, up) |
| ladder bottom | bull rev | bull rev 56% | 80 | 41 | −7.07% (bear, down) |
| last engulfing bottom | bull rev | bear cont 65% | 13 | 48 | +4.85% (bear, up) |
| last engulfing top | bear rev | bull cont 68% | 14 | 79 | −4.42% (bear, down) |
| long black day | cont | cont 53% | 9 | 19 | +6.30% (bear, up) |
| long white day | cont | cont 58% | 10 | 53 | −6.21% (bear, down) |
| marubozu, black | cont | cont 53% | 30 | 57 | +5.33% (bear, up) |
| marubozu, closing black | cont | cont 52% | 18 | 43 | +5.82% (bear, up) |
| marubozu, closing white | cont | cont 55% | 15 | 70 | −5.36% (bear, down) |
| marubozu, opening black | cont | cont 52% | 5 | 58 | +4.63% (bear, up) |
| marubozu, opening white | cont | cont 54% | 7 | 75 | −4.37% (bear, down) |
| marubozu, white | cont | cont 56% | 27 | 71 | −4.79% (bear, down) |
| mat hold | bull cont | bull cont 78% | 93 | 86 | −7.21% (bull, down) |
| matching low | bull rev | bear cont 61% | 58 | 8 | +7.15% (bear, up) |
| meeting lines, bearish | bear rev | bull cont 51% | 63 | 16 | +7.16% (bear, up) |
| meeting lines, bullish | bull rev | bull rev 56% | 72 | 18 | +5.08% (bear, up) |
| morning doji star | bull rev | bull rev 76% | 78 | 25 | −6.25% (bear, down) |
| morning star | bull rev | bull rev 78% | 66 | 12 | −8.53% (bear, down) |
| on neck | bear cont | bear cont 56% | 70 | 33 | +8.32% (bear, up) |
| piercing pattern | bull rev | bull rev 64% | 40 | 13 | −6.57% (bear, down) |
| rickshaw man | indecision | cont 51% | 55 | 35 | +4.22% (bear, up) |
| rising three methods | bull cont | bull cont 74% | 88 | 94 | −5.10% (bull, down) |
| rising window | bull cont | bull cont 75% (stopped in gap 20%) | 20 | — | — |
| separating lines, bearish | bear cont | bear cont 63% | 82 | 40 | +8.36% (bear, up) |
| separating lines, bullish | bull cont | bull cont 72% | 76 | 36 | −8.05% (bear, down) |
| shooting star (1 line) | bear rev | bear rev 59% | 37 | 55 | +3.86% (bear, up) |
| shooting star (2 lines) | bear rev | bull cont 61% | 51 | 52 | −4.93% (bear, down) |
| side-by-side white lines, bearish | bear cont | bear cont 56% | 86 | 29 | +7.86% (bear, up) |
| side-by-side white lines, bullish | bull cont | bull cont 66% | 73 | 46 | −6.07% (bear, down) |
| spinning top, black | indecision | rev 51% | 1 | 73 | −3.36% (bear, down) |
| spinning top, white | indecision | rev 50% | 2 | 69 | −3.63% (bear, down) |
| stick sandwich | bull rev | bear cont 62% | 59 | 14 | +7.43% (bear, up) |
| takuri line | bull rev | bull rev 66% | 28 | 47 | −4.45% (bear, down) |
| three black crows | bear rev | bear rev 78% | ~60 | 3 | (page not parsed; from book) |
| three inside down | bear rev | bear rev 60% | 33 | 56 | +4.93% (bear, up) |
| three inside up | bull rev | bull rev 65% | 31 | 20 | −7.00% (bear, down) |
| three line strike, bearish | bear cont | bull rev 84% | 94 | 1 | −8.81% (bull, down) |
| three line strike, bullish | bull cont | bear rev 65% | 95 | 2 | +16.91% (bear, up) |
| three outside down | bear rev | bear rev 69% | 21 | 39 | +6.30% (bear, up) |
| three outside up | bull rev | bull rev 75% | 24 | 34 | −7.14% (bear, down) |
| three stars in the south | bull rev | bull rev 86% | 99 | 103 | −3.64% (bull, down) |
| three white soldiers | bull rev | bull rev 82% | 67 | 32 | −7.66% (bear, down) |
| thrusting | bear cont | bull rev 57% | 56 | 15 | −5.92% (bear, down) |
| tri-star, bearish | bear rev | bear rev 52% | 77 | 76 | −4.29% (bear, down) |
| tri-star, bullish | bull rev | bull rev 60% | 79 | 28 | +5.11% (bear, up) |
| tweezers bottom | bull rev | bear cont 52% | 39 | 44 | +4.95% (bear, up) |
| tweezers top | bear rev | bull cont 56% | 35 | 81 | −3.21% (bear, down) |
| two black gapping | bear cont | bear cont 68% | 29 | 10 | +6.45% (bear, up) |
| two crows | bear rev | bear rev 54% | 64 | 61 | −4.84% (bear, down) |
| unique three river bottom | bull rev | bear cont 60% | 89 | 60 | −5.60% (bear, down) |
| upside gap three methods | bull cont | bear rev 59% | 85 | 27 | +4.92% (bull, up) |
| upside gap two crows | bear rev | bull cont 60% | 75 | 74 | −5.50% (bear, down) |
| upside tasuki gap | bull cont | bull cont 57% | 74 | 5 | −9.20% (bear, down) |

Reading the "best 10-day" column: the largest moves are almost all in **bear markets** and often in
the direction *opposite* the pattern's name (e.g. bearish meeting lines +7.16% on an up breakout) —
i.e. Bulkowski's performance is mostly regime beta, not pattern alpha.

## Appendix B — TA-Lib CDL function → catalog section map (61 functions)

CDL2CROWS 5.12 · CDL3BLACKCROWS 5.6 · CDL3INSIDE 5.4 · CDL3LINESTRIKE 6.6 · CDL3OUTSIDE 5.5 ·
CDL3STARSINSOUTH 5.8 · CDL3WHITESOLDIERS 5.6 · CDLABANDONEDBABY 5.3 · CDLADVANCEBLOCK 5.7 ·
CDLBELTHOLD 3.10 · CDLBREAKAWAY 6.5 · CDLCLOSINGMARUBOZU 3.10 · CDLCONCEALBABYSWALL 6.3 ·
CDLCOUNTERATTACK 4.11 · CDLDARKCLOUDCOVER 4.4 · CDLDOJI 3.1 · CDLDOJISTAR 4.12 · CDLDRAGONFLYDOJI 3.3 ·
CDLENGULFING 4.1 · CDLEVENINGDOJISTAR 5.2 · CDLEVENINGSTAR 5.1 · CDLGAPSIDESIDEWHITE 5.14 ·
CDLGRAVESTONEDOJI 3.4 · CDLHAMMER 3.6 · CDLHANGINGMAN 3.7 · CDLHARAMI 4.2 · CDLHARAMICROSS 4.2 ·
CDLHIGHWAVE 3.11 · CDLHIKKAKE 5.19 · CDLHIKKAKEMOD 5.19 · CDLHOMINGPIGEON 4.8 · CDLIDENTICAL3CROWS 5.9 ·
CDLINNECK 4.9 · CDLINVERTEDHAMMER 3.8 · CDLKICKING 4.6 · CDLKICKINGBYLENGTH 4.6 · CDLLADDERBOTTOM 6.4 ·
CDLLONGLEGGEDDOJI 3.2 · CDLLONGLINE 3.11 · CDLMARUBOZU 3.10 · CDLMATCHINGLOW 4.7 · CDLMATHOLD 6.2 ·
CDLMORNINGDOJISTAR 5.2 · CDLMORNINGSTAR 5.1 · CDLONNECK 4.9 · CDLPIERCING 4.3 · CDLRICKSHAWMAN 3.2 ·
CDLRISEFALL3METHODS 6.1 · CDLSEPARATINGLINES 4.10 · CDLSHOOTINGSTAR 3.9 · CDLSHORTLINE 3.11 ·
CDLSPINNINGTOP 3.11 · CDLSTALLEDPATTERN 5.7 · CDLSTICKSANDWICH 5.13 · CDLTAKURI 3.3 · CDLTASUKIGAP 5.16 ·
CDLTHRUSTING 4.9 · CDLTRISTAR 5.10 · CDLUNIQUE3RIVER 5.11 · CDLUPSIDEGAP2CROWS 5.12 ·
CDLXSIDEGAP3METHODS 5.15.

Not in TA-Lib but in this catalog: four-price doji, tweezers, matching high, last engulfing, above/below
the stomach, two black gapping, windows, 8–13 new price lines, and all §7 price-action descriptors.
TA-Lib outputs ±100 (pattern with direction) or 0; several functions return ±100 for both directions
(engulfing, harami, 3 inside/outside, kicking, belt hold, star families) — the sign is the textbook
direction, which per §9 should be treated as a label to be tested, not a trade side.

## Appendix C — Academic references
- Caginalp G., Laurent H. (1998) "The predictive power of price patterns", Applied Mathematical Finance
  5:181–205. S&P500 stocks 1992–96; 3-day reversal patterns; significant excess 2-day returns.
- Fock J.H., Klein C., Zwergel B. (2005) "Performance of candlestick analysis on intraday futures data",
  Journal of Derivatives 13(1):28–40. 5-min DAX & Bund futures; 19 patterns; randomization benchmark;
  no value; oscillator filters help slightly.
- Marshall B.R., Young M.R., Rose L.C. (2006) "Candlestick technical trading strategies: Can they create
  value for investors?", J. Banking & Finance 30:2303–2323. DJIA stocks 1992–2002; bootstrap; no value.
- Marshall, Young, Cahan (2008) "Are candlestick technical trading strategies profitable in the Japanese
  equity market?", Rev. Quant. Finance & Accounting 31:191–207. No.
- Goo Y.-J., Chen D.-H., Chang Y.-W. (2007) "The application of Japanese candlestick trading strategies
  in Taiwan", Investment Management & Financial Innovations 4(4):49–71. Some patterns profitable (in-sample).
- Horton M.J. (2009) "Stars, crows, and doji: the use of candlesticks in stock selection", Quarterly Rev.
  of Economics & Finance 49:283–294. Little value.
- Lu T.-H., Shiu Y.-M., Liu T.-C. (2012) "Profitable candlestick trading strategies — the evidence from a
  new perspective", Review of Financial Economics 21:63–68. Taiwan; three-day patterns profitable.
- Lu T.-H., Shiu Y.-M. (2012) "Tests for two-day candlestick patterns in the emerging equity market of
  Taiwan", Emerging Markets Finance & Trade 48(S1):41–57.
- Duvinage M., Mazza P., Petitjean M. (2013) "The intra-day performance of market timing strategies and
  trading systems based on Japanese candlesticks", Quantitative Finance 13(7):1059–1070. 5-min DJIA-30;
  SSPA; nothing survives costs + snooping.
- Zhu M., Atri S., Yegen E. (2016) "Are candlestick trading strategies effective in certain stocks with
  distinct features?", Pacific-Basin Finance Journal 37:116–127. China; some.
- Chen J.-H., Tsai Y.-C. (2020) "Encoding candlesticks as images for pattern classification using
  convolutional neural networks", Financial Innovation 6:26. GAF-CNN, 8 patterns, ~90% classification.
- Bulkowski T.N. (2008) Encyclopedia of Candlestick Charts, Wiley; thepatternsite.com.
- Nison S. (2001) Japanese Candlestick Charting Techniques, 2nd ed.; Morris G. (2006) Candlestick
  Charting Explained, 3rd ed.; Crabel T. (1990) Day Trading with Short Term Price Patterns and Opening
  Range Breakout; Brooks A. (2012) Trading Price Action Trends/Trading Ranges/Reversals; Chesler D. (2004)
  "Trading false moves with the hikkake pattern", Active Trader.
