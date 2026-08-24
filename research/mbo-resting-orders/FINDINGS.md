# MBO Resting-Order Program — findings (2026-08-21/22)

# ❌ STATUS: DEAD — killed out-of-sample 2026-08-22. Do not revive.

Two independent OOS months bought ($88.90 total) and evaluated against the pre-registered
frozen criteria. **Out-of-sample the strategy LOST $25,472 over 50 sessions.**

| | Dec 2025-Jan 2026 (in-sample) | **April 2026** | Jul-Aug 2026 |
|---|---|---|---|
| trades | 922 | 1,042 | 1,336 |
| PF | 1.18 | **0.88** | 1.03 |
| net | +$43,357 | **-$36,533** | +$11,061 |
| maxDD | $6,377 | $41,308 | $32,935 |
| directional edge D | +$50,164 | **-$21,883** | +$29,676 |
| flip test | passes | **FAILS (+$5,652)** | passes |
| locked filter A | +0.21 PF | **-0.07** | +0.07 |

**The killer is the flip-test inversion in April.** Flipping direction MADE money, so the
signal carried no directional information that month — it was actively wrong. And April sits
CHRONOLOGICALLY BETWEEN the other two, which destroys any decay story: a real edge goes
strong -> weak -> dead, not strong -> INVERTED -> weakly positive. That is what sampling
noise three times looks like when the first draw is favourable.

★ **The Dec-Jan result — PF 1.19, +$43,357, flip -$56,971, +4.12sd vs placebo, balanced
long/short, band-stable, momentum-independent — was a FAVOURABLE DRAW.** It passed every
control available without new data. None of those controls could detect the problem, because
they all re-used the same month. **Only out-of-sample data could kill this, and it did.**

---

## ARCHIVED BELOW: the original (pre-OOS) case


---

## 1. The signal

**Detection:** a resting order of **size >= 10** added **3-5 points behind the last trade**
(i.e. 12-20 ticks deep in the book), front month only, in MBO event time.
**Trade:** market order in the resting order's direction (bid -> long, ask -> short),
**symmetric +/-30 point bracket**, **one position at a time**.

That last constraint matters: it collapses 24,306 raw detections into ~1,320 real trades
across 27 days. All headline numbers are post-collapse.

### Results (1 contract full NQ, $20/pt, $4 round-turn commission)

| lat | slip | n | WR | PF | net (27d) | maxDD |
|-----|------|---|-----|----|-----------|-------|
| 0.0s | 0.25pt | 1340 | — | 1.15 | +$48,540 | — |
| 0.25s | 0.25pt | 915 | 54.5% | **1.18** | **+$41,100** | $6,377 |
| 1.0s | 0.25pt | 922 | 54.9% | **1.19** | **+$43,357** | $7,911 |

### The $43,357 is ACTUAL over the sample, not a projection

It is the simulated net over **27 session-days (2025-12-29 .. 2026-01-28)**, of which only
**22 are full sessions** — Jan 1 is a holiday and Jan 4/11/18/25 are Sundays, contributing
+$50 combined.

**Annualization is HIGHLY skew-sensitive — quote the median, not the mean:**

| method | $/yr @ 1 contract |
|---|---|
| naive (mean/day x 252) | $404,665 |
| full sessions only | $496,062 |
| **median day x 252** | **$64,260**  <- most robust |
| excluding top-3 days | $153,006 |

**mean day = $1,606 but MEDIAN day = $255.** Jan 14 (+$10,881), Jan 8 (+$9,901) and
Jan 23 (+$8,003) carry 66% of all profit; the typical day makes a few hundred dollars.
Honest range: **$64k-$400k/yr**. Against $21k/yr for live MBO that is 33% of gross at the
low end and 5% at the high end — so the OOS month decides whether this is worth funding,
not just whether it is real.

### Barrier width is the whole game — and it runs OPPOSITE to the probability table

| band (distance behind touch) | PF (lat=1s) | net 27d |
|---|---|---|
| 0-2pt | 0.98 | -$8,626 |
| 2-3pt | 1.03 | +$7,218 |
| **3-5pt** | **1.19** | **+$43,357** |

And by bracket size (all detections):

| bracket | PF | net |
|---|---|---|
| +/-5 | 0.80 | -$137,300 |
| +/-10 | 0.88 | -$78,150 |
| +/-15 | 0.97 | -$14,298 |
| +/-20 | 0.96 | -$18,612 |
| +/-30 | 1.05 | +$15,272 |

