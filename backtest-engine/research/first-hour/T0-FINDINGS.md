# T0: Baseline first-hour distributions (NQ, 9:30–11:00 ET)

## TL;DR

Foundation distributions for a single-trade-per-day NQ strategy in the first 90
minutes of RTH. **At a 60-min horizon, 74% of days produce ≥30 NQ pts of MFE
from the 9:30 open and 64% produce ≥50 pts**, so a 20–30 pt target is well
within the routine excursion envelope (it isn't even a stretch). The cost of
that opportunity is symmetric: **79% of days also see ≥30 pts of MAE** in the
same window, so a stop tighter than ~30 pts is fighting noise. The first-bar
bias has real edge after a strong gap-down (LONG continuation 82.5%, SHORT
reversal only 40.5%), and mid-cap-time-to-extreme is short — median time to MFE
in the 60-min window is **24 minutes**, MAE **19 minutes**.

## Dataset

- **Range:** 2025-01-13 → 2026-04-23 (the standard 15-month window).
- **Source:** `backtest-engine/data/ohlcv/nq/NQ_ohlcv_1m.csv` with
  `CSVLoader.filterPrimaryContract()` (raw contracts, calendar spreads dropped).
- **Trading dates seen:** 333.
- **Days kept:** 324 after filtering. Drops:
  - 21 NQ rollover dates from `data/ohlcv/nq/NQ_rollover_log.csv`
    (4 of those rolls fall in the analysis window: 2025-03-18, 2025-06-16,
    2025-09-15, 2025-12-15, 2026-03-16).
  - Days with <90 RTH minutes (early closes / data gaps).
- **Gap stratification** is computed as `(9:30 open − prior RTH close) / prior
  RTH close`, where prior RTH close = last bar at or before 16:00 ET on the
  prior trading day (rollover days skipped from the lookup too).
- **Gap bucket sample sizes:** gap_up_strong 88, gap_up_mild 69, flat 44,
  gap_down_mild 46, gap_down_strong 77.

Raw distributions JSON (incl. per-day rows for reuse by other tracks):
`backtest-engine/research/first-hour/output/T0-baseline.json` (364 KB).

## Findings

### Headline — % of days with MFE ≥ X pts (from 9:30 open, by horizon)

|              | 30m   | 60m   | 90m   | 120m  |
|--------------|------:|------:|------:|------:|
| MFE ≥ 20 pt  | 79.0% | 81.2% | 82.1% | 83.0% |
| MFE ≥ 30 pt  | 68.8% | 74.1% | 76.5% | 77.5% |
| MFE ≥ 50 pt  | 52.8% | 63.9% | 66.4% | 68.8% |
| MFE ≥ 75 pt  | 38.0% | 50.0% | 53.1% | 56.8% |
| MFE ≥ 100 pt | 26.2% | 36.7% | 42.3% | 46.0% |
| MFE ≥ 150 pt | 12.4% | 20.7% | 26.2% | 29.3% |

### Headline — % of days with MAE ≥ X pts (from 9:30 open, by horizon)

|              | 30m   | 60m   | 90m   | 120m  |
|--------------|------:|------:|------:|------:|
| MAE ≥ 20 pt  | 80.9% | 84.6% | 87.0% | 87.3% |
| MAE ≥ 30 pt  | 73.1% | 79.0% | 81.5% | 82.4% |
| MAE ≥ 50 pt  | 54.9% | 64.5% | 67.9% | 69.4% |
| MAE ≥ 75 pt  | 39.2% | 48.8% | 53.1% | 54.6% |
| MAE ≥ 100 pt | 29.6% | 37.7% | 42.9% | 46.0% |
| MAE ≥ 150 pt | 13.6% | 22.2% | 26.5% | 29.6% |

**Read:** A 30-pt target hit-rate is in the high 60s/70s within an hour. A
30-pt stop *also* gets hit ~73–79% of the time. Edge has to come from
*choosing the right side* before entry — the magnitudes are there for either
direction.

### MFE / MAE point distribution (medians and percentiles)

| Horizon | MFE med | MFE p75 | MFE p90 | MAE med | MAE p75 | MAE p90 |
|--------:|--------:|--------:|--------:|--------:|--------:|--------:|
| 30 min  |   55.3  |  103.3  |  155.4  |   57.4  |  107.2  |  172.3  |
| 60 min  |   74.9  |  134.1  |  194.5  |   70.6  |  138.0  |  223.5  |
| 90 min  |   80.6  |  151.8  |  207.6  |   80.8  |  156.6  |  255.8  |
| 120 min |   88.3  |  160.7  |  223.3  |   83.5  |  176.7  |  280.0  |

### Time-to-extreme inside the 9:30–11:00 window (minutes)

| Horizon | t→MFE med | t→MFE p75 | t→MAE med | t→MAE p75 |
|--------:|----------:|----------:|----------:|----------:|
| 30 min  |    13     |    24     |    12     |    22     |
| 60 min  |    24     |    47     |    19     |    42     |
| 90 min  |    30.5   |    70.5   |    25.5   |    66     |
| 120 min |    45     |    97     |    30     |    84.25  |

**Read:** MFE tends to print *later* than MAE — adverse excursion clusters in
the first 20 min while favorable excursion is more uniform across the 60-min
window. Implication for a 60-min horizon trade: the worst pain typically
arrives early; if you survive the first 20 min, you have the rest of the
window to run.

### First-60m range distribution (NQ pts)

Overall (n=324): min 30.75, p25 120.6, **median 176.0**, mean 193.6, p75 235.5,
p90 307.8, p99 456.9, max 1688.

First-90m range (n=324): p25 140.3, **median 194.4**, p75 268.4, p90 356.6,
p99 580.5.

By month (median first-60m range):

| Month   | n | median | p75 | p90 |
|---------|--:|-------:|----:|----:|
| Jan     | 35| 172.5  | 229.0 | 260.7 |
| **Feb** | 40| **253.8** | 329.9 | 407.4 |
| Mar     | 41| 217.8  | 252.5 | 320.3 |
| Apr     | 37| 205.5  | 296.0 | 330.2 |
| May     | 22| 159.3  | 186.0 | 255.9 |
| Jun     | 20| 128.1  | 153.4 | 225.1 |
| Jul     | 23| 117.0  | 142.1 | 160.6 |
| Aug     | 21| 140.8  | 186.3 | 295.8 |
| **Sep** | 21| **104.5** | 138.3 | 219.3 |
| Oct     | 23| 139.5  | 177.9 | 235.5 |
| Nov     | 20| 230.5  | 278.4 | 402.1 |
| Dec     | 21| 176.5  | 202.3 | 243.3 |

**Range varies 2.4× across months** — Feb/Mar/Apr/Nov are the wide-range
months, summer (Jun-Sep) is half as volatile. A points-based stop calibrated
on Feb data is wildly conservative in Sep.

By DOW (median first-60m range): Mon 174 / Tue 171 / Wed 164 / Thu 185 /
Fri 189 — within 15% of each other; DOW is a much weaker effect than month.

### First-60m range by gap bucket (NQ pts)

| Bucket             | n  | median | p75   | p90   |
|--------------------|---:|-------:|------:|------:|
| gap_up_strong      | 88 | 159.5  | 209.5 | 269.0 |
| gap_up_mild        | 69 | 158.5  | 206.5 | 320.4 |
| flat               | 44 | 147.4  | 190.2 | 244.2 |
| gap_down_mild      | 46 | 188.0  | 271.3 | 361.0 |
| **gap_down_strong**| 77 | **220.0** | 288.3 | 338.7 |

**Down gaps produce the widest first-hour ranges** — gap_down_strong's median
(220 pt) is 49% wider than flat (147 pt) and 38% wider than gap_up_strong.
This is consistent with sell-side panic / mechanical de-risking dynamics.

### MFE/MAE at 60-min horizon by gap bucket

| Bucket             | n  | MFE med | MFE p75 | MAE med | MAE p75 | P(MFE≥30) | P(MFE≥50) | P(MFE≥100) |
|--------------------|---:|--------:|--------:|--------:|--------:|----------:|----------:|-----------:|
| gap_up_strong      | 88 |  63.0   | 116.4   |  70.4   | 130.5   |  71.6%    |  60.2%    |  30.7%     |
| gap_up_mild        | 69 |  62.3   | 145.0   |  57.5   | 114.8   |  72.5%    |  58.0%    |  36.2%     |
| flat               | 44 |  54.0   |  91.7   |  84.9   | 126.6   |  65.9%    |  54.5%    |  22.7%     |
| gap_down_mild      | 46 |  79.6   | 122.3   |  68.4   | 139.5   |  76.1%    |  65.2%    |  34.8%     |
| **gap_down_strong**| 77 | **111.8** | 170.3 |  76.5   | 197.5   | **81.8%** | **77.9%** |  **53.3%** |

**gap_down_strong is the standout for opportunity AND pain** — MFE median
112 pt (almost 2× the flat-day median) but MAE p75 of 197.5 pt. A trade in
this regime needs either a wider stop or a strong direction filter.

### Reversal vs continuation (overall)

P(11:00 close > 9:30 open | first 15-min bar BULL) = **72.6%** (n=168)
P(11:00 close < 9:30 open | first 15-min bar BEAR) = **67.5%** (n=154)

**The first 15-min direction continues into 11:00 in ~70% of cases overall** —
this is the single most important cheap signal at 9:45 ET.

### Reversal vs continuation by gap bucket

| Bucket             | n_days | bull15 → bull@11:00 | bear15 → bear@11:00 |
|--------------------|-------:|--------------------:|--------------------:|
| gap_up_strong      |    88  | 71.1% (n=45)        | 71.4% (n=42)        |
| gap_up_mild        |    69  | 67.5% (n=40)        | 72.4% (n=29)        |
| flat               |    44  | 65.0% (n=20)        | 69.6% (n=23)        |
| gap_down_mild      |    46  | 73.9% (n=23)        | 65.2% (n=23)        |
| **gap_down_strong**|    77  | **82.5% (n=40)**    |  **59.5% (n=37)**   |

**Asymmetry on gap_down_strong:** if the first 15-min bar is BULLISH after a
strong gap down, continuation rate is **82.5%**. If the first 15-min bar is
BEARISH after a strong gap down, the bear-trade only continues 59.5% of the
time — still positive expectancy but materially weaker. Translation: dip-buying
the first bullish 15-min bar after a panic open is the cleanest signal in the
matrix.

## Proposed Strategy v0

Per spec, T0 does not propose a strategy — its only job is to publish the
distributions other tracks build on. Tracks T1–T11 will combine these
distributions with their own filters (sweep prediction, GEX walls, IV, etc.) to
generate signals and entries.

What T0 *does* recommend to those tracks:

- **Stops:** Anything tighter than ~30 pt has a >70% probability of being
  picked off inside 60 min purely on noise. A reasonable starting stop is
  the **MAE p50–p75 of the relevant gap bucket** — e.g. ~70 pt on gap_up_strong,
  ~85 pt on flat, ~140 pt on gap_down_mild. Calibrate per-bucket if the
  filter creates one.
- **Targets:** A 20–30 pt target is conservative for any decent entry; the
  hit-rate is 65–75% within an hour even unconditionally. The interesting
  target band is **50–100 pt** (50% / 26% unconditional hit at 60 min) where
  per-trade EV starts to justify the stop. For a 1:2 R:R structure
  (stop 50 / target 100), unconditional 1H hit is 64% hit-stop / 37% hit-tgt,
  so a strategy needs to lift target-hit rate by ~10–15 pp from baseline to
  break even.
- **Time stop:** Median time-to-MFE inside a 60-min window is 24 min;
  inside 90 min is 30 min. **A 60–90 min time-stop is well-calibrated** —
  shorter forfeits the right tail, longer just adds drift risk without
  meaningfully lifting MFE quantiles.
- **Vol-regime adjustment:** First-60m range varies 2× by month
  (Sep median 105 pt vs Feb 254 pt). Strategies should size stops/targets
  off a **rolling 20-day median first-hour range** rather than fixed points.

## Backtest-engine integration sketch

T0 produces no strategy code — only a JSON dataset and conventions for
downstream tracks:

- **Per-day rows** in `output/T0-baseline.json → perDay[]` carry: date,
  dow, month, open930, prevRthClose, gapPts, gapPct, gapBucket, range60,
  range90, first15Bull/Bear, closeAt11, closeAt11VsOpen, closedAbove930,
  and full horizon MFE/MAE/time-to-extreme. Other tracks should `require()`
  this file and join on date rather than reloading 1m candles.
- **Constants downstream tracks should adopt:**
  - 9:30 ET reference open = the candle whose `et.timeInMinutes === 570`.
  - Gap thresholds: ±0.4% (strong), ±0.1% (mild), <0.1% (flat).
  - "First-hour" = 9:30–10:30 ET (60 min); "first-90m" = 9:30–11:00 ET.
  - Skip days listed in `NQ_rollover_log.csv` for both the entry day AND
    the prior-close lookup.

## Caveats / Followups

1. **Sample sizes are small at the bucket × condition level** — gap_down_strong
   bull15 has only n=40. Headline effects (continuation in the 80s%) need
   OOS confirmation; tracks T1, T2, T8 should re-check on the held-out
   2026-02 → 2026-04 slice.
2. **MFE/MAE measurement is bar-based (1m highs/lows).** Real fills will
   slip — but for distribution shape this is the right ground truth.
3. **"First 15-min bar"** here means the cumulative move from 9:30 open to
   the close of the 9:44 minute bar (i.e. the first 15 actual 1-min bars).
   Not a single 15-min OHLC candle — the result is identical for direction
   purposes, but downstream tracks that build a true 15-min OHLC should be
   aware of the distinction.
4. **Sep-Oct 2025 is the lowest-vol pocket** in the dataset; if a strategy
   is tuned to recent quarters it may overfit those values. Always weight
   by the broader range distribution above.
5. **The 64.5% MAE-≥50pt vs 63.9% MFE-≥50pt symmetry** at 60 min is striking
   — without an entry filter, picking a side blindly is exactly a coin flip
   on which gets hit first. Every downstream strategy must justify how it
   asymmetrizes that coin.
