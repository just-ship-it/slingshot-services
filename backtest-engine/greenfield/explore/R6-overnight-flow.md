# R6 — Overnight / Globex-session flow census (NQ, 18:00→09:30 ET)

Descriptive census only — NO win rates, PF, or fill simulation (1s sims come later
for survivors). All effects in NQ points and vol-normalized (ret / prior-14d ATR).
Session date rolls at 18:00 ET; overnight = session_minute 0..929 (18:00..09:29 ET).
Windows are once-per-day events, so **pooled mean = day-weighted mean** (one
observation per session) — no rule-#8 divergence to flag. Every conditioner is
knowable strictly before its outcome window. NQ is UTC in the source cache
(verified: DST-correct via `America/New_York`); ES cache already ET-stamped.

Scripts (rerunnable, repo-root `python3`):
`R6-00-prep.py` (UTC→ET panels), `R6lib.py` (session-minute + window helpers),
`R6-01-minute-census.py`, `R6-02-windows.py`, `R6-03-drill.py`,
`R6-04-conditional.py`, `R6-05-jointscan.py`, `R6-06-london.py`, `R6-07-robust.py`.
Panels: `cache_nq_et_panel.csv.gz`, `cache_es_et_panel.csv.gz`.

---

## HEADLINE

**One survivor: the 03:35→04:05 ET European-cash-open drive (long).**
NQ +2.58 pt gross, t=3.75, **positive all 6 years (2021-2026) on BOTH NQ and ES**,
99.4th-pctile (literally the max) of all same-width overnight windows, median≈mean
(not outlier-driven), robust across DST seasons and weekdays. Net after conservative
overnight cost ≈ **+1.5 pt/day**. This is the only overnight effect that clears the
joint stability + ES-replication + cost bar.

**Everything else the broad scan flagged is dead as a tradable edge** — the sharp
per-minute drifts (23:00, 03:25, 09:27) are single-minute print artifacts that
collapse under any tradable entry/exit tolerance; the big drifts (whole-overnight,
Europe-150m, reopen, Sunday) are regime beta or NQ-only noise that fail per-year
stability and/or ES confirmation; all conditional structure (handoffs, 08:30 macro,
autocorrelation) is null.

---

## H1 — Time-locked drift

### The breadcrumb single-minute effects are ARTIFACTS (all DEAD-on-cost)

Per-minute census (`R6-01`) reproduces the flagged effects, but they are
**one-minute spikes** that vanish the instant you widen to a tradable window:

| minute (ET) | NQ 1-min mean | NQ t | yr signs | widen to tradable window → |
|---|---|---|---|---|
| 23:00 | +0.65 pt | +6.54 | ++++++ | 22:55–23:05 → +0.24 (t=1.03); 23:00–23:30 → +0.44 (t=1.14) **collapses** |
| 03:25 | −0.44 pt | −3.14 | −−−−−− | 03:15–03:30 → −0.25 (t=−0.47) **collapses** |
| 09:27 | −0.95 pt | −5.40 | −−−−−− | 09:20–09:29 → −0.88 (t=−1.97), yr [+−−−−+] unstable, RTH-adjacent |

**23:00 decomposition** (`R6-03`): 86% intrabar (+0.556) / 14% gap (+0.091). The ES
analogue is +0.19 pt with t=**8.58** — a mean *below one ES tick (0.25)* yet hugely
significant = a **mechanical print bias at the 23:00 ET stamp**, not a tradable move.
To capture the NQ +0.65 you must be filled at 23:00:00 and exit at 23:01:00; a single
0.5 pt/side overnight cost (≥1 pt round-trip) exceeds the gross. **DEAD.** (1s
follow-up not worth running — net is negative before it starts.)

Mechanism note: with 1,379 overnight minutes scanned, ~43 will show 6/6 same-sign by
chance alone; 6/6 on a single minute is inside the multiple-testing floor. Magnitude
+ ES-confirmation + window-robustness are the real filters, and these three fail them.

