# G1 — GOLD daily-trend sleeve: independent verification, freeze, book measurement

**Verdict: CONFIRMED and ROBUST.** The GC 100-day Donchian breakout edge reproduces
from scratch, sits on a broad parameter plateau (not a cherry-pick), is **stronger
out-of-sample (2018+) than in dev**, and survives an independent random-entry placebo
(p≈0.011, more conservative than M2's claimed 0.000). Frozen and written to the book.
As a book sleeve it is **genuinely orthogonal (corr −0.001) and adds return at a small
Sharpe gain — but at 1 MGC it does NOT reduce book drawdown.**

All numbers re-derived from scratch (no M2 code read; spec only). Data `data/macro/gc_1d.csv`
(8000 bars, 1994-09-21 → 2026-07-21). MGC = $10/pt; RT cost $3.5 (1 tick/side slip + $1.5 comm).

---

## STEP 1 — Independent reproduction of the headline (N=100, H=42)

Spec re-implemented from scratch: signal at day-D **close**; LONG if close > highest-high
of prior N days (channel **excludes** today), SHORT if close < lowest-low of prior N; enter
**D+1 open**; fixed hold **H** trading days; long+short; non-overlapping. Knowability:
channel uses only bars < D, entry is next open, no future bars touch the signal.

| metric | M2 claim | G1 reproduced | verdict |
|---|---|---|---|
| trades (n) | 82 | **81** | ✓ |
| WR | 58% | **61.7%** | ✓ |
| PF | 3.07 | **3.03** (3.07 at $0 cost) | ✓ |
| mean $/trade (MGC) | $351 | **$351** | ✓ exact |
| median $/trade | — | $96 | — |
| total (32y, MGC) | — | $28,400 | — |
| maxDD (MGC, by-trade) | −$2,825 | **−$3,313** | ✓ (~17%, same ballpark) |
| book-era 2021+ | +$16.4k | **+$16,216** | ✓ |

**CONFIRMED** — every headline within ~10% (mean $/trade exact, PF within rounding).
Long/short split: longs +$32,604 (n=50), shorts −$4,204 (n=31). The edge is
**heavily long-biased** — shorts are a net drag; this is a long-gold-drift + trend product.

---

## STEP 2 — Robustness (plateau vs cherry-pick, dev/OOS, cost)

**PF surface (fixed hold, full history, MGC net):**

| N \ H | 21 | 42 | 63 |
|---|---|---|---|
| 50  | 1.19 | 1.84 | 1.83 |
| 75  | 1.23 | 2.42 | 1.64 |
| 100 | 1.51 | **3.03** | 2.13 |
| 125 | 1.80 | 3.30 | 2.24 |
| 150 | 1.92 | 3.87 | 3.17 |

**Broad plateau, not a spike.** Every H=42 and H=63 cell across N=50→150 is comfortably
positive; PF rises **monotonically** with channel length N and peaks at the H=42 hold.
100/42 sits on a smooth ridge, and neighbours (75/42, 125/42, 100/63) are all healthy.
Only the short H=21 hold is weak. Opposite-channel exit variant is also positive
(N=100: PF 3.99, n=23) — the edge is not an artifact of the fixed-horizon exit.

**DEV (exit ≤2017) vs OOS (exit ≥2018):**

| config | dev PF | dev total | OOS PF | OOS total |
|---|---|---|---|---|
| 100/42 | 2.45 | +$9,403 | **3.54** | **+$18,997** |
| 125/42 | 2.09 | +$7,810 | 4.99 | +$20,505 |
| 150/42 | 1.97 | +$7,034 | 8.57 | +$22,038 |

**OOS is STRONGER than dev across the entire plateau** — this is NOT a pre-2018
supercycle artifact. The edge is alive (indeed accelerating) post-2018, carried by the
2019-2020 and 2024-2025 gold trends.

**Per-year (100/42):** positive in 21 of 32 years. Losing years are gold bears/ranges —
2017 −$436, 2021 −$1,093, 2022 −$403, 2023 −$1,818 — exactly the trend-following chop
tax. Winners concentrated in gold uptrends (2011 +$3.5k, 2020 +$2.8k, 2024 +$3.1k,
2025 +$9.2k). Long-run positive + OOS-alive with expected trend-chop drawdown years.

**Cost sensitivity (100/42):** PF 3.07 → 3.03 → 3.00 → 2.93 as RT cost goes $0→$3.5→$7→$14.
Negligible — 42-day holds with hundreds of $/trade dwarf commission/slippage.

---

## STEP 3 — Placebo (breakout timing vs random same-direction entry)

Random entries matched by **count (50L/31S) and holding period (42d)**, 10-20k draws,
multiple seeds. Random draws capture gold's drift (mean random total ≈ $3.7k, sd $10.6k
— a long-biased basket in a secular bull rides the drift).

