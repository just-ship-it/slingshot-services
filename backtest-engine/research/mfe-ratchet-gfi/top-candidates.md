# MFE Ratchet Sweep — Top Candidates

Sweep window: 2025-01-13 to 2026-04-20
PF floor: 1.4
Configs tested: 28 | Passed PF floor: 28 | Failed: 0

Objective ordering:
1. **Primary**: winnerCaptureRatio (% of favorable MFE on winners that we monetized)
2. **Tiebreaker**: Sharpe ratio (smoothness)
3. **Secondary view**: composite PnL = totalPnL − 0.5 × |giveback $|

## Baseline reference (current live BE 70/+5)

```json
{
  "totalTrades": 172,
  "winRate": 61.63,
  "profitFactor": 2.99,
  "sharpeRatio": 6.41,
  "maxDrawdownPct": 11.3,
  "totalPnL": 157329,
  "winners": 106,
  "totalWinnerPnL_pts": 11846.7,
  "totalWinnerMFE_pts": 16510.7,
  "totalGiveback_pts": 4664,
  "givebackDollars": 93280,
  "winnerCaptureRatio": 71.75,
  "beClipCount_MFE70_exit_under30": 38,
  "beClipPct": 22.09,
  "bigBeClipCount_MFE100_exit_under50": 20,
  "bigBeClipPct": 11.63,
  "mfeToSLCount_MFE50_exit_full_SL": 8,
  "mfeToSLPct": 4.65
}
```

## Top 3 by Winner Capture Ratio

### #1: `s1-m100l40` (tiers: 100:0.4)

| Metric | Baseline (BE 70/+5) | Candidate | Δ |
|---|---:|---:|---:|
| Trades | 172.00 | 172.00 | +0.00 |
| Win Rate | 61.63% | 56.40% | -5.23pp |
| Profit Factor | 2.99 | 2.46 | -0.53 |
| Sharpe | 6.41 | 5.73 | -0.68 |
| Max DD % | 11.30% | 10.10% | -1.20pp |
| Total PnL | $157,329 | $129,901 | $-27,428 |
| Avg Winner MFE | 155.76 | 157.98 | +2.22 |
| Avg Giveback | 27.12 | 65.18 | +38.06 |
| Winner Capture % | 71.75% | 71.57% | -0.18pp |
| BE-Clip count | 38.00 | 11.00 | -27.00 |
| Big-BE-Clip | 20.00 | 19.00 | -1.00 |
| MFE→SL count | 8.00 | 17.00 | +9.00 |
| Giveback $ | $93,280 | $87,138 | $-6,142 |

### #2: `s1-m100l50` (tiers: 100:0.5)

| Metric | Baseline (BE 70/+5) | Candidate | Δ |
|---|---:|---:|---:|
| Trades | 172.00 | 176.00 | +4.00 |
| Win Rate | 61.63% | 56.82% | -4.81pp |
| Profit Factor | 2.99 | 2.35 | -0.64 |
| Sharpe | 6.41 | 5.53 | -0.88 |
| Max DD % | 11.30% | 9.80% | -1.50pp |
| Total PnL | $157,329 | $121,441 | $-35,888 |
| Avg Winner MFE | 155.76 | 149.38 | -6.38 |
| Avg Giveback | 27.12 | 63.98 | +36.86 |
| Winner Capture % | 71.75% | 71.00% | -0.75pp |
| BE-Clip count | 38.00 | 11.00 | -27.00 |
| Big-BE-Clip | 20.00 | 2.00 | -18.00 |
| MFE→SL count | 8.00 | 17.00 | +9.00 |
| Giveback $ | $93,280 | $86,628 | $-6,652 |

### #3: `s1-m100l60` (tiers: 100:0.6)

| Metric | Baseline (BE 70/+5) | Candidate | Δ |
|---|---:|---:|---:|
| Trades | 172.00 | 179.00 | +7.00 |
| Win Rate | 61.63% | 56.98% | -4.65pp |
| Profit Factor | 2.99 | 2.19 | -0.80 |
| Sharpe | 6.41 | 5.29 | -1.12 |
| Max DD % | 11.30% | 9.45% | -1.85pp |
| Total PnL | $157,329 | $108,951 | $-48,378 |
| Avg Winner MFE | 155.76 | 141.27 | -14.49 |
| Avg Giveback | 27.12 | 63.52 | +36.40 |
| Winner Capture % | 71.75% | 69.71% | -2.04pp |
| BE-Clip count | 38.00 | 11.00 | -27.00 |
| Big-BE-Clip | 20.00 | 1.00 | -19.00 |
| MFE→SL count | 8.00 | 17.00 | +9.00 |
| Giveback $ | $93,280 | $87,293 | $-5,987 |


