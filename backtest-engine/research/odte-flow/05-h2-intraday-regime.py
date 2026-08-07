#!/usr/bin/env python3
"""ODTE-flow P1 / H2 — does the INTRADAY 0DTE dealer-gamma SIGN govern NQ mean-reversion vs trend?

For each 15-min snapshot T (from qqq-0dte-intraday.csv, causal — only trades <= T), classify the regime:
  net0_sign = +1  dealers net LONG 0DTE gamma  -> they FADE  -> expect MEAN-REVERSION (dampened, negative autocorr)
  net0_sign = -1  dealers net SHORT 0DTE gamma -> they CHASE -> expect TREND (expansion, positive autocorr)

NQ forward behavior over next H min (continuous 1m, ET-aligned), measured at T:
  cont_H   = prior_move * fwd_move  (normalized by prev-day range^2)   >0 trend / <0 revert
  fwdrng_H = (max-min of NQ over [T,T+H]) / prev_range                  expansion (bigger => trend/vol)
  fwdabs_H = |fwd_move| / prev_range
Compare long-gamma vs short-gamma snapshots; magnitude terciles; PLACEBO = shuffled regime labels (bootstrap p).
Restrict to 10:00-15:00 ET (forward room, avoid open/close microstructure). Report POOLED + PER-QUARTER.
Also a LEVEL cut: does NQ move toward the mapped 0DTE pin more on long-gamma? (pin~ATM so secondary.)
"""
import numpy as np
import pandas as pd
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
ET = ZoneInfo("America/New_York")
RNG = np.random.default_rng(20260723)
HORIZONS = [15, 30, 60]


def load_nq_intraday():
    df = pd.read_csv(f"{BASE}/data/ohlcv/nq/NQ_ohlcv_1m_continuous.csv",
                     usecols=["ts_event", "high", "low", "close"])
    ts = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(ET)
    df["date"] = ts.dt.strftime("%Y-%m-%d")
    df["etmin"] = (ts.dt.hour * 60 + ts.dt.minute).astype(int)
    df = df[df["date"] >= "2025-01-15"]
    # per (date,etmin) close; per date prev_range and 9:30 open for ratio
    close = {(r.date, r.etmin): r.close for r in df.itertuples()}
    hilo = df.groupby("date").agg(rth_hi=("high", "max"), rth_lo=("low", "min")).reset_index()
    hilo["rng"] = hilo["rth_hi"] - hilo["rth_lo"]
    hilo["prev_range"] = hilo["rng"].shift(1)
    prev_range = dict(zip(hilo["date"], hilo["prev_range"]))
    open930 = {(r.date, r.etmin): r.close for r in df[df["etmin"] == 570].itertuples()}
    return close, prev_range, open930


def boot_p(a, b):
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if len(a) < 10 or len(b) < 10:
        return np.nan
    obs = a.mean() - b.mean()
    pool = np.concatenate([a, b]); n1 = len(a)
    d = np.empty(5000)
    for i in range(5000):
        RNG.shuffle(pool)
        d[i] = pool[:n1].mean() - pool[n1:].mean()
    return (np.abs(d) >= abs(obs)).mean()


