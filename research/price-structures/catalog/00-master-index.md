# 00 — Master index: every structure, one place (2026-08-18)

Sources: `01-chart-patterns.md` (62 ids / 74 variants, Bulkowski stats), `02-candlestick-patterns.md`
(56 classical + 10 modern descriptors; all 61 TA-Lib CDL rules), `03-school-specific-structures.md`
(81 entries; Brooks / Wyckoff-VSA / harmonics / Elliott-Wolfe / ICT-SMC / Crabel-Raschke-Williams-Ross-
Vic-Grimes-Volman-Darvas-MP), `04-detection-methods-and-literature.md`, `05-repo-audit.md`.

Legend — **TF**: viability on 24h NQ/ES intraday (1m–1h) / daily: ✅ observable, ⚠️ needs an adapted
rule (gap → body separation, session gap only), ❌ effectively unobservable intraday, W = weekly-scale
only. **Ev** (best available evidence for predictive value): A = peer-reviewed positive somewhere;
B = practitioner tables (in-sample); C = descriptive stats only (Bulkowski daily stocks); D = none /
null / negative in tests. **Tier**: build order (1 = v0 engine, 2 = v1, 3 = later / composite-only).

## A. Canonical primitives (implement ONCE; school names are tags on the same event)

| # | primitive | what it is (OHLCV) | aliases collapse into it (see 03 §7) | Tier |
|---|---|---|---|---|
| P1 | `pivot` | fractal k-window + ATR-zigzag extrema, `confirmedAt` | all | 1 |
| P2 | `bar_features` | body/shadow/range vs rolling medians+ATR+ToD table, CLV, run-length, relvol | all candles, Brooks bar taxonomy, VSA | 1 |
| P3 | `twin_extreme` | 2–3 pivots of one kind within tol_eq, intervening trough/peak ≥ depth | double/triple top-bottom (Adam/Eve), Big M/W, pipe/horn, EQH/EQL, tweezers, MP poor high/low, Brooks DT/DB magnet, 2B (with sweep) | 1 |
| P4 | `slope_sign_shape` | two boundary lines through pivots → (upperSlope_n, lowerSlope_n, Δwidth) | sym/asc/desc triangle, rising/falling wedge, broadening (4), diamond (2 triangles), rectangle, channel, flag/pennant body, Brooks wedge/micro-channel/TTR, Darvas box | 1 |
| P5 | `prior_impulse` | move ≥K·ATR in ≤M bars, efficiency ratio, speed | flagpole, pole for pennant/HTF, spike (spike-and-channel), displacement, measured-move leg1, HS prior trend | 1 |
| P6 | `breakout` | close beyond a level/line by ε; follow-through | Brooks breakout, BOS/MSS, Donchian, Darvas, ORB/IB ext, Wyckoff SOS/JAC, squeeze fire, all chart-pattern confirmations | 1 |
| P7 | `sweep_reversal` | violate level (depth d), close back inside within k bars | ICT sweep/raid/judas/turtle soup, Wyckoff spring/upthrust/UTAD, VSA upthrust, Brooks failed BO/trap/opening reversal, Grimes failure test, Vic 2B, Williams Oops!/80-20, hikkake, bull/bear trap, false breakout, busted pattern seed | 1 |
| P8 | `breakout_retest` | after P6, pullback to level ≤ depth, resumption | BOPB/High-1/20-gap-bar, LPS/back-up, OB/FVG/BOS retest, Ross hook, Holy Grail, Grimes simple PB, three-bar play, throwback/pullback (Bulkowski) | 1 |
| P9 | `three_bar_gap` (FVG) | bar i-2 and bar i don't overlap, size ≥ threshold | FVG/BISI-SIBI/CE/iFVG/BPR, Brooks measuring gap, runaway/breakaway gap (session variant), single prints, rising/falling window | 1 |
| P10 | `compression_range` | N bars overlapping small ranges / range percentile | TTR, barbwire, ii/iii, NR4/NR7/ID/2BNR, BB/TTM squeeze, Volman block, compression box (C1), pennant, Wyckoff phase B, narrow IB | 1 |
| P11 | `session_range` | first W min range (5/15/30/60), IB, extension, day-type | ORB, IB, PO3, Crabel stretch, trend-from-open, gap-and-go | 1 |
| P12 | `gap_event` | open vs prior close/extreme (session gaps on futures) | gap-and-go/fill, Oops!, NDOG/NWOG, island reversal (with second gap), open-outside-value | 1 |
| P13 | `climax_bar` | outsized bar/vol after extended move; close position | Brooks climax, VSA climactic/stopping vol, Wyckoff SC/BC, extension bar, smash day, WRB, key/outside reversal; ICT displacement (opposite reading) | 1 |
| P14 | `two_leg_pullback` | ABC counter-move then resumption | High-2/Low-2, complex PB, AB=CD, zigzag, OTE retrace, measured-move | 2 |
| P15 | `three_push` | three successive extremes, converging legs | Brooks wedge/three pushes, Three Drives, Wolfe Wave, ending diagonal, rising/falling wedge (P4 special case), three rising valleys/falling peaks | 2 |
| P16 | `trend_reversal_123` | TL break → test of extreme → break of intervening pivot | MTR, Vic 1-2-3, Ross 1-2-3, CHoCH structural, H&S neckline logic, Dow reversal | 2 |
| P17 | `origin_zone` | last opposing candle before impulse | order block/breaker/mitigation, supply-demand, Brooks signal bar | 2 |
| P18 | `rounded_base` | curvature fit through pivots (cup/saucer/dome) | cup-with-handle (+inv), rounding top/bottom, scallops, BARR lead-in | 2 |
| P19 | `regime_state` | trend vs range classifier (structure, ADX, MP day type) | always-in, 80% rules, SMC trend, MP day type, Wyckoff phase | 2 |
| P20 | `fib_zone` / `harmonic_ratio` | leg-ratio windows on 4–5 pivots | XABCD family, OTE, Elliott guidelines | 2 |
| P21 | `volume_effort` | vol vs range/close anomalies (ToD-normalized) | VSA no-demand/no-supply/test/effort bars, Wyckoff effort-vs-result | 3 |
| P22 | `wave_validator` | Elliott R1–R3 / NEoWave checks over pivot sequences (validator/feature only) | Elliott counts, corrections | 3 |

