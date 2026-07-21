#!/usr/bin/env python3
"""
R4-00: build slim intermediates for the FIRST-HOUR (09:30-10:45 ET) flow census.

Source: cache/NQ_1m_primary.csv via a1_common (ET columns, rollover-safe).
Day features merged from B12-days.csv (all knowable at 09:30).

Knowability convention used throughout R4:
  price_at(mod M) := OPEN of the 1m bar stamped at minute-of-day M.
  That open == close of the (M-1) bar, which closed at M:00:00 -> knowable at M:00.
  So P(0945)=open of mod585 bar, P(1000)=open of mod600, etc. Exact, no off-by-one.
  The 15m opening candle 09:30-09:45 = 1m bars mod 570..584 (close of 584 = P(0945)).

Outputs:
  R4-marks.csv          one row per qualifying day: price marks + opening-candle
                        features + arr5 + extreme-timing + B12 day features.
  R4-minute-returns.csv long: per day, per minute-of-day mod 570..719, the 1m
                        close-to-close return in pts and /atr14 (event-vol vs drift).
Qualify: full_rth, single RTH symbol (rth_same_sym), and no NaN in the core marks.
"""
import numpy as np
import pandas as pd
import a1_common as A

MOD0, MOD1 = 570, 959          # 09:30 .. 15:59 (full RTH, for extreme timing)
df = A.load_cache("NQ")
w = df[(df["mod"] >= MOD0) & (df["mod"] <= MOD1)].copy()

# pivot each OHLCV field to day x mod dense arrays
def piv(col):
    return w.pivot_table(index="trade_date", columns="mod", values=col, aggfunc="first")
O = piv("o"); H = piv("h"); L = piv("l"); C = piv("c"); V = piv("v")
mods = O.columns.to_numpy()
days = O.index
def col(M):  # column position for a given mod
    return int(np.where(mods == M)[0][0])

Oa = O.to_numpy(); Ha = H.to_numpy(); La = L.to_numpy(); Ca = C.to_numpy(); Va = V.to_numpy()

def P(M):    # price mark = open of bar mod M
    return Oa[:, col(M)]

# ---- day features from B12 (knowable at 09:30) ----
b = pd.read_csv("B12-days.csv", parse_dates=["trade_date"]).set_index("trade_date")
m = pd.DataFrame(index=days)
for c in ["year", "dow", "full_rth", "rth_same_sym", "roll_in_day", "on_ok", "gap_ok",
          "on_high", "on_low", "on_range", "on_range_atr", "rth_open", "rth_close",
          "prior_rth_close", "gap", "gap_atr", "atr14_prior", "on_compressed"]:
    m[c] = b[c].reindex(days)
atr = m["atr14_prior"].to_numpy()

# ---- price marks ----
mark_mods = {"0930": 570, "0935": 575, "0940": 580, "0945": 585, "1000": 600,
             "1005": 605, "1010": 610, "1015": 615, "1030": 630, "1045": 645,
             "1100": 660, "1200": 720}
for name, M in mark_mods.items():
    m[f"p{name}"] = P(M)

# ---- opening 15m candle (mod 570..584) ----
c570, c584 = col(570), col(585)  # slice [570..584] is columns col(570):col(585)
oc_o = Oa[:, c570]
oc_h = np.nanmax(Ha[:, c570:c584], axis=1)
oc_l = np.nanmin(La[:, c570:c584], axis=1)
oc_c = P(585)                       # close of 09:44 bar == open of 09:45 bar
m["oc_open"], m["oc_high"], m["oc_low"], m["oc_close"] = oc_o, oc_h, oc_l, oc_c
m["oc_dir"] = np.sign(oc_c - oc_o)         # +1 up candle, -1 down
m["oc_body"] = oc_c - oc_o
m["oc_body_atr"] = (oc_c - oc_o) / atr
m["oc_range"] = oc_h - oc_l

# arr5 at 09:45: side * (extreme_in_drive_dir over 09:40-09:45 - P(0940)) / atr
side = m["oc_dir"].to_numpy()
c580 = col(580)
hi5 = np.nanmax(Ha[:, c580:c584], axis=1)   # 580..584 -> 09:40..09:45
lo5 = np.nanmin(La[:, c580:c584], axis=1)
ext5 = np.where(side >= 0, hi5, lo5)
m["arr5"] = side * (ext5 - P(580)) / atr

