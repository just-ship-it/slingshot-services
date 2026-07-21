# B5 — Honest 1s viability sim: elevated-volume directional-thrust FADE

**Verdict: DEAD.** No config in the disclosed 16-config dev grid reaches the survival
bar (PF ≥ 1.3, positive every year, ≥100 trades). The single pre-registered config
loses money on the locked 2025–2026 set (PF 0.955, negative both years). The census's
headline −2.58 pt heavy-thrust edge is a **day-weighting artifact**: the tradable
pooled per-trade drift is ≈ 0, and after 1s fill costs the fade is a net loser.

Date: 2026-07-17. Data: RTH 1s cache `cache_nq_rth_1s.csv` (31.2M rows, 1,345 eligible
days 2021–2026). Signal built causally in `B5-01-signal.py`; sim in `B5-02-sim.py`.

---

## 1. Signal (reconstructed causally, independent of census outputs)

Faithful to the census (R3-04) thrust detector, re-implemented from raw 1s bars:

- Per-minute close (fwd-filled) & volume from 1s bars, minute index m from 09:28 ET.
- `net3[m] = close[m] − close[m−3]` (trailing-3m move).
- `netb3[m] =` median of `|net3[m]|` over the **previous 20 eligible days** (strictly
  prior, causal). Eligible = full RTH + ≥20,000 traded seconds.
- **THRUST**: `|net3[m]| ≥ k · netb3[m]`, dir = sign(net3), **5-min per-day cooldown**.
- `vm3[m] = (V[m]+V[m−1]+V[m−2]) / (volb[m]+volb[m−1]+volb[m−2])`, volb = prev-20-day
  median of that minute's volume (causal).
- ATR regime = trailing-250d tercile of `atr14_prior` (knowable 09:30).
- Every input knowable at the minute-m **close** second (`base + m·60 + 59`); order
  placed at +1s (`base + (m+1)·60`).

**Trade = fade (counter to thrust dir).** No entries after 15:15 ET, hard flat 15:45 ET.
Roll days excluded. All fills/exits walk 1s bars from the fill instant. Costs: $5 RT
commission, limit fills exact, market entry ±0.25 adverse, stop ±0.5, time exit ±0.25.

**Signal parity check:** my causal pooled aligned-drift matches the census's own
`R3-baselines.npz` arrays at the pooled level (see §2), confirming the signal is
reconstructed correctly — the disagreement with the census is about *weighting*, not a bug.

---

## 2. The census edge is a day-weighting artifact (root cause)

Aligned forward +15m drift (`dir · fwd`; census claims this is NEGATIVE → fade pays),
computed from the **census's own R3-baselines.npz**, 5-min cooldown, `|net3|≥2·netb3`:

| bucket (2021–2024) | n | **day-weighted mean** | t | **pooled mean** |
|---|---|---|---|---|
| vacuum vm3≤0.7 | 1,358 | +0.75 | +0.78 | +0.55 |
| mid 0.7–1.5 | 23,430 | +0.35 | +1.68 | +0.21 |
| heavy vm3≥1.5 | 10,323 | **−1.63** | **−4.19** | −0.87 |
| HEAVY vm3≥2.5 | 1,846 | **−2.22** | −2.62 | **+0.17** |
| HEAVY vm3≥2.5 (all yrs) | 2,670 | **−2.58** | −2.87 | ≈ 0 |

The census's −2.58 pt / t=−4.4 headline is the **day-weighted** mean. The **pooled**
(per-trade) mean for the HEAVY tail is ≈ **0 to +0.17** (wrong sign for a fade).
My independent causal rebuild reproduces the pooled value (HEAVY≥2.5 pooled +0.10).

**Why it matters:** a trader realizes the *pooled per-trade* expectation, not the
day-weighted mean. The reversal concentrates on low-thrust-count days; high-thrust-count
days (volatile/trend days that emit the most tradable signals) CONTINUE. The fade gets
run over exactly when it fires most — an adverse-selection/clustering trap that the
day-clustered t-stat masks. There is no tradable gross edge to begin with.

---