Meta-states on any confirmed pattern (Tier 1, lifecycle layer): **false-break** (back inside ≤3 bars),
**throwback/pullback**, **single/double bust**, **partial rise/decline** (pre-breakout tell), **expired**.

## B. Chart patterns (from 01) — id → primitive, TF, evidence, tier

| id | fam | bias | primitive | TF | Ev | Tier | note |
|---|---|---|---|---|---|---|---|
| bull-flag / bear-flag | cont | with pole | P5+P4 | ✅ | A (Leigh; Cervelló-Royo/Arévalo 15m YM) | 1 | most robust intraday result; loose template did best |
| pennant | cont | with pole | P5+P4(conv) | ✅ | C | 1 | BEFR 54% |
| high-and-tight-flag | cont | up | P5+P4 | ✅ | C | 2 | daily-stock construct (2× in 2mo) — scale as ≥8 ATR pole |
| rectangle-top / -bottom | bilat | — | P4(flat/flat) | ✅ | C | 1 | partial rise/decline tell 65-80% |
| channel-up / -down / horizontal | cont | slope | P4(parallel) | ✅ | D (C2: placebo on NQ) | 1 | log only; C2 says slope adds nothing |
| measured-move-up / -down | cont | leg | P14 | ✅ | C | 2 | |
| ascending / descending scallop (+inverted) | cont | | P18 | ⚠️ | C | 3 | |
| cup-with-handle / inverted | cont | up/down | P18+P4 | ⚠️ (needs 30-100+ bars) | C (BEFR 5%) | 2 | |
| gap-common / breakaway / runaway / exhaustion | event | — | P12 / P9 | ⚠️ session gaps only | C | 1 | intraday "gap" = P9 body gap |
| symmetrical-triangle | bilat | prior | P4(conv) | ✅ | C (rank 36/39) | 1 | |
| ascending / descending triangle | bilat | up/down | P4(flat+conv) | ✅ | C | 1 | |
| rising-wedge / falling-wedge (rev+cont) | rev/cont | down/up | P4(conv same-sign) ≡ P15 | ✅ | C (rising wedge worst-ranked) | 1 | |
| broadening-top / -bottom | bilat | — | P4(div) | ✅ | C | 1 | |
| right-angled-broadening asc / desc | bilat | — | P4(flat+div) | ✅ | C | 1 | |
| ascending / descending broadening wedge | bilat | down/up | P4(div same-sign) | ✅ | C | 1 | |
| diamond-top / -bottom | rev | | P4(div→conv) | ✅ | C (diamond bottom rank 1/36 down) | 2 | |
| double-top ×4 / double-bottom ×4 (Adam/Eve) | rev | down/up | P3 | ✅ | A/C (LMW distributions differ; means ≈0) | 1 | emit Adam/Eve as features |
| big-m / big-w | rev | | P3+P5 | ✅ | C | 1 | |
| triple-top / -bottom | rev | | P3(n=3) | ✅ | C | 1 | |
| head-and-shoulders top / bottom | rev | | P3+P16 | ✅ | A-/D (Osler-Chang FX; Savin; dominated by momentum) | 1 | best-documented; small, one-sided |
| complex-head-and-shoulders | rev | | P3 | ⚠️ long | C | 2 | |
| three-rising-valleys / three-falling-peaks | rev/cont | | P15 | ✅ | C | 2 | |
| horn / pipe top-bottom | rev | | P3(sep≤3) | W | C | 3 | weekly-scale; intraday analog = twin spike |
| rounding-bottom / -top | rev/cont | | P18 | ⚠️ | C (BEFR 4%) | 2 | |
| v-top / v-bottom / extended-v | rev | | P13+P5 | ✅ | C | 2 | |
| island-top / -bottom / long-island | rev | | P12×2 | ❌ intraday (session-gap variant only) | C | 3 | |
| bump-and-run-reversal top / bottom | rev | | P4(trend line)+P5 | ⚠️ | C (rank 1/39 bottom) | 2 | |
| dead-cat-bounce / inverted | event | | P13+P12 | ❌ (stock event) | C | 3 | |
| roof / inverted-roof | rev | | P4 | ✅ | C (rare) | 3 | |
| reversal-bar / key-reversal | comp | | P13 | ✅ | C | 1 | |
| throwback / pullback | meta | | P8 | ✅ | C (58%, hurts perf) | 1 | lifecycle state |
| busted single/double/triple | meta | opposite | P7 on confirmed | ✅ | C (single bust +53%/−23% best) | 1 | lifecycle state |
| partial-rise / partial-decline | meta | | P4 internal leg | ✅ | C (65-80%) | 1 | |
| wolfe-wave bull / bear | harm-adj | | P15 | ✅ | C/D | 2 | |

