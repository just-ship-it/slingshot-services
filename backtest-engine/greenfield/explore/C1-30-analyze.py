#!/usr/bin/env python3
"""C1-30: aggregate the touch census into the findings tables.

Every effect is reported real vs BOTH placebo classes (random-offset x3 seeds,
round-100 grid), with n and binomial SE, and per-year for stability.
Placebo touches that landed within 10pts of real structure are excluded from
placebo baselines (contamination).
"""
import sys
import numpy as np
import pandas as pd
import C1_common as C

pd.set_option("display.width", 220)

CLASS = {}
for f in ("PDH", "PDL", "PDC", "PDM", "PDVWAP", "PDPOC", "PDHVN"):
    CLASS[f] = "PriorDay"
for f in ("PWH", "PWL"):
    CLASS[f] = "PriorWeek"
for f in ("ONH", "ONL"):
    CLASS[f] = "Overnight"
for f in ("OPEN", "OR5H", "OR5L", "OR15H", "OR15L", "OR30H", "OR30L"):
    CLASS[f] = "Opening"
for f in ("VWAP", "RPOC"):
    CLASS[f] = "DynVWAP"
for f in ("SW5H", "SW5L", "SW15H", "SW15L", "SW60H", "SW60L"):
    CLASS[f] = "Swing"
CLASS["MT"] = "MultiTouch"
CLASS["ROUND"] = "ROUND"

EXTREMES = {"PDH", "PDL", "ONH", "ONL", "OR15H", "OR15L", "OR30H", "OR30L",
            "PWH", "PWL", "OR5H", "OR5L"}


def load(path):
    t = pd.read_csv(path)
    t["cls"] = t["family"].map(CLASS)
    # race categories within 60m
    tb = t["t_brk"].where(t["t_brk"] > 0, 10 ** 9)
    tr = t["t_r15"].where(t["t_r15"] > 0, 10 ** 9)
    t["bounce1st"] = (tr <= 60) & (tr < tb)
    t["break1st"] = (tb <= 60) & (tb < tr)
    t["resolved"] = t["bounce1st"] | t["break1st"]
    tr35 = t["t_r35"].where(t["t_r35"] > 0, 10 ** 9)
    t["b35_1st"] = (tr35 <= 120) & (tr35 < tb)
    t["k35_1st"] = (tb <= 120) & (tb < tr35)
    t["res35"] = t["b35_1st"] | t["k35_1st"]
    t["brk60"] = (t["t_brk"] > 0) & (t["t_brk"] <= 60)
    t["brk15"] = (t["t_brk"] > 0) & (t["t_brk"] <= 15)
    t["instant"] = t["pen0"] > C.P["brk"]
    t["pen60atr"] = t["pen60"] / t["atr14d"]
    t["ret60atr"] = t["ret60"] / t["atr14d"]
    # placebo contamination: placebo touch that sits ON real structure (<=5pts)
    t["clean"] = np.where(t["kind"] == "real", True, ~(t["near_real"] <= 5))
    return t


def base(g, w60=True):
    """core stats for a touch subset"""
    v = g[g["valid_min"] >= 60] if w60 else g
    n = len(v)
    if n == 0:
        return dict(n=0)
    r = v[v["resolved"]]
    race = r["bounce1st"].mean() if len(r) else np.nan
    v35 = v[(v["valid_min"] >= 120) | v["res35"]]
    r35 = v35[v35["res35"]]
    race35 = r35["b35_1st"].mean() if len(r35) else np.nan
    return dict(n=n, race15=race, se=np.sqrt(race * (1 - race) / max(len(r), 1)),
                n_res=len(r), race35=race35, n35=len(r35),
                brk15=v["brk15"].mean(), brk60=v["brk60"].mean(),
                inst=v["instant"].mean(),
                pen60=v["pen60"].median(), ret60=v["ret60"].median(),
                pen60atr=v["pen60atr"].median(), ret60atr=v["ret60atr"].median())


def table(df, bycols, label, min_n=60):
    print(f"\n===== {label} =====")
    rows = []
    for key, g in df.groupby(bycols):
        b = base(g)
        if b["n"] < min_n:
            continue
        rows.append(dict(zip(bycols if isinstance(key, tuple) else [bycols],
                             key if isinstance(key, tuple) else [key]), **b))
    if not rows:
        print("(no cells)")
        return None
    out = pd.DataFrame(rows)
    print(out.round(3).to_string(index=False))
    return out


