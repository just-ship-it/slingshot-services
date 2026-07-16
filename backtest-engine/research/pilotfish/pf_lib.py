"""PILOTFISH shared helpers: minute-feature loading, causal baselines, stats."""
import csv
import statistics
from collections import defaultdict

FEATURES = '/home/drew/projects/slingshot-services/backtest-engine/data/features/pilotfish_minute_features.csv'
PT, SLIP, COMM = 20.0, 2.0, 4.0


FEATURES_2021 = FEATURES.replace('.csv', '_2021-22.csv')


def load_minutes(include_2021=False):
    """Return list of dict rows (typed) in chronological order. With
    include_2021, prepends the 2021-22 extension file."""
    rows = []
    files = ([FEATURES_2021, FEATURES] if include_2021 else [FEATURES])
    for fn in files:
        with open(fn) as f:
            for r in csv.DictReader(f):
                rows.append({
                    'ts': r['ts_min'], 'date': r['et_date'], 'hhmm': r['et_hhmm'],
                    'dow': int(r['dow']), 'sym': r['symbol'],
                    'o': float(r['open']), 'h': float(r['high']),
                    'l': float(r['low']), 'c': float(r['close']),
                    'v': int(r['volume']), 'sv': int(r['svol_co']),
                    'travel': float(r['travel']), 'absn': float(r['absorption']),
                    'mru': int(r['maxrun_up']), 'mrd': int(r['maxrun_dn']),
                })
    return rows


def causal_baseline(rows, field, lookback=60, agg=statistics.median):
    """rows -> {(date, hhmm): baseline} using ONLY prior days' values for that
    minute-of-day (trailing `lookback` days). Rows must be chronological."""
    hist = defaultdict(list)   # hhmm -> [(date, value)] in date order
    out = {}
    for r in rows:
        key = r['hhmm']
        h = hist[key]
        # baseline BEFORE appending today's value (causal)
        if len(h) >= 20:
            out[(r['date'], key)] = agg(v for _, v in h[-lookback:])
        if not h or h[-1][0] != r['date']:
            h.append((r['date'], r[field]))
        else:
            h[-1] = (r['date'], h[-1][1])  # keep first occurrence per day
    return out


def index_by_day(rows):
    days = defaultdict(list)
    for r in rows:
        days[r['date']].append(r)
    return days


def stat_line(label, picks, per_side_pts=None):
    """picks = signed point outcomes. Returns (n, avg, wr, net$/tr)."""
    if len(picks) < 8:
        print(f'{label:58s} n={len(picks):4d}  (too few)')
        return None
    g = statistics.mean(picks)
    wr = 100 * sum(1 for p in picks if p > 0) / len(picks)
    net = g * PT - SLIP * PT - COMM
    print(f'{label:58s} n={len(picks):4d} avg={g:+7.2f}pt WR={wr:4.1f}% '
          f'net/tr=${net:+7.0f} total=${net*len(picks):+11,.0f}')
    return len(picks), g, wr, net


def split_years(events, datefn=lambda e: e[0]):
    disc = [e for e in events if datefn(e) < '2025-01-01']
    hold = [e for e in events if datefn(e) >= '2025-01-01']
    return disc, hold


TF_MS = {'1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
         '1h': 3600000, '4h': 14400000, '1d': 86400000}

LSDIR = '/home/drew/projects/slingshot-services/backtest-engine/research/lt-extraction/output'


class LsSeries:
    """Knowability-shifted LS state series. Dumper rows stamp the bar OPEN
    with the SEALED state — the state is only usable from stamp + TF width
    (the 2026-07-13 ls15 lookahead lesson, generalized to every TF)."""

    def __init__(self, tf):
        import csv as _csv
        import bisect as _bisect
        self._bisect = _bisect
        self.tf = tf
        shift = TF_MS[tf]
        self.ts, self.st = [], []
        with open(f'{LSDIR}/nq_ls_{tf}_raw.csv') as f:
            for r in _csv.DictReader(f):
                self.ts.append(int(r['unix_ms']) + shift)   # knowable-from
                self.st.append(int(r['state']))

    def state_at(self, ms):
        """state KNOWABLE at ms (None before first knowable flip)."""
        i = self._bisect.bisect_right(self.ts, ms) - 1
        return self.st[i] if i >= 0 else None

    def age_min(self, ms):
        """minutes since the current state became knowable."""
        i = self._bisect.bisect_right(self.ts, ms) - 1
        return (ms - self.ts[i]) / 60000 if i >= 0 else None