### Broad / session drifts are regime beta, not clock-locked edges

| window (ET) | NQ mean | t | NQ yr signs | ES mean | verdict |
|---|---|---|---|---|---|
| 18:00→09:29 whole overnight | +4.90 | 1.44 | +−++++ (2022 = −10.1) | +0.44 (t 0.59) | equity overnight risk-premium; 2022 bear = −10 pt; 14.5 h hold; **DEAD as trade** |
| 02:00→04:30 Europe 150m | +3.76 | 2.44 | −+++++ (2021 neg) | +0.44 (t 1.23) | inflated by 2025/26 bull; ES weak; **superseded** by the 30-min core below |
| 18:00→19:00 reopen | +1.54 | 1.76 | −+++++ | +0.15 (t 0.84) | ES flat, 2021 neg; **weak/DEAD** |

---

## SURVIVOR — 03:35→04:05 ET European-open drive (LONG)

Emerged from the joint NQ+ES grid scan (`R6-05`): of 831 windows, only 6 are
same-sign every year on **both** NQ and ES; this cluster (03:30–04:10) is the tightest
and highest-t. Locked window **03:35→04:05 ET (30 min)** (`R6-06`, `R6-07`):

| metric | NQ | ES |
|---|---|---|
| mean (close→close) | **+2.58 pt** | +0.44 pt |
| mean (market-exec, open→open) | **+2.67 pt** | +0.45 pt |
| t-stat | **+3.75** | +2.73 |
| median | +2.60 | +0.25 |
| 95%-trimmed mean | +2.29 | +0.40 |
| % positive days | 55.4% | 52.1% |
| vol-normalized (ret/ATR14) | +0.0074 | +0.0014 |
| per-year (2021→2026) | +2.18 / +3.59 / +1.40 / +0.94 / +2.15 / +8.43 | +0.36 / +0.83 / +0.24 / +0.24 / +0.47 / +1.28 |
| **positive every year** | **YES (6/6)** | **YES (6/6)** |
| placebo rank (same-width 30m overnight windows) | **99.4th pctile = the MAX** (placebo mean +0.20) | — |
| n | 1,401 days | 1,288 days |

**Why it is an edge, not beta:**
- Positive in **2022** (+3.59) — a year the *whole* overnight was −10 pt. A drive that
  is up in a bear-overnight year is a localized flow signature, not market beta.
- `corr(window return, prior-overnight move) = −0.047` ≈ 0 → **autonomous drive**,
  not momentum continuation of the earlier overnight tape.
- median ≈ mean, trimmed mean +2.29 → **not outlier-driven** (real central drift).
- Winter +2.73 / summer +2.24 → holds across the US/UK DST seam.
- Positive every weekday (Mon +1.66 weakest → Thu +3.14 strongest).
- **ES confirms every single year** — the cross-instrument agreement that lifts it
  above the multiple-testing floor.

**Mechanism (plausible):** European cash equity open (Frankfurt/Paris 09:00 CET,
London 08:00 = ~03:00 ET); institutional European flow establishes session direction
in the first ~30–70 min, and index futures drift with it. Empirically it is
**ET-clock-locked** (robust across the DST seam), which is what matters for execution.

**Cost realism:** 03:35–04:05 ET sits in the active European morning, *after* the
00:00–02:00 ET dead lull, so liquidity is moderate (not the worst overnight book).
Trade = market entry (slips) + time-based market exit (slips), both sides slip:
- @0.5 pt/side → −1.0 pt round-trip → **net ≈ +1.58 pt/day**
- @0.6 pt/side → −1.2 pt round-trip → **net ≈ +1.38 pt/day**

Gross +2.58 clears a conservative round-trip with ~1.5× margin. **Net ~+1.5 pt/day**
is below the 3–4 pt/day book target as a 1-lot, but it is positive every year and
**structurally uncorrelated** with the confirmed 15:00→15:30 RTH trade (different
session, participants, hours) — exactly the diversifier R6 was chartered to find.
Sizing (2-lot ≈ +3 pt) or a stop/target overlay (1s study) can close the gap.

