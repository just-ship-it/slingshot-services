# C2 — Census of intraday TRENDS and PARALLEL TREND CHANNELS on NQ

Greenfield charter compliant. Descriptive census only — NO win rates, NO profit
factors, NO fill simulation. Effects are reported in NQ points and vol-normalized
(ATR14). Placebo-controlled and per-year (2021–2026) throughout. Data: prebuilt
primary-contract 1m caches (NQ + ES), RTH 09:30–16:00 ET, single-symbol days only,
rollover days excluded.

**Bottom line:** trends and parallel channels on NQ are placebo-equivalent to
sloped-random and flat-band controls. The fitted **slope adds nothing over a flat
band of the same width** in any test. The one honest signal — trailing slope has
*some* forward-return content — is (a) not sign-stable across years on NQ, and
(b) where stable (ES, very short horizon) it is economically negligible and still
inside the placebo band in half the years. **Channels are NOT better than the
static horizontal levels the sibling C1 study found placebo-equivalent — they are
the same placebo with a slope bolted on.**

---

## 0. LOOKAHEAD SELF-AUDIT (read first)

The central trap in channel research is fitting a line with hindsight and then
"testing" respect of the very bars used in the fit. Here is exactly how each
channel object is FROZEN before any evaluation, and where the knowability boundary
sits.

**Knowability convention (inherited from C1_common, unchanged).** A 1m bar stamped
at minute-of-day `tmin=T` covers `[T, T+1)` and is usable only at `T+2` (its close,
plus one more minute — the live-emission delay baked into every greenfield study).
An HTF bar occupying 1m minutes `[s, s+tf)` closes with the 1m bar stamped `s+tf-1`,
usable at `s+tf+1`.