## 3. Dev grid — ALL 16 configs disclosed (2021–2024)

Fade sim, honest 1s fills. `gpts` = avg gross pts/trade (before commission). None pass
the bar. **No config is positive every year** (2023 negative in nearly all; 2022 in most).

### Stage A — signal scan (exit fixed: targ 0.15×ATR / stop 0.30×ATR / hold 15m / mkt)

| config | n | WR | PF | avg$ | gpts | Sharpe | maxDD | yrs+ | per-year PF (21/22/23/24) |
|---|---|---|---|---|---|---|---|---|---|
| k1.5 vm3≥1.5 all | 9985 | 51.2 | 0.985 | −3.7 | 0.07 | −0.29 | −140k | 2/4 | 1.01/1.08/**0.84**/**0.98** |
| k1.5 vm3≥1.5 top | 3241 | 52.6 | 1.060 | 17.8 | 1.14 | 0.67 | −30k | 3/4 | 1.10/1.12/**0.56**/1.04 |
| k1.5 vm3≥2.5 all | 1794 | 52.2 | 0.961 | −11.7 | −0.34 | −0.36 | −56k | 3/4 | 1.04/1.00/**0.75**/1.02 |
| k1.5 vm3≥2.5 top | 521 | 52.8 | 1.042 | 15.4 | 1.02 | 0.25 | −20k | 2/4 | **0.99**/1.00/**0.54**/1.21 |
| k2.0 vm3≥1.5 all | 9396 | 51.2 | 1.002 | 0.5 | 0.27 | 0.03 | −149k | 3/4 | 1.06/1.04/**0.84**/1.03 |
| k2.0 vm3≥1.5 top | 3064 | 53.3 | 1.111 | 32.3 | 1.87 | 1.08 | −22k | 3/4 | 1.25/1.11/**0.62**/1.13 |
| k2.0 vm3≥2.5 all | 1692 | 51.6 | 0.959 | −12.4 | −0.37 | −0.36 | −55k | 2/4 | 1.03/**0.88**/**0.80**/1.13 |
| k2.0 vm3≥2.5 top | 496 | 53.6 | 1.068 | 24.2 | 1.46 | 0.37 | −15k | 2/4 | 1.15/**0.91**/**0.53**/1.38 |

### Stage B — exit sweep on the census a-priori best cell (k2.0 vm3≥2.5 atr=top)

| config | n | WR | PF | avg$ | gpts | Sharpe | maxDD | yrs+ | per-year PF (21/22/23/24) |
|---|---|---|---|---|---|---|---|---|---|
| targ0.10 stop0.30 hold15 mkt | 496 | 58.9 | 1.013 | 4.4 | 0.47 | 0.08 | −19k | 2/4 | 1.12/**0.89**/**0.46**/1.25 |
| targ0.10 stop0.30 hold15 lim | 349 | 61.9 | 1.098 | 31.4 | 1.82 | 0.39 | −19k | 2/4 | 1.68/**0.85**/**0.45**/1.50 |
| targ0.10 stop0.30 hold30 mkt | 496 | 63.7 | 0.922 | −32.7 | −1.39 | −0.39 | −37k | 3/4 | 1.05/**0.73**/1.05/1.17 |
| targ0.10 stop0.30 hold30 lim | 349 | 66.8 | 1.023 | 9.3 | 0.72 | 0.09 | −31k | 3/4 | 1.59/**0.69**/1.02/1.53 |
| targ0.20 stop0.30 hold15 mkt | 496 | 51.8 | 1.089 | 32.6 | 1.88 | 0.52 | −11k | 2/4 | 1.18/**0.98**/**0.59**/1.31 |
| **targ0.20 stop0.30 hold15 lim** ★ | 349 | 54.4 | **1.141** | 53.6 | 2.93 | 0.56 | −13k | 2/4 | 1.48/**0.88**/**0.68**/1.58 |
| targ0.20 stop0.30 hold30 mkt | 496 | 54.8 | 1.021 | 10.5 | 0.78 | 0.11 | −33k | 2/4 | **0.97**/**0.82**/1.50/1.33 |
| targ0.20 stop0.30 hold30 lim | 349 | 55.3 | 1.043 | 22.4 | 1.37 | 0.15 | −37k | 3/4 | 1.06/**0.73**/1.70/1.57 |

