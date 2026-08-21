#!/usr/bin/env python3
"""Replay MBO to reconstruct full depth, snapshot resting size around each touch level.

mbp-1 could not answer the bounce/break question: NQ's inside book is 1-5 lots, far too
thin to represent "defence at a level". Real resting liquidity sits deeper, so the book has
to be rebuilt order-by-order.

usage: mbo_depth.py <mbo.csv> <touches.csv> <out.csv>
  touches.csv: sec,level,from_below,bounce,pm,atr,price,lvl_name
"""
import sys, csv, collections

mbo, touches_f, out_f = sys.argv[1], sys.argv[2], sys.argv[3]
day = mbo.split('-')[-1].split('.')[0]
day_iso = f"{day[:4]}-{day[4:6]}-{day[6:8]}"

tou = []
with open(touches_f) as fh:
    for r in csv.DictReader(fh):
        if r['sec'].startswith(day_iso):
            tou.append(r)
if not tou:
    sys.exit(0)
tou.sort(key=lambda r: r['sec'])
ti = 0

# front-month symbol = most frequent outright
cnt = collections.Counter()
with open(mbo) as fh:
    fh.readline()
    for i, line in enumerate(fh):
        if i > 2_000_000: break
        p = line.rsplit(',', 1)
        s = p[-1].strip()
        if '-' not in s: cnt[s] += 1
SYM = cnt.most_common(1)[0][0]

orders = {}                                   # oid -> (side, px, sz)
bid = collections.defaultdict(int)            # px -> resting size
ask = collections.defaultdict(int)
BAND = 5.0                                    # points either side of the level

def snap(level):
    lo, hi = level - BAND, level + BAND
    b = sum(s for p, s in bid.items() if lo <= p <= level and s > 0)
    a = sum(s for p, s in ask.items() if level <= p <= hi and s > 0)
    bw = sum(s for p, s in bid.items() if lo <= p <= hi and s > 0)
    aw = sum(s for p, s in ask.items() if lo <= p <= hi and s > 0)
    return b, a, bw, aw, len([1 for p, s in bid.items() if lo <= p <= hi and s > 0])

res = []
with open(mbo) as fh:
    fh.readline()
    for line in fh:
        f = line.split(',')
        if f[14].strip() != SYM: continue
        act, side, px, sz, oid = f[5], f[6], f[7], f[8], f[10]
        ts = f[0][:19]
        # flush any touches at or before this event
        while ti < len(tou) and tou[ti]['sec'] <= ts:
            lv = float(tou[ti]['level'])
            b, a, bw, aw, nlv = snap(lv)
            r = dict(tou[ti]); r.update(bid_at=b, ask_at=a, bid_band=bw, ask_band=aw, nlevels=nlv)
            res.append(r); ti += 1
        if act == 'R':
            orders.clear(); bid.clear(); ask.clear(); continue
        if not px or px == '': continue
        try:
            p = float(px); s = int(sz)
        except ValueError:
            continue
        book = bid if side == 'B' else ask if side == 'A' else None
        if book is None: continue
        if act == 'A':
            orders[oid] = (side, p, s); book[p] += s
        elif act in ('C', 'F'):
            o = orders.get(oid)
            if o:
                bk = bid if o[0] == 'B' else ask
                bk[o[1]] -= s if act == 'F' else o[2]
                if act == 'F':
                    ns = o[2] - s
                    if ns > 0: orders[oid] = (o[0], o[1], ns)
                    else: orders.pop(oid, None)
                else:
                    orders.pop(oid, None)
        elif act == 'M':
            o = orders.get(oid)
            if o:
                bk = bid if o[0] == 'B' else ask
                bk[o[1]] -= o[2]
            orders[oid] = (side, p, s); book[p] += s

if res:
    with open(out_f, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(res[0].keys()))
        w.writeheader(); w.writerows(res)
print(f"{day} sym={SYM} touches={len(res)}")