def delta_frame(df, bycol, label):
    """real vs rand vs round race15 per value of bycol"""
    print(f"\n===== {label}: real vs placebos =====")
    rows = []
    for val, g in df.groupby(bycol):
        b_r = base(g[g["kind"] == "real"])
        b_p = base(g[(g["kind"] == "rand") & g["clean"]])
        b_pa = base(g[g["kind"] == "rand"])
        b_o = base(g[(g["kind"] == "round") & g["clean"]])
        if b_r["n"] < 60 or b_p["n"] < 60:
            continue
        d = b_r["race15"] - b_p["race15"]
        z = d / np.sqrt(b_r["se"] ** 2 + b_p["se"] ** 2) if b_p["n"] else np.nan
        rows.append(dict(key=val, n_real=b_r["n"], n_rand=b_p["n"], n_round=b_o.get("n", 0),
                         race_real=b_r["race15"], race_rand=b_p["race15"],
                         race_rand_all=b_pa["race15"],
                         race_round=b_o.get("race15", np.nan),
                         d_vs_rand=d, z=z,
                         brk60_real=b_r["brk60"], brk60_rand=b_p["brk60"],
                         pen60_real=b_r["pen60"], pen60_rand=b_p["pen60"],
                         ret60_real=b_r["ret60"], ret60_rand=b_p["ret60"],
                         race35_real=b_r["race35"], race35_rand=b_p["race35"]))
    if not rows:
        print("(no cells)")
        return None
    out = pd.DataFrame(rows).round(3)
    print(out.to_string(index=False))
    return out


