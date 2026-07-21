"""R2-07 (H6): Cross-market execution - does NQ lead/lag ES and QQQ at 1m in
specific windows?

Mechanism: hedge flow executes where liquidity is; if dealers hedge QQQ-option
books in NQ futures (or vice versa), the hedging market moves first and the
other converges - a window-localized lead/lag asymmetry, strongest in hedge
windows (EOD, expiry afternoons).

Measure: per year x window: contemporaneous corr(x_t, y_t), cross corr
(x_t, y_{t+1}) and (y_t, x_{t+1}); lead asymmetry A = corr(x_t,y_{t+1}) -
corr(y_t,x_{t+1}) (A>0: x leads y). Descriptive only; 1m is coarse and mostly
contemporaneous - the honest question is whether asymmetry is stable, not
whether it is tradable.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from R2_common import ROOT, EXP, load_1m, load_sessions

s = load_sessions()
days = set(s["trade_date"])


def prep_fut(sym):
    df = load_1m(sym, usecols=["ts_utc", "et_date", "et_hhmm", "c", "symbol"])
    df = df[df["et_date"].isin(days)].copy()
    c = df["c"].to_numpy()
    r = np.full(len(df), np.nan)
    r[1:] = np.log(c[1:] / c[:-1])
    sy = df["symbol"].to_numpy()
    r[1:][sy[1:] != sy[:-1]] = np.nan
    df["r"] = r
    return df.set_index("ts_utc")[["et_date", "et_hhmm", "r"]]


nq = prep_fut("NQ")
es = prep_fut("ES")
m = nq.join(es[["r"]], rsuffix="_es", how="inner").dropna()
m["year"] = m["et_date"].str[:4].astype(int)

WINDOWS = {"open_0930_1029": (930, 1029), "midday_1130_1359": (1130, 1359),
           "last_1500_1559": (1500, 1559), "europe_0300_0800": (300, 800)}


def leadlag(x, y):
    # consecutive-minute pairs only would need ts arithmetic; shift within the
    # already-window-filtered frame is safe because windows are contiguous and
    # we drop pairs crossing day boundaries via et_date group shift
    return (np.corrcoef(x[:-1], y[1:])[0, 1],
            np.corrcoef(y[:-1], x[1:])[0, 1],
            np.corrcoef(x, y)[0, 1], len(x))


def run_pair(m, xa, xb, name):
    print(f"\n=== {name}: lead asymmetry A = corr({xa}_t,{xb}_t+1) - corr({xb}_t,{xa}_t+1) ===")
    for wname, (a, b) in WINDOWS.items():
        rows = []
        for yr, g in m[(m["et_hhmm"] >= a) & (m["et_hhmm"] <= b)].groupby("year"):
            xs, ys = [], []
            for _, gg in g.groupby("et_date"):
                if len(gg) < 10:
                    continue
                xs.append(gg[xa].to_numpy())
                ys.append(gg[xb].to_numpy())
            cx1 = np.corrcoef(np.concatenate([v[:-1] for v in xs]),
                              np.concatenate([v[1:] for v in ys]))[0, 1]
            cy1 = np.corrcoef(np.concatenate([v[:-1] for v in ys]),
                              np.concatenate([v[1:] for v in xs]))[0, 1]
            c0 = np.corrcoef(np.concatenate(xs), np.concatenate(ys))[0, 1]
            n = sum(len(v) for v in xs)
            rows.append(f"{yr}: c0={c0:.3f} A={cx1-cy1:+.4f} "
                        f"(x>y:{cx1:+.3f} y>x:{cy1:+.3f}) n={n}")
        print(f"  {wname}\n    " + "\n    ".join(rows))


run_pair(m, "r", "r_es", "NQ vs ES")

# NQ vs QQQ (RTH only; QQQ 1m from Databento, ts_event = bar open UTC)
q = pd.read_csv(os.path.join(ROOT, "data/ohlcv/qqq/QQQ_ohlcv_1m.csv"),
                usecols=["ts_event", "close"])
q["ts_utc"] = q["ts_event"].str[:16].str.replace("T", "T", regex=False)
q["ts_utc"] = q["ts_event"].str[:16] + ":00Z"
q = q.sort_values("ts_event")
qc = q["close"].to_numpy()
qr = np.full(len(q), np.nan)
qr[1:] = np.log(qc[1:] / qc[:-1])
ts = pd.to_datetime(q["ts_event"].str[:19])
dtm = np.full(len(q), np.nan)
dtm[1:] = (ts.to_numpy()[1:] - ts.to_numpy()[:-1]) / np.timedelta64(1, "m")
qr[dtm > 5] = np.nan
q["r_qqq"] = qr
q = q.set_index("ts_utc")[["r_qqq"]]

mq = nq.join(q, how="inner").dropna()
mq["year"] = mq["et_date"].str[:4].astype(int)
mq = mq[(mq["et_hhmm"] >= 931) & (mq["et_hhmm"] <= 1559)]
run_pair(mq, "r", "r_qqq", "NQ vs QQQ (RTH)")
