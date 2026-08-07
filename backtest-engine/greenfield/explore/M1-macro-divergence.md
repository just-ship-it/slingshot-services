# M1 — Cross-market MACRO DIVERGENCE swing screen

**Question (owner):** does the daily relationship between US equities and other macro
markets (rates, credit, dollar, gold, crypto, vol) predict a **multi-day** directional
move in NQ — especially a **DEFENSIVE/SHORT** signal that fires when equities are about
to weaken, to diversify an intraday equity-**long** book? Deliverable = the *distribution*
of the forward NQ point-move (ultimate expression = ~30-DTE option, needs a real move to
clear premium).

**Headline verdict: the defensive/short prize does NOT exist in this data.** At every
horizon tested (3/5/10/20 trading days), every cross-market *stress* signal — VIX spikes,
credit-spread widening, risk-off composite, dollar spikes, breadth deterioration, gold-bid,
crypto-weakness, even *leading* divergences (macro weak while equity still strong) — is
**contrarian-BULLISH, not bearish.** Shorting them loses. The daily-close macro divergence
arrives *after* the down-move; the forward multi-day move is a bounce. The only real,
stable structure is the **mirror image: "fade-the-fear" LONG** — which has an edge and is
near-uncorrelated to the book, but is a LONG and therefore does **not** deliver the
defensive/hedge behaviour the owner asked for.

---

## Method (causal, per KNOWABILITY contract)

- Daily OHLCV panel, master calendar = **NQ trading dates** (`M1-panel.csv`,
  `M1-00-panel.py`). Every other market reindexed onto NQ dates with **forward-fill**
  (as-of prior close) — on date D we use each market's most recent close ≤ D. Causal by
  construction. BTC (24/7) contributes its close on NQ trading days; weekend BTC dropped.
- Signal computed from data **through day-D close**; enter NQ at **D+1 open**; fixed-horizon
  exit at the **close of the h-th trading day** (h ∈ {3,5}, plus 10/20 for the horizon sweep).
  This is naturally lookahead-free at daily resolution.
- **Point non-stationarity control (load-bearing):** NQ was ~1,500–2,600 in 1999–2010 and
  ~14,000–29,000 in 2021–2026. A "100-point move" is 5–7% then vs ~0.4% now. So raw
  point hit-rates are meaningless without a same-era *unconditional* control, and
  sign-stability is judged on **percent** moves, not points. Point distributions are
  reported for the **2021+ era only** (matches current price regime and the book window).
- Cost: 1 entry + 1 exit ≈ **1.5 NQ pts round-trip** — negligible vs a 100-pt target; not
  subtracted from the distribution stats.
- Regimes labelled: 2000–02 dotcom, 2008 GFC, 2010 flash, 2011 EU, 2015–16 China, 2018Q4,
  2020 COVID, 2022 bear, 2025 tariff, else "calm".
- Scripts: `M1-00-panel.py` (cache) → `M1-01-screen.py` (broad, `M1-candidates.csv`) →
  `M1-02-focus.py` (stability/placebo, `M1-focus-*.csv`) → `M1-03-shorts-and-controls.py`
  → `M1-04-horizon-and-divergence.py` → `M1-05-book-correlation.py`.

---

## THE decisive control — point hit-rates are an illusion (`M1-03` part a)

Unconditional (random-day) NQ move, MFE≥X within 5 days:

| era | dir | n | median move | hit≥100 | hit≥150 | hit≥200 | avg NQ px |
|---|---|---|---|---|---|---|---|
| ≥2010 | long | 4166 | +26 | 0.48 | 0.37 | 0.30 | 9,162 |
| ≥2018 | long | 2147 | +72 | 0.78 | 0.67 | 0.57 | 14,414 |
| **≥2021** | **long** | **1391** | **+82** | **0.84** | **0.75** | **0.68** | 17,719 |
| **≥2021** | **short** | **1391** | **−82** | **0.79** | **0.70** | **0.63** | 17,719 |
| ≥2024 | long | 637 | +147 | 0.88 | 0.81 | 0.74 | 22,268 |

**A random 2021+ long clears 200 pts 68% of the time; a random short 63%.** So the
VIX-short's "hit200 = 0.76" seen in the raw screen was *below* — not above — the ambient
base rate. Any "≥100/150/200 pt" claim must be read against this table.

---

## Family-by-family screen (`M1-01`, full history, horizon 5d)

`dirMove` = mean directional point-move (positive ⇒ the stated direction profits).
Unconditional 5d: mean **+18.9** / median +14.0 pts, wr(up) 0.574.

