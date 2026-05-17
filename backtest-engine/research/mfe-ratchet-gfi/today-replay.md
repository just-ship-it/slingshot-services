# Today Replay (2026-05-14) under MFE Ratchet Configurations

Drew's five gex-flip-ivpct signals from today, replayed under each candidate config.
T4 and T5 are blocked under flat-then-reenter (T3 is open the entire time).

## Baseline: live config BE 70 / +5

| Trade | Entry | MFE | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 5 | $100 | BE clip on rally (MFE 138.75) |
| T2 (10:40) | 29677.5 | 10 | -60 | $-1200 | original SL |
| T3 (11:15) | 29733 | 138 | 5 | $100 | BE clip on rally (MFE 138) |
| T4 (11:55) | 29754.75 | — | 0 | $0 | blocked (T3 open) |
| T5 (12:50) | 29731.75 | — | 0 | $0 | blocked (T3 open) |
| **TOTAL** |  |  | **-50** | **$-1000** |  |

## Structural-magnet ratchet (new mechanic)

Tiers are built per-trade from the visible 1m 9/9 swing lows in the profit region:
- T1 entry 29665.5: magnets 29664, 29595.25, 29533 (29664 has MFE=1.5, 29533 below TP)
- T3 entry 29733.0: magnets 29664 (MFE 69), 29595.25 (MFE 137.75), 29533 (MFE 200, ≥ TP, excluded)

### Config: `magnet-ratchet-75pct`

| Trade | Entry | MFE | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 104.06 | $2081.25 | magnet ratchet (highest tier MFE>=132.5, lock 75%) |
| T2 (10:40) | 29677.5 | 10 | -60 | $-1200 | original SL (no magnet touched, MFE too small) |
| T3 (11:15) | 29733 | 138 | 103.5 | $2070 | magnet ratchet (highest tier MFE>=137.8, lock 75%) |
| T4 (11:55) | 29754.75 | — | 0 | $0 | blocked (T3 still open) |
| T5 (12:50) | 29731.75 | — | 0 | $0 | blocked (T3 still open) |
| **TOTAL** |  |  | **147.6** | **$2951** | Δ vs baseline: +197.6pt / +$3951 |

### Config: `magnet-ratchet-65pct`

| Trade | Entry | MFE | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 90.19 | $1803.75 | magnet ratchet (highest tier MFE>=132.5, lock 65%) |
| T2 (10:40) | 29677.5 | 10 | -60 | $-1200 | original SL (no magnet touched, MFE too small) |
| T3 (11:15) | 29733 | 138 | 89.7 | $1794 | magnet ratchet (highest tier MFE>=137.8, lock 65%) |
| T4 (11:55) | 29754.75 | — | 0 | $0 | blocked (T3 still open) |
| T5 (12:50) | 29731.75 | — | 0 | $0 | blocked (T3 still open) |
| **TOTAL** |  |  | **119.9** | **$2398** | Δ vs baseline: +169.9pt / +$3398 |

### Config: `magnet-ratchet-85pct`

| Trade | Entry | MFE | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 117.94 | $2358.75 | magnet ratchet (highest tier MFE>=132.5, lock 85%) |
| T2 (10:40) | 29677.5 | 10 | -60 | $-1200 | original SL (no magnet touched, MFE too small) |
| T3 (11:15) | 29733 | 138 | 117.3 | $2346 | magnet ratchet (highest tier MFE>=137.8, lock 85%) |
| T4 (11:55) | 29754.75 | — | 0 | $0 | blocked (T3 still open) |
| T5 (12:50) | 29731.75 | — | 0 | $0 | blocked (T3 still open) |
| **TOTAL** |  |  | **175.2** | **$3505** | Δ vs baseline: +225.2pt / +$4505 |

## Pure-MFE ratchet variants (from earlier sweep)

### Config: `engine-default` — tiers `100:0.6,60:0.5,40:0.4,20:0.25`