def main():
    snaps = pd.read_csv(f"{BASE}/research/odte-flow/qqq-0dte-intraday.csv")
    close, prev_range, open930 = load_nq_intraday()
    snaps = snaps[(snaps["et_min"] >= 600) & (snaps["et_min"] <= 900)].copy()

    recs = []
    for r in snaps.itertuples():
        d, T = r.date, r.et_min
        pr = prev_range.get(d)
        if not pr or pr <= 0:
            continue
        nqT = close.get((d, T)); nqTm = close.get((d, T - 15))
        if nqT is None or nqTm is None:
            continue
        rec = dict(date=d, quarter=str(pd.Period(d, freq="Q")), etmin=T,
                   sign=r.net0_sign, net=float(r.net0_gamma), absg=float(r.absg0),
                   cg_imb=r.cg_imb, pin=r.pin_pos, spot=r.spot_qqq, prior=(nqT - nqTm) / pr)
        # NQ/QQQ ratio for pin mapping
        nqO = open930.get((d, 570));
        for H in HORIZONS:
            nqH = close.get((d, T + H))
            if nqH is None:
                rec[f"cont{H}"] = np.nan; rec[f"fwdrng{H}"] = np.nan; rec[f"fwdabs{H}"] = np.nan
                continue
            fwd = (nqH - nqT) / pr
            # forward range over [T, T+H]
            his = [close.get((d, T + k)) for k in range(0, H + 1)]
            his = [x for x in his if x is not None]
            frng = (max(his) - min(his)) / pr if his else np.nan
            rec[f"cont{H}"] = rec["prior"] * fwd
            rec[f"fwdrng{H}"] = frng
            rec[f"fwdabs{H}"] = abs(fwd)
        recs.append(rec)
    df = pd.DataFrame(recs)
    print(f"{len(df)} snapshots, {df.date.nunique()} days, {df.date.min()}..{df.date.max()}")
    print(f"regime mix: long(+) {int((df['sign']==1).sum())} / short(-) {int((df['sign']==-1).sum())}")

    print(f"\n{'='*92}\nH2 — 0DTE gamma regime vs NQ forward behavior (POOLED)")
    print("  hypothesis: LONG-gamma => cont<0 (revert) & smaller fwdrng ; SHORT-gamma => cont>0 (trend) & bigger")
    print(f"{'='*92}")
    for H in HORIZONS:
        for m in [f"cont{H}", f"fwdrng{H}", f"fwdabs{H}"]:
            lo = df[df["sign"] == 1][m].values
            sh = df[df["sign"] == -1][m].values
            ml, ms = np.nanmean(lo), np.nanmean(sh)
            p = boot_p(lo, sh)
            print(f"  {m:9s} | long={ml:+.4f} (n={np.isfinite(lo).sum():4d}) | short={ms:+.4f} "
                  f"(n={np.isfinite(sh).sum():4d}) | Δ(L−S)={ml-ms:+.4f} p={p:.3f}")

    print(f"\n{'-'*92}\nMagnitude terciles on net/absg (regime strength) vs cont30 / fwdrng30\n{'-'*92}")
    df["net_norm"] = df["net"] / df["absg"]
    df["terc"] = pd.qcut(df["net_norm"], 3, labels=["short", "mid", "long"])
    for m in ["cont30", "fwdrng30", "fwdabs30"]:
        gm = df.groupby("terc", observed=True)[m].mean()
        print(f"  {m:9s} short={gm.get('short',float('nan')):+.4f} mid={gm.get('mid',float('nan')):+.4f} long={gm.get('long',float('nan')):+.4f}")

    print(f"\n{'-'*92}\nPER-QUARTER stability: Δ(long−short) for cont30 and fwdrng30\n{'-'*92}")
    for m in ["cont30", "fwdrng30"]:
        print(f"  [{m}]")
        for q in sorted(df["quarter"].unique()):
            s = df[df["quarter"] == q]
            ml = np.nanmean(s[s["sign"] == 1][m]); ms = np.nanmean(s[s["sign"] == -1][m])
            print(f"    {q}: long={ml:+.4f} short={ms:+.4f} Δ={ml-ms:+.4f} (n={len(s)})")

    # also condition on call/put gamma imbalance magnitude (stronger positioning)
    print(f"\n{'-'*92}\nStrong-positioning subset (|cg_imb|>0.3): regime vs cont30/fwdrng30\n{'-'*92}")
    st = df[df["cg_imb"].abs() > 0.3]
    for m in ["cont30", "fwdrng30"]:
        lo = st[st["sign"] == 1][m].values; sh = st[st["sign"] == -1][m].values
        print(f"  {m:9s} long={np.nanmean(lo):+.4f} short={np.nanmean(sh):+.4f} Δ={np.nanmean(lo)-np.nanmean(sh):+.4f} p={boot_p(lo,sh):.3f} (n={len(st)})")


if __name__ == "__main__":
    main()
