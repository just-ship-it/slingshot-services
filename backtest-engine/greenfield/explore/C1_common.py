"""C1 price-structure level census — shared machinery.

Greenfield charter compliant: inputs are ONLY the prebuilt greenfield caches.
All times ET. Trading day (td) = 18:00 ET -> 17:00 ET next day, minute-of-td
tmin in [0, 1380): ON = [0,930), RTH = [930,1320), late = [1320,1380).

Knowability convention: a 1m bar stamped T covers [T, T+60s) and is usable at
T+120s (close + 60s). A level derived from bar(s) ending at stamp T therefore
activates at tmin(T) + 2. Touch outcomes are measured from the bar AFTER the
touch bar (the touch itself is knowable only at the touch bar's close).
"""
import os
import zlib
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
NQ_1M = os.path.join(HERE, "cache", "NQ_1m_primary.csv")
ES_1M = os.path.join(HERE, "cache", "ES_1m_primary.csv")
DAYS = os.path.join(HERE, "cache", "NQ_daily_sessions.csv")

TD_END = 1380
RTH_O, RTH_C = 930, 1320

# --- point-space parameters (NQ). ES pass rescales these by ATR ratio. ---
P = dict(
    arm=25.0,            # must be >= this far away before a touch can count
    tols=(2.0, 5.0, 10.0),
    tol_main=5.0,
    brk=5.0,             # "break" = penetration beyond level by > this
    race_r=(15.0, 35.0), # retrace targets for race metrics
    race_w=(60, 120),    # race windows (minutes)
    horizons=(5, 15, 30, 60),
    swing_kill=15.0,     # swing level dies on 1m close beyond by > this
    swing_life_td=3,     # swing max lifetime in trading days
    mt_bin=2.0, mt_tol=3.0,   # multi-touch bin grid / visit tolerance
    vap_bin=5.0, vap_sep=25.0,
    conf_d=5.0,          # confluence distance
    rand_lo=30.0, rand_hi=120.0, n_seeds=3,
    round_grid=100.0,
    reenter=2.0,         # spring re-entry: back on origin side by >= this
)


def load_days():
    d = pd.read_csv(DAYS, parse_dates=["trade_date"])
    d["td"] = d["trade_date"].dt.strftime("%Y-%m-%d")
    return d.set_index("td", drop=False)


def load_bars(path=NQ_1M):
    df = pd.read_csv(path)
    if "et_hhmm" not in df.columns:
        raise ValueError("expected ET-annotated cache")
    hh = df["et_hhmm"].values // 100
    mm = df["et_hhmm"].values % 100
    mins = hh * 60 + mm
    ev = mins >= 1080  # >= 18:00 -> belongs to next calendar day's td
    tmin = np.where(ev, mins - 1080, mins + 360).astype(np.int32)
    et = pd.to_datetime(df["et_date"])
    td = np.where(ev, (et + pd.Timedelta(days=1)).dt.strftime("%Y-%m-%d"),
                  et.dt.strftime("%Y-%m-%d"))
    cols = {"o": "o", "h": "h", "l": "l", "c": "c", "v": "v"}
    out = pd.DataFrame({
        "td": td, "tmin": tmin,
        "o": df[cols["o"]].astype(np.float64),
        "h": df[cols["h"]].astype(np.float64),
        "l": df[cols["l"]].astype(np.float64),
        "c": df[cols["c"]].astype(np.float64),
        "v": df[cols["v"]].astype(np.float64),
        "symbol": df["symbol"].values,
    })
    return out


def day_arrays(bars):
    """dict td -> dict of numpy arrays, single-symbol days only."""
    out = {}
    for td, g in bars.groupby("td", sort=True):
        syms = g["symbol"].unique()
        out[td] = dict(
            tmin=g["tmin"].values, o=g["o"].values, h=g["h"].values,
            l=g["l"].values, c=g["c"].values, v=g["v"].values,
            nsym=len(syms), sym=syms[0] if len(syms) == 1 else None,
        )
    return out


