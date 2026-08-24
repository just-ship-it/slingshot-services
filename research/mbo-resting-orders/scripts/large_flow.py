#!/usr/bin/env python3
"""Per-minute LARGE-ORDER flow from MBO — the institutional-footprint proxy.

Size profile on NQ (2026-01-13, 19.1M front-month events) shows three classes:
    size 1  : 99.0% of adds, 6.1% fill, median life 0s   -> quote churn
    size 15 : anomalously common, 3.1% fill              -> posted and pulled
    size>=10: 46-58% fill, median life 31-47s            -> someone working size
So "institutions absorbing" is measurable only after filtering OUT the churn.

Emits per minute: large adds/cancels/fills by side, so accumulation (adds that FILL)
can be separated from flashing (adds that CANCEL).
"""
import sys, collections
mbo, out = sys.argv[1], sys.argv[2]
cnt = collections.Counter()
with open(mbo) as fh:
    fh.readline()
    for i, l in enumerate(fh):
        if i > 1_500_000: break
        s = l.rsplit(',', 1)[-1].strip()
        if '-' not in s: cnt[s] += 1
SYM = cnt.most_common(1)[0][0]
BIG = 10
info = {}
agg = collections.defaultdict(lambda: collections.Counter())
with open(mbo) as fh:
    fh.readline()
    for l in fh:
        p = l.split(',')
        if p[14].strip() != SYM: continue
        a, side, px, sz, oid, ts = p[5], p[6], p[7], p[8], p[10], p[1]
        m = ts[:16]
        if a == 'A':
            try: s = int(sz)
            except: continue
            if s >= BIG:
                info[oid] = (s, side, m)
                agg[m]['add_' + side] += s
        elif a in ('C', 'F'):
            v = info.pop(oid, None)
            if not v: continue
            s, sd, m0 = v
            try: fs = int(sz)
            except: fs = s
            agg[m][('fill_' if a == 'F' else 'cxl_') + sd] += (fs if a == 'F' else s)
with open(out, 'w') as fh:
    fh.write('minute,add_B,add_A,fill_B,fill_A,cxl_B,cxl_A\n')
    for m in sorted(agg):
        c = agg[m]
        fh.write(f"{m},{c['add_B']},{c['add_A']},{c['fill_B']},{c['fill_A']},{c['cxl_B']},{c['cxl_A']}\n")
print(f"{mbo.split('-')[-1][:8]} {SYM} minutes={len(agg)}")