| family | signal | dir | n | dirMove | median | win% | EDGE vs base |
|---|---|---|---|---|---|---|---|
| credit | HY/IG ratio z<−1.5 | short | 684 | **−62.9** | −36 | 0.38 | −44.0 |
| credit | HYG 5d top-decile | **long** | 457 | **+54.1** | +32 | 0.63 | +35.2 |
| rates | corr(NQ,TLT)>0 & bonds↓ | short | 1652 | −20.3 | −19 | 0.39 | −1.4 |
| rates | TLT 3d spike-up | short | 604 | −45.4 | −24 | 0.37 | −26.5 |
| dollar | DXY 5d top-decile | short | 699 | −24.9 | −11 | 0.43 | −6.0 |
| vol | VIX top-decile (1y) | short | 758 | −51.2 | −29 | 0.40 | −32.3 |
| vol | VIX 5d spike | short | 726 | −37.3 | −18 | 0.42 | −18.4 |
| breadth | IWM−SPY 5d bottom-decile | short | 676 | −37.8 | −24 | 0.38 | −18.9 |
| composite | risk-off top-decile | short | 701 | −44.7 | −20 | 0.40 | −25.8 |
| composite | risk-off z>2 | short | 245 | −44.9 | −22 | 0.40 | −25.8 |
| composite | risk-**on** bottom-decile | **long** | 654 | +28.9 | +17 | 0.59 | +10.0 |
| xasset | gold−SPY 5d top-decile | short | 596 | −52.6 | −29 | 0.40 | −33.7 |
| xasset | BTC 5d bottom-decile | short | 358 | −64.5 | −43 | 0.37 | −45.6 |
| xasset | NQ −2σ vs 20d mean | **long** | 299 | +64.8 | +23 | 0.62 | +45.9 |

**Read the sign correctly:** for `dir=short`, `dirMove` is the SHORT's profit. Every
short row is **negative** ⇒ the short **loses**. The negative "dirMove" is the giveaway
that these stress signals mark local bottoms.

---

## Why the shorts are dead — sign check + horizon sweep

**Stress-short sign check (`M1-03` b), short profit (positive=good):**

| signal | full n | mean | win% | 2021+ mean | 2021+ win% |
|---|---|---|---|---|---|
| VIX top-decile | 758 | −51 | 0.40 | −168 | 0.35 |
| VIX 5d spike | 726 | −37 | 0.42 | −146 | 0.37 |
| risk-off top-decile | 701 | −45 | 0.40 | −151 | 0.34 |
| HY/IG z<−1.5 | 684 | −63 | 0.38 | −180 | 0.29 |

**Horizon sweep (`M1-04`), short mean move (win%):** every signal, every horizon, loses —
and loses *more* as the horizon lengthens (drift compounds against the short).

| signal | h=3 | h=5 | h=10 | h=20 |
|---|---|---|---|---|
| VIX top-decile | −29 (.43) | −51 (.40) | −94 (.38) | −188 (.35) |
| risk-off top-decile | −26 (.43) | −45 (.40) | −67 (.41) | −96 (.39) |
| LEAD credit<spy & NQ↑ | −12 (.42) | −35 (.43) | −76 (.38) | −161 (.41) |
| LEAD breadth<spy & NQ↑ | −5 (.38) | −22 (.34) | −43 (.37) | −129 (.34) |
| LEAD VIX↑ & NQ↑ (divergence) | +3 (.45) | −2 (.44) | −37 (.38) | −64 (.38) |
| LEAD credit-widen & NQ↑ | −21 (.44) | −34 (.43) | −53 (.41) | −119 (.33) |

The **leading**-divergence shorts (short the *strength*: macro deteriorating while NQ still
rising — the textbook "credit leads equity") also lose. **Trend-conditioning doesn't rescue
it either** (`M1-03` c): requiring NQ already below its 50- or 200-day MA still yields
win% 0.38–0.46 and 2–4 positive years out of ~20.

**Placebo (`M1-02`):** every short's realised directional return sits at the **0th
percentile** of a 2,000-draw matched-count random-entry null — i.e. worse than essentially
all random days. The signals are *anti*-predictive for shorts.

