# JV-ICT Signal Universe — MFE/MAE Excursion Study (2026-07-23)

**Question:** For EVERY mechanical jv-ict setup (no confluence gate, no bias gate, both sides, no session restriction), what does the raw opportunity look like — best/worst-case excursions of an independent 1 NQ contract, honest 1s fills, no stops/targets, forced flat 16:00 ET same trading day? And (scope addition from Drew): **if we only picked the 1 best trade per day, would this be profitable — or are the ~1,500 signals/year genuinely noise?**

**Verdict up front:** the ungated universe is a symmetric random walk around NQ drift (median MFE 85.4 pts vs median MAE 75.3 pts; +X-before-−X ≈ coin flip at every threshold 5–50 pts; 16:00-hold expectancy −1.2 pts/trade before costs). **The daily-oracle ceiling of the real universe is at or below the ceiling of every seed-matched random-entry placebo universe** — even a perfect 1-trade-per-day selector would be selecting from noise. This closes the "maybe the selection layer redeems the setups" question from 07-PROGRAM-SUMMARY.md: on NQ 2021–2024 it cannot, because the setups do not concentrate opportunity relative to random entries with the same time-of-day and geometry profile.

---

## 1. Method

### Signal harvest (engine capture mode)

```
node index.js --ticker NQ --start 2021-01-18 --end 2024-12-31 --strategy jv-ict \
  --timeframe 15m --capture-signals research/jv-ict-2026-07/signals-universe.json \
  --strategy-json '{"confluenceMode":"none","biasMode":"none","sides":"both",
                    "sessionStartMin":0,"sessionEndMin":1440}'
```

Capture mode bypasses the position gate and zeroes cooldown → every trigger recorded, nothing executed. Session emission window opened to the full 24h clock (`sessionStartMin:0, sessionEndMin:1440`); signals actually span **all 24 ET hours** (see §2 — the state machines fire around the clock, with the mass concentrated 01:00–10:00 ET). All other params = implementation defaults (15m run TF, entry 70.5% fib, TTL 24 bars). **3,600 signals**, every one carrying entry/stop/TP plus full metadata (sweep level/ts, extreme, MSS ts, leg terminus, fib anchors, IMB/OB zones, and the `jv_cancel` block with cancel levels + TTL). 2025+ locked set untouched.

### 1s excursion simulator (`08-mfe-mae-1s-sim.js`)

One chronological streaming pass (readline) over `data/ohlcv/nq/NQ_ohlcv_1s_continuous.csv` (4.9 GB — continuous, matching the price space signals were generated in; never loaded into memory). All orders/trades tracked in-flight simultaneously; runtime 57s. Rules, per CLAUDE.md 1s mandate:

- **Placement** at the signal's 15m close. **Fill** = first 1s bar with ts ≥ placement where `low <= limit` (BUY) / `high >= limit` (SELL); fill price = exact limit; fill ts = that 1s bar.
- **Pre-fill cancels** replicate `shouldInvalidatePendingOrder` exactly, evaluated at each 15m close AFTER that period's fills (engine ordering): (a) close beyond sweep extreme, (b) close beyond leg terminus, (c) TTL 6h, (d) study cutoff — any still-pending order dies at 16:00 ET of its trading day (replaces the strategy's 15:30 session-end/day-rollover cancels for this study). Note: (a) can never fire in practice — the extreme lies beyond the limit, so any 15m close beyond it implies an intrabar fill earlier in that period; the engine has the same property.
- **From fill instant:** walk 1s bars strictly forward (never ts < fill_ts; fill bar included), tracking running MFE/MAE with timestamps plus first-crossing times for ±{5,10,15,20,30,50} pts.
- **Forced flat** = last 1s close at/before 16:00 ET of the signal's trading day (ET/DST handled via IANA conversion; trading day = ET date, shifted +1 for ET hour ≥ 18, so Globex-evening signals flat at the NEXT day's 16:00). On short sessions (holiday half-days) the last bar before cutoff is used. Signals emitted in the 16:00–17:00 ET tail of their own trading day (cutoff already past) are cancelled immediately (`post_cutoff_emission`, 144 signals = 4%).
- Orders and trades fully independent; overlaps allowed; no stops, no targets, no slippage/commission on the raw excursion numbers (friction applied only in the oracle section).

### Sanity / verification

