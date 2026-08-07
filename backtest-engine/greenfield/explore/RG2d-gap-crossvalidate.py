#!/usr/bin/env python3
"""
RG2d — Gap-continuation cross-validation (NQ + ES) with VOL-ADAPTIVE confirmation.

Two questions:
  (Q1) Does the confirmed-up-gap-long edge replicate on ES (independent instrument, same 2021-2026 era)?
  (Q2) Was the 2024-25 decay an artifact of a FIXED 5pt tolerance (which is strict in high-vol 2022,
       loose in low-vol 2025)? Re-run with tolerance & gap-threshold as FRACTIONS of prior-day RTH range.

Vol-adaptive definitions (per day):
  gap        = day_open - prev_rth_close
  tol        = tol_frac  * prev_range          # confirmation slack, scales with vol
  gap_thr    = gap_frac  * prev_range          # "big open" threshold, scales with vol
  confirm(long) = up-gap & |gap|>=gap_thr & (min low over [9:30, 9:30+w) >= open - tol)
  entry = open of 9:30+w bar ; exit = close of last bar <= 15:45 ET ; long only (piece: up-days)
  P&L reported in points AND in xRange (= pnl / prev_range) for cross-instrument comparability.

Fills honest: entry/exit at bar open/close, no intrabar stop -> 1m ok (no lookahead/same-bar ambiguity).
"""
import os
import numpy as np
import pandas as pd
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
ET = ZoneInfo("America/New_York")
OPEN_HM = 9 * 60 + 30
CLOSE_HM = 16 * 60
C1545 = 15 * 60 + 45
RNG = np.random.default_rng(20260722)

INSTR = {
    "nq": f"{BASE}/data/ohlcv/nq/NQ_ohlcv_1m_continuous.csv",
    "es": f"{BASE}/data/ohlcv/es/ES_ohlcv_1m_continuous.csv",
}


def build_rich(path, cache):
    df = pd.read_csv(path, usecols=["ts_event", "open", "high", "low", "close"])
    ts = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(ET)
    df["etdate"] = ts.dt.strftime("%Y-%m-%d")
    df["hm"] = (ts.dt.hour * 60 + ts.dt.minute).astype(int)
    df["year"] = ts.dt.year.astype(int)
    rows = []
    prev_close = prev_range = None
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
        ex = rth[rth["hm"] <= C1545]
        rec["exit1545"] = ex.iloc[-1]["close"] if len(ex) else np.nan
        this_range = rth["high"].max() - rth["low"].min()
        if ok and prev_close is not None and prev_range is not None:
            rows.append(rec)
        prev_close = rth.iloc[-1]["close"]
        prev_range = this_range
    out = pd.DataFrame(rows)
    out.to_csv(cache, index=False)
    return out


def load(instr):
    cache = f"{BASE}/greenfield/explore/RG2d-{instr}-rich.csv"
    if os.path.exists(cache):
        return pd.read_csv(cache)
    print(f"  building {instr} rich table ...", flush=True)
    return build_rich(INSTR[instr], cache)


def stats(p):
    p = p[np.isfinite(p)]
    if len(p) == 0:
        return dict(n=0, mean=np.nan, wr=np.nan, pf=np.nan, sh=np.nan)
    wins, losses = p[p > 0].sum(), -p[p < 0].sum()
    pf = wins / losses if losses > 0 else np.inf
    sh = p.mean() / p.std(ddof=1) * np.sqrt(len(p)) if len(p) > 1 and p.std() > 0 else np.nan
    return dict(n=len(p), mean=p.mean(), wr=(p > 0).mean(), pf=pf, sh=sh)


def analyze(instr, D, w, tol_frac, gap_frac):
    gap = (D["day_open"] - D["prev_close"]).values
    pr = D["prev_range"].values
    updir = gap > 0
    tol = tol_frac * pr
    gthr = gap_frac * pr
    entry = D[f"entry{w}"].values
    exitp = D["exit1545"].values
    long_pnl = exitp - entry
    xr = np.where(pr > 0, long_pnl / pr, np.nan)   # points / prev_range

    big = np.abs(gap) >= gthr
    conf_long = updir & big & (D[f"clow{w}"].values >= D["day_open"].values - tol)
    upgap_all = updir & big   # control: up-gap long, no confirmation gate

    cs_pt, cs_xr = stats(long_pnl[conf_long]), stats(xr[conf_long])
    us_pt = stats(long_pnl[upgap_all])
    # bootstrap: is confirmed mean(xRange) > random same-size subset of upgap_all?
    base = xr[upgap_all]; base = base[np.isfinite(base)]
    k = cs_xr["n"]; pv = np.nan
    if k > 0 and len(base) >= k and np.isfinite(cs_xr["mean"]):
        idx = RNG.integers(0, len(base), size=(10000, k))
        pv = (base[idx].mean(axis=1) >= cs_xr["mean"]).mean()
    return dict(conf_long=conf_long, long_pnl=long_pnl, xr=xr, year=D["year"].values,
                cs_pt=cs_pt, cs_xr=cs_xr, us_pt=us_pt, pv=pv)