## C. Candlestick patterns (from 02) — id → TF, evidence, tier

Evidence baseline: daily — only confirmation-type 3-bar patterns > 60% reversal (three outside 75%,
morning/evening star 78/72%, soldiers 82%, crows 78%); 1-2 bar shapes ≈ 50-60%; ~¼ act *opposite* to
textbook. Intraday futures: Fock-Klein-Zwergel 2005 (5m DAX/Bund) NULL; Duvinage 2013 NULL after
snooping. **Treat as feature vocabulary (P2), not a signal source.** All are Tier 1 as *features*
because P2 makes them ~free; the *tier* below is for evaluating them as standalone events.

| group | ids | TF | Ev | Tier |
|---|---|---|---|---|
| doji family | doji, long-legged/rickshaw, dragonfly/takuri, gravestone, four-price | ✅ (min-range floor) | D | 2 |
| hammer family | hammer, hanging-man, inverted-hammer, shooting-star, pin-bar (Fuller/Brooks) | ✅ | D/B (pin bar at level) | 1 |
| marubozu / belt-hold / WRB / trend bar / climax bar | ✅ | C/B | 1 (=P13) |
| spinning top / high-wave / short-line / long-line | ✅ | D | 3 |
| engulfing bull/bear, outside bar, three-outside up/down | ✅ | C (bearish engulf 79% rev but perf rank 91) | 1 |
| harami / harami-cross, inside bar, ii/iii, three-inside, hikkake (+mod) | ✅ | B/C (hikkake = P7) | 1 |
| piercing / dark-cloud (+lite), on-neck/in-neck/thrusting, counterattack/meeting lines | ✅ / ⚠️ | C | 2 |
| tweezer top/bottom, matching low/high, homing pigeon | ✅ (=P3 micro) | C | 2 |
| morning/evening star (+doji star), abandoned baby | ⚠️ star-lite (no gap) / ❌ | C (78/72%) | 1 (lite) |
| three white soldiers / black crows, identical three crows, advance block, deliberation | ✅ | C (82/78%) | 1 |
| three-line strike (+lite), rising/falling three methods, mat hold | ✅ / ⚠️ | C (3LS acts opposite) | 2 |
| kicking, separating lines, tasuki gaps, gap three methods, side-by-side white, two black gapping, upside-gap two crows, tri-star, breakaway, ladder bottom, concealing baby swallow, unique three river, stick sandwich, three stars in south | ❌ / ⚠️ (gap-dependent; adapted variants in 02 §7.10) | C | 3 |
| eight/ten/twelve/thirteen new price lines (run-length) | ✅ | C | 2 (feature) |
| NR4/NR7/ID/ID-NR4, WRB, CLV / close-in-third, body-range ratios, run-length, gap-relative descriptors | ✅ | B (Crabel) | 1 (features / P10) |