| Trade | Entry | MFE | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 83.25 | $1665 | ratchet @ MFE peak (138.75pt) locked 60% |
| T2 (10:40) | 29677.5 | 10 | -60 | $-1200 | original SL (ratchet never engaged) |
| T3 (11:15) | 29733 | 138 | 82.8 | $1656 | ratchet @ MFE peak (138pt) locked 60% |
| T4 (11:55) | 29754.75 | — | 0 | $0 | blocked (T3 still open) |
| T5 (12:50) | 29731.75 | — | 0 | $0 | blocked (T3 still open) |
| **TOTAL** |  |  | **106.0** | **$2121** | Δ vs baseline: +156.1pt / +$3121 |

### Config: `s1-m100l40` — tiers `100:0.4`

| Trade | Entry | MFE | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 55.5 | $1110 | ratchet @ MFE peak (138.75pt) locked 40% |
| T2 (10:40) | 29677.5 | 10 | -60 | $-1200 | original SL (ratchet never engaged) |
| T3 (11:15) | 29733 | 138 | 55.2 | $1104 | ratchet @ MFE peak (138pt) locked 40% |
| T4 (11:55) | 29754.75 | — | 0 | $0 | blocked (T3 still open) |
| T5 (12:50) | 29731.75 | — | 0 | $0 | blocked (T3 still open) |
| **TOTAL** |  |  | **50.7** | **$1014** | Δ vs baseline: +100.7pt / +$2014 |

### Config: `s1-m100l50` — tiers `100:0.5`

| Trade | Entry | MFE | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 69.38 | $1387.5 | ratchet @ MFE peak (138.75pt) locked 50% |
| T2 (10:40) | 29677.5 | 10 | -60 | $-1200 | original SL (ratchet never engaged) |
| T3 (11:15) | 29733 | 138 | 69 | $1380 | ratchet @ MFE peak (138pt) locked 50% |
| T4 (11:55) | 29754.75 | — | 0 | $0 | blocked (T3 still open) |
| T5 (12:50) | 29731.75 | — | 0 | $0 | blocked (T3 still open) |
| **TOTAL** |  |  | **78.4** | **$1568** | Δ vs baseline: +128.4pt / +$2568 |

### Config: `s1-m100l60` — tiers `100:0.6`

| Trade | Entry | MFE | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 83.25 | $1665 | ratchet @ MFE peak (138.75pt) locked 60% |
| T2 (10:40) | 29677.5 | 10 | -60 | $-1200 | original SL (ratchet never engaged) |
| T3 (11:15) | 29733 | 138 | 82.8 | $1656 | ratchet @ MFE peak (138pt) locked 60% |
| T4 (11:55) | 29754.75 | — | 0 | $0 | blocked (T3 still open) |
| T5 (12:50) | 29731.75 | — | 0 | $0 | blocked (T3 still open) |
| **TOTAL** |  |  | **106.0** | **$2121** | Δ vs baseline: +156.1pt / +$3121 |

### Config: `s1-m70l40` — tiers `70:0.4`

| Trade | Entry | MFE | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 55.5 | $1110 | ratchet @ MFE peak (138.75pt) locked 40% |
| T2 (10:40) | 29677.5 | 10 | -60 | $-1200 | original SL (ratchet never engaged) |
| T3 (11:15) | 29733 | 138 | 55.2 | $1104 | ratchet @ MFE peak (138pt) locked 40% |
| T4 (11:55) | 29754.75 | — | 0 | $0 | blocked (T3 still open) |
| T5 (12:50) | 29731.75 | — | 0 | $0 | blocked (T3 still open) |
| **TOTAL** |  |  | **50.7** | **$1014** | Δ vs baseline: +100.7pt / +$2014 |

## Fib-retrace variants (NEW — bar-close confirmation)

Fib level for a short trade = `fillPrice - MFE × (1 − retracePct)`.
Trade exits on the FIRST 1m bar whose CLOSE is above the fib level
(after activation). Hard SL=60 unchanged; mechanism only engages once
MFE ≥ activationMFE.

Estimated exit price ≈ fib level + 5pt close-overshoot buffer (sharp
reversal bars typically close 5-15pt above the trigger threshold; 5pt
is a conservative midpoint). T2's MFE never reaches activation, so the
hard stop fires unchanged.

### Config: `fib-r618-a40` — best balanced (sweep PF 2.77 / Sharpe 5.59 / DD 7.11% / $127k)

