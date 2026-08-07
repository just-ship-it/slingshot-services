#!/usr/bin/env python3
"""ODTE-flow P1 / H2b — the DIRECTIONAL 'mean-reversion level' test (what H2's blunt autocorr would miss).

Two direct tests of Drew's 'levels where indices mean-revert' thesis:

(A) PIN ATTRACTION. Map the intraday 0DTE positive-gamma magnet (pin_pos, QQQ) to NQ via the live ratio.
    displacement = pin_nq - nq_T  (signed dist to pin). Does NQ move TOWARD the pin over next H?
    attraction slope = OLS slope of fwd_move on displacement (both / prev_range); >0 = reverts to pin.
    Compare LONG-gamma (dealers defend pin -> expect attraction) vs SHORT-gamma vs PLACEBO level
    (prior-day close mapped to NQ, run through identical machinery — pin must beat placebo).

(B) GAMMA ASYMMETRY -> DIRECTION. cg_imb = (gamma above spot - below)/|tot|. Does it predict signed fwd move?
    On long-gamma, dealers longer-gamma-above should cap upside / support -> test sign of E[fwd | cg_imb].

Causal: snapshot T uses trades<=T; fwd measured T->T+H on NQ continuous 1m. 10:00-15:00 ET. Per-quarter shown.
"""
import numpy as np
import pandas as pd
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
ET = ZoneInfo("America/New_York")
RNG = np.random.default_rng(20260723)
H = 30


def load_nq():
    df = pd.read_csv(f"{BASE}/data/ohlcv/nq/NQ_ohlcv_1m_continuous.csv", usecols=["ts_event", "high", "low", "close"])
    ts = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(ET)
    df["date"] = ts.dt.strftime("%Y-%m-%d")
    df["etmin"] = (ts.dt.hour*60 + ts.dt.minute).astype(int)
    df = df[df["date"] >= "2025-01-15"]
    close = {(r.date, r.etmin): r.close for r in df.itertuples()}
    hilo = df.groupby("date").agg(hi=("high", "max"), lo=("low", "min")).reset_index()
    hilo["prev_range"] = (hilo["hi"] - hilo["lo"]).shift(1)
    hilo["prev_close_nq"] = hilo["close"] if "close" in hilo else None
    # prev day's last close:
    lastclose = df.groupby("date")["close"].last()
    prevclose = lastclose.shift(1)
    return close, dict(zip(hilo["date"], hilo["prev_range"])), dict(prevclose)


def slope(x, y):
    x, y = np.asarray(x), np.asarray(y)
    m = np.isfinite(x) & np.isfinite(y)
    x, y = x[m], y[m]
    if len(x) < 20 or x.std() == 0:
        return np.nan, 0
    return np.polyfit(x, y, 1)[0], len(x)


def boot_slope_p(x, y):
    """H0: slope=0 via y-permutation."""
    x, y = np.asarray(x), np.asarray(y)
    m = np.isfinite(x) & np.isfinite(y)
    x, y = x[m], y[m]
    if len(x) < 20:
        return np.nan
    obs = np.polyfit(x, y, 1)[0]
    n = len(x); d = np.empty(3000)
    for i in range(3000):
        d[i] = np.polyfit(x, RNG.permutation(y), 1)[0]
    return (np.abs(d) >= abs(obs)).mean()


def main():
    snaps = pd.read_csv(f"{BASE}/research/odte-flow/qqq-0dte-intraday.csv")
    snaps = snaps[(snaps["et_min"] >= 600) & (snaps["et_min"] <= 900)].copy()
    close, prev_range, prevclose = load_nq()

    rows = []
    for r in snaps.itertuples():
        d, T = r.date, r.et_min
        pr = prev_range.get(d); nqT = close.get((d, T)); nqH = close.get((d, T + H))
        if not pr or pr <= 0 or nqT is None or nqH is None or not r.spot_qqq:
            continue
        ratio = nqT / r.spot_qqq
        pin_nq = r.pin_pos * ratio
        pc = prevclose.get(d)
        rows.append(dict(date=d, quarter=str(pd.Period(d, freq="Q")), sign=r.net0_sign,
                         cg_imb=r.cg_imb,
                         disp_pin=(pin_nq - nqT) / pr,
                         disp_pc=((pc - nqT) / pr) if pc else np.nan,
                         fwd=(nqH - nqT) / pr))
    df = pd.DataFrame(rows)
    print(f"{len(df)} snapshots, {df.date.nunique()} days. H={H}min")
    print(f"pin displacement: median |disp|={df['disp_pin'].abs().median():.4f} xRange "
          f"(pin sits ~{df['disp_pin'].abs().median():.2f} prev-ranges from spot)")

    print(f"\n{'='*90}\n(A) PIN ATTRACTION — OLS slope of fwd on displacement (>0 = reverts toward level)\n{'='*90}")
    for tag, mask in [("LONG-gamma", df["sign"] == 1), ("SHORT-gamma", df["sign"] == -1), ("ALL", df["sign"] != 0)]:
        s = df[mask]
        sl, n = slope(s["disp_pin"], s["fwd"]); p = boot_slope_p(s["disp_pin"], s["fwd"])
        slp, _ = slope(s["disp_pc"], s["fwd"]); pp = boot_slope_p(s["disp_pc"], s["fwd"])
        print(f"  {tag:11s} | PIN slope={sl:+.4f} p={p:.3f} (n={n}) | PLACEBO(prevclose) slope={slp:+.4f} p={pp:.3f}")

    print(f"\n  per-quarter PIN attraction slope (LONG-gamma):")
    for q in sorted(df["quarter"].unique()):
        s = df[(df["quarter"] == q) & (df["sign"] == 1)]
        sl, n = slope(s["disp_pin"], s["fwd"])
        print(f"    {q}: slope={sl:+.4f} (n={n})")

    print(f"\n{'='*90}\n(B) GAMMA ASYMMETRY (cg_imb) -> signed forward move\n{'='*90}")
    for tag, mask in [("LONG-gamma", df["sign"] == 1), ("SHORT-gamma", df["sign"] == -1), ("ALL", df["sign"] != 0)]:
        s = df[mask]
        sl, n = slope(s["cg_imb"], s["fwd"]); p = boot_slope_p(s["cg_imb"], s["fwd"])
        print(f"  {tag:11s} | slope(fwd on cg_imb)={sl:+.5f} p={p:.3f} (n={n})")
    # terciles of cg_imb -> mean fwd (directional)
    df["imb_t"] = pd.qcut(df["cg_imb"], 3, labels=["gamma_below", "mid", "gamma_above"])
    print("  cg_imb terciles -> mean signed fwd move (xRange):")
    print("   ", df.groupby("imb_t", observed=True)["fwd"].mean().round(4).to_dict())


if __name__ == "__main__":
    main()
