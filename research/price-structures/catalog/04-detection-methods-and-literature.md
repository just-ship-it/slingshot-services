# Detection Methods & Literature — Algorithms for a Streaming Multi-Timeframe Pattern Engine

**Scope.** The algorithmic/literature side of building a causal, streaming chart-pattern and candle-formation detector on OHLCV only (NQ/ES; 1s→1m base, aggregated to 1m/3m/5m/15m/1h/D). Companion to `01-chart-patterns.md` (what the patterns are), `05-repo-audit.md` (what we already have) and `schema/pattern-event.schema.json` (what an emitted event looks like). Every §7 recommendation is tied to §1–6 evidence.

**Reading order if short on time:** §0 (recommendation) → §1.9 (pivot method comparison table) → §5.6 (evaluation pitfalls checklist) → §7 (state machine + logging design).

Date compiled: 2026-08-18. Publisher paywalls (ScienceDirect/Wiley/OUP) blocked full-text for several papers; where I only had abstracts + secondary sources I say so.

---

## §0. Recommendation summary (details in §7)

1. **Pivot substrate = confirmed-lag extrema, two generators run in parallel per timeframe:** (a) *rolling-window / fractal* pivots with `order = k` (a bar is a pivot high iff it is the max of `[i-k, i+k]`; confirmed at `i+k`); (b) *directional-change zigzag* with an ATR-scaled reversal threshold (confirmed the bar the reversal threshold is crossed). Both produce `{extremeIdx, extremeTs, price, kind, confirmedAt}` and alternate H/L. Neurotrader's `rw_extremes` and `directional_change` are the cleanest reference implementations of exactly this contract ([rolling_window.py](https://github.com/neurotrader888/TechnicalAnalysisAutomation/blob/main/rolling_window.py), [directional_change.py](https://github.com/neurotrader888/TechnicalAnalysisAutomation/blob/main/directional_change.py)). Do NOT use kernel-regression / Savitzky-Golay / wavelet smoothing or global RDP/PIP as the *live* substrate — they are non-causal or repaint (§1.9). PIP is fine as a *descriptor* of a closed window (§2.4).
2. **Pattern representation = predicate over the last 5–7 confirmed pivots + OHLC between them, with ATR-normalised tolerances**, in the style of Lo–Mamaysky–Wang (LMW) definitions (§2.1) generalised the way Wan & Si (2017) and Trendoscope do (§2.2, §3.7). Trendlines are "outer" lines through pivots (Neurotrader's constrained fit, §4.1) scored by touch count and containment (§4.4).
3. **Lifecycle = explicit state machine `candidate → forming → confirmed → resolved | invalidated`**, where *forming* is emitted the bar the (n−1)th pivot confirms, *confirmed* the bar the breakout closes, and every state transition is stamped with the bar `ts` on which the engine could actually know it (§7.2). Emerging states are logged and evaluated, not just completed ones (§5.5).
4. **Multi-timeframe = one 1m base stream → per-TF session-anchored aggregators → one detector instance per TF**, with pattern events carrying `tf` and a `parentCandidates[]` link computed by time-interval containment against higher-TF forming patterns (§6.3).
5. **Evaluation = conditional-vs-unconditional forward-return distributions at fixed horizons (KS / decile GoF à la LMW), side-matched random-pivot placebo controls, block/stationary bootstrap for p-values, and a multiple-comparison correction (Reality Check / SPA or DSR) across the pattern×param×TF grid.** Base-rate of breakout direction at the *forming* state is the primary quantity for the downstream probability model (§5).

The five most important literature findings on predictive value are in §5.7.

---

## §1. Swing-point / pivot extraction

### 1.1 Rolling-window (Williams-fractal generalisation)

A bar `i` is a pivot high iff `high[i] > high[j]` for all `j ∈ [i-k, i+k], j≠i` (ties: choose ≥ on the left, > on the right to break symmetry). Williams fractals are the `k=2` case (5-bar). Pine's `ta.pivothigh(left, right)` allows asymmetric `left≠right`; the confirmation lag is `right`. TradingView's built-in Chart Patterns use 5/5 pivots ("no higher high 5 bars left or right") and scan the last 600 bars ([TradingView chart-patterns support page](https://www.tradingview.com/support/solutions/43000706927-all-chart-patterns/)); `stock-pattern` uses 6/6 by default ([wiki](https://github.com/BennyThadikaran/stock-pattern/wiki/Pattern-Algorithms)); Neurotrader's `rw_extremes(data, order)` uses `order` on both sides and returns `[confirm_i, extreme_i, price]` with `confirm_i = extreme_i + order` ([rolling_window.py](https://github.com/neurotrader888/TechnicalAnalysisAutomation/blob/main/rolling_window.py)).

```
// streaming, O(k) per bar (or O(1) amortised with a monotonic deque)
onBarClose(i):
  c = i - k                      // candidate that just became checkable
  if c < k: return
  if high[c] == max(high[c-k..c+k]) and unique: emit PivotH{extremeIdx:c, confirmedAt:i, price:high[c]}
  if low[c]  == min(low[c-k..c+k])  and unique: emit PivotL{extremeIdx:c, confirmedAt:i, price:low[c]}
```

Properties: fixed lag `k` bars (known in advance); zero repainting once emitted; parameter is in *bars* so it does not adapt to volatility; produces same-kind consecutive pivots (H,H) which must be post-processed into an alternating sequence (keep the more extreme; the discarded one is still a valid "minor" pivot for a finer level). LMW note that raw 3-bar extrema (`k=1`) yield "too many extrema and patterns that are not visually consistent" ([LMW 2000 §II.B](https://www.cis.upenn.edu/~mkearns/teaching/cis700/lo.pdf)).

### 1.2 Zigzag / directional-change (DC) with % / ATR / points threshold

State machine: while in an up-leg track `tmpMax`; when `close ≤ tmpMax·(1−σ)` (or `tmpMax − θ·ATR`, or `− points`) confirm `tmpMax` as a pivot high at the *current* bar and flip to a down-leg. Neurotrader's `directional_change(close, high, low, sigma)` returns tops/bottoms as `[conf_i, ext_i, price]` ([directional_change.py](https://github.com/neurotrader888/TechnicalAnalysisAutomation/blob/main/directional_change.py)); Guillaume et al.'s DC framework (Olsen group, 1997) is the academic origin, and Trendoscope's Pine `zigzag` library and TradingView's built-ins use "Deviation (ticks/%)" + "Depth (min bars between pivots)" ([TradingView zigzag lib](https://www.tradingview.com/script/bzIRuGXC-ZigZag/), [Trendoscope zigzag](https://www.tradingview.com/script/DnjLJ7fc-zigzag/)).

```
onBarClose(i):
  if upLeg:
    if high[i] > tmpMax: tmpMax=high[i]; tmpMaxI=i          // last leg keeps extending (this is the "repaint" people complain about)
    elif close[i] <= tmpMax - thresh(i):                     // thresh = pct*tmpMax | k*ATR | points
      emit PivotH{extremeIdx:tmpMaxI, confirmedAt:i}; upLeg=false; tmpMin=low[i]; tmpMinI=i
  else: mirror
```

Properties: lag is *variable* (0 bars in a fast reversal, many in a slow drift), so the pivot's `confirmedAt − extremeIdx` must be stored; the *unconfirmed* last leg moves every bar — this is the classic zigzag "repainting"; harmless if you (a) never emit the provisional pivot as an event and (b) let pattern candidates reference it only in *candidate* state. Threshold in ATR units is the right choice for a multi-TF engine (§4.5) — percent thresholds behave differently on 1m vs D and points thresholds don't survive regime changes. Multi-threshold zigzags (Trendoscope "multi level recursive zigzag") give a natural pivot hierarchy for nesting (§6).

### 1.3 Perceptually Important Points (PIP)

Chung, Fu, Luk & Ng (2001) "Flexible time series pattern matching based on perceptually important points" ([IJCAI-01 workshop; ResearchGate](https://www.researchgate.net/publication/288658678_Flexible_time_series_pattern_matching_based_on_perceptually_important_points)); Fu, Chung, Luk & Ng (2007) template- vs rule-based ([EAAI 20(3)](https://www.sciencedirect.com/science/article/abs/pii/S0952197606001278)); Fu et al. (2008) "Representing financial time series based on data point importance" ([EAAI 21(2)](https://www.sciencedirect.com/science/article/abs/pii/S0952197607000577)) introduces the PIP specialised binary tree (SB-tree) that supports **incremental update** and multi-resolution retrieval.

Algorithm (top-down): PIPs start as the first and last point of a window; repeatedly add the point with maximum distance to the segment joining its adjacent PIPs until `n_pips` are chosen. Three distances: **Euclidean (PIP-ED)** = `d(p, pipL) + d(p, pipR)`; **perpendicular (PIP-PD)** = orthogonal distance to the chord; **vertical (PIP-VD)** = `|chord(x_p) − y_p|`. Fu et al. found VD/PD give lower residual error and are more "chart-like" than ED; VD is cheapest and what Neurotrader's `find_pips` defaults to ([perceptually_important.py](https://github.com/neurotrader888/TechnicalAnalysisAutomation/blob/main/perceptually_important.py); complexity O(n_pips²·n) naive, O(n log n) with the SB-tree/heap).

```
find_pips(y, n_pips, dist='vd'):
  pips = [0, len(y)-1]
  while len(pips) < n_pips:
    best=(−1, −1)
    for each adjacent (l, r) in pips:
      for i in (l, r): d = dist(i, l, r); if d > best.d: best=(d, i)
    insert best.i into pips (sorted)
  return pips
```

Properties: **global over the window and non-causal** — adding a bar can re-select every PIP (the ranking of "importance" changes), so PIP is a *descriptor of a closed window*, not a streaming pivot source. It is exactly right for (a) normalising a completed pattern into a fixed-length shape vector for template/DTW/clustering (§2.3–2.5) and (b) Neurotrader's flag detector, where the *pole tip* is the anchor and PIPs describe the flag body up to the current bar (§3.5). The 2005 Fu et al. paper "Preventing meaningless stock time series pattern discovery by changing PIP detection" ([Springer](https://link.springer.com/chapter/10.1007/11539506_146)) is the warning that PIP-based motif mining can find "patterns" in noise unless the PIP count is tied to the window's actual complexity.

### 1.4 Ramer–Douglas–Peucker (RDP) and other line simplifiers

RDP: keep endpoints; find the point with max perpendicular distance to the chord; if `> ε` split recursively. Equivalent in spirit to PIP-PD but with a *distance threshold* rather than a *point count*; also global/non-causal on a fixed window. Useful only for offline shape encoding; ε must be ATR-scaled ([RDP docs](https://rdp.readthedocs.io/); comparison of simplifiers for TS interpretability, [arXiv 2505.08846](https://arxiv.org/pdf/2505.08846)). Visvalingam–Whyatt (area-based) is an alternative with the same caveats.

### 1.5 Kernel-regression extrema — Lo, Mamaysky & Wang (2000)

LMW ([J. Finance 55(4); PDF](https://www.cis.upenn.edu/~mkearns/teaching/cis700/lo.pdf), [NBER w7613](https://www.nber.org/papers/w7613)): fit a Nadaraya–Watson Gaussian-kernel regression `m̂_h(t)` to each rolling window of `l+d = 38` daily closes (`l=35`, `d=3`), pick bandwidth `h = 0.3·h*` where `h*` minimises the leave-one-out cross-validation function (CV bandwidth "too smooth" per the technical analysts they polled — "admittedly ad hoc"), locate sign changes of `m̂'_h(t)`, then snap each smoothed extremum to the raw-price extremum in `[t−1, t+1]`. Extrema alternate max/min by construction. The lag `d=3` exists precisely so that the pattern completed by the extremum at `t+l−1` is only *detected* at `t+l+d−1` and conditional returns start after that — their explicit anti-look-ahead device.

Properties for us: excellent visual fidelity, but the smoother is two-sided (uses future bars within the window) → an extremum near the right edge is unstable until `≈h` bars later; bandwidth in bars, not volatility; O(window²) per bar unless incremental. Verdict: reference method for offline labelling / sanity comparison, not the live substrate. Local-polynomial regression is LMW's own suggested improvement (boundary bias).

### 1.6 Turning-point rules with confirmation lag (and lookahead)

All the causal methods above share the contract: a pivot has an **extreme time** and a **confirmation time**, and nothing downstream may use the pivot before `confirmedAt`. Pine's `ta.pivothigh` is the canonical trap: it returns the value on the bar `rightbars` after the pivot, but a naive `plot(..., offset=-rightbars)` paints it into the past ([Pine docs on repainting](https://www.tradingview.com/pine-script-docs/concepts/repainting/), [pivothigh reference](https://pinewizards.com/technical-analysis-functions/ta-pivothigh-in-pine-script/)). The equivalent research bug is any script that computes pivots on the full array with `scipy.signal.argrelextrema(order=k)` and then treats the pivot as known at its own index (this is what `stock-pattern`'s `getMaxMin` does, and it's fine for an EOD *screener*, wrong for a *backtest*). Rule: **every pivot record carries `confirmedAt`; every pattern state carries `stateTs ≥ max(confirmedAt of pivots used)`.**

### 1.7 Savitzky–Golay, wavelets, numerical differentiation

SG (local polynomial least squares) and DWT denoising preserve peaks better than an SMA but are still symmetric filters → same two-sided problem as kernel regression; one-sided SG variants exist but then behave like a lagging EMA. `trendln`'s default extrema method `METHOD_NUMDIFF` uses `findiff` central-difference stencils (accuracy 4 = 5-point) on the raw series — again symmetric ([trendln README](https://github.com/GregoryMorse/trendln/blob/master/README.md)). Peak-detection comparisons ([UMD smoothing comparison](https://terpconnect.umd.edu/~toh/spectrum/SmoothingComparison.html)) confirm SG "retains turning points" but at the cost of the same edge lag. Not recommended for the live substrate.

### 1.8 Repainting taxonomy (what "repaint" means for each method)

| Method | Extreme moves after first sighted? | Confirmation lag | Streaming cost |
|---|---|---|---|
| Rolling window k | No (once confirmed) | fixed `k` bars | O(1)–O(k) |
| DC / zigzag | Provisional last leg moves; confirmed pivots frozen | variable (0…∞) | O(1) |
| PIP / RDP on window | Yes — whole set can re-rank | n/a (window closes) | O(n log n) per window |
| Kernel reg / SG / wavelet | Yes near right edge (~bandwidth) | ≈ bandwidth | O(w²) or O(w) incremental |
| LMW with lag d | No (they *wait* d bars) | `d` + smoother edge | O(w²) per window |

### 1.9 Recommendation for the substrate

Use **rolling-window (k) AND ATR-zigzag in parallel per TF**, both emitting the same `Pivot` record; the k-window generator gives a dense, evenly-lagged pivot stream for candle-scale structures (`k=2..3` on 1m/3m, `k=3..5` on 15m+), the ATR-zigzag gives the sparse "significant swing" stream for classical patterns (θ ≈ 1.0–2.0 ATR on the detection TF; expose as `pivotStrength`). Enforce alternation and de-duplication in one `PivotTrack` per (TF, generator). Keep PIP for shape descriptors only. Never use two-sided smoothers live.

---

## §2. Pattern-matching approaches

### 2.1 Rule-based on extrema — LMW's exact definitions

Given alternating extrema `E1..E5` (max/min alternate), LMW define ([§II.A](https://www.cis.upenn.edu/~mkearns/teaching/cis700/lo.pdf)):

| Pattern | E1 | Shape constraints | Tolerance |
|---|---|---|---|
| HS | max | `E3 > E1, E3 > E5` | `E1,E5` within 1.5% of their mean; `E2,E4` within 1.5% of their mean |
| IHS | min | `E3 < E1, E3 < E5` | same |
| BTOP | max | `E1 < E3 < E5` and `E2 > E4` | — |
| BBOT | min | `E1 > E3 > E5` and `E2 < E4` | — |
| TTOP | max | `E1 > E3 > E5` and `E2 < E4` | — |
| TBOT | min | `E1 < E3 < E5` and `E2 > E4` | — |
| RTOP | max | tops within 0.75% of mean; bottoms within 0.75% of mean; lowest top > highest bottom | 0.75% |
| RBOT | min | same | 0.75% |
| DTOP | max | `Ea = highest later max`; `E1, Ea` within 1.5%; `t_a − t_1 > 22` days | 1.5%, ≥22 bars |
| DBOT | min | mirror with lowest later min | same |

Note what's *absent*: no neckline-break requirement, no prior-trend requirement, no volume, no symmetry constraint. LMW count a pattern "completed" at E5 (or Ea) and measure the 1-day return starting `d=3` days later. For our engine these are the *forming-state* predicates; breakout/neckline logic is layered on top (§7.2). Tolerances should be re-expressed as `max(a·ATR, b·price)` for intraday futures (1.5% of NQ ≈ 350 pts is meaningless on 5m; see `01-chart-patterns.md` §A for defaults).

Related rule-based work: Osler & Chang 1995 (H&S in FX from published manuals; [NY Fed SR 4](https://www.newyorkfed.org/research/staff_reports/sr4.html)); Savin, Weller & Zvingelis 2007 (LMW algorithm + analyst filters, 63-day windows; [J. Fin. Econometrics 5(2)](https://academic.oup.com/jfec/article-abstract/5/2/243/785044)); Zapranis & Tsinaslanidis 2012 (rolling-window peaks, H&S / saucers / horizontal S-R rules; [Applied Fin. Econ.](https://www.tandfonline.com/doi/abs/10.1080/09603107.2012.663469)) and their book *Technical Analysis for Algorithmic Pattern Recognition* (Springer 2016; [TOC](http://link.springer.com/content/pdf/10.1007%2F978-3-319-23636-0.pdf)) which is the most complete rule catalogue in the academic literature (RW and PIP preprocessing → per-pattern rules → DTW).

### 2.2 Formal constraint specification — Wan & Si (2017), Trendoscope, Bulkowski-style rules

Wan & Si, "A formal approach to chart patterns classification in financial time series" ([Inf. Sci. 411, 2017](https://www.sciencedirect.com/science/article/abs/pii/S002002551631636X)) compile **53 chart patterns as first-order-logic constraints over the relative positions (price and time) of PIP-derived points**, then classify with the rules directly, testing on NYSE Composite, HSI and AMZN against Template-Based (Leigh grid), Euclidean-distance and DTW matchers; a 2019 companion does the same for candlesticks ([ASOC 2019](https://dl.acm.org/doi/10.1016/j.asoc.2019.105700)) and a 2021 paper extracts features from the constraints for ML ([KAIS 2021](https://link.springer.com/article/10.1007/s10115-021-01569-1)). Their thesis, which I endorse: *a pattern is a small conjunction of inequalities on `(t_i, p_i)`; templates and DTW are lossy proxies for that.* (Abstract-level only — paywalled.)

Trendoscope's open-source Auto Chart Patterns encodes the same idea for the trendline-pair family: examine the last 5 or 6 zigzag pivots; require an upper line touching all pivot highs and a lower line touching all pivot lows (within an *error threshold*), no intersection inside the span, no candle outside the lines; classify by slope pair using a *flat threshold* into converging/diverging/parallel × rising/falling/flat → wedge / triangle / channel ([Trendoscope Auto Chart Patterns](https://www.tradingview.com/script/WZ8B1FIW-Auto-Chart-Patterns-Trendoscope/), [chartpatterns lib](https://www.tradingview.com/script/OuVJr45r-chartpatterns/)). Repainting is an *option* ("only updates a pattern if the new coordinates yield a more geometrically accurate representation") — a good model for our `candidate` refinement rule.

`stock-pattern` (BennyThadikaran, MIT-ish, unspecified in wiki) uses "two points are on a straight line if |Δ| ≤ average candle range" as its universal tolerance and simple ordinal rules (H&S: `C > A,E`; `B,D < A,E`; `|B−D| ≤ avgRange`; close hasn't breached neckline; DT: `|A−C| ≤ avgRange`, `B` below both, close not breached, `vol(C) < vol(A)`; triangles by ordering of A,C,E vs B,D,F) ([wiki](https://github.com/BennyThadikaran/stock-pattern/wiki/Pattern-Algorithms)). This "avg candle range" ≈ ATR tolerance is the intraday-friendly convention.

Bulkowski's identification guidelines (in `01-chart-patterns.md`) are the same genre with looser, hand-tuned thresholds and *require* the breakout to call a pattern complete.

### 2.3 Template matching — Leigh et al. bull flag grid

Leigh, Modani, Purvis & Roberts (2002) "Stock market trading rule discovery using technical charting heuristics" ([ESWA 23(2)](https://www.academia.edu/104495621/Stock_market_trading_rule_discovery_using_technical_charting_heuristics)), Leigh, Paz & Purvis (2002), Leigh, Purvis & Ragusa (2002), and Leigh, Frohlich, Hornik, Purvis & Roberts (2008) "Trading rule discovery in the US stock market" ([ESWA 2008](https://www.sciencedirect.com/science/article/abs/pii/S0957417408004314)): a **10×10 weight grid** (values −2.5…+1.0) encodes the bull-flag silhouette; a 60-day (later 120-day) price window is rescaled so max→top row, min→bottom row, columns = 6-day (12-day) time buckets, each cell = fraction of the window's closes falling in it; **fit = Σ cell·weight**; buy when fit ≥ threshold, hold 20 (later 40–100) days; NYSE Composite 1981–1996 (later 1967–2003), with a separate volume template in the 2002 paper. Results: statistically significant excess returns over buy-and-hold in-sample and in holdout, though the excess is small and untraded-cost-adjusted; the 2008 paper reports both bull and bear flag templates significant on the extended sample ([Alpha Interface review](https://www.alphainterface.com/2013/04/18/do-chart-pattern-recognition-algorithms-yield-profits/)). Wang & Chan (2007) applied the same template idea to rounding-bottom/saucer patterns on tech stocks (>20% annualised after costs, tiny sample) ([ESWA 33(2)](https://www.sciencedirect.com/science/article/abs/pii/S0957417406001448)); Cervelló-Royo, Guijarro & Michniuk (2015) and Arévalo, García, Guijarro & Peris (2017) ported the grid to **15-minute DJIA futures 2000–2013 (91,309 bars)** with a *0/negative-only* weight matrix (fit ∈ [−?,5], 5 = perfect), range filter ≥100 pts, EMA filter, ATR-relative SL/TP re-optimised quarterly, and White's Reality Check for data snooping; best fit=+4 → 0.25%/trade, ≈300–1,750 trades, "significantly outperform buy-and-hold" ([Arévalo et al. 2017 preprint](https://riunet.upv.es/server/api/core/bitstreams/22139367-4e73-4c5d-a708-1930685dd8a5/content); [Lobão et al. 2024 Chinese replication](https://onlinelibrary.wiley.com/doi/10.1002/ise3.62)). Chen & Chen (2016) combined PIP bull-flag matching with a "floating-weighted" template on TAIEX/NASDAQ ([Inf. Sci. 346–347](https://sciencedirect.com/science/article/pii/S0020025516300159)). `mlfinlab` ships this as "Matrix Flag" labels.

Assessment: templates are trivially streaming (a fixed-length window, O(100) per bar), inherently ATR/scale-free (window is min-max normalised), and give a *graded* score rather than a boolean — attractive for the probability model. Weaknesses: the grid weights are arbitrary/opaque (Zapranis & Tsinaslanidis critique cited in Arévalo), the window length is fixed (no variable-duration patterns), and min-max normalisation is fragile to one spike. Good as a *secondary feature* on flag/pennant candidates, not as the primary detector.

### 2.4 Shape-distance: Euclidean on PIP vectors, DTW, subsequence DTW

Fu et al. 2007 compare template (Euclidean on n-PIP vectors) vs rule-based on PIPs; rule-based gives more control, template more flexibility. Tsinaslanidis & Kugiumtzis (2014) "A prediction scheme using PIPs and DTW" ([ESWA 41(15)](https://www.sciencedirect.com/science/article/abs/pii/S0957417414002516)): PIP-segment the series into subsequences, DTW-match against history, forecast; results — captures deterministic structure in *simulated* series, **confirms EMH on equity indices** (no forecastability), and beats baselines only sometimes on FX. Tsinaslanidis (2018) "Subsequence DTW for charting: bullish and bearish class predictions for NYSE stocks" ([ESWA 94](https://www.sciencedirect.com/science/article/abs/pii/S0957417417307376)): UCR-suite subsequence DTW + derivative DTW against a library of textbook pattern prototypes, labelled bullish/bearish; **bearish-class predictions are significant, bullish are not** (abstract-level). Zhang et al. (2010) "A real time hybrid pattern matching scheme for stock time series" ([ADC 2010](https://dl.acm.org/doi/pdf/10.5555/1862242.1862263)) — sliding-window PIP extraction + Spearman rank correlation + rules, explicitly designed for online use.

Assessment: DTW is O(n·m) per candidate (fine for n≈50), and it needs a *closed* window (subsequence DTW handles the "where does the pattern end" question but at O(N·m) per query). It is a reasonable *similarity feature* ("how H&S-like is this 5-pivot shape vs. the prototype") but a poor primary detector: it has no notion of the *levels* (neckline, boundaries) we must emit.

### 2.5 Symbolic (SAX) and grammar-based

SAX (Lin, Keogh et al. 2003/2007) → PAA + Gaussian breakpoints → words; CPC-SAX (Nikolaou 2024, [J. Fin. & Data Sci. 10](https://www.sciencedirect.com/science/article/pii/S2405918824000175), [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4513502)) does instance-based multilabel classification of chart patterns from SAX strings: accuracy >85% per stock but **average F1 < 45%** — i.e., the easy majority class dominates. Leitão et al. 2016 (PIP+SAX+GA on S&P daily) reported 76.7% vs 61.9% B&H over 2011–14 with ~17 trades/yr (Arévalo's review flags the sample size). SAX + Sequitur grammar induction is used for motif/anomaly discovery in other domains; the "grammar-based chart pattern" idea (a pattern = a production over up/down/flat leg symbols with attribute constraints) is essentially what a pivot-sequence predicate already is — I found no strong finance-specific grammar paper worth adopting. Verdict: symbolic encodings are a compact way to *index* pivot sequences (e.g. `"HLHLH"` + leg-size quantiles) for the probability model, not a detector.

### 2.6 Neural / image approaches

- Chen & Tsai (2020) "Encoding candlesticks as images for pattern classification using CNNs" ([Fin. Innov. 6:26](https://jfin-swufe.springeropen.com/articles/10.1186/s40854-020-00187-0), [arXiv 1901.05237](https://arxiv.org/pdf/1901.05237)): GASF-encode 10-bar OHLC windows → CNN classifies 8 candlestick patterns; ~90% accuracy on EUR/USD 1-min *labels generated by rules* — it learns the rule, says nothing about prediction.
- Liu & Si (2022) "1D CNNs for chart pattern classification" ([J. Supercomputing](https://link.springer.com/article/10.1007/s11227-022-04431-5)): 1D-CNN beats SVM/ELM/LSTM/rule/DTW at *recognising* synthetic patterns; again a labelling study.
- Guo, Liang & Li (2007) RPCL clustering of chart shapes; Kamijo & Tanigawa (1990) RNN for triangles; "Capitalico" (2016 slides) RNN chart matching ([slideshare](https://www.slideshare.net/HitoshiHarada/capitalico-chart-pattern-matching-in-financial-trading-using-rnn)) — engineering demos.
- Ahlawat (2016) "Empirical evaluation of price-based technical patterns using probabilistic neural networks" ([Algorithmic Finance 5(3-4)](https://journals.sagepub.com/doi/full/10.3233/AF-160059)): PNN identifies 14 patterns on DJIA-30 + 10 indices, 1990–2015, bull/bear split, 10–50-day holds, with costs → **"no pattern produces statistically and economically significant profits"** for the cross-section; a few are better than others.
- Neurotrader's `pip_pattern_miner.py` / `wf_pip_miner.py`: 24-bar windows → 5 PIPs → z-score → k-means (k∈[5,40] by silhouette) → cluster ranked by Martin ratio of forward returns over `hold_period=6` → long/short clusters; walk-forward retrain; permutation test by shuffling returns ([pip_pattern_miner.py](https://github.com/neurotrader888/TechnicalAnalysisAutomation/blob/main/pip_pattern_miner.py)). His videos report the miner's in-sample edge largely disappears walk-forward on BTC hourly (my summary of the series; the repo itself contains no results file — treat as anecdotal).

Verdict: ML classifiers reproduce rule labels; they do not manufacture predictive power. Use rules for detection; use ML (if at all) downstream on the emitted event features.

### 2.7 Comparison table

| Approach | Streaming? | Emits levels? | Variable duration? | Scale-free? | Graded score? | Evidence of predictive use |
|---|---|---|---|---|---|---|
| Rules on pivots (LMW/Wan-Si/Trendoscope) | yes | yes | yes | with ATR tol | can be (slack) | LMW, SWZ, O&C: distributional, weak $ |
| Template grid (Leigh) | yes | weak | no | yes | yes | Leigh 2002/08, Arévalo 2017: significant but small |
| PIP + Euclid/DTW | window-closed | no | DTW yes | yes | yes | T&K 2014 (EMH on indices), Tsin. 2018 (bearish only) |
| SAX / grammar | yes | no | limited | yes | no | CPC-SAX F1<45% |
| CNN/1D-CNN/RNN | yes | no | fixed window | yes | prob | label replication only |

---

## §3. Open-source implementations worth learning from

| Library | Lang / license | What it does | Quality notes |
|---|---|---|---|
| **TA-Lib** `CDL*` (61 patterns) | C, Python wrapper; BSD-2 ([ta-lib.org](https://ta-lib.org/)) | Candlestick rules parameterised by `TA_CandleSetting`: BodyLong = RealBody, avg 10, ×1.0; BodyVeryLong RealBody/10/3.0; BodyShort RealBody/10/1.0; BodyDoji HighLow/10/0.1; ShadowLong RealBody/0/1.0; ShadowVeryLong RealBody/0/2.0; ShadowShort Shadows/10/1.0; ShadowVeryShort HighLow/10/0.1; **Near HighLow/5/0.2; Far HighLow/5/0.6; Equal HighLow/5/0.05** (from `ta_global.c`) | Battle-tested; adaptive "average of last N" thresholds are exactly the ATR-relative idiom; outputs ±100/0. Known false-negative issues (e.g. shooting star [#647](https://github.com/TA-Lib/ta-lib-python/issues/647)). Every rule is O(1)/bar → streaming-friendly. |
| `pandas-ta` / `pandas-ta-classic` `cdl_pattern` | Py, MIT | Wraps TA-Lib CDL (classic fork claims native impls) | Convenience only. |
| `tulipy` / tulipindicators | C/Py, LGPL | Indicators only, no candle/chart patterns | n/a |
| `technicalindicators` (npm, anandanand84) | TS, MIT ([npm](https://www.npmjs.com/package/technicalindicators)) | Candlestick patterns (doji, hammer, engulfing, stars, tweezers…) with per-pattern threshold interfaces; also naive "HeadAndShoulders / DoubleTop / DoubleBottom" via a `PatternDetector` | Chart-pattern part is a toy (fixed-length window normalisation); candle part usable. |
| `zigzag` (PyPI, jbn) | Py, MIT-ish | `peak_valley_pivots(close, up_thresh, down_thresh)` percent zigzag, whole-array | Non-streaming; last pivot repaints. |
| **`neurotrader888/TechnicalAnalysisAutomation`** | Py, MIT ([repo](https://github.com/neurotrader888/TechnicalAnalysisAutomation)) | `rolling_window.py`, `directional_change.py`, `perceptually_important.py`, `trendline_automation.py`, `head_shoulders.py`, `flags_pennants.py`, `harmonic_patterns.py`, `pip_pattern_miner.py`, `wf_pip_miner.py` | Small, readable, **causal by construction** (every pivot is `[confirm_i, extreme_i, price]`; H&S and flags carry `break_i/conf_x`). Best single reference. See §3.5. |
| **`BennyThadikaran/stock-pattern`** | Py CLI ([repo](https://github.com/BennyThadikaran/stock-pattern), [algorithms wiki](https://github.com/BennyThadikaran/stock-pattern/wiki/Pattern-Algorithms)) | H&S, DT/DB, triangles, VCP, flags via 6/6 pivots + avg-candle-range tolerance | EOD screener; batch `argrelextrema`-style pivots (no confirmedAt) — good rules, wrong plumbing for backtests. |
| `keithorange/PatternPy` | Py, MIT ([repo](https://github.com/keithorange/PatternPy)) | Vectorised H&S, tops/bottoms, S/R | Thin; uses `argrelextrema`. |
| `zeta-zetra/chart_patterns` | Py ([repo](https://github.com/zeta-zetra/chart_patterns)) | Port of Neurotrader/Medium-article rules | Derivative. |
| **`GregoryMorse/trendln`** | Py, MIT ([README](https://github.com/GregoryMorse/trendln/blob/master/README.md)) | Extrema: NAIVE, NAIVECONSEC, NUMDIFF (findiff); lines: NCUBED (all 3-point combos), NSQUREDLOGN (sorted-slope 2-point), HOUGHPOINTS, HOUGHLINES / PROBHOUGH (skimage on a rasterised chart); scoring by slope std-error `errpct=0.005`, or "area on wrong side"; `window=125` segments before merge | Reference for Hough/exhaustive touch-line search; batch only. |
| **Trendoscope Pine libs** (`zigzag`, `chartpatterns`, Auto Chart Patterns; open-source on TV) | Pine v5/6 | Multi-level zigzag; 5/6-pivot trendline-pair patterns; error/flat thresholds; classification; optional repaint | Best *streaming design* reference in the TA world (§2.2). |
| **LuxAlgo Smart Money Concepts** ([TV script](https://www.tradingview.com/script/CnB3fSph-Smart-Money-Concepts-LuxAlgo/)) / Price Action Concepts (paid) | Pine, open-source (SMC) | Swing/internal structure via `ta.pivothigh(len)`, BOS/CHoCH on close beyond last swing, order blocks, EQH/EQL with threshold + bar confirmation, FVG with auto threshold, premium/discount | Confirmation-lag aware ("bars confirmation"); levels expire on break — matches our repo's `timeframe-analyzer.js` (see `05-repo-audit.md`). |
| TradingView built-in Chart Patterns (H&S, DT/DB, triangles, wedges, flags, pennants, rectangle) | closed | 5/5 pivots, last 600 bars, Depth/Deviation inputs, targets = pattern height projected from break ([support doc](https://www.tradingview.com/support/solutions/43000706927-all-chart-patterns/)) | Definitions are Edwards & Magee-style; useful as UX benchmark only. |

### 3.5 Neurotrader's methods in detail (since we'll borrow them)

- **Pivots**: `rw_extremes(data, order)` (§1.1) and `directional_change(close, high, low, sigma)` (§1.2). Confirmation index is first-class.
- **Trendlines** (`fit_trendlines_single/high_low`): OLS fit → take the point of max residual above (for resistance) / below (for support) as pivot → *optimise slope around that pivot so the line never crosses price* while minimising Σ(line − price)² ; `check_trend_line()` returns −1 if the constraint is violated; gradient sign + halving step search ([trendline_automation.py](https://github.com/neurotrader888/TechnicalAnalysisAutomation/blob/main/trendline_automation.py)). Output: outer envelope lines that touch ≥1 point and hug the data — exactly what a chartist draws.
- **Head & shoulders** (`head_shoulders.py`): rolling-window pivots; `HSPattern` dataclass with `l_shoulder, r_shoulder, head, l_armpit, r_armpit, neck_start/end, neck_slope, head_width, head_height, pattern_width, pattern_r2, break_i, break_p`; rules — head above both shoulders and both shoulders above their armpit-midpoints; time-symmetry `r_to_h_time ≤ 2.5·l_to_h_time` and vice-versa; neckline = line through the two armpits projected forward; two modes: `early_find=True` (declare when price falls to the midpoint between right shoulder and armpit — an *emerging* call) vs `early_find=False` (declare on neckline break — *confirmed*); `pattern_r2` = fit of price to the six straight segments; evaluation: entry at break, target `neck_end ∓ head_height`, stop at the right shoulder, exit within `head_width` bars → log-return. His stated conclusion (video series) is that H&S so defined has no standalone edge on his test assets, with the "early" mode worse than the confirmed mode; the `pattern_r2` and width/height features are what he suggests feeding a model. Treat as anecdotal but directionally consistent with §5.
- **Flags/pennants** (`flags_pennants.py`): pole = confirmed rolling-window extreme (`order≥3`) with `base_x/base_y` at `i−order`; flag body described by 5 PIPs from pole tip to current bar; rules — ≥`max(5, 0.5·order)` bars from pole tip; flag width ≤ 0.5·pole width; flag height ≤ 0.5·pole height (0.75 in trendline variant); middle PIP inside the body (`pips_y[2]` beyond neighbours); support/resistance lines through PIPs with intercept at pole tip must not intersect inside the flag; **breakout = close beyond the line on the current bar → `conf_x`**; `pennant = True` if the far line slopes toward the near line; evaluation: return over `hold = flag_width·hold_mult` bars after `conf_x`. This is a clean template for a *pole-anchored, streaming* consolidation detector.
- **PIP miner** (§2.6) — clustering + walk-forward + permutation test.

---

## §4. Trendline / channel fitting

### 4.1 Least-squares vs "outer" lines
OLS through highs gives a *centre* line, not a boundary. Neurotrader's constrained fit (§3.5) yields the outer envelope by rotating an OLS line around its most-violating pivot until it clears all points; equivalent to a 1-parameter LP. Trendoscope instead builds lines *through pivot pairs* and requires all intermediate pivots/candles to lie inside (error threshold). Both are O(n) per candidate line and can be re-run on each pivot confirmation.

### 4.2 Exhaustive / sorted-slope search (`trendln`)
`METHOD_NCUBED`: every 3-subset of extrema, keep collinear-within-tolerance triples; `METHOD_NSQUREDLOGN`: sort pairwise slopes, sweep for clusters; `window=125` then merge. Scoring by slope std error or wrong-side area. Batch-only but the scoring ideas transfer.

### 4.3 Hough transform / RANSAC
Hough (skimage) on a rasterised (time × price) image finds lines by vote counting — robust to outliers, scale must be normalised, quantisation of ρ/θ becomes the tolerance; `trendln` `HOUGHPOINTS` votes over extrema only. RANSAC (fit line to random 2-pivot samples, count inliers within `ε = a·ATR`, keep the best; [skimage example](https://scikit-image.org/docs/stable/auto_examples/transform/plot_ransac.html); LuxAlgo has a Pine port as "Machine Learning Regression Trend") is the same idea without rasterisation and is trivially incremental (re-sample when a pivot confirms). For ≤7 pivots per pattern exhaustive pairs (21 lines) beats both.

### 4.4 Touch-count / quality scoring
For a candidate line L over span `[t0, t1]`: `touches = #{pivots with |p − L(t)| ≤ ε}`; `violations = #{bars with close beyond L by > ε}`; `containment = 1 − violations/nBars`; `fitErr = RMS residual of touching pivots`. Emit `lineQuality = f(touches ≥ 2 or 3, containment, span/ATR)`. Bulkowski/Edwards–Magee want ≥2 touches per line (≥3 for a "valid" trendline); Trendoscope requires all selected pivots to touch.

### 4.5 Slope normalisation across timeframes
Express slope in **ATR-per-bar** (`slope_norm = Δprice/Δbars / ATR(tf)`) or in degrees after scaling y by ATR and x by 1 bar; a "flat" line is `|slope_norm| < flatThresh (≈0.05–0.1)`; "converging" iff the lines meet within `k·span` bars ahead. This is what lets a 3m wedge and a 1h wedge share one predicate and one probability table. Pattern height and pole height are likewise reported in ATR multiples (and in points).

---

## §5. Statistical evaluation of pattern edges

### 5.1 Conditional vs unconditional distributions (LMW)
LMW standardise per-stock returns, pool, and compare the distribution of the 1-day return `d` days after completion with the unconditional distribution via (i) a **decile goodness-of-fit** χ² (are conditional returns spread 10% per unconditional decile?) and (ii) two-sample **Kolmogorov–Smirnov**; also condition on volume trend (first-half vs second-half turnover ratio 1.2). Findings ([Tables V–VIII](https://www.cis.upenn.edu/~mkearns/teaching/cis700/lo.pdf)): NYSE/AMEX — HS, BBOT, RTOP, RBOT, DTOP significant by KS (p 0.000–0.021), IHS/BTOP/TTOP/TBOT/DBOT not; Nasdaq — **all 10 significant** with much larger Q (34–92) despite fewer patterns; pattern *frequencies* differ from GBM simulations (real data has 3× more H&S, fewer broadening tops). Crucially they show the conditional distributions differ *in shape* (excess mass in the middle deciles = lower variance) — **information ≠ directional edge**. They caution the tests assume IID and only 1-day horizon.

### 5.2 Bootstrap under a null process
Osler & Chang 1995 compare H&S profits with 10,000 bootstrap random-walk/GARCH series ([NY Fed SR 4](https://www.newyorkfed.org/research/staff_reports/sr4.html)): significant for DEM and JPY (~1%/trade), not for the other four, "significant and economically meaningful" pooled. Marshall, Young & Rose 2006 ([JBF 30(8)](https://www.sciencedirect.com/science/article/abs/pii/S0378426605002116)) bootstrap OHLC jointly and find **no value in candlestick strategies on DJIA stocks 1992–2002**, contra Caginalp & Laurent 1998 ([Applied Math. Finance 5](https://econpapers.repec.org/RePEc:taf:apmtfi:v:5:y:1998:i:3-4:p:181-205)) who report ~1% over 2 days for 3-day reversal candles on S&P 500 stocks 1992–96 (out-of-sample "36 σ" — a claim later studies did not replicate). Use **stationary/block bootstrap** (Politis–Romano) to preserve intraday autocorrelation and vol clustering ([block bootstrap overview](https://hrcak.srce.hr/file/197357)).

### 5.3 Data-snooping corrections
Sullivan, Timmermann & White 1999 (7,846 rules on 100 years of DJIA; White's Reality Check) — in-sample best rules survive RC on the 1897–1986 sample but **not in the 1987–96 out-of-sample decade** ([JF 54(5)](https://onlinelibrary.wiley.com/doi/10.1111/0022-1082.00163)). Hansen's SPA test (2005) is the less-conservative successor. Bailey & López de Prado's **Deflated Sharpe Ratio** corrects a selected backtest's Sharpe for the number of trials, non-normality and track length ([SSRN 2460551](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551)); Harvey, Liu & Zhu argue a **t > 3.0** hurdle for new "factors" given the multiple-testing history ([RFS 29(1)](https://academic.oup.com/rfs/article/29/1/5/1843824)). Our grid (≈60 patterns × ≈5 params × 6 TFs × 2 sides) is thousands of hypotheses — a per-cell p<0.05 is meaningless without one of these.

### 5.4 Event-study mechanics
Overlapping events (a 15m H&S and its 5m child; consecutive DTs) inflate significance: use HAC/Hansen–Hodrick errors with bandwidth ≥ horizon overlap, or Kolari–Pape–Pynnönen's overlapping-window correction ([SSRN 3167271](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3167271)); or simply de-cluster (one event per (TF, side, horizon) window). Arévalo et al. add a **quarterly re-optimised SL/TP** which is itself a look-ahead-free walk-forward — copy that.

### 5.5 Emerging-state counting (survivorship inside the detector)
The single most important methodological point for our downstream probability model: **the population must be defined at the earliest state you would act on.** If you only log patterns that later completed (neckline broke, flag broke out in the pole direction), the "success rate" is conditional on the outcome and is not a probability at all. Bulkowski's stats are computed on hand-picked *completed* patterns (with a breakout) — hence "93% success"; SWZ and LMW count at completion of the 5th extremum, before any breakout; Neurotrader's `early_find` flag exists exactly to expose the difference. Design consequence (§7): every candidate that reaches `forming` gets a row with `formingTs`, and outcomes are tabulated for **all** of them: `{confirmedUp, confirmedDown, invalidated, timedOut}` plus forward returns at fixed horizons from `formingTs` *and* from `confirmedTs`. Base rate of breakout direction at `forming` is the first number the engine reports per pattern×TF.

### 5.6 Pitfall checklist (all observed in the literature or in this repo)
1. Pivot look-ahead (§1.6) — using `extremeIdx` instead of `confirmedAt`.
2. Resolve-side look-ahead — walking exits from the pattern's *start* or the *bar open* rather than from the decision instant (see repo memory: dealer-reaction FSM void; `KNOWABILITY.md`).
3. Completed-only populations (§5.5).
4. Multiple comparisons without RC/SPA/DSR (§5.3).
5. Percent tolerances on intraday futures (LMW 1.5% ≈ 350 NQ pts) → use ATR (§4.5).
6. Overlapping / nested events double-counted (§5.4).
7. Pooled vs day-weighted results diverging (repo memory R3) — report both.
8. Fill realism: 1s-honest fills from the confirmation instant (repo rule); pattern studies almost universally use close-to-close.
9. IID assumption in KS/χ² — bootstrap instead.
10. Regime split (bull/bear, vol tercile) — Ahlawat, Bulkowski and Arévalo all show pattern stats move with regime; store regime tags on every event.

### 5.7 The five most important literature findings on predictive value
1. **Patterns are real as *information* but weak as *directional edges*.** LMW: conditional return distributions differ from unconditional for most patterns (esp. Nasdaq), but the difference is mostly in dispersion, not mean; they explicitly decline to claim profitability.
2. **H&S is the best-documented case and it is small, regime-dependent and mostly one-sided.** Osler–Chang: significant in DEM/JPY only; SWZ: 5–7%/yr risk-adjusted underperformance for 3 months after H&S tops in Russell 2000, not tradable long-short in the 1990s bull, partly momentum; Tsinaslanidis 2018: bearish-class DTW predictions significant, bullish not.
3. **Flags/consolidations after a sharp move are the most robust intraday finding.** Leigh 2002/2008 (daily NYSE), Cervelló-Royo 2015 / Arévalo 2017 (15m DJIA futures, ~0.25%/trade with ATR-relative SL/TP and Reality Check) — but with sizeable parameter search and small per-trade edge; the volume template mattered in Leigh 2002.
4. **Candlestick (1–3 bar) patterns have no robust edge in liquid US indices** once bootstrapped (Marshall–Young–Rose 2006; Ahlawat 2016 across 14 patterns/DJIA-30) — the Caginalp–Laurent 1998 result did not survive replication in that literature.
5. **After data-snooping correction most technical rules fail out-of-sample** (STW 1999; DSR/HLZ), and ML recognisers merely reproduce rule labels (Chen–Tsai, Liu–Si) — so the burden is on emerging-state base rates + placebo-controlled forward returns on *our* data, not on any published number.

---

## §6. Multi-timeframe / nesting

### 6.1 Literature
There is essentially no rigorous academic literature on hierarchical chart-pattern detection; what exists is (a) Fu et al.'s PIP-SB-tree "multi-resolution representation" (same series at different PIP counts — a *resolution* hierarchy, not a timeframe hierarchy), (b) Trendoscope's "multi level recursive zigzag" (zigzag of zigzag pivots, i.e., a pivot-strength hierarchy — the practical analogue of Elliott degree), (c) the fractal-market-hypothesis / self-similarity folklore (Peters 1994; Mandelbrot) and trader heuristics (Elder triple screen), and (d) TV-indicator practice of validating patterns across scales ([quantanalysis fractal microstructures](https://www.quantanalysis.org.uk/python/market-structure-fractal-microstructures/); [MQL5 fractal patterns article](https://www.mql5.com/en/articles/18566)). None provides evidence that nesting improves prediction; it is an untested hypothesis we should log for.

### 6.2 Two hierarchies, keep both
- **Timeframe hierarchy**: same detector, different bar aggregation (1m→3m→…→D). Aggregation must be **session-anchored** for intraday TFs (bars start at 09:30 ET / 18:00 ET boundaries so 15m/1h bars mean the same thing every day; TradingView-style) — rolling/unanchored bars produce different pivots for the same data and break comparability with the platform users look at. Daily bars follow the futures session convention (label by session-open date; repo gotcha in memory).
- **Pivot-strength hierarchy within a TF**: k-window with increasing k, or ATR-zigzag with increasing θ, or zigzag-of-zigzag. Cheaper than more TFs and gives "the 15m pattern's pivots are a subset of the 3m pivots" for free when the base is shared.

### 6.3 Nesting design
Every `PatternEvent` carries `{tf, span:[t0,t1], levels}`; nesting = interval containment: child `c` on `tf_c` nests in parent `p` on `tf_p > tf_c` iff `c.span ⊂ p.span` and `p.state ∈ {forming, confirmed}` at `c.formingTs`. Compute lazily at emission by querying an in-memory index of higher-TF forming patterns (per TF ≤ dozens live at once). Log `parentIds[]` and `parentAlignment ∈ {same-direction, counter, neutral}` for the probability model. Also record *level coincidence*: child boundary within `ε` of a parent boundary/neckline (the "confluence" feature that traders claim matters; the repo's LT/GEX work found level-reaction edges are placebo-equivalent — so log it, don't assume it).

---

## §7. Streaming architecture

### 7.1 Data flow
```
1s/1m base bars ─► CandleAggregator(tf, sessionAnchored) ─► per-TF pipeline:
   BarClose(tf) ─► ATR/vol features
              ─► PivotTrack[k-window]  ─► Pivot events (confirmedAt = now)
              ─► PivotTrack[atr-zigzag]─► Pivot events (confirmedAt = now)
              ─► CandleRules (TA-Lib-style, O(1))            ─► PatternEvent(kind=candle)
              ─► PatternDetectors[i].onPivot / .onBar        ─► PatternEvent(kind=chart, state=…)
   PatternEvent ─► NestingIndex (higher TFs) ─► enrich parentIds ─► emit to bus / log
```
One 1m base stream (from the 1s stream in backtests, TV/Schwab live), aggregators own the bar-close clock; every detector receives `onBarClose(bar)` and `onPivot(pivot)` and holds bounded buffers (last N pivots per generator, last M bars).

### 7.2 Pattern state machine
```
states: candidate → forming → confirmed → resolved(target|stop|timeout) | invalidated
        candidate → invalidated
        forming   → invalidated | expired
```
- **candidate**: predicate over `n−1` confirmed pivots + the *provisional* zigzag leg passes with slack; may be refined/replaced when a better-fitting pivot arrives (Trendoscope's "only if more accurate" rule). Not logged as an event, but the first `candidateTs` is stored on the record.
- **forming**: all structural pivots (LMW's `E1..E5`, or pole + flag PIPs) are *confirmed*; boundaries (neckline, trendlines, box) computed; `formingTs = max(pivot.confirmedAt)` = the bar the engine can first know it. Emits event with `levels: {validateUp, validateDown, invalidate}` and features (ATR-normalised height/width/slopes/touches/quality/r², prior-trend, volume ratios, template fit).
- **confirmed**: first bar with `close` beyond a validation level (optionally + `0.1–0.25 ATR` filter, or 2 closes); `confirmedTs`, `direction`. For bilateral patterns the direction is whichever side breaks first.
- **invalidated**: structural violation before confirmation (e.g. new pivot exceeds head; price closes back through the pole base; a 6th pivot breaks alternation constraints; max-bars-in-forming exceeded → `expired`).
- **resolved**: after confirmation, first of `target hit` / `stop hit` / `timeout(H bars)` walked on **1s bars from `confirmedTs`** (repo rule), plus MFE/MAE; also record fixed-horizon returns from `formingTs` and `confirmedTs`.

Every transition writes `{patternId, tf, kind, side, state, stateTs, barIdx, decisionInstantTs}` so that "what did the engine know at time T" is reconstructible; the pattern record is append-only (versions), never mutated in place — this is how emerging states stay honest for §5.5.

### 7.3 Incremental pivot & line maintenance
- k-window: monotonic deque per side gives O(1) amortised.
- ATR-zigzag: O(1) state per generator; ATR from the same TF's closed bars only.
- Alternation: `PivotTrack.push(p)` — if same kind as last, keep the more extreme (`H`: higher) and demote the other to `minor=true` (still stored; some patterns e.g. Adam/Eve tops or complex H&S want minors).
- Trendlines: recompute only when a pivot confirms or a candidate's span extends; ≤ C(7,2)=21 pivot-pair lines + Neurotrader constrained fit; cache per candidate.

### 7.4 Emitting and logging
Publish `PatternEvent` on the bus (`pattern.<state>`), and append JSONL per (symbol, tf) for research; include the raw feature vector so probability estimation is a pure offline join (`event → forward returns`). Volumes: with k=2 on 1m NQ RTH ≈ 100–150 pivots/day/side; 5-pivot patterns candidate at every pivot → a few hundred forming events/day at 1m, tens at 15m — cheap.

### 7.5 Placebo generation inside the engine
Because side-matched placebos are mandatory (repo memory), the engine should be able to emit *random-pivot patterns*: at each real forming event also emit `k` synthetic events with the same TF/side/time-of-day and randomly displaced structural times (or shuffled pivot indices) — the null distribution for §5 comes from the same code path.

---

## §8. Pseudocode: an LMW-style 5-pivot detector in the streaming contract

```js
class FivePivotDetector {           // one instance per (tf, generator)
  constructor(spec) { this.spec = spec; this.pivots = []; this.live = new Map(); }  // spec: HS|IHS|TTOP|... predicate + levels fn
  onPivot(p) {                       // p = {kind, extremeIdx, extremeTs, price, confirmedAt}
    this.pivots.push(p); if (this.pivots.length > 12) this.pivots.shift();
    const w = this.pivots.slice(-5);
    if (w.length < 5) return;
    const atr = this.atrAt(p.confirmedAt);
    const res = this.spec.predicate(w, atr);            // {ok, slack, features}
    if (!res.ok) return;
    const levels = this.spec.levels(w, atr);            // {validateUp, validateDown, invalidate, target}
    const id = hash(w.map(x => x.extremeIdx));
    this.live.set(id, {id, state:'forming', formingTs:p.confirmedAt, pivots:w, levels, features:res.features});
    emit({...rec, state:'forming', stateTs:p.confirmedAt});
  }
  onBar(b) {                          // closed bar on this tf
    for (const r of this.live.values()) {
      if (r.state === 'forming') {
        if (b.close > r.levels.validateUp)   transition(r, 'confirmed', {dir:'up', ts:b.ts});
        else if (b.close < r.levels.validateDown) transition(r, 'confirmed', {dir:'down', ts:b.ts});
        else if (violates(b, r.levels.invalidate) || b.idx - r.pivots[4].extremeIdx > r.maxBars) transition(r, 'invalidated', {ts:b.ts});
      } else if (r.state === 'confirmed') { /* resolution handled by 1s walker offline or by a live tracker */ }
    }
  }
}
```
`predicate` for HS (ATR form of LMW): `w[0].kind==='H' && w[2].price > w[0].price && w[2].price > w[4].price && |w[0].price − w[4].price| ≤ max(a·atr, b·mean) && |w[1].price − w[3].price| ≤ max(a·atr, b·mean) && timeSymmetry(w) ≤ 2.5`; `levels`: neckline through `w[1],w[3]` projected; `validateDown = neckline(t)`, `invalidate = w[2].price` (or right shoulder), `target = neckline − (w[2].price − neckline@head)`.

---

## §9. Source list (all accessed 2026-08-18)

- Lo, Mamaysky & Wang (2000) *Foundations of Technical Analysis*, J. Finance 55(4) — [PDF](https://www.cis.upenn.edu/~mkearns/teaching/cis700/lo.pdf), [NBER](https://www.nber.org/papers/w7613), [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=228099)
- Chung, Fu, Luk & Ng (2001) PIP — [ResearchGate](https://www.researchgate.net/publication/288658678_Flexible_time_series_pattern_matching_based_on_perceptually_important_points); Fu et al. (2007) template vs rule — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0952197606001278); Fu et al. (2008) data-point importance / SB-tree — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0952197607000577); Fu et al. (2005) meaningless pattern discovery — [Springer](https://link.springer.com/chapter/10.1007/11539506_146)
- Leigh, Modani, Purvis & Roberts (2002) — [Academia](https://www.academia.edu/104495621/Stock_market_trading_rule_discovery_using_technical_charting_heuristics); Leigh et al. (2008) — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0957417408004314); Wang & Chan (2007) — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0957417406001448); Arévalo, García, Guijarro & Peris (2017) — [UPV preprint](https://riunet.upv.es/server/api/core/bitstreams/22139367-4e73-4c5d-a708-1930685dd8a5/content); Lobão et al. (2024) — [Wiley](https://onlinelibrary.wiley.com/doi/10.1002/ise3.62); Chen & Chen (2016) — [ScienceDirect](https://sciencedirect.com/science/article/pii/S0020025516300159)
- Wan & Si (2017) formal chart patterns — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S002002551631636X); (2019) candlesticks — [ACM](https://dl.acm.org/doi/10.1016/j.asoc.2019.105700); (2021) features — [Springer](https://link.springer.com/article/10.1007/s10115-021-01569-1)
- Tsinaslanidis & Kugiumtzis (2014) PIP+DTW — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0957417414002516); Tsinaslanidis (2018) subsequence DTW — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0957417417307376); Zapranis & Tsinaslanidis (2012) — [T&F](https://www.tandfonline.com/doi/abs/10.1080/09603107.2012.663469); book — [Springer](http://link.springer.com/content/pdf/10.1007%2F978-3-319-23636-0.pdf); Zhang et al. (2010) real-time hybrid — [ACM](https://dl.acm.org/doi/pdf/10.5555/1862242.1862263)
- Nikolaou (2024) CPC-SAX — [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2405918824000175); Chen & Tsai (2020) GAF-CNN — [Springer](https://jfin-swufe.springeropen.com/articles/10.1186/s40854-020-00187-0); Liu & Si (2022) 1D-CNN — [Springer](https://link.springer.com/article/10.1007/s11227-022-04431-5); Ahlawat (2016) PNN — [SAGE](https://journals.sagepub.com/doi/full/10.3233/AF-160059)
- Osler & Chang (1995) — [NY Fed](https://www.newyorkfed.org/research/staff_reports/sr4.html); Savin, Weller & Zvingelis (2007) — [OUP](https://academic.oup.com/jfec/article-abstract/5/2/243/785044), [CXO summary](https://www.cxoadvisory.com/technical-trading/testing-the-head-and-shoulders-pattern/); Marshall, Young & Rose (2006) — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0378426605002116); Caginalp & Laurent (1998) — [RePEc](https://econpapers.repec.org/RePEc:taf:apmtfi:v:5:y:1998:i:3-4:p:181-205); Sullivan, Timmermann & White (1999) — [Wiley](https://onlinelibrary.wiley.com/doi/10.1111/0022-1082.00163); Bailey & López de Prado (2014) DSR — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551); Harvey, Liu & Zhu (2016) — [OUP](https://academic.oup.com/rfs/article/29/1/5/1843824); Kolari, Pape & Pynnönen overlapping event windows — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3167271); Alpha Interface review — [link](https://www.alphainterface.com/2013/04/18/do-chart-pattern-recognition-algorithms-yield-profits/)
- Code: Neurotrader — [repo](https://github.com/neurotrader888/TechnicalAnalysisAutomation); stock-pattern — [repo](https://github.com/BennyThadikaran/stock-pattern) / [wiki](https://github.com/BennyThadikaran/stock-pattern/wiki/Pattern-Algorithms); trendln — [README](https://github.com/GregoryMorse/trendln/blob/master/README.md); TA-Lib — [site](https://ta-lib.org/), [issue #647](https://github.com/TA-Lib/ta-lib-python/issues/647); technicalindicators — [npm](https://www.npmjs.com/package/technicalindicators); PatternPy — [repo](https://github.com/keithorange/PatternPy); Trendoscope — [Auto Chart Patterns](https://www.tradingview.com/script/WZ8B1FIW-Auto-Chart-Patterns-Trendoscope/), [zigzag lib](https://www.tradingview.com/script/DnjLJ7fc-zigzag/), [chartpatterns lib](https://www.tradingview.com/script/OuVJr45r-chartpatterns/); LuxAlgo SMC — [script](https://www.tradingview.com/script/CnB3fSph-Smart-Money-Concepts-LuxAlgo/); TradingView built-ins — [support](https://www.tradingview.com/support/solutions/43000706927-all-chart-patterns/), [ZigZag lib](https://www.tradingview.com/script/bzIRuGXC-ZigZag/); Pine repainting — [docs](https://www.tradingview.com/pine-script-docs/concepts/repainting/); RDP — [docs](https://rdp.readthedocs.io/); RANSAC — [skimage](https://scikit-image.org/docs/stable/auto_examples/transform/plot_ransac.html)
