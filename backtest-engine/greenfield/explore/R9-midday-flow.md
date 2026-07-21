# R9 — Midday / European-close flow census (NQ, ES cross-check)

**Window studied:** ~11:00–13:30 ET midday, plus adjacent 13:30–14:00 post-lunch and
matched AM/PM placebo windows. **Instruments:** NQ (2020-12→2026-06, 1358 clean RTH
days) and ES (2021-01→2026-01, 1283 clean days). **Method:** descriptive census only
— signed forward returns on 1m bar OPEN, instant-to-instant, in points AND
ATR-normalized. NO fills / WR / PF (those need 1s sims, deferred). Each clock-locked
window fires **once per day**, so pooled == day-weighted throughout (GREENFIELD rule
#8 divergence not applicable here — stated, not just assumed). Clean-day universe
excludes rollover days (B12 `full_rth & rth_same_sym` for NQ; single-symbol + roll==0
for ES).

Scripts: `R9-00-cache.py` (ET-localized midday caches), `R9_common.py` (loader+stats),
`R9-01-census.py` (all 5 hypotheses + controls), `R9-02-focus.py` (localization +
net-after-cost). Intermediates: `R9-nq-mid.csv`, `R9-es-mid.csv`, `R9-nq-meta.csv`.

## Bottom line: NULL

**No robust, ES-replicated, per-year-stable, net-of-cost tradable midday edge exists
in 11:00–13:30 ET.** Every candidate that looked promising on first pass was killed by
one of: (a) failure to replicate on ES, (b) sign inversion across years, (c)
specification fragility (a hand-picked reference window that a 5-minute shift
destroys), or (d) net-negative after realistic RTH slippage. The three pieces of
midday folklore in the brief — European-close fade, lunch reversal, midday
compression→breakout — are all **rejected**, two of them **inverted**.

---

## H1 — European-close window (~11:25–11:45 ET): NULL (folklore rejected)

Mechanism tested: European cash close ~11:30 ET unwinds Euro-hours hedging → a signed
drift or a fade/extension of the morning (09:30→11:30) move.

- **Unconditional** 11:25–11:45 drift: NQ −0.40pt (t−0.4), ES +0.04pt (t+0.2) → dead flat.
- **Fade vs extend the morning:** the *first-pass* result looked like a clean
  **momentum EXTENSION** — NQ +2.31pt (t+2.21), ES +0.60pt (t+2.53), and it appeared
  *localized* (died after 11:45). **This was a specification artifact.** It used the
  morning reference `09:30→11:30`, which **overlaps the 11:25→11:45 outcome by 5 min**.
- **Clean re-spec (reference strictly ends before entry):** morning `09:30→11:25`,
  enter 11:25, exit 11:45 → NQ **−0.58pt (t−0.56)**, ES **+0.02pt (t+0.09)**. Gone.
- **Rolling momentum control** (fixed 30-min lookback ending at T, side=sign, outcome
  [T, T+15]) at T=11:30: NQ **−0.41pt (t−0.45)**, ES **+0.00pt (t+0.02)**. And T=11:30
  does **not** stand out from any other time of day (T=10:00 and T=15:00 are the only
  mildly positive cells, both elsewhere and both t<1.9).

The apparent effect inverts under a 5-minute shift of the reference window — the
signature of a best-of-many artifact, not an edge. **European-close signed flow: DEAD.**
(No "fade" and no robust "extend" — the folklore fade is simply absent.)

## H2 — Lunch reversal (12:00–13:00): NULL (folklore rejected)

Fade the late-morning (10:30→12:00) move during the lunch lull, exit 13:00/13:30.

- Unconditional 12:00–13:00 drift: NQ −0.75pt (t−0.5), ES −0.07pt (t−0.2) → flat.
- Fade signal, exit 13:00: NQ −0.36pt (t−0.2), ES −0.30pt (t−0.9) → no edge.
- Conditioning on morning trend **strength** (top/bottom tercile |move|/ATR) does not
  rescue it; cells are t<1 and flip sign across years and across instruments.

**Lunch reversal: DEAD.** The lunch lull is efficient — the morning move neither
reliably reverses nor resumes across 12:00–13:00.

## H3 — Unconditional 30-min signed drift, ranked across 11:00–13:30: NULL-ish

Ranked all 30-min windows (points, ATR-norm, per-year, sign count). Midday windows
carry a mild LONG lean but nothing clears the bar:

| window | NQ mean (t) | NQ yrs± | ES mean (t) | ES yrs± | verdict |
|---|---|---|---|---|---|
| 11:00–11:30 | +1.41 (1.02) | 5/2 | +0.24 (0.82) | 5/1 | = brief's known ~1pt "11:00 pop", **sub-cost** |
| 11:30–12:00 | +1.27 (1.02) | 5/2 | +0.27 (0.98) | 5/1 | small long lean, sub-cost |
| 12:00–12:30 | −0.53 (0.46) | 4/3 | −0.00 (0.01) | 5/1 | flat |
| 12:30–13:00 | −0.22 (0.20) | 3/4 | −0.07 (0.30) | 2/4 | flat |
| 13:00–13:30 | +0.94 (0.72) | 5/2 | +0.01 (0.04) | 4/2 | flat on ES |

The late-morning long lean (11:00–12:00) is the brief's already-known **~1pt 11:00 pop
— sub-cost, micro only** (confirmed here, both instruments). Core midday (12:00–13:00)
is dead. No midday window is an unconditional clock-locked flow above cost.

## H4 — Post-lunch trend resumption (13:00–14:00): weak unconditional drift, NOT a resumption effect

- The strongest single window in the whole scan is the **13:30–14:00 LONG** drift:
  NQ **+2.41pt (t+2.10), 6/7 years positive** (only 2021 negative); ES **+0.41pt
  (t+1.46), 4/6 positive** (2021 also negative — a *matched* bad year across
  instruments, mildly reassuring).
- **But it is unconditional drift, not a "resumption."** Conditioning on a strong
  morning (top tercile |09:30→12:00|/ATR) does **not** improve it — it *worsens* it
  (NQ strong-morning +1.15 t0.39; 2026 −17.5). The hypothesis (conditional resumption)
  is rejected; the residual is just an unconditional long lean.
- **Net-after-cost:** NQ 13:30–14:00 long, round-trip market in/out:
  +1.9pt @0.25slip → +1.4pt @0.5slip → +0.4pt @1.0slip ($+33 / $+23 / $+3 per
  day·contract). **ES is net-NEGATIVE at any slip** (gross only 0.41pt).

This is the single least-dead item, but it is: NQ-only-tradable, best-of-11-windows
(t2.1 across 11 windows ≈ noise ceiling), just outside the 11:00–13:30 core, and
likely partly **market beta** (2021–2026 is a mostly-up sample). It does **not** clear
the survival bar. Filed as a weak watch-item, not a candidate.

## H5 — Midday compression (11:00–13:00 range) → afternoon breakout: NULL (folklore inverted)

- "Coiled spring" is **backwards.** |13:00–15:00 move|/ATR *increases* monotonically
  with midday range on both instruments (NQ 0.15/0.17/0.23; ES 0.19/0.26/0.32 by
  compressed/mid/wide tercile). Tight midday → *quieter* afternoon (vol persistence),
  not a bigger breakout.
- Directional signal (sign of 13:00 price vs midday-range midpoint, exit 15:00,
  compressed days only): NQ −2.52pt (t−0.75), ES −1.42pt (t−1.87) → wrong sign /
  noise. **DEAD.**

---

## Ranked shortlist

**None clear the GREENFIELD survival bar.** For completeness, ordered by residual
strength:

1. **13:30–14:00 NQ unconditional LONG** — +2.41pt, t2.10, 6/7 yr; net +1.4pt@0.5slip
   (~$23/day·contract). *Blockers:* not ES-tradable (ES gross 0.41pt, net<0);
   best-of-11 windows; likely beta-contaminated; adjacent-to not inside the midday
   window. *If ever revisited:* 1s sim on NQ only, LONG 13:30:01→14:00, and a
   beta-control (subtract same-day SPY/ES drift) to test if anything survives de-beta.

That is the entire shortlist. Everything else is dead.

## DEAD list (do not re-run)

- **European-close signed flow / fade / extend (11:25–11:45):** no fade, no robust
  extend; apparent extension was a 5-min window-overlap artifact; clean rolling
  momentum is 0 at 11:30 and 11:30 is unremarkable vs other times.
- **Lunch reversal (fade 10:30→12:00 move over 12:00–13:00):** flat, un-rescued by
  strength conditioning, un-replicated.
- **Midday unconditional signed drift 12:00–13:00:** dead flat both instruments.
- **11:00 pop / late-morning long lean (11:00–12:00):** real but ~1pt, sub-cost (matches
  brief's known null).
- **Post-lunch *conditional* resumption (strong-morning → 13:00–14:00 extend):**
  conditioning worsens vs unconditional; rejected.
- **Midday compression → afternoon breakout (H5):** inverted (compression → *smaller*
  afternoon range); directional signal noise/wrong-sign.
- **Noon reversal (T=12:00 rolling momentum fade, NQ −1.58 t−1.93):** NQ-only, ES null
  (−0.04) → best-of-many noise, not replicated.

## Methodology notes / caveats

- Census on 1m OPENs is admissible (descriptive, GREENFIELD rule #2); any number here
  that graduates to a strategy needs a 1s sim from the fill instant.
- Multiple testing: ~11 windows × {fade,extend} × strength terciles were scanned. The
  discriminators used against best-of-many were **ES replication** (same sign + same
  localization) and **per-year sign stability** — the two survivors of first-pass
  screening (H1 extension, H4 drift) failed the first and the second/robustness checks
  respectively.
- ES ATR proxy = 14-day rolling mean of RTH high−low (prior-day shifted); NQ uses
  B12 `atr14_prior`. ATR-normalized effects tracked the point effects (no divergence).
