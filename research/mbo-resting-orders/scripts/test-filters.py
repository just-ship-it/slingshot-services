#!/usr/bin/env python3
"""Apply LOCKED filters to a test month. Usage: test-filters.py <derived-dir> <label>"""
import sys, importlib.util, os
here=os.path.dirname(os.path.abspath(__file__))
def load(n,f):
    s=importlib.util.spec_from_file_location(n,os.path.join(here,f))
    m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
M=load('fd','filter-dev.py'); L=load('lf','LOCKED-FILTERS.py')
src,label=sys.argv[1],sys.argv[2]
rows=M.trades(src)
print(f"=== {label}  ({src}) ===")
print(f"{'filter':<14}{'n':>6}{'WR':>7}{'PF':>6}{'net':>11}{'$/trade':>9}{'maxDD':>9}   vs in-sample PF")
for k,fn in L.FILTERS.items():
    s=M.stat([r for r in rows if fn(r)],k)
    ins=L.INSAMPLE[k]['pf']
    if s is None: print(f"{k:<14}  (too few)"); continue
    delta=s['pf']-ins
    print(f"{k:<14}{s['n']:>6}{s['wr']:>6.1f}%{s['pf']:>6.2f}{s['net']:>+11,.0f}"
          f"{s['per']:>+9.1f}{s['dd']:>9,.0f}   {ins:.2f} -> {s['pf']:.2f} ({delta:+.2f})")
