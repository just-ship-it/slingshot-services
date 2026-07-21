#!/usr/bin/env python3
"""C2-10: build the causal linear-regression channel registry.

For each usable RTH day and each timeframe (5m, 15m) and each trailing window K,
fit OLS(close ~ bar_index) over the trailing K HTF bars ending at every bar i.
One registry row per frozen channel. Everything in a row is knowable at the
freeze instant (window END bar close); no forward data is touched here.

Registry columns (per frozen channel):
  prod, td, year, tf, K, symbol,
  freeze_end   1m tmin of the window's last-bar CLOSE (channel evaluable at >freeze_end)
  n_before     # RTH HTF bars elapsed in the day at freeze (age proxy)
  price_end    regression value at the last bar  == rail mid at t=freeze_end
  slope_pb     slope in points / HTF-bar
  slope_pm     slope in points / MINUTE (= slope_pb / tf)
  r2           in-window fit R^2
  sigma        residual std (pts)
  maxdev       max |residual| in window (pts)
  atr14        prior-day ATR14 (pts)
  slope_norm   slope_pb * K / atr14  (total trend travel over the window, in ATR)
  w2s          half-width = 2*sigma  (pts)
  wmax         half-width = maxdev   (pts)

Rail at future minute t:  mid=price_end+slope_pm*(t-freeze_end); rails = mid +/- W.

Usage: python3 C2-10-fit.py [NQ|ES] [start_td] [end_td]
"""
import sys, time
import numpy as np
import pandas as pd
import C2_common as C2
import C1_common as C1

PROD = (sys.argv[1] if len(sys.argv) > 1 else "NQ").upper()
START = sys.argv[2] if len(sys.argv) > 2 else None
END = sys.argv[3] if len(sys.argv) > 3 else None


def build(dm, use, atr_map):
    rows = []
    for td in use:
        if START and td < START:
            continue
        if END and td > END:
            continue
        atr = atr_map.get(td, np.nan)
        if not np.isfinite(atr) or atr <= 0:
            continue
        d = dm[td]
        sym = d["sym"]
        yr = C2.year_of(td)
        for tf, Ks in C2.KGRID.items():
            agg = C2.rth_htf(d, tf)
            if agg is None:
                continue
            bt, bo, bh, bl, bc, bv = agg
            n = len(bc)
            for K in Ks:
                if n < K:
                    continue
                fit = C2.rolling_linreg(bc, K)
                if fit is None:
                    continue
                ei = fit["end_idx"]
                freeze_end = bt[ei] + tf              # 1m tmin of last-bar close
                slope_pb = fit["slope_pb"]
                for j in range(len(ei)):
                    rows.append((
                        PROD, td, yr, tf, K, sym,
                        int(freeze_end[j]),
                        int(ei[j] + 1),               # n RTH HTF bars elapsed
                        round(float(fit["price_end"][j]), 3),
                        round(float(slope_pb[j]), 5),
                        round(float(slope_pb[j] / tf), 6),
                        round(float(fit["r2"][j]), 4),
                        round(float(fit["sigma"][j]), 3),
                        round(float(fit["maxdev"][j]), 3),
                        round(float(atr), 2),
                        round(float(slope_pb[j] * K / atr), 4),
                        round(float(2 * fit["sigma"][j]), 3),
                        round(float(fit["maxdev"][j]), 3),
                    ))
    cols = ["prod", "td", "year", "tf", "K", "symbol", "freeze_end", "n_before",
            "price_end", "slope_pb", "slope_pm", "r2", "sigma", "maxdev",
            "atr14", "slope_norm", "w2s", "wmax"]
    return pd.DataFrame(rows, columns=cols)


def main():
    t0 = time.time()
    if PROD == "NQ":
        days, dm, use = C2.load_nq()
        atr_map = {td: days.loc[td, "atr14_prior"] for td in use}
    else:
        dm, meta, use = C2.load_es()
        atr_map = {td: meta.loc[td, "atr14_prior"] for td in use}
    print(f"{PROD}: {len(use)} usable tds loaded ({time.time()-t0:.0f}s)", flush=True)
    reg = build(dm, use, atr_map)
    suffix = "" if (START is None and END is None) else f"_{START}_{END}"
    out = f"{C2.HERE}/C2-registry-{PROD}{suffix}.csv"
    reg.to_csv(out, index=False)
    print(f"registry: {len(reg)} rows -> {out} ({time.time()-t0:.0f}s)")
    print(reg.groupby(["tf", "K"]).size())
    print("r2 quantiles:", np.round(reg["r2"].quantile([.5, .75, .9, .95]).values, 3))
    print("slope_norm |q|:", np.round(reg["slope_norm"].abs().quantile([.5, .9, .99]).values, 3))


if __name__ == "__main__":
    main()
