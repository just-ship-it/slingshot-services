#!/usr/bin/env python3
"""ODTE-flow P1 / H3 — is B4a (pre-close continuation) governed by the 15:00 0DTE gamma regime?

B4a (our one confirmed greenfield edge, [[greenfield-r2-flow-footprints]]): at 15:00 ET, if |day move
(open->15:00)| > 0.30*ATR14, enter in the direction of the day move, exit 15:30, no stop.

Hypothesis (0DTE charm/hedging into close):
  dealers SHORT 0DTE gamma at 15:00 -> hedge WITH the move -> amplify continuation -> B4a STRONGER
  dealers LONG  0DTE gamma at 15:00 -> fade/pin -> dampen -> B4a WEAKER
Also test cg_imb (call/put gamma imbalance) and absg0 (positioning size) as charm-intensity conditioners.

Conditioner = the 15:00 (et_min=900) snapshot from qqq-0dte-intraday.csv (causal, knowable at 15:00).
NQ from continuous 1m. Reports B4a PnL (points) by regime, pooled + per-quarter, vs the unconditional B4a.
"""
import numpy as np
import pandas as pd
from zoneinfo import ZoneInfo

BASE = "/home/drew/projects/slingshot-services/backtest-engine"
ET = ZoneInfo("America/New_York")
OPEN_HM, T1500, T1530, CLOSE_HM = 9*60+30, 15*60, 15*60+30, 16*60


def build_nq():
    df = pd.read_csv(f"{BASE}/data/ohlcv/nq/NQ_ohlcv_1m_continuous.csv",
                     usecols=["ts_event", "open", "high", "low", "close"])
    ts = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(ET)
    df["date"] = ts.dt.strftime("%Y-%m-%d")
    df["etmin"] = (ts.dt.hour*60 + ts.dt.minute).astype(int)
    df = df[df["date"] >= "2024-11-01"]
    rows = []
    atr_hist = []
    prev_close = None
    for d, g in df.groupby("date", sort=True):
        rth = g[(g["etmin"] >= OPEN_HM) & (g["etmin"] < CLOSE_HM)]
        if len(rth) < 60:
            if len(rth): prev_close = rth.iloc[-1]["close"]
            continue
        ob = rth[rth["etmin"] == OPEN_HM]
        p1500 = rth[rth["etmin"] == T1500]
        p1530 = rth[rth["etmin"] == T1530]
        hi, lo = rth["high"].max(), rth["low"].min()
        tr = hi - lo if prev_close is None else max(hi-lo, abs(hi-prev_close), abs(lo-prev_close))
        if ob.empty or p1500.empty or p1530.empty:
            prev_close = rth.iloc[-1]["close"]; atr_hist.append(tr); continue
        atr14 = np.mean(atr_hist[-14:]) if len(atr_hist) >= 14 else np.nan
        rows.append(dict(date=d, day_open=ob.iloc[0]["open"], px1500=p1500.iloc[0]["close"],
                         px1530=p1530.iloc[0]["close"], atr14=atr14))
        prev_close = rth.iloc[-1]["close"]; atr_hist.append(tr)
    return pd.DataFrame(rows)


def summ(tag, pnl):
    p = pnl[np.isfinite(pnl)]
    if len(p) == 0:
        print(f"    {tag:32s} n=0"); return
    wins, losses = p[p > 0].sum(), -p[p < 0].sum()
    pf = wins/losses if losses > 0 else np.inf
    sh = p.mean()/p.std(ddof=1)*np.sqrt(len(p)) if len(p) > 1 and p.std() > 0 else np.nan
    print(f"    {tag:32s} n={len(p):3d} mean={p.mean():+6.2f}pt wr={(p>0).mean()*100:4.1f}% pf={pf:.2f} sh={sh:+.2f} tot={p.sum():+7.0f}")


def main():
    nq = build_nq()
    snap = pd.read_csv(f"{BASE}/research/odte-flow/qqq-0dte-intraday.csv")
    s15 = snap[snap["et_min"] == 900][["date", "net0_sign", "net0_gamma", "absg0", "cg_imb"]]
    df = nq.merge(s15, on="date", how="inner").dropna(subset=["atr14"])
    df["day_move"] = df["px1500"] - df["day_open"]
    df["dir"] = np.sign(df["day_move"])
    df["trig"] = df["day_move"].abs() > 0.30 * df["atr14"]
    df["pnl"] = (df["px1530"] - df["px1500"]) * df["dir"]
    df["quarter"] = df["date"].map(lambda d: str(pd.Period(d, freq="Q")))
    b = df[df["trig"]].copy()
    print(f"joined {len(df)} days ({df.date.min()}..{df.date.max()}); B4a-triggered {len(b)}")

    print(f"\n{'='*88}\nH3 — B4a by 15:00 0DTE gamma regime\n{'='*88}")
    summ("B4a ALL (unconditional)", b["pnl"].values)
    summ("B4a | dealers SHORT 0DTE gamma", b[b["net0_sign"] == -1]["pnl"].values)
    summ("B4a | dealers LONG 0DTE gamma", b[b["net0_sign"] == 1]["pnl"].values)

    print(f"\n  cg_imb (call/put gamma imbalance) cut:")
    summ("B4a | cg_imb<-0.2 (put-heavy)", b[b["cg_imb"] < -0.2]["pnl"].values)
    summ("B4a | cg_imb>+0.2 (call-heavy)", b[b["cg_imb"] > 0.2]["pnl"].values)

    print(f"\n  absg0 (0DTE positioning size) terciles:")
    b["absg_t"] = pd.qcut(b["absg0"].astype(float), 3, labels=["low", "mid", "high"])
    for t in ["low", "mid", "high"]:
        summ(f"B4a | absg0 {t}", b[b["absg_t"] == t]["pnl"].values)

    print(f"\n  short-gamma AND large positioning (charm-max):")
    summ("B4a | short & absg0 high", b[(b["net0_sign"] == -1) & (b["absg_t"] == "high")]["pnl"].values)

    print(f"\n{'-'*88}\nPer-quarter: B4a short-gamma vs long-gamma (mean pt)\n{'-'*88}")
    for q in sorted(b["quarter"].unique()):
        s = b[b["quarter"] == q]
        sh = s[s["net0_sign"] == -1]["pnl"]; lo = s[s["net0_sign"] == 1]["pnl"]
        print(f"    {q}: short n={len(sh):2d} mean={sh.mean():+6.2f} | long n={len(lo):2d} mean={lo.mean():+6.2f}")


if __name__ == "__main__":
    main()
