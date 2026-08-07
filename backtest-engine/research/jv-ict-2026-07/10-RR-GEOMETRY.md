# JV-ICT — Ex-ante R:R Selection + Structural Brackets + Profit-Lock Management (2026-07-23)

**Hypothesis under test (first-hand detail from Drew, who traded live alongside the author for a year):** the author (a) stopped a fixed 4–5 pts beyond the invalidation level (sweep extreme), (b) targeted external liquidity pools (prior swing extremes beyond the leg terminus), (c) computed ex-ante R:R on every trade and skipped setups that didn't pay, and (Task 4 addition) managed with tight 20–30 pt max loss, 50–200+ pt targets, and a profit-lock once +20–30 pts. Observed live profile to reproduce: **green nearly every day; red days extremely rare AND small.**

**Verdict up front: REFUTED on the pre-registered primary; no bracket or management geometry on these entries comes anywhere near the live profile.** Expectancy is NOT monotone in ex-ante R:R at the primary 4.5-pt buffer (the 1.5–2 bin is the *worst* bin, −2.85 pts/trade). The rr≥2 tail (n=314) is positive and beats all 5 placebo seeds — noted honestly below — but it sits behind a dose-response that dips below both placebo and zero on the way there, which is the signature of a selected tail, not a dose. The daily-profile comparison is not close in any configuration (best real green-day rate at positive EV ≈ 46–49% vs "green ~daily"), and the conservation matrix shows why it never can be: on 50/50 first-passage entries, green-day frequency is bought only with rare-but-LARGE red days. The management grid (36 cells + robustness) lands almost exactly on the theoretical noise prediction — ~50% small losses / ~20–40% scratches / few big wins, EV ≈ 0 minus friction — and no cell materially beats its placebo twin.

Dev window only (2021-01-18 → 2024-12-31); 2025+ locked set untouched. Friction throughout: 0.5 pt adverse slip on stop/lock/flat exits (targets = exact limits) + 0.2 pt ($4) commission per trade.

---

## Method

### Task 1 — per-signal structural brackets (causal)

- `10-rr-levels.py` replays the engine's exact 15m bar construction (1m continuous → 15m, loader's flat-bar filter, floor-to-15-min buckets) and replicates the strategy's swing machinery (pivotN=2 fractals confirmed with 2-bar lag, maxSwings=300) chronologically. At each signal's emission close it prices:
  - **stop_level** = sweep extreme ± buffer; buffers {4.0, **4.5**, 5.0} pts (primary 4.5).
  - **target_level** = the `tpMode:'external'` selection from `shared/strategies/jv-ict.js:936-957`: nearest swing (or PDH/PDL) beyond the leg terminus on the profit side, within 2× leg height; fallback = leg terminus ± 1 tick. Tagged `external` (3,501 signals = 97.3%) vs `legLow` (99).
  - **rr** = target distance / stop distance from the resting limit.
