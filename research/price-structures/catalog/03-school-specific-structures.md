# 03 — School-Specific / Less-Common Price Structures (OHLCV-only)

Catalog of price structures from Al Brooks, Wyckoff/VSA, Harmonics, Elliott/Wolfe, ICT/SMC and a grab-bag of
"other" schools (Crabel, Raschke, Williams, Ross, Grimes, Volman, Darvas, Donchian, Market Profile, ORB...),
each reduced to a **formal, code-ready rule over OHLCV bars, swings, ATR and volume averages**. Nothing here
requires order flow, options or DOM. Target instruments: NQ/ES intraday (1m-1h) and daily.

Sections
0. Conventions + shared primitives (read first — every rule below assumes these)
1. Al Brooks price action
2. Wyckoff + Volume Spread Analysis
3. Harmonic patterns
4. Elliott Wave / NEoWave / Wolfe Wave
5. ICT / Smart Money Concepts
6. Other schools (Darvas, Donchian, ORB, Market Profile, squeeze, Crabel, Raschke, Williams, Ross, Trader Vic, Grimes, Volman, gaps, reversals, traps)
7. Equivalence / synonym table (dedupe map for the detector engine)
8. Mechanical-definedness ranking + evidence summary
9. Detection-engine notes (shared primitives, state machines, pitfalls)
10. Sources

Field key used for every structure:
- **id** — stable snake_case identifier for the engine
- **school** — origin
- **type** — `setup` (entry-able), `context` (regime/state that conditions other setups), `event` (single-bar/single-moment occurrence)
- **bias** — long / short / both / none
- **rule** — pseudocode over `bars[i] = {o,h,l,c,v,ts}`, `atr(n)`, `avgvol(n)`, `swings`
- **state** — what is "emerging" (partial, still mutable) vs "confirmed" (fixed; the bar/close that seals it)
- **levels** — trigger, invalidation (stop), target
- **evidence** — published stats / academic tests; "none" is stated explicitly
- **overlap** — near-synonyms elsewhere in this catalog or in the classical catalog (01/02)
- **pitfalls** — detection traps (lookahead, repainting, rollover, tolerance drift)

---

## 0. Conventions + shared primitives

All later pseudocode assumes these helpers. Implement once, reuse everywhere (see §9).

```
bar         = {o,h,l,c,v,ts}
range(b)    = b.h - b.l
body(b)     = |b.c - b.o|
upperWick   = b.h - max(b.o,b.c);  lowerWick = min(b.o,b.c) - b.l
closePos(b) = (b.c - b.l) / range(b)            # 0 = close at low, 1 = close at high; NaN if range==0
bodyPct(b)  = body(b) / range(b)
atr(n)      = Wilder ATR over n bars, computed on bars < i only (never include the bar being classified)
avgvol(n)   = SMA of v over the prior n bars (exclude current bar)
avgrng(n)   = SMA of range over prior n bars
dir(b)      = sign(b.c - b.o)  (+1 bull, -1 bear, 0 doji)

Bar taxonomy (Brooks-style, parameterised):
  TREND_BAR(b, k=0.60)  := bodyPct(b) >= k
  DOJI_BAR(b, k=0.30)   := bodyPct(b) <= k        # "doji" in Brooks' loose sense, not the candlestick strict doji
  BIG_BAR(b, m=1.5)     := range(b) >= m * atr(14)  # "displacement" / climax-candidate
  INSIDE(b, p)          := b.h <= p.h and b.l >= p.l
  OUTSIDE(b, p)         := b.h >  p.h and b.l <  p.l
  UP_BAR(b, p)          := b.c > p.c   (VSA convention: close vs PRIOR close, not vs own open)
  DOWN_BAR(b, p)        := b.c < p.c

Swings (fractal pivots):
  swingHigh(i, L)  := h[i] > max(h[i-L..i-1]) and h[i] >= max(h[i+1..i+L])   # confirmed only at bar i+L  (!! L-bar lag)
  swingLow(i, L)   := l[i] < min(l[i-L..i-1]) and l[i] <= min(l[i+1..i+L])
  Typical L: 1 (Ross/Williams "swing"), 2-3 (Brooks micro), 5 (LuxAlgo internal), 10-50 (LuxAlgo swing / structural)
  ZigZag(pct or ATR-mult) alternative: reversal threshold = k*atr; pivots confirmed only after reversal of k*atr.
  Both are lagging: swing/zigzag pivots are only *known* after confirmation → never let a rule reference a
  pivot before its confirmation bar (classic repaint bug).

Structure labels (SMC/Dow): HH, HL, LH, LL from alternating swing pivots.
Dealing range: last confirmed swingLow→swingHigh (or reverse) in current structure; midpoint = EQ.

Volume convention: NQ/ES intraday volume has a strong U-shaped intraday seasonality. Use avgvol relative to the SAME
time-of-day (e.g., ratio to the 20-day mean volume for that minute-of-day) for anything volume-conditioned
(VSA/Wyckoff), otherwise every 09:30 bar is "climactic".

Tolerance conventions:
  Fibonacci ratio hits: ±3-5% of the ratio value is common in retail scanners (e.g., 0.618 → 0.587..0.649).
    Carney's own texts treat the numbers as exact "harmonic ratios" but every implementation uses a window; use
    ±0.03 absolute for retracements, ±0.05 for extensions, and record the tolerance with each hit.
  Level equality (equal highs/lows, double tops): within eq_thr * atr(14), eq_thr default 0.10 (LuxAlgo) - 0.25.
  "At" a level (touch): within 0.10-0.25 * atr, or ≤ 2 ticks intraday NQ.
```

Session conventions for NQ/ES: RTH 09:30-16:00 ET; ICT killzones: London 02:00-05:00, NY AM 07:00-10:00 (or 08:30-11:00),
NY PM 13:30-16:00 ET; Market Profile IB = 09:30-10:30 ET. Trading-day boundaries for "daily" high/low raids: RTH day
vs. Globex day (18:00 ET open) — pick one and be consistent; ICT uses the 00:00 ET "true day open" and the 18:00 open.

---

## 1. Al Brooks price action ("Trading Price Action" trilogy: Trends / Trading Ranges / Reversals)

Brooks' vocabulary is enormous and largely discretionary; the items below are the ones with a defensible bar-level
definition. Brooks trades the 5-min ES almost exclusively, uses a 20-EMA, and reads every bar as a "signal bar" whose
high/low is the entry stop. **Evidence for the whole school: none published (Brooks' own books contain no statistics;
his "80%" and "60/40" numbers are stated heuristics, not measurements).** Overlaps: many Brooks names are relabels of
classical patterns (flags, wedges, double tops), see §7.

### brk_trend_bar / brk_doji_bar — Trend bar vs doji bar
- school: Brooks · type: event · bias: trend bar carries dir(b); doji none
- rule: `TREND_BAR(b, 0.60)`; strong trend bar additionally `closePos ∈ top/bottom 20%` and `range ≥ avgrng(20)`.
  `DOJI_BAR(b, 0.30)`; Brooks: "a bar with a body of about 1/3 or less of the range" and mid-range close.
- state: sealed at bar close (intrabar body ratio changes constantly — never classify a forming bar).
- levels: trend-bar high/low = signal-bar stops for the next bar's entry (buy 1 tick above bull bar high).
- evidence: none. Candlestick literature (Marshall/Young/Rose 2006, DJIA) finds no value in single-bar patterns.
- overlap: Marubozu / long-body candle; VSA "wide spread" bar; ICT "displacement candle" (with ATR filter).
- pitfalls: bodyPct undefined when range==0 (1m NQ Globex bars); ATR normalisation needed across sessions.

### brk_always_in — Always-in direction (context)
- school: Brooks · type: context · bias: long/short state
- rule (one workable operationalisation; Brooks gives none):
  ```
  ai = flat
  on bar close b:
    if TREND_BAR(b) and dir(b)=+1 and b.c > max(h[i-3..i-1])  and (BIG_BAR(b) or 2 consecutive bull trend bars): ai = long
    if TREND_BAR(b) and dir(b)=-1 and b.c < min(l[i-3..i-1])  and (BIG_BAR(b) or 2 consecutive bear trend bars): ai = short
    # optional: require close beyond EMA20 in that direction, or a completed swing HH/HL structure
  ```
- state: flips on the close of the qualifying breakout bar; "emerging" while a large bar is forming.
- levels: none directly; conditions all other Brooks setups (with-trend only).
- evidence: none. Equivalent to any regime filter; validate like a trend filter (e.g., EMA slope, Donchian state).
- overlap: SMC market-structure trend (last BOS direction); Dow trend; ICT "daily bias".
- pitfalls: any always-in rule whipsaws in trading ranges (which Brooks says is ~80% of the time); the definition
  is circular in his books ("the direction most traders believe...").

### brk_spike_and_channel — Spike and channel
- school: Brooks · type: context/setup · bias: with the spike, then reversal at channel end
- rule:
  ```
  SPIKE: >=3 (Brooks: "several") consecutive bars same dir, each TREND_BAR, closes near extreme, little overlap
         (each bar's close beyond prior bar's extreme), total move >= 2*atr(14) — often the first bars of the day
  CHANNEL: after spike, price continues in same dir but with overlapping bars, pullbacks, slope < spike slope
           (regress closes: slope_channel < 0.5*slope_spike), lasting >= 10 bars
  Signal: channel is expected to be broken and price to "test the start of the channel" (the pullback bottom after spike)
  ```
- state: spike confirmed after 3rd bar close; channel labelled after ~10 bars; "end of channel" not knowable in advance
  (only via a wedge/climax reversal signal, see brk_wedge).
- levels: target of the eventual channel break = start of channel (first pullback low after spike). Measured move
  from spike (spike height projected from spike end) is Brooks' first target for the channel itself.
- evidence: none.
- overlap: Elliott 1-2-3-4-5 with extended 3 ("spike" ≈ wave 3, channel ≈ wave 5); "trend day" in Market Profile;
  Grimes' "impulse then pullback" model.
- pitfalls: slope comparisons must be ATR-normalised; overnight vs RTH ATR differ 2-3x.

### brk_trend_from_open — Trend from the open
- school: Brooks · type: context · bias: direction of first bars
- rule: within the first 3-5 RTH bars (5m; 15-25 1m bars), price moves ≥1.0*ATR(daily)*0.25 (or ≥ 2*atr5m(14))
  in one direction with ≤1 pullback bar and no bar closing back through the open of the day → "trend from the open,
  small pullbacks"; expect ~60-70% (Brooks' claim) of day to trend. Trigger a with-trend pullback buy at first
  High-1 (see brk_second_entry).
- state: emerging in first 3 bars; labelled at bar 5 close.
- levels: day open + first pullback = invalidation; target = measured move of opening leg / prior day range.
- evidence: none from Brooks. Related published: opening-range breakout literature (Zarattini & Aziz 2023) supports
  "early-move continuation" on stocks/QQQ; project's own greenfield first-hour work: first-15m CONTINUES not reverses.
- overlap: ORB (§6), Market Profile "open-drive"; ICT AM session power-of-three "distribution".
- pitfalls: opening auction bar of NQ (09:30:00) is often a huge outlier bar; exclude it from ATR/avgvol.

### brk_opening_reversal — Opening reversal
- school: Brooks · type: setup · bias: against the opening move
- rule: within first 60-90 min RTH, price tests a "magnet" (yesterday's high/low/close, overnight high/low, EMA20,
  gap-fill level, or a prior swing) within 0.25*atr, then prints a reversal bar (strong trend bar in opposite
  direction, closePos ≥0.7 for bull) → buy 1 tick above that bar's high (sell below low).
- state: emerging while at magnet; confirmed on the reversal bar's close; entry on next bar break.
- levels: trigger = signal bar high/low; stop = beyond test extreme (opposite end of signal bar or magnet); target
  = opposite side of the opening range, then measured move.
- evidence: none. Project's own results: opening reversals of GEX/LT touches ~random; ES/NQ level-reaction dead.
- overlap: failed ORB / "failure test" (Grimes), turtle soup at prior-day extremes, ICT "judas swing".
- pitfalls: level list is discretionary — enumerate the magnet set explicitly and test each separately.

### brk_breakout — Breakout (bar-level) / breakout with follow-through
- school: Brooks · type: event · bias: breakout direction
- rule: `b.c > max(h[i-N..i-1])` (N=10-20) with TREND_BAR(b) — "breakout bar". Follow-through = next bar also
  trend bar same dir OR closes beyond breakout bar's midpoint. Brooks' strength checklist (count ≥3 = strong):
  big body, close near extreme, small tails, gap between this close and prior high, follow-through bar, several
  bars not pulling back to breakout point.
- state: event at bar close; strength known 1-2 bars later.
- levels: breakout point (broken level) = "breakout test" support; stop below breakout bar low.
- evidence: none Brooks-specific; Donchian/turtle-style breakouts have trend-following literature support at daily
  horizons (Hurst/Ooi/Pedersen 2017), essentially none intraday.
