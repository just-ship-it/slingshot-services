# R8 — Downside / short-biased / counter-trend edge census (NQ, ES cross-check)

**Mandate:** the book has two LONG edges and no downside protection. Hunt for a
SHORT-favorable or counter-trend state whose forward return is reliably negative
*beyond* NQ's structural up-drift, with per-year sign stability. Descriptive only
(no WR/PF/fills — 1s sims later). A decisive null is an acceptable outcome.

**Data:** primary-contract-filtered 1m cache (`cache/{NQ,ES}_1m_primary.csv`,
2020-12→2026-06), collapsed to a daily+intraday-marks panel `R8_{NQ,ES}_daily.csv`
(builder `R8-00-build-daily.py`). All returns in **points**, RAW contract space.
Rollover days excluded from any gap / day-over-day test (symbol-change = phantom gap).
ATR14 = 14-day SMA of prior RTH true range (causal). Clock marks = close at each
ET minute, at-or-before. Scripts: `R8-01..06`, helpers `R8lib.py`.

---

## HEADLINE VERDICT

**There is NO all-regime, all-years short edge.** NQ's up-drift is weak and noisy
day-to-day, but every *conditional* state that looked short either (a) shows
**continuation, not reversal** (momentum, the opposite of a fade), (b) is a
**shared-price tautology** that evaporates under a clean forward test, or (c) is a
**bear/normal-regime tilt** that fails in melt-up years.

**One short-tilted candidate survives as rankable (not deployable as-is):** the
**large-gap-up morning fade on NQ** — after a big gap-up open, the first ~90 minutes
(09:30→11:00) drift **down** in 5 of 6 years (fails only 2021, the melt-up). It
would have paid in 2022 and 2025 (the down/vol years, when the long edges bleed) and
still paid in 2023/2024/2026 mornings. That is real diversification value. It does
NOT meet the survival bar (not positive *every* year), and needs 1s confirmation.

**Downside is otherwise only a bear-regime phenomenon, and it is NOT live-flaggable:**
a trailing-SMA "downtrend" flag does not predict forward down-drift once the
look-ahead is removed (see H4/regime below). So: shorts are tradable in bear regimes
in hindsight, but there is no knowable-at-decision-time regime switch that turns a
persistent short on.

---

## Per-hypothesis results

### Control — unconditional drift census (`R8-01`)
The load-bearing baseline. NQ full-RTH drift +4.67pt (t=0.92); the up-drift
concentrates in the afternoon (**13:00→16:00 +4.93pt, positive all 7 years** — the
book's known long region). Overnight (prior close→open) +5.20pt.

**Only negative unconditional window found:** the pre-pre-close dip **15:15–15:45 ET**.
- NQ 1515→1530: −0.76pt, negative **6/7 years**; 1530→1545: −0.79pt, 5/7.
- ES 1530→1545: −0.33pt, t=−1.65, negative **5/6 years**.
- Immediately followed by the 15:45→16:00 pop (+1.60pt NQ, +6/1 years).

Persistent, both products, but **magnitude ~0.8pt — below the ~1pt round-trip
slippage floor.** Descriptive curiosity, not tradable alone. DEAD for trading.

### H1 — Exhaustion / overextension fade (`R8-02`)
Condition on intraday up-extension `(price(T)−open)/ATR` at T∈{10:30,11:00,12:00,13:00};
forward T→16:00. **Decisive opposite of the hypothesis:** the top up-extension
quintile has the **highest** forward return (continuation), positive 5/6 years; the
bottom (down-extension) quintile continues **down**. This is momentum, not
mean-reversion. **DEAD** (and confirms an up-momentum structure, NQ and ES).

### H2 — Gap-up fade (`R8-02`, `R8-06`) — the survivor
Large gap-ups DO fade, strongest in the **morning**:
- NQ gap≥0.3·ATR, **open→11:00: −5.42pt, negative 5/6 years** (only 2021 +4.4). n=324.
  vs unconditional morning −1.07pt.
- NQ gap≥0.5·ATR, open→11:00: **−12.91pt, 5/6 years** (2021 +20.6). n=157 (~28/yr).
- NQ gap≥0.75·ATR, open→11:00: **−30.83pt, t=−2.21, 4/6.** n=60.
- Full-day open→16:00 is **noisier** (2024, 2026 flip positive) — the afternoon
  up-drift rescues bull-year gaps, so the edge lives in the morning.
- ES: same sign, weaker (higher-beta NQ shows it more): gap≥0.5·ATR open→1600
  −6.36pt, 4/6 years.

Mechanism: opening-gap mean reversion, concentrated in the largest gaps and the
first 90 min. Live-computable (gap = open − prior RTH close; ATR from prior days —
all known at 09:30). One signal/day → pooled = day-weighted (no rule-8 divergence).
**Not survival-bar-passing (fails 2021 melt-up), but the best short-tilted candidate.**

### H3 — Failed-breakout / upside-sweep reversal (`R8-03`)
Prior-day-high (PDH) and overnight-high (ONH) sweeps. The "closed back below the
level" group is trivially negative (tautological — the return is measured to a close
that is by definition below entry). The **causal test — return from the reclaim
instant forward** — is NOT short:
- NQ PDH reclaim→close **+4.04pt** (3/7 years neg); reclaim→+60m −2.40pt (4/7, tiny).
- NQ ONH reclaim→close **+7.91pt** (2/7 neg).
Sweeps tend to resolve **up** (liquidity grab then continue), and **held** breakouts
continue strongly up (+87pt PDH, +108pt ONH to close — a long momentum signal).
**DEAD as a short.**