- 0 negative hold times; 0 fills before signal; MFE ≥ 0 and MAE ≥ 0 for all 1,390 fills; final PnL always within [−MAE, +MFE]; fill rate 38.6% ≈ the gated program's ~35%.
- **3 trades hand-audited against the raw 1s CSV** (independent Python walk via the minute index): fill ts, MFE/MAE magnitudes AND timestamps, and forced-flat close matched the simulator exactly on all three (one fully worked below, §6); a cancelled order's leg-terminus 15m-close cancel also reproduced exactly.

---

## 2. Universe

| | |
|---|---|
| Signals (2021-01-18 → 2024-12-31) | **3,600** (938 / 804 / 1,006 / 852 by year ≈ 900/yr) |
| Sides | 1,796 buy / 1,804 sell (balanced by construction) |
| Filled | **1,390 (38.6%)** — 672 buy / 718 sell |
| Cancelled pre-fill | close_beyond_leg_terminus **1,997 (55%)**, post_cutoff_emission 144, cutoff_1600_unfilled 49, order_ttl_expired 20 |
| Signal clock | all 24 ET hours; mode 03:00 ET (356), heavy 01:00–10:00, thin 11:00–14:00 and 17:00–19:00 |

The dominant cancel is the leg terminus breaking before the retest — price continues with the MSS instead of retracing 70.5%. The 15m-close sweep-extreme cancel fired 0 times (structurally impossible pre-fill, see §1).

## 3. MFE / MAE distributions (points; $ = pts × $20)

Filled trades, no management, flat 16:00 ET. Median hold 8.6h (p10 2.5h, p90 15.4h — many fills are overnight Globex entries held into the next RTH close).

| | p10 | p25 | p50 | p75 | p90 | mean |
|---|---|---|---|---|---|---|
| **MFE** | 14.0 ($280) | 35.5 ($710) | **85.4 ($1,708)** | 164.6 ($3,293) | 246.8 ($4,935) | 114.4 ($2,289) |
| **MAE** | 11.0 ($220) | 31.5 ($630) | **75.3 ($1,505)** | 151.3 ($3,025) | 234.6 ($4,692) | 105.7 ($2,114) |

By side — near-identical (the setup does not tilt the excursion field):

| side | med MFE | med MAE | mean 16:00 PnL |
|---|---|---|---|
| buy (n=672) | 85.9 | 74.5 | **+5.28 pts** |
| sell (n=718) | 85.0 | 76.5 | **−7.21 pts** |

By year: 2022 is simply a bigger-range year on both sides of the ledger (med MFE 136.0 / med MAE 108.8) vs 2021 (63.5 / 58.0), 2023 (75.9 / 70.4), 2024 (84.5 / 73.3). MFE and MAE scale together — vol, not edge.

By entry hour (fill, ET): overnight fills (20:00–08:00) have the largest MFEs (medians 95–135) *and* equally large MAEs (medians 90–135) — they're just held longest into the 16:00 flat. Late-RTH fills (14:00–15:00) have the smallest of both (med MFE 25–44, MAE 21–27). Ratio hovers ≈1.0–1.2 everywhere except a mild long-side tilt in the 05:00–06:00 and 09:00 buckets (MFE/MAE ≈ 1.3–1.5) — drift-consistent, small n per cell.

## 4. Joint structure

**% of fills reaching +X before −Y** (first-crossing on 1s path; same-bar ties counted as failure):

| +X \ −Y | 5 | 10 | 15 | 20 | 30 | 50 |
|---|---|---|---|---|---|---|
| **5** | 52.9 | 68.9 | 77.3 | 81.8 | 86.9 | 91.4 |
| **10** | 32.6 | **49.0** | 59.8 | 66.9 | 74.5 | 83.2 |
| **15** | 22.9 | 38.3 | **48.6** | 56.5 | 65.8 | 76.5 |
| **20** | 18.6 | 32.1 | 42.0 | **49.6** | 58.9 | 70.3 |
| **30** | 14.0 | 25.0 | 34.0 | 40.1 | **49.4** | 61.4 |
| **50** | 9.0 | 15.8 | 22.5 | 27.4 | 35.6 | **47.6** |

The diagonal is a **coin flip at every scale** (49.0 / 48.6 / 49.6 / 49.4 / 47.6) — a limit fill at the 70.5% retracement carries no first-passage bias whatsoever, from scalp (±5) to swing (±50) scale. By side the diagonal is equally flat (buy 47–51%, sell 47.5–56.5% with the 56.5 only at ±5, mostly fill-bar mechanics). This is the entire strategy question answered in one table: **there is no exit rule — no target/stop geometry — that turns these entries into positive expectancy, because the underlying first-passage odds are 50/50 everywhere.**