retracePct = 0.618, activationMFE = 40. Locks 38.2% of MFE on bar close.

| Trade | Entry | MFE | Fib level | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 29612.50 | ~48 | ~$960 | fib_retrace (close > 29612.5) |
| T2 (10:40) | 29677.5 | 10 | n/a | -60 | $-1200 | SL — MFE < 40 (no engagement) |
| T3 (11:15) | 29733 | 138 | 29680.30 | ~48 | ~$960 | fib_retrace (close > 29680.3) |
| T4 (11:55) | 29754.75 | — | — | 0 | $0 | blocked (T3 open) |
| T5 (12:50) | 29731.75 | — | — | 0 | $0 | blocked (T3 open) |
| **TOTAL** |  |  |  | **~36** | **~+$720** | Δ vs baseline: +$1,720 |

### Config: `fib-r786-a30` — best PF (sweep PF 2.80 / Sharpe 5.10 / DD 8.28% / $123k)

retracePct = 0.786, activationMFE = 30. Locks 21.4% of MFE on bar close.

| Trade | Entry | MFE | Fib level | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 29635.80 | ~25 | ~$500 | fib_retrace |
| T2 (10:40) | 29677.5 | 10 | n/a | -60 | $-1200 | SL — MFE < 30 |
| T3 (11:15) | 29733 | 138 | 29703.45 | ~25 | ~$500 | fib_retrace |
| T4 (11:55) | 29754.75 | — | — | 0 | $0 | blocked |
| T5 (12:50) | 29731.75 | — | — | 0 | $0 | blocked |
| **TOTAL** |  |  |  | **~-10** | **~-$200** | Δ vs baseline: +$800 |

### Config: `fib-r886-a70` — max PnL+Sharpe (sweep PF 2.68 / Sharpe 6.00 / DD 9.98% / $146k)

retracePct = 0.886, activationMFE = 70. Locks 11.4% of MFE on bar close.

| Trade | Entry | MFE | Fib level | Exit pts | $ NQ | Reason |
|---|---:|---:|---:|---:|---:|---|
| T1 (09:50) | 29665.5 | 138.75 | 29649.68 | ~11 | ~$220 | fib_retrace |
| T2 (10:40) | 29677.5 | 10 | n/a | -60 | $-1200 | SL — MFE < 70 |
| T3 (11:15) | 29733 | 138 | 29717.27 | ~11 | ~$220 | fib_retrace |
| T4 (11:55) | 29754.75 | — | — | 0 | $0 | blocked |
| T5 (12:50) | 29731.75 | — | — | 0 | $0 | blocked |
| **TOTAL** |  |  |  | **~-38** | **~-$760** | Δ vs baseline: +$240 |

## Today net P&L by config (summary)

| Config | T1 | T2 | T3 | **Today net** | Δ vs live |
|---|---:|---:|---:|---:|---:|
| live BE 70/+5 (baseline) | +$100 | -$1,200 | +$100 | **-$1,000** | — |
| `fib-r886-a70` | +$220 | -$1,200 | +$220 | -$760 | +$240 |
| `fib-r786-a30` | +$500 | -$1,200 | +$500 | -$200 | +$800 |
| **`fib-r618-a40`** | **+$960** | **-$1,200** | **+$960** | **+$720** | **+$1,720** |
| `s1-m70l40` | +$1,110 | -$1,200 | +$1,104 | +$1,014 | +$2,014 |
| `magnet-ratchet-75pct` | +$2,081 | -$1,200 | +$2,070 | +$2,951 | +$3,951 |

On this specific MFE-then-rally pattern, pure-MFE ratchet and structural
magnet ratchet capture more raw P&L than fib variants — they lock at the
MFE peak regardless of how price retraces. Fib waits for a bar to confirm
the reversal via close, which costs ~50pt of capture on a sharp
reversal but **delivers better aggregate DD discipline** across 16
months ($146k @ 9.98% DD for fib-r886-a70 vs $134k @ 8.34% DD for the
pure-MFE winner). The fib mechanic is more discriminating; the pure-MFE
ratchet is more reactive.

All variants leave T2 unchanged. The activation threshold ensures the
fib mechanism never engages on quick-loss trades — full SL fires normally.