★ = best-of-16 dev config by PF (1.141). It is the single best cell of a 16-config
sweep; even so it fails "positive every year" (2022 & 2023 negative). **Distrusted.**

Note: `vm3≥2.5, atr=all` cells are outright **negative gross** (gpts −0.34/−0.37) —
fading heavy thrusts across all regimes loses before costs. The apparent positive gross
in `atr=top` cells (bigger absolute moves) does not convert to a stable per-year edge.

---

## 4. FROZEN CONFIG (declared BEFORE the locked run)

Frozen in `B5-frozen.json` on 2026-07-17, before any 2025–2026 evaluation:

```
k=2.0, vm3≥2.5, atr=top, targ_c=0.20, stop_c=0.30, hold=15m, entry=limit(off=8pt, win=180s)
```

Chosen as the best-of-16 dev config by PF (1.141), **explicitly distrusted** as the
single best cell of a sweep that already fails the survival bar in dev. Frozen only to
document OOS behavior; the strategy is DEAD in dev independent of the locked result.

## 5. LOCKED 2025–2026 result (single run, verbatim)

```
LOCKED 2025-2026            n=286  WR=51.0  PF=0.955  avg=$-28.4  gpts=-1.17  Sh=-0.23  DD=$-27113  y+=0/2
   [2025:$-3207/n174/pf0.97  2026:$-4906/n112/pf0.93]  exits{time:204, target:56, stop:26}
LOCKED 2025-2026 (2x slip)  n=286  WR=51.0  PF=0.948  avg=$-32.8  gpts=-1.39  Sh=-0.27  DD=$-27793  y+=0/2
   [2025:$-3967/n174/pf0.96  2026:$-5426/n112/pf0.93]
```

The dev "edge" (PF 1.141) fully collapses out-of-sample: PF 0.955, **negative both
years**, gross pts/trade **negative** (−1.17). Fails the locked bar (PF ≥ 1.2) decisively.

---

## 6. Net-vs-gross cost analysis

| quantity | value |
|---|---|
| Census headline (day-weighted, all yrs, HEAVY≥2.5) | +2.58 pts fade "edge" |
| **Tradable pooled** gross +15m drift, HEAVY≥2.5 | ≈ 0 (+0.10 to +0.17 aligned = ~0 fade) |
| Frozen-geometry gross pts/trade, LOCKED | **−1.17 pts** |
| Round-trip cost (comm 0.25pt + entry 0.25 + exit 0.25–0.5) | ≈ 0.75–1.0 pt |
| Frozen-geometry **net** $/trade, LOCKED | **−$28.4** (−1.42 net pts) |

Almost none of the census's 2.58 pt gross "edge" is real for a trader: ~2.4 pts of it is
a day-weighting illusion, leaving a pooled edge of ≈ 0, which then goes negative once the
trade geometry and 1s adverse selection are applied.

## 7. Failure mode

1. **Day-weighting illusion.** The census effect is a per-day statistic; the per-trade
   (pooled) expectation the trader actually earns is ≈ 0. High-signal-count days continue
   (momentum), low-count days reverse — classic clustering/adverse selection.
2. **No cost cushion.** Even where a thin positive gross appeared (atr=top), it was
   year-unstable (2022–2023 negative) and below the ~0.75–1.0 pt cost floor.
3. **OOS collapse.** Gross pts/trade flips from slightly-positive-in-cherry-picked-dev
   to −1.17 on the locked set — the "edge" was overfit noise in a best-of-16 selection.

This is another instance of the project's recurring pattern: a small 1m/census
probability signature that evaporates at the 1s fill level. Fast, honest DEAD.

## Files
- `B5-01-signal.py` — causal thrust/vm3/baseline builder → `B5-events.csv`
- `B5-02-sim.py` — honest 1s fade sim (`dev` / `descstat` / `lock` modes)
- `B5-frozen.json` — pre-registered locked config