def main():
    Ds = {}
    for instr in ("nq", "es"):
        Ds[instr] = load(instr)
        d = Ds[instr]
        print(f"{instr.upper()}: {len(d)} days {d.date.min()}..{d.date.max()} "
              f"prev_range median={np.nanmedian(d['prev_range']):.1f}")

    print(f"\n{'='*94}\nVOL-ADAPTIVE sweep — confirmed up-gap long, exit 15:45, tol/gap as fractions of prev-range")
    print(f"{'='*94}")
    print(f"{'instr':5s} {'w':>2s} {'tolf':>5s} {'gapf':>5s} | {'n':>3s} {'mean_pt':>8s} {'mean_xR':>8s} "
          f"{'wr':>5s} {'pf':>5s} {'sh':>5s} | ctrl_pt gate_p")
    configs = []
    for instr in ("nq", "es"):
        for w in (15, 20):
            for tolf in (0.015, 0.025, 0.04):
                for gapf in (0.05, 0.10):
                    r = analyze(instr, Ds[instr], w, tolf, gapf)
                    flag = " *" if (r["pv"] == r["pv"] and r["pv"] < 0.05) else ""
                    print(f"{instr:5s} {w:2d} {tolf:5.3f} {gapf:5.2f} | {r['cs_pt']['n']:3d} "
                          f"{r['cs_pt']['mean']:+8.2f} {r['cs_xr']['mean']:+8.3f} "
                          f"{r['cs_xr']['wr']*100:4.0f}% {r['cs_xr']['pf']:5.2f} {r['cs_xr']['sh']:+5.2f} | "
                          f"{r['us_pt']['mean']:+6.2f} {r['pv']:.3f}{flag}")
                    configs.append((instr, w, tolf, gapf, r))
        print()

    # ---- per-year, both instruments, at a common vol-adaptive config ----
    W, TOLF, GAPF = 15, 0.025, 0.05
    print(f"{'='*94}\nPER-YEAR — common config w={W} tol_frac={TOLF} gap_frac={GAPF} (confirmed up-gap long)\n{'='*94}")
    for instr in ("nq", "es"):
        r = analyze(instr, Ds[instr], W, TOLF, GAPF)
        cl, xr, yr = r["conf_long"], r["xr"], r["year"]
        pnl = r["long_pnl"]
        print(f"\n{instr.upper()}  overall: n={r['cs_xr']['n']} mean_xR={r['cs_xr']['mean']:+.3f} "
              f"pf={r['cs_xr']['pf']:.2f} sh={r['cs_xr']['sh']:+.2f} gate_p={r['pv']:.3f}")
        for y in sorted(set(yr)):
            m = cl & (yr == y)
            v = xr[m]; v = v[np.isfinite(v)]
            p = pnl[m]; p = p[np.isfinite(p)]
            if len(v) == 0:
                continue
            print(f"    {y}: n={len(v):2d} mean_xR={v.mean():+.3f} wr={(v>0).mean()*100:4.0f}% "
                  f"mean_pt={p.mean():+6.2f} tot_pt={p.sum():+7.1f}")

    # ---- pooled NQ+ES at common config (doubles the sample) ----
    print(f"\n{'='*94}\nPOOLED NQ+ES (common config) — the key sample-size test\n{'='*94}")
    allxr, allyr = [], []
    for instr in ("nq", "es"):
        r = analyze(instr, Ds[instr], W, TOLF, GAPF)
        v = r["xr"][r["conf_long"]]
        y = r["year"][r["conf_long"]]
        allxr.append(v); allyr.append(y)
    allxr = np.concatenate(allxr); allyr = np.concatenate(allyr)
    s = stats(allxr)
    print(f"  pooled confirmed up-gap: n={s['n']} mean_xR={s['mean']:+.3f} wr={s['wr']*100:.1f}% "
          f"pf={s['pf']:.2f} sh={s['sh']:+.2f}")
    for y in sorted(set(allyr[np.isfinite(allxr)])):
        m = (allyr == y) & np.isfinite(allxr)
        v = allxr[m]
        if len(v) == 0:
            continue
        print(f"    {int(y)}: n={len(v):2d} mean_xR={v.mean():+.3f} wr={(v>0).mean()*100:4.0f}% tot_xR={v.sum():+.2f}")


if __name__ == "__main__":
    main()
