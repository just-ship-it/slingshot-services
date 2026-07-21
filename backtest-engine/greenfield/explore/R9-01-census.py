#!/usr/bin/env python3
"""R9-01: midday / European-close flow census (NQ, ES cross-check).

Descriptive only: signed forward returns on 1m OPEN, per-day (once/window/day so
pooled==day-weighted). Points AND ATR-normalized. Per-year sign stability. Matched
placebo windows. Separates event vol (|move|) from signed drift.

Run: python3 R9-01-census.py [nq|es]   (default nq; both printed if 'both')
"""
import sys, numpy as np
from collections import defaultdict
import R9_common as R

def signed_drift(O,meta,a0,a1):
    """unconditional signed drift a0->a1: per-day, per-year."""
    vals=[]; py=[]; valsatr=[]
    for d in O:
        r=R.op(O,d,a1)-R.op(O,d,a0)
        if not np.isfinite(r): continue
        y,dow,atr=meta[d]
        vals.append(r); py.append((y,r))
        if np.isfinite(atr) and atr>0: valsatr.append(r/atr)
    s=R.summary(vals); s['atr']=np.mean(valsatr) if valsatr else float('nan')
    return s, R.per_year(py)

def cond_drift(O,meta,sig_a0,sig_a1,ret_a0,ret_a1,mode,strength_terc=None):
    """Signal from sign(open[sig_a1]-open[sig_a0]); trade over ret window.
    mode='fade' -> -sign ; mode='extend' -> +sign.
    strength_terc: None or (which,) select |signal|/atr tercile in {0:weak,1:mid,2:strong}.
    Returns per-day realized pts = side*ret, side per mode, and per-year."""
    # first pass collect strengths for tercile edges (by year? use pooled edges)
    recs=[]
    for d in O:
        sig=R.op(O,d,sig_a1)-R.op(O,d,sig_a0)
        ret=R.op(O,d,ret_a1)-R.op(O,d,ret_a0)
        y,dow,atr=meta[d]
        if not (np.isfinite(sig) and np.isfinite(ret) and np.isfinite(atr) and atr>0): continue
        recs.append((d,y,sig,ret,atr))
    strengths=np.array([abs(s/a) for _,_,s,_,a in recs])
    if strength_terc is not None and len(strengths)>10:
        q=np.quantile(strengths,[1/3,2/3])
    vals=[]; py=[]
    for d,y,sig,ret,atr in recs:
        st=abs(sig/atr)
        if strength_terc is not None:
            which=strength_terc
            if which==0 and not (st<q[0]): continue
            if which==1 and not (q[0]<=st<q[1]): continue
            if which==2 and not (st>=q[1]): continue
        side=(-1 if mode=='fade' else 1)*np.sign(sig)
        v=side*ret
        vals.append(v); py.append((y,v))
    s=R.summary(vals)
    return s, R.per_year(py)

def block(title): print("\n"+"="*78+"\n"+title+"\n"+"="*78)