**Linear-regression channel (def #1, `C2-10-fit.py`).**
- OLS of `close ~ bar_index` is fit over the trailing `K` HTF bars **ending at bar
  i**. Every bar in that window has already closed at the freeze instant.
- We store `freeze_end = s_i + tf` — the 1m minute of the window's LAST bar close.
- The registry stores `price_end` (regression value at the last bar), `slope_pm`
  (points/minute), and half-width `W`. The rail at any future minute `t` is
  `mid(t)=price_end+slope_pm*(t-freeze_end)`, `rails = mid ± W`. All three numbers
  are frozen at build time from `≤ freeze_end` data only.
- **Every forward evaluation uses only bars with `tmin > freeze_end`.** Forward
  returns use `p0 = close(freeze_end-1)` (last *known* close) and
  `pH = close(freeze_end-1+H)`; rail touches walk `t ≥ freeze_end+1`. No forward
  bar ever enters the fit. Verified: the OLS reproduces `np.polyfit` exactly, and
  `freeze_end` equals the window's last-bar close minute (assertion test passed).

**Pivot-anchored channel (def #2, `C2-50-pivot.py`).** The fractal-lookahead trap
handled explicitly:
- A fractal swing at HTF bar `j` (N=3 bars each side) is **CONFIRMED only at bar
  `j+N`** (`k=N`; `C1.fractal_swings` returns `confirm_idx=j+N`). The channel is
  built from the two most-recent *confirmed* swing highs (up) or lows (down), and
  a parallel rail through the extreme intervening low/high.
- **The channel is frozen at the confirmation bar of the 2nd (later) pivot**, i.e.
  `freeze_end = bar_close_minute(confirm_idx of pivot 2)`. It does not exist one
  minute earlier. Anchors are same-day and within a 40-bar lookback.
- Forward evaluation is strictly after `freeze_end`, identical machinery to def #1.

**Trend state (def #3)** is the linreg slope itself, evaluated as forward-return
prediction — same freeze/forward split.

**Placebos run through the IDENTICAL machinery**, changing only the slope:
- `sloped` — same freeze anchor and width `W`, slope replaced by a random draw
  (empirical magnitude pool, random sign, deterministic per channel-id).
- `flatband` — slope = 0, band `= price_end ± W`. This is the "does the slope add
  anything over a horizontal band?" control demanded by the C1 calibration.
- `shuffle` / `randsign` (persistence) — permute slope values across freeze rows,
  or randomize slope sign; destroys the time-alignment so any real spread collapses.

**Selection-conditioning guard.** For the boundary/break census, channels are
**tiled** (non-overlapping windows spaced by `K*tf`) so touches are independent
samples, not the same touch re-counted across hundreds of overlapping fits.
Side-matched spread (E[fwd|up]−E[fwd|down]) is used for every one-directional claim
so NQ's up-drift cannot launder itself into an "up-channel edge" (drift lifts both
legs equally; the spread nets it out — the `drift` column shows the raw baseline).

**Registry caches (for a 1s follow-up):** `C2-registry-NQ.csv` (412,847 frozen
channels), `C2-registry-ES.csv` (379,043), `C2-pivot-registry-NQ-{5,15}m.csv`.
Each row fully reconstructs its causal rail at any future instant.

---

## 1. TREND / SLOPE PERSISTENCE (the honest core question)

Does an established channel's trailing slope predict the next bars' return, beyond
NQ's up-drift and the known-weak autocorrelation? Metric = side-matched spread
`E[fwd_H | slope>0] − E[fwd_H | slope<0]` in ATR units, per year. A real edge needs
the spread **positive with per-year sign stability** and **outside the placebo band**.

### NQ 5m, K=12 (60-min channel) — representative

| H | pooled spread | drift | per-year sign-stable | years beating placebo |
|---|---|---|---|---|
| 5m | +0.0009 | +0.0001 | **no** | 0/6 |
| 15m | +0.0021 | +0.0004 | yes (tiny) | 2/6 |
| 30m | +0.0030 | +0.0009 | **no** (2021 −.0010, 2022 −.0010, 2025 −.0011) | 3/6 |
| 60m | +0.0043 | +0.0028 | **no** (2021 −.0035, 2022 −.0021, 2025 −.0057) | 3/6 |

The pooled positive number is an artifact of **2023–2026**: the up−down spread is
≈0 or negative in 2021–2022 and positive in 2023–2026. This is the project-wide
kill signal — a per-year sign inversion. Same pattern at K=6/18/24 and on 15m bars.

### Conditioning — the "tight, young, HTF-aligned channels continue" claim

Tested at NQ 5m K=12, H=30m, as high-bucket − low-bucket spread per year:

| Conditioner | high−low spread by year (2021→2026) | verdict |
|---|---|---|
| R² tight (≥.7) vs loose (<.5) | −.009, +.003, +.018, +.013, −.004, −.020 | unstable — clean channels do NOT reliably persist more |
| Age young (n≤K+3) vs mature (>2K) | −.031, +.002, +.003, −.023, −.020, −.017 | **mostly negative** — young channels persist LESS, not more |
| \|slope_norm\| strong (>.5) vs weak (<.2) | +.001, −.004, +.028, +.090, +.027, +.048 | biggest effect BUT only 2023–2026; ≈0/neg in 2021–2022 |
| Multi-window sign alignment vs mixed | −.011, +.012, +.003, −.004, −.005, −.011 | unstable — HTF alignment does not reliably help |

**The interesting tradable claim is refuted.** "Tight + young + HTF-aligned →
continues" does not hold: young is if anything worse, alignment is a wash, tightness
is unstable. The only conditioner with muscle (strong slope magnitude) is a
recent-regime momentum effect that fails per-year stability.

### ES generalization (`C2-60-es.py`) — the one nuance

ES's short-horizon spread is **positive every year** (unlike NQ):

| ES config | H | pooled | sign-stable | beats shuffle-placebo band |
|---|---|---|---|---|
| 5m K=12 | 15m | +0.0038 | yes | **3/6 years** (2022/23/24; inside band 2021/25/26) |
| 15m K=8 | 30m | +0.0068 | yes | not all years |

So ES carries a genuinely-signed but **tiny** short-horizon slope momentum
(~0.003–0.007 ATR ≈ fractions of a point) that is still inside the placebo band in
half the years, and — critically — **does not reproduce with stability on NQ, the
target instrument.** Not a deployable edge.

---

## 2. RAIL BOUNDARY INTERACTION (the level-like part)

When price first approaches a projected rail (within 5pts, having been ≥25pts
inside), does it revert into the channel or break through? Metric = mean reversion
at +15m (ATR units, +=reverted), real vs both placebo classes, tiled channels.

### NQ

| config | real | sloped placebo | flat-band | p(breakout) |
|---|---|---|---|---|
| 5m K=12, H15 | +0.0165 (n3419) | +0.0147 | +0.0142 | 0.43 |
| 5m K=12, H30 | +0.0146 | +0.0181 | +0.0144 | 0.46 |
| 15m K=8, H15 | +0.0172 (n2128) | +0.0139 | +0.0167 | 0.40 |

Real ≈ sloped ≈ flat-band at every horizon. Per-year, real is above placebo in some
years and below in others (noise). **A channel rail mean-reverts price exactly as
much as a random sloped line or a flat band of the same width does — i.e., it is a
level, and levels on NQ are placebo (per C1).** The slope contributes nothing.

---

## 3. CHANNEL BREAK / REVERSAL

After a 1m close breaks a rail by >5pts, does it continue or snap back? Metric =
continuation in break direction (ATR units), tiled channels.

| config | real | sloped | flat-band | p(continue) |
|---|---|---|---|---|
| NQ 5m K=12, H15 | +0.0300 (n6175) | +0.0312 | +0.0318 | 0.64 |
| NQ 5m K=12, H30 | +0.0331 | +0.0329 | +0.0350 | 0.61 |
| NQ 15m K=8, H60 | +0.0382 (n1847) | +0.0319 | +0.0377 | 0.59 |

There IS post-break continuation (p≈0.61–0.65 > 0.5) — but it appears **identically
in the flat-band control**. It is generic post-volatility-expansion drift of *any*
band, not a channel-break effect. Real does not beat flat. Dead as a channel signal.

---

## 4. PIVOT-ANCHORED CHANNELS (def #2)

6,617 causal 5m up/down channels; 733 on 15m. Both headline tests:

- **Slope persistence:** spread flips sign every year at every horizon
  (5m H15: +.001, +.002, −.002, +.001, −.011, +.022). Pure noise, worse than linreg.
- **Rail reversion H15:** real +0.0137 ≈ sloped +0.0150 ≈ flat +0.0138 (5m);
  real +0.0230 ≈ sloped +0.0182 ≈ flat +0.0235 (15m, n only 367). Placebo-equivalent.

Pivot channels add nothing over the linreg channel and are noisier.

---

## 5. REGIME + TIME-OF-DAY (`C2-40-regime.py`)

Fraction of RTH freezes sitting in a "well-fit" channel, and its intraday shape.

**How often is NQ "in" a channel?** (5m K=12, fraction of freezes)

| year | R²≥0.5 | R²≥0.7 | R²≥0.9 | median R² |
|---|---|---|---|---|
| 2021 | 0.45 | 0.26 | 0.04 | 0.44 |
| 2023 | 0.46 | 0.27 | 0.05 | 0.46 |
| 2025 | 0.45 | 0.26 | 0.04 | 0.44 |

Stable across years: only **~26% of the time** is price in a clean (R²≥0.7) 60-min
channel; ~4% in a very clean one. Channels are the **minority** state.

**Time-of-day (5m K=12):** the 60-min window means channels can't be measured before
10:30. From 10:30 on:

| ET window | frac R²≥0.7 | med \|slope_norm\| | med width/ATR |
|---|---|---|---|
| 10:30–11:30 | 0.285 | 0.174 | 0.117 |
| 11:30–13:30 | 0.263 | 0.115 | 0.081 |
| 13:30–15:00 | 0.274 | 0.101 | 0.070 |
| 15:00–16:00 | 0.258 | 0.095 | 0.070 |

Weak "morning-drive / afternoon-drift" signature: slope magnitude ≈halves from the
10:30–11:30 drive into the afternoon, and channels widen most in the morning. But
**fit-quality (R²) is nearly flat across the day** — you can always fit a line to
*something*; the trending-ness that matters (slope magnitude) decays, the
"respect" (R²) does not vary enough to gate on.

---

## 6. RANKED SHORTLIST + DEAD LIST

### Survivors (beat BOTH placebo classes with per-year stability)

**None.** No trend or channel effect on NQ clears the bar.

### Closest flicker (documented, not a survivor)

| effect | size | n | per-year | live-computable | verdict |
|---|---|---|---|---|---|
| ES very-short-horizon slope momentum (5m K=12, H≤15m) | ~0.004 ATR spread | ~15k/yr | positive every year but inside placebo band 3/6 | yes | **too small + not on NQ** — no 1s follow-up warranted |

### Dead list (with the reason each died)

1. **Trailing-slope persistence (all TF/K/H) on NQ** — pooled-positive but per-year
   sign-inverts (≈0/neg 2021–22, pos 2023–26). Fails the stability kill criterion.
2. **"Tight/young/HTF-aligned channels continue"** — refuted: young persists *less*,
   alignment is a wash, tightness unstable. The named tradable hypothesis is dead.
3. **Strong-slope momentum conditioner** — largest effect but a 2023–2026-only
   regime artifact; zero/negative in 2021–2022.
4. **Rail boundary mean-reversion** — real ≈ sloped ≈ flat-band at every horizon &
   year. The rail is a placebo level; slope adds nothing.
5. **Channel-break continuation** — real ≈ flat-band; it is generic post-vol-expansion
   drift, not a channel effect.
6. **Pivot-anchored channels (5m & 15m)** — noisier than linreg; persistence flips
   sign yearly; boundary placebo-equivalent.

### Verdict on "trends/channels > static levels"

**No.** A channel boundary is a sloped level, and it behaves exactly like the static
horizontal levels C1 proved placebo-equivalent — real rails match flat-band controls
of identical width. The slope, the fit quality, the channel age, and HTF nesting all
fail to add stable, placebo-beating forward information on NQ. The clearest,
best-powered nulls are the boundary (section 2) and break (section 3) tables, where
real and flat-band track to within noise across hundreds of thousands of samples.

---

## Reproduce

```
python3 C2-10-fit.py NQ            # + ES : build channel registries
python3 C2-20-persistence.py       # slope persistence + conditioning + placebos
python3 C2-30-boundary.py          # rail boundary + break, real vs 2 placebos
python3 C2-40-regime.py            # regime + time-of-day
python3 C2-50-pivot.py 5           # + 15 : pivot-anchored channels
python3 C2-60-es.py                # ES generalization
```
Registry CSVs (`C2-registry-*.csv`, `C2-pivot-registry-*.csv`) carry the exact
causal channel definitions for a 1s follow-up — though no survivor warrants one.
