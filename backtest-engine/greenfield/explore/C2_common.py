"""C2 trend / parallel-channel census — shared machinery.

Greenfield charter compliant. Inputs are ONLY the prebuilt greenfield caches
(cache_nq_primary_1m via C1_common's NQ_1m_primary + NQ_daily_sessions + ES).
All times ET. Reuses C1_common for bar loading, aggregation, fractal swings,
ATR, placebo RNG.

CAUSALITY CONTRACT (the central trap for channels)
--------------------------------------------------
A channel frozen at HTF bar i uses ONLY bars whose CLOSE <= the freeze instant.
Every touch / outcome we evaluate happens STRICTLY AFTER the freeze instant.

Knowability (inherited from C1): a 1m bar stamped at tmin T covers [T, T+1)
and is usable at T+2 (close + 1 more minute). An HTF bar occupying 1m tmins
[s, s+tf) closes with the 1m bar stamped s+tf-1, usable at s+tf+1. Therefore a
channel frozen on HTF bars up to and including bar i (which ends at s_i+tf)
becomes EVALUABLE at 1m tmin >= s_i+tf+1. We store freeze_end = s_i+tf (the
bar's close minute) and require every forward evaluation index > freeze_end,
starting the walk at tmin >= freeze_end+1. No forward datum is ever used to
build the channel.

Rail reconstruction (for a 1s follow-up): at any future minute t,
    mid(t) = price_end + slope_pm * (t - freeze_end)
    upper(t) = mid(t) + W ,  lower(t) = mid(t) - W
where price_end is the regression value at the window's last bar (time
freeze_end), slope_pm is slope in points/MINUTE, and W is the half-width.
All three are frozen at build time.
"""
import os
import zlib
import numpy as np
import pandas as pd

import C1_common as C1

HERE = os.path.dirname(os.path.abspath(__file__))
RTH_O, RTH_C = C1.RTH_O, C1.RTH_C        # 930, 1320 (tmin of 09:30, 16:00)
TD_END = C1.TD_END

# ------- channel census parameters (NQ point space) -------
CP = dict(
    tols=(2.0, 5.0, 10.0),      # rail-touch tolerances
    arm=25.0,                   # must be >=this far from a rail before a touch counts
    brk=5.0,                    # break = 1m close beyond rail by > this
    horizons=(5, 15, 30, 60),   # forward horizons (minutes)
    r2_grid=(0.5, 0.7, 0.9),    # "well fit" thresholds
    n_placebo=3,                # random-slope placebo seeds
)

# TF -> list of window lengths K (in HTF bars) to sweep.  Within-RTH only.
# 5m: 78 RTH bars/day.  15m: 26 RTH bars/day.
KGRID = {
    5:  (6, 12, 18, 24),        # 30 / 60 / 90 / 120 min
    15: (4, 8, 12),             # 60 / 120 / 180 min
}


def year_of(td):
    return int(td[:4])


# ------------------------------------------------------------- HTF bars ---

def rth_htf(day, tf):
    """Aggregate one day's RTH 1m arrays to tf-min bars aligned to tmin//tf.
    Returns (start_tmin, o, h, l, c, v) for buckets fully inside RTH.
    RTH_O=930 is divisible by 5 and 15 so buckets align cleanly for those tf.
    """
    T = day["tmin"]
    m = (T >= RTH_O) & (T < RTH_C)
    if m.sum() < tf:
        return None
    bt, o, h, l, c, v = C1.agg_bars(T[m], day["o"][m], day["h"][m], day["l"][m],
                                    day["c"][m], day["v"][m], tf)
    # keep only buckets whose full span is inside RTH
    keep = (bt >= RTH_O) & (bt + tf <= RTH_C)
    return (bt[keep], o[keep], h[keep], l[keep], c[keep], v[keep])


# ----------------------------------------------------- rolling OLS fit ---

def rolling_linreg(y, K):
    """Vectorised trailing OLS of y[i-K+1..i] on local x=0..K-1, for every i>=K-1.
    Returns dict of arrays (length = len(y)-K+1, aligned to window END index i):
      slope_pb (pts/bar), price_end (fit value at last bar), r2, sigma,
      maxdev (max |residual| in window), end_idx (i).
    """
    n = len(y)
    if n < K:
        return None
    W = np.lib.stride_tricks.sliding_window_view(y, K)   # (n-K+1, K)
    x = np.arange(K, dtype=np.float64)
    Sx = x.sum(); Sxx = (x * x).sum()
    Sy = W.sum(1)
    Sxy = W @ x
    denom = K * Sxx - Sx * Sx
    b = (K * Sxy - Sx * Sy) / denom
    a = (Sy - b * Sx) / K
    yhat = a[:, None] + b[:, None] * x[None, :]
    resid = W - yhat
    ss_res = (resid * resid).sum(1)
    ymean = Sy / K
    ss_tot = ((W - ymean[:, None]) ** 2).sum(1)
    r2 = np.where(ss_tot > 1e-9, 1.0 - ss_res / ss_tot, np.nan)
    sigma = np.sqrt(ss_res / max(K - 2, 1))
    maxdev = np.abs(resid).max(1)
    price_end = a + b * (K - 1)
    end_idx = np.arange(K - 1, n)
    return dict(slope_pb=b, price_end=price_end, r2=r2, sigma=sigma,
                maxdev=maxdev, end_idx=end_idx)