- overlap: Donchian channel breakout; SMC BOS; ORB.
- pitfalls: NQ intraday breakouts overwhelmingly fail (project's C1 research: classic S/R breakouts placebo-equivalent).

### brk_breakout_pullback — Breakout pullback (BOPB)
- school: Brooks · type: setup · bias: with breakout
- rule: after brk_breakout up, first pullback (1-5 bars) that holds at/above the breakout level - 0.25*atr (may
  slightly poke below: "breakout test"), then a bull bar → buy above its high. Brooks: the pullback often ends
  at the breakout point or the EMA.
- state: emerging on first bear bar after breakout; confirmed on the pullback's first bull-bar close.
- levels: trigger = signal bar high; stop = below pullback low; target = measured move (breakout leg height).
- evidence: none.
- overlap: classic "retest of breakout"; SMC "BOS retest / order-block retest"; Ross hook (§6) is essentially the same.
- pitfalls: distinguish from failed breakout: define max pullback depth (e.g., closes ≤ 0.5*atr below level).

### brk_failed_breakout — Failed breakout
- school: Brooks · type: setup · bias: counter to breakout
- rule: `b.h > max(h[i-N..i-1])` (breakout attempt) and within k≤3 bars a close back below the broken level
  (`c[i+k] < level`) with a bear trend bar → sell below that bar. Brooks: "most breakouts in trading ranges fail."
- state: emerging on the poke; confirmed on the close back inside.
- levels: trigger = low of failure bar; stop = above breakout high; target = opposite side of range.
- evidence: none Brooks-specific; overlaps with the best-studied family here (see §7 "sweep/spring/turtle soup").
- overlap: turtle soup, Wyckoff spring/upthrust, ICT liquidity sweep, Grimes failure test, 2B (Trader Vic), bull/bear trap.
- pitfalls: choose N and k explicitly; "level" must be a swing pivot or range extreme, not just any N-bar high.

### brk_measuring_gap — Measuring gap
- school: Brooks · type: event/target · bias: with trend
- rule: in a bull breakout, if `l[i+1] > h[i-1]` (the bar after the breakout bar has its low above the high of the bar
  before it → a gap around the breakout bar), that gap is a measuring gap; target = start of move + (gap midpoint - start)
  i.e., the gap is the midpoint of the total move. Bear: `h[i+1] < l[i-1]`.
- state: confirmed at close of bar i+1.
- levels: target only; gap zone acts as support (if closed back through → measured move void).
- overlap: classical "measuring gap"/runaway gap; ICT FVG (three-bar structure identical!). See §7.
- pitfalls: on 1m NQ these are ubiquitous; require BIG_BAR(i).

### brk_micro_channel — Micro channel
- school: Brooks · type: context · bias: with channel (but breakout against it is the first-leg trade)
- rule: bull micro channel: `n ≥ 3` consecutive bars where `l[j] >= l[j-1]` (no bar's low below prior bar's low);
  strong variant: `l[j] > l[j-1]` and closes rising. Bear symmetric on highs. Track n.
- state: exists from n=3; ends when a bar violates → "micro-channel break". Brooks: first break usually fails →
  buy the failed break ("first pullback in a micro channel usually gets a second leg up").
- levels: after break, buy above the high of the first bull bar that follows (breakout-pullback logic).
- evidence: none.
- overlap: N-bar streak; "stair-step"; Volman "block".
- pitfalls: on 1s/1m data channels of 3 are noise; require n≥5 or ATR-normalised progress.

### brk_tight_trading_range — Tight trading range (TTR)
- school: Brooks · type: context · bias: none (breakout of TTR is the trade; Brooks: don't trade inside)
- rule: `n ≥ 5` bars where `max(h[i-n+1..i]) - min(l[..]) <= 1.5*atr(14)` and consecutive bars overlap ≥50% and
  ≥60% of bars are DOJI_BAR. "Barbwire" (below) is the ≥3-bar tight variant with a doji among big bars.
- state: emerging n≥3, TTR at n≥5; ends on a bar closing outside the range.
- levels: range high/low; breakout with follow-through; first breakout usually fails (fade back into TTR).
- evidence: none Brooks-specific; NR7/ID-NR4 (Crabel) is the daily analogue with tested stats.
- overlap: consolidation/box, Volman box/"block", TTM squeeze, Wyckoff phase B micro, ICT balanced price range.
- pitfalls: overlapping definitions with "trading range" — record n and range/ATR so downstream can threshold.

### brk_barbwire — Barbwire
- school: Brooks · type: context · bias: none (avoid; fade breakouts of it)
- rule: ≥3 consecutive bars, mostly overlapping (each bar's range shares ≥50% with prior), at least one is a
  DOJI_BAR with `range >= avgrng(20)` (a large doji), located around the EMA20 (|c - ema20| < 0.5*atr).
- state: labelled at 3rd bar close.
- overlap: TTR subtype; "chop zone".
- pitfalls: mostly a "do-not-trade" flag; use as a veto feature.

### brk_wedge — Wedge / three pushes (reversal)
- school: Brooks · type: setup · bias: reversal
- rule: three consecutive swing highs (L=2-3) each higher (bull wedge top: HH1 < HH2 < HH3) with the two
  intervening swing lows also rising, AND slope of highs-line < slope of lows-line (converging) OR pushes shrinking
  in size (leg3 < leg2 < leg1 by ≥25% each) — Brooks accepts any "three pushes" even without convergence.
  Signal: bear reversal bar after third push, close below its low → short.
- state: emerging after 2nd push; confirmed on reversal-bar close after 3rd push.
- levels: trigger = signal bar low; stop = above 3rd push high; target 1 = start of wedge (1st push low);
  Brooks: "wedge reversal usually has two legs".
- evidence: none Brooks-specific; classical rising-wedge stats (Bulkowski) exist for daily stocks only.
- overlap: rising/falling wedge; Elliott ending diagonal; Three Drives (harmonic, with Fib ratios); Wolfe Wave.
- pitfalls: swing length choice dominates; three-pushes without convergence catches every trend leg.

### brk_second_entry — High 1 / High 2 / Low 1 / Low 2 (second entry)
- school: Brooks · type: setup · bias: with trend
- rule (bull, in a bull trend / above EMA20):
  ```
  after a pullback begins (a bar with h < prior h), count:
    H1 := first bar whose h > prior bar h                    (first buy signal; entry stop above H1 high)
    if H1 fails (a later bar makes a lower low than the H1 signal-bar low or price makes new pullback low)
       then H2 := next bar with h > prior bar h                (second entry: preferred)
  Low1/Low2 symmetric in bear trends.
  Filter: H2 signal bar should be a bull bar (close > open) — "buy above a bull bar in a bull trend".
  ```
- state: H1 counted at bar close; H2 confirmed at close of the second qualifying bar; entry on next bar break.
- levels: trigger = signal-bar high +1 tick; stop = below signal bar (or below pullback low); target = trend
  extreme then measured move; Brooks: 1:1 scalp then swing.
- evidence: none.
- overlap: "ABC pullback" (Grimes complex pullback = 2 legs = High 2); Ross hook (H1 in a fresh trend); Raschke Holy
  Grail (pullback to EMA in ADX trend).
- pitfalls: legs are counted on the trading TF only; Brooks himself notes counting is discretionary in "complex"
  pullbacks; the mechanical count above will over-generate H2 in trading ranges — require EMA/always-in filter.

### brk_mtr — Major trend reversal (MTR)
- school: Brooks · type: setup · bias: reversal
- rule (bull → bear MTR):
  ```
  1. established bull trend (>= 20 bars above EMA20 or HH/HL structure)
  2. trend-line break: a pullback that closes below the bull trend line (drawn from two prior HLs) — or below EMA20 by > 0.5*atr
  3. test of the extreme: price returns to the old high within tolerance: higher high (HH) or lower high (LH), 
     |test - old_high| <= 1.0*atr   (Brooks: "usually a higher high in a bull MTR")
  4. reversal signal bar at the test (bear trend bar / outside down bar) → sell below its low
  ```
- state: emerging at step 2-3; confirmed on step-4 signal bar close + break of its low.
- levels: stop above the test high; target 1 = pullback low from step 2; MTR expected to have "at least two legs".
- evidence: none.
- overlap: Trader Vic 1-2-3 (identical mechanics!), Joe Ross 1-2-3, double top / 2B, Wyckoff UTAD then SOW, SMC CHoCH.
- pitfalls: "trend line" needs an explicit construction (see §9); test tolerance is the sensitive knob.

### brk_final_flag — Final flag
- school: Brooks · type: setup · bias: reversal (after a failed with-trend breakout of the flag)
- rule: late in a trend (≥3 legs / after climax), a TTR/flag forms; breakout in trend direction fails within ≤5 bars
  (closes back inside the flag) → reversal; target = "measured move down at least to the bottom of the final flag,
  usually beyond". Also: a *breakout* from the final flag that goes far above then reverses = climax.
- state: only knowable in hindsight until the failed-breakout bar; treat as failed_breakout conditioned on trend age.
- levels: trigger = close back inside flag; stop = above failed breakout high; target = flag low then start of leg.
- overlap: failed breakout + trend maturity; Elliott wave-4 triangle then truncated 5th; Wyckoff UTAD.
- pitfalls: "late in trend" needs an explicit measure (legs count, distance from EMA in ATR, bars since trend start).

### brk_trendline_break_test — Trend-line break + test
- school: Brooks · type: setup · bias: reversal (after test) or continuation (if test makes new extreme with strength)
- rule: trend line = line through the last two confirmed HLs (bull); break = bar close below line by > 0.25*atr;
  test = subsequent move back to within 1*atr of the prior trend high; then apply MTR rules.
- state/levels: as MTR step 2-3.
- overlap: MTR, 1-2-3, "trendline break + retest".
- pitfalls: which two pivots define the line changes the outcome; use the most recent two HLs, re-drawn each pivot.

### brk_80pct_rule — "80% rules" (context)
- school: Brooks · type: context · bias: mean-reversion inside ranges, continuation in trends
- rule (Brooks' heuristics, restated as testable statements):
  (a) In a trading range (TTR/range detected), ~80% of breakout attempts fail → fade breakouts.
  (b) In a strong trend (spike/always-in with follow-through), ~80% of reversal attempts fail → buy pullbacks.
  (c) "Markets are in trading ranges ~80% of the time" (context prior).
- state: n/a
- evidence: none published; project's own data: NQ intraday breakouts of classical S/R are placebo-equivalent (C1),
  which is consistent with (a).
- overlap: regime filter; ADX / Choppiness / range-vs-trend classifier.
- pitfalls: circular unless "trading range" and "strong trend" are defined ex-ante (use §9 regime classifier).

### brk_climax_bar — Climax bar / buy-climax / sell-climax
- school: Brooks · type: event · bias: reversal (after 2-3 climaxes) or exhaustion
- rule: BIG_BAR(b, 2.0) trend bar after ≥ 10 bars of trend and |c - ema20| ≥ 2*atr; or 2-3 consecutive big
  trend bars accelerating (each range > prior). Brooks: "consecutive climaxes → trading range likely; a climax
  followed by a strong opposite bar is a reversal signal".
- state: event at close; reversal only after the opposite-direction bar.
- levels: reversal trigger = below climax bar low (bull climax); stop above climax high; target = EMA20 / start of climax.
- evidence: none Brooks-specific; overlaps with VSA "climactic action" and generic "extension bar" mean-reversion which
  does have some published support (short-horizon reversal after extreme moves in index futures).
- overlap: VSA buying/selling climax, Wyckoff SC/BC, ICT displacement (opposite reading!), extension bar (§6).
- pitfalls: on NQ 1m the largest bars cluster at 09:30, 10:00 data, 14:00 FOMC — condition on time-of-day.

### brk_20_gap_bar — 20-gap-bar rule (EMA gap bars)
- school: Brooks · type: context · bias: with trend
- rule: "gap bar" (bull) := `l[j] > ema20[j]` (bar entirely above the EMA). If ≥ 20 consecutive gap bars occur, the
  trend is very strong; the FIRST pullback that touches/goes below the EMA is a buy (High 1/High 2 at EMA) with
  expectation of a test of the trend high. Bear symmetric.
- state: count reaches 20 → armed; fires on first EMA touch after arming.
- levels: trigger = high of the first bull bar at the EMA; stop = below pullback low; target = trend high.
- evidence: none.
- overlap: Raschke Holy Grail (ADX>30 + pullback to EMA20) — nearly identical setup with an ADX rather than
  gap-bar count as strength proxy.
- pitfalls: EMA period is TF-specific (Brooks 20 on 5m); on 1m use 100-EMA to approximate.

### brk_ii_ioi — ii / ioi patterns
- school: Brooks · type: setup · bias: breakout direction (Brooks: with the always-in direction preferred)
- rule: `ii` := INSIDE(b[i], b[i-1]) and INSIDE(b[i-1], b[i-2]) (two consecutive inside bars);
  `ioi` := INSIDE(b[i], b[i-1]) and OUTSIDE(b[i-1], b[i-2]). Enter on break of the last inside bar's high/low;
  stop = other side of the ii/ioi. "iii" = three inside bars.
- state: sealed at close of the second inside bar; entry on next-bar break.
- levels: trigger = last bar's h/l ± 1 tick; stop = opposite side; target = measured (height of the outer bar or 2R).
- evidence: none Brooks-specific; inside-bar breakouts (Crabel ID) have Crabel's stats on daily data.
- overlap: Crabel inside day / ID-NR4; Volman "double doji break"; NR7 family; classic "inside bar" pattern.
- pitfalls: consecutive inside bars on 1m NQ are frequent in Globex; require the range of the mother bar ≥ 1*atr.

### brk_magnets_measured_move — Magnets & measured moves
- school: Brooks · type: target · bias: n/a
- rule: measured-move targets: (a) leg-1 height projected from pullback end (AB=CD in harmonic terms);
  (b) spike height projected from spike end; (c) trading-range height projected from breakout (classical);
  (d) measuring gap (above); (e) "magnets": prior day H/L/C, EMA, round numbers, range extremes, gap fills —
  enumerate as a level list.
- overlap: harmonic AB=CD (§3), classical measured move; SMC "draw on liquidity" (prior H/L, EQH/EQL).
- pitfalls: level lists blow up combinatorially; treat as target candidates, not signals.


## 2. Wyckoff + Volume Spread Analysis (VSA)

Wyckoff (1930s) is a narrative model of accumulation/distribution "schematics" with named events; Tom Williams'
VSA ("Master the Markets", 1993/2005; TradeGuider) is the bar-level reduction: **spread (range) × close position ×
volume, each relative to recent averages, plus the prior bar direction**. Both are OHLCV-native — the "effort" is
volume, the "result" is spread/close, so they are the most naturally implementable volume schools here.
**Evidence: no peer-reviewed tests of Wyckoff schematics or VSA bar rules; TradeGuider's own claims are unaudited.**
Academic volume-price work (Karpoff 1987 survey; Blume/Easley/O'Hara 1994 on volume as information) supports the
*premise* that volume conditions price moves, not these specific rules.

Volume normalisation for NQ/ES (critical): `relvol(b) = v / avgvol_sameTimeOfDay(20d)`; VSA texts use "compared with
the previous two bars" and "vs 30-bar average" — implement both: `v > v[i-1] and v > v[i-2]` (local) and
`relvol thresholds` (global). Ultra-high := relvol ≥ 2.0 (or ≥ 2σ log-volume); high ≥ 1.5; low ≤ 0.7; ultra-low ≤ 0.5.
Spread: wide := range ≥ 1.5*avgrng(30); narrow := range ≤ 0.6*avgrng(30). Close position via closePos().

### wy_schematic — Accumulation / distribution schematic (phases A–E) as a state machine
- school: Wyckoff · type: context (multi-event) · bias: accumulation long / distribution short
- rule (accumulation; distribution mirrors on the high side with BC/AR/ST/UT/UTAD/SOW/LPSY):
  ```
  Phase A (stopping the prior downtrend):
    PS  (preliminary support): first bar in a downtrend with relvol >= 1.5 and wide spread and closePos >= 0.4 (buying appears)
    SC  (selling climax):  BIG_BAR bear, relvol >= 2.0 (ultra-high), wide spread, closePos >= 0.35 (close off lows) — marks range LOW candidate
    AR  (automatic rally): the rally after SC, ends at first swingHigh(L) — marks range HIGH; AR height >= 1.5*atr
    ST  (secondary test): return toward SC low with LOWER volume (relvol < SC relvol * 0.6) and narrower spread; may undercut SC by <= 0.5*atr
  Phase B (building the cause): oscillation between AR high and SC/ST low for >= N bars (N >= 10 on daily; >= 30 on 5m);
    additional STs, "minor" SOS/SOW; volume declining on tests
  Phase C (test): SPRING/SHAKEOUT := bar (or bars) with l < rangeLow (SC/ST low) - 0..0.5*atr and close back >= rangeLow
    within <= 3 bars; volume classification: #1 spring high vol+wide (needs re-test), #2 moderate, #3 low vol (best)
    TEST := after spring, a low-volume (relvol <= 0.7) narrow-spread down move that holds above spring low
  Phase D (mark-up begins inside range): SOS (sign of strength) := wide-spread bull bar, relvol >= 1.5, close near high,
    closing ABOVE the range's mid / AR high ("jump across the creek" (JAC) := close > rangeHigh); 
    LPS (last point of support) := pullback after SOS with low volume, narrow spread, holding above spring/mid;
    BU (back-up to the edge of the creek) := pullback to the broken rangeHigh from above
  Phase E: trend; range no longer relevant.
  ```
- state: each event confirmed on its bar close (spring needs the close-back-inside); phases only labelled after
  the next event; the schematic is only "confirmed" at SOS/JAC — before that it is indistinguishable from a
  continuation range.
- levels: spring low = stop for longs from the spring/test/LPS entries; AR high / rangeHigh = breakout trigger
  (JAC) and BU support; target = "cause" via point-and-figure count: `count = (#columns of the range in P&F) * boxSize * reversal`,
  OHLCV approximation: `range width in bars × avgrng` — treat as measured move = range height × k (k=1..3).
- evidence: none quantitative. The spring/upthrust component is the same object as turtle soup / liquidity sweep
  (see §7) which has anecdotal (Raschke) and project-internal (pre-RTH sweep 90.5% OOS side, post-sweep reversal 67.6%)
  support.
- overlap: SC ≈ Brooks sell climax ≈ VSA climactic action; AR/ST ≈ range; spring ≈ turtle soup ≈ failed breakout ≈
  ICT sweep ≈ Grimes failure test ≈ 2B; SOS+LPS ≈ breakout-pullback ≈ SMC BOS + retest; UTAD ≈ bull trap.
- pitfalls: on NQ intraday, the schematic labels are almost entirely post-hoc; a mechanical detector should emit
  the atomic events (climax bar, range, spring, test, SOS, LPS) and let the composite be a scored feature.
  Rollovers shift range levels — flush on symbol change (CLAUDE.md).

### wy_effort_vs_result — Effort vs result (law 3) as a bar feature
- school: Wyckoff/VSA · type: event · bias: divergence signals reversal/absorption
- rule: `effort = relvol(b)`, `result = range(b)/avgrng(30)` and/or `|c - c[i-1]|/atr`.
  Anomaly A (effort >> result): relvol ≥ 2.0 and result ≤ 0.8 → absorption / hidden supply-demand (in an up move: supply
  entering = bearish; in a down move: demand = bullish). Anomaly B (result >> effort): relvol ≤ 0.7 and result ≥ 1.5 →
  "no supply/no demand" ease of movement — continuation-friendly in the move's direction (thin book).
- state: sealed at bar close.
- evidence: none for the rule; the project's vacuum program found thin-book big candles (result >> effort) are a
  fragility footprint with no direction — consistent with "no direction, just regime" reading.
- overlap: VSA no-demand/no-supply/stopping-volume are all sub-cases; "volume-price divergence".
- pitfalls: futures volume in Globex is tiny — restrict to RTH or normalise by time-of-day.

### vsa_no_demand — No demand (bar)
- school: VSA · type: event · bias: bearish (in a downtrend/after weakness = confirms weakness; in an uptrend = warning)
- rule: `UP_BAR(b, prev)` (close > prior close) and `range(b) <= 0.6*avgrng(30)` (narrow) and `v < v[i-1] and v < v[i-2]`
  (Williams: "volume less than the previous two bars") and `closePos(b) <= 0.5` (close mid or low). Stronger if
  relvol ≤ 0.7. Context: after a sign of weakness (upthrust / climactic up-bar).
- state: at bar close; VSA then requires confirmation = next bar down.
- levels: sell below no-demand bar low; stop above its high (or above the prior swing high).
- evidence: none.
- overlap: Brooks "weak bull bar in a bear trend" / small doji at resistance; ICT "inefficient rally".
- pitfalls: extremely frequent on 1m; combine with location (at range top / after upthrust) or it is noise.

### vsa_no_supply — No supply
- school: VSA · type: event · bias: bullish
- rule: `DOWN_BAR(b, prev)` and narrow spread and `v < v[i-1] and v < v[i-2]` and `closePos(b) >= 0.5`. Context: after a
  sign of strength (stopping volume / shakeout). Williams' "test" is a no-supply bar that dips into a prior high-volume
  area and closes back mid/high.
- state/levels: mirror of no_demand; buy above bar high, stop below its low.
- overlap: Wyckoff "test" after spring; Brooks "weak bear bar in bull trend"; ICT retracement into OB "with low volume".

### vsa_stopping_volume — Stopping volume
- school: VSA · type: event · bias: bullish (end of down move)
- rule: down move in progress (≥3 down bars or c < ema20 - 1*atr); bar b: `DOWN_BAR` or new low, `relvol >= 2.0`
  (ultra-high), wide spread, `closePos(b) >= 0.5` (close mid or high — "close off the lows"). Variant: 2-3 consecutive
  high-volume down bars with closes progressively higher in range.
- state: at close; "confirmed" by a subsequent no-supply/test bar.
- levels: bar low = key support (Wyckoff SC low); long trigger = a subsequent test holding above it.
- evidence: none.
- overlap: Wyckoff SC/PS; Brooks sell climax + reversal bar; hammer with volume; ICT "sweep + displacement" if the
  low took out a prior low.
- pitfalls: same as climax bars — time-of-day volume clustering.

### vsa_upthrust — Upthrust (UT)
- school: VSA · type: event · bias: bearish
- rule: `b.h > max(h[i-N..i-1])` (new high over N=10-20 or above range high), `range(b) >= 1.2*avgrng(30)`,
  `closePos(b) <= 0.25` (close near low), and either high volume (relvol ≥ 1.5, "supply swamped demand") or very
  low volume ("no demand up-thrust"). Wyckoff UTAD := upthrust above the *distribution range high* in phase C.
- state: at close.
- levels: sell below UT low; stop above UT high; target = range low.
- evidence: none.
- overlap: shooting star / pin bar at highs; Brooks failed breakout / bull trap; ICT buy-side liquidity sweep +
  bearish displacement (identical geometry); Trader Vic 2B; turtle soup (sell). See §7.
- pitfalls: this is THE most-duplicated structure in the whole catalog — implement once as `sweep_reversal_bar` and tag.

### vsa_test — Test (after supply removed)
- school: VSA · type: event · bias: bullish
- rule: after a high-volume down bar / spring / shakeout within the last K bars, a bar with `l` dipping toward or into
  that bar's range, `relvol <= 0.7`, `range <= avgrng(30)`, `closePos >= 0.5`. Successful test = low volume; failed
  test = high volume (supply still present).
- levels: buy above test bar high; stop below spring/shakeout low.
- overlap: Wyckoff spring test / LPS; Brooks second entry after a climax; ICT "retest of the sweep low / OB".

### vsa_climactic_action — Climactic action (buying / selling climax)
- school: VSA · type: event · bias: reversal warning
- rule: `relvol >= 2.5` (ultra-high, e.g. > 2.5σ log-vol) with wide spread after an extended move (≥ 2*atr from
  ema20), close position: selling climax closePos ≥ 0.35 (off lows), buying climax closePos ≤ 0.65 (off highs) —
  a climax bar closing at its extreme is *not* a climax by VSA rules but "professional support/selling with follow-through".
- overlap: Wyckoff BC/SC; Brooks climax; extension bar; ICT — no equivalent (ICT reads it as displacement/continuation).
- evidence: none for the rule; short-horizon reversal after volume-spike extremes has mixed academic support in equities.

### vsa_effort_bars — Effort-to-rise / effort-to-fall (with & without result)
- school: VSA · type: event · bias: with effort if result present; against if not
- rule: effort to rise = up bar, wide spread, high volume, closePos ≥ 0.7 → bullish continuation ("result").
  Effort to rise *no result* = same volume but next bar fails to make progress (h[i+1] <= h[i], closes lower) → bearish
  (absorption). Mirror for effort to fall.
- state: needs one bar of follow-through to classify → confirmed at i+1 close.
- overlap: wy_effort_vs_result; Brooks breakout with/without follow-through; ICT displacement.

### wy_jump_across_creek / wy_lps — JAC + LPS/BU (breakout + retest)
- school: Wyckoff · type: setup · bias: long
- rule: JAC := bull bar closing above the range high (AR high) with relvol ≥ 1.3 and wide spread; LPS/BU := within
  ≤ 10 bars, a pullback whose low ≥ rangeHigh - 0.5*atr, low volume, then a bull bar → buy above it.
- levels: stop below LPS low (or below range midpoint for wide stop); target = range height × k.
- overlap: brk_breakout_pullback, SMC BOS + retest / breaker, Ross hook, classical breakout-retest.
- pitfalls: same as breakout pullback; the volume conditions are the only Wyckoff-specific addition.

### wy_utad / wy_sow_lpsy — Upthrust after distribution, SOW, LPSY (mirror of spring/SOS/LPS)
- school: Wyckoff · type: setup · bias: short
- rule: UTAD := after ≥ N bars of range, bar with h > rangeHigh + 0..0.5*atr and close back < rangeHigh within ≤3 bars
  (volume high preferred); SOW := wide-spread bear bar closing below range mid/low on high volume; LPSY := low-volume
  rally failing below the broken level → sell.
- overlap: vsa_upthrust; bull trap; turtle soup sell; ICT buy-side sweep + CHoCH.


## 3. Harmonic patterns (Gartley 1935 → Pesavento 1997 → Carney "Harmonic Trading" vol.1-3)

All harmonic patterns are 4-leg (X-A-B-C-D) or 5-point (0-X-A-B-C for Shark/5-0) swing structures whose leg
lengths must satisfy Fibonacci ratio windows. Detection = (1) get alternating swing pivots (ZigZag with ATR or %
threshold), (2) for each 5-pivot window test the ratio table, (3) build the PRZ at D from the overlapping
projections, (4) trade the reversal at D. **Evidence: no peer-reviewed support for any harmonic pattern; Carney's
books have no out-of-sample stats; blog backtests (e.g. QuantifiedStrategies) show roughly coin-flip results, and
the ratio windows are wide enough that pattern frequency depends almost entirely on the ZigZag threshold.**

Notation: `XA = |A - X|`, `AB = |B - A|` etc. Retracement `r_AB = AB/XA` (B point retrace of XA), `r_BC = BC/AB`,
projection `p_BC = CD/BC` (D as extension of BC), `r_XA_D = |D-X|... ` we use `ret_D = |A - D| / XA` (D's retracement of XA
measured from A) — bullish pattern: X low, A high, B low, C high, D low (buy at D). Tolerance: ±0.03 for
retracements, ±0.05 for extensions unless the pattern spec says a hard bound (Carney's Bat requires B < 0.618 strictly).

Ratio table (bullish and bearish identical in absolute ratios):

| pattern     | B (of XA)          | C (of AB)     | D (of BC ext)  | D (of XA)                    | notes |
|-------------|--------------------|---------------|----------------|------------------------------|-------|
| AB=CD       | n/a                | 0.618–0.786 (alt: 0.382/0.886) | 1.272–1.618 (alt 2.0/2.24)  | CD = AB (1.0) or 1.272/1.618×AB | pure symmetry pattern; time symmetry optional |
| Gartley     | 0.618 (±0.03)      | 0.382–0.886   | 1.13–1.618     | 0.786                        | D=0.786 XA is defining; B must be 0.618 |
| Bat         | 0.382–0.50 (<0.618)| 0.382–0.886   | 1.618–2.618    | 0.886                        | D=0.886 XA; B strictly < 0.618 |
| Alt Bat     | 0.382 (≤0.382)     | 0.382–0.886   | 2.0–3.618      | 1.13                         | D beyond X (extension) |
| Butterfly   | 0.786              | 0.382–0.886   | 1.618–2.618 (Carney: 1.618–2.24) | 1.27 (–1.618)      | D beyond X; B=0.786 defining |
| Crab        | 0.382–0.618        | 0.382–0.886   | 2.24–3.618     | 1.618                        | D=1.618 XA defining, extreme |
| Deep Crab   | 0.886              | 0.382–0.886   | 2.0–3.618      | 1.618                        | B=0.886 |
| Cypher      | 0.382–0.618        | C = 1.272–1.414 ext of XA (C beyond A) | n/a | D = 0.786 retrace of **XC** | (Oglesbee) not Carney |
| Shark       | (0-X-A-B-C) AB=1.13–1.618 XA ext (B beyond A... i.e. point B beyond X in Carney's labeling) | BC = 1.618–2.24 of AB | — | C = 0.886–1.13 of **OX** | 5-0 follows; trade at C |
| 5-0         | AB = 1.13–1.618 of XA (B beyond X)| BC = 1.618–2.24 of AB | CD = 0.50 retrace of BC (D = 50% BC) | AB=CD reciprocal (CD ≈ AB) | trade at D=0.5 BC |
| Three Drives| drives: each new extreme = 1.27 or 1.618 ext of the prior correction; corrections retrace 0.618–0.786 | | | | time symmetry between drives preferred |

### hm_abcd — AB=CD (measured-move with Fib gate)
- school: Harmonic (Gartley/Pesavento/Carney) · type: setup · bias: reversal at D
- rule (bullish): pivots A(high) > B(low) < C(high) > D(low) with `0.618 <= r_BC=|C-B|/|A-B| <= 0.786` (alt 0.382/0.886)
  and D projected at `p = 1.272..1.618` (reciprocal of C retrace: 0.618↔1.618, 0.786↔1.272) AND `|D - C| ≈ |A - B|`
  (CD = AB within ±10%) → PRZ = [C - 1.618*BC .. C - 1.272*BC] ∩ [C - AB ± tol]. Optional time rule: bars(CD) ≈ bars(AB).
- state: emerging once C confirmed (PRZ known in advance — the point of harmonics); confirmed when price enters PRZ and
  prints a reversal bar (Carney "terminal bar" / T-bar: closes back inside after testing PRZ).
- levels: entry at PRZ (limit) or on reversal-bar break; stop beyond PRZ extreme (Carney: beyond 1.618 BC or 1.13
  of the AB=CD); targets 0.382 / 0.618 retrace of AD, then A.
- evidence: none. (Measured-move ABCD is used across schools; Bulkowski's "measured move down/up" daily stats exist.)
- overlap: Brooks measured move / two-legged pullback; Elliott zigzag (A-B-C with C = 1.0–1.618 A); Grimes complex pullback.
- pitfalls: with loose tolerances everything is an ABCD; log the ratio residuals as features rather than binary hits.

### hm_gartley / hm_bat / hm_altbat / hm_butterfly / hm_crab / hm_deepcrab — 5-point XABCD patterns
- school: Harmonic (Carney) · type: setup · bias: reversal at D (bullish: buy at D low; bearish: sell at D high)
- rule (generic detector, bullish; bearish mirrors):
  ```
  for each 5 consecutive alternating pivots (X low, A high, B low, C high, D low):
     XA=A-X; AB=A-B; BC=C-B; CD=C-D
     rB = AB/XA; rC = BC/AB; pD_bc = CD/BC; rD_xa = (A-D)/XA
     match pattern P if all four ratios in P's windows (table above), tolerances as noted.
  D is *not yet a pivot* at detection time: PRZ(P) = {A - rD_xa(P)*XA} ∪ {C - pD_bc(P)*BC} ∪ {AB=CD projection}
     → PRZ = tight cluster if the projections agree within 0.5*atr; Carney requires convergence.
  ```
- state: emerging when X,A,B,C confirmed (PRZ projected); "in PRZ" while price is inside; confirmed at reversal bar
  (T-bar) closing back out of the PRZ towards A; invalidated if close beyond the PRZ's far bound by > tol
  (Bat: D beyond X invalid → becomes Alt Bat/Butterfly candidate; Gartley beyond 0.886 → Bat candidate).
- levels: trigger = PRZ touch (limit) or T-bar break; stop = 1.13 XA (Gartley/Bat) or beyond the 1.618/2.24/3.618 BC
  bound (Butterfly/Crab); targets: 0.382 and 0.618 retrace of AD; type-1 (initial reaction) vs type-2 (after
  retest) in Carney's execution model.
- evidence: none peer-reviewed. Informal backtests (QuantifiedStrategies 2023-24 blog series) ~50% WR, PF ~1.
- overlap: Gartley ≈ Elliott 5-3 correction (ABC in a wave-2/4 context); Butterfly/Crab ≈ Brooks failed breakout of a
  range top with a measured-move (D beyond X = sweep of X = liquidity sweep!); Bat ≈ deep pullback (0.886).
  Three Drives ≈ Brooks wedge / three pushes ≈ Wolfe wave (points 1-3-5).
- pitfalls: (1) pivot-detection threshold dominates; (2) many patterns share windows — return all matches with residual
  scores; (3) the "D beyond X" patterns are structurally liquidity sweeps — dedupe with §5/§7; (4) don't allow the D
  pivot to be *known* — PRZ must be projected from C, not fitted after the fact (lookahead trap in most retail scanners).

### hm_cypher — Cypher (Darren Oglesbee)
- rule (bullish): X low, A high, B low with rB = 0.382–0.618; C high beyond A with `(C - X)/(A - X) ∈ 1.272–1.414`;
  D = 0.786 retrace of X→C: `D = C - 0.786*(C - X)`. Trade long at D; stop below X; targets 0.382/0.618 of CD.
- overlap: expanding-then-retrace structure ≈ Elliott irregular flat (B beyond A); SMC "sweep of A then discount OTE".
- evidence: none.

### hm_shark / hm_five_zero — Shark and 5-0
- rule (bullish 5-0 as per Carney): points 0,X,A,B,C,D. `AB = 1.13–1.618 × XA` (B extends beyond X: a failed
  breakout / sweep of X), `BC = 1.618–2.24 × AB` (C extends beyond A... i.e. reverse extension), Shark completion at
  C: `C ∈ 0.886–1.13 of OX retrace/ext`; 5-0 completion `D = 0.50 × BC` (D retraces 50% of BC), often with `CD ≈ AB`
  (reciprocal AB=CD).
- state: Shark PRZ known once B confirmed; 5-0 D known once C confirmed.
- levels: Shark: enter at C, stop beyond 1.13 OX, target 0.5 BC (= the 5-0 D); 5-0: enter at D, stop beyond 0.618 BC.
- overlap: Shark = "failed-breakout of X then extended thrust" ≈ Wyckoff spring + SOS; 5-0 D = 50%-of-range = SMC EQ /
  premium-discount midpoint (identical arithmetic).
- evidence: none.

### hm_three_drives — Three Drives
- rule: three successive extremes D1 < D2 < D3 (bearish reversal after three drives up), each drive `= 1.27 or 1.618 ×`
  the preceding correction, corrections retrace 0.618–0.786 of the prior drive; drives roughly equal in time (±20%).
  Sell after D3 completion (reversal bar); stop above D3; target = correction-2 low then D1.
- overlap: Brooks wedge / three pushes (Fib-gated version), Wolfe wave (points 1,3,5), Elliott ending diagonal.
- evidence: none.

### PRZ construction / invalidation (shared)
- PRZ = intersection/cluster of ≥2 projections: (a) XA retrace/extension for D, (b) BC projection, (c) AB=CD projection.
  Cluster width `w = max - min` of projections; Carney: valid if all lie within a "tight" band — use `w <= 0.5*atr(14)`
  (intraday) or `≤ 1% of price` (daily). Entry zone = [min,max] of cluster.
- Invalidation: close beyond the far bound of the PRZ by > 0.25*atr (or the next larger harmonic ratio: 1.13 for 0.886
  patterns, 1.618/2.24 for extension patterns). Targets: 0.382/0.618 of the AD leg (Carney), or C then A.
- Tolerance conventions in software: TradingView built-in "XABCD" is manual; popular Pine/MT4 scanners use ±5%
  relative on each ratio (0.618 → 0.587–0.649); harmonics.io / Carney's HarmonicTrader software uses ±3%. Record which.


## 4. Elliott Wave (mechanically checkable parts), NEoWave objective rules, Wolfe Waves

**Honest assessment of algorithmic detectability.** Elliott counting is under-determined: for any pivot sequence there
are many admissible labelings across degrees; the three "inviolable" rules prune only a little, and the guidelines
(alternation, channeling, Fibonacci proportions) are soft. Academic literature: essentially none supporting predictive
value; automated EW software (Prechter's EWAVES, MotiveWave, ELWAVE) counts differently on the same data. Treat EW as
(a) a set of *hard-constraint validators* over 5-pivot / 3-pivot windows and (b) a *feature generator* (which admissible
labels exist, ratio residuals) — never as a unique state. Wolfe Waves are geometrically well-defined and cheap to detect
(no evidence either).

Detection primitives: pivots via ZigZag(k*atr) at ≥ 2 thresholds (degrees). A candidate impulse = 6 alternating pivots
p0..p5 (waves 1..5 = legs p0→p1, ..., p4→p5). Candidate zigzag = 4 pivots (A,B,C).

### ew_impulse_rules — Impulse validator (waves 1-2-3-4-5)
- school: Elliott · type: context (labels trend maturity) · bias: with impulse; reversal expected after 5
- rule (bullish impulse; legs L1..L5 = |p1-p0| .. |p5-p4|):
  ```
  R1: wave 2 never retraces > 100% of wave 1:            p2 > p0
  R2: wave 3 is never the shortest of 1,3,5:             L3 > min(L1, L5)      (need p5 to be known; before that: L3 > L1 or accept pending)
  R3: wave 4 does not enter wave-1 price territory:       p4 > p1                (exception: diagonals — allow overlap only in wedge geometry)
  R4 (implied): waves 1,3,5 in trend direction, 2,4 counter; p1>p0, p3>p1, p5>p3 (p5>p3 relaxes for "truncated 5th": p5 <= p3 allowed but flagged)
  Guidelines (score, not veto):
   G1 alternation: (wave2 depth ratio, duration) differs from wave4 (e.g., one > 0.5 retrace and other < 0.5; or sharp vs flat)
   G2 extension: one of 1/3/5 >= 1.618 × each of the other two (usually 3 in futures/stocks)
   G3 Fibonacci: L3 ∈ {1.618, 2.618}×L1 (±10%); L5 ∈ {0.618, 1.0, 1.618}×L1 or L5 = 0.618×(p3-p0); wave2 retrace 0.5-0.618; wave4 retrace 0.236-0.382 (of wave 3)
   G4 channel: line p2-p4 parallel to line p1-p3; wave 5 ends near the upper channel (touch or throw-over)
   G5 wave 4 often ends near the wave-4-of-lesser-degree of wave 3 (i.e., the sub-wave 4 inside wave 3) — needs finer ZigZag
  ```
- state: "emerging" until p5 confirmed by a reversal of ≥ k*atr; wave-5 termination guessed from G3/G4; a labeling
  becomes "confirmed" only when the following correction breaks the 2-4 trend line (canonical EW confirmation).
- levels: after 5, expected ABC correction to the wave-4 zone (p4) — target; invalidation of the impulse count = break
  of p2 (or of p4 by the correction being deeper than the impulse's start).
- evidence: none supportive in peer review; multiple studies (e.g., Kotick 2003 in Bloomberg-type reviews; various
  MSc theses) find inconsistency between counters. Prechter & Frost is the canonical text.
- overlap: wave 1-2-3 ≈ Brooks spike-and-channel; wave 5 ≈ Brooks channel end / wedge; ABC ≈ AB=CD; wave 4 triangle ≈
  TTR/final flag; ending diagonal ≈ wedge/three drives/Wolfe.
- pitfalls: (1) degree ambiguity — run ≥2 ZigZag thresholds and only accept counts stable across both; (2) never
  "count" using pivots not yet confirmed; (3) R2 needs wave 5 to be known — for live use, evaluate a partial count and
  return admissibility flags per rule; (4) NQ intraday impulses often exceed 5 legs (extended 3rd with sub-waves) —
  every extension can also be counted as a higher-degree 1-2-3.

### ew_corrections — Zigzag / flat / triangle geometry validators
- school: Elliott · type: context/setup · bias: end of correction = with prior impulse
- rule (pivots A,B,C after an impulse ending at p5 = start of A; sub-structure not checked unless finer ZigZag available):
  ```
  ZIGZAG (5-3-5): B retraces 0.382–0.786 of A (typ. 0.5–0.618); C = 0.618, 1.0, 1.618 × A (±10%); C beyond A's end.
  FLAT (3-3-5):   B retraces >= 0.90 of A (regular: 0.90–1.05; expanded/irregular: 1.05–1.382 beyond A's start);
                  C ≈ 1.0–1.618 × A; regular flat: C ends near A's end; expanded: C ends beyond A's end (1.05–1.618).
  RUNNING FLAT:   B > 1.0 A, C fails to reach A's end (C < A end) — trend continuation signal.
  TRIANGLE (3-3-3-3-3): 5 legs a,b,c,d,e each retracing 0.618–0.786 of the prior; converging: highs falling, lows rising
                  (contracting; also barrier/expanding variants); e may undershoot; thrust out of triangle = height of the
                  triangle's widest part projected from the breakout.
  DOUBLE/TRIPLE (W-X-Y / W-X-Y-X-Z): combinations — do not attempt to detect mechanically beyond "correction longer than N pivots".
  ```
- state: correction "complete" only when price breaks the 0-B trend line / makes a new impulse-direction extreme;
  emerging while inside.
- levels: end-of-C zones (0.618/1.0/1.618 A projections; the wave-4-of-previous-degree area) = entry zones with-trend;
  invalidation = beyond the impulse start (100% retrace) for a wave-2 correction; beyond p1 for a wave-4 correction.
- overlap: zigzag ≈ AB=CD/measured move ≈ Brooks two-legged pullback; expanded flat ≈ Trader Vic 2B ≈ liquidity sweep +
  reversal (B beyond A's start = sweep of the impulse extreme); triangle ≈ classical symmetrical triangle ≈ TTR/pennant.
- pitfalls: same as impulse; flats vs zigzags are only distinguishable by B depth, so log B depth as a continuous feature.

### neo_rules — NEoWave (Glenn Neely, "Mastering Elliott Wave") objective add-ons worth borrowing
- school: NEoWave · type: validator · bias: n/a
- rule (subset that is mechanical):
  ```
  Rule of Similarity & Balance: adjacent waves of the same degree must be within a factor of ~3 in price OR time
      (i.e., 1/3 <= L[i]/L[i+1] <= 3 or 1/3 <= T[i]/T[i+1] <= 3); otherwise they are of different degree → re-pivot.
  Rule of Proportion/Time: wave 2 and wave 4 durations should not both be trivially short relative to 1/3/5.
  Neely retrace tests for wave labels: m1 relative to m0 and m2 (retracement categories <38.2, 38.2–61.8, 61.8–100, 100–161.8, >161.8) — 
      each category admits a fixed list of possible labels for the middle mono-wave (Neely's tables ch.3). Implementable as a lookup.
  Logarithmic vs arithmetic: use log-price for daily/weekly; arithmetic for intraday futures.
  Post-constructive Rules of Logic: an impulse's following correction should retrace into wave 4 area but not beyond wave 2 start
      in <= the impulse's duration, otherwise the impulse label is wrong ("wave 5 failure to hold").
  ```
- evidence: none. Value = pruning + degree normalisation, making counts less arbitrary.

### wolfe_wave — Wolfe Wave (5-point with EPA line)
- school: Wolfe (Bill Wolfe) · type: setup · bias: reversal at 5 toward the EPA line
- rule (bullish Wolfe = falling structure): pivots 1(low),2(high),3(low),4(high),5(low):
  ```
  p3 < p1              (point 3 lower than point 1)
  p4 < p2              (point 4 lower than point 2); typically p4 > p3 and p4 within the 1-2 range
  p5 < p3              and p5 penetrates (undercuts) the extended trend line through p1-p3 — "5 overshoots the 1-3 line"
  lines(1,3) and (2,4) converge (wedge) — they define the channel; the wave "sweeps" the 3 low
  EPA (estimated price at arrival) = value of the extended line p1→p4 at a future time (target line)
  ETA (estimated time of arrival) = time coordinate where lines 1-3 and 2-4 intersect (apex)
  ```
- state: emerging after p4 (channel drawn, p5 zone = 1-3 line extension); confirmed at p5 reversal bar (close back
  above the 1-3 line after undercut).
- levels: entry at p5 undercut of the 1-3 line (or the reversal bar break); stop below p5 (a few ticks / 0.25 atr);
  target = EPA line (1-4 extension) — moving target, take at ETA-time.
- evidence: none.
- overlap: falling wedge with undercut (classical); Brooks wedge / three pushes; Three Drives (points 1,3,5 with Fib);
  Wyckoff spring at wedge; ICT liquidity sweep of p3 low + reversal to premium (EPA is above); ending diagonal.
- pitfalls: the 5-point requirement plus "p5 beyond 1-3 line" is what separates it from a generic wedge — enforce the
  undercut; EPA target changes with time — store the line, not a price.


## 5. ICT / Smart Money Concepts (OHLCV-detectable parts)

Michael Huddleston (ICT) never published formal definitions; the community converged on the LuxAlgo "Smart Money
Concepts" Pine indicator (most-used SMC script on TradingView) plus a handful of open-source ports. Where a number below
is "LuxAlgo default", it is taken from that script's source (gist mirror; see §10). **Evidence: no academic tests of
any ICT concept. FVG ≡ three-bar gap ≡ Brooks measuring gap; sweep ≡ turtle soup/spring; OTE ≡ 0.618–0.786 retracement;
OB ≈ last opposing candle ≈ "origin of impulse" — all are relabels of older objects, but the *combination* (sweep →
displacement → FVG/OB retrace in killzone) is a specific, testable sequence.** Project-internal: GEX/LT level-reaction
families were placebo-equivalent; sweeps at pre-RTH extremes had a real side-bias (liquidity research memo).

### smc_swing_structure — Swing highs/lows, internal vs swing structure
- school: SMC · type: context · bias: n/a
- rule: LuxAlgo: internal structure uses `L=5` (fractal 5-bar), swing structure `L=50` (user 10–200):
  `swings(len): upper=highest(len); lower=lowest(len); os := high[len] > upper ? 0 : low[len] < lower ? 1 : os[1]`
  → a swing high at bar[len] when it exceeds all `len` bars after it (i.e., confirmed len bars late).
  Labels HH/HL/LH/LL from alternating pivots.
- state: pivot confirmed `len` bars after it prints (5 bars for internal, 50 for swing) — enormous lag at L=50; most
  live traders use fractal L=2–3 ("ICT swing high = a high with lower highs on both sides", i.e., L=1!).
- overlap: Dow/Ross swings; Brooks HH/HL; every school. Implement ONE pivot service with configurable L.
- pitfalls: repaint — never let downstream rules see a pivot before bar i+L.

### smc_bos_choch — Break of Structure / Change of Character / Market Structure Shift
- school: SMC · type: event · bias: BOS with trend, CHoCH/MSS = potential reversal
- rule (LuxAlgo): trend state `t ∈ {-1,0,+1}`. On `close > lastSwingHigh` (candle-close crossover — LuxAlgo uses
  close; many ICT traders accept wick "body close required" is the majority): if `t == +1` → BOS (bullish continuation),
  else (t ≤ 0) → CHoCH (bullish reversal) and set `t=+1`. Symmetric for lows. ICT "MSS" ≈ CHoCH but requires
  displacement (BIG_BAR + FVG on the breaking leg). Internal (L=5) and swing (L=50) structures tracked separately.
- state: event on the closing bar; a wick-only break is *not* a BOS in the LuxAlgo convention (it is a sweep).
- levels: the broken swing becomes the retest zone; the swing that produced the break's origin (last opposing candle)
  = order block; the leg's midpoint = CE/OTE zone.
- evidence: none.
- overlap: Dow trend change; Brooks trend-line break + higher low/lower high; classical higher-high/lower-low breakout;
  Trader Vic 1-2-3 point-3 break (CHoCH ≈ 1-2-3 completion).
- pitfalls: with L=50 on 1m, CHoCH is a lagging, rare object; on L=5 it fires constantly — the pair are different signals.

### smc_fvg — Fair value gap (FVG) / imbalance / BISI-SIBI, consequent encroachment, inversion FVG
- school: ICT · type: event/zone · bias: retrace into gap then continuation (with the impulse)
- rule: three bars i-2, i-1, i: bullish FVG iff `l[i] > h[i-2]` (gap between bar i-2 high and bar i low); zone = [h[i-2], l[i]].
  Bearish: `h[i] < l[i-2]`, zone = [h[i], l[i-2]]. LuxAlgo adds: `c[i-1] > h[i-2]` (middle candle closes beyond) and a
  size filter: `delta_per = (l[i]-h[i-2])/h[i-2]*100 > threshold` where auto threshold = `cum(|delta_per|)/n * 2`
  (2× the running mean gap size) — i.e., FVG must be ≥ 2× the average three-bar gap. Simpler: gap ≥ 0.25*atr(14).
  Consequent encroachment (CE) = gap midpoint `(top+bottom)/2` — ICT entry level inside the FVG.
  Mitigation/fill: partial when price trades into it, full when it trades through the far edge (`l <= bottom` for bullish);
  LuxAlgo removes the FVG once price crosses its far boundary (mitigated); many ports require a close beyond it.
  Inversion FVG (iFVG): a bullish FVG that gets *closed through* (close < bottom) then acts as resistance (retest from
  below → short); mirror for bearish.
  Balanced price range (BPR): a bullish FVG and a bearish FVG overlapping in price (opposite displacements) — the overlap
  zone is the BPR; treated as strong S/R.
- state: FVG sealed at close of bar i (the 3rd bar); CE known immediately; iFVG state changes on the closing-through bar.
- levels: entry at CE or the near edge; stop below the FVG far edge (or the impulse origin low); target = next liquidity
  (EQH/prior high) or the opposing FVG.
- evidence: none academic. Structurally identical to Brooks' measuring gap and to a "runaway gap" on intrabar data;
  Bulkowski gap-fill statistics (daily) are the closest published analogue.
- overlap: brk_measuring_gap (identical three-bar test), classical breakaway/runaway gap, "single prints" in Market Profile
  (a range visited only once during the impulse — same idea in TPO space).
- pitfalls: on 1m NQ, unfiltered FVGs occur ~every 10 bars — the ATR/auto threshold is essential; on 1s data nearly every
  bar pair has one; also many "FVG fill" studies use the fill bar's own high/low → the recurring 1m fill-bar bug (CLAUDE.md).

### smc_order_block — Order block (OB) / breaker block / mitigation block
- school: ICT/SMC · type: zone · bias: with the displacement that left it
- rule (bullish OB): the last bearish candle (`c<o`) before a bullish displacement move that (a) is BIG_BAR (≥1.5-2×atr
  or > 2× mean range — LuxAlgo filter: candle range `< 2×ATR-threshold` is required for the *candle to qualify as OB*
  (excluding freak candles) and (b) creates a BOS/CHoCH (LuxAlgo trigger: OB detected on each structure break, taking the
  lowest-low candle between the swing and the break as the OB source) and (c) ideally leaves an FVG right after it.
  Zone = [OB.l, OB.h] (some use body only [min(o,c), max(o,c)]; ICT: "mean threshold" = 50% of OB body/range).
  Mitigation: price returns into the zone (touch) — LuxAlgo marks internal OB mitigated when price "taps inside"; many
  ports invalidate only on close beyond the far edge.
  Breaker block: a bullish OB that fails (price closes below its low) → the same zone now acts as bearish resistance on
  the retest from below (breaker). ICT's own definition: the swing that ran liquidity (took an old low) then reversed
  — the last down-close candle *before* the run — becomes support once price breaks above the swing high (structure).
  Mitigation block: like a breaker but the swing did NOT take liquidity (failed to make the new low/high).
- state: candidate OB exists after the displacement bar closes; "confirmed" when the BOS/CHoCH prints; mitigated/broken
  states thereafter.
- levels: entry at OB high (bullish) / 50% ("mean threshold") / OB low; stop below OB low (or below the sweep low);
  target = the liquidity above (EQH/prior swing high) or opposing OB/FVG.
- evidence: none.
- overlap: "origin of the impulse" / demand zone (supply-demand school, Sam Seiden) — identical; Brooks: "the bar before the
  breakout / the breakout pullback level"; Wyckoff LPS zone; harmonic: none.
- pitfalls: (1) which candle: last opposing candle vs lowest-low candle vs first candle of the impulse — differ; store
  all three; (2) an OB is only meaningful with the sweep+displacement context; standalone "last red candle before a big
  green candle" is every pullback in a trend.

### smc_liquidity_pools — Equal highs / equal lows (EQH/EQL), relative equal, session/daily highs-lows as liquidity
- school: ICT/SMC · type: level · bias: target of a sweep; after sweep, reversal bias
- rule (LuxAlgo): two swing highs (L=eq_len, default 3) whose difference `max - min < atr * eq_threshold`, eq_threshold
  default 0.10 (range 0–0.5) → EQH; EQL symmetric. "Relative equal" in ICT parlance = same within a few ticks/points
  (allow eq_threshold up to 0.25). Other liquidity pools (level list): previous day high/low (PDH/PDL), previous week
  high/low, session highs/lows (Asia, London, NY AM), overnight high/low, round numbers, old swing highs/lows.
- state: EQH confirmed when the 2nd swing high is confirmed (L bars later); "swept" when a later high > EQH.
- levels: EQH = buy-stop liquidity above → target for longs / sweep-then-short trigger.
- overlap: double top/bottom (classical, with tighter tolerance); Brooks "double top" magnet; Wyckoff range extremes;
  Market Profile "poor high/low" (unfinished auction; a poor high in TPO terms = flat top = EQH!).
- pitfalls: on NQ, "equal" within 0.1 ATR(1m) ≈ 1-2 points; the same double top is also a classical pattern — dedupe.

### smc_liquidity_sweep — Liquidity sweep / stop hunt / stop run / "turtle soup" / judas swing / raid
- school: ICT (also Raschke turtle soup, Wyckoff spring/UT) · type: event/setup · bias: reversal (against the sweep)
- rule: `h[i] > L` where L is a liquidity level (EQH, PDH, session high, swing high) and `c[i] < L` (close back below;
  wick-only violation) — single-bar sweep; multi-bar sweep: `max(h[i..i+k]) > L` and `c[i+k] < L` with k ≤ 3-5.
  Sweep depth `d = (max h - L)/atr` (typical valid: 0.05–1.0 atr; deep = failed sweep → breakout).
  ICT confirmation: sweep followed by displacement in the opposite direction (BIG_BAR) creating an FVG and an MSS/CHoCH
  on a lower TF within N bars.
  Judas swing: the sweep occurs in the first part of a session (London 02:00–05:00 or NY 08:30–10:00) against the
  eventual session direction — i.e., an opening-session sweep of the overnight/Asian high/low then reversal ("power of
  three manipulation phase").
  Daily/session high-low raid: sweep of PDH/PDL or the Asian/London range extremes specifically.
- state: emerging on the wick violation intrabar (NOT tradable until close); confirmed at close back inside; ICT-confirmed
  after displacement + MSS.
- levels: entry at the reclaim (close back inside) or the OB/FVG left by the displacement (retrace); stop beyond the
  sweep extreme; target = opposite side of the range / opposing liquidity pool.
- evidence: none for ICT; Raschke's Street Smarts anecdotal for turtle soup; project-internal: pre-RTH sweep side bias
  90.5% OOS and post-sweep reversal 67.6% (liquidity-research-results memo) — the *one* well-supported object in this section.
- overlap: THE central duplicate: turtle soup ≡ Wyckoff spring/upthrust ≡ Brooks failed breakout / bull-bear trap ≡ Grimes
  failure test ≡ Trader Vic 2B ≡ VSA upthrust ≡ Larry Williams' Oops!-like reversal ≡ harmonic Butterfly/Crab D beyond X ≡
  Elliott expanded-flat B wave. See §7 — implement once as `sweep_reversal` with parameters {level_type, depth, k, close_rule}.
- pitfalls: the sweep is defined intrabar; only the close seals it — the 1m fill-bar bug bites hardest here (an intrabar
  detector that "sees" the reclaim at the bar's own high/low is lookahead). Also, level type matters — treat each level
  type as a separate arm (project GEX/LT levels dead; PDH/PDL and pre-RTH extremes alive).

### smc_premium_discount_ote — Premium/discount, equilibrium, OTE (optimal trade entry)
- school: ICT · type: context/zone · bias: buy in discount (below 50%), sell in premium
- rule: dealing range = [lastSwingLow, lastSwingHigh] of the current structure (LuxAlgo uses trailing extremes:
  premium = top 5% [0.95*hi+0.05*lo, hi], equilibrium band [0.475..0.525], discount = bottom 5%; but ICT's discretionary
  usage = below/above the 50% line). OTE = 0.62–0.79 retracement of the impulse leg (ICT: 62%, 70.5%, 79% levels;
  "sweet spot" 70.5%). Bullish OTE entry: after a bullish leg low→high, price retraces to [high - 0.79*leg, high - 0.62*leg].
- state: known once the leg's swing high is confirmed; invalid once price exceeds the leg's high (new leg) or breaks its low.
- levels: entry OTE 0.705; stop below leg low (or below 1.0); targets: −0.27 / −0.62 extensions (ICT: "−27%, −62%").
- overlap: 0.618–0.786 Fibonacci retracement (universal); harmonic B-point windows; Elliott wave-2 depth 0.5–0.618;
  Brooks "deep pullback / second entry at 60-70%".
- evidence: none beyond generic Fibonacci-retracement literature (which is null).
- pitfalls: identical to standard fib retrace — no need for a separate detector; just add the [0.62,0.79] band.

### smc_displacement — Displacement
- school: ICT · type: event · bias: with the candle
- rule: `range(b) >= k*atr(14)` (k=1.5–2.0; community: 2× ATR or ≥ 2× the average body of the last 20) AND
  bodyPct ≥ 0.7 AND leaves an FVG (`l[i] > h[i-2]` for bullish) — a displacement without an FVG is "just a big candle".
- overlap: Brooks strong trend bar / climax (opposite reading!), VSA effort-to-rise; Bollinger "big bar"; ICT reads
  continuation, Brooks/VSA read exhaustion when late in the move — encode trend-age as a feature.
- pitfalls: NQ 09:30–09:35 and news minutes dominate any ATR-multiple filter; use time-of-day-conditioned ATR.

### smc_power_of_three — Power of three (AMD: accumulation-manipulation-distribution) on session/day opens
- school: ICT · type: context/setup · bias: with the "distribution" leg after manipulation
- rule (candle-level analog): for the session/day candle, a bullish PO3 = open near the low of the eventual range with a
  wick below the open (manipulation) then close near the high. Intraday detection: (1) accumulation := range of the first
  W bars (e.g., Asia 20:00–00:00 or 00:00–02:00 or 09:30–09:45) ≤ 0.6× typical; (2) manipulation := sweep of that
  range's low (buy PO3) — depth ≤ 1 atr — with close back inside; (3) distribution := displacement + BOS above the
  accumulation high. Fire at (3) or at retrace into the FVG/OB after (3).
- state: emerging at (2); confirmed at (3).
- levels: stop below manipulation low; target = session-range projection (accumulation height × 2-3) or PDH.
- overlap: judas swing (step 2); ORB with fake-out (Volman "advanced range break", Raschke turtle soup + ORB); Wyckoff
  spring → SOS; Brooks opening reversal → trend from the open.
- evidence: none.

### smc_session_raid — Daily / session high-low raid & "draw on liquidity"
- rule: level set = {PDH, PDL, PWH, PWL, Asia H/L, London H/L, NY AM H/L, midnight-open, 08:30-open}; event = sweep of
  a level (see smc_liquidity_sweep) or *reach* of a level (target hit). Bias heuristic: which side is nearer/untested;
  ICT: "market seeks the liquidity it hasn't taken".
- overlap: opening reversal magnets (Brooks); Market Profile "prior day value area / range extremes"; classic pivot points.
- pitfalls: level bookkeeping across Globex/RTH day boundaries; contract rollover changes PDH/PDL price space (raw contract).


## 6. Other schools

### 6a. Boxes, channels, opening range, Market Profile, compression

### darvas_box — Darvas box (Nicolas Darvas, "How I Made $2,000,000")
- school: Darvas · type: setup · bias: long (original), symmetric usable
- rule (daily; intraday analog with N bars): (1) new N-period high (Darvas: 52-week/all-time high); (2) box TOP =
  that high once it is NOT exceeded for 3 consecutive bars; (3) box BOTTOM = the lowest low after the top, once it is
  not undercut for 3 consecutive bars; box is then "closed"; (4) buy on `c > boxTop` (Darvas used a buy-stop 1/8 above);
  stop below boxBottom (Darvas: just under the box); (5) boxes stack — new box begins on the breakout; stop trails to the
  bottom of each new box. Volume increase on the breakout was Darvas' filter.
- state: box "forming" until both 3-bar confirmations; confirmed thereafter; breakout event at close above top.
- levels: trigger boxTop; stop boxBottom; target: next box (trend follow) — no fixed target.
- evidence: none academic for Darvas specifically; N-day breakout literature (Donchian/turtle) supports slow daily
  trend following in futures.
- overlap: Donchian breakout with a 3-bar "settled" filter; Brooks TTR breakout; rectangle; SMC BOS + accumulation range.
- pitfalls: the 3-bar settle rule creates a fixed lag; intraday it needs an ATR-minimum box height.

### donchian_breakout — Donchian channel breakout (turtle 20/55; 10-bar exit)
- school: Donchian/Turtles · type: setup · bias: breakout direction
- rule: `long if h[i] > max(h[i-N..i-1])` (N=20 or 55; entry intrabar via stop order in the original; use close-confirmed
  for OHLCV honesty); exit `l < min(l[i-M..i-1])` (M=10 or 20); position sizing by ATR (N=20 "unit"); turtle filter: skip
  the 20-day signal if the previous 20-day signal was a winner (System 1). Intraday: N in bars of the trading TF.
- state: event at bar; channel value known each bar (no lag).
- levels: entry = channel edge (+1 tick); stop = 2×ATR(20) or opposite channel; target none (trailing).
- evidence: strongest of the section at daily horizons — trend-following/time-series-momentum literature (Moskowitz-
  Ooi-Pedersen 2012; Hurst-Ooi-Pedersen 2017 "A Century of Evidence") and Faith's "Way of the Turtle" tests; intraday
  NQ breakouts (project C1) placebo-equivalent.
- overlap: Brooks breakout; SMC BOS (swing-based instead of N-bar); Darvas; ORB is a session-anchored special case.
- pitfalls: on raw-contract data, a rollover gap can trigger a "breakout" — filter symbol changes (CLAUDE.md).

### orb — Opening range breakout (ORB), with range definitions
- school: Crabel (1990) / Raschke / Zarattini-Aziz · type: setup · bias: breakout direction
- rule: opening range OR = [min l, max h] over the first W minutes of RTH (W ∈ {1,5,15,30,60}; Crabel: first 5-min bar
  or the "stretch"); long on `c > OR.high` (or stop order at OR.high + tick, Zarattini/Aziz: enter on the *close of the
  first 5-min bar* in the bar's direction, i.e. W=5 with the direction of bar 1); stop = OR.low (Zarattini/Aziz: 10% of
  the 14-day ATR ≈ tight stop; or the OR midpoint); target = EOD exit (Z/A: hold to close) or R-multiple (10R cap).
  Crabel "stretch": `stretch = SMA_10( min(|open - high|, |open - low|) )` of the last 10 days; ORB entry = open ± stretch.
  Filters: NR7/ID day before (Crabel), gap ≥ 0.5×ATR, relative volume ≥ 1.5 (Zarattini-Barbon-Aziz 2024, stocks),
  OR width relative to ATR (skip if OR > 0.4×daily ATR — wide OR = already-moved).
- state: OR sealed at 09:30+W; breakout event on close/stop; failed ORB = re-entry into OR within k bars (→ opening
  reversal / turtle soup).
- levels: trigger OR.high/low; stop = opposite side / mid / ATR fraction; targets = 1×/2× OR height, PDH/PDL, VWAP.
- evidence: **best-supported intraday setup in this catalog**: Zarattini & Aziz (2023, SSRN "Can Day Trading Really Be
  Profitable?") 5-min ORB on QQQ/TQQQ 2016–2023 with 10%-ATR stop and EOD exit — large excess returns (before robust
  costs; leveraged); Zarattini, Barbon & Aziz (2024, "A Profitable Day Trading Strategy for the U.S. Equity Market")
  ORB on high-relative-volume gapping stocks; Crabel's 1990 tables (S&P/bonds, ORB after NR4/ID days ~ 60-70% WR
  claims, in-sample). Caveat: futures/NQ evidence is thin and project's own first-hour work says the first-15m move
  *continues* (supportive) but B6 (a specific ORB variant) died.
- overlap: Brooks trend-from-the-open (continuation reading) / opening reversal (failed ORB); ICT PO3 distribution
  (breakout after manipulation); Market Profile IB extension (W=60); Volman range break.
- pitfalls: W and the entry rule (close vs stop) change everything; the 09:30 bar of NQ contains the opening auction print.

### mp_initial_balance — Market Profile initial balance (IB), range extension, day-type, POC/VA approximation
- school: Market Profile (Steidlmayer/Dalton) · type: context · bias: extension side
- rule (OHLCV-only): IB = [min l, max h] of 09:30–10:30 ET (first two 30-min TPO periods); `ibw = IB.h - IB.l`.
  Range extension up := any later bar h > IB.h; extension size `ext = (dayHigh - IB.h)/ibw`.
  Day type classifier (Dalton, restated): normal := no extension or ext ≤ 0.5 both sides; normal-variation := ext ≥ 1×ibw
  one side (day range ≈ 2× IB); trend day := ext ≥ 2×ibw one side and closes near extreme (closePos(day) ≥ 0.8) and IB is
  narrow (ibw ≤ 0.35 × ATR20 daily); neutral := extension both sides; neutral-extreme := both sides but close at an extreme;
  double-distribution trend := two separate value clusters (bimodal close histogram) joined by a thin zone.
  Profile shape from 1m closes: histogram of 1m closes (or of all 1m [l,h] coverage) in tick buckets → POC = mode bucket;
  value area = smallest set of contiguous buckets around POC holding 70% of the mass (VAH/VAL); "P" shape (short-covering
  rally: POC in upper third with a thin lower tail) := skew < −0.5; "b" shape := skew > +0.5 (POC lower third with thin upper
  tail); "D" (balanced) := |skew| < 0.3 & single mode. Single prints := 1m-close buckets visited by ≤ 1 bar (proxy for
  TPO single prints ≈ FVG in intraday terms). Poor high/low := the day's extreme bucket has ≥ 2 touches without excess
  (a flat top) → equivalent to EQH/EQL.
- state: IB sealed at 10:30; day type only classifiable progressively (trend-day earliest at ~11:00 when ext ≥ 1×ibw and
  no counter-rotation); profile shape final at close.
- levels: IB.h/IB.l = breakout triggers/first targets; ext targets 1×, 2× ibw; POC/VAH/VAL from prior day = magnets;
  naked POC (prior-day POC untouched) = target.
- evidence: Dalton's books are qualitative; some published work on value-area/POC mean-reversion (mixed); project's own:
  IB/day-type not tested as such. Reasonably well-defined mechanically.
- overlap: ORB(W=60) ≡ IB breakout; ICT session raids ≈ prior VA/POC magnets; TTR ≈ narrow IB; EQH ≈ poor high.
- pitfalls: TPO profiles use 30-min brackets; the 1m-close proxy over-weights fast moves; volume-profile (VPOC) needs
  1m volume allocation — okay on OHLCV if you spread each 1m bar's volume uniformly over its range.

### bb_squeeze / ttm_squeeze — Bollinger squeeze / TTM squeeze as compression
- school: Bollinger / Carter (TTM) · type: context/setup · bias: breakout direction (momentum histogram sign)
- rule: Bollinger: `bandwidth = (upper - lower)/middle` with BB(20,2); squeeze := bandwidth at its N-period low (Bollinger:
  6-month low on daily; intraday N=100–120 bars); breakout in the direction of the first close outside a band; "head fake"
  = first close outside is reversed within 2-3 bars.
  TTM (John Carter): squeeze ON := `BB(20,2.0) upper < KC(20, 1.5×ATR) upper AND BB lower > KC lower` (Bollinger inside
  Keltner); squeeze OFF ("fires") on the first bar Bollinger exits Keltner; direction = sign of momentum histogram
  (`linreg(close - avg(highest(20)+lowest(20))/2, sma20)/2, 20)`); count of consecutive squeeze-on bars = compression length.
- state: squeeze-on is a state; the fire bar is the event.
- levels: entry at fire bar close (or break of squeeze range); stop = opposite Keltner band / squeeze range; target ≈
  squeeze-range height × 2 or trailing.
- evidence: none peer-reviewed; volatility-contraction → expansion is well documented (vol clustering; project Wave A: vol
  clustering is #1), but direction is not predicted by the squeeze itself.
- overlap: Brooks TTR / final flag; NR7/ID-NR4 (single-bar compression); Wyckoff phase B/C; ICT "consolidation → BPR";
  triangles/pennants (classical).
- pitfalls: KC ATR multiplier (1.5 vs 2.0) changes fire frequency ~3×; direction from momentum sign is a lag.

### 6b. Bar-pattern setups (Trader Vic, Ross, Williams, Crabel, Raschke, Grimes, three-bar play, Volman)

### vic_123 / vic_2b — Trader Vic 1-2-3 reversal and 2B (Victor Sperandeo)
- school: Sperandeo · type: setup · bias: reversal
- rule (top): (1) trend line (drawn from the trend's lowest low to the highest minor low preceding the highest high,
  such that it doesn't cut through price) is broken by a close below it; (2) test: price rallies to retest the high and
  fails (LH; tolerance ≤ 1×atr below high, or a marginal new high that fails = 2B); (3) price breaks the low of the
  pullback between the high and the test (the "point 2" low) → short. 2B: `h[i] > priorHigh` (new high) but within ≤ 2-3
  bars closes back below priorHigh → sell (short-term reversal; Vic on daily: "within one day", intraday: 2-3 bars).
- state: emerging at (1)-(2); confirmed on close below point 2 (1-2-3) or on close back below priorHigh (2B).
- levels: 1-2-3: stop above test high; target = measured (height of the last leg) / prior support. 2B: stop above the
  new high; target the point-2 low.
- evidence: none quantitative (Sperandeo's "Trader Vic" gives anecdotal win rates).
- overlap: identical to Brooks MTR; Ross 1-2-3 (Ross labels the same three points on a low); SMC CHoCH (point-3 break)
  and 2B ≡ sweep/turtle soup/upthrust/spring; Wyckoff UTAD ≡ 2B at range top.
- pitfalls: trend-line construction rule must be fixed (Vic's is explicit — use it).

### ross_123_hook — Joe Ross 1-2-3 high/low + Ross hook
- school: Joe Ross ("Trading by the Book") · type: setup · bias: with the new trend
- rule (1-2-3 low): point 1 = swing low (the trend extreme); point 2 = the first swing high after point 1 (first correction
  peak); point 3 = the pullback low after 2 that holds above point 1 (3 > 1); entry = break of point 2 (buy-stop 1 tick
  above 2's high) — Ross uses L=1 swings ("a bar with a higher low on each side"). Ross hook (Rh) = after the 1-2-3
  breakout establishes a trend, the FIRST bar that fails to make a new high (h[i] <= h[i-1]) creates a hook at the
  prior bar's high; buy on the break of the hook (h > hookHigh). "Trader's Trick Entry" (TTE) = enter *before* the
  point-2/hook break, on the break of the high of one of the correction bars (max 3 bars into the correction), to
  front-run stop clusters.
- state: 1-2-3 sealed when point 3 forms (a bar with a higher low after the pullback low); hook sealed at the close of
  the failing bar.
- levels: trigger = point-2 high / hook high; stop = below point 3 / below the correction low; target = measured (1→2
  height) from 3, or trailing on subsequent hooks.
- evidence: none.
- overlap: 1-2-3 ≡ Vic 1-2-3 ≡ Brooks MTR ≡ SMC CHoCH; Ross hook ≡ Brooks High 1 / breakout pullback ≡ SMC BOS-retest;
  TTE ≡ Brooks "entering on the pullback bar's break".
- pitfalls: with L=1 swings on 1m NQ these fire constantly — impose min leg size in ATR (Ross: no rule).

### lw_oops — Larry Williams "Oops!"
- school: Larry Williams ("Long-Term Secrets to Short-Term Trading") · type: setup · bias: reversal of the opening gap
- rule (buy): `open[t] < low[t-1]` (gap down below the prior bar's low — daily; intraday analog: session open below the
  prior session low) then buy-stop at `low[t-1] + 1 tick`; fill only if price trades back up through it that day; stop
  = below the day's low (or 1×ATR); exit next bar's open / first profitable open (Williams' "bailout" exit) or EOD.
  Sell mirror: `open > high[t-1]`, sell-stop at `high[t-1] - tick`.
- state: armed at the open; triggered intraday on the stop; confirmed on fill.
- levels: as above.
- evidence: Williams' own in-sample tables (S&P, bonds, 1980s-90s) — not audited; the gap-fill/gap-fade literature
  on index futures shows a modest historical fill tendency that decays with gap size (various practitioner tests;
  no strong academic result).
- overlap: gap-fade / gap-fill (below); Brooks opening reversal at yesterday's low; ICT PDL sweep at the open + reclaim
  (Oops! is exactly "sweep of PDL by the open, reclaim → long"); Wyckoff spring at the day level.
- pitfalls: futures with 23-hour sessions rarely gap on the Globex day — define the "day" as RTH (prior RTH low vs
  09:30 open) for NQ/ES.

### lw_smash_day — Larry Williams smash day (and hidden smash day)
- school: Larry Williams · type: setup · bias: reversal next bar
- rule (buy smash): bar t closes below the prior bar's low (`c[t] < l[t-1]`, "naked close" — an emotional smash); next
  bar, buy-stop at `h[t] + tick`; if filled → long; stop below l[t]; exit bailout/first profitable open or EOD+1.
  Hidden smash day (buy): `closePos(bar t) <= 0.25` (closes in the lower 25% of its range) but `c[t] >= l[t-1]` — a weak
  close that did *not* break the prior low; buy on next bar break of h[t]. Sell mirrors (close in top 25%, c[t] <= h[t-1]).
- state: smash bar sealed at close; entry next bar on stop.
- levels: trigger h[t]+tick; stop l[t]; target 1×range or bailout exit.
- evidence: Williams' tables (in-sample). None independent.
- overlap: outside/engulfing reversal next bar; Brooks "failed breakout / trap bar"; ICT sweep of previous bar low with
  next-bar reclaim; VSA "climactic down bar followed by up bar".
- pitfalls: on intraday bars this is a 2-bar reversal that fires constantly — Williams used daily bars; add TDW (day of
  week) and trend filters as he did.

### crabel_nr — Crabel NR4 / NR7 / ID / ID-NR4 / WS / 2-bar NR + ORB
- school: Toby Crabel ("Day Trading with Short Term Price Patterns and Opening Range Breakout", 1990) · type: context (day
  before) + setup (ORB the day after) · bias: breakout direction
- rule (daily bars; intraday analog with N bars):
  ```
  NR4  := range[t] < min(range[t-1..t-3])          NR7 := range[t] < min(range[t-1..t-6])
  ID   := h[t] < h[t-1] and l[t] > l[t-1]           ID/NR4 := ID and NR4      (Crabel's favourite)
  WS4/WS7 := range[t] > max(range[t-1..t-3 / t-6])  (wide-spread; fade/continuation contexts)
  2BNR := (range over bars t-1..t) is the narrowest 2-bar range of the last 20 days
  3BNR / 4BNR analogous; NR days cluster → "contraction"
  Next day: ORB with stretch (see orb): buy at open + stretch, sell at open - stretch; stop = other side (or a fixed
  fraction); exit at close (Crabel: same-day). Filters: prior day close vs open, trend context.
  ```
- state: NR/ID labelled at bar close; the setup fires the following bar/session.
- levels: open ± stretch; stop = opposite trigger; target = EOD or ~1×ATR.
- evidence: Crabel's book gives extensive (in-sample, 1982-1990) tables: ID/NR4 + ORB ~ 60-70% winners at close in
  S&P/T-bonds; Connors & Raschke ("Street Smarts") re-used NR7 with claims of edge; independent tests (various
  practitioners, e.g., Kaufman) show the volatility-expansion part is robust (NR days precede wide-range days) but
  direction is not predicted. Second-best-supported family here.
- overlap: TTM/Bollinger squeeze (multi-bar compression); Brooks TTR / ii; SMC accumulation (PO3 step 1); triangle
  apex; Volman "block".
- pitfalls: on NQ daily, use RTH ranges not Globex; the "range" comparison must exclude the current bar from the
  window (Crabel does).

### raschke_turtle_soup — Turtle Soup / Turtle Soup Plus One (Connors & Raschke, "Street Smarts")
- school: Raschke · type: setup · bias: reversal (against a 20-day breakout)
- rule (buy): (1) today makes a new 20-day low (`l[t] < min(l[t-20..t-1])`); (2) the *previous* 20-day low must have
  occurred ≥ 4 days earlier (the low being taken is "old"); (3) once the new low is made, place a buy-stop 5-10 ticks
  above the prior 20-day low; (4) if filled, stop 1 tick below today's low; (5) trail; exit 2-6 days. Plus One: same but the
  entry is taken the *next* day (day t+1 must open ≤ the prior low; buy-stop at prior low). Sell mirror on 20-day highs.
  Intraday: N-bar (20) lows on the trading TF; "prior extreme ≥ 4 bars old".
- state: armed intrabar on the new low; fills on the reclaim stop; confirmed on fill.
- levels: as above; target = middle of the range / opposite side.
- evidence: Street Smarts anecdotal (1995); designed as the fade of the Turtles' Donchian entry; independent tests
  (Connors' later work) mixed; project-internal sweep results (pre-RTH extremes) are the closest supportive data.
- overlap: ≡ liquidity sweep / stop hunt / spring / upthrust / failed breakout / 2B / failure test / Oops! (day-level).
- pitfalls: the "≥4 bars old" rule and the "5-10 ticks above" reclaim are what make it mechanical — keep them.

### raschke_holy_grail — Holy Grail (ADX pullback to 20-EMA)
- school: Raschke · type: setup · bias: with trend
- rule: ADX(14) > 30 and rising (adx[t] > adx[t-1]); price pulls back to touch the 20-EMA (l ≤ ema20 for a bull);
  buy-stop at the high of the bar that touched (or the prior bar's high); stop below the pullback low; target = prior
  swing high; if a bar closes back through the EMA in the wrong direction the setup resets.
- state: armed at EMA touch; triggered on the high break.
- evidence: Street Smarts anecdotal; EMA-pullback-in-ADX-trend tested informally many times, no academic result.
- overlap: Brooks 20-gap-bar rule + High 1 at EMA (near-identical); Grimes simple pullback; SMC "OB retest with trend".

### raschke_80_20 — 80-20s (Taylor / Raschke)
- school: Raschke (from George Taylor's Trading Technique via Derek Gipson) · type: setup · bias: reversal of a one-sided bar
- rule (buy): day t opens in the top 20% of its range and closes in the bottom 20% (`(o - l)/range ≥ 0.8` and closePos ≤ 0.2`);
  day t+1: price must trade at least 5-15 ticks (Raschke: 5-15 pts on S&P) *below* day t's low, then place a buy-stop at
  day t's low; if filled, stop just below the day's low; exit same day (day-trade). Sell mirror (open in bottom 20%, close in
  top 20%).
- state: bar t sealed at close; setup fires intrabar t+1 on the reclaim of l[t].
- evidence: Street Smarts anecdotal only.
- overlap: sweep of prior-bar low + reclaim (turtle soup at 1-bar horizon); Williams Oops!/smash day; Brooks trap bar;
  ICT PDL sweep in the AM.

### raschke_anti — Anti (Raschke)
- school: Raschke · type: setup · bias: with the *new* short-term trend after a first pullback
- rule: Street Smarts uses a 7-period %K with 10-period %D (slow stochastic, no extra smoothing): the slow line (%D) has
  turned in the new direction (e.g., up after a low), the fast line (%K) pulls back against it for 3-4 bars while %D keeps
  rising, then %K hooks back in the %D direction → buy on the break of the hook bar's high; stop below the pullback low. Price-only equivalent: after
  the first impulse of a new trend (leg 1), a 3-4 bar shallow pullback (≤ 0.5 of leg 1), buy above the pullback's last bar.
- overlap: Grimes' "Anti" (identical name; Grimes' definition = first pullback in a new trend after a climax + trend-line
  break, entered on the pullback failure); Brooks High 1 after a spike; Ross hook.
- evidence: none.

### grimes_pullbacks — Adam Grimes' pullback taxonomy (simple / complex), Anti, failure test ("The Art & Science of Technical Analysis")
- school: Grimes · type: setup · bias: with trend (pullbacks), reversal (failure test)
- rule:
  ```
  Impulse leg := move ≥ 2×atr (or a "large" swing on the ZigZag) with momentum (Grimes uses a KC(20,2.25×ATR) touch as
      the impulse marker: price closed outside the Keltner channel = "buying climax"/momentum leg).
  Simple pullback := one counter-move (single ZigZag leg) retracing 0.3–0.7 of the impulse, then resumption (new impulse
      extreme). Complex pullback := two-legged (ABC) counter-move: two counter legs separated by a with-trend leg that fails
      to make a new extreme; complex pullbacks are Grimes' preferred entries ("the second leg is where weak hands give up").
  Entry: (a) break of the pullback's last bar high (with-trend), (b) limit at 0.5–0.618 of the impulse, (c) "pullback failure"
      → stop-and-reverse; stop below pullback low; target: 1×impulse from pullback low (measured move) or the trailing KC band.
  Anti (Grimes) := after a climax + trend-line break, the FIRST pullback in the *new* direction; take it (the "anti" of the
      old trend). Same as Brooks' "first pullback after MTR".
  Failure test := price trades beyond a prior swing extreme/level and *fails*: closes back inside within 1-2 bars → enter
      against, stop just beyond the extreme; target the other side of the range. (== sweep/turtle soup/spring.)
  ```
- state: pullback classification changes with each new leg (simple → complex when a second counter leg forms).
- evidence: Grimes reports his own tests (in-sample); no academic. Note: Grimes' book contains an explicit test showing
  classical patterns/candles have no edge unless conditioned on the impulse — consistent with project findings.
- overlap: simple pullback ≡ Brooks High 1 / Ross hook / SMC OB retest; complex ≡ Brooks High 2 / harmonic AB=CD / Elliott
  zigzag; failure test ≡ sweep family.
- pitfalls: "pullback depth" and "leg" both depend on the ZigZag threshold; use ATR-scaled thresholds per TF.

### three_bar_play — Three-bar play (Jared Wesley / "3-bar play")
- school: momentum day-trading · type: setup · bias: continuation
- rule (bull): bar 1 = igniting bar: `range >= 2×avgrng(20)`, bodyPct ≥ 0.7, closePos ≥ 0.8; bars 2 (and 3 for the 4-bar
  play) = "resting" bars: range ≤ 0.5×range(bar1), lows ≥ bar1's midpoint (hold the upper half/third), no close below the
  bar-1 midpoint; entry = break of the resting bar high (or bar-1 high); stop below the resting bar low; target = 1×bar-1
  range projected (measured) / 2R.
- state: sealed at the close of the last resting bar; entry on the break.
- overlap: Brooks "breakout with follow-through then small pullback bar" (a High-1 immediately after a spike); ICT
  displacement + first FVG retrace; bull flag (tiny); Volman "first break".
- evidence: none.
- pitfalls: bar-1 magnitude filter must be time-of-day-normalised on NQ.

### volman_patterns — Bob Volman scalping patterns (Forex Price Action Scalping / Understanding Price Action)
- school: Volman (70-tick / 5m EUR-USD) · type: setup · bias: breakout direction, mostly with the 20-EMA slope
- rule (all require a "pattern line"/level and a break; entry on the break, stop ~ 10 pips → ATR-scaled: 0.5-1×atr):
  ```
  DD  (double doji break): two consecutive small-body bars (bodyPct ≤ 0.3, range ≤ avgrng) sitting on/at the EMA or a
      pattern line after a with-trend move; entry on the break of their combined high (with trend); stop below combined low.
  FB  (first break): after a strong with-trend leg and a shallow sideways cluster (2-4 bars) at the extreme, buy the break of the
      cluster's high — the *first* break of a build-up in a fresh trend.
  SB  (second break): the first break failed (pulled back into the cluster) but held; the second break of the same level is taken.
  BB  (block break): a "block" = 3+ overlapping bars in a tight rectangle (range ≤ 1×atr) after a move; buy the break of the
      block's high; ≈ Brooks TTR breakout / three-bar play.
  RB  (range break): a multi-bar range (≥ 10 bars) with a clear pattern line; entry on the break bar's close/next bar.
  IRB (inside range break): a smaller range forming inside a larger range near its edge; break of the inner range toward the
      outer edge — pre-breakout squeeze at the boundary.
  ARB (advanced range break): the range break was faked (false break returned inside) then re-breaks the same side — take
      the second break ("break, false break, re-break").
  Later book (UPA): pattern break (PB), pattern break pullback (PBP), pattern break combi (PBC), pullback reversal (PR),
      range break (RB) — same objects; PBC = a break followed by a "combi" (2-bar bar-pattern like an ii/inside+trend bar) at
      the level, entry on the combi break.
  ```
- state: build-up/box "forming" while bars overlap; the break bar seals it; ARB requires the failed-first-break history.
- levels: as above; Volman: fixed 20-pip target / 10-pip stop originally (2:1); ATR-scale.
- evidence: none.
- overlap: DD ≡ ii/inside-doji breakout; BB/FB ≡ Brooks TTR/micro-flag breakout ≡ three-bar play; ARB ≡ failed breakout
  then re-breakout ≡ Wyckoff spring → SOS ≡ SMC sweep → BOS; RB ≡ Donchian/rectangle break.
- pitfalls: highly TF-specific (70-tick); on 1m NQ use ATR scaling and the EMA-slope filter.


### 6c. Gaps, extension/mean-reversion bars, single-bar and 2-3-bar reversals, traps

### gap_and_go / gap_fill — Gap structures (session-level)
- school: day-trading folk / Bulkowski gap stats · type: setup · bias: gap-and-go = with gap; gap-fill = against gap
- rule: gap `g = open_RTH[t] - close_RTH[t-1]` (for futures use the RTH close, else the "gap" is the overnight move; both
  useful — tag which); `gs = |g|/ATR20_daily`. Gap-and-go (bull): gs ≥ 0.3, first W=5–15 min hold above `open - 0.25×g`
  (no fill of more than 25% of gap), then break of the opening-range high → long; stop = OR low / gap midpoint;
  target = 1×g / PDH. Gap-fill (fade): gs ∈ [0.2, 1.0], first bars fail to extend (no new high in first 15 min for a gap up),
  short toward `close_RTH[t-1]` (full fill) with a stop above the OR high; partial-fill target = 50% of g.
  Fill statistics feature: fraction of gaps of size bucket filled same day (compute in-sample; equities lit: ~70% of small
  gaps fill; futures decays with size and with trend alignment).
- state: gap known at 09:30; go/fill decision by 09:45.
- evidence: Bulkowski (daily stocks) gap-fill tables; several practitioner tests of ES gap fills (~60-70% for gaps
  < 0.5×ATR); Williams' Oops! is the fade special case; project: gap-fade sleeve in the greenfield BOOK shadow (live).
- overlap: Oops! (fade of gaps that violate the prior day's extreme); Brooks gap-open reversal / trend-from-open;
  ICT: "gap = FVG on the daily" / new-day-opening-gap (NDOG) / new-week-opening-gap (NWOG) as levels; Market Profile
  "open outside value → look for return to value".
- pitfalls: futures "gap" definitions vary (RTH-close vs settlement vs 18:00 open); pick and freeze.

### extension_bar / vwap_extension — Mean-reversion "extension bar" (n×ATR from VWAP/EMA)
- school: mean-reversion / Brooks climax / Grimes KC touch · type: event · bias: fade
- rule: `z = (c - vwap)/σ_vwap` (VWAP standard-deviation bands from session start) or `d = (c - ema20)/atr(14)`;
  extension := |z| ≥ 2 (or |d| ≥ 2–3) AND the bar is a BIG_BAR closing at its extreme; fade trigger = first bar
  closing back inside the band / first opposite-direction trend bar; stop beyond the extension extreme; target VWAP/EMA.
  Grimes' operational marker: close outside KC(20, 2.25×ATR) = "overextended".
- state: event at close; trade on the reversal bar.
- evidence: short-horizon reversal after extreme intraday deviations has some support in equity index futures
  (practitioner and some academic short-term reversal literature); project's own vol-cluster finding says big bars
  predict big bars (variance), not direction — treat direction as unproven.
- overlap: Brooks climax; VSA climactic action; Wyckoff SC/BC; Bollinger band walk (opposite: continuation!).
- pitfalls: "band walk" in trend days makes naive fades bleed — condition on day type (MP trend day) / ADX.

### key_reversal / outside_reversal — Key reversal day / outside reversal bar
- school: classical (Edwards & Magee, Schabacker) · type: event · bias: reversal
- rule: key reversal (top): `h[t] > h[t-1]` (new high — often above an N-bar high) and `c[t] < c[t-1]` (close below the
  prior close; strict version: `c[t] < l[t-1]`); high volume preferred. Outside reversal (bearish engulfing on OHLC):
  `h[t] > h[t-1] and l[t] < l[t-1] and c[t] < o[t] and c[t] < c[t-1]` (outside bar closing down); strong if closePos ≤ 0.2.
- state: at close.
- levels: sell below l[t]; stop above h[t]; target = prior swing low.
- evidence: Bulkowski's daily stats for outside days (weak); candlestick engulfing tests (Marshall et al. 2006) null.
- overlap: engulfing candle; Brooks outside-down bar / reversal bar; VSA upthrust (if at range top with volume);
  ICT: single-candle sweep + displacement; Williams smash-day (partial).
- pitfalls: on 1m, outside bars are frequent — condition on location (at an N-bar extreme).

### hook_reversal — Hook reversal (day)
- school: classical (Bulkowski catalogues "hook reversal") · type: event · bias: reversal
- rule (top): `o[t] > h[t-1]` (opens above the prior high, or within 0.1×atr of it) and `c[t] < c[t-1]` (closes below the
  prior close) and `range[t] < range[t-1]` (range narrower than the prior bar) — a narrow reversal bar after a gap-open
  beyond the prior extreme. Bottom mirrors (`o[t] < l[t-1] and c[t] > c[t-1] and range[t] < range[t-1]`).
- overlap: Oops!-style gap-open reversal on a small bar; harami-like; Brooks "gap-open failed breakout".
- evidence: none.

### pivot_point_reversal — Pivot point reversal (3-bar swing reversal)
- school: classical/Larry Williams · type: event · bias: reversal
- rule (top): bar t-1 has `h[t-1] > h[t-2] and h[t-1] > h[t]` (a 3-bar swing high, L=1) and bar t closes below the low
  of bar t-1 (`c[t] < l[t-1]`) → sell; stop above h[t-1]. Bottom mirror. (Sometimes called "swing reversal"/"pivot
  reversal"; the L=1 swing + confirmation close.)
- overlap: Ross 1-2-3 in miniature; Brooks reversal bar + entry; SMC "internal CHoCH" at L=1; Williams "swing" definition.
- evidence: none.

### bull_trap / bear_trap — Trap patterns
- school: classical · type: event/setup · bias: reversal
- rule: bull trap := breakout close above resistance R (`c[t] > R`, R = N-bar high / range top / pattern boundary), then
  within k ≤ 3-5 bars a close back below R (`c[t+k] < R`) → short; the trap is "sprung" for the breakout buyers. Bear trap
  mirror. Distinguish from a wick sweep (no close beyond) — the trap requires a *close* beyond then a close back.
- overlap: failed breakout (close version), Wyckoff UTAD/terminal shakeout, SMC "false BOS" / "sweep on the closing basis",
  Volman false break, 2B (2B typically no close beyond).
- pitfalls: k and the level definition; a trap on 1m may be a valid breakout on 5m — record TF.

### failure_test — Failure test (Grimes; overlaps Wyckoff spring/upthrust)
- see grimes_pullbacks. Canonical parameters: level = prior swing extreme (L≥3) or range boundary; violation depth ≤ 0.5×atr;
  reclaim within ≤ 2 bars by close; stop just beyond the violation extreme; target other side. → alias of `sweep_reversal`.

### wy_spring / wy_upthrust (also listed §2) — retained here only as aliases → `sweep_reversal`.


## 7. Equivalence / synonym table (dedupe map)

The engine should implement each **canonical primitive** once, with parameters, and emit school-specific *tags* as
labels on the same event. Column "params that differ" tells you which knobs the schools actually disagree on.

| canonical primitive (implement once)                | school names / aliases (emit as tags)                                                                                                                                                                                                                                                                                                                                                       | params that differ between schools |
|-----------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------|
| **sweep_reversal** — price violates a level, closes back inside within k bars | ICT liquidity sweep / stop hunt / raid / judas swing / turtle soup (Raschke) / turtle soup+1 · Wyckoff spring / shakeout / terminal shakeout / upthrust / UTAD · VSA upthrust · Brooks failed breakout / trap / opening reversal at a magnet · Grimes failure test · Trader Vic 2B · Williams Oops! (level = prior-day low, at the open) · Raschke 80-20 (level = prior bar low) · Elliott expanded-flat B wave / truncated 5th · Harmonic Butterfly/Crab/Alt-Bat D beyond X · Wolfe point 5 · Volman false break · bull/bear trap (close-based variant) · Market Profile "look above and fail" | level_type {swing L, EQH/EQL, PDH/PDL, session H/L, N-bar high, range boundary, trendline}; depth (wick-only vs close-beyond); k bars to reclaim; entry (reclaim close vs stop above level + ticks); required follow-through (displacement/FVG/MSS or none) |
| **breakout** — close beyond a level with follow-through | Brooks breakout / always-in flip · SMC BOS / MSS(with displacement) · Donchian/turtle · Darvas box break · ORB / IB extension · Wyckoff SOS / JAC · Volman RB/BB/FB · Bollinger/TTM squeeze fire · Crabel ORB after NR · gap-and-go break of OR high · Ross point-2 break · Vic 1-2-3 point-3 break (=CHoCH) | level type; close vs intrabar stop; follow-through bars; volume filter (Wyckoff/Darvas only) |
| **breakout_retest / first_pullback** — after breakout, shallow pullback to the level, resumption | Brooks breakout pullback / High-1 / 20-gap-bar EMA touch · Wyckoff LPS / back-up to creek · SMC BOS retest / OB mitigation / FVG fill entry / breaker retest · Ross hook / TTE · Raschke Holy Grail (EMA) · Grimes simple pullback · three-bar play (immediate) · Volman SB/PBP · Elliott wave-2 (shallow) | pullback depth cap; retest anchor (level vs EMA vs OB zone vs FVG CE); trend-strength filter (ADX / gap-bar count / displacement) |
| **two_leg_pullback (ABC)** — counter-move with two legs then resumption | Brooks High-2 / Low-2 / two-legged pullback · Grimes complex pullback · harmonic AB=CD (Fib-gated) · Elliott zigzag / 5-3 · SMC "OTE" retrace (0.62-0.79) · Wyckoff ST/test sequence (in-range) | Fib windows (harmonic strict, others none); leg counting method |
| **three_push_wedge** — three successive extremes with shrinking/converging legs | Brooks wedge / three pushes / wedge flag · Three Drives (Fib-gated) · Wolfe Wave (5-pt with undercut of 1-3 line + EPA) · Elliott ending diagonal / 5th wave · classical rising/falling wedge | Fib gates; convergence requirement; undercut requirement (Wolfe) |
| **trend_reversal_123** — trend-line break, test of extreme (LH/HH), break of intervening pivot | Brooks MTR / trend-line break + test · Trader Vic 1-2-3 · Joe Ross 1-2-3 · SMC CHoCH (structural version) · Wyckoff phase A→C (climax, AR, ST) at large scale · Dow trend change · double top / 2B + neckline | trendline construction rule; test tolerance; pivot L |
| **climax_bar** — outsized bar/volume after an extended move | Brooks climax / buy-sell climax · VSA climactic action / stopping volume (with close-position rules) · Wyckoff SC/BC/PS · extension bar (VWAP/EMA/KC z-score) · ICT displacement (**opposite** reading: continuation) · Williams smash day (daily) | volume requirement (VSA/Wyckoff yes; Brooks/ICT no); close-position; distance-from-mean; trend age |
| **compression_range** — N bars of overlapping small ranges | Brooks TTR / barbwire / final flag / ii-iii · Crabel NR4/NR7/ID/2BNR · Bollinger/TTM squeeze · Volman block/box/DD · Wyckoff phase B (macro) · SMC accumulation / BPR · Market Profile narrow IB / balance · pennant/flag/triangle | N; range/ATR cap; single-bar vs multi-bar; indicator-based (BB/KC) vs raw |
| **three_bar_gap (FVG)** — bar i-2 and bar i don't overlap | ICT FVG / imbalance / BISI-SIBI / CE / iFVG / BPR (overlapping opposite FVGs) · Brooks measuring gap · classical breakaway/runaway/measuring gap · Market Profile single prints | min size (ATR/auto threshold); mitigation rule (touch vs close-through); fill target (CE vs full) |
| **origin_zone (OB / demand-supply)** — last opposing candle before impulse | SMC order block / breaker / mitigation block · supply-demand zones (Seiden) · Brooks "the bar before the breakout" / signal bar · Wyckoff LPS zone / creek · Volman pattern line | candle choice; zone bounds (wick vs body vs 50%); invalidation (touch vs close) |
| **equal_extremes (EQH/EQL)** — two pivots within tolerance | SMC EQH/EQL / relative equal · double top/bottom (classical) · Brooks double top/bottom magnet · Market Profile poor high/low · Wyckoff AR/ST range extremes | tolerance (0.1 ATR SMC vs 1-3% classical); pivot L; treated as target (SMC) vs reversal (classical) |
| **session_range_breakout** — range of first W min, break | ORB (W=5/15/30/60) · Market Profile IB (W=60) extension · Brooks trend-from-open · ICT PO3 distribution (after manipulation) · Crabel stretch ORB · Volman RB · gap-and-go | W; entry (close vs stop); stop rule (opposite side / mid / ATR fraction); prior-day filter (NR/ID/gap/relvol) |
| **gap_event** — open vs prior close/extreme | gap-and-go / gap-fill · Williams Oops! · ICT NDOG/NWOG · Brooks gap-open trend/reversal · Market Profile open-outside-value | gap size buckets; fill fraction; RTH vs Globex reference |
| **regime_state** — trend vs range classifier | Brooks always-in / 80% rules · SMC structure trend (last BOS) · Elliott impulse-vs-correction · Market Profile day type · ADX / Choppiness · Wyckoff phase | window; thresholds |
| **fib_retrace_zone** — 0.5-0.79 pullback of a leg | ICT OTE / discount-premium · harmonic B-point windows · Elliott wave-2 (0.5-0.618) · Brooks "deep pullback" | window edges |
| **volume_effort_bar** — volume vs range/close anomalies | VSA no-demand / no-supply / test / effort-no-result · Wyckoff effort-vs-result · (no ICT/Brooks/harmonic analog) | volume normalisation; local (prev 2 bars) vs global (relvol) |

Consequence: the ~90 named structures above collapse to **~16 canonical primitives**; roughly 40% of the named structures
in ICT/Wyckoff/Brooks/Raschke/Williams are the *sweep_reversal* or *breakout_retest* primitives under different names.

---

## 8. Mechanical-definedness ranking + evidence summary

Tier A — crisp, deterministic from OHLCV, no discretionary inputs (build first):
- ORB / IB (session-anchored range + break) · Crabel NR4/NR7/ID/2BNR + stretch · Donchian / Darvas box · three-bar gap (FVG /
  measuring gap) with ATR threshold · EQH/EQL with ATR tolerance · sweep_reversal with explicit {level, depth, k, close rule}
  (turtle soup's rules are the crispest spec) · Williams Oops! / smash day / 80-20 · key/outside reversal, pivot-point reversal ·
  ii/ioi (Brooks) · TTM/Bollinger squeeze · Wolfe Wave (5 pivots + line tests) · Market Profile day-type via ibw multiples ·
  VSA bar rules (given a stated volume normalisation) · SMC BOS/CHoCH given fixed L (LuxAlgo: close-based, L=5/50).
Tier B — mechanical once you fix a pivot/ZigZag threshold (results are sensitive to it):
- Harmonic XABCD family (ratio tables are exact; pivot choice is not) · Ross 1-2-3/hook · Vic 1-2-3 · Brooks wedge/three pushes,
  High-2/Low-2, MTR · Grimes simple/complex pullback · Elliott hard rules (as validators) · order blocks (candle choice) ·
  Wyckoff atomic events (SC/AR/ST/spring/SOS/LPS) · gap-and-go/gap-fill · extension bars.
Tier C — narrative / post-hoc, only usable as scored composites or vetoes:
- Full Wyckoff schematics/phases · Elliott counts (degree ambiguity) · Brooks always-in, "80% rules", final flag, spike-and-
  channel end · ICT PO3 / "draw on liquidity" / daily bias · Raschke Anti (indicator-tuned) · Volman (TF-specific, needs the
  EMA-slope discretion).

Evidence summary (honest):
- Academic/peer-review positive: ORB (Zarattini & Aziz 2023 SSRN; Zarattini, Barbon & Aziz 2024 — equities/QQQ, not
  futures); Donchian-style trend following at daily+ horizons (Moskowitz-Ooi-Pedersen 2012; Hurst-Ooi-Pedersen 2017);
  volatility clustering / contraction→expansion (which underlies NR7/squeeze) is universal, direction is not.
- Practitioner-tested with in-sample tables: Crabel NR/ID + ORB (1990); Connors & Raschke Street Smarts (turtle soup,
  80-20, Holy Grail, NR7 — 1995, anecdotal); Larry Williams (Oops!, smash day — his own tables); Bulkowski (gap fills,
  outside days, measured moves — daily stocks); Grimes (pullback tests in his book).
- Untested academically / no stats in the source texts: Al Brooks (all), Wyckoff schematics, VSA (TradeGuider claims),
  every harmonic pattern (blog backtests ≈ coin flip), Elliott (contradictory counts; null in reviews), Wolfe Waves,
  ICT/SMC (all — LuxAlgo publishes no stats), Volman, Ross, Trader Vic (anecdotal), Darvas (memoir).
- Project-internal (this repo): sweeps of pre-RTH extremes real (side 90.5% OOS; reversal 67.6%); GEX/LT level-reactions,
  classical S/R breakouts, and 1m probability edges placebo-equivalent; first-15m continuation > reversal; big-bar
  ("displacement") anatomy = thin book, no direction; PCC/Monday/gap-fade sleeves shadow-live.

---

## 9. Detection-engine notes

Shared primitives (one implementation each; every school-specific detector composes them):
1. `bars` normaliser: raw contract + `filterPrimaryContract()`; symbol-change → flush all state (levels, swings, ranges).
2. `atr(n)`, `avgrng(n)`, `relvol` (time-of-day normalised), all **exclusive of the current bar**.
3. `pivots(L)` fractal + `zigzag(k×atr)`; both emit `(price, ts, confirmed_at_ts)`; consumers may only read pivots with
   `confirmed_at_ts <= now`.
4. `levels` registry: {swing, EQH/EQL, PDH/PDL/PDC, session H/L (Asia/London/NY/ON), OR/IB, POC/VAH/VAL, round numbers,
   EMA/VWAP bands, FVG/OB zones, trendlines}; each level carries {price, type, born_ts, tested_count, swept_ts, broken_ts}.
5. `event` primitives: sweep_reversal(level, depth, k, close_rule); breakout(level, ft_bars); retest(level, depth_cap);
   climax_bar(k_atr, dist, vol); three_bar_gap(min_atr); compression(N, cap); equal_extremes(tol); two_leg_pullback;
   three_push; trend_reversal_123; regime_state.
6. `state machines`: schematic (Wyckoff), PO3, ORB→failed-ORB, squeeze→fire, box→break, harmonic PRZ→T-bar; each state
   carries `emerging|confirmed|invalidated` and the sealing bar ts.

Pitfall checklist (all bit the project before — see memory):
- **1m fill-bar / intrabar lookahead**: sweep/reclaim, FVG-fill, PRZ-touch, ORB-stop entries all "see" the reclaim in the
  same bar's high/low. Seal on close, fill on 1s (CLAUDE.md rule) — never evaluate the bar that triggers with its own extremes.
- **Pivot repaint**: fractal L / ZigZag pivots exist only after L bars / after reversal; SMC "swing" L=50 is 50 bars late.
- **Rollover**: raw-contract levels (PDH/PDL/EQH/OB/FVG) jump ~200-300 pts at roll; flush or shift by roll spread.
- **Time-of-day**: NQ 09:30 bar, 10:00 macro prints, 14:00 FOMC dominate any ATR/volume-multiple detector; use
  minute-of-day-conditioned baselines; exclude the opening-auction bar from averages.
- **Tolerance drift**: Fib windows, EQ tolerance, sweep depth — log residuals as continuous features; binary hits at loose
  tolerance make every school "detect" every swing.
- **Side-matched placebos are mandatory** (project rule): every level-based detector must be compared against random /
  shifted levels of the same side and time-of-day.
- **Report pooled AND day-weighted** stats (thrust-fade artifact).
- **Volume**: Globex volume is 5-20× lower than RTH; VSA/Wyckoff rules only meaningful in RTH or with session-conditioned baselines.

---

## 10. Sources

- LuxAlgo Smart Money Concepts indicator (source mirror used for definitions): https://gist.github.com/niquedegraaff/8c2f45dc73519458afeae14b0096d719 ;
  https://www.tradingview.com/script/CnB3fSph-Smart-Money-Concepts-SMC-LuxAlgo/ ; https://www.luxalgo.com/library/indicator/smart-money-concepts-smc/ ;
  https://www.luxalgo.com/library/concept/fair-value-gap/
- Harmonic ratios: Carney, *Harmonic Trading* vol.1–3; https://harmonictrader.com/harmonic-patterns/shark-pattern/ ;
  https://www.quantifiedstrategies.com/shark-harmonic-trading-strategy/ (informal backtest); https://fxopen.com/blog/en/how-to-trade-the-shark-harmonic-pattern/
- Al Brooks, *Trading Price Action: Trends / Trading Ranges / Reversals* (Wiley 2011-12); brookstradingcourse.com glossary.
- Wyckoff: Pruden, *The Three Skills of Top Trading*; Wyckoff Analytics schematics; Tom Williams, *Master the Markets* (VSA).
- Elliott: Frost & Prechter, *Elliott Wave Principle*; Neely, *Mastering Elliott Wave* (NEoWave rules); Wolfe Wave: Bill Wolfe's course notes / Bulkowski's description.
- Crabel, *Day Trading with Short Term Price Patterns and Opening Range Breakout* (1990); Connors & Raschke, *Street Smarts* (1995);
  Larry Williams, *Long-Term Secrets to Short-Term Trading*; Joe Ross, *Trading by the Book*; Sperandeo, *Trader Vic*;
  Grimes, *The Art and Science of Technical Analysis* (2012); Volman, *Forex Price Action Scalping* (2011), *Understanding Price Action* (2014);
  Darvas, *How I Made $2,000,000 in the Stock Market*; Dalton, *Mind over Markets*; Bollinger, *Bollinger on Bollinger Bands*; Carter, *Mastering the Trade* (TTM squeeze).
- Academic: Zarattini & Aziz (2023) "Can Day Trading Really Be Profitable?" SSRN 4416622; Zarattini, Barbon & Aziz (2024) "A Profitable Day Trading Strategy for the U.S. Equity Market" SSRN;
  Moskowitz, Ooi & Pedersen (2012) "Time Series Momentum"; Hurst, Ooi & Pedersen (2017) "A Century of Evidence on Trend-Following"; Marshall, Young & Rose (2006) candlestick tests (DJIA);
  Lo, Mamaysky & Wang (2000) "Foundations of Technical Analysis"; Karpoff (1987) price-volume survey; Bulkowski, *Encyclopedia of Chart Patterns*.
- Project-internal: memory files referenced in text (liquidity-research-results, greenfield C1/R3/Wave-A, dealer-reaction, 1s-research-mandatory).