def usable_tds(days, day_map, start=None, end=None):
    """tds safe for the census: in day cache, full RTH, single symbol,
    no roll in day, ATR available."""
    tds = []
    for td, row in days.iterrows():
        if start and td < start:
            continue
        if end and td > end:
            continue
        if td not in day_map or day_map[td]["nsym"] != 1:
            continue
        if bool(row.get("roll_in_day", False)):
            continue
        if not np.isfinite(row.get("atr14_prior", np.nan)):
            continue
        if not bool(row.get("full_rth", True)):
            continue
        tds.append(td)
    return tds


# ---------------------------------------------------------------- touches ---

def touch_events(h, l, L, i0, i1, tol, arm):
    """Touch events for one level over active bar window [i0, i1).
    L: scalar or full-day array (dynamic level). Returns [(i, side)] where
    side 'b' = approach from below (level acts as resistance),
    'a' = approach from above (support). Requires an armed bar (>= arm pts
    away on that side) after activation and after any prior touch."""
    if i1 - i0 < 2:
        return []
    Ls = L[i0:i1] if isinstance(L, np.ndarray) else L
    hs, ls_ = h[i0:i1], l[i0:i1]
    ev = []
    for side in ("b", "a"):
        if side == "b":
            armc = hs <= Ls - arm
            tc = hs >= Ls - tol
        else:
            armc = ls_ >= Ls + arm
            tc = ls_ <= Ls + tol
        if not tc.any() or not armc.any():
            continue
        tprev = np.concatenate(([False], tc[:-1]))
        tstarts = np.flatnonzero(tc & ~tprev)
        aidx = np.flatnonzero(armc)
        last = -1
        for t in tstarts:
            p = np.searchsorted(aidx, t)
            if p > 0 and aidx[p - 1] > last:
                ev.append((i0 + int(t), side))
                last = t
    ev.sort()
    return ev


def outcomes(h, l, c, i, dn, L, side):
    """Forward outcomes for a touch at day-bar index i (level value L frozen).
    dn = number of bars in day. All forward stats use bars i+1.. only.
    Returns dict."""
    sgn = 1.0 if side == "b" else -1.0
    o = {}
    o["pen0"] = sgn * (h[i] - L) if side == "b" else (L - l[i])
    o["close_rel"] = sgn * (c[i] - L)
    j0, j1 = i + 1, min(i + 1 + 120, dn)
    o["valid_min"] = dn - (i + 1)
    if j1 <= j0:
        for H in P["horizons"]:
            o[f"pen{H}"] = np.nan
            o[f"ret{H}"] = np.nan
        o["t_brk"] = -1
        o["t_r15"] = -1
        o["t_r35"] = -1
        o["t_reenter"] = -1
        return o
    hh, ll = h[j0:j1], l[j0:j1]
    if side == "b":
        pen = hh - L
        ret = L - ll
    else:
        pen = L - ll
        ret = hh - L
    pmax = np.maximum.accumulate(pen)
    rmax = np.maximum.accumulate(ret)
    for H in P["horizons"]:
        if len(pen) >= H:
            o[f"pen{H}"] = pmax[H - 1]
            o[f"ret{H}"] = rmax[H - 1]
        else:
            o[f"pen{H}"] = np.nan
            o[f"ret{H}"] = np.nan
    bmask = pen > P["brk"]
    o["t_brk"] = int(np.argmax(bmask)) + 1 if bmask.any() else -1
    for tag, R in (("t_r15", P["race_r"][0]), ("t_r35", P["race_r"][1])):
        m = ret >= R
        o[tag] = int(np.argmax(m)) + 1 if m.any() else -1
    # spring re-entry: after a break, first bar back on origin side by >= reenter
    o["t_reenter"] = -1
    if o["t_brk"] > 0:
        k = o["t_brk"] - 1  # index into pen/ret arrays
        if side == "b":
            back = ll[k:] <= L - P["reenter"]
        else:
            back = hh[k:] >= L + P["reenter"]
        if back.any():
            o["t_reenter"] = k + int(np.argmax(back)) + 1
    return o


def race(t_r, t_brk, window, valid_min):
    """1 = retrace target first, 0 = break first, nan = unresolved/invalid."""
    tr = t_r if 0 < t_r <= window else 10 ** 9
    tb = t_brk if 0 < t_brk <= window else 10 ** 9
    if tr == tb == 10 ** 9:
        return np.nan if valid_min < window else 0.5  # neither -> neutral
    return 1.0 if tr < tb else 0.0


