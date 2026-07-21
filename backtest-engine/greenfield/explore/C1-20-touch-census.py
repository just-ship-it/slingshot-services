#!/usr/bin/env python3
"""C1-20: touch census over the levels registry + placebos.

For every level (real / random-offset placebo x3 seeds / round-100 grid) and
every tolerance in {2,5,10}pts: detect touches (arm >=25pts away first),
measure forward outcomes from the bar AFTER the touch bar:
  pen{5,15,30,60}  max penetration beyond the level (pts, approach direction)
  ret{5,15,30,60}  max retrace away from the level (MFE against approach)
  t_brk            first minute with penetration > 5pts (<=120m, -1 if none)
  t_r15/t_r35      first minute with retrace >= 15/35pts
  t_reenter        after a break: first minute back >=2pts on origin side
Touch-bar overshoot is stored separately as pen0 (same-bar ambiguity).

Knowable-at-touch features: arr5 (side x (extreme - close_5m_ago) / 1m-ATR14),
tod bucket, touch index in level lifetime, level age, confluence (other real
families within 5pts), approach side, session.

Output: C1-touches.csv.gz (one row per touch per tolerance channel).
Usage: python3 C1-20-touch-census.py [START_TD] [END_TD]
"""
import csv, gzip, sys, time
import numpy as np
import pandas as pd
import C1_common as C

P = C.P

FIELDS = ["td", "year", "tmin", "bi", "tol", "kind", "seed", "family", "level_id",
          "L", "side", "sess", "touch_idx", "age_min", "arr5", "raw5", "atr1m",
          "atr14d", "conf_n", "conf_f", "near_real", "pen0", "close_rel",
          "pen5", "pen15", "pen30", "pen60", "ret5", "ret15", "ret30", "ret60",
          "t_brk", "t_r15", "t_r35", "t_reenter", "valid_min"]


def dyn_series(d, fam):
    """Causal dynamic level series (2-bar knowability lag), NaN outside."""
    T, h, l, c, v = d["tmin"], d["h"], d["l"], d["c"], d["v"]
    n = len(T)
    out = np.full(n, np.nan)
    tp = (h + l + c) / 3.0
    if fam == "VWAP":
        m = (T >= C.RTH_O) & (T < C.RTH_C)
        cv = np.where(m, v, 0.0)
        cpv = np.where(m, tp * v, 0.0)
        csv_ = np.cumsum(cv)
        cspv = np.cumsum(cpv)
        for i in range(2, n):
            if T[i] >= C.RTH_O + 8 and csv_[i - 2] > 0:
                out[i] = cspv[i - 2] / csv_[i - 2]
    elif fam == "RPOC":
        binw = P["vap_bin"]
        prof = {}
        best_bin, best_v = None, -1.0
        poc_hist = np.full(n, np.nan)
        for i in range(n):
            b = round(tp[i] / binw)
            prof[b] = prof.get(b, 0.0) + v[i]
            if prof[b] > best_v:
                best_v, best_bin = prof[b], b
            poc_hist[i] = best_bin * binw
        out[2:] = poc_hist[:-2]
        out[:130] = np.nan  # need some accumulation; active from tmin 120 anyway
    return out


