# V1 — Independent verification of B4 (pre-close continuation + monthly-expiry short)

**Date:** 2026-07-17. **Role:** adversarial re-implementation from raw data only.
**Verified doc:** `greenfield/explore/B4-preclose-expiry.md` (read only for spec + claims).
**Independence:** no file under `greenfield/explore/` other than that .md was read,
imported, or executed — no B4*.py, B4_common.py, B12*.py, B3*.py, no cached CSVs.
Everything below was built from `data/ohlcv/nq/NQ_ohlcv_1s.csv` (8.3GB raw 1s) and
`data/ohlcv/nq/NQ_ohlcv_1m.csv` (raw 1m), with my own primary-contract selection,
session handling, ATR, and expiry calendar.

**Scripts (this directory):**
- `V1-01-extract-1s.py` — one streaming pass over the raw 1s file; per-ET-day slim
  windows (09:30, 10:30, 15:00, 15:30, 15:45) + per-hour per-symbol RTH volume →
  `v1_slim_1s.pkl`. Produced **1,395 ET days — exactly the doc's claimed cache universe**.
- `V1-02-daily-atr.py` — RTH daily bars + ATR14 variants from the raw 1m file.
- `V1-05-atr-fullsession.py` — full-session (Globex 18:00→17:00 ET) daily bars +
  ATR14 variants (`v1_daily_fs.csv`).
- `V1-03-b4a.py` — B4a sim (frozen + unfiltered, 1×/2× slip, all ATR variants).
- `V1-04-b4b.py` — B4b sim + expiry calendar (Easter computus for Good-Friday shift)
  + quarterly / weekly-Friday controls.
- Raw outputs: `v1_b4a_results.txt`, `v1_b4a_fs_results.txt`, `v1_b4b_results.txt`.

## 1. Restated spec (as I implemented it)

Common sim contract: market order placed at wall time T fills at the **open of the
first 1s bar stamped ≥ T** with 0.25 pt adverse slippage per side (0.5 pt at the 2×
sensitivity line); time exits at the flat bar's open, also 0.25 adverse; $5
round-trip commission; NQ $20/pt, 1 contract. A decision "at" T may use only 1s bars
**closed** by T (a bar stamped 14:59:59 closes at 15:00:00). Calendar-spread rows
(symbol contains `-`) dropped; primary contract chosen per ET clock-hour by highest
RTH volume; days where the per-hour primary changes across ET hours 9–15 are
excluded as intraday-roll days.

**B4a (pre-close continuation):** `day_move` = close of last 1s bar before 15:00:00
ET minus open of first 1s bar ≥ 09:30:00 ET. If `|day_move| > 0.30 × ATR14`
(knowable at 09:30, i.e. computed from daily bars through the prior day), enter
**aligned** (long if up-day) market placed 15:00:01; no stop; exit market 15:30:00.
Eligibility: full RTH session (bars ≥ 15:45 present), no intraday roll, ATR14 +
trailing-250d ATR tercile knowable (≥ 60 strictly-prior ATR obs; the frozen config
uses no vol gate, but the eligibility universe was defined with this requirement),
signal bar within 120 s of 15:00, `day_move ≠ 0`. Dev = 2021–2024; validation =
2025–2026, run on the frozen config.

**B4b (monthly-expiry morning short):** on **monthly-class** (non-quarterly, i.e.
not Mar/Jun/Sep/Dec) 3rd-Friday option expirations — holiday-shifted to Thursday
when the 3rd Friday is Good Friday (2022-04-14, 2025-04-17) — SHORT market placed
09:30:01, exit market 10:30:00, no stop, no filter. Controls: same short on
quarterly 3rd Fridays and on all other Fridays.

## 2. Implementation choices / spec ambiguities I had to resolve

1. **ATR14 daily-bar session convention — the one material ambiguity.** The .md
   delegates ATR14 to `B12-days.csv` (banned) and never defines the session. I built
   it both ways from the raw 1m file: (a) RTH-only (09:30–16:00) daily bars, and
   (b) full-session Globex daily bars (18:00 ET prev day → 17:00 ET). SMA of the
   last 14 true ranges, TR = max(h−l, |h−pc|, |l−pc|), value on day D uses sessions
   ≤ D−1. **Full-session TR reproduces the claims almost exactly; RTH-only makes
   the |move| filter ~6 %/11 % less selective** (dev n 544, val n 213, val PF 1.353)
   because RTH ATR is smaller, especially in gap-heavy 2022/2025. I treat
   full-session as the intended reading. Robustness note: under EVERY tested ATR
   convention (RTH/full-session, SMA/Wilder, naive/roll-safe/h−l TR) the frozen
   config stays alive: dev PF 1.407–1.482, val PF 1.317–1.510, both validation
   years positive.