## Top 3 by composite PnL (PnL − 0.5 × |giveback|)

### #1: `s1-m100l40` (tiers: 100:0.4)

| Metric | Baseline (BE 70/+5) | Candidate | Δ |
|---|---:|---:|---:|
| Trades | 172.00 | 172.00 | +0.00 |
| Win Rate | 61.63% | 56.40% | -5.23pp |
| Profit Factor | 2.99 | 2.46 | -0.53 |
| Sharpe | 6.41 | 5.73 | -0.68 |
| Max DD % | 11.30% | 10.10% | -1.20pp |
| Total PnL | $157,329 | $129,901 | $-27,428 |
| Avg Winner MFE | 155.76 | 157.98 | +2.22 |
| Avg Giveback | 27.12 | 65.18 | +38.06 |
| Winner Capture % | 71.75% | 71.57% | -0.18pp |
| BE-Clip count | 38.00 | 11.00 | -27.00 |
| Big-BE-Clip | 20.00 | 19.00 | -1.00 |
| MFE→SL count | 8.00 | 17.00 | +9.00 |
| Giveback $ | $93,280 | $87,138 | $-6,142 |

### #2: `s1-m70l40` (tiers: 70:0.4)

| Metric | Baseline (BE 70/+5) | Candidate | Δ |
|---|---:|---:|---:|
| Trades | 172.00 | 181.00 | +9.00 |
| Win Rate | 61.63% | 61.88% | +0.25pp |
| Profit Factor | 2.99 | 2.61 | -0.38 |
| Sharpe | 6.41 | 5.97 | -0.44 |
| Max DD % | 11.30% | 8.34% | -2.96pp |
| Total PnL | $157,329 | $133,542 | $-23,787 |
| Avg Winner MFE | 155.76 | 139.44 | -16.32 |
| Avg Giveback | 27.12 | 59.41 | +32.29 |
| Winner Capture % | 71.75% | 69.44% | -2.31pp |
| BE-Clip count | 38.00 | 2.00 | -36.00 |
| Big-BE-Clip | 20.00 | 14.00 | -6.00 |
| MFE→SL count | 8.00 | 12.00 | +4.00 |
| Giveback $ | $93,280 | $95,466 | +$2,186 |

### #3: `s1-m100l50` (tiers: 100:0.5)

| Metric | Baseline (BE 70/+5) | Candidate | Δ |
|---|---:|---:|---:|
| Trades | 172.00 | 176.00 | +4.00 |
| Win Rate | 61.63% | 56.82% | -4.81pp |
| Profit Factor | 2.99 | 2.35 | -0.64 |
| Sharpe | 6.41 | 5.53 | -0.88 |
| Max DD % | 11.30% | 9.80% | -1.50pp |
| Total PnL | $157,329 | $121,441 | $-35,888 |
| Avg Winner MFE | 155.76 | 149.38 | -6.38 |
| Avg Giveback | 27.12 | 63.98 | +36.86 |
| Winner Capture % | 71.75% | 71.00% | -0.75pp |
| BE-Clip count | 38.00 | 11.00 | -27.00 |
| Big-BE-Clip | 20.00 | 2.00 | -18.00 |
| MFE→SL count | 8.00 | 17.00 | +9.00 |
| Giveback $ | $93,280 | $86,628 | $-6,652 |


## Pareto frontier (PF × PnL × Capture)

| id | tiers | trades | PF | Sharpe | DD% | PnL | Capture% | BE-clip | MFE→SL |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| s1-m70l40 | 70:0.4 | 181 | 2.61 | 5.97 | 8.34 | $133,542 | 69.44 | 2 | 12 |
| s1-m100l40 | 100:0.4 | 172 | 2.46 | 5.73 | 10.10 | $129,901 | 71.57 | 11 | 17 |

## All survivors (sorted by capture ratio)