def yearly_delta(df, bycol, label, min_n=40):
    print(f"\n===== {label}: yearly race15 delta (real - rand) =====")
    piv = {}
    for (val, yr), g in df.groupby([bycol, "year"]):
        b_r = base(g[g["kind"] == "real"])
        b_p = base(g[(g["kind"] == "rand") & g["clean"]])
        if b_r["n"] < min_n or b_p["n"] < min_n:
            continue
        piv.setdefault(val, {})[yr] = round(b_r["race15"] - b_p["race15"], 3)
        piv[val][f"n{yr}"] = b_r["n"]
    if not piv:
        print("(no cells)")
        return None
    out = pd.DataFrame(piv).T
    ycols = sorted([c for c in out.columns if not str(c).startswith("n")])
    out = out[ycols + [f"n{y}" for y in ycols if f"n{y}" in out.columns]]
    dsign = out[ycols]
    out["pos_yrs"] = (dsign > 0).sum(axis=1)
    out["neg_yrs"] = (dsign < 0).sum(axis=1)
    print(out.to_string())
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else f"{C.HERE}/C1-touches.csv.gz"
    t = load(path)
    print(f"{len(t)} touch rows; kinds: {t.groupby('kind').size().to_dict()}")
    print(f"placebo contamination excluded: "
          f"{(~t['clean']).sum()} rows ({(~t['clean']).mean()*100:.1f}%)")

    m = t[t["tol"] == C.P["tol_main"]].copy()

    # -1. structure density census (how much of price space IS "a level"?)
    try:
        reg = pd.read_csv(f"{C.HERE}/C1-levels-registry.csv")
        days = C.load_days()
        cov = []
        for td, g in reg[reg["dynamic"] == 0].groupby("td"):
            row = days.loc[td] if td in days.index else None
            if row is None or not np.isfinite(row.get("rth_high", np.nan)):
                continue
            act = g[(g["act_from"] <= 1080) & (g["act_to"] > 1080)]
            lo, hi = row["rth_low"], row["rth_high"]
            grid = np.arange(lo, hi + 1, 1.0)
            if len(act) and len(grid):
                d = np.min(np.abs(grid[:, None] - act["price"].values[None, :]), axis=1)
                cov.append((len(act), (d <= 5).mean(), hi - lo))
        cov = pd.DataFrame(cov, columns=["n_active", "frac_within5", "rth_range"])
        print(f"\nSTRUCTURE DENSITY (active static real levels at 12:00 ET, n={len(cov)} days):")
        print(cov.describe().loc[["mean", "50%", "25%", "75%"]].round(3).to_string())
    except Exception as ex:
        print("density census failed:", ex)

    # 0. tolerance sensitivity
    for tol in C.P["tols"]:
        g = t[t["tol"] == tol]
        br = base(g[g["kind"] == "real"])
        bp = base(g[(g["kind"] == "rand") & g["clean"]])
        print(f"tol={tol}: real n={br['n']} race15={br['race15']:.3f} | "
              f"rand n={bp['n']} race15={bp['race15']:.3f} | d={br['race15']-bp['race15']:+.3f}")

    # 1. family and class tables
    delta_frame(m, "cls", "CLASS (tol=5)")
    delta_frame(m, "family", "FAMILY (tol=5)")
    yearly_delta(m, "cls", "CLASS")
    yearly_delta(m, "family", "FAMILY")

    # 2. arr5 x structure (the key interaction)
    mm = m[m["arr5"].notna()].copy()
    qs = mm["arr5"].quantile([0.2, 0.4, 0.6, 0.8]).values
    mm["arr5_q"] = np.searchsorted(qs, mm["arr5"].values) + 1
    print(f"\narr5 quintile edges: {np.round(qs,2)}")
    delta_frame(mm, "arr5_q", "ARR5 QUINTILE x structure (all real families pooled)")
    for cls in ("PriorDay", "Overnight", "Opening", "Swing", "MultiTouch", "DynVWAP"):
        delta_frame(mm[mm["cls"] == cls], "arr5_q", f"ARR5 QUINTILE within {cls}")
    # yearly stability of the interaction at the fast end
    fast = mm[mm["arr5_q"] >= 4]
    yearly_delta(fast, "cls", "FAST-ARRIVAL (arr5 Q4-5) yearly delta by class")

    # 3. time of day / session
    delta_frame(m, "sess", "TIME OF DAY")
    m["is_rth"] = (m["tmin"] >= C.RTH_O) & (m["tmin"] < C.RTH_C)
    delta_frame(m, "is_rth", "RTH vs non-RTH")

    # 4. first vs later touch
    m["tix_b"] = np.where(m["touch_idx"] == 1, "1st",
                          np.where(m["touch_idx"] == 2, "2nd", "3rd+"))
    delta_frame(m, "tix_b", "TOUCH INDEX")
    for cls in ("PriorDay", "Overnight", "Opening", "Swing"):
        delta_frame(m[m["cls"] == cls], "tix_b", f"TOUCH INDEX within {cls}")

    # 5. level age (families that persist)
    pers = m[m["cls"].isin(["Swing", "PriorDay", "PriorWeek", "MultiTouch"])].copy()
    pers["age_b"] = pd.cut(pers["age_min"], [0, 120, 480, 1440, 10 ** 9],
                           labels=["<2h", "2-8h", "8-24h", ">24h"])
    delta_frame(pers, "age_b", "LEVEL AGE")

    # 6. confluence
    r = m[m["kind"] == "real"].copy()
    r["conf_b"] = np.where(r["conf_f"] >= 2, "conf2+",
                           np.where(r["conf_f"] == 1, "conf1",
                                    np.where(r["near_real"].fillna(999) > 15, "solo", "near")))
    print("\n===== CONFLUENCE (real levels) =====")
    tbl = table(r, "conf_b", "real by confluence", min_n=100)
    p_solo = base(m[(m["kind"] == "rand") & m["clean"] & (m["near_real"].fillna(999) > 15)])
    print(f"placebo-solo baseline: n={p_solo['n']} race15={p_solo['race15']:.3f} "
          f"brk60={p_solo['brk60']:.3f} ret60={p_solo['ret60']}")
    yearly = r.groupby(["conf_b", "year"]).apply(lambda g: base(g)["race15"]).unstack()
    print("real confluence race15 by year:\n", yearly.round(3).to_string())

    # 7. approach side
    delta_frame(m, "side", "APPROACH SIDE (b=from below/resistance)")
    for cls in ("PriorDay", "Overnight", "Opening"):
        delta_frame(m[m["cls"] == cls], "side", f"SIDE within {cls}")

    # 8. held vs broken contrast (extremes families, real, tol=5)
    print("\n===== HELD vs BROKEN (extremes, real): knowable-at-touch features =====")
    e = m[(m["kind"] == "real") & m["family"].isin(EXTREMES) & (m["valid_min"] >= 60)]
    e = e[~e["instant"]]  # exclude same-bar pierce ambiguity
    for feat in ("arr5", "touch_idx", "conf_f", "pen0", "age_min", "atr14d"):
        h = e.loc[~e["brk60"], feat].astype(float)
        b = e.loc[e["brk60"], feat].astype(float)
        se = np.sqrt(h.var() / max(len(h), 1) + b.var() / max(len(b), 1))
        print(f"  {feat:10s} held mean={h.mean():8.3f} (n={len(h)})  broken mean={b.mean():8.3f} "
              f"(n={len(b)})  d={h.mean()-b.mean():+8.3f}  z={(h.mean()-b.mean())/se:+.2f}")
    ht = e.groupby("sess")["brk60"].agg(["mean", "size"])
    print("P(broken<=60m) by session (extremes):\n", ht.round(3).to_string())

    # 9. per-seed placebo consistency
    print("\n===== placebo per-seed race15 (consistency check) =====")
    for s, g in m[(m["kind"] == "rand") & m["clean"]].groupby("seed"):
        b = base(g)
        print(f"  seed {s}: n={b['n']} race15={b['race15']:.3f}")

    # 10. horizon profile
    print("\n===== broken-by-H profile (real vs rand, tol=5) =====")
    for H in (5, 15, 30, 60):
        vr = m[(m["kind"] == "real") & (m["valid_min"] >= H)]
        vp = m[(m["kind"] == "rand") & m["clean"] & (m["valid_min"] >= H)]
        print(f"  H={H:3d}: P(pen>{C.P['brk']}) real={ (vr['pen'+str(H)]>C.P['brk']).mean():.3f} "
              f"rand={(vp['pen'+str(H)]>C.P['brk']).mean():.3f} | "
              f"P(ret>=15) real={(vr['ret'+str(H)]>=15).mean():.3f} "
              f"rand={(vp['ret'+str(H)]>=15).mean():.3f}")


if __name__ == "__main__":
    main()