# --------------------------------------------------------- placebo RNG ---

def placebo_slope(base_id, seed, slope_pool):
    """Random-slope placebo: draw a slope magnitude from the empirical pool,
    random sign, deterministic from (base_id, seed)."""
    h = zlib.crc32(f"{base_id}|slp|{seed}".encode()) & 0xFFFFFFFF
    rng = np.random.default_rng(h)
    mag = rng.choice(slope_pool)
    sign = 1.0 if rng.random() < 0.5 else -1.0
    return sign * abs(mag)


def load_nq():
    days = C1.load_days()
    bars = C1.load_bars(C1.NQ_1M)
    dm = C1.day_arrays(bars)
    use = C1.usable_tds(days, dm)
    return days, dm, use


def es_day_meta(dm, tds):
    """Per-day ATR14(prior) + RTH counts for ES (mirrors C1-50-es.py)."""
    rows = []
    prev_close = np.nan
    atr_hist = []
    for td in tds:
        d = dm[td]
        T = d["tmin"]
        rth = (T >= RTH_O) & (T < RTH_C)
        on = T < RTH_O
        hi, lo, cl = d["h"].max(), d["l"].min(), d["c"][-1]
        tr = hi - lo if not np.isfinite(prev_close) else max(hi, prev_close) - min(lo, prev_close)
        atr14 = np.mean(atr_hist[-14:]) if len(atr_hist) >= 14 else np.nan
        rows.append(dict(td=td, sym=d["sym"], n_rth=int(rth.sum()), n_on=int(on.sum()),
                         atr14_prior=atr14))
        atr_hist.append(tr)
        prev_close = cl
    return pd.DataFrame(rows).set_index("td", drop=False)


def close_map(dm, tds):
    """td -> (close, high, low) arrays indexed by 1m tmin (NaN elsewhere)."""
    out = {}
    for td in tds:
        d = dm[td]
        c = np.full(TD_END + 120, np.nan); c[d["tmin"]] = d["c"]
        h = np.full(TD_END + 120, np.nan); h[d["tmin"]] = d["h"]
        l = np.full(TD_END + 120, np.nan); l[d["tmin"]] = d["l"]
        out[td] = (c, h, l)
    return out


def eval_channel(cm, td, fe, price_end, slope_pm, W, atr, tf, K):
    """Evaluate one frozen channel forward on 1m bars. Returns (touches, break).
    Rail(t)=price_end+slope_pm*(t-fe); lifetime = K*tf minutes; RTH only.
    Touch = first approach within TOL to a rail after being >=ARM inside.
    rev{H} = movement back toward mid (into channel), ATR units (+=reversion)."""
    HZ = CP["horizons"]; ARM = CP["arm"]; TOL = 5.0; BRK = CP["brk"]
    if td not in cm:
        return [], None
    c, h, l = cm[td]
    life = int(K * tf)
    t0, t1 = fe + 1, min(fe + life, RTH_C - 1)
    if t1 - t0 < 5:
        return [], None
    ts = np.arange(t0, t1 + 1)
    mid = price_end + slope_pm * (ts - fe)
    up = mid + W; lo = mid - W
    ch = h[ts]; cl = l[ts]; cc = c[ts]
    touches = []
    for side, rail, ext in (("up", up, ch), ("lo", lo, cl)):
        if side == "up":
            armed = ext <= rail - ARM; near = ext >= rail - TOL
        else:
            armed = ext >= rail + ARM; near = ext <= rail + TOL
        if not (armed.any() and near.any()):
            continue
        first_arm = int(np.argmax(armed))
        cand = np.flatnonzero(near); cand = cand[cand > first_arm]
        if len(cand) == 0:
            continue
        k = int(cand[0]); railk = rail[k]; rev = {}
        for H in HZ:
            j = k + H
            if j < len(ts):
                rev[H] = ((railk - cc[j]) if side == "up" else (cc[j] - railk)) / atr
            else:
                rev[H] = np.nan
        touches.append(dict(side=side, **{f"rev{H}": rev[H] for H in HZ}))
    brk = None
    bu = cc > up + BRK; bl_ = cc < lo - BRK
    bidx = 10**9; bside = None
    if bu.any():
        bidx = int(np.argmax(bu)); bside = "up"
    if bl_.any():
        bi2 = int(np.argmax(bl_))
        if bi2 < bidx:
            bidx = bi2; bside = "lo"
    if bside is not None:
        cont = {}; rk = (up if bside == "up" else lo)[bidx]
        for H in HZ:
            j = bidx + H
            cont[H] = (((cc[j] - rk) if bside == "up" else (rk - cc[j])) / atr) if j < len(ts) else np.nan
        brk = dict(side=bside, **{f"cont{H}": cont[H] for H in HZ})
    return touches, brk


def load_es():
    bars = C1.load_bars(C1.ES_1M)
    dm = C1.day_arrays(bars)
    tds_all = sorted(dm.keys())
    meta = es_day_meta(dm, tds_all)
    use = [td for td in tds_all
           if dm[td]["nsym"] == 1 and meta.loc[td, "n_rth"] >= 370
           and np.isfinite(meta.loc[td, "atr14_prior"])]
    return dm, meta, use