| id | tiers | trades | PF | Sharpe | DD% | PnL | Capture% | Giveback$ | BE-clip | MFE→SL |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| s1-m100l40 | 100:0.4 | 172 | 2.46 | 5.73 | 10.10 | $129,901 | 71.57 | $87,138 | 11 | 17 |
| s1-m100l50 | 100:0.5 | 176 | 2.35 | 5.53 | 9.80 | $121,441 | 71.00 | $86,628 | 11 | 17 |
| s1-m100l60 | 100:0.6 | 179 | 2.19 | 5.29 | 9.45 | $108,951 | 69.71 | $87,293 | 11 | 17 |
| s1-m70l40 | 70:0.4 | 181 | 2.61 | 5.97 | 8.34 | $133,542 | 69.44 | $95,466 | 2 | 12 |
| s1-m70l60 | 70:0.6 | 191 | 2.12 | 4.82 | 7.98 | $98,103 | 69.21 | $82,921 | 0 | 11 |
| s1-m70l50 | 70:0.5 | 188 | 2.16 | 4.72 | 8.62 | $101,475 | 67.33 | $92,078 | 0 | 12 |
| s2-m120l70-m70l40 | 120:0.7,70:0.4 | 185 | 2.30 | 5.32 | 7.59 | $109,622 | 66.81 | $96,495 | 2 | 12 |
| s2-m150l60-m70l40 | 150:0.6,70:0.4 | 183 | 2.49 | 5.73 | 8.30 | $123,402 | 66.50 | $104,140 | 2 | 12 |
| s2-m120l70-m70l50 | 120:0.7,70:0.5 | 189 | 2.05 | 4.47 | 8.57 | $91,735 | 66.37 | $91,219 | 0 | 12 |
| s2-m150l70-m70l40 | 150:0.7,70:0.4 | 183 | 2.45 | 5.65 | 8.44 | $120,087 | 66.28 | $103,489 | 2 | 12 |
| s2-m150l60-m70l50 | 150:0.6,70:0.5 | 188 | 2.08 | 4.51 | 8.57 | $94,745 | 65.44 | $96,667 | 0 | 12 |
| s2-m150l70-m70l50 | 150:0.7,70:0.5 | 188 | 2.06 | 4.49 | 8.72 | $92,890 | 65.26 | $96,461 | 0 | 12 |
| s2-m120l60-m70l50 | 120:0.6,70:0.5 | 189 | 2.04 | 4.43 | 8.61 | $90,825 | 65.02 | $96,347 | 0 | 12 |
| s2-m120l60-m70l40 | 120:0.6,70:0.4 | 185 | 2.30 | 5.20 | 7.88 | $108,912 | 64.97 | $104,333 | 2 | 12 |
| s1-m50l40 | 50:0.4 | 170 | 2.41 | 4.56 | 8.68 | $93,922 | 64.14 | $90,055 | 3 | 0 |
| s1-m50l60 | 50:0.6 | 180 | 1.72 | 3.12 | 11.54 | $51,783 | 64.04 | $69,537 | 0 | 0 |
| s1-m50l50 | 50:0.5 | 178 | 1.88 | 3.43 | 10.68 | $63,193 | 62.37 | $81,584 | 0 | 0 |
| s3-m160l70-m100l55-m60l40 | 160:0.7,100:0.55,60:0.4 | 172 | 2.10 | 4.26 | 8.78 | $81,027 | 62.35 | $93,921 | 4 | 6 |
| s2-m120l70-m50l50 | 120:0.7,50:0.5 | 179 | 1.79 | 3.33 | 10.18 | $56,658 | 61.01 | $82,269 | 0 | 0 |
| s2-m120l70-m50l40 | 120:0.7,50:0.4 | 175 | 2.14 | 4.16 | 7.99 | $77,292 | 60.79 | $93,950 | 3 | 0 |
| s2-m150l60-m50l50 | 150:0.6,50:0.5 | 178 | 1.82 | 3.30 | 10.65 | $58,888 | 60.61 | $85,083 | 0 | 0 |
| s2-m150l60-m50l40 | 150:0.6,50:0.4 | 172 | 2.24 | 4.27 | 8.64 | $82,367 | 59.99 | $99,719 | 3 | 0 |
| s2-m150l70-m50l50 | 150:0.7,50:0.5 | 178 | 1.78 | 3.23 | 10.76 | $55,953 | 59.80 | $86,067 | 0 | 0 |
| s3-m140l65-m90l50-m50l35 | 140:0.65,90:0.5,50:0.35 | 174 | 2.22 | 4.29 | 8.59 | $80,842 | 59.71 | $99,831 | 10 | 0 |
| s2-m120l60-m50l50 | 120:0.6,50:0.5 | 179 | 1.77 | 3.15 | 10.51 | $54,893 | 59.58 | $86,138 | 0 | 0 |
| s2-m150l70-m50l40 | 150:0.7,50:0.4 | 172 | 2.20 | 4.22 | 8.85 | $79,742 | 59.54 | $99,808 | 3 | 0 |
| s2-m120l60-m50l40 | 120:0.6,50:0.4 | 175 | 2.11 | 4.05 | 8.22 | $75,557 | 59.20 | $99,189 | 3 | 0 |
| s3-m150l65-m80l50-m40l30 | 150:0.65,80:0.5,40:0.3 | 179 | 2.12 | 3.69 | 10.09 | $68,952 | 55.69 | $104,372 | 5 | 0 |