**+/-5 has the LARGEST probability tilt (+11.36pp bid-vs-ask) and the WORST trading
result.** That tilt is the resting order physically blocking the next few ticks — real,
but not a forecast. You pay spread + slippage to harvest a $100 bracket. Tight brackets
die by **20ms** of latency; +/-30 survives a full second because at 30 points away the
order's own obstruction is irrelevant and only genuine information remains.

---

## 2. Controls PASSED

- **Flip test:** true +$43,357 vs flipped **-$56,971**. Direction carries the information.
- **Random-direction placebo** at matched entry instants: **+4.12 sd** above.
- **Not drift:** balanced 453 long / 469 short, BOTH profitable (+$23,683 / +$19,674).
  (The sample had net down-drift — unconditional P(up) at +/-20 was 47.79%, CI excludes 50 —
  so this control was mandatory.)
- **Not outliers:** top-3 trades = $1,788 of $43,357; median trade +$26.
- **Not knife-edge:** every sub-band positive (2.5-5pt PF 1.11, 3.5-5pt 1.09, 4-5pt 1.10).
- **Not momentum:** at the SAME instants, momentum direction gives PF 1.01 vs book 1.18.
- **Latency-robust:** positive in 17 of 18 lat/slip combos, degrading smoothly.

## 3. Caveats (why this is NOT deployable as-is)

1. **27 days, ONE calendar month (2025-12-29 .. 2026-01-28). ZERO out-of-sample.**
2. **Post-hoc band selection** — the 3-5pt band was chosen by inspecting 4 bands.
3. **3 of 27 days carry 66% of profit** ($28,785 of $43,357); only 17/27 days positive.
4. PF 1.03-1.19 at ~34-49 trades/day is thin — fill-quality degradation kills it.
5. Slippage figures are assumptions, not measurements.

---

## 4. What was RULED OUT (do not re-run)

### 4a. Cheaper data tiers — no $199 version exists
Standard ($199/mo) live = "all schemas EXCEPT MBP-10 and MBO" (primary source: pricing
tooltips). MBP-10 does NOT help — Standard excludes it too, so L2 costs the same $1,750.
The signal sits 12-20 ticks deep, beyond MBP-10's ten levels (~2.5pt in a dense NQ book).