- **Replication validation (hard asserts over all 3,600 signals): 3,600/3,600** — emission-bar close == `mss_close`, extreme-bar body == `fib100`, terminus-bar wick == `leg_terminus`, and the causal swing (O) present in the replicated swing list at emission. Zero misses.
- **Placebos** (5 seeded universes, paired 1:1 to real signals via `placebo_catalog_idx`, verified index-aligned): stop = synthetic `jv_cancel.extreme` ± buffer (synthetic extreme sits at the same distance as the real pair's), target = the real pair's external-target *distance* applied to the placebo entry. So the rr filter induces the identical geometry selection in both populations — mandatory, because "high rr" mechanically means tight-stop-far-target.

### Task 2/4 — bracket-mode 1s simulation

`10-rr-bracket-1s-sim.js` (88s streaming pass over the 1s continuous file): identical order lifecycle to the 08 study (placement at 15m close, exact-limit fill on first touching 1s bar, engine-honest pre-fill cancels, forced flat 16:00 ET) — fill set cross-validated **identical** to 08 (1,390 real fills, 0 fill-ts mismatches; 6,700 placebo fills). After fill, 44 exit schemes run independently per trade on each 1s bar: 3 structural brackets (buffers), 36 management-grid cells, 4 lockOffset-0 robustness cells, 1 structural-management variant. Within-bar priority (conservative): current stop → target → lock trigger → same-bar recheck of the ratcheted stop. Bracket outcomes are consistent with 08 excursion bounds (no `T` exit without MFE ≥ target dist; no `S` without MAE ≥ stop dist).

Analysis: `10b-rr-analysis.py` → `10-analysis-out.md` (full tables); per-signal deliverable `rr-brackets.csv`.

---

## 1. Ex-ante R:R distribution (real universe, n=3,600)

| buffer | p10 | p25 | median | p75 | p90 | ≥1.5 | ≥2 |
|---|---|---|---|---|---|---|---|
| 4.0 | 0.80 | 1.15 | 1.54 | 1.97 | 2.49 | 53.1% | 23.9% |
| **4.5** | 0.78 | 1.13 | **1.51** | 1.93 | 2.43 | 50.7% | 22.0% |
| 5.0 | 0.76 | 1.10 | 1.48 | 1.89 | 2.39 | 48.1% | 20.2% |

By side (buffer 4.5): sells are structurally richer (median 1.61, 26.4% ≥2) than buys (1.41, 17.5%) — shorts get external targets slightly farther relative to stops. By year: 2022 richest (median 1.64, 30.2% ≥2), other years ~1.46–1.50. So an "only take rr≥2" author would still have found ~200 qualifying signals/year — frequency is not the obstacle.

## 2. PRIMARY — dose-response of expectancy on ex-ante rr (buffer 4.5) — **FAIL**

Real universe, structural bracket outcomes, net pts/trade:

| rr bin | n | WR% | EV net | PF | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|---|---|---|---|
| <1 | 282 | 62.4 | +0.47 | 1.05 | +0.5 (85) | +4.1 (45) | −0.1 (79) | −1.2 (73) |
| 1–1.5 | 428 | 42.5 | −0.66 | 0.95 | −0.8 (111) | +9.1 (83) | −0.9 (126) | −7.8 (108) |
| 1.5–2 | 366 | 34.2 | **−2.85** | 0.84 | −0.4 (79) | −5.4 (101) | −0.3 (98) | −5.0 (88) |
| 2–3 | 246 | 32.5 | +1.01 | 1.06 | −0.8 (61) | −1.7 (78) | +3.1 (56) | +5.1 (51) |
| >3 | 68 | 29.4 | +7.66 | 1.51 | +9.4 (17) | −0.1 (27) | +17.1 (9) | +14.0 (15) |

Placebo pooled (same filter, same bracket construction, n=6,700):

| rr bin | n | EV net | PF |
|---|---|---|---|
| <1 | 1,408 | +0.36 | 1.04 |
| 1–1.5 | 2,131 | −0.22 | 0.98 |
| 1.5–2 | 1,701 | −0.87 | 0.94 |
| 2–3 | 1,141 | −2.03 | 0.88 |
| >3 | 319 | −3.72 | 0.79 |

**Pre-registered PASS required all three of:** (i) monotone increasing expectancy in rr — **FAIL**: the curve is V-shaped (+0.47 → −0.66 → −2.85 → +1.01 → +7.66), and the 1.5–2 bin is not just non-monotone, it's the worst cell in the table and *loses to its placebo counterpart* (−2.85 vs −0.87). (ii) rr≥2 positive in ≥3/4 years incl. 2024 — met (+1.42 / −1.30 / +5.02 / +7.08). (iii) beats same-selection placebo — met (rr≥2: real EV +2.45, PF 1.14 vs placebo seed span −4.96..+0.15, 0/5 seeds beat real; rr≥3: +7.66 vs −9.69..+5.67, 0/5).

Per the pre-registration, **failure of monotonicity at the 4.5 buffer refutes the hypothesis regardless of sub-cells.** Robustness buffers agree (4.0: +0.65/−0.44/−3.00/+0.81/+7.29; 5.0: +0.51/−0.91/−3.55/+2.40/+5.55 — same V shape both).

**Honest note on the rr≥2 tail** (do not oversell, do not hide): real rr≥2 (n=314, ~80 trades/yr) nets +2.45 pts/trade, PF 1.14, positive 3/4 years incl. 2024, and beats all 5 placebo seeds; placebo shows the opposite (monotone decreasing) dose curve, so the divergence at the top is not pure geometry artifact. But: (a) the path there is non-causal as a "dose" — a real R:R edge should not make the adjacent 1.5–2 bin the worst-performing, placebo-losing cell in the table; (b) n=68 carries a third of the tail's EV; (c) this is exactly the selected-max signature that Round 3's placebo test killed (long+imb, PF 2.21, also beat pooled placebo and also had a broke adjacent cell). Treat as the program's standard drift/selection artifact unless the locked set is someday spent on it — which this study does not recommend.

## 3. JV-profile comparison — daily P&L, one-at-a-time gating (structural b45)

| portfolio | universe | trades | traded days | green% | med green | med red | worst red | max consec red |
|---|---|---|---|---|---|---|---|---|
| rr≥1.5 | real | 652 | 470 | **38.9** | +41.8 | −26.9 | −135.9 | 10 |
| rr≥1.5 | placebo mean | — | — | 36.5 | +40.1 | −25.8 | −104.3 | 12.8 |
| rr≥2 | real | 307 | 259 | **34.4** | +58.8 | −23.8 | −135.9 | 11 |
| rr≥2 | placebo mean | — | — | 29.3 | +49.8 | −23.9 | −75.5 | 13.2 |
| all fills | real | 1,297 | 727 | 46.2 | +31.1 | −30.2 | −142.6 | 9 |
| all fills | placebo mean | — | — | 44.4 | +30.7 | −27.0 | −115.0 | 9.2 |

Observed live profile: green ~daily, red extremely rare and small. The rr-selected portfolios are **red on 6 of 10 traded days**, median red ≈ half a grand per contract, worst day −$2,700, and up to 11 consecutive red days. Selecting for high R:R *lowers* the green-day rate (34–39% vs 46%) — mechanically, because high-rr trades are low-WR trades. **No R:R admission filter can produce the observed profile from these entries.**

## 4. Conservation-law bracket matrix (all 1,390 fills; from 08 first-crossing data)

Per cell: WR% / EV net / green-day% (gated) / median red day:

| tgt\stop | 5 | 10 | 15 | 20 | 30 | 50 |
|---|---|---|---|---|---|---|
| **+5** | 53%/−0.14/45%/−6 | 69%/−0.00/57%/−11 | 77%/+0.17/66%/−11 | 82%/+0.20/71%/−16 | 87%/+0.22/78%/−26 | 91%/+0.20/85%/−46 |
| **+10** | 33%/−0.64/40%/−6 | 49%/−0.63/42%/−11 | 60%/−0.41/53%/−16 | 67%/−0.21/56%/−21 | 74%/−0.35/63%/−21 | 83%/+0.17/74%/−41 |
| **+15** | 23%/−0.99/35%/−6 | 38%/−0.90/47%/−11 | 49%/−0.79/41%/−16 | 56%/−0.51/50%/−21 | 66%/−0.44/56%/−31 | 77%/+0.30/66%/−36 |
| **+20** | 19%/−0.96/31%/−6 | 32%/−0.85/41%/−11 | 42%/−0.68/52%/−16 | 50%/−0.38/42%/−21 | 59%/−0.43/53%/−31 | 70%/+0.15/61%/−51 |
| **+30** | 14%/−0.70/25%/−6 | 25%/−0.36/38%/−11 | 34%/+0.10/43%/−16 | 40%/+0.05/50%/−21 | 49%/+0.14/45%/−31 | 61%/+0.98/57%/−51 |
| **+50** | 9%/−0.55/18%/−6 | 16%/−0.56/28%/−11 | 23%/−0.09/38%/−16 | 27%/−0.09/42%/−21 | 36%/+0.18/47%/−31 | 48%/+1.67/46%/−51 |

**No cell satisfies (EV ≥ 0) AND (green-day% ≥ 65) AND (median red small relative to median green).** The tradeoff is a conservation law on these 50/50 entries: the only way to be green 78–85% of days (tiny target, huge stop) is to eat median red days of −26 to −46 pts against +5-pt greens, at EV ≈ +0.2 (within drift noise; the same cells in the placebo book price similarly). The best-EV cells (+50/50: +1.67; +30/50: +0.98) are the NQ-drift corner — green only 46–57% of days. "Green ~daily AND red rare-and-small AND EV > 0" is not a reachable point of this surface.

## 5. Management grid (Task 4) — tight stop × far target × profit-lock

36 cells: stop {20,25,30} × target {50,100,150,200} × lockTrigger {20,25,30}, lockOffset +2; exits: T=target, L=locked-stop scratch (~+1.3 net), S=full stop, F=16:00 flat. Full table in `10-analysis-out.md`. Summary:

- **Theoretical noise prediction confirmed almost exactly**: e.g. cell 25/100/25 → 10% T / 37% L / 48% S / 5% F, EV −0.87 (placebo −0.42). Across all 36 real cells EV spans −1.72 to **+0.50** (mean ≈ −0.55); 30/36 cells are negative; the placebo pooled span is −0.62..+0.55 — the two populations trace the same surface.
- **Best real cell** g25/150/30: EV +0.50, PF 1.04 — but per-year +2.7/+4.9/**−2.0/−3.3** (fails 2023 AND 2024, i.e. dies in the two most recent years) and does not beat its own placebo twin meaningfully (+0.33). No cell is positive in 2024 and 2023 simultaneously; nothing survives the pre-registered "positive expectancy that survives 2024 and beats placebo" bar. lockOffset-0 robustness and the structural variant (`ms`: EV −1.23, placebo −0.35) change nothing.
- **Daily profile with the lock** (the author's signature move): green-day rates 42.8–49.1%, median red −21 to −31, worst red −102 to −133, ≥9 consecutive red days — vs placebo means within ~1–2 green points of real everywhere. The profit-lock converts losers into scratches (L% 17–51%) but *cannot* raise the green-day rate above ~50%, because on 50/50 entries half the fills go straight against you before +20.

**(a) No cell produces positive expectancy that survives 2024 and beats placebo. (b) No cell approaches "green ~daily, red rare and small" — nothing to flag.**

## 6. Worked example (high-rr structural trade, levels shown)

Signal 2023-06-27 13:45:00Z (09:45 ET), **BUY** limit **17286.00** (70.5% retracement). Metadata: sweep extreme 17264.00 → stop 17264 − 4.5 = **17259.50** (risk 26.5 pts). Leg terminus 17303.25; external target = nearest prior swing high beyond the terminus within 2× leg height = **17377.50** (reward 91.5 pts). **Ex-ante rr = 3.45** — exactly the trade the author's checklist would have taken. Filled 14:10:29Z; ran to the target without touching the stop: exit +91.50 gross / +91.30 net. (A winner — and the rr>3 bin it lives in is 29% WR; the median rr>3 trade stops out for −31.)

## Verdict

1. **Structural brackets + ex-ante R:R selection do not rescue the universe.** The primary dose-response test fails at the pre-registered 4.5-pt buffer (V-shaped, not monotone; the 1.5–2 bin loses to placebo). The rr≥2 tail's placebo-beating positivity is the same selected-tail signature this program has already killed twice, and is explicitly not a reopening.
2. **No bracket geometry on these entries can reproduce the observed live profile.** The conservation matrix is closed: green-day frequency, red-day size, and EV cannot all be favorable at once on entries whose first-passage odds are 50/50 at every scale. The profit-lock management style — simulated exactly as described — lands on the noise prediction to within ~0.5 pt/trade.
3. **Where the edge lived, if it lived:** not in the mechanized setup + stop/target/R:R/lock arithmetic. After this study, the entry universe, the selection layer (08: oracle ≤ placebo), the confluence layer (09), and now the risk/management layer have all been independently closed. What remains is what 07-PROGRAM-SUMMARY already ranked: information *outside* the book's mechanical content (which setups he actually took, news/HTF context) — or the profile itself being survivor-memory. A "green ~daily, red rare and small" P&L on a strategy whose honest bracket WR at his own geometry is ~30% would require a selection function better than the perfect-hindsight oracle already shown to be placebo-equivalent.

**Files:** `10-rr-levels.py` (Task-1 replication, validated 3,600/3,600), `rr-levels.json`, `10-rr-bracket-1s-sim.js` (bracket/management 1s sim, fill-set identical to 08), `bracket-results.csv` (21,040 orders × 44 schemes), `10b-rr-analysis.py`, `10-analysis-out.md` (full tables), `rr-brackets.csv` (per-signal levels + rr + bracket outcomes, 3,600 rows).
