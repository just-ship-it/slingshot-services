"""R8 shared helpers: load daily panel, stats, per-year tables."""
import csv, math

MARKS = ["0930","1000","1030","1100","1130","1200","1230","1300",
         "1330","1400","1430","1500","1515","1530","1545","1600"]

def load(prod, base="/home/drew/projects/slingshot-services/backtest-engine/greenfield/explore"):
    rows=[]
    with open(f"{base}/R8_{prod}_daily.csv", newline="") as f:
        for r in csv.DictReader(f):
            for k in ("atr14_prior","prior_rth_close","gap","rth_open","rth_close",
                      "rth_high","rth_low","rth_vol","rth_ret",*[f"p{m}" for m in MARKS]):
                v=r.get(k,"")
                r[k]=float(v) if v not in ("",None) else None
            for k in ("year","dow","roll_day","rth_high_min","rth_low_min"):
                r[k]=int(r[k]) if r[k] not in ("",None) else None
            rows.append(r)
    return rows

def mean(xs):
    xs=[x for x in xs if x is not None]
    return sum(xs)/len(xs) if xs else float('nan')

def std(xs):
    xs=[x for x in xs if x is not None]
    if len(xs)<2: return float('nan')
    m=sum(xs)/len(xs)
    return math.sqrt(sum((x-m)**2 for x in xs)/(len(xs)-1))

def tstat(xs):
    xs=[x for x in xs if x is not None]
    n=len(xs)
    if n<2: return float('nan')
    s=std(xs)
    if s==0: return float('nan')
    return mean(xs)/(s/math.sqrt(n))

def by_year(rows, valfn):
    """returns dict year-> list of values (None dropped by callers via mean)."""
    out={}
    for r in rows:
        v=valfn(r)
        if v is None: continue
        out.setdefault(r["year"],[]).append(v)
    return out

def year_table(rows, valfn, years=None):
    """print-ready: per year (n, mean, t). returns list of (year,n,mean,t)."""
    d=by_year(rows,valfn)
    res=[]
    for y in sorted(d):
        xs=d[y]
        res.append((y,len(xs),mean(xs),tstat(xs)))
    return res

def fmt_year_table(rows, valfn, label):
    res=year_table(rows,valfn)
    allx=[valfn(r) for r in rows if valfn(r) is not None]
    lines=[f"  {label}: pooled n={len(allx)} mean={mean(allx):+.2f}pt t={tstat(allx):+.2f}"]
    cells=[]
    for (y,n,m,t) in res:
        cells.append(f"{y}:{m:+.1f}(n{n},t{t:+.1f})")
    lines.append("    "+"  ".join(cells))
    # sign stability
    signs=[1 if m>0 else -1 for (_,_,m,_) in res]
    pos=sum(1 for s in signs if s>0); neg=len(signs)-pos
    lines.append(f"    year-signs: +{pos} / -{neg}  (of {len(signs)})")
    return "\n".join(lines)