def main():
    t0 = time.time()
    start = sys.argv[1] if len(sys.argv) > 1 else None
    end = sys.argv[2] if len(sys.argv) > 2 else None
    days = C.load_days()
    bars = C.load_bars(C.NQ_1M)
    dm = C.day_arrays(bars)
    all_tds = list(days.index)
    td_pos = {td: k for k, td in enumerate(all_tds)}
    use = [td for td in C.usable_tds(days, dm, start, end)]
    reg = pd.read_csv(f"{C.HERE}/C1-levels-registry.csv")
    reg_by_td = {td: g for td, g in reg.groupby("td")}
    print(f"census over {len(use)} tds ({time.time()-t0:.0f}s load)", flush=True)

    suffix = "" if not start else f".{start}_{end}"
    outp = f"{C.HERE}/C1-touches{suffix}.csv.gz"
    fh = gzip.open(outp, "wt", newline="")
    W = csv.writer(fh)
    W.writerow(FIELDS)

    counters = {}   # (channel_key, tol) -> touches so far (lifetime)
    nrows = 0

    for tdi, td in enumerate(use):
        if td not in reg_by_td:
            continue
        d = dm[td]
        T, h, l, c = d["tmin"], d["h"], d["l"], d["c"]
        n = len(T)
        dn = n
        atr1 = C.atr1m_series(h, l, c)
        atr14d = float(days.loc[td, "atr14_prior"])
        year = td[:4]
        g = reg_by_td[td]

        # --- build channels: (key, family, kind, seed, L, i0, i1, born_gidx)
        channels = []
        real_static = []  # (price, act_from, act_to, family, level_id) for confluence
        for r in g.itertuples(index=False):
            i0 = int(np.searchsorted(T, r.act_from))
            i1 = int(np.searchsorted(T, r.act_to))
            if i1 - i0 < 5:
                continue
            if r.dynamic:
                S = dyn_series(d, r.family)
                channels.append((r.level_id, r.family, "real", 0, S, i0, i1, r.born_gidx))
                for s in range(1, P["n_seeds"] + 1):
                    off = C.rand_offset(r.level_id, s)
                    channels.append((r.level_id, r.family, "rand", s, S + off, i0, i1, r.born_gidx))
            else:
                channels.append((r.level_id, r.family, "real", 0, float(r.price), i0, i1, r.born_gidx))
                real_static.append((float(r.price), r.act_from, r.act_to, r.family, r.level_id))
                for s in range(1, P["n_seeds"] + 1):
                    off = C.rand_offset(r.level_id, s)
                    channels.append((r.level_id, r.family, "rand", s, float(r.price) + off,
                                     i0, i1, r.born_gidx))
        # round grid
        gridw = P["round_grid"]
        glo = np.floor((l.min() - 30) / gridw) * gridw
        ghi = np.ceil((h.max() + 30) / gridw) * gridw
        base_g = td_pos[td] * C.TD_END
        for gp in np.arange(glo, ghi + 1, gridw):
            channels.append((f"RN:{td}:{int(gp)}", "ROUND", "round", 0, float(gp), 0, n, base_g))

        # confluence arrays (real static levels + dynamic real values)
        if real_static:
            cf_p = np.array([x[0] for x in real_static])
            cf_a0 = np.array([x[1] for x in real_static])
            cf_a1 = np.array([x[2] for x in real_static])
            cf_fam = np.array([x[3] for x in real_static])
            cf_id = np.array([x[4] for x in real_static])
        else:
            cf_p = np.zeros(0)
        dynvals = {}
        for fam in ("VWAP", "RPOC"):
            dynvals[fam] = dyn_series(d, fam)

        for key, fam, kind, seed, L, i0, i1, born_g in channels:
            for tol in P["tols"]:
                evs = C.touch_events(h, l, L, i0, i1, tol, P["arm"])
                if not evs:
                    continue
                ck = (key, seed, tol)
                for (i, side) in evs:
                    counters[ck] = counters.get(ck, 0) + 1
                    tix = counters[ck]
                    Lv = float(L[i]) if isinstance(L, np.ndarray) else L
                    o = C.outcomes(h, l, c, i, dn, Lv, side)
                    tmin_i = int(T[i])
                    gidx = td_pos[td] * C.TD_END + tmin_i
                    age = gidx - born_g
                    # arrival speed
                    arr5 = raw5 = np.nan
                    if i >= 5 and np.isfinite(atr1[i]) and atr1[i] > 0.05:
                        if side == "b":
                            raw5 = h[i] - c[i - 5]
                        else:
                            raw5 = c[i - 5] - l[i]
                        arr5 = raw5 / atr1[i]
                    # confluence vs real structure
                    conf_n = conf_f = 0
                    near = np.nan
                    if len(cf_p):
                        act = (cf_a0 <= tmin_i) & (tmin_i < cf_a1) & (cf_id != key)
                        if act.any():
                            dd = np.abs(cf_p[act] - Lv)
                            near = float(dd.min())
                            m5 = dd <= P["conf_d"]
                            conf_n = int(m5.sum())
                            fams = set(cf_fam[act][m5])
                            for fmn, dv in dynvals.items():
                                if fmn != fam and np.isfinite(dv[i]) and abs(dv[i] - Lv) <= P["conf_d"]:
                                    fams.add(fmn)
                                    conf_n += 1
                            conf_f = len(fams)
                    W.writerow([td, year, tmin_i, i, tol, kind, seed, fam, key,
                                round(Lv, 2), side, C.tod_bucket(tmin_i), tix, age,
                                None if not np.isfinite(arr5) else round(arr5, 3),
                                None if not np.isfinite(raw5) else round(raw5, 2),
                                None if not np.isfinite(atr1[i]) else round(atr1[i], 3),
                                round(atr14d, 1), conf_n, conf_f,
                                None if not np.isfinite(near) else round(near, 1),
                                round(o["pen0"], 2), round(o["close_rel"], 2),
                                *[None if not np.isfinite(o[f"pen{H}"]) else round(o[f"pen{H}"], 2)
                                  for H in P["horizons"]],
                                *[None if not np.isfinite(o[f"ret{H}"]) else round(o[f"ret{H}"], 2)
                                  for H in P["horizons"]],
                                o["t_brk"], o["t_r15"], o["t_r35"], o["t_reenter"],
                                o["valid_min"]])
                    nrows += 1
        if (tdi + 1) % 100 == 0:
            print(f"  {tdi+1}/{len(use)} tds, {nrows} touches, {time.time()-t0:.0f}s", flush=True)

    fh.close()
    print(f"DONE {nrows} touch rows -> {outp} ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