Other joint facts:

- **MFE:MAE ratio**: median 1.12, p25 0.33, p75 3.92 — wide and centered just above 1 (drift).
- **MFE peak before MAE trough: 48.4%** — even the ordering of best-vs-worst is a coin flip.
- Time-to-MFE ≈ time-to-MAE (median 255 vs 254 min; distributions overlap completely).
- MFE and MAE per trade are strongly *negatively* coupled through the day's direction: trades in the lowest MAE quartile have median MFE 131; highest MAE quartile median MFE 47 — i.e., a trade mostly rides one side of a trending day. Selection between them is the whole game (see §7).
- **16:00-hold expectancy: −1.17 pts/trade overall** (before costs); buy **+5.28**, sell **−7.21**. Per-year: buys positive 3/4 years (2022 negative), sells negative all 4 years. This reconciles exactly with the program's established result — the ungated universe ≈ NQ drift, longs carry it, shorts pay for it.
- **IMB-confluence tag** (recorded, not gated): med MFE 95.0 vs 82.9, mean hold PnL +17.0 vs −11.5 (n=504/886). Direction-consistent with Round 1's "IMB is a real filter", but Round 3 already showed the IMB-gated config loses to placebo in 2024; treated as color, not signal. OB tag: nothing (mean PnL +0.05 with OB vs +2.66 without).

## 5. Daily-oracle ceiling — "what if we only took the best trade per day?"

Setup: per ET trading day, pick the best filled trade(s) with hindsight, under two outcome models bounding the truth: **(a) hold-to-16:00 PnL** (no management — understates a good manager) and **(b) MFE** (perfect top-tick exit — overstates any manager). Friction: $4 round-trip commission + 0.5 pt slippage = **0.7 pts/trade** at $20/pt.

Signal density: 989 trading days carry ≥1 signal; **727 days have ≥1 fill** (262 signal-days fill nothing); median 2 fills per fill-day (mean 1.91, max 10).

| pts/yr (net of friction) | 2021 | 2022 | 2023 | 2024 | total | total $ |
|---|---|---|---|---|---|---|
| oracle-1/day, hold | 7,663 | 10,652 | 5,880 | 6,379 | **30,574** | $611k |
| oracle-2/day, hold | 4,358 | 5,584 | 4,325 | 2,709 | 16,976 | $340k |
| oracle-1/day, MFE | 23,539 | 33,978 | 21,657 | 25,859 | **105,032** | $2.10M |
| oracle-2/day, MFE | 29,759 | 45,915 | 30,363 | 34,874 | 140,911 | $2.82M |
| anti-oracle-1/day, hold | −5,893 | −8,964 | −6,581 | −6,983 | −28,420 | −$568k |

Oracle and anti-oracle are near mirror images (+30.6k vs −28.4k) — the universe is symmetric; hindsight max-picking manufactures the entire "profit".

### The critical control: placebo oracles

Best-of-N/day is a max statistic, so an oracle over random entries looks great too. Five seeded placebo universes were generated with the strategy's own engine-honest `placeboMode` (the Round-3 kill-test machinery): the real universe's full per-signal geometry catalog (ET minute-of-day, limit offset, stop/TP distances, side — all 3,600 entries) replayed on PRNG-chosen random weekdays, same cancel rules, same capture pipeline, then run through the **same 1s excursion simulator in the same streaming pass**. Sizes 3,472–3,505 signals; fill rates 37.3–38.9% (real: 38.6%); med MFE 82–94 / med MAE 87–92 (real: 85/75).

| oracle-1/day total pts, 2021–24 | real | placebo mean | placebo min | placebo max |
|---|---|---|---|---|
| hold model | **30,574** | 37,985 | 31,377 | 42,406 |
| MFE model | **105,032** | 110,985 | 107,508 | 112,787 |

Per fill-day (placebos land fills on slightly more days): real 42.1 pts/day (hold) vs placebo 42.2–57.9; real 144.5 pts/day (MFE) vs placebo 144.5–153.0. Per-year: real beats the placebo mean in zero of four years on the hold model and one of four (2021, by 8%) on the MFE model.

**The real universe's perfect-selection ceiling is at or below the FLOOR of the 5-seed placebo distribution under both outcome models.** Sweep→MSS→fib-retest events do not concentrate opportunity: days selected by the mechanical setup are, if anything, marginally *less* rewarding to an oracle than random weekdays sampled with the same time-of-day/geometry profile.

### Selection feasibility (is best-of-day even learnable?)