# ---- morning + rth extreme timing ----
cA, cM12, cRE = col(570), col(720), col(959) + 1   # 09:30, 12:00, 15:59(+1)
# window [09:30, 12:00): columns cA..cM12-1
mh_arg = np.nanargmax(Ha[:, cA:cM12], axis=1); mh_mod = mods[cA:cM12][mh_arg]
ml_arg = np.nanargmin(La[:, cA:cM12], axis=1); ml_mod = mods[cA:cM12][ml_arg]
m["morn_high_mod"] = mh_mod; m["morn_low_mod"] = ml_mod
m["morn_high"] = np.nanmax(Ha[:, cA:cM12], axis=1)
m["morn_low"]  = np.nanmin(La[:, cA:cM12], axis=1)
# full RTH extremes and their timing
rh_arg = np.nanargmax(Ha[:, cA:cRE], axis=1); rh_mod = mods[cA:cRE][rh_arg]
rl_arg = np.nanargmin(La[:, cA:cRE], axis=1); rl_mod = mods[cA:cRE][rl_arg]
m["rth_high_mod"] = rh_mod; m["rth_low_mod"] = rl_mod
m["rth_high"] = np.nanmax(Ha[:, cA:cRE], axis=1)
m["rth_low"]  = np.nanmin(La[:, cA:cRE], axis=1)
# did the opening candle set the RTH extreme?
m["oc_set_rth_high"] = (m["rth_high_mod"] < 585) & (np.abs(m["rth_high"] - oc_h) < 1e-6)
m["oc_set_rth_low"]  = (m["rth_low_mod"]  < 585) & (np.abs(m["rth_low"]  - oc_l) < 1e-6)
# is the 09:45 print already the running RTH extreme so far?
m["p0945_is_high_sofar"] = np.abs(oc_c - oc_h) < 1e-6
m["p0945_is_low_sofar"]  = np.abs(oc_c - oc_l) < 1e-6

# ---- windowed extreme timing for the fresh-extreme reversal test (H2B, causal) ----
# For a closed past window [a,b): the mod of the high and of the low, price-anchored.
def win_ext(a, b):
    ca, cb = col(a), col(b)
    ha = np.nanargmax(Ha[:, ca:cb], axis=1); la = np.nanargmin(La[:, ca:cb], axis=1)
    return mods[ca:cb][ha], mods[ca:cb][la]
for (a, b, tag) in [(570, 630, "1030"), (570, 615, "1015"),
                    (600, 660, "1100"), (630, 690, "1130")]:
    hm, lm = win_ext(a, b)
    m[f"fhw{tag}_hi_mod"] = hm; m[f"fhw{tag}_lo_mod"] = lm

# ---- opening-range break (H5): first break of 09:30-09:45 range after 09:45 ----
orh, orl = oc_h, oc_l
# scan mods 585..719 for first bar whose high>orh (up) or low<orl (down)
brk_dir = np.zeros(len(days)); brk_mod = np.full(len(days), np.nan)
seg_h = Ha[:, col(585):col(720)]; seg_l = La[:, col(585):col(720)]
seg_mods = mods[col(585):col(720)]
up_hit = seg_h > orh[:, None]; dn_hit = seg_l < orl[:, None]
for i in range(len(days)):
    uidx = np.where(up_hit[i])[0]; didx = np.where(dn_hit[i])[0]
    fu = uidx[0] if len(uidx) else 10**9
    fd = didx[0] if len(didx) else 10**9
    if fu == fd == 10**9:
        continue
    if fu <= fd:
        brk_dir[i] = 1; brk_mod[i] = seg_mods[fu]
    else:
        brk_dir[i] = -1; brk_mod[i] = seg_mods[fd]
m["or15_break_dir"] = brk_dir
m["or15_break_mod"] = brk_mod

# ---- 10:00 event vol proxy: realized range 10:00-10:05 / atr ----
c600, c605 = col(600), col(605)
rng_1000 = (np.nanmax(Ha[:, c600:c605], axis=1) - np.nanmin(La[:, c600:c605], axis=1))
m["vol_1000_5m_atr"] = rng_1000 / atr
# comparable baseline: realized 5m range at 11:00-11:05
c660, c665 = col(660), col(665)
m["vol_1100_5m_atr"] = (np.nanmax(Ha[:, c660:c665], axis=1) - np.nanmin(La[:, c660:c665], axis=1)) / atr

# qualify
core = ["p0930", "p0945", "p1000", "p1030", "p1045", "p1200", "atr14_prior"]
q = m["full_rth"].fillna(False) & m["rth_same_sym"].fillna(False)
for c in core:
    q &= m[c].notna()
q &= m["atr14_prior"].gt(0)
m = m[q].copy()
m.to_csv("R4-marks.csv")
print(f"R4-marks: {len(m)} days, years {sorted(m.year.dropna().unique().tolist())}")

# ---- minute-returns long table (H3/H4): mod 570..839 (incl. midday control band) ----
qmods = [x for x in range(570, 840)]
cc = C.reindex(index=m.index)
rows = []
prevmod = {qmods[i]: qmods[i]-1 for i in range(len(qmods))}
Cm = cc.to_numpy(); cidx = {int(x): j for j, x in enumerate(cc.columns.to_numpy())}
yr = m["year"].to_numpy(); at = m["atr14_prior"].to_numpy()
for mm in qmods:
    if mm not in cidx or (mm-1) not in cidx:
        continue
    ret = Cm[:, cidx[mm]] - Cm[:, cidx[mm-1]]
    good = np.isfinite(ret)
    sub = pd.DataFrame({"trade_date": m.index[good], "year": yr[good].astype(int),
                        "mod": mm, "ret_pts": ret[good], "ret_atr": ret[good]/at[good]})
    rows.append(sub)
mr = pd.concat(rows, ignore_index=True)
mr.to_csv("R4-minute-returns.csv", index=False)
print(f"R4-minute-returns: {len(mr)} rows, mods 570..719")
