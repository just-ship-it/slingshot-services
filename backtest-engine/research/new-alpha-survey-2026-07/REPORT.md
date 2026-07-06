# New-Alpha Survey — 2024–mid-2026 Literature (2026-07-05)

Deep-research sweep for genuinely new, retail-feasible alpha ORTHOGONAL to the existing book
(GEX levels/flip, level fades, IV-skew/0DTE-IV, fib confluence, opening-range momentum,
second-scale order flow, vol-regime filters, meta-labeling). 6 search angles, 25 primary
sources fetched, 121 claims extracted, top 25 adversarially verified (3-vote panels):
22 confirmed, 3 refuted. Every performance number below was checked verbatim against the
primary paper.

---

## RANKED SHORTLIST

### 1. Cross-asset rebalancing front-running (TOP CANDIDATE — high confidence)

**Paper:** Harvey, Mazzoleni & Melone, "The Unintended Consequences of Rebalancing" — NBER w33554, rev. Jan 2026. Presented AFA 2026 + NBER Asset Pricing.
https://www.nber.org/system/files/working_papers/w33554/w33554.pdf

**Mechanism:** Mechanical institutional 60/40 rebalancing (threshold- and calendar-based)
creates predictable next-day price pressure: one-SD signal → ~16–17 bps LOWER equity
returns, ~2–4 bps HIGHER bond returns, reverting almost fully within two weeks. Inventory
pressure, not fundamentals.

**Performance:** Long-short S&P 500 / 10Y Treasury futures sized by the signals:
~10.2%/yr at 9.17% vol, **Sharpe 1.11, skew +5.23**, 1997–2023; stays near Sharpe 1 after
conservative transaction costs. Caveat: crisis-concentrated (ex-GFC/COVID Sharpe 0.90).

**Data/feasibility:** Both signals computed SOLELY from daily ES/ZN futures returns of a
simulated 60/40 portfolio. No flow data needed, real-time computable. We already have ES;
need daily ZN (10Y note futures) — trivially available.

**Fit:** Daily horizon, ES/ZN pair, flow-pressure mechanism — fully orthogonal to the
intraday NQ book, positive-skew profile complements our mean-reversion book.

### 2. End-of-day gamma-imbalance pressure in SINGLE STOCKS (medium confidence)

**Paper:** Barbon, Beckmeyer, Buraschi & Moerke — SSRN 3925725 (Swiss Finance Institute).
https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3925725

**Mechanism:** Dealer delta-hedging gamma imbalance + LETF rebalancing flows predict
last-30-minute single-stock returns (one-SD gamma imbalance → −113% of avg last-half-hour
return; LETF flow → +430%). Both revert (LETF by next open, gamma over ~a day) → an
additional overnight reversal leg exists.

**Performance:** 15:30→close long-short decile strategy: 6.63%/yr, gross Sharpe 4.29, 62%
daily hit rate (2012–2019). Net of costs: combined/gamma-only retain **Sharpe ~1.77/1.76**;
LETF-only leg is dead (~0.05) and decayed by 2019. Gamma effect persistent and if anything
increasing.

**Data/feasibility:** Needs per-stock gamma-imbalance estimates (OptionMetrics-style OI
data or approximations from OPRA OI + standard sign conventions — we already build this
machinery for QQQ/SPY). Cross-sectional equities EOD, so per-name costs matter.

**Fit caveat:** Mechanistically adjacent to our GEX work (smaller diversification benefit),
but cross-sectional single-stock EOD is a genuinely different book. Sample ends Dec 2019 —
first task is confirming survival in 2024–2026 data.

### 3. Conditional 0DTE SPX structures (medium confidence)

**Paper:** Vilkov, "0DTE Trading Rules" — SSRN 4641356, updated Jan/Feb 2026.
Open replication repo: https://github.com/vilkovgr/0dte-strategies

**Mechanism:** Alpha is in structure selection + tactical conditioning at 10:00 ET, NOT
passive premium harvesting (unconditional 0DTE VRP verified as economically tiny — ~0.20%
of spot even on a zero-realized-variance day).

**Performance:** Strict walk-forward OOS (expanding window, 252d burn-in, Apr 2019–Feb 2026,
costs = half-spread + 0.5bp): put ratio spreads **net Sharpe 0.93** (gross 1.18);
diversified top-3 basket ~0.82 net.

**Data/feasibility:** SPX 0DTE chains (CBOE/broker feeds — adjacent to what we already
consume for QQQ/SPY). Open-source code → low implementation cost. "OOS" = walk-forward
backtest, not post-publication live.

**Fit:** Partially adjacent to Short-DTE-IV, but the lever (structure selection/timing) is
different from IV-direction prediction. Also the natural bridge to the parked options-book
exploration (Track A = 0DTE SPX).

### 4. 0DTE intraday VRP sign as a timing signal (RESEARCH LEAD — medium confidence)

**Paper:** Almeida, Freire & Hizmeri — SSRN 4701401 (Princeton/Erasmus/Liverpool).

**Finding:** Only ~35% of SPX 0DTE options (7% of ATM) satisfy stochastic-dominance price
bounds (2012–2023). The 0DTE-implied intraday VRP **negatively** predicts intraday market
returns — opposite the monthly-horizon relation — driven by the "good" (upside) variance
component, significant most of the day (total-VRP significance limited to 11:00–13:00).

