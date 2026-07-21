#!/usr/bin/env python3
"""
Probe (Drew, 2026-07-16): can LT levels / LS state predict the SIGNED dealer
gamma (dg_sign) at a DWF wall? If yes, a price-derived live proxy for the
options-tape flow signing might exist. Ground truth: dwf_levels.csv dg_sign
(TCBBO quote-rule flow signing, 2025-02 -> 2026-01).

Knowability: all features are computed as-of 09:45 ET of the wall's date
(dwf levels go live >=09:45 ET). LS stamps are bar-OPEN (dumper) -> shifted
+60s (1m) / +900s (15m) before comparison. LT rows are live-captured
(knowable at stamp).

Output: per-feature accuracy/lift vs base rate, AUC for continuous features,
per-quarter stability for anything that looks alive.
"""
import csv
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from collections import defaultdict

ET = ZoneInfo("America/New_York")
REPO = "/home/drew/projects/slingshot-services/backtest-engine"

LS15_OFF = 900_000   # ms, bar-open stamp -> knowable at close
LS1_OFF = 60_000


def load_flips(path, off_ms):
    """[(knowable_ms, state)] sorted."""
    out = []
    with open(path) as f:
        for r in csv.DictReader(f):
            out.append((int(r["unix_ms"]) + off_ms, int(r["state"])))
    out.sort()
    return out


def state_at(flips, t_ms):
    """(state, ms_since_flip, flips_last_24h) as of t_ms; None if before data."""
    lo, hi = 0, len(flips)
    while lo < hi:
        mid = (lo + hi) // 2
        if flips[mid][0] <= t_ms:
            lo = mid + 1
        else:
            hi = mid
    if lo == 0:
        return None
    idx = lo - 1
    n24 = 0
    j = idx
    while j >= 0 and flips[j][0] > t_ms - 86_400_000:
        n24 += 1
        j -= 1
    return flips[idx][1], t_ms - flips[idx][0], n24


def load_lt_rows(path, dates_needed):
    """date -> last row (levels list, sentiment) with ts <= 09:45 ET that date."""
    cutoff = {}
    for d in dates_needed:
        dt = datetime.fromisoformat(f"{d}T09:45:00").replace(tzinfo=ET)
        cutoff[d] = int(dt.astimezone(timezone.utc).timestamp() * 1000)
    best = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            ts = int(r["unix_timestamp"])
            for d, cut in cutoff.items():
                if cut - 86_400_000 <= ts <= cut:
                    prev = best.get(d)
                    if prev is None or ts > prev[0]:
                        levels = []
                        for k in ("level_1", "level_2", "level_3", "level_4", "level_5"):
                            try:
                                v = float(r[k])
                                if v > 0:
                                    levels.append(v)
                            except (ValueError, TypeError, KeyError):
                                pass
                        best[d] = (ts, levels, r.get("sentiment", ""))
    return best


def auc(pos, neg):
    """rank AUC of continuous feature separating pos from neg."""
    allv = [(v, 1) for v in pos] + [(v, 0) for v in neg]
    allv.sort()
    r, rsum = 0, 0.0
    i = 0
    while i < len(allv):
        j = i
        while j < len(allv) and allv[j][0] == allv[i][0]:
            j += 1
        avg_rank = (i + j + 1) / 2.0
        for k in range(i, j):
            if allv[k][1] == 1:
                rsum += avg_rank
        i = j
    n1, n0 = len(pos), len(neg)
    if n1 == 0 or n0 == 0:
        return None
    return (rsum - n1 * (n1 + 1) / 2.0) / (n1 * n0)


