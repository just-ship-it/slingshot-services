#!/usr/bin/env python3
"""
R8-02: Conditional short/fade census. Every candidate measured vs the SAME-window
unconditional forward return (drift control), per year, pooled.

Hypotheses:
  H1 EXHAUSTION FADE: large intraday UP extension by time T -> forward (T->1600) fades down?
  H2 GAP-UP FADE:    large gap up (>K*ATR) -> forward RTH (open->1600) fades down?
  H6 DAY-AFTER:      big up day t -> weakness on t+1 (overnight gap, and RTH)?
  H5 VOL-REGIME:     high-ATR days -> afternoon (1300->1600 / 1500->1600) fade?

Buckets by conditioner quantile; reports forward mean per bucket, and for the
EXTREME up-conditioned bucket a per-year table + the unconditional control.
"""
import sys
sys.path.insert(0,"/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore")
from R8lib import load, mean, tstat, std
import math

def quantile_buckets(rows, condfn, fwdfn, nq=5):
    pairs=[(condfn(r),fwdfn(r),r) for r in rows]
    pairs=[p for p in pairs if p[0] is not None and p[1] is not None]
    pairs.sort(key=lambda p:p[0])
    n=len(pairs)
    out=[]
    for b in range(nq):
        lo=b*n//nq; hi=(b+1)*n//nq
        seg=pairs[lo:hi]
        cond=[p[0] for p in seg]; fwd=[p[1] for p in seg]
        out.append((mean(cond),mean(fwd),tstat(fwd),len(seg),[p[2] for p in seg]))
    return out,pairs

def peryear(subrows, fwdfn):
    d={}
    for r in subrows:
        v=fwdfn(r)
        if v is None: continue
        d.setdefault(r["year"],[]).append(v)
    cells=[]; signs=[]
    for y in sorted(d):
        xs=d[y]; m=mean(xs); cells.append(f"{y}:{m:+.1f}(n{len(xs)})"); signs.append(1 if m>0 else -1)
    pos=sum(1 for s in signs if s>0)
    return "  ".join(cells), pos, len(signs)

def report(title, rows, condfn, fwdfn, nq=5, extreme="hi"):
    print(f"\n### {title}")
    buckets,pairs=quantile_buckets(rows,condfn,fwdfn,nq)
    allfwd=[p[1] for p in pairs]
    print(f"  unconditional fwd: n={len(allfwd)} mean={mean(allfwd):+.2f}pt t={tstat(allfwd):+.2f}")
    for i,(cm,fm,ft,n,sub) in enumerate(buckets):
        tag="  <-- extreme-UP" if (extreme=="hi" and i==nq-1) else ("  <-- extreme-DOWN" if (extreme=="lo" and i==0) else "")
        print(f"  Q{i+1}: cond~{cm:+.2f}  fwd={fm:+.2f}pt (t{ft:+.2f}, n{n}){tag}")
    exb = buckets[-1] if extreme=="hi" else buckets[0]
    cells,pos,tot=peryear(exb[4],fwdfn)
    print(f"  extreme-bucket per-year: {cells}")
    print(f"  extreme-bucket year-signs: +{pos}/-{tot-pos}  (edge wants MOSTLY negative for a fade)")

def main():
    for prod in ("NQ","ES"):
        rows=load(prod)
        print(f"\n================ {prod} ================")
        atr=lambda r: r["atr14_prior"]
        # ---- H1 EXHAUSTION FADE at several T ----
        for T in ("1030","1100","1200","1300"):
            ext=lambda r,T=T: ((r[f"p{T}"]-r["p0930"])/r["atr14_prior"]) if (r[f"p{T}"] is not None and r["atr14_prior"]) else None
            fwd=lambda r,T=T: (r["p1600"]-r[f"p{T}"]) if (r[f"p{T}"] is not None and r["p1600"] is not None) else None
            report(f"H1 exhaustion: extension(open->{T})/ATR  -> fwd {T}->1600", rows, ext, fwd, nq=5, extreme="hi")
        # ---- H2 GAP-UP FADE ----
        gaproll=[r for r in rows if r["gap"] is not None and r["atr14_prior"]]
        gcond=lambda r: r["gap"]/r["atr14_prior"]
        gfwd=lambda r: (r["p1600"]-r["p0930"]) if (r["p1600"] is not None and r["p0930"] is not None) else None
        report("H2 gap-up fade: gap/ATR -> fwd RTH(open->1600)", gaproll, gcond, gfwd, nq=5, extreme="hi")
        # also open->1200 (early fade of gap)
        gfwd2=lambda r: (r["p1200"]-r["p0930"]) if (r["p1200"] is not None and r["p0930"] is not None) else None
        report("H2b gap-up fade: gap/ATR -> fwd open->1200", gaproll, gcond, gfwd2, nq=5, extreme="hi")

        # ---- H5 VOL-REGIME afternoon fade ----
        vf1=lambda r: (r["p1600"]-r["p1300"]) if (r["p1600"] is not None and r["p1300"] is not None) else None
        report("H5 vol-regime: ATR14 -> fwd 1300->1600", [r for r in rows if r["atr14_prior"]], atr, vf1, nq=5, extreme="hi")
        vf2=lambda r: (r["p1600"]-r["p1500"]) if (r["p1600"] is not None and r["p1500"] is not None) else None
        report("H5b vol-regime: ATR14 -> fwd 1500->1600", [r for r in rows if r["atr14_prior"]], atr, vf2, nq=5, extreme="hi")

        # ---- H6 DAY-AFTER big up day ----
        # link consecutive: build index by position; t+1 must be next row and roll_day==0
        for i in range(len(rows)-1):
            rows[i]["_next"]=rows[i+1]
        rows[-1]["_next"]=None
        def dcond(r):
            if not r["atr14_prior"]: return None
            return r["rth_ret"]/r["atr14_prior"]
        def dfwd_on(r):
            nx=r.get("_next")
            if nx is None or nx["roll_day"]==1 or nx["gap"] is None: return None
            return nx["gap"]  # overnight t->t+1 open
        def dfwd_rth(r):
            nx=r.get("_next")
            if nx is None or nx["roll_day"]==1: return None
            return nx["rth_ret"]
        base=[r for r in rows if r["atr14_prior"]]
        report("H6 day-after: rth_ret(t)/ATR -> overnight gap t+1", base, dcond, dfwd_on, nq=5, extreme="hi")
        report("H6b day-after: rth_ret(t)/ATR -> RTH ret t+1", base, dcond, dfwd_rth, nq=5, extreme="hi")

if __name__=="__main__":
    main()
