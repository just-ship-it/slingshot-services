# RogueTrader PDF ideas — backtest vetting (2026-07-22)

Source: two setups mined from `C:\Users\Drew\OneDrive\Documents\Trading` PDFs that were NOT already in
the research program:
1. **Squeeze precursor** (`Flagging_Potential_Short_Squeezes.pdf`) — swing long 1–2 days ahead of an SPX
   gamma squeeze, flagged by (A) ATM **call IV > put IV** and (B) **VIX put/call ratio elevated (>0.67)**.
2. **Gap continuation** (`SPX_PATTERN_RECOGNITION_FOR_INTRADAY_BOTTOMS_AT_OPEN.pdf`) — on gap days the RTH
   open is the day's extreme; if it holds ~15–20 min, ride the gap direction to close. Up-day biased.

Scripts: `RG1-squeeze-precursor.py`, `RG2-gap-continuation.py`, `RG2b-gap-rigor.py`, `RG2c-spy-daily-gaps.py`.
Data sourced tonight: CBOE equity/index/total put/call ratios via the TV daily pipeline → `data/macro/pc*_1d.csv`
(2006/07→2026). VIX-specific P/C symbols didn't resolve on TV; standard CBOE P/C used as analog (longer history).

---

## 1. Squeeze precursor — VERDICT: rediscovers a KNOWN factor; the novel part fails

**Signal A (call IV > put IV, SPY dte0, 2023-03→2026-01 — binding IV window):**
- Standalone edge over baseline is NOT significant. SPY H=2d: +0.098% vs +0.051% base, bootstrap **p=0.30**.
  Per-year: negative 2023, positive 2024–25 → a **bull-market coincidence**, not a precursor. The piece's
  actually-novel claim does not hold up.

**Signal B (put/call ratio elevated → contrarian long, 2007→2026, 19yr):**
- REAL and significant, monotonic in threshold. SPY H=2d: pc_eq>1.0 → +0.199% edge +14.8bps **p=0.004**, PF 1.35;
  pc_eq>trailing-1y-90th-pctile → +0.207% edge +15.6bps **p=0.007**, PF 1.30. NQ H=3d P/C-90pctile: +0.410%
  **p=0.027**, PF 1.43. pc_total>90pctile NQ H=2d: PF **1.46 p=0.017**.
- BUT this is the **textbook put/call contrarian anomaly** (high put buying = fear = mean-revert up), not the
  piece's insight. Tail-driven (2008 = +40% of the pctile bucket's PnL). Long-equity-beta → a poor diversifier
  for Drew's uncorrelated-book goal.

**Best combination — elevated P/C + falling VIX** (`Bpctile & vix_falling`), the piece's spirit:
- NQ H=1d: +0.342% edge +30bps **p=0.011** PF **1.74**; NQ H=2d: +0.614% edge +52bps **p=0.012** PF **1.99**.
- Still fundamentally the known contrarian-sentiment factor with a vol-subsiding gate.

**Bottom line:** No *new* alpha. The idea works only through the well-documented put/call contrarian effect.
The distinctive "call-richer-than-put IV" precursor is noise. Not worth pursuing as novel; at most a minor,
equity-correlated overlay. **PARK.**

---

## 2. Gap continuation — VERDICT: real but sample-starved and DECAYING; not deployable as-is

**Unconditional gap-chase is DEAD (the long view kills the naive form):**
- SPY daily 1994–2026 (32yr): up-gap long open→close mean **-0.000%, PF 1.00** — *worse* than being long every
  day (+0.009%). Down-gaps don't continue either. **Gaps fade on average** (matches the literature).
- Recent years explicitly negative: SPY big-up-gap long 2023 -0.042%, 2024 -0.028%, **2025 -0.116%**.
- NQ big up-gap long is positive overall (+0.256%, PF 1.34) but that's mostly the 2000–2002 dot-com regime.
- (The "open≈day-low → +1%, 100% WR" line is a **lookahead tautology** — if open is near the low, close ≥ open
  by construction. Non-tradable; flagged in the script.)

