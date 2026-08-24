#!/usr/bin/env python3
"""
FREE exact quote for one OOS month of NQ MBO from Databento. Costs nothing to run —
get_cost is a metadata call, not a data purchase. No subscription required for
usage-based historical.

Setup:
    pip install databento
    export DATABENTO_API_KEY=db-xxxxxxxx        # portal -> Settings -> API keys
    python3 quote-oos-cost.py [START] [END]

Defaults to a month that does NOT overlap our in-sample window
(2025-12-29 .. 2026-01-28), so the result is genuine out-of-sample.
"""
import os, sys
try:
    import databento as db
except ImportError:
    sys.exit("pip install databento")
KEY = os.environ.get('DATABENTO_API_KEY')
if not KEY:
    sys.exit("set DATABENTO_API_KEY (never hardcode it here)")
START = sys.argv[1] if len(sys.argv) > 1 else '2026-06-01'
END   = sys.argv[2] if len(sys.argv) > 2 else '2026-07-01'
c = db.Historical(KEY)
print(f"NQ MBO quote {START} -> {END}\n")
for sym, stype in (('NQ.FUT', 'parent'), ('NQU6', 'raw_symbol')):
    for schema in ('mbo', 'mbp-10', 'mbp-1'):
        try:
            cost = c.metadata.get_cost(dataset='GLBX.MDP3', symbols=[sym], stype_in=stype,
                                       schema=schema, start=START, end=END)
            size = c.metadata.get_record_count(dataset='GLBX.MDP3', symbols=[sym], stype_in=stype,
                                               schema=schema, start=START, end=END)
            print(f"  {sym:<8} {schema:<7} ${cost:>9,.2f}   {size:>15,} records")
        except Exception as e:
            print(f"  {sym:<8} {schema:<7} error: {str(e)[:70]}")
print("""
Notes:
 - 'NQ.FUT' (parent) pulls ALL NQ contracts incl. calendar spreads — matches our raw CSVs
   but costs more. A single front-month raw_symbol is cheaper and is all the strategy needs
   (FROZEN-OOS-EVAL.py filters to front month anyway).
 - Pick the correct front month for the window you request (e.g. NQU6 for Jun-Sep 2026).
 - Stream one day at a time, extract, delete: 57.4GB -> 38MB (1,511x). Peak disk ~2GB.
 - Then run:  python3 FROZEN-OOS-EVAL.py <dir-of-csvs> <FRONT_SYMBOL>
""")