def rand_offset(level_id, seed, lo=None, hi=None):
    lo = P["rand_lo"] if lo is None else lo
    hi = P["rand_hi"] if hi is None else hi
    hsh = zlib.crc32(f"{level_id}|{seed}".encode()) & 0xFFFFFFFF
    rng = np.random.default_rng(hsh)
    mag = rng.uniform(lo, hi)
    sign = 1.0 if rng.random() < 0.5 else -1.0
    return sign * mag


# ------------------------------------------------------------ aggregation ---

def agg_bars(tmin, o, h, l, c, v, tf):
    """Aggregate a day's 1m arrays to tf-minute bars aligned to tmin//tf.
    Returns (bar_start_tmin, o, h, l, c, v) arrays; only buckets with data."""
    b = tmin // tf
    ub, inv = np.unique(b, return_inverse=True)
    n = len(ub)
    ah = np.full(n, -np.inf)
    al = np.full(n, np.inf)
    av = np.zeros(n)
    ao = np.zeros(n)
    ac = np.zeros(n)
    np.maximum.at(ah, inv, h)
    np.minimum.at(al, inv, l)
    np.add.at(av, inv, v)
    first = np.full(n, -1, dtype=int)
    for i in range(len(inv) - 1, -1, -1):
        first[inv[i]] = i
    last = np.full(n, -1, dtype=int)
    for i in range(len(inv)):
        last[inv[i]] = i
    ao = o[first]
    ac = c[last]
    return ub * tf, ao, ah, al, ac, av


def fractal_swings(bh, bl, N):
    """Strict fractal swing highs/lows on aggregated bars.
    Returns list of (bar_idx, 'H'|'L', price, confirm_bar_idx)."""
    out = []
    n = len(bh)
    for j in range(N, n - N):
        ws, we = j - N, j + N + 1
        if bh[j] > np.max(np.delete(bh[ws:we], N)):
            out.append((j, "H", bh[j], j + N))
        if bl[j] < np.min(np.delete(bl[ws:we], N)):
            out.append((j, "L", bl[j], j + N))
    return out


def atr1m_series(h, l, c):
    """Causal 14-bar SMA ATR on the day's 1m bars (NaN for first 14)."""
    n = len(h)
    tr = np.empty(n)
    tr[0] = h[0] - l[0]
    pc = c[:-1]
    tr[1:] = np.maximum(h[1:], pc) - np.minimum(l[1:], pc)
    out = np.full(n, np.nan)
    if n >= 14:
        cs = np.concatenate(([0.0], np.cumsum(tr)))
        out[13:] = (cs[14:] - cs[:-14]) / 14.0
    return out


def vap_profile(prices, vols, binw):
    """Volume-at-price histogram: dict bin_center -> volume."""
    b = np.round(prices / binw).astype(np.int64)
    prof = {}
    for bi, vv in zip(b, vols):
        prof[bi] = prof.get(bi, 0.0) + vv
    return {k * binw: v for k, v in prof.items()}


def vap_nodes(prof, sep, max_hvn=2):
    """POC + up to max_hvn secondary local maxima >= sep away."""
    if not prof:
        return []
    items = sorted(prof.items())
    px = np.array([p for p, _ in items])
    vv = np.array([v for _, v in items])
    poc = px[int(np.argmax(vv))]
    nodes = [("PDPOC", float(poc))]
    # local maxima
    cand = []
    for k in range(1, len(px) - 1):
        if vv[k] >= vv[k - 1] and vv[k] >= vv[k + 1]:
            cand.append((vv[k], px[k]))
    cand.sort(reverse=True)
    for _, p in cand:
        if all(abs(p - q) >= sep for _, q in nodes):
            nodes.append(("PDHVN", float(p)))
            if len(nodes) >= 1 + max_hvn:
                break
    return nodes


def tod_bucket(tmin):
    if tmin < 600:
        return "ON_early"      # 18:00-04:00
    if tmin < 930:
        return "premkt"        # 04:00-09:30
    if tmin < 1020:
        return "rth_open"      # 09:30-11:00
    if tmin < 1200:
        return "midday"        # 11:00-14:00
    if tmin < 1320:
        return "rth_close"     # 14:00-16:00
    return "late"              # 16:00-17:00