**Status:** The paper's bound-violation TRADING strategy claim FAILED verification (1-2) —
profitability dissipated after daily 0DTE listings (May 2022). Treat as a signal-research
lead: a potentially novel intraday timing overlay computable from 0DTE chains we already
consume, possibly on the existing NQ book.

### 5. Overnight-jump-conditioned tug-of-war (MODERATE — medium confidence)

**Paper:** Bahcivan, Finance Research Letters vol. 86, 2025.

**Finding:** Conditioning the Lou-Polk-Skouras overnight/intraday decomposition on
overnight price jumps: the zero-cost strategy's overnight leg earns 3.9% lower risk-adj
return in jump stocks; intraday reversal leg shows 4.4% smaller loss in jump stocks next
month. Tradable asymmetry for any overnight/intraday decomposition strategy. Data needs
modest (daily open/close + jump detection). Single letters-format study, no cost analysis.

### 6. Small-cap 11 AM hour-of-day anomaly (SPECULATIVE)

**Paper:** Zirk-Sadowski & Hryckiewicz, Finance Research Letters vol. 86, 2025 (~11.6M
observations, bootstrapped ANOVA). Significant 11 AM effect, most robust at 45–60 min
horizons, Tue–Thu; Mondays invert (reversed 10 AM effect). Purely descriptive, gross
returns, small-cap spreads likely eat much of it. Timing-overlay input at best.

### 7. Dispersion / correlation-risk-premium trading (THEORETICAL SUPPORT)

**Paper:** Dhaene, Linders, Ling & Wang, Annals of Actuarial Science 19(2), 2024/25
(peer-reviewed, Cambridge UP). Shows the persistent implied>realized correlation gap can
exist in arbitrage-free equilibrium — dispersion trades are not an artifact destined to
close. Supporting empirical claim from fetch phase: long dispersion on smart-beta baskets
earned significant premia 2011–2023 while S&P 500 dispersion RP ≈ 0 (harvestable premium
migrated to non-mega-cap baskets). Multi-leg single-name options = cost/margin-heavy for
solo; lowest priority.

---

## VERIFIED NEGATIVE RESULTS (do NOT pursue)

1. **Index reconstitution front-running is competed away** (Pegoraro, Sammon & Shim SSRN
   6772502, 2026; corroborated by Greenwood & Sammon, Journal of Finance 2025: S&P 500
   addition abnormal returns fell 7.4% (1990s) → 0.3% (past decade)). Only niche corners
   (fast-track IPO adds of hard-to-short names) retain pressure.
2. **Unconditional overnight ES drift is dead after costs** (Boyarchenko, Larsen & Whelan,
   RFS 2023 / NY Fed SR917): 2:00–3:00 AM long Sharpe 1.1 gross → −0.5 net. NightShares
   ETFs shut down 2023. Mechanism (dealer inventory / closing order imbalance, stronger
   after selloffs) is real — an RSV-conditioned variant is the only lead, and the paper's
   own "buy-the-dip 1.1 net Sharpe" claim failed our verification (1-2).
3. **Unconditional 0DTE variance premium** — too small to monetize (see #3 above).

## REFUTED IN VERIFICATION (excluded)

- "ES returns concentrate 2:00–3:00 AM and survive multiple-testing corrections" — 0-3.
- Conditional buy-the-dip overnight Sharpe 1.1 net — 1-2.
- 0DTE bound-violation trading strategy (10x Sharpe) — 1-2; edge dissipated post-May-2022
  daily listings.

## COVERAGE GAPS (absence of findings ≠ absence of literature)

Nothing survived the verify pipeline on: cross-asset lead-lag beyond rebalancing (a
DeltaLag deep-learning arXiv paper was surfaced but not verified), earnings/event-driven,
crypto/rates/commodities microstructure, retail-flow/13F/insider, ML factor timing,
alternative data (satellite/credit-card/web). A follow-up sweep could target these.

Also surfaced but unverified (interesting leads): risk-premium-adjusted VIX1D as a
model-free 1-day vol forecast (Journal of Futures Markets 45(11), 2025); LSTM on S&P 100
delta-neutral straddles OOS Sharpe 1.33 (arXiv 2407.21791); Falck/Rej/Thesmar decay
yardstick (~35% average post-publication Sharpe decay — apply to all of the above).

## OPEN QUESTIONS (natural phase-2 items)

1. Does the gamma-imbalance EOD effect survive in 2024–2026 data, and can we approximate
   per-stock dealer gamma imbalance from OPRA OI without OptionMetrics?
2. Net capacity/slippage of Harvey rebalancing strategy at 1–5 ES/ZN contracts; does it
   hold in the 2023–2026 window post-AFA-publicity?
3. Can the negative intraday 0DTE-VRP relation be converted into a futures-timing overlay
   on the existing NQ book, and does it survive the post-May-2022 regime?
4. Run a second sweep on the uncovered families (alt-data, 13F/insider, ML factor timing).

---
Full verified-claims JSON and per-agent transcripts (session-temporary):
task output wh44jnfc6; workflow run wf_7653bff3-3b6.
Stats: 6 angles, 25 sources, 121 claims, 25 verified (22 confirmed / 3 refuted), 108 agents.
