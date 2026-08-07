#!/usr/bin/env python3
"""ODTE-flow P1 / H2c — is the 0DTE-gamma-sign vol effect INCREMENTAL over recent realized vol?

H2 confirmed: dealer-LONG 0DTE gamma -> NQ forward range compresses; SHORT -> expands (significant).
But 0DTE gamma sign may just be a PROXY for recent realized vol (vol clustering = A1, our strongest prior
signal). Decisive test: does gamma sign still separate forward vol AFTER controlling for recent vol?

recent_vol = (max-min of NQ close over [T-30,T]) / prev_range   (price-only vol-clustering baseline)
target     = fwdrng30 = (max-min close over [T,T+30]) / prev_range

Tests:
  (1) within recent_vol TERCILES, does long vs short gamma still separate fwdrng30? (incremental if yes)
  (2) 2-var OLS: fwdrng30 ~ recent_vol + gamma_sign — is the gamma coefficient significant?
  (3) how much of gamma-sign's raw separation survives the recent-vol control?
"""
import numpy as np
import pandas as pd
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
ET = ZoneInfo("America/New_York")
RNG = np.random.default_rng(20260723)


def load_nq():
    df = pd.read_csv(f"{BASE}/data/ohlcv/nq/NQ_ohlcv_1m_continuous.csv", usecols=["ts_event", "high", "low", "close"])
    ts = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(ET)
    df["date"] = ts.dt.strftime("%Y-%m-%d")
    df["etmin"] = (ts.dt.hour*60 + ts.dt.minute).astype(int)
    df = df[df["date"] >= "2025-01-15"]
    close = {(r.date, r.etmin): r.close for r in df.itertuples()}
    hilo = df.groupby("date").agg(hi=("high", "max"), lo=("low", "min")).reset_index()
    hilo["prev_range"] = (hilo["hi"] - hilo["lo"]).shift(1)
    return close, dict(zip(hilo["date"], hilo["prev_range"]))


def rng_over(close, d, a, b):
    xs = [close.get((d, m)) for m in range(a, b + 1)]
    xs = [x for x in xs if x is not None]
    return (max(xs) - min(xs)) if len(xs) >= 2 else np.nan


def boot_diff_p(a, b):
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if len(a) < 10 or len(b) < 10:
        return np.nan
    obs = a.mean() - b.mean(); pool = np.concatenate([a, b]); n1 = len(a); d = np.empty(4000)
    for i in range(4000):
        RNG.shuffle(pool); d[i] = pool[:n1].mean() - pool[n1:].mean()
    return (np.abs(d) >= abs(obs)).mean()


def main():
    snaps = pd.read_csv(f"{BASE}/research/odte-flow/qqq-0dte-intraday.csv")
    snaps = snaps[(snaps["et_min"] >= 600) & (snaps["et_min"] <= 900)].copy()
    close, prev_range = load_nq()
    rows = []
    for r in snaps.itertuples():
        d, T = r.date, r.et_min
        pr = prev_range.get(d)
        if not pr or pr <= 0:
            continue
        rv = rng_over(close, d, T - 30, T)
        fr = rng_over(close, d, T, T + 30)
        if not np.isfinite(rv) or not np.isfinite(fr):
            continue
        rows.append(dict(sign=r.net0_sign, recent_vol=rv/pr, fwdrng=fr/pr))
    df = pd.DataFrame(rows)
    print(f"{len(df)} snapshots")

    # raw separation
    lo = df[df["sign"] == 1]["fwdrng"].values; sh = df[df["sign"] == -1]["fwdrng"].values
    print(f"\nRAW: fwdrng long={lo.mean():+.4f} short={sh.mean():+.4f} Δ={lo.mean()-sh.mean():+.4f} p={boot_diff_p(lo,sh):.3f}")
    print(f"     recent_vol long={df[df['sign']==1]['recent_vol'].mean():.4f} short={df[df['sign']==-1]['recent_vol'].mean():.4f}  "
          f"(<- if these differ, gamma sign is partly a vol proxy)")

    print(f"\n{'='*80}\n(1) within recent_vol terciles: does gamma sign STILL separate fwdrng?\n{'='*80}")
    df["rv_t"] = pd.qcut(df["recent_vol"], 3, labels=["lowvol", "midvol", "highvol"])
    for t in ["lowvol", "midvol", "highvol"]:
        s = df[df["rv_t"] == t]
        l = s[s["sign"] == 1]["fwdrng"].values; h = s[s["sign"] == -1]["fwdrng"].values
        print(f"  {t:8s} rv_mean={s['recent_vol'].mean():.3f} | long={l.mean():+.4f}(n={len(l)}) "
              f"short={h.mean():+.4f}(n={len(h)}) Δ={l.mean()-h.mean():+.4f} p={boot_diff_p(l,h):.3f}")

    print(f"\n{'='*80}\n(2) OLS: fwdrng ~ 1 + recent_vol + gamma_sign  (is gamma coef significant?)\n{'='*80}")
    X = np.column_stack([np.ones(len(df)), df["recent_vol"].values, df["sign"].values.astype(float)])
    y = df["fwdrng"].values
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    sigma2 = resid @ resid / (len(y) - 3)
    cov = sigma2 * np.linalg.inv(X.T @ X)
    se = np.sqrt(np.diag(cov))
    names = ["const", "recent_vol", "gamma_sign"]
    for nm, b, s in zip(names, beta, se):
        t = b / s
        print(f"  {nm:11s} coef={b:+.5f} se={s:.5f} t={t:+.2f}")
    # gamma_sign coef: +1=long -> if negative, long compresses fwd vol controlling for recent vol
    print(f"\n  -> gamma_sign |t|>1.96 means the vol effect is INCREMENTAL over recent realized vol.")
    # variance explained
    r2_full = 1 - resid @ resid / ((y - y.mean()) @ (y - y.mean()))
    Xr = X[:, :2]
    br, *_ = np.linalg.lstsq(Xr, y, rcond=None); rr = y - Xr @ br
    r2_rv = 1 - rr @ rr / ((y - y.mean()) @ (y - y.mean()))
    print(f"  R^2: recent_vol only={r2_rv:.4f} | +gamma_sign={r2_full:.4f} | ΔR^2={r2_full-r2_rv:.5f}")


if __name__ == "__main__":
    main()