**Per-regime sign inversion (`M1-02`, kills them by the project's own rule):** the stress
shorts only "work" in a couple of crises and invert elsewhere. E.g. risk-off-top-decile
SHORT directional % by regime: 2008 GFC **+2.7**, 2020 COVID **+2.7** (both violent
mean-reverting bounces — short loses hard), calm **−0.9**. Sign flips across regimes ⇒ dead.

---

## The one real structure — FADE-THE-FEAR LONG (`M1-03` d, `M1-02`)

Same stress triggers, taken **long** (dir=+1), 5-day hold:

| signal | full n | mean | win% | yr-positive | 2021+ mean | 2021+ median |
|---|---|---|---|---|---|---|
| VIX top-decile → LONG | 758 | +51 | 0.60 | **0.88** (≈18/20+ yrs) | +168 | +230 |
| HY/IG z<−1.5 → LONG | 684 | +63 | 0.62 | 0.80 | +180 | +183 |
| risk-off top-decile → LONG | 701 | +45 | 0.59 | 0.74 | +151 | +190 |
| VIX 5d spike → LONG | 726 | +37 | 0.57 | 0.74 | +146 | +189 |

- **Beats drift:** unconditional 2021+ long median = +82 pts; fade-long VIX-top = **+230**
  (~2.8×). Placebo percentile 0.96–1.00. Real conditional lift, not drift.
- **Regime caveat (the mean-reversion tax):** it **loses in sustained crashes** — 2008 GFC
  and 2000–02 are the down years inside that 0.88. Classic "buy-the-dip works until it
  doesn't"; a 2008-style grind will hurt. Size for that.
- **Option-expression caveat:** it fires when VIX is in its top decile, so a 30-DTE **long
  call** is bought into *elevated* IV and eats vol-crush as fear normalises. The move is big
  enough (median +190/+230 pts in 2021+), but the clean expression is long futures or a
  short-put / call-spread, **not** a naked long call.
- Also strong but a different animal: **NQ −2σ vs its own 20-day mean → LONG** (pure
  price mean-reversion, not cross-market): 2021+ mean +174 pts, yr-positive 0.78, placebo
  1.00. It's a dip-buy, not a macro-divergence signal, and adds the most long exposure.

---

## Correlation to the existing book (`M1-05`, 2021–2026, book trading days)

Book combined = pcc + monday + gapfade daily PnL. Macro signal = 1-contract MTM
($20/pt) while in the 5-day hold.

| macro signal | vs pcc | vs monday | vs gapfade | **vs combined** | $/day |
|---|---|---|---|---|---|
| FADE-LONG VIX-top | +0.025 | −0.055 | −0.025 | **−0.048** | +146 |
| FADE-LONG risk-off | +0.035 | −0.065 | −0.036 | **−0.056** | +172 |
| SHORT risk-off (hedge attempt) | −0.035 | +0.065 | +0.036 | **+0.056** | **−172** |

**Book's worst 20 combined days (mean −$5,883/day):**

| macro signal | same-day $/day | total on worst-20 | next-5d sum after a worst day |
|---|---|---|---|
| FADE-LONG VIX-top | **+$1,367** | +$27,340 | +$705 |
| FADE-LONG risk-off | +$1,143 | +$22,855 | +$2,417 |
| SHORT risk-off (hedge) | **−$1,143** | −$22,855 | −$2,417 |

**Interpretation:**
- The **fade-LONG** is ~**uncorrelated / slightly negative** (−0.05) to the combined book
  and, notably, **earns on the book's worst days** (+$1.1–1.4k). That's because the book's
  worst days are high-volatility *trend* days (gap-fade continuation, etc.) that frequently
  resolve *up*, where an already-long swing gains. It's a genuine **return-diversifier via
  horizon** — but it is a LONG, so it does not *hedge* directional equity risk.
- The deliberate **SHORT hedge is the worst of both worlds:** it *loses money* (−$172/day),
  it is *positively* correlated to the book (+0.056), and it *bleeds on the book's worst
  days* (−$1,143). You cannot buy a paid macro-short hedge here — it costs carry AND fails
  to hedge.

---

## RANKED shortlist

1. **FADE-THE-FEAR LONG — VIX top-decile (or HY/IG z<−1.5 / risk-off top-decile).**
   Mechanism: cross-market stress at daily close marks short-term capitulation; NQ
   mean-reverts up over 3–5 days. **Direction: LONG. Big enough for 30-DTE?** Yes (2021+
   median +190/+230 pts) — but buy futures/short-put, not long calls (IV crush).
   **Stable across regimes?** Mostly (yr-positive 0.88) **except sustained crashes (2008,
   2000–02) where it loses** — a mean-reversion risk, not a hedge. **Diversifies the book?**
   Yes by the numbers (corr ≈ −0.05, +$1.4k on book-worst-days) — but as a return-adder on
   a different horizon, **NOT as a defensive/short hedge.**
2. **NQ −2σ-vs-20d-mean → LONG** (price mean-reversion, not cross-market). Strongest raw
   edge (2021+ mean +174, placebo 1.00) but purely a dip-buy; maximally *adds* long exposure
   — least diversifying. Listed for completeness / as a benchmark the macro signals must beat.

## DEAD list (do not revisit at daily→3–20d swing horizon)

- **All cross-market SHORTS**, every family, every horizon: VIX-spike, credit-widening
  (HYG, HY/IG), risk-off composite, DXY-spike, breadth (IWM−SPY), gold-bid, BTC-weak,
  TLT-flight, stock-bond-corr-flip — **anti-predictive for shorts** (fade-the-fear longs
  instead). Placebo 0th-percentile, win% ≤0.46, sign inverts across regimes.
- **Leading-divergence shorts** ("credit/breadth weak while equity still strong") — the
  textbook lead-indicator trade — also lose at 3–20d.
- **Trend-conditioned shorts** (stress + NQ<MA50/MA200) — still lose.
- **The deliberate macro-SHORT hedge** — negative carry, positively correlated to the book,
  loses on the book's worst days.

## Bottom line for the owner

There is **no daily cross-market divergence signal that reliably shorts NQ for a multi-day
down-move** — the down-move is already in the price by the close, and the tradeable edge is
the *bounce*. The defensive/diversifying hedge you were hoping for is not in this data at
this horizon. The only real macro-divergence edge is **long, contrarian ("buy the fear")**,
which happens to be near-uncorrelated to the book and even earns on its worst days, but it
**adds** rather than hedges equity-long exposure and carries a buy-the-dip tail risk in
sustained bear markets. If a defensive overlay is the goal, it will have to come from
something other than daily cross-market levels — this screen says "null" on the short side.