Among the 1,046 trades on multi-fill days (base rate P(best)=0.368): side lift 0.98–1.02, model M/W 0.98–1.02, stop-width quartiles 0.88–1.06, OB 0.97–1.08, IMB 0.93 vs **1.13**, entry-hour lifts 0.66–1.27 for all cells with n>40 (the 1.52 at 06:00 ET is n=34). Nothing exceeds noise scale; the only recurring whisper is IMB (+13% relative), which Round 3 already killed as placebo-equivalent-selected-max. There is no ex-ante feature that identifies the day's best trade.

## 6. Worked trade audit (raw 1s rows)

Signal #6: **SELL limit 16415.75**, emitted 2021-01-26T04:45:00Z (= 23:45 ET Jan 25 → trading day 2021-01-26, cutoff 16:00 ET = 21:00Z). Metadata: sweep extreme 16450.50 (cancel/stop side), leg terminus 16347.00, swept level 16369.00, MSS close 04:45:00Z.

```
ts_event                   open      high      low       close   vol
2021-01-26 09:01:14+00:00  16414.75  16415.00  16414.75  16415    20   ← high < 16415.75, still pending
2021-01-26 09:01:15+00:00  16415.00  16416.00  16415.00  16416    24   ← FIRST bar high ≥ 16415.75 → FILL @ 16415.75
2021-01-26 10:50:39+00:00  16387.75  16388.00  16387.25  16388    13   ← session low 16387.25 → MFE = 28.50 pts
2021-01-26 16:06:25+00:00  16498.25  16499.75  16498.25  16499.5  55   ← session high 16499.75 → MAE = 84.00 pts
2021-01-26 20:59:59+00:00  16451.50  16452.25  16448.25  16451.5  444  ← last bar before 21:00Z → flat @ 16451.50
```

Simulator row: fill_ts 09:01:15Z ✓, mfe 28.50 @ 10:50:39Z ✓, mae 84.00 @ 16:06:25Z ✓, close_1600_pnl −35.75 (= 16415.75 − 16451.50) ✓, minutes_held 718.75 (09:01:15 → 21:00:00Z) ✓. Two further audits (an overnight sell filled 02:58:15Z with MFE 551.0 into the Feb-25-2021 selloff, exit PnL +488.75; and a buy cancelled by a 15m close 16448.25 > leg terminus 16430.75 at 12:15Z) also matched exactly.

## 7. Bottom line (Drew's question answered)

**No — picking the 1 best trade per day would not make this strategy profitable, because "the best trade of the day" in this universe is a lottery draw, not a discoverable object.** Three independent lines of evidence agree:

1. **The excursion field is symmetric.** Median MFE only 10 pts above median MAE, first-passage diagonal 47.6–49.6% at every ±5→±50 threshold, MFE-before-MAE 48.4%. There is no management scheme (targets, stops, trailing) that extracts positive expectancy from 50/50 first-passage odds; the +X-before-−Y table *is* the exhaustive sweep of all fixed bracket exits.
2. **The oracle ceiling is placebo-equivalent.** Perfect hindsight selection of 1/day yields 30.6k pts (hold) / 105k pts (MFE) over 4 years — at or below the *minimum* of 5 random-entry placebo universes with matched size, clock and geometry (31.4k–42.4k / 107.5k–112.8k). The huge oracle dollar figures are pure max-statistic; random days offer the same or more.
3. **Best-of-day has no ex-ante signature.** No feature in the setup's own metadata (side, model, hour, stop width, OB/IMB) predicts which trade wins the day beyond noise; the anti-oracle is a mirror image of the oracle.

The ~1,500 sweeps/900 signals a year are genuinely noise on NQ 2021–2024 — not "noise until the right selection layer is found": a selection layer strictly better than perfect hindsight does not exist, and perfect hindsight already fails to beat random. This extends the 07-PROGRAM-SUMMARY verdict from "no configuration survives" to "no *selection function over the universe* can survive". The only reopening condition that remains is the one already ranked there: evidence about what the source trader actually traded — which, given this result, would have to reveal information *outside* the mechanical setup definition (news, HTF levels, regime reads) to matter.

**Files:** per-trade CSV `mfe-mae-universe.csv` (3,600 rows, incl. threshold first-crossing seconds), placebo trades `mfe-mae-placebo.csv` (17,440 rows), simulator `08-mfe-mae-1s-sim.js`, analysis `08b-analysis.py`, signal universes `signals-universe.json` / `signals-placebo-s{1..5}.json`, geometry catalog `placebo-catalog-universe.json`.