---

# Fib-Retrace Sweep — Bar-Close Exit Mechanism (NEW)

Implemented per Drew's spec (2026-05-15): hard SL=60 unchanged, exit only
on a 1m bar CLOSE through a percent-retrace level from fill price to
running MFE extreme. Activation gate ensures the mechanism stays dormant
until MFE reaches a threshold.

Sweep dimension: `retracePct` ∈ {0.50, 0.618, 0.706, 0.786, 0.886} ×
`activationMFE` ∈ {30, 40, 50, 70} = 20 cells. Same 16-month window.

## Best-of-category

| Category | Config | retracePct | activationMFE | PF | Sharpe | DD% | PnL$ |
|---|---|---:|---:|---:|---:|---:|---:|
| Best PF | `fib-r786-a30` | 0.786 | 30 | **2.80** | 5.10 | 8.28 | 123,429 |
| **Best PnL+Sharpe** | `fib-r886-a70` | 0.886 | 70 | 2.68 | **6.00** | 9.98 | **145,956** |
| Lowest DD | `fib-r618-a30` | 0.618 | 30 | 2.72 | 4.97 | **6.58** | 114,112 |
| **Best balanced** | `fib-r618-a40` | 0.618 | 40 | 2.77 | 5.59 | **7.11** | 127,502 |

## All 20 configs (sorted by PF desc)

| Config | retr | act | Trades | PF | Sharpe | DD% | PnL$ | Capture% | Giveback | fibExits | mfe→SL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `fib-r786-a30` | 0.786 | 30 | 189 | 2.80 | 5.10 | 8.28 | 123,429 | — | 51.6 | 88 | 5 |
| `fib-r786-a40` | 0.786 | 40 | 184 | 2.78 | 5.47 | 8.75 | 131,157 | 68.89 | 55.6 | 73 | 5 |
| `fib-r618-a40` | 0.618 | 40 | 189 | 2.77 | 5.59 | 7.11 | 127,502 | — | 52.0 | 86 | 5 |
| `fib-r886-a50` | 0.886 | 50 | 178 | 2.77 | 5.69 | 10.24 | 138,346 | — | 59.6 | 52 | 6 |
| `fib-r886-a30` | 0.886 | 30 | 182 | 2.75 | 4.87 | 9.61 | 120,576 | — | 55.1 | 75 | 5 |
| `fib-r786-a50` | 0.786 | 50 | 180 | 2.74 | 5.61 | 9.44 | 134,987 | — | 58.3 | 62 | 6 |
| `fib-r886-a40` | 0.886 | 40 | 181 | 2.74 | 5.31 | 10.83 | 130,836 | — | 57.6 | 62 | 5 |
| `fib-r618-a30` | 0.618 | 30 | 194 | 2.72 | 4.97 | 6.58 | 114,112 | — | 48.5 | 101 | 5 |
| `fib-r706-a30` | 0.706 | 30 | 191 | 2.72 | 4.92 | 7.40 | 115,767 | — | 49.8 | 94 | 5 |
| `fib-r886-a70` | 0.886 | 70 | 169 | 2.68 | 6.00 | 9.98 | 145,956 | — | 62.4 | 30 | 14 |
| `fib-r706-a40` | 0.706 | 40 | 187 | 2.67 | 5.22 | 7.72 | 121,912 | — | 54.0 | 82 | 5 |
| `fib-r618-a50` | 0.618 | 50 | 184 | 2.66 | 5.63 | 8.07 | 128,967 | — | 56.8 | 74 | 6 |
| `fib-r706-a50` | 0.706 | 50 | 182 | 2.63 | 5.38 | 8.81 | 127,257 | — | 57.9 | 69 | 6 |
| `fib-r786-a70` | 0.786 | 70 | 171 | 2.63 | 5.79 | 10.33 | 141,952 | — | 62.4 | 36 | 16 |
| `fib-r706-a70` | 0.706 | 70 | 173 | 2.54 | 5.54 | 9.61 | 134,772 | — | 63.5 | 44 | 16 |
| `fib-r618-a70` | 0.618 | 70 | 175 | 2.53 | 5.75 | 7.51 | 133,872 | — | 63.1 | 50 | 17 |
| `fib-r500-a70` | 0.50  | 70 | 177 | 2.37 | 5.44 | 8.13 | 121,647 | — | 60.8 | 61 | 17 |
| `fib-r500-a40` | 0.50  | 40 | 192 | 2.35 | 4.53 | 11.81 | 98,217 | — | 49.4 | 101 | 5 |
| `fib-r500-a50` | 0.50  | 50 | 187 | 2.26 | 4.67 | 10.95 | 101,177 | — | 54.6 | 88 | 6 |
| `fib-r500-a30` | 0.50  | 30 | 200 | 2.14 | 3.49 | 11.59 | 76,757 | — | 45.4 | 121 | 5 |