**MBP-1 substitution (we own 338 days, 2025-01..2026-01):** built the exact L1 view
including `bid_ct_00`/`ask_ct_00` (order COUNT -> avg order size = sz/ct).
**12 of 12 rules at/below breakeven** over 23 overlap days:
avg-size>=3/5/10 PF 0.96/0.92/**0.83**; raw-size>=10/20/40 PF 0.95/0.86/0.96;
size-imb>=.3/.5/.7 PF 0.92/0.90/1.01; count-imb>=.3/.5/.7 PF 0.91/0.97/0.99.
"Large avg order size AT THE TOUCH" is the WORST rule — near-touch large orders are
quoting churn, not intent.

### 4b. Free-data reverse engineering — LT / LS / GEX / T all fail
Agreement with detection DIRECTION (50% = no info):
LT level-position 46.6% | LT sentiment (=LS-15m) 48.8% (z-1.39) | GEX total_gex 49.5% |
GEX regime 49.5% | GEX gamma_imbalance 49.7% | GEX above-flip 51.5% |
**GEX nearer-support 53.2% (z+3.69)** | **price momentum 59.3%**

Traded standalone: LT sentiment PF 1.03; LT+top25% lvlmove 0.92; +top10% 1.05;
GEX support/resistance **PF 0.89** (-$15,645); pure momentum 0.90-1.01.

> **KEY CALIBRATION: 53.2% agreement (z=+3.69, statistically real) trades at PF 0.89.
> 59.3% agreement trades at PF 1.01.** A proxy needs far more than significance — the
> money is in the ~45% where it DISAGREES. Do not chase significant-but-weak agreement.

### 4c. Forensic snapshot — no common thread
3,351 detections vs 6,802 same-day random controls, 25 features (price, activity, LT, GEX):
**max standardized difference = 0.073** (gflip_dist). Cohen 0.2 = "small" — nothing reaches it.
Run-up trajectories (ret1/5/15/30) all 0.03-0.05. Detection-rate-by-decile all flat vs
33% baseline. Joint LT-sentiment x GEX-gamma cells: 31.0/31.8/33.4/34.6.

**Events/crossovers/spikes (19 tested, NONE |z|>3):** LT sentiment flip 15/30/60m
-0.4/+1.5/+1.3pp; LT level spike (top10%) -0.0/-1.7/-0.5pp; T5xTH crossover (up/dn/any,
15/30/60m) all |z|<1.3; price crossed an LT level 5/15/30m -1.2/-1.6/-1.0pp (NEGATIVE);
price crossed gamma_flip 15m +7.4pp z=+2.07 (n=188 — chance rate at 19 tests).

**Only recurring hint: the GAMMA FLIP.** Surfaced twice independently (decile spread
10.2pp; cross z=2.07), with a plausible mechanism (dealer hedging near the flip). But it
is **TIMING-ONLY**, and timing without direction is worthless — random direction at true
detection instants LOSES (-$8,293 mean). If the OOS month is ever bought, test gamma-flip
proximity as a FILTER on the MBO strategy, not as a replacement.

**Interpretation:** detection moments are statistically indistinguishable from random
moments in the same session across everything we own. Cuts both ways — nothing can proxy
it, but the signal is genuinely ORTHOGONAL to our whole toolkit (supports realness).

### 4d. Earlier nulls in the same program
- size-15 "post-and-pull" fingerprint: real behaviour but **symmetric** (50.2/49.8 bid/ask,
  identical 2.8% fill rate) -> two-sided quoter, no directional intent.
- day-specific one-sided size classes: only 8/271 day-size cells |bid%-50|>=15; direction
  matched the day's move 4/8.
- passive fill imbalance (F events) vs forward return, 7 size buckets x H=5/10/30/60:
  **28 cells, ZERO beat matched null**, max |t| 1.75.
- round-50 level conditioning: 1 of 22 flagged = chance rate; survived prior-return control
  but died in a 108-cell robustness grid (7 |t|>2 vs 5.4 expected; signs flip on adjacent params).

---

## 5. Methodology bugs found here (all cost real time — check these first)

1. **Front-month contamination.** `fp.py` computed the front month and then never filtered
   by it. NQM6 trades a few hundred points above NQH6, so every forward scan tripped the
   +20 barrier instantly -> 26 of 27 days showed ~78% up-first. **Symptom: an impossibly
   one-sided first-passage result.**
2. **Time-base mismatch (86400s).** MBP-1 files start ~22:55 UTC the PRIOR day; MBO files
   start at midnight. A seconds-of-day + wrap heuristic adds a day to one and not the other.
   ZERO detections landed in range and the first L1 run reported 12 trades of pure noise.
   **Fix: absolute dates — `date.toordinal()*86400 + tod`. Never a wrap heuristic.**
3. **Overlap trap.** 24,306 raw detections are heavily overlapping; a single rally stamps
   "up" on hundreds of rows. Day-clustered bootstrap + one-position-at-a-time are mandatory.
4. **Geometry.** A resting bid sits BELOW the market, so anchoring barriers to the order's
   own price bakes in a tilt. Anchor to last trade.
5. **Volatility masquerading as signal.** LT level movement looked like it marked detections
   (+5.6pp top decile) but corr(ntrades,ndet)=+0.773 vs corr(lvlmove,ndet)=+0.199, and the
   **partial correlation given range+activity collapses to +0.085.**
6. **BBO reconstruction from MBO is O(book) per event** — 19M events/day made it unusable.
   Use the owned `data/orderflow/nq/mbp-1/` files instead.

---

## 6. How to resume

Derived data is checked in under `derived/` (~66MB) so nothing needs re-parsing from the
58GB of raw MBO.

```
derived/ext/YYYYMMDD.npz   px[], ts[] (all front-month trade prints, absolute secs)
                           det[] = (ts, last_trade, order_px, dir, size, px_index)
derived/l1/YYYYMMDD.npz    l1[] = (ts, bid_px, bid_sz, bid_ct, ask_px, ask_sz, ask_ct, last)
derived/absorb/            per-minute passive-fill flow by size bucket
derived/fp2/               first-passage times to +/-5/10/15/20/30
derived/S.pkl, S2.pkl      forensic snapshots (detections + controls + LT/GEX/events)
```

Re-run the headline result:  `python3 scripts/sim.py`
Re-extract from raw MBO:     `python3 scripts/ext.py <glbx-mdp3-YYYYMMDD.mbo.csv>`
L1 substitution test:        `python3 scripts/l1search.py`
Free-data sweeps:            `scripts/lt_test.py`, `lt_test2.py`, `gex_test.py`, `snap.py`, `events.py`

### DATA SOURCING — vendor research 2026-08-22

**LIVE MBO (only needed if OOS passes):**

| source | $/mo | notes |
|---|---|---|
| **Rithmic R\|API+** | **$100 API + $25 trader ID + ~$40 CME non-pro ≈ $165** | true MBO, full depth, **accurate queue position**, no per-platform usage fee, MONTH-TO-MONTH |
| Bookmap Global+ | $99 + Rithmic data + CME | **its CME MBO is supplied by Rithmic**; visualization-first, has a JS API |
| dxFeed / CQG | quote needed | both listed as MBO-capable |
| Databento Plus | **$1,750 + license fees + 12-MONTH CONTRACT** | ~10x more than Rithmic |

★ **Rithmic is ~10x cheaper than Databento Plus and has no annual lock-in.** Bookmap
sourcing its MBO from Rithmic confirms Rithmic is THE retail MBO channel. Unverified:
whether R|API+ exposes MBO programmatically (vs only to certified platforms) and whether
it carries order IDs — **ask Rithmic directly before assuming**. Queue position implies
order-level data, which is a good sign.

🚨 **Professional-classification trap applies here too**: a funded prop account flips CME
from non-pro (~$40/mo) to professional (~$140/exchange/mo). See [[pickmytrade-integration]].

**MEASURED VOLUME (basis for all cost estimates, 2026-08-22):**
446M records across our 27 days (16.5M/day). Front month = **61%** of records (rest NQM6 +
calendar spreads). Databento meters **bytes delivered in DBN** = fixed **56 B/MBO record**,
NOT the 61.6GB of CSV on disk. So:
- front-month-only billable volume = **~14.6 GB per ~21-day month**
- requesting a single raw_symbol instead of `NQ.FUT` parent saves **39%** (strategy only
  needs front month; FROZEN-OOS-EVAL filters to it anyway)

**✅ CONFIRMED 2026-08-22 from the Databento portal: MBO = $1.80/GB.** Real quote — NQ
(ALL contracts, parent symbology) 2026-05-22..2026-08-21 = 105.1 GB = **$176.12**, 82 daily
files. MBO history available from **2017-05-21** (9 years — plenty for 5-year sampling).
Cut it by requesting only the 2 front months as raw symbols (~61% of volume, ~$110), and
by sampling OLDER months (lower message volume). Estimate table below was correct in range:

| $/GB | 1 month | 3 months |
|---|---|---|
| $0.50 (published floor) | $7.28 | **$21.85** |
| $1.00 | $14.56 | $43.69 |
| $2.00 (our known cbbo-1m rate) | $29.13 | $87.39 |
| $5.00 | $72.82 | $218.46 |
| $11.00 (ceiling — OPRA statistics rate) | $160.21 | **$480.62** |

**=> 3 months is almost certainly <$500 and plausibly <$50.** The 22x spread is ONE unknown
(Databento's MBO $/GB) resolvable FREE in ~2 min via `scripts/quote-oos-cost.py`.
NB older months are CHEAPER — NQ message volume has grown a lot since 2021, so these
current-density figures are conservative for 5-year sampling.

**★ PURCHASE PLAN (scripts/plan-purchase.py, 2026-08-22).** Two separate wastes to avoid:
(1) the `NQ` PARENT pulls all contracts + calendar spreads (~39% waste); (2) requesting
BOTH front symbols across the WHOLE window is equally wasteful — each is the DEFERRED month
for half the period. Fix = **date-sliced per-symbol requests** off `NQ_rollover_log.csv`:

    NQM6  2026-05-22 .. 2026-06-14   (16 sessions)
    NQU6  2026-06-14 .. 2026-08-21   (49 sessions)

Model validates $149.96 vs portal ACTUAL $176.12 (~15% low -> scale estimates x1.17).
CSV vs DBN encoding: **NO cost difference** (Drew verified) — billing is normalized, not
delivered-bytes.

| plan | est. cost | vs the $176 parent quote |
|---|---|---|
| A. recent 3mo, front-month-only | **~$107** | saves ~$69 |
| B. **3 months SCATTERED 2021/2023/2025** | **~$63** | saves ~$113 |
| C. single cheapest month (2022) | **~$16** | — |

★ **Option B is cheaper AND the better test** — older months carry ~half the message
density (2021 = 49% of 2026 activity index) and cover genuinely different regimes.

**HISTORICAL MBO (what the OOS test actually needs):**

1. **Databento usage-based** — from **$0.50/GB**, metered by bytes delivered, **NO
   subscription required**, and **`get_cost` quotes are FREE**. Run `scripts/quote-oos-cost.py`.
   This is almost certainly the cheapest and fastest path — likely tens of dollars for one
   front-month contract-month, though the exact number needs the quote.
2. **CME DataMine** — direct from the exchange, PCAP full depth. Pricing not public;
   contact CMEDataSales@CMEGroup.com. Worth an email but expect institutional pricing.
3. **Self-record via Rithmic** — ~$165 for one month. Costs wall-clock time (a month) but
   simultaneously proves the live path works. Best if the Databento quote comes back high.

### ★ RECOMMENDED PURCHASE (2026-08-22) — pick ROLL-FREE months (1 symbol, no slicing)

| purpose | symbol | window | est. |
|---|---|---|---|
| cheap probe, different regime | **NQZ2** | 2022-10-01 .. 2022-11-01 | **~$15** |
| decay test, +6mo from in-sample | **NQU6** | 2026-07-01 .. 2026-08-01 | **~$38** |
| | | **both** | **~$53** |

Other roll-free options: Apr 2022 NQM2 ~$15 · Oct 2021 NQZ1 ~$17 · Apr 2023 NQM3 ~$16 ·
Jun 2026 / Aug 2026 NQU6 ~$36. (Rolls land in Mar/Jun/Sep/Dec — avoid those months and you
need only ONE symbol and ONE evaluator run.)

★ **Sequencing logic:** staging saves money only if the FIRST test can end the inquiry, and
the old month CANNOT. Old-month FAIL is not disqualifying (2022 NQ ran ~half today's message
density, different participant mix — a 2026-only edge is still tradeable). Old-month PASS
still requires the recent month before funding. **Recent-month FAIL IS disqualifying.** So the
$38 recent month carries the decision weight. Buy both if budget allows; if starting with the
$15 probe, treat a failure as INCONCLUSIVE, not a verdict. Upside case for the old month: a
2022 PASS = structural effect surviving 4 years of microstructure change = large confidence gain.

### ★ VERDICT BANDS — power analysis (2026-08-22, BEFORE data arrived)

Day-level bootstrap of the in-sample trades, 20k synthetic 21-session months:

| outcome | if edge LIVE | if edge DEAD | evidence |
|---|---|---|---|
| PF < 1.10 | 17% | 98% | original bar discarded a live edge 1 month in 6 |
| **PF >= 1.10** | 83% | 2% | **41:1 for live** |
| **net < $0** | **1%** | **84%** | **84:1 for dead** |
| net < -$10k | 0% | 64% | |

A live edge shows PF median 1.19 (10th pct 1.07, 90th 1.32) and net median +$33k
(10th +$13.4k) over a month. **A live edge essentially never loses over a full month.**

=> three bands, not binary: **CONFIRM** (PF>=1.10 & net>0) · **AMBIGUOUS** (net>0, PF<1.10
-> buy the 2nd month, one month cannot separate an off-month from a marginal edge) ·
**KILL** (net<0). Drew's framing was "only strongly negative = fail"; the bootstrap says
PLAIN negative is already 84:1, so KILL sits at net<0, not at some deeper threshold.
Revised on a POWER CALCULATION before the number existed — legitimate. Do NOT loosen again
once the result is known.

### THE ONLY NEXT STEP THAT MATTERS

**Buy 1-2 months of historical NQ MBO usage-based** (per-GB, NO subscription, NO annual
contract — this does NOT require the $1,750 Plus plan; that is only for LIVE MBO).
Then run `scripts/FROZEN-OOS-EVAL.py` **unchanged**. The parameters are frozen on purpose:
this finding's biggest exposure is re-tuning after seeing a soft OOS number.

Storage is a non-issue: stream one day at a time, extract, delete the raw.
57.4GB -> 38MB is a **1,511x** reduction; peak footprint ~2GB regardless of months pulled.

Prior odds: given the post-hoc band, single month, and 3-days-carry-66% concentration,
I'd put **better than even odds on it NOT surviving** OOS. That is exactly why the cheap
historical test comes before any $21k/yr commitment.
