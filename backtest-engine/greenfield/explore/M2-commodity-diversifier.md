# M2 — Gold & Oil as a diversifying layer for the intraday equity-long book

**Question.** (A) Do GC (gold) / CL (crude) daily returns actually diversify the existing
intraday equity-long book? (B) Is there a real, tradeable daily/swing EDGE *in* gold or oil
that is *also* uncorrelated to that book?

**Data.** Daily OHLCV `data/macro/{gc,cl,si,hg,ng,nq,spy,vix,tlt,ief,hyg,lqd,uup,dxy,gld,iwm,btc}_1d.csv`
(commodities/nq/dxy = 1994→, book 2021→). Trade targets = **gc, cl**. Sizing on micros
**MGC $10/pt**, **MCL $100/pt**; round-trip cost charged = 2 ticks slip + commission
≈ **$3.5** on each (GC 0.35 pt, CL 0.035 pt). No intraday used (daily bars only).

**Measurement (KNOWABILITY-compliant).** Signal from data known at day-D **close** →
enter **D+1 open** → exit **close of D+N** (fixed hold) → PnL in points × micro pt-value −
cost. Non-overlapping trades. Per-calendar-year + per-regime + random-entry placebo.

### ⚠️ Data-alignment fix (material — applied before all cross-series work)
Futures daily bars (gc,cl,si,hg,ng,nq,dxy) are stamped at **18:00 ET the calendar day
BEFORE the session** (weekday set = {Mon–Thu, **Sun**}, no Friday). Verified empirically:
`gld`(ETF) vs `gc`(fut) returns correlate **0.88 only at lag +1**, ~0 at lag 0; same for
spy-vs-nq. **Futures label date = session date − 1 business day.** All futures-vs-ETF/book
joins therefore require `busday_offset(date, +1, roll='backward')` onto the equity calendar
(scripts `M2-00b-align.py`, `M2-06`). Without this, every futures-vs-equity correlation is
misaligned by a day and attenuated toward zero. (Validation after fix: Monday-strategy book
vs nq = **+0.64**, exactly as expected for an equity-directional strat.)

---

## TRACK A — Diversification profile  (the gating question) → **gold YES, oil YES-but-weaker**

### A1. gc/cl daily returns vs the EQUITY BOOK daily PnL (session-aligned, 2021–2026)

| book PnL | corr **gc** | corr **cl** | corr nq | corr spy |
|---|---|---|---|---|
| combined (co-traded, n=866) | **−0.024** | **−0.011** | +0.209 | +0.177 |
| combined (zero-filled, portfolio) | **−0.019** | **−0.007** | — | — |
| pcc | −0.029 | −0.001 | +0.074 | +0.078 |
| monday | +0.014 | +0.046 | +0.641 | +0.559 |
| gapfade | −0.110 | −0.155 | −0.465 | −0.426 |

The book is **equity-directional** (combined vs spy +0.18; Monday vs nq +0.64). Gold and oil
sit at **≈0 (slightly negative)** to the combined book — genuine, near-orthogonal return
streams. (gapfade is short-biased, so its −0.11/−0.16 to gc/cl is just its equity-beta sign.)

### A2. Underlying return correlations (full aligned history)

| pair | corr | pair | corr | pair | corr |
|---|---|---|---|---|---|
| gc–spy | **+0.005** | cl–spy | **+0.119** | gc–cl | +0.083 |
| gc–nq | −0.006 | cl–nq | +0.077 | gc–dxy | −0.293 |
| gc–tlt | +0.132 | gc–ief | +0.162 | gc–uup | −0.346 |
| gc–vix | −0.001 | cl–vix | −0.097 | cl–tlt | −0.101 |
| gc–si | +0.749 | gc–gld | +0.883 | cl–hg | +0.152 |

Mechanisms confirmed: **gold ≈ inverse-dollar / real-rate asset** (dxy −0.29, uup −0.35,
tlt/ief +0.13/+0.16, spy ~0). **Oil ≈ growth/risk asset** (spy +0.12, copper +0.15, vix
−0.10). gc–si +0.75 → silver is a gold substitute, not an independent stream.

### A3. Per-year & stress stability — does the diversification hold when it matters?

| window | gc–spy | cl–spy | gc–cl |
|---|---|---|---|
| 2008 GFC | **−0.057** | +0.352 | +0.270 |
| 2014–16 oil crash | **−0.147** | +0.325 | +0.082 |
| 2020 COVID | +0.213 | +0.157 | +0.033 |
| 2022 stress | +0.118 | +0.113 | +0.363 |
| 2021–26 book era | +0.103 | +0.083 | +0.052 |