## D. School-specific structures (from 03) — id → primitive, TF, evidence, tier

| school | ids | primitive | TF | Ev | Tier |
|---|---|---|---|---|---|
| Brooks | brk_trend_bar/doji_bar, brk_ii_ioi, brk_climax_bar, brk_breakout, brk_breakout_pullback, brk_failed_breakout, brk_measuring_gap, brk_tight_trading_range, brk_barbwire, brk_micro_channel | P2, P10, P13, P6, P8, P7, P9, P10, P10, P4 | ✅ | D (none published) | 1 (as tags) |
| Brooks | brk_wedge, brk_second_entry (H1/H2/L1/L2), brk_mtr, brk_trendline_break_test, brk_spike_and_channel, brk_20_gap_bar, brk_magnets_measured_move | P15, P14, P16, P16, P5+P4, P8, P14 | ✅ | D | 2 |
| Brooks | brk_always_in, brk_80pct_rule, brk_trend_from_open, brk_opening_reversal, brk_final_flag | P19, P19, P11, P7@open, P10 | ✅ | D | 3 (composite/context) |
| Wyckoff/VSA | wy_spring/upthrust/UTAD, wy_jump_across_creek/lps, wy_sow_lpsy | P7, P6+P8, P6+P8 | ✅ | D | 1 (tags) |
| Wyckoff/VSA | vsa_no_demand, vsa_no_supply, vsa_stopping_volume, vsa_upthrust, vsa_test, vsa_climactic_action, vsa_effort_bars, wy_effort_vs_result | P21 (P7, P13) | ✅ (ToD-normalized vol) | D | 3 |
| Wyckoff | wy_schematic (phases A–E state machine) | P19 composite | ⚠️ | D | 3 |
| Harmonics | hm_abcd, hm_gartley, hm_bat, hm_altbat, hm_butterfly, hm_crab, hm_deepcrab, hm_cypher, hm_shark, hm_five_zero, hm_three_drives, PRZ | P20 (+P14/P15) | ✅ (pivot-threshold sensitive) | D (blog backtests ≈ coin flip) | 2 |
| Elliott/NEoWave | ew_impulse_rules, ew_corrections, neo_rules | P22 | ⚠️ non-unique | D | 3 (validator only) |
| Wolfe | wolfe_wave | P15 | ✅ | C/D | 2 |
| ICT/SMC | smc_swing_structure, smc_bos_choch, smc_fvg, smc_liquidity_pools (EQH/EQL), smc_liquidity_sweep, smc_displacement | P1, P6/P16, P9, P3, P7, P5/P13 | ✅ (LuxAlgo L=5/50, FVG auto-thr, EQ tol 0.1 ATR) | D (repo: pre-RTH sweep side 90.5% OOS is the only support) | 1 |
| ICT/SMC | smc_order_block (+breaker/mitigation), smc_premium_discount_ote, smc_session_raid | P17, P20, P11/P7 | ✅ | D | 2 |
| ICT/SMC | smc_power_of_three | P11 composite | ⚠️ | D | 3 |
| Boxes/ranges | orb (5/15/30/60), mp_initial_balance (+day type, POC/VA approx), donchian_breakout, darvas_box, bb_squeeze / ttm_squeeze | P11, P11/P19, P6, P4/P6, P10 | ✅ | A (ORB equities; Donchian daily TF) / D | 1 |
| Bar setups | crabel_nr (NR4/NR7/ID/2BNR/WS + stretch), lw_oops, lw_smash_day, raschke_turtle_soup (+1), raschke_80_20, key_reversal / outside_reversal, hook_reversal, pivot_point_reversal, bull_trap / bear_trap, failure_test | P10+P11, P12+P7, P13, P7, P7, P13, P13, P1, P7, P7 | ✅ (many daily-designed; intraday analog = session-relative) | B | 1 |
| Bar setups | vic_123 / vic_2b, ross_123_hook, raschke_holy_grail, raschke_anti, grimes_pullbacks (simple/complex/Anti/failure test), three_bar_play, volman_patterns (DD/FB/SB/BB/RB/IRB/ARB) | P16/P7, P16/P8, P8, P19, P8/P14/P7, P8, P7/P8/P10 | ✅ | B/D | 2 |
| Session/gap/ext | gap_and_go / gap_fill, extension_bar / vwap_extension | P12, P13 | ✅ | B (repo A1: gap-fill monotone in |gap|/ATR, real) | 1 |

## E. Counts

- Chart: 62 ids (74 variants). Candles: 56 classical (+10 modern descriptors; 61 TA-Lib rules mapped;
  ~24 gap-dependent → 14 unobservable intraday, 10 adapted). School-specific: 81 entries.
- **Unique named structures ≈ 200 → canonical primitives ≈ 22** (+5 lifecycle meta-states).
- Tier 1 (v0 engine): P1–P13 + lifecycle meta-states → covers flags/pennants, all triangles/wedges/
  broadening/rectangles/channels, double/triple tops-bottoms + H&S (simple), all viable candles as
  features, FVG, sweep/failed-break, breakout+retest, compression/NR, ORB/IB, gaps, climax/WRB.
- Tier 2: measured moves, three-push/Wolfe/wedge-as-3-push, 1-2-3 reversals/MTR/CHoCH-structural,
  order blocks, cup/rounding/scallop/BARR, diamonds, complex H&S, harmonics, V/extended-V.
- Tier 3: VSA bars, Wyckoff phases, Elliott validators, weekly-scale (horn/pipe), stock-event
  patterns (DCB, islands), narrative context (always-in, PO3).
