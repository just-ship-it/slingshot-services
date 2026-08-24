#!/usr/bin/env python3
"""
Build our replicated short-basket indices from baskets.json + price CSVs.

At each rebalance (basket effective date, = FINRA settlement + 9 bdays):
  - post-price screens: close >= $1 and mcap (sharesOut x close) >= $100M
    at the last price on/before the effective date
  - top-20 by SI%% after screens
  - weights: SI%%-proportional ("weighted") and equal ("equal") — anchored at
    the rebalance CLOSE; returns accrue from the NEXT session (no lookahead).
Between rebalances weights drift with returns. Missing member-day (halt) or
series end (delisting): member dropped that day, weights renormalized.

Output: our_basket_daily.csv  (date, ret_w, ret_e, n_members)
        index levels printed for eyeballing.
"""
import csv, datetime as dt, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
PRICES = os.path.join(HERE, '..', '..', 'backtest-engine', 'data', 'shortinterest', 'prices')
BASKETS = os.path.join(HERE, 'baskets.json')
OUT = os.path.join(HERE, 'our_basket_daily.csv')
TOP_N = 20
MIN_PX = 1.0
MIN_MCAP = 100e6

def load_px(sym):
    p = os.path.join(PRICES, f'{sym.lower()}_1d.csv')
    if not os.path.exists(p):
        return None
    out = {}
    with open(p) as f:
        r = csv.reader(f)
        head = next(r)
        di, ci = head.index('date'), head.index('close')
        for row in r:
            try:
                out[row[di]] = float(row[ci])
            except (ValueError, IndexError):
                pass
    return out or None

def main():
    baskets = json.load(open(BASKETS))
    px = {}
    for b in baskets.values():
        for m in b['members'] + b.get('members_dtc', []):
            if m['sym'] not in px:
                px[m['sym']] = load_px(m['sym'])
    have = sum(1 for v in px.values() if v)
    print(f'prices: {have}/{len(px)} constituents', flush=True)

    all_dates = sorted({d for v in px.values() if v for d in v})
    date_ix = {d: i for i, d in enumerate(all_dates)}

    def px_asof(sym, date):
        s = px.get(sym)
        if not s:
            return None
        if date in s:
            return s[date]
        i = date_ix.get(date)
        if i is None:
            return None
        for j in range(i - 1, max(i - 8, -1), -1):
            if all_dates[j] in s:
                return s[all_dates[j]]
        return None

    import sys
    variant = sys.argv[1] if len(sys.argv) > 1 else 'sipct'
    mkey = 'members' if variant == 'sipct' else 'members_dtc'
    wkey = 'siPct' if variant == 'sipct' else 'dtc'
    global OUT
    if variant != 'sipct':
        OUT = OUT.replace('.csv', f'_{variant}.csv')
    print(f'variant: {variant} ({mkey}, weight={wkey})', flush=True)

    # rebalance schedule: effectiveDate -> screened top-20 with anchor weights
    rebs = []
    for sdate in sorted(baskets):
        b = baskets[sdate]
        eff = b['effectiveDate']
        mem = []
        for m in b[mkey]:
            c = px_asof(m['sym'], eff)
            if c is None or c < MIN_PX:
                continue
            if m.get('sharesOut') and c * m['sharesOut'] < MIN_MCAP:
                continue
            if not m.get('sharesOut') and c * m['adv'] < 3e6:  # dtc variant: $ liquidity proxy
                continue
            mem.append((m['sym'], m[wkey]))
            if len(mem) == TOP_N:
                break
        if len(mem) >= 10:
            rebs.append((eff, mem))
    print(f'rebalances usable: {len(rebs)} (first {rebs[0][0]}, last {rebs[-1][0]})', flush=True)

    rows = []
    lvl_w = lvl_e = 100.0
    for ri, (eff, mem) in enumerate(rebs):
        w_w = {s: p for s, p in mem}
        tot = sum(w_w.values())
        w_w = {s: v / tot for s, v in w_w.items()}
        w_e = {s: 1 / len(mem) for s, _ in mem}
        end = rebs[ri + 1][0] if ri + 1 < len(rebs) else '9999'
        i0 = date_ix.get(eff)
        if i0 is None:
            i0 = next((i for i, d in enumerate(all_dates) if d >= eff), None)
        if i0 is None:
            continue
        for i in range(i0 + 1, len(all_dates)):
            d = all_dates[i]
            if d > end or (end != '9999' and d > end):
                break
            prev = all_dates[i - 1]
            rw = re_ = tw = te = 0.0
            n = 0
            for w_map, acc in ((w_w, 'w'), (w_e, 'e')):
                pass
            # compute member returns once
            rets = {}
            for s in w_w:
                c0, c1 = px_asof(s, prev), px.get(s, {}).get(d)
                if c0 and c1 and c0 > 0:
                    rets[s] = c1 / c0 - 1
            if not rets:
                continue
            sw = sum(w_w[s] for s in rets)
            se = sum(w_e[s] for s in rets)
            rw = sum(w_w[s] * rets[s] for s in rets) / sw if sw else 0.0
            re_ = sum(w_e[s] * rets[s] for s in rets) / se if se else 0.0
            # drift weights
            for s in list(w_w):
                if s in rets:
                    w_w[s] *= (1 + rets[s])
                    w_e[s] *= (1 + rets[s])
            for w_map in (w_w, w_e):
                t = sum(w_map.values())
                for s in w_map:
                    w_map[s] /= t
            lvl_w *= (1 + rw)
            lvl_e *= (1 + re_)
            rows.append((d, rw, re_, len(rets)))
            if end != '9999' and d == end:
                break

    # dedupe on date (rebalance-day overlap), last wins
    dedup = {}
    for d, rw, re_, n in rows:
        dedup[d] = (rw, re_, n)
    with open(OUT, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['date', 'ret_w', 'ret_e', 'n_members'])
        for d in sorted(dedup):
            rw, re_, n = dedup[d]
            w.writerow([d, f'{rw:.6f}', f'{re_:.6f}', n])
    print(f'daily rows: {len(dedup)} ({min(dedup)} -> {max(dedup)})', flush=True)
    print(f'final levels: weighted {lvl_w:.1f}, equal {lvl_e:.1f} (base 100)', flush=True)

if __name__ == '__main__':
    main()