- **Gold does NOT converge to equities in stress** — it goes *negative* in deflationary
  crashes (2008, 2014–16) and only mildly positive (~0.1–0.2) in inflationary/liquidity
  stress (2020, 2022). It is a true diversifier, best exactly when the book hurts.
- **Oil is a weaker diversifier**: its baseline spy correlation is mildly positive and
  **rises to +0.3–0.35 in crashes** (2008, 2014–16) — oil sells off *with* equities in a
  risk-off. It also spent 2009–2013 (QE risk-on) at cl–spy +0.4–0.6. Recently (2023–26)
  back near 0, and 2026 even −0.38. Net: oil diversifies the *book* (which trades few days)
  but is a poorer portfolio hedge than gold.

**Track A verdict: adding a gold layer is unambiguously diversifying (≈0 to book, decouples
in stress). Oil is diversifying to the book too, but couples with equities in exactly the
crash regimes where you'd want the hedge — treat oil as a return-source, not a hedge.**

---

## TRACK B — Edge hunt (daily/swing). Scripts M2-02…M2-05; PnL/book-corr M2-06; DD M2-07.

### Ranked shortlist of tradeable edges (all ≈0 correlation to the book — see A/⭐)

| # | edge | dir | trades (32y) | WR | mean $/tr | PF | placebo p | maxDD (micro) | corr→book | per-regime |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **GC 100-day Donchian breakout, hold 42d** | long+short | 82 | 58% | **$351** | **3.07** | **0.000** | −$2,825 (MGC) | **−0.002** | +ve all 4 stress; DD yrs 2017/2021/2023 |
| 2 | **GC dip-fade (5d ret z≤−2σ), hold 5d** | long | 106 | 58% | $117 | 1.95 | 0.010 | −$2,760 (MGC) | +0.001 | 2020+, 2024–25+; 2014–16 −ve |
| 3 | *CL vol-regime conditioner* (descriptive) | filter | — | — | — | — | — | — | ~0 | see B4 |