def main():
    walls = []
    with open(f"{REPO}/data/features/dwf_levels.csv") as f:
        for r in csv.DictReader(f):
            walls.append({"date": r["date"], "level": float(r["level_nq"]),
                          "kind": r["kind"], "y": int(r["dg_sign"]),
                          "dte0": float(r["dte0_share"])})
    dates = sorted({w["date"] for w in walls})
    print(f"walls={len(walls)} days={len(dates)} window={dates[0]}..{dates[-1]}")

    ls15 = load_flips(f"{REPO}/research/lt-extraction/output/nq_ls_15m_raw.csv", LS15_OFF)
    ls1 = load_flips(f"{REPO}/research/lt-extraction/output/nq_ls_1m_raw.csv", LS1_OFF)
    lt = load_lt_rows(f"{REPO}/data/liquidity/nq/NQ_liquidity_levels.csv", dates)
    print(f"lt rows resolved for {len(lt)}/{len(dates)} days")

    rows = []
    for w in walls:
        d = w["date"]
        t945 = int(datetime.fromisoformat(f"{d}T09:45:00").replace(tzinfo=ET)
                   .astimezone(timezone.utc).timestamp() * 1000)
        s15 = state_at(ls15, t945)
        s1 = state_at(ls1, t945)
        ltr = lt.get(d)
        feat = {"y": 1 if w["y"] > 0 else 0, "kind": w["kind"], "q": d[:4] + "Q" + str((int(d[5:7]) - 1) // 3 + 1)}
        if s15:
            feat["ls15"] = s15[0]
            feat["ls15_hrs_since"] = s15[1] / 3.6e6
            feat["ls15_flips24"] = s15[2]
        if s1:
            feat["ls1"] = s1[0]
            feat["ls1_flips24"] = s1[2]
        if ltr:
            _, levels, sent = ltr
            if levels:
                dists = [abs(x - w["level"]) for x in levels]
                nearest = min(dists)
                feat["lt_dist"] = nearest
                feat["lt_within25"] = 1 if nearest <= 25 else 0
                feat["lt_within50"] = 1 if nearest <= 50 else 0
                near_lv = levels[dists.index(nearest)]
                feat["lt_above"] = 1 if near_lv > w["level"] else 0
            if sent:
                feat["lt_sent_bull"] = 1 if sent.upper() == "BULLISH" else 0
        rows.append(feat)

    have = [r for r in rows if "ls15" in r]
    base = sum(r["y"] for r in have) / len(have)
    maj = max(base, 1 - base)
    print(f"\nn with LS features = {len(have)}; P(dg=+1) = {base:.3f}; majority acc = {maj:.3f}\n")

    # binary features: accuracy of best single split + per-class rates
    bins = ["ls15", "ls1", "lt_within25", "lt_within50", "lt_above", "lt_sent_bull"]
    print(f"{'feature':16s} {'n':>5s} {'P(y=1|f=1)':>11s} {'P(y=1|f=0)':>11s} {'bestAcc':>8s} {'lift':>6s}")
    for b in bins:
        sub = [r for r in rows if b in r]
        if len(sub) < 100:
            print(f"{b:16s} n={len(sub)} (insufficient)")
            continue
        p1 = [r["y"] for r in sub if r[b] == 1]
        p0 = [r["y"] for r in sub if r[b] == 0]
        if not p1 or not p0:
            print(f"{b:16s} degenerate")
            continue
        r1, r0 = sum(p1) / len(p1), sum(p0) / len(p0)
        bmaj = max(sum(r["y"] for r in sub) / len(sub), 1 - sum(r["y"] for r in sub) / len(sub))
        acc = max((r1 * len(p1) + (1 - r0) * len(p0)) / len(sub),
                  ((1 - r1) * len(p1) + r0 * len(p0)) / len(sub))
        print(f"{b:16s} {len(sub):5d} {r1:11.3f} {r0:11.3f} {acc:8.3f} {acc - bmaj:+6.3f}")

    # continuous: AUC
    print(f"\n{'feature':16s} {'n':>5s} {'AUC':>6s}")
    for cfeat in ["lt_dist", "ls15_hrs_since", "ls15_flips24", "ls1_flips24"]:
        sub = [r for r in rows if cfeat in r]
        if len(sub) < 100:
            continue
        a = auc([r[cfeat] for r in sub if r["y"] == 1],
                [r[cfeat] for r in sub if r["y"] == 0])
        print(f"{cfeat:16s} {len(sub):5d} {a:6.3f}")

    # interaction: ls15 x kind
    print("\nls15 x kind -> P(dg=+1):")
    for kind in ("sup", "res"):
        for s in (0, 1):
            sub = [r for r in rows if r.get("ls15") == s and r["kind"] == kind]
            if sub:
                print(f"  kind={kind} ls15={s}: n={len(sub):4d} P={sum(r['y'] for r in sub)/len(sub):.3f}")

    # per-quarter stability of the strongest-looking binary (ls15)
    print("\nper-quarter P(dg=+1 | ls15=1) vs P(dg=+1 | ls15=0):")
    qs = sorted({r["q"] for r in have})
    for q in qs:
        sub = [r for r in have if r["q"] == q]
        a = [r["y"] for r in sub if r["ls15"] == 1]
        b = [r["y"] for r in sub if r["ls15"] == 0]
        pa = sum(a) / len(a) if a else float("nan")
        pb = sum(b) / len(b) if b else float("nan")
        print(f"  {q}: n={len(sub):4d}  ls15=1: {pa:.3f} (n={len(a)})  ls15=0: {pb:.3f} (n={len(b)})")


if __name__ == "__main__":
    main()
