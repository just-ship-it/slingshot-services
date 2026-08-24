#!/usr/bin/env python3
"""
LOCKED FILTER CANDIDATES — chosen 2026-08-22 on IN-SAMPLE (Dec 2025 - Jan 2026) ONLY.
Locked BEFORE April 2026 finished downloading and WITHOUT reading derived/ext_oos.

    DO NOT ADD, REMOVE OR RETUNE A FILTER AFTER SEEING TEST RESULTS.

Selection reasoning (all from in-sample, baseline PF 1.18 / $44.9 per trade):
  A range_low   pos<0.5   PF 1.39, n=408, $87.2/trade, maxDD $3,898 (vs $6,377)
                Kept because BOTH sides profit inside it (long 1.36 / short 1.41) so it is
                not a disguised directional bet, and it has the largest effect at large n.
                The losing cell is specifically SHORT while price sits in the upper half.
  B rth         9<=hour<=16 UTC   PF 1.26, n=648, net $43,818 > unfiltered $41,100
                i.e. it REMOVES money-losing trades (04utc -$92.7/trade, 19utc -$70.3).
  C both        A and B   PF 1.48, n=292, $111.8/trade, maxDD $3,760

REJECTED despite good in-sample numbers:
  size>=25 (PF 1.56) — size is NON-MONOTONE: 10-14:1.13  15-19:1.26  20-24:0.90
                       25-49:1.69  50+:1.29. A loser between winners means the 25-49
                       bucket is likely a lucky draw at n=93, not a size effect.
  dist<4.0 (PF 1.22)  — effect too small to justify halving the sample.
  gap>=300s (PF 1.24) — same, and it raised maxDD to $9,637.

15 single splits + 5 combinations were examined, so expect ~1 to look good by chance.
Two independent test months (April 2026, Jul-Aug 2026) is the bar.
"""
FILTERS = {
    'baseline':   lambda f: True,
    'A_range_low': lambda f: f['pos'] < 0.5,
    'B_rth':       lambda f: 9 <= f['hour'] <= 16,
    'C_both':      lambda f: f['pos'] < 0.5 and 9 <= f['hour'] <= 16,
}
# in-sample results, recorded at lock time for comparison
INSAMPLE = {
    'baseline':    dict(n=915, pf=1.18, net=41100,  per=44.9,  dd=6377),
    'A_range_low': dict(n=408, pf=1.39, net=35558,  per=87.2,  dd=3898),
    'B_rth':       dict(n=648, pf=1.26, net=43818,  per=67.6,  dd=5146),
    'C_both':      dict(n=292, pf=1.48, net=32632,  per=111.8, dd=3760),
}
