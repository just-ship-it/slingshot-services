#!/usr/bin/env python3
"""
RG2b — rigor pass on the up-gap-confirmed-long edge from RG2.

Adds what RG2 lacked:
  (1) Significance: does the confirmation gate's edge survive randomization?
      Bootstrap — among up-gap(>=thr) days, is the confirmed subset's long return higher than
      random same-size subsets? Empirical p-value.
  (2) Vol-normalization: express P&L in units of that day's volatility (prev-day RTH range).
      Strips the "confirmed days are just high-vol 2022 days" explanation.
  (3) Robustness sweeps: confirmation window {15,20,30}min, tolerance {3,5,8}pt, cutoff {15:45,16:00}.
  (4) Sanity: confirmed-day realized-vol vs unconfirmed, to see if the gate is a vol selector.

Builds a richer per-day table in one pass over NQ continuous 1m and caches it.
"""
import os
import numpy as np
import pandas as pd
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
F = f"{BASE}/data/ohlcv/nq/NQ_ohlcv_1m_continuous.csv"
CACHE = f"{BASE}/greenfield/explore/RG2b-days-rich.csv"
ET = ZoneInfo("America/New_York")
OPEN_HM = 9 * 60 + 30
CLOSE_HM = 16 * 60
C1545 = 15 * 60 + 45
RNG = np.random.default_rng(20260722)


def build_rich():
    df = pd.read_csv(F, usecols=["ts_event", "open", "high", "low", "close"])
    ts = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(ET)
    df["etdate"] = ts.dt.strftime("%Y-%m-%d")
    df["hm"] = (ts.dt.hour * 60 + ts.dt.minute).astype(int)
    df["year"] = ts.dt.year.astype(int)
    rows = []
    prev_close = None
    prev_range = None
    for d, g in df.groupby("etdate", sort=True):
        rth = g[(g["hm"] >= OPEN_HM) & (g["hm"] < CLOSE_HM)]
        if len(rth) < 60:
            if len(rth):
                prev_close = rth.iloc[-1]["close"]
            continue
        ob = rth[rth["hm"] == OPEN_HM]
        if ob.empty:
            prev_close = rth.iloc[-1]["close"]
            continue
        day_open = ob.iloc[0]["open"]
        rec = dict(date=d, year=int(g.iloc[0]["year"]), prev_close=prev_close,
                   prev_range=prev_range, day_open=day_open)
        ok = True
        for w in (15, 20, 30):
            cw = rth[(rth["hm"] >= OPEN_HM) & (rth["hm"] < OPEN_HM + w)]
            eb = rth[rth["hm"] == OPEN_HM + w]
            if cw.empty or eb.empty:
                ok = False
                break
            rec[f"clow{w}"] = cw["low"].min()
            rec[f"chigh{w}"] = cw["high"].max()
            rec[f"entry{w}"] = eb.iloc[0]["open"]
        ex1545 = rth[rth["hm"] <= C1545]
        rec["exit1545"] = ex1545.iloc[-1]["close"] if len(ex1545) else np.nan
        rec["exit1600"] = rth.iloc[-1]["close"]
        rec["rth_high"] = rth["high"].max()
        rec["rth_low"] = rth["low"].min()
        this_range = rec["rth_high"] - rec["rth_low"]
        if ok and prev_close is not None and prev_range is not None:
            rows.append(rec)
        prev_close = rth.iloc[-1]["close"]
        prev_range = this_range
    out = pd.DataFrame(rows)
    out.to_csv(CACHE, index=False)
    return out


def stats_pts(p):
    p = p[np.isfinite(p)]
    if len(p) == 0:
        return dict(n=0, mean=np.nan, wr=np.nan, pf=np.nan, sh=np.nan)
    wins, losses = p[p > 0].sum(), -p[p < 0].sum()
    pf = wins / losses if losses > 0 else np.inf
    sh = p.mean() / p.std(ddof=1) * np.sqrt(len(p)) if len(p) > 1 and p.std() > 0 else np.nan
    return dict(n=len(p), mean=p.mean(), wr=(p > 0).mean(), pf=pf, sh=sh)