**The ONLY lever is the intraday 20-min confirmation** (RG2/RG2b, NQ continuous 1m 2021→2026):
- Confirmed up-gap long (open held as low through the window, entry at window end, exit 15:45):
  headline w=20 tol=5 thr=30 → n=50, mean **+27pt, PF 1.80, WR 64%, Sharpe 1.72**.
- The gate does **real work** (not the first-hour "unconditional drift" trap): unconfirmed up-gap long ≈ +1pt,
  confirmed ≈ +27pt. Survives **vol-normalization** (0.074 vs 0.014 ×prev-range). Confirmed days are *lower*
  vol than unconfirmed → **not** a volatility-selection artifact. Positive every year 2021–2025. Down-gap
  shorts are dead (consistent with the piece's up-days-only caveat).

**Why it's not deployable:**
- **Thin:** ~10–18 events/year, ~50–90 total. Bootstrap significance of the gate is **marginal** (p≈0.05–0.16
  across configs; only a couple cross <0.05).
- **Decaying:** vol-normalized per-year edge 0.225(2022) → 0.075(2023) → **0.026(2024) → 0.006(2025)**.
- **Fragile to params:** needs tol≥5pt and window ≤20min; w=30/tol=3 variants go flat.

**Bottom line (pre-cross-validation):** The pattern looked genuine (gate separates cleanly) but thin and fading.

### UPDATE 2026-07-23 — cross-validation KILLS it (RG2d, RG2e)

Extended to **ES** (independent instrument, clean continuous 1m — the Wave-A duplicate defect is in the *raw*
file, not continuous) and re-ran with **vol-adaptive** tolerance/threshold (fractions of prior-day range, so
NQ+ES pool and the fixed-5pt scaling artifact is removed).

- **ES replicates only weakly** (PF ~1.2 at tight tol; goes *negative* at loose tol). NQ was the strong outlier.
- **Vol-adaptive removes the "decay" story but exposes inconsistency**: both instruments **negative in 2023**;
  significance *worsens* (gate bootstrap p ≈ 0.15–0.40, none <0.05).
- **Pooled NQ+ES (n=192): PF 1.21, Sharpe ~1.0** — far below the NQ-alone 1.80 headline (that was small-sample
  luck + fixed-tol selection + instrument selection).
- **Mechanism decomposition (RG2e, 2599 days)** — the decisive cut:
  - Real signal is just "**open held as its low for 15 min → long**" (PF 1.25, Sharpe 1.24); the *gap* adds ~nothing.
  - **Short side is dead-to-backwards**: dn-gap held-high → continuation short = **PF 0.60** (they bounce).
    Down-drive is a directional coin-flip (long 0.97 / short 1.03).
  - **Long leg is net NEGATIVE over the last 3 years**: up-gap held-low LONG per-year xRange
    2021 +0.26, 2022 +0.21, **2023 −0.24**, 2024 +0.07, 2025 +0.06. Edge lives entirely in 2021–22.
  - Combined long+short book = **PF 0.92** (loses).

**Plausible structural cause of the 2023+ death:** opening-drive *continuation* dying as 0DTE volume exploded and
pushed intraday behavior toward *mean-reversion*. Consistent with the first-hour program's broader null.

**FINAL VERDICT: DROP.** A weak, long-only, 2021–22-concentrated intraday-momentum artifact that does not survive
independent-instrument cross-validation, is not statistically significant, and has been net-negative since 2023.
No further conditioning warranted (would be curve-fitting a recently-dead signal).

---

## Recommended next steps (if pursued)
1. **Gap continuation, sample extension** — the single thing that could revive it: test the identical 20-min-hold
   confirmation on **ES intraday** (independent instrument; ~doubles events) and on **SPY/QQQ 1m** if sourced.
   Caveat: memory notes the ES 1m file has a duplicate-bar defect (Wave A) — clean it first.
2. **Squeeze precursor** — not worth more; it's a known factor. If ever wanted as an overlay, use
   `pc_eq>90pctile & vix_falling` on NQ 2-day holds, but expect equity-beta correlation.

Neither advances the uncorrelated-book goal materially. Both files/notes retained for the record.