### H4 — Late-day downside window
Covered by the control (`R8-01`): the only negative window (15:15–15:45) is
sub-slippage. No afternoon window has a tradable negative signed drift. The known
long pre-close window (15:00→15:30 direction-following, 15:45→16:00 pop) dominates.
**DEAD.**

### H5 — High-vol-regime afternoon fade (`R8-02`)
High-ATR quintile → afternoon 13:00→16:00 is **positive** (+14pt NQ top quintile,
4/1 years up); 15:00→16:00 also non-negative. High vol does not produce an afternoon
fade. **DEAD.**

### H6 — Day-after a big up day (`R8-02`)
Big up day t (top `rth_ret/ATR` quintile) → next overnight +0.38pt, next RTH +5.25pt
(NQ) — **no** next-day weakness. Notable inverse: big **DOWN** day t → next RTH
**+19pt** (NQ), +5.6pt (ES) — a mean-reversion **long** bounce (not my mandate; flagged
for the long book). **DEAD as a short.**

### Regime / "bear-only" test (`R8-04`, `R8-05`) — the important null
A live trailing-SMA trend flag was the natural "bear-regime conditioner."
- **Contemporaneous version (`R8-04`) looked spectacular:** open-below-SMA100 →
  overnight −20.9pt, negative **6/6 years**; above-SMA → +15.7pt, 0/6. **This is a
  shared-price tautology** — the regime flag (open<SMA) and the overnight return
  (open−prior close) both contain the open, so a down-gap mechanically produces both.
- **Clean forward version (`R8-05`)** — flag at close[t] (knowable 16:00), predict the
  NEXT overnight/next-day — **the short evaporates:** NQ below-SMA100 forward
  overnight −7.32pt but only **3/6 years** negative; forward next-day RTH is
  **positive** (+12pt, mean-reversion up). The below-SMA state does not forward-drift
  down reliably.
- Mirror: the **above-SMA forward overnight is a reliable LONG** (NQ +10.2pt, t=2.48,
  5/6 years; ES +1.05, positive). Noted for the long book; likely correlated with the
  existing long edges, not a diversifier.

**Conclusion:** there is no knowable-at-decision-time regime flag that turns on a
persistent short. Bear-regime down-moves are real but only identifiable ex-post.

---

## RANKED shortlist

**#1 (only rankable) — NQ large-gap-up morning fade.**
- Signal (all knowable at 09:30 ET): gap = 09:30 open − prior RTH close; if
  gap ≥ K·ATR14 (K≈0.5), **short at the open, cover ≈11:00 ET**.
- Effect: gap≥0.5·ATR open→11:00 **−12.9pt** mean, **5/6 years negative** (fails only
  2021 melt-up), n=157 (~28/yr). At K=0.3: −5.4pt, 5/6, n=324 (~59/yr). vs
  unconditional morning −1.1pt.
- Regime label: **all-years EXCEPT strong-melt-up (2021)** — importantly this is
  NOT bear-only; it pays in bull mornings 2023/2024/2026 too, and pays hardest in
  the down/vol years (2022, 2025) — the exact diversification the book lacks.
- Cost: intraday short round-trip ≈0.5–1.0pt slippage; net edge comfortable at K≥0.5
  (−12.9pt gross), marginal at K=0.3 (−5.4pt gross). NQ point = $2 (or $0.50 MNQ).
- Live-computability: trivial (OHLCV only). ES cross-check same sign, weaker.
- **Proposed 1s follow-up:** simulate short at 09:30 fill instant, exit at 11:00 ET
  (and test a protective stop at, e.g., +0.5·ATR against, plus a 12:00 exit variant),
  1s fills/MFE/MAE from fill_ts. Verify trade count / mean-pt within ~10% of −12.9pt.
  Report per-year WR/PF; expect a losing 2021. Sweep K∈{0.3,0.5,0.75}.

*No #2.* Nothing else clears "beats the unconditional drift with per-year stability."

---

## DEAD list (do not revisit as shorts)
- **H1 exhaustion fade** — up-extension *continues up* (momentum), both products.
- **H3 failed-breakout / sweep reversal** — reclaim instant drifts *up*; held breaks
  continue up. Not a short.
- **H4 late-day fade** — only negative window (15:15–15:45) is ~0.8pt, sub-slippage.
- **H5 vol-regime afternoon fade** — high vol → afternoon *up*.
- **H6 day-after big-up** — no next-day weakness (big-DOWN days bounce *up* instead).
- **Trailing-SMA "downtrend" short** — clean forward test is not negative; the strong
  version was a shared-open tautology. No live-flaggable bear-regime switch.
- **Full-day gap-up fade (open→16:00)** — afternoon up-drift rescues bull-year gaps;
  only the *morning* leg is stable.

## Long-side observations (not the mandate; for the long book / diversification audit)
- Above-SMA forward overnight = reliable long (NQ +10.2pt, 5/6 yr) — probably
  correlated with existing long edges, so **not** a diversifier.
- Big-DOWN day → next-RTH bounce up (+19pt NQ, +5.6 ES) — a mean-reversion long.
- Held PDH/ONH breakouts continue strongly up — breakout-continuation long.

## Honesty notes
- Every conditional was measured vs the same-window unconditional drift and split
  per-year; sign-flips across years were treated as noise per charter rule 6.
- The regime tautology (R8-04 vs R8-05) is the key methodological catch: a
  contemporaneous flag that shares a price with the forward return will manufacture a
  6/6-year "edge" that is not tradable. Always flag at a strictly-prior instant.
- All numbers here are descriptive (1m marks). No WR/PF/fills claimed — the #1
  candidate requires 1s simulation before any belief per the 1s mandate.