**Live-computability:** trivial — a wall-clock trigger on OHLCV (live source = YES).
No GEX/LT/IV inputs needed. Fully deployable if it survives 1s costs.

**Proposed 1s follow-up (required before any WR/PF claim):**
1. From `data/ohlcv/nq/NQ_ohlcv_1s.csv` (primary-filter per hour), simulate market
   entry at the 03:35:00 bar and market exit at 04:05:00, walking 1s from fill_ts,
   with realistic overnight slippage measured from the actual 1s spread in this hour.
2. Confirm net EV/day and % positive reproduce the 1m census within ~10%.
3. Test a protective stop (e.g., 1×–1.5× the 30-min ATR) — does a stop lift PF or just
   clip the fat-right-tail winners? Also test a small profit target vs pure time-exit.
4. Verify the exact optimal minute boundaries on 1s (03:35 vs 03:30/03:40 start).

---

## Secondary / marginal (noted, not a candidate)

- **02:10→02:40 ET** (`R6-05/07`): NQ +1.47, positive 6/6 [0.8/1.3/0.6/2.2/1.2/4.1],
  ES +0.22 6/6. But gross +1.47 in the thinner 02:00 ET hour → after ~1 pt+ cost
  (worse book here) net ≈ +0.3–0.5 pt — **too small to clear realistic cost
  reliably.** A weaker echo of the same European-open drive; not independently viable.

---

## DEAD LIST (explicit)

| # | hypothesis | result | why dead |
|---|---|---|---|
| 1 | 23:00 ET drift-up (breadcrumb) | NQ +0.65/6-6, ES +0.19 (sub-tick!) | single-minute print artifact; collapses when windowed; gross < cost |
| 2 | 03:25 ET fade (breadcrumb) | single-min −0.44/6-6 | collapses to −0.25 (t −0.47) at 03:15–03:30; ES weak |
| 3 | 09:27 ET pre-open fade | single-min −0.95/6-6 | window unstable [+−−−−+]; RTH-adjacent |
| 4 | Whole-overnight drift 18:00→09:29 | +4.90 t=1.44 | equity overnight risk-premium; 2022 = −10; regime beta; 14.5 h hold |
| 5 | 18:00 reopen drive / 18:00→19:00 | +1.54 t=1.76 | 2021 neg; ES flat; regime-dependent |
| 6 | H2 Asia→Europe handoff | corr −0.046, yr [+−−−++] | near-zero, per-year sign flips; ES same |
| 7 | H2 Europe→pre-NY handoff | corr −0.043, yr [−−+−−−] | near-zero, unstable |
| 8 | H2 Asia→pre-NY handoff | corr −0.010 | zero |
| 9 | H4 08:30 macro continuation | NQ corr +0.079 (p .003) | per-year unstable [++−+−+]; ES shows NO directional component (±0.19 both ways = pure vol, no drift) |
| 10 | H5 Sunday (Mon-session) reopen | NQ +4.82 (t 1.86) | **ES flat (+0.14 vs +0.15)** → NQ-only weekend-gap noise |
| 11 | H6 overnight mean-reversion/momentum | 30m lag-1 autocorr **+0.005** (p .33) | tape efficient at overnight horizons; no momentum, no reversion |

---

## Ranked shortlist

| rank | candidate | gross (NQ) | net after cost | per-year | ES | live-computable | status |
|---|---|---|---|---|---|---|---|
| **1** | **03:35→04:05 ET Euro-open drive (long)** | **+2.58 pt** | **~+1.5 pt/day** | **6/6 positive** | **6/6 ✓** | yes (clock trigger) | **→ 1s follow-up** |
| 2 | 02:10→02:40 ET (echo) | +1.47 pt | ~+0.4 pt | 6/6 positive | 6/6 (tiny) | yes | too small vs cost — park |
| — | all others | — | ≤0 after cost | fail | fail | — | DEAD (table above) |
