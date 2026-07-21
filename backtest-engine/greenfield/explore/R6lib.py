#!/usr/bin/env python3
"""Shared helpers for R6 overnight census.

session_minute: minutes since 18:00 ET, monotonic within a Globex session.
  18:00 ET -> 0 ; 23:00 -> 300 ; 00:00 -> 360 ; 09:29 -> 929 ; 09:30 -> 930 ;
  16:00 -> 1320 ; 17:59 -> 1439.
Overnight window = session_minute in [0, 929]  (18:00 .. 09:29 ET).
"""
import numpy as np, pandas as pd

def hhmm_to_sm(hhmm):
    hh = hhmm // 100; mm = hhmm % 100
    return ((hh - 18) if hh >= 18 else (hh + 6)) * 60 + mm

def clock_to_sm(hh, mm):
    return ((hh - 18) if hh >= 18 else (hh + 6)) * 60 + mm

def load_panel(path):
    df = pd.read_csv(path)
    df['sm'] = df['et_hhmm'].map(hhmm_to_sm).astype(int)
    df = df.sort_values(['session_date','sm']).reset_index(drop=True)
    sessions = {}
    for sd, g in df.groupby('session_date', sort=True):
        sessions[sd] = {
            'sm':   g['sm'].to_numpy(),
            'o':    g['o'].to_numpy(),
            'h':    g['h'].to_numpy(),
            'l':    g['l'].to_numpy(),
            'c':    g['c'].to_numpy(),
            'v':    g['v'].to_numpy(),
            'sym':  g['symbol'].to_numpy(),
            'year': int(g['year'].iloc[0]),
            'dow':  int(g['dow'].iloc[0]),
        }
    return sessions

def at_or_before(sess, target_sm):
    """Return index of last bar with sm <= target_sm, else None."""
    smv = sess['sm']
    i = np.searchsorted(smv, target_sm, side='right') - 1
    return int(i) if i >= 0 else None

def window_return(sess, start_sm, end_sm, max_gap=5):
    """Points return close(end)-close(start), same symbol at both endpoints.
    Endpoints resolved at-or-before with a staleness cap (max_gap minutes).
    Returns (ret_pts, entry_close, exit_close, symbol) or None."""
    i0 = at_or_before(sess, start_sm)
    i1 = at_or_before(sess, end_sm)
    if i0 is None or i1 is None or i1 <= i0:
        return None
    smv = sess['sm']
    if start_sm - smv[i0] > max_gap or end_sm - smv[i1] > max_gap:
        return None
    if sess['sym'][i0] != sess['sym'][i1]:
        return None
    return (sess['c'][i1] - sess['c'][i0], sess['c'][i0], sess['c'][i1], str(sess['sym'][i0]))
