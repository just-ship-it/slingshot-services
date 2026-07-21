#!/usr/bin/env python3
"""
R6-00-prep: Convert NQ UTC 1m primary cache -> ET-annotated panel (parquet).
Session date rolls at 18:00 ET (bars >=18:00 ET belong to NEXT session date).
Overnight = 18:00 ET prev-evening .. 09:29 ET session date.
symbol column preserved (truth for rollover; never span symbol changes).

Also builds an ES ET panel from the ES cache (which already has et_date/et_hhmm),
applying the same 18:00 session-roll convention so NQ/ES align by session_date.

Output:
  cache_nq_et_panel.parquet   cols: session_date, year, dow, et_hhmm, symbol, o,h,l,c,v
  cache_es_et_panel.parquet   same cols
"""
import csv, sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import pandas as pd

UTC = ZoneInfo('UTC'); ET = ZoneInfo('America/New_York')

def build_nq(path, out):
    offcache = {}
    rows = []
    with open(path) as f:
        r = csv.reader(f); next(r)
        for row in r:
            s = row[0]                      # 2020-12-27T23:00  (UTC, naive)
            hourkey = s[:13]
            off = offcache.get(hourkey)
            if off is None:
                dt = datetime.fromisoformat(s).replace(tzinfo=UTC)
                off = dt.astimezone(ET).utcoffset()
                offcache[hourkey] = off
            utc_dt = datetime.fromisoformat(s)   # naive == utc clock
            et_dt = utc_dt + off
            hh = et_dt.hour; mm = et_dt.minute
            et_hhmm = hh*100 + mm
            # session date: bars >=18:00 ET belong to next session
            sd = et_dt.date()
            if hh >= 18:
                sd = sd + timedelta(days=1)
            rows.append((sd.isoformat(), sd.year, sd.weekday(), et_hhmm,
                         row[6], float(row[1]), float(row[2]), float(row[3]),
                         float(row[4]), float(row[5])))
    df = pd.DataFrame(rows, columns=['session_date','year','dow','et_hhmm','symbol','o','h','l','c','v'])
    # dow here is weekday of session_date; but for a Globex session that opened
    # the prior evening the more useful "session weekday" is session_date's dow.
    df.to_csv(out, index=False)
    print(f'NQ panel: {len(df):,} rows -> {out}')
    return df

def build_es(path, out):
    rows = []
    with open(path) as f:
        r = csv.reader(f); next(r)
        for row in r:
            # ts_utc,et_date,et_hhmm,dow,o,h,l,c,v,symbol,roll
            et_date = row[1]; et_hhmm = int(row[2])
            hh = et_hhmm // 100
            d = datetime.fromisoformat(et_date).date()
            sd = d + timedelta(days=1) if hh >= 18 else d
            rows.append((sd.isoformat(), sd.year, sd.weekday(), et_hhmm,
                         row[9], float(row[4]), float(row[5]), float(row[6]),
                         float(row[7]), float(row[8])))
    df = pd.DataFrame(rows, columns=['session_date','year','dow','et_hhmm','symbol','o','h','l','c','v'])
    df.to_csv(out, index=False)
    print(f'ES panel: {len(df):,} rows -> {out}')
    return df

if __name__ == '__main__':
    build_nq('cache_nq_primary_1m.csv', 'cache_nq_et_panel.csv.gz')
    build_es('cache/ES_1m_primary.csv', 'cache_es_et_panel.csv.gz')
