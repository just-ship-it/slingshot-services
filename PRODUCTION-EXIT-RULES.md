# Production Exit Rules — Targets / Stops / Break-Even

**Snapshot date:** 2026-05-29
**Source of truth:** `signal-generator/src/utils/config.js` preset bundles (mirrored in `backtest-engine/src/cli.js`).
**Production presets (confirmed — no preset env overrides set on the signal-generator app, so the config.js defaults are live):**

| Strategy | Constant | Live preset |
|---|---|---|
| gex-flip-ivpct | `GEX_FLIP_IVPCT` | **v2** (`GFI_PRESET` default) |
| gex-lt-3m-crossover | `GEX_LT_3M_CROSSOVER` | **v3** (`GLX_PRESET` default) |
| gex-level-fade | `GEX_LEVEL_FADE` | **v2** (`GLF_PRESET` default) |
| ls-flip-trigger-bar | `LS_FLIP_TRIGGER_BAR` | **v3** candJ (`LSTB_PRESET` default) |

> All distances are in **points**. Dollar values shown for **MNQ** (micro, $2/pt — what the live account trades). For full **NQ** multiply ×10 ($20/pt).
>
> **Legend:**
> - **Target / Stop** — bracket distance from entry, in points.
> - **BE trig / lock** — break-even: once price reaches `trig` points of favorable excursion (MFE), the stop moves to entry **±`lock`** (i.e. you lock in `lock` points of profit). `0/0` = no BE.
> - **Trail trig / off** — trailing stop: arms at `trig` pts MFE, then trails `off` pts behind the high-water mark.
> - **Max hold** — minutes after fill before force-flat (enforced by trade-orchestrator `checkMaxHold`).
> - BE and Trail are mutually exclusive per rule in these presets.

---

## gex-flip-ivpct — preset **v2** (uniform across all entry rules)

GFI applies one exit policy to every entry rule (S1/S2/… differ only in entry logic).

| Param | Points | MNQ $ |
|---|---|---|
| Target | 260 | $520 |
| Stop | 60 | $120 |
| Break-even | trig 160 → lock +10 | arms at +$320, locks +$20 |
| Trailing | — | — |
| Max hold | 600 min (10h) | |
| Fib-retrace exit | **off** (v2 disables it; `tight` preset enables) | |
| Blocked hours (ET) | 6, 7, 8 | |
| Blocked DOW | none | |

---

## gex-lt-3m-crossover — preset **v3** (PER-RULE)

Enabled rules = all minus disabled `[L_S3, L_S5_SOLO, L_PW, S_S2_SOLO, S_R3, S_R5, S_PW_SOLO]` → the 4 below are the only live rules.

| Rule | Side | Target | Stop | Break-even | Trailing | Max hold | Time/level blocks |
|---|---|---|---|---|---|---|---|
| **L_S4** | long | 100 ($200) | 70 ($140) | 70 → +20 | — | 120 min | block LT idx [2,4]; block DOW Thu, Fri |
| **S_CW** | short | 200 ($400) | 70 ($140) | 80 → +20 | — | 120 min | block hours 14, 15 ET |
| **S_GF_SOLO** | short | 180 ($360) | 70 ($140) | 80 → +20 | — | 120 min | block hour 11 ET |
| **S_R4** | short | 80 ($160) | 40 ($80) | — | trig 70 → off 25 | 60 min | block LT idx [2,4]; block DOW Fri; block hours 11, 15 ET |

> Plus a global **LS-BE-on-flip** overlay (`GLX_LS_BE_ON_FLIP`) layered on top of the per-rule BE.

---

## gex-level-fade — preset **v2** (uniform)

| Param | Points | MNQ $ |
|---|---|---|
| Target | 110 | $220 |
| Stop | 22 | $44 |
| Break-even | trig 100 → lock +10 | arms at +$200, locks +$20 |
| Trailing | — | — |
| Max hold | 180 min (3h) | |
| Levels traded | **PRH, PRL only** (v2 drops SH/SL — PF 0.96 zone) | |

---

## ls-flip-trigger-bar — preset **v3** (candJ, uniform)

| Param | Points | MNQ $ |
|---|---|---|
| Target | 15 | $30 |
| Stop | 12 | $24 |
| Break-even | trig 8 → lock +2 | arms at +$16, locks +$4 |
| Trailing | — | — |
| Min trigger-bar range | 3 pts (skip tiny bars) | |
| Max hold | 60 min | |
| Blocked hours (ET) | 5, 16, 17, 18, 19, 20, 21, 22, 23 (Asia + close) | |

---

## Production enabled set (confirmed by Drew, 2026-05-29)

Prod runs **all 4** strategies in this doc:
1. gex-level-fade
2. gex-flip-ivpct
3. ls-flip-trigger-bar
4. gex-lt-3m-crossover

⚠️ **The committed `signal-generator/strategy-config.json` is STALE** — it shows only `gex-flip-ivpct` and `gex-lt-3m-crossover` as `enabled: true` (gex-level-fade and ls-flip-trigger-bar marked `false`). Production has all 4 on (live signals 2026-05-29 fired from level-fade, lstb, and lt-3m). The deployed config / override differs from the local file; worth reconciling so the repo matches live.

## How to change in production

Set on the **signal-generator** Sevalla app env (no value currently set → using defaults above):
- `GFI_PRESET` = `v2` | `tight` | `v2-max` | `v2-low-dd`
- `GLX_PRESET` = `v3` | `w12` | `v3-max` | `v3-balanced` | `v3-low-dd`
- `GLF_PRESET` = `v2` | `gold` | `v2-max` | `v2-low-dd`
- `LSTB_PRESET` = `v3` | `v2` | `v3-max` | `v3-balanced` | `v3-low-dd`

Reproduce any preset in the backtester with the matching `--gfi-preset` / `--glx-preset` / `--glf-preset` / `--lstb-preset` flag. Full preset bundles + alternates live in `signal-generator/src/utils/config.js` and `backtest-engine/STRATEGY-GOLD-STANDARDS.md`.
