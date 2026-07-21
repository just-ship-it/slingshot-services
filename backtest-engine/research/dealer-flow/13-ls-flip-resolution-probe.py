#!/usr/bin/env python3
"""
Probe part 2 (Drew, 2026-07-16): does an LS flip NEAR a wall touch predict the
episode's RESOLUTION (rejected vs accepted)?

Joins P1 wall/placebo episodes (03-wall-episodes.py, episodes.json; ts=UTC
minute) against knowability-honest LS-1m flips (dumper stamps bar OPEN ->
knowable at stamp+60s).

Alignment convention: side='above' = price approached from above (level below
spot); rejection = price bounces UP -> a bullish flip (state=1) is
"rejection-aligned". side='below' mirrors.

Outcome universe: rejected vs accepted only (expired/roll dropped).
Placebo classes run through IDENTICAL machinery — a real level-specific signal
must separate on walls and NOT equally on placebo.
"""
import json
import csv
from datetime import datetime, timezone

REPO = "/home/drew/projects/slingshot-services/backtest-engine"
LS1_OFF_MS = 60_000
WINDOWS_MIN = (15, 30, 60)


def load_flips():
    out = []
    with open(f"{REPO}/research/lt-extraction/output/nq_ls_1m_raw.csv") as f:
        for r in csv.DictReader(f):
            out.append((int(r["unix_ms"]) + LS1_OFF_MS, int(r["state"])))
    out.sort()
    return out


def last_flip_before(flips, t_ms):
    lo, hi = 0, len(flips)
    while lo < hi:
        mid = (lo + hi) // 2
        if flips[mid][0] <= t_ms:
            lo = mid + 1
        else:
            hi = mid
    return None if lo == 0 else flips[lo - 1]


def main():
    flips = load_flips()
    eps = json.load(open(f"{REPO}/research/dealer-flow/episodes.json"))

    rows = []
    for e in eps:
        if e["resolution"] not in ("rejected", "accepted"):
            continue
        t = datetime.fromisoformat(e["ts"]).replace(tzinfo=timezone.utc)
        t_ms = int(t.timestamp() * 1000)
        lf = last_flip_before(flips, t_ms)
        if lf is None:
            continue
        age_min = (t_ms - lf[0]) / 60000.0
        bull = lf[1] == 1
        aligned = (bull and e["side"] == "above") or (not bull and e["side"] == "below")
        rows.append({
            "cls": e["cls"], "year": e["year"],
            "rej": 1 if e["resolution"] == "rejected" else 0,
            "age": age_min, "aligned": aligned,
        })

    print(f"episodes with LS coverage (rejected|accepted only): {len(rows)}")

    def report(rs, label):
        n = len(rs)
        if n == 0:
            return
        base = sum(r["rej"] for r in rs) / n
        print(f"\n== {label}: n={n} P(rejected) base={base:.3f}")
        print(f"{'window':>7s} {'group':22s} {'n':>6s} {'P(rej)':>7s} {'d_base':>7s}")
        for w in WINDOWS_MIN:
            rec = [r for r in rs if r["age"] <= w]
            ali = [r for r in rec if r["aligned"]]
            agn = [r for r in rec if not r["aligned"]]
            non = [r for r in rs if r["age"] > w]
            for g, name in ((ali, f"flip<= {w}m ALIGNED"), (agn, f"flip<= {w}m AGAINST"),
                            (non, f"no flip in {w}m")):
                if len(g) >= 20:
                    p = sum(r["rej"] for r in g) / len(g)
                    print(f"{w:>6d}m {name:22s} {len(g):6d} {p:7.3f} {p - base:+7.3f}")
        # state alignment regardless of recency
        ali = [r for r in rs if r["aligned"]]
        agn = [r for r in rs if not r["aligned"]]
        for g, name in ((ali, "state ALIGNED (any age)"), (agn, "state AGAINST (any age)")):
            p = sum(r["rej"] for r in g) / len(g)
            print(f"{'any':>7s} {name:22s} {len(g):6d} {p:7.3f} {p - base:+7.3f}")

    report([r for r in rows if r["cls"] == "wall"], "WALLS")
    report([r for r in rows if r["cls"] == "placebo_round"], "PLACEBO round-numbers")
    report([r for r in rows if r["cls"] == "placebo_rand"], "PLACEBO random")

    # per-year stability, walls, 30m window
    print("\n== per-year (walls, flip<=30m):")
    for y in ("2025", "2026"):
        rs = [r for r in rows if r["cls"] == "wall" and r["year"] == y]
        base = sum(r["rej"] for r in rs) / len(rs) if rs else float("nan")
        ali = [r for r in rs if r["age"] <= 30 and r["aligned"]]
        agn = [r for r in rs if r["age"] <= 30 and not r["aligned"]]
        pa = sum(r["rej"] for r in ali) / len(ali) if len(ali) >= 10 else float("nan")
        pg = sum(r["rej"] for r in agn) / len(agn) if len(agn) >= 10 else float("nan")
        print(f"  {y}: base={base:.3f} aligned={pa:.3f} (n={len(ali)}) against={pg:.3f} (n={len(agn)})")


if __name__ == "__main__":
    main()