**⭐ The "real AND uncorrelated" prize = GC trend/dip-buying (#1, #2).** Both are
near-zero-correlated to the equity book (−0.002 / +0.001 combined), positive-expectancy over
32 years, survive the random-entry placebo, and are tradeable at 1 micro (MGC) with
low-hundreds-to-$2.8k drawdown. In the book window (2021–26, 1 MGC) they added **+$16.4k
(Donchian, PF 5.4)** and **+$9.4k (dip-fade, PF 3.0)** — both uncorrelated to the book.

**Caveat (say it plainly):** #1 and #2 are **long-biased and regime-dependent** — the payoff
is concentrated in gold's secular uptrends (2005–2011 supercycle, 2024–2025 parabola) with
real losing years in gold bears/ranges (Donchian: 2017 −$481, 2023 −$651, 2021 −$374). The
placebo (p=0.000 for Donchian) confirms the breakout *timing* adds value beyond
random-same-direction entry, but the *magnitude* rides the CTA/trend premium in gold. This is
a legitimate diversifying trend bet, not a market-neutral anomaly.

### B1. Trend / momentum (mechanism: CTA / time-series-momentum premium; producers/consumers hedge slowly)
- **GC TSMOM** (sign of trailing 250d ret, 42d hold): PF 1.88 but **placebo p=0.31 → dead**
  (pure capture of gold's long drift; random long entry does as well).
- **GC Donchian 100d/42d**: PF 3.07, **placebo p=0.000 → survives** (edge #1).
- **CL TSMOM 42/5**: PF 1.17, placebo p=0.17; crisis-concentrated (2008 PF 2.5, 2014–16 2.3,
  2020 2.7) but **PF 0.86 & −$6.8k in 2021–26 → regime bet, currently dead.**
- **CL Donchian 100/63**: PF 1.70 but entirely 2008/2020 (PF 8.7 / ∞), flat 2021–26. Regime bet.

### B2. Seasonality / calendar (causal by construction)
- **Day-of-week**: no edge (all |mean| < $6, and futures labels are session-shifted — Thu
  label = Friday session; relabel before any use). **DEAD.**
- **Turn-of-month** (enter ~last-2 close, hold 5): GC PF 1.34 but placebo **p=0.17**; CL PF
  0.91 (negative). Not a standalone edge. **DEAD.**
- **Month-of-year** (descriptive tilts, not a strategy): gold strong Jan/Jul/Aug/Nov, weak
  **Jun (−$220, WR 34%)**; oil strong Feb–Apr/Jun, weak Sep–Nov. Useful as a seasonal *tilt*
  overlay only; matched-control edge too weak to trade alone.

### B3. Mean-reversion / overextension (mechanism: positioning overshoot reverts)
- **GC dip-fade z≤−2σ hold 5**: edge #2 (PF 1.95, placebo p=0.010) — but the *short* side
  (fade rallies) loses everywhere → it's asymmetric drift-buying, not symmetric reversion.
- **CL rally-fade z≥1.5σ hold 5** (short): PF 1.56, placebo p=0.013, **positive in all 4
  stress regimes** (2008 PF 3.8, 2014–16 2.1, 2020 3.5, 2022 2.1), 20/31 yrs+. *Looked* like
  the cleanest oil edge — BUT netted ≈$0 in 2021–26 and suffered its **worst-ever drawdown in
  2026 (−$4,458 / MCL)** when a crude breakout ran the fade over. Classic
  fade-the-trend tail risk. **NOT deployable as standalone; demote to a filtered signal.**

### B4. Volatility regime (mechanism: payoff is vol-state dependent)  ← strongest *structural* oil finding
Forward-10d LONG return by 20d-realized-vol quintile (overlapping samples — t inflated, read
the *shape/PF*, not the t):

| vol quintile | **CL** long fwd-10d | **GC** long fwd-10d |
|---|---|---|
| Q1 (lowest) | **−$45  PF 0.71** | +$41 PF 1.36 |
| Q2 | +$47 PF 1.38 | +$89 PF 1.88 |
| Q3 | +$37 PF 1.29 | +$2 PF 1.02 |
| Q4 | +$8 PF 1.05 | +$8 PF 1.05 |
| Q5 (highest) | **−$49  PF 0.75** | +$52 PF 1.38 |

**Crude has a clean inverted-U in vol: long pays in MID vol, loses in low-vol (contango
complacency grind) and high-vol (crash/spike).** This is the most mechanically-robust oil
result — but as a *conditioner*, not a packaged strategy. Gold long pays in all vol states
(drift), strongest in low–mid vol; fading gold dips works better in high vol (PF 2.19).

### B5. Cross-commodity / macro conditioning (state filters)
- **Gold | weak USD** (dxy < 50d MA): long-gold PF 1.48 (t 2.64) vs 1.34 in strong-USD —
  real but modest tailwind (gold-long works either way due to drift).
- **Oil | strong copper** (hg > 50d MA): long-crude PF 1.19 vs **PF 0.92 (negative) when
  copper weak** → copper regime *flips the sign* of the crude long. Usable growth filter:
  only be long crude when the growth complex confirms.

### Explicit DEAD / regime-only list
- GC & CL time-series-momentum as standalone (drift capture / crisis-only).
- CL Donchian & CL TSMOM in the current (2021–26) regime — crisis-only, dead now.
- All day-of-week and turn-of-month seasonality.
- CL rally-fade as a standalone (real history, but ≈$0 recently + worst DD in 2026).
- Silver/gold, oil/copper as *independent* streams (gc–si 0.75; hg is a filter not a target).

---

## Bottom line
1. **Diversification (Track A): YES for gold, qualified-yes for oil.** Gold is ≈0-correlated
   to the equity book and to equities themselves, and *decouples further (negative)* in
   deflationary stress — the ideal diversifier. Oil is ≈0 to the book but mildly equity-beta
   and couples (+0.3) in crashes — a diversifying return-source, not a hedge.
2. **Edge (Track B): a qualified real, uncorrelated edge exists in GOLD trend/dip-buying;
   oil is mostly a regime bet.** Top 2 tradeable, book-uncorrelated, micro-viable edges:
   **GC 100d Donchian breakout (hold 42)** and **GC dip-fade (z≤−2σ, hold 5)** — both
   positive-expectancy over 32y, placebo-clean, corr≈0 to book, sane micro DD (~$2.8k), but
   **long-biased and concentrated in gold's secular uptrends** (a CTA/trend premium, not a
   neutral anomaly). Crude offers no clean standalone daily edge right now; its one robust
   structure is a **vol-regime conditioner** (long pays only in mid-vol) and a **copper
   growth filter**, best used to condition/scale a position rather than trade alone.