2. **Tercile-knowable warmup:** I required ≥ 60 strictly-prior ATR14 obs → 56–57
   warmup skips vs their 54 (a 2–3-day boundary difference in April 2021 only).
3. **Full-session detection:** "full RTH session" = primary contract has 1s bars at
   or after 15:45 ET (early closes halt 13:00 and drop out naturally). Reproduces
   their skip counts exactly (dev not_full = 34, val not_full = 13).
4. **Roll days:** my per-hour-primary test flags 4 dev roll days (theirs: 4) and
   2 validation days (theirs: 0) — the source of the 2025 unfiltered 245-vs-247
   day-count difference.
5. **WR convention:** win = net-$ > 0. Matches claimed WRs to ≤ 0.5 pp everywhere,
   so this is the same convention.
6. **Sharpe:** I used per-trade mean/std × √252. B4b Sharpes match (8.49/4.43 exact);
   the B4a dev headline Sharpe does not (mine 2.19 vs claimed 1.56), so their B4a
   Sharpe uses some other convention. Sharpe is not in the acceptance criteria; all
   accepted metrics (n/WR/PF/PnL/DD/per-year) are convention-clean.

## 3. Side-by-side results

### B4a frozen (|move| > 0.30×ATR14, no gate, no stop, 15:00:01→15:30), slip 1×

| window | source | n | WR | PF | PnL | maxDD | PF@2× |
|---|---|---|---|---|---|---|---|
| dev 2021–2024 | **claimed** | 514 | 60.5 | 1.461 | +$50,815 | −$11,270 | 1.407 |
| dev 2021–2024 | **mine (fs-ATR)** | 515 | 60.6 | 1.482 | +$53,220 | −$11,510 | 1.428 |
| val 2025–2026 | **claimed** | 195 | 52.3 | 1.572 | +$33,910 | −$7,610 | 1.531 |
| val 2025–2026 | **mine (fs-ATR)** | 191 | 51.8 | 1.510 | +$30,305 | −$9,595 | 1.470 |

Per-year PnL/count (claimed → mine): 2021 +8,260/107 → +8,665/106 · 2022
+22,230/137 → +24,340/139 · 2023 +19,710/134 → +20,125/136 · 2024 **+615/136 →
+90/134** (both ~flat positive) · 2025 +18,125/133 → +13,940/128 · 2026 +15,785/62
→ +16,365/63. **Same sign every year.** Full-sample cross-check: claimed 709 trades
+$84,725; mine 706 trades +$83,525.

Acceptance: n dev +0.2 %, val −2.1 % (±5 % ✓); WR Δ ≤ 0.5 pp (±3 pp ✓); PF dev
+1.4 %, val −3.9 % (±10 % ✓); per-year signs identical ✓.

### B4a unfiltered baseline, slip 1×

| window | source | n | WR | PF | PnL | per-year |
|---|---|---|---|---|---|---|
| dev | claimed | 929 | 55.9 | 1.237 | +$49,820 | +11,265/186 · +28,040/248 · +18,855/247 · −8,340/248 |
| dev | mine | 926 | 55.9 | **1.237** | +$49,535 | +10,335/182 · +28,685/249 · **+18,855/247 (exact)** · **−8,340/248 (exact)** |
| val | claimed | 360 | 51.9 | 1.269 | +$30,525 | +22,810/247 · +7,715/113 |
| val | mine | 358 | 52.0 | 1.273 | +$30,950 | +23,235/245 · **+7,715/113 (exact)** |

2023, 2024 and 2026 unfiltered PnL match **to the dollar** — the original's fill
mechanics and mine, independently implemented from the raw 1s file, are identical.
Residual diffs are universe-boundary only (3 extra warmup days in early 2021, one
2022 roll/eligibility day, 2 roll-flagged 2025 days).

### B4b monthly-expiry short (09:30:01→10:30, no stop), slip 1×

