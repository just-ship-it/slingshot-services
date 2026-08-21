# Does the ORDER BOOK predict a bounce at a level? (2026-08-21) — NO

The best-posed question of the program, and the first targeted use of the 407GB `mbp-1` /
58GB `mbo` sets: **at the instant price touches a level, does resting liquidity separate the
touches that bounce from the ones that break?**

It qualifies where earlier order-flow work did not: a STATE question (what the book is good
at) rather than direction (what it is not), at a precisely defined instant, on events already
labelled — 157,514 touches with a bounce/break outcome and a martingale baseline.

## Step 1 — mbp-1 answered, but could not have answered

5,934 touches joined to top-of-book. No separation (all abs t < 2.1, and the two marginal
cells pointed the WRONG way). But the magnitudes disqualify the test: defending size averaged
**2.0 contracts**, total **4.1**. NQ's inside book is 1-5 lots — far too thin to represent
"defence of a level". `mbp-1` is level-1 only, so it structurally cannot answer this.

## Step 2 — MBO depth reconstruction

Built `mbo_depth.py`: order-by-order replay (A/C/M/F/R) maintaining price->size ladders,
snapshotting resting size within ±5pt of the level at each touch instant. 11.5M front-month
rows/day, ~52s/day. Overlap with the touch set: **2,090 touches over 15 days**
(2026-01-08 .. 2026-01-28).

This sees real liquidity: **59-93 contracts** in the band versus mbp-1's ~2 at the inside.

## Step 3 — the result, and the trap inside it

Raw, it looks overwhelming: defending depth 80.3 on bounces vs 34.2 on breaks, **t = 25.4**;
`def_ratio` 0.786 vs 0.246, **t = 40.9**. And bounce rate rises monotonically with defending
depth, 5.5% -> 74.9% across quintiles.

🚨 It is geometry. The martingale tracks it just as closely:

| quintile | defend | bounce% | martingale% | skill | t |
|---|---|---|---|---|---|
| 0 | 0.0 | 5.5% | 6.5% | -1.01 | -0.99 |
| 2 | 61.8 | 65.8% | 67.2% | -1.38 | -0.72 |
| 3 | 86.8 | 74.9% | 77.4% | -2.48 | -1.32 |
| 4 | 121.5 | 72.2% | 72.0% | +0.23 | 0.11 |

`corr(defending depth, martingale prob) = 0.700`. The "defending" side holds more size
mostly because it is the side AWAY FROM SPOT. Residualising depth on the martingale and
re-testing leaves skill of -1.06 / -3.09 / -1.58 / -0.45 / +1.01 pp, all abs t <= 1.70, no
monotonicity. **Pooled: -1.03pp, t = -1.32.**

## Is 15 days enough to conclude?

Yes, for the economic question. se on skill is ~1.1pp at n=2,090, so the test detects
**>=2.2pp** at t=2. The cost bar on this payoff needs **~7pp**. A tradeable effect could not
hide here. A sub-2pp effect could — but it would not be worth trading.

## Verdict

Bounce/rejection at LT-fib and T-level prices is **not predictable** — not from price
(157k touches, -0.17pp), not from approach direction, not from level confluence, and not
from reconstructed order-book depth (-1.03pp). The book's apparent "defence" of a level is
a restatement of where price sits relative to it.

## Reusable

- `mbo_depth.py` — MBO order-by-order book reconstruction with depth snapshots at arbitrary
  prices/instants. Generic: give it timestamps and prices, it returns the ladder around them.
- `extract_book.sh` — mbp-1 -> per-second top-of-book, 1.1GB/day -> a few hundred KB.
- ★ The lesson that recurred three separate times today: **any level-relative feature is
  contaminated by where price sits relative to that level.** Residualise against the
  martingale (or the geometry) BEFORE reading a t-stat, however large it looks.