def run(inst):
    O,Hh,Ll,meta=R.load(inst)
    print(f"\n######## INSTRUMENT {inst.upper()}  days={len(O)} ########")

    # ---------- H3 + CONTROLS: unconditional 30-min signed drift ----------
    block("H3 UNCONDITIONAL 30-min SIGNED DRIFT (midday + placebo windows)")
    windows=[("0930-1000","o930","o1000"),("1000-1030","o1000","o1030"),  # placebo AM
             ("1030-1100","o1030","o1100"),
             ("1100-1130","o1100","o1130"),("1130-1200","o1130","o1200"),  # midday
             ("1200-1230","o1200","o1230"),("1230-1300","o1230","o1300"),
             ("1300-1330","o1300","o1330"),
             ("1330-1400","o1330","o1400"),("1400-1430","o1400","o1430"),  # placebo PM
             ("1500-1530","o1500","o1530")]
    rows=[]
    for name,a0,a1 in windows:
        s,py=signed_drift(O,meta,a0,a1)
        yrs={y:v[0] for y,v in py.items()}
        pos=sum(1 for v in yrs.values() if v>0); neg=len(yrs)-pos
        print(f"{name}: mean={s['mean']:+.2f}pt atr={s['atr']:+.3f} t={s['t']:+.2f} n={s['n']} "
              f"WR={s['wr']*100:.0f}% | yrs+{pos}/-{neg}")
        print("        "+R.fmt_year(py))
        rows.append((name,s['mean'],s['atr'],s['t'],pos,neg,s['n']))

    # ---------- H1: European-close window, conditioned on morning direction ----------
    block("H1 EUROPEAN CLOSE (~11:25-11:45) vs morning move (0930->1130)")
    print("-- unconditional euclose window drift (control) --")
    for nm,a0,a1 in [("1125-1145","o1125","o1145"),("1120? use1100-1130","o1100","o1130"),
                     ("1130-1200","o1130","o1200")]:
        s,py=signed_drift(O,meta,a0,a1)
        print(f"  {nm}: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']}")
    print("-- FADE morning at 11:25 -> exit 11:45 (side=-sign(0930->1130)) --")
    s,py=cond_drift(O,meta,"o930","o1130","o1125","o1145","fade")
    print(f"  FADE: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']} WR={s['wr']*100:.0f}%")
    print("       "+R.fmt_year(py))
    print("-- EXTEND morning at 11:25 -> 11:45 --")
    s,py=cond_drift(O,meta,"o930","o1130","o1125","o1145","extend")
    print(f"  EXT : mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']}")
    print("-- FADE morning at 11:30 -> exit 12:00 (longer hold) --")
    s,py=cond_drift(O,meta,"o930","o1130","o1130","o1200","fade")
    print(f"  FADE30: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']}")
    print("       "+R.fmt_year(py))
    print("-- FADE morning at 11:30 -> exit 13:00 (into lunch) --")
    s,py=cond_drift(O,meta,"o930","o1130","o1130","o1300","fade")
    print(f"  FADE->13: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']}")
    print("       "+R.fmt_year(py))

    # ---------- H2: lunch reversal ----------
    block("H2 LUNCH REVERSAL: fade late-morning (1030->1200) during 12:00-13:00")
    print("-- unconditional lunch-window drift (control) --")
    for nm,a0,a1 in [("1200-1300","o1200","o1300"),("1200-1330","o1200","o1330")]:
        s,py=signed_drift(O,meta,a0,a1)
        print(f"  {nm}: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']}")
    for hold,rn in [("o1300","1200->1300"),("o1330","1200->1330")]:
        print(f"-- FADE 1030->1200 move, exit {rn} (all days) --")
        s,py=cond_drift(O,meta,"o1030","o1200","o1200",hold,"fade")
        print(f"  FADE: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']} WR={s['wr']*100:.0f}%")
        print("       "+R.fmt_year(py))
    print("-- FADE conditioned on STRONG late-morning (top tercile |move|/atr), exit 1300 --")
    s,py=cond_drift(O,meta,"o1030","o1200","o1200","o1300","fade",strength_terc=2)
    print(f"  FADE|strong: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']}")
    print("       "+R.fmt_year(py))
    print("-- FADE conditioned on WEAK late-morning (bottom tercile), exit 1300 --")
    s,py=cond_drift(O,meta,"o1030","o1200","o1200","o1300","fade",strength_terc=0)
    print(f"  FADE|weak: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']}")

    # ---------- H4: post-lunch trend resumption ----------
    block("H4 POST-LUNCH RESUMPTION: extend morning (0930->1200) over 1300-1400")
    print("-- unconditional 1300-1400 drift (control) --")
    s,py=signed_drift(O,meta,"o1300","o1400"); print(f"  1300-1400: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']}")
    for terc,tn in [(None,"all"),(2,"strong-morning"),(0,"weak-morning")]:
        print(f"-- EXTEND 0930->1200 morning, exit 1400 | {tn} --")
        s,py=cond_drift(O,meta,"o930","o1200","o1300","o1400","extend",strength_terc=terc)
        print(f"  EXT|{tn}: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']} WR={s['wr']*100:.0f}%")
        print("       "+R.fmt_year(py))
    print("-- EXTEND morning, exit 1500 (longer) | strong --")
    s,py=cond_drift(O,meta,"o930","o1200","o1300","o1500","extend",strength_terc=2)
    print(f"  EXT->1500|strong: mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']}")
    print("       "+R.fmt_year(py))

    # ---------- H5: midday range compression -> afternoon breakout ----------
    block("H5 MIDDAY COMPRESSION (11:00-13:00 range) -> 13:00-15:00 expansion/direction")
    recs=[]
    for d in O:
        h,l=R.win_hilo(Hh,Ll,d,"o1100","o1300")
        if not (np.isfinite(h) and np.isfinite(l)): continue
        y,dow,atr=meta[d]
        if not (np.isfinite(atr) and atr>0): continue
        mid=(h+l)/2.0
        p1300=R.op(O,d,"o1300"); p1500=R.op(O,d,"o1500")
        if not (np.isfinite(p1300) and np.isfinite(p1500)): continue
        rng=(h-l)/atr
        pm_move=p1500-p1300
        recs.append((d,y,rng,mid,p1300,pm_move,atr))
    rngs=np.array([r[2] for r in recs]); q=np.quantile(rngs,[1/3,2/3])
    print(f"  11-13 range/atr terciles: <{q[0]:.2f} | {q[0]:.2f}-{q[1]:.2f} | >{q[1]:.2f}  n={len(recs)}")
    # event vol: |afternoon move| by compression tercile (expansion check)
    for lab,sel in [("compressed(lo)",lambda x:x<q[0]),("mid",lambda x:q[0]<=x<q[1]),("wide(hi)",lambda x:x>=q[1])]:
        sub=[r for r in recs if sel(r[2])]
        absmv=np.mean([abs(r[5])/r[6] for r in sub])
        print(f"  |1300-1500 move|/atr | {lab}: {absmv:.3f}  n={len(sub)}")
    # directional: signal at 1300 = sign(p1300 - midpoint), exit 1500, compressed only
    print("-- BREAKOUT direction = sign(p1300 - 11-13 midpoint), exit 1500, COMPRESSED days --")
    vals=[]; py=[]
    for d,y,rng,mid,p1300,pm_move,atr in recs:
        if rng>=q[0]: continue
        side=np.sign(p1300-mid)
        if side==0: continue
        v=side*pm_move; vals.append(v); py.append((y,v))
    s=R.summary(vals); print(f"  mean={s['mean']:+.2f}pt t={s['t']:+.2f} n={s['n']} WR={s['wr']*100:.0f}%")
    print("       "+R.fmt_year(R.per_year(py)))

if __name__=="__main__":
    which=sys.argv[1] if len(sys.argv)>1 else "nq"
    if which=="both":
        run("nq"); run("es")
    else:
        run(which)