| window | source | n | WR | PF | PnL | per-year | PF@2× |
|---|---|---|---|---|---|---|---|
| dev 2021–2024 | claimed | 31 | 64.5 | 3.726 | +$25,095 | +3,790/7 · +11,230/8 · +3,180/8 · +6,895/8 | 3.661 |
| dev 2021–2024 | mine | **31** | **64.5** | **3.726** | **+$25,095** | **identical to the dollar** | **3.661** |
| val 2025–2026 | claimed | 12 | 66.7 | 1.956 | +$9,635 | 2025 +12,200/8 · 2026 **−2,565/4** | 1.941 |
| val 2025–2026 | mine | **12** | **66.7** | **1.956** | **+$9,635** | **identical, incl. 2026 negative** | **1.941** |

Gross pts (claimed → mine): dev mean +41.2/med 43.25 → 41.23/43.25; val mean
40.9/med 75.62 → 40.90/75.62. My independently computed expiry calendar reproduced
their traded dates exactly, including both Good-Friday Thursday shifts (2022-04-14,
2025-04-17) and dev n=31 (2021-01-15 pre-cache). Controls: quarterly dev n=16
PF 0.896 gross −2.83 pts (claimed 0.90 / −2.8 ✓); weekly-Friday dev n=152 PF 0.676
gross −13.5 pts (claimed 151 / 0.66 / −14.4 — one-day set difference, same
conclusion: weekly Fridays drift UP, effect is monthly-specific).

## 4. Divergence analysis

- **Every material claim reproduced within tolerance.** The only reproduction
  divergence encountered en route was my initial RTH-only ATR guess (val PF 1.353,
  −13.9 % — outside the ±10 % band). It is a spec-underspecification artifact, not
  a defect in the original: switching to full-session daily TR brings every cell
  inside tolerance simultaneously (counts, WR, PF, PnL, per-year, 2×-slip, both
  windows), which would be essentially impossible if the claimed numbers were
  fabricated or bug-driven.
- **Fragile edge worth flagging:** dev-2024 sign for the frozen config is
  convention-marginal — claimed +$615, mine +$90 (full-session ATR), but −$740 to
  −$1,575 under Wilder/RTH ATR variants. The doc's own "2024 ~flat / dormant year"
  characterization is the right reading; the literal "positive all 4 dev years" bar
  component holds only under the specific ATR convention. 2025 PnL is the largest
  residual gap (−$4.2k on ~7 symmetric-difference marginal-threshold days).

## 5. Lookahead audit of the spec

- **09:30 reference price:** open of first 1s bar ≥ 09:30:00 = first trade price at
  the open — observable in real time, long past by decision time. Clean.
- **15:00 decision price:** close of last bar stamped < 15:00:00; that bar closes at
  15:00:00; order placed 15:00:01 fills at the open of the first bar ≥ 15:00:01,
  with adverse slippage. **No entry uses any information after 15:00:01.** Clean.
- **ATR14:** built from sessions ending ≤ 17:00 ET the prior day; tercile window
  strictly prior. Clean.
- **B4b calendar:** deterministic date arithmetic (3rd Friday, Good-Friday shift),
  knowable years in advance. Clean.
- **Minor, non-material eligibility caveats** (day-selection, not outcome-selection):
  (1) "full RTH session" is confirmed with post-entry data, but early closes are
  exchange-scheduled in advance and such days have no 15:00 bar to trade at all —
  no trade can be created or rescued by this check; (2) per-hour primary-contract
  volume for hour 15 includes 15:00–16:00 volume, so the roll-day exclusion and the
  entry symbol technically use same-hour future volume. In live trading the front
  month is known ex-ante and roll days are calendar-predictable; affected days ≈ 4–6
  in 5.5 years, and my handling vs theirs differed on 2 days with negligible impact.
  Neither caveat can manufacture edge.

## 6. Verdicts

- **B4a pre-close continuation: CONFIRMED.** All acceptance criteria met (n ±2.1 %
  worst case, WR ≤ 0.5 pp, PF ≤ 3.9 %, per-year signs identical), unfiltered
  baseline matches to the dollar in three year-cells, and the edge is robust to
  every ATR-convention reading of the one under-specified input. Caveats: 2024
  dev-year sign is convention-marginal (~flat either way, as the doc itself says);
  spec should pin down the ATR session convention (full-session Globex daily bars
  is what reproduces).
- **B4b monthly-expiry short: CONFIRMED** — exact to the dollar in every claimed
  cell (dev, validation, 2×-slip, gross points, controls), including the 2026
  negative. The doc's own capping of the claim at "suggestive, n-bar unreachable"
  is the correct interpretation and is endorsed.