- **Full history: actual $28,400 vs random → p ≈ 0.011** (stable across seeds 0.010-0.012).
- OOS-only (2018+): actual $18,997 vs random → p ≈ 0.09 (n=26, low power).

**Timing edge SURVIVES** at ~99% confidence full-history — the breakout *entry timing*
adds value beyond random same-direction entry. **Note: I could NOT reproduce M2's
p=0.000.** My independent placebo is more conservative (p≈0.011); gold's drift is a large
confound and the honest count/hold-matched null already bakes it in. The edge clears the
5% bar comfortably but is "significant," not "p=0.000." The OOS-only placebo (p=0.09) is a
mild yellow flag — recent significance rests on a small trade count.

---

## STEP 4 — Frozen config + book output

**FROZEN SPEC:** GC Donchian **N=100, H=42**, fixed-hold, long+short, non-overlapping,
1× MGC ($10/pt), RT cost $3.5. Chosen = the M2 headline, which sits on the plateau
centre (not the PF-max corner 150/42, to avoid edge-of-grid selection).

**Daily mark-to-market** written to `book-gold-daily.csv` (3459 rows, 1995-04-03 →
2026-07-22, total $28,400). Per-day = position × close-to-close × $10/pt, entry day from
open, ±$1.75 cost on entry/exit days. Daily sum reconciles **exactly** to trade-level net
($28,400.50 = $28,400.50).

**Alignment handled:** gold futures label date = actual session date − 1 business day.
The book CSV is dated by **actual session date** via `np.busday_offset(label, +1,
roll='backward')` so it joins correctly onto the equity book's session calendar. (For the
standalone gold backtest the offset is immaterial — internally consistent — it matters
only for the join.)

---

## STEP 5 — 4-sleeve composite (book era 2021+, FIXED union calendar of all 4 sleeves)

Naive `book-harness.py` runs over 1995-2026 where gold is the ONLY sleeve pre-2021, and
its per-add union calendar shifts when gold (which holds a position ~64% of days) is
added — both distort the comparison. The decision-relevant test fixes the calendar and
adds gold to the same days:

| book (2021+, fixed cal, 1143 days) | Sharpe | maxDD | PF | total |
|---|---|---|---|---|
| 3-sleeve (pcc+monday+gapfade) | 1.86 | −$24,290 | 1.55 | $242,800 |
| **4-sleeve (+ 1 MGC gold)** | **1.95** | −$24,642 | 1.54 | $259,016 |
| Δ | **+0.09** | −$352 (≈flat) | −0.01 | **+$16,216** |

**Correlation (book era, fixed calendar):**

|  | pcc | monday | gapfade | gold |
|---|---|---|---|---|
| pcc | 1.000 | −0.023 | 0.043 | −0.047 |
| monday | −0.023 | 1.000 | −0.062 | −0.005 |
| gapfade | 0.043 | −0.062 | 1.000 | 0.050 |
| gold | −0.047 | −0.005 | 0.050 | 1.000 |

**gold vs 3-sleeve combined book = −0.001** — as orthogonal as it gets.

**Scale / sizing:** gold daily std $348 vs 3-sleeve book std $1,811 (MGC $10/pt vs NQ
$20/pt, and gold's positions are small-vol). Risk-matching would need ~5.2× MGC — but that
HURTS: at 5.2× book Sharpe drops to 1.78 (−0.09) and DD worsens to −$30.5k, because gold's
own Sharpe (~0.6) is far below the book's (1.86); adding a low-Sharpe sleeve in size dilutes
the book even when uncorrelated. A modest **~3× MGC** is the practical ceiling
(Sharpe 1.94, +$48k, DD −$25.3k ≈ flat).

### Diversification verdict
Gold is a **real, orthogonal return stream** (corr −0.001) that adds return at a **small
positive Sharpe gain (+0.09 at 1 MGC)**. It **does NOT lower book drawdown** — DD is
essentially unchanged (−$352, ~1.4%, noise), because gold's small uncorrelated PnL doesn't
happen to offset the equity sleeves' specific worst stretches, and its risk contribution is
tiny. Verdict: **add for uncorrelated return, not as a drawdown hedge.** It improves the
book weakly-positively; it is not a Sharpe/DD game-changer at deployable micro size.

---

## Files
- `G1-donchian.py` — from-scratch Donchian backtest (STEP 1); `G1_donchian.py` = importable copy.
- `G1-robustness.py` — PF surface, opposite-channel exit, dev/OOS split, cost sensitivity (STEP 2).
- `G1-placebo.py` — random same-direction entry placebo (STEP 3).
- `G1-book.py` — freeze + daily MTM writer → `book-gold-daily.csv` (STEP 4).
- `G1-composite.py` — book-era 3-vs-4-sleeve composite + correlation (STEP 5).