def main():
    if os.path.exists(CACHE):
        D = pd.read_csv(CACHE)
        print(f"Loaded cached rich table: {len(D)} days {D.date.min()}..{D.date.max()}")
    else:
        print("Building rich per-day table (one pass) ...", flush=True)
        D = build_rich()
        print(f"Built {len(D)} days {D.date.min()}..{D.date.max()}")

    gap = (D["day_open"] - D["prev_close"]).values
    updir = gap > 0

    print(f"\n{'='*92}\n(1)+(3) ROBUSTNESS + SIGNIFICANCE: up-gap CONFIRMED long")
    print("    confirm = open held as low through the window (clow >= open - tol). entry=window end, exit=cutoff.")
    print(f"{'='*92}")
    for cutoff in ("exit1545", "exit1600"):
        for w in (15, 20, 30):
            for tol in (3.0, 5.0, 8.0):
                for thr in (0, 30):
                    entry = D[f"entry{w}"].values
                    exitp = D[cutoff].values
                    long_pnl = exitp - entry
                    conf_long = updir & (D[f"clow{w}"].values >= D["day_open"].values - tol) & (np.abs(gap) >= thr)
                    upgap_all = updir & (np.abs(gap) >= thr)          # control: up-gap long, no gate
                    cs = stats_pts(long_pnl[conf_long])
                    us = stats_pts(long_pnl[upgap_all])
                    # bootstrap: random same-size subsets of upgap_all, prob mean >= confirmed mean
                    base = long_pnl[upgap_all]
                    base = base[np.isfinite(base)]
                    k = cs["n"]
                    pv = np.nan
                    if k > 0 and len(base) >= k and np.isfinite(cs["mean"]):
                        idx = RNG.integers(0, len(base), size=(10000, k))
                        pv = (base[idx].mean(axis=1) >= cs["mean"]).mean()
                    flag = " *" if (pv == pv and pv < 0.05) else ""
                    print(f"  {cutoff[4:]} w={w:2d} tol={tol:.0f} thr={thr:3d} | CONFIRM n={cs['n']:3d} "
                          f"mean={cs['mean']:+6.2f} wr={cs['wr']*100:4.1f}% pf={cs['pf']:.2f} sh={cs['sh']:+.2f}"
                          f" | ctrl(upgap) mean={us['mean']:+5.2f} n={us['n']:3d} | gate_p={pv:.3f}{flag}")

    # ---- (2) Vol-normalized: pnl / prev-day RTH range ----
    print(f"\n{'='*92}\n(2) VOL-NORMALIZED (pnl / prev-day RTH range) — headline variant w=20 tol=5 thr=30 exit1545\n{'='*92}")
    w, tol, thr, cutoff = 20, 5.0, 30, "exit1545"
    entry = D[f"entry{w}"].values
    exitp = D[cutoff].values
    long_pnl = exitp - entry
    pr = D["prev_range"].values
    normpnl = np.where(pr > 0, long_pnl / pr, np.nan)
    conf_long = updir & (D[f"clow{w}"].values >= D["day_open"].values - tol) & (np.abs(gap) >= thr)
    upgap_all = updir & (np.abs(gap) >= thr)
    cs, us = stats_pts(normpnl[conf_long]), stats_pts(normpnl[upgap_all])
    print(f"  CONFIRM (norm) n={cs['n']} mean={cs['mean']:+.3f}xRange wr={cs['wr']*100:.1f}% pf={cs['pf']:.2f} sh={cs['sh']:+.2f}")
    print(f"  CTRL upgap(norm) n={us['n']} mean={us['mean']:+.3f}xRange wr={us['wr']*100:.1f}% pf={us['pf']:.2f} sh={us['sh']:+.2f}")
    print(f"  raw-pts CONFIRM mean={stats_pts(long_pnl[conf_long])['mean']:+.2f}pt")

    # ---- (4) Is the gate a volatility selector? ----
    print(f"\n{'='*92}\n(4) GATE = VOL SELECTOR? realized prev-range on confirmed vs unconfirmed up-gap days\n{'='*92}")
    conf_range = D["prev_range"].values[conf_long]
    unconf = updir & (np.abs(gap) >= thr) & ~(D[f"clow{w}"].values >= D["day_open"].values - tol)
    unconf_range = D["prev_range"].values[unconf]
    print(f"  confirmed up-gap: prev_range median={np.nanmedian(conf_range):.1f}  mean={np.nanmean(conf_range):.1f}  n={np.isfinite(conf_range).sum()}")
    print(f"  unconfirmed up-gap: prev_range median={np.nanmedian(unconf_range):.1f}  mean={np.nanmean(unconf_range):.1f}  n={np.isfinite(unconf_range).sum()}")

    # ---- per-year of the headline, both raw and vol-normalized ----
    print(f"\n  per-year headline (w20 tol5 thr30 exit1545) up-gap CONFIRMED long:")
    yr = D["year"].values
    for y in sorted(set(yr)):
        m = conf_long & (yr == y)
        p = long_pnl[m]
        pn = normpnl[m]
        p = p[np.isfinite(p)]
        if len(p) == 0:
            continue
        print(f"    {y}: n={len(p):2d} mean={p.mean():+6.2f}pt wr={(p>0).mean()*100:4.1f}% "
              f"norm_mean={np.nanmean(pn):+.3f}xRange tot={p.sum():+7.1f}pt")


if __name__ == "__main__":
    main()