## Top 3 candidates for live deployment

### 1. `fib-r618-a40` — RECOMMENDED for balanced

- PF 2.77 (vs baseline 2.99, −0.22)
- Sharpe 5.59 (vs baseline 6.41, −0.82)
- DD **7.11%** (vs baseline 11.30%, **−4.19pp**)
- PnL $127,502 (vs baseline $157,329, −$29,827)
- Today (2026-05-14): ~+$720 vs live −$1,000 = **+$1,720 rescue**

**Trade-off**: Sacrifices $30k of 16-month PnL to cut max drawdown
nearly in half. On wave-pattern days like today this config catches the
+50pt zone reliably because the 61.8% retrace level is far enough below
fill to require a sharp reversal before exiting.

### 2. `fib-r886-a70` — RECOMMENDED for max PnL

- PF 2.68 (vs baseline 2.99, −0.31)
- Sharpe **6.00** (vs baseline 6.41, −0.41)
- DD 9.98% (vs baseline 11.30%, −1.32pp)
- PnL **$145,956** (vs baseline $157,329, −$11,373)
- Today: ~−$760 vs live −$1,000 = +$240 rescue (only marginally helpful)

**Trade-off**: Closest to baseline on PnL. The very-late activation
threshold (70pt) means the mechanism only protects trades that have
genuinely earned protection — small wins still ride to TP/SL without
interference. mfe→SL bumps to 14 (vs 8 baseline) because the activation
gate sometimes prevents engagement on borderline reversals.

### 3. `fib-r786-a30` — runner-up for max PF

- PF **2.80** (vs baseline 2.99, −0.19) — closest variant to baseline PF
- Sharpe 5.10 (vs baseline 6.41, −1.31)
- DD 8.28% (vs baseline 11.30%, −3.02pp)
- PnL $123,429 (vs baseline $157,329, −$33,900)
- Today: ~−$200 vs live −$1,000 = +$800 rescue

**Trade-off**: Highest PF in the entire fib grid. Lower Sharpe than
fib-r618-a40 because trades fire more often (189 vs 189 — same trade
count but more fib exits at 88 vs 86, suggesting slightly less smooth
equity curve).

## Honest verdict

None of the fib variants beat the baseline (BE 70/+5) on raw PnL or PF.
The baseline is hard to beat because it's tuned tight: BE arms at MFE 70
and locks +5, so MOST winners run to TP=200 unscathed, and the BE-clip
events that DO happen lock small profit ($100 per clip). The fib
mechanism trades some of that "let winners run to TP" effect for
"limit-cap on the rare big giveback" — saving ~$1,500-2,000 per painful
day but losing some upside on winning days where the bar happens to
close past the fib threshold mid-flight.

**The strategic question for Drew**: is half the drawdown worth $30k of
16-month PnL? On a small account that goes bust at 20% DD, yes. On a
PnL-maximizing setup with deep capital, probably no.
