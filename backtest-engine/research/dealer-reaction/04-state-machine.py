#!/usr/bin/env python3
"""Dealer-reaction STATE MACHINE (Drew's spec, 2026-07-23).

FSM per GEX level:
  IDLE -> PENETRATED (price trades >= PEN_MIN past level) -> track swing extreme since penetration
       -> TRIGGER when LS-15m flips AGAINST the penetration within WATCH_WIN
       -> ENTER fade; STOP = swing-extreme-since-penetration + BUFFER (structural, behind the high before flip)
          TARGET = the penetrated level L (fade back to level); R:R gate = reward/risk >= RR_MIN
       -> resolve on 1s: target-before-stop, realized R, MFE/MAE.

LS causality: flips stamped at 15m bar close; acted on at +LS_LAG (anti-repaint). 2026-01..05-11 = backfilled
(memory) -> excluded via --drop-backfill for a causal-clean check.

Ingredient isolation (compare all, same machinery):
  full      = penetration + LS-flip trigger + structural stop + R:R gate  (the strategy)
  noLS      = enter at first STALL bar after penetration (no LS)          (does LS add?)
  placebo_* = round/random levels through full stack                      (is the level special?)
Metrics: win% (target before stop), avg R, expectancy(R & pts), PF, per-quarter, 2026-OOS.
Usage: python3 04-state-machine.py <mode>  mode: full|noLS|placebo_round|placebo_rand
"""
import bisect
import csv
import glob
import json
import os
import random
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path('/home/drew/projects/slingshot-services/backtest-engine')
ET = ZoneInfo('America/New_York')
PRIM1M = BASE / 'research/causal-gex-screen/nq_1m_primary_ohlc.csv'
S1S = BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.csv'
S1IDX = BASE / 'data/ohlcv/nq/NQ_ohlcv_1s.index.json'
LTF = BASE / 'data/liquidity/nq/NQ_liquidity_levels.csv'
LS1M = BASE / 'research/lt-extraction/output/nq_ls_1m_raw.csv'   # 1m LS flips (state 0/1)
SHORT_STATE = int(os.environ.get('SHORT_STATE', '0'))   # which LS state = bearish/short (test 0 and 1)
WIN_START, WIN_END = '2025-01-13', '2026-06-16'
PEN_MIN = 20.0          # min penetration past level to arm
WATCH_WIN_MS = 60 * 60000   # 60-min window to wait for the trigger
BUFFER = 4.0            # stop buffer beyond the swing extreme
RESET_BUF = 8.0        # decisive cross-back margin to abandon a penetration (let it stall past the level)
RR_TARGET = 1.5        # target = RR_TARGET * risk in the fade direction (continuation after the flip)
RISK_CAP = 40.0        # skip if structural stop (behind swing extreme) is further than this
LS_LAG_MS = int(os.environ.get('LS_LAG_MS','60000'))   # anti-repaint lag; env-overridable for the lookahead test
T0_OFF_MS = int(os.environ.get('T0_OFFSET_MS','0'))    # 60000 = walk 1s from trigger-bar CLOSE (honest); 0 = legacy bar-open walk
MAXHOLD_S = 60 * 60
EOD_ET = 15 * 60 + 45
STOP_SLIP = 1.5
STALL_RATIO = 0.7      # noLS: a "stall" bar = 1m range <= STALL_RATIO * atr
RNG = random.Random(20260723)


def to_ms(iso):
    return int(datetime.strptime(iso, '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc).timestamp() * 1000)


def et_min(ms):
    dt = datetime.fromtimestamp(ms / 1000, ET)
    return dt.hour * 60 + dt.minute, dt.strftime('%Y-%m-%d')


def load_1m():
    bars = []
    with open(PRIM1M) as f:
        r = csv.reader(f); next(r)
        for row in r:
            if row[0][:10] < WIN_START or row[0][:10] > WIN_END:
                continue
            bars.append((to_ms(row[0]), float(row[1]), float(row[2]), float(row[3]), float(row[4]), row[5]))
    bars.sort()
    return bars


def load_gex_levels():
    days = {}
    for fp in sorted(glob.glob(str(BASE / 'data/gex/nq-cbbo-causal/nq_gex_*.json'))):
        d = json.load(open(fp)); date = os.path.basename(fp).split('_')[-1][:10]
        snaps = []
        for s in d['data']:
            ms = int(datetime.fromisoformat(s['timestamp']).timestamp() * 1000)
            lv = {}
            for k in ('call_wall', 'put_wall', 'gamma_flip'):
                if s.get(k):
                    lv[k] = float(s[k])
            if s.get('resistance'):
                lv['R1'] = float(s['resistance'][0])
            if s.get('support'):
                lv['S1'] = float(s['support'][0])
            snaps.append((ms, lv))
        snaps.sort(); days[date] = snaps
    return days


def make_placebo(bars, kind):
    byday = defaultdict(list)
    for ms, o, h, l, c, sym in bars:
        em, date = et_min(ms)
        if 570 <= em < 945:
            byday[date].append((h, l))
    days = {}
    for date, hl in byday.items():
        dhi = max(x[0] for x in hl); dlo = min(x[1] for x in hl); lv = {}
        if kind == 'round':
            for j, x in enumerate(range(int(dlo // 100 + 1) * 100, int(dhi), 100)):
                lv[f'R{j}'] = float(x)
        else:
            for j in range(5):
                lv[f'N{j}'] = RNG.uniform(dlo, dhi)
        days[date] = [(0, lv)]
    return days


def snap_at(snaps, ms):
    lo, hi, best = 0, len(snaps) - 1, None
    while lo <= hi:
        m = (lo + hi) // 2
        if snaps[m][0] <= ms:
            best = snaps[m][1]; lo = m + 1
        else:
            hi = m - 1
    return best


def load_ls_flips(drop_backfill):
    flips = []
    with open(LTF) as f:
        prev = None
        for row in csv.DictReader(f):
            dt = row['datetime']
            if dt[:10] < WIN_START or dt[:10] > WIN_END:
                continue
            if drop_backfill and '2026-01-01' <= dt[:10] <= '2026-05-11':
                prev = row['sentiment']; continue
            s = row['sentiment']
            if prev is not None and s != prev:
                ms = int(row['unix_timestamp'])
                flips.append((ms, s))   # (flip_ts, new_state)
            prev = s
    flips.sort()
    return flips


def load_ls1m_flips():
    """1m LS flips -> [(ts_ms, 'BULLISH'|'BEARISH')]. Raw stamp = flip bar OPEN; +60s = knowable (bar close).
    state==SHORT_STATE -> BEARISH. Anti-repaint lag applied at trigger time (LS_LAG_MS)."""
    flips = []
    with open(LS1M) as f:
        for row in csv.DictReader(f):
            try:
                ms = int(row['unix_ms']); s = int(row['state'])
            except (ValueError, KeyError):
                continue
            iso = row.get('timestamp_iso', '')
            if iso[:10] < WIN_START or iso[:10] > WIN_END:
                continue
            flips.append((ms, 'BEARISH' if s == SHORT_STATE else 'BULLISH'))
    flips.sort()
    return flips


def ls_flip_between(flips, t0, t1, want):
    """first flip to `want` in (t0, t1]; returns flip_ts or None."""
    i = bisect.bisect_right([f[0] for f in flips], t0)
    while i < len(flips) and flips[i][0] <= t1:
        if flips[i][1] == want:
            return flips[i][0]
        i += 1
    return None


class S1Reader:
    def __init__(self):
        idx = json.load(open(S1IDX)); self.minutes = idx['minutes']
        self.keys = sorted(int(k) for k in self.minutes); self.f = open(S1S, 'rb')

    def walk(self, t0, sym):
        end = t0 + MAXHOLD_S * 1000
        j = bisect.bisect_left(self.keys, (t0 // 60000) * 60000)
        while j < len(self.keys) and self.keys[j] <= end:
            m = self.minutes[str(self.keys[j])]; self.f.seek(m['offset'])
            for line in self.f.read(m['length']).decode('utf-8', 'replace').split('\n'):
                p = line.split(',')
                if len(p) < 10 or p[9].strip() != sym:
                    continue
                try:
                    tms = int(datetime.strptime(p[0][:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).timestamp() * 1000)
                    if t0 <= tms <= end:
                        yield tms, float(p[5]), float(p[6]), float(p[7])
                except ValueError:
                    continue
            j += 1


def resolve(reader, t0, entry, d, stop, target, sym):
    """d=+1 long/-1 short. stop/target are PRICES. target-before-stop first-passage on 1s."""
    risk = abs(entry - stop)
    if risk < 1:
        return None
    mfe = mae = 0.0; outcome = None; exitpx = None; cl = entry
    for tms, hi, lo, cl in reader.walk(t0, sym):
        em, _ = et_min(tms)
        fav = (hi - entry) if d > 0 else (entry - lo)
        adv = (entry - lo) if d > 0 else (hi - entry)
        mfe = max(mfe, fav); mae = max(mae, adv)
        hit_stop = (lo <= stop) if d > 0 else (hi >= stop)
        hit_tgt = (hi >= target) if d > 0 else (lo <= target)
        if hit_stop:           # stop-before-target same bar (conservative)
            outcome = 'stop'; exitpx = stop - d * STOP_SLIP; break
        if hit_tgt:
            outcome = 'target'; exitpx = target; break
        if em >= EOD_ET:
            outcome = 'eod'; exitpx = cl; break
    if outcome is None:
        outcome = 'timeout'; exitpx = cl
    pnl = (exitpx - entry) * d
    return dict(outcome=outcome, pnl=round(pnl, 2), R=round(pnl / risk, 3), risk=round(risk, 2),
                mfe=round(mfe, 2), mae=round(mae, 2))


def atr14(bars):
    out = [None] * len(bars); win = []
    for i, b in enumerate(bars):
        win.append(b[2] - b[3])
        if len(win) > 14:
            win.pop(0)
        out[i] = sum(win) / len(win)
    return out


def run(mode):
    bars = load_1m(); atr = atr14(bars)
    print(f'{len(bars)} bars', flush=True)
    if mode in ('full', 'noLS'):
        levels = load_gex_levels()
    else:
        levels = make_placebo(bars, 'round' if mode == 'placebo_round' else 'rand')
    flips = load_ls1m_flips() if mode != 'noLS' else []
    reader = S1Reader()

    trades = []
    state = {}   # gk -> dict(pen_dir, pen_ts, extreme, level)
    for i, (ms, o, h, l, c, sym) in enumerate(bars):
        em, date = et_min(ms)
        if not (570 <= em < EOD_ET):
            continue
        snaps = levels.get(date)
        if not snaps:
            continue
        lv = snap_at(snaps, ms)
        if not lv:
            continue
        for kind, L in lv.items():   # per-kind persistent state; duplicate trades deduped after
            gk = f'{date}:{kind}'
            st = state.get(gk)
            cur_side = 'above' if c >= L else 'below'
            if st is None:
                state[gk] = dict(phase='watch', side=cur_side); continue
            if st['phase'] == 'watch':
                if cur_side != st['side']:   # crossed the level
                    st.update(phase='crossed', origin=st['side'], cross_ts=ms,
                              dir=(+1 if cur_side == 'above' else -1),
                              extreme=(h if cur_side == 'above' else l))
                st['side'] = cur_side
                continue
            # crossed/penetrated: extend the swing extreme
            st['extreme'] = max(st['extreme'], h) if st['dir'] > 0 else min(st['extreme'], l)
            if ms - st['cross_ts'] > WATCH_WIN_MS:   # expire; stale/faded penetrations rejected by R:R gate
                state[gk] = dict(phase='watch', side=cur_side); continue
            past = (st['extreme'] - L) if st['dir'] > 0 else (L - st['extreme'])
            if st['phase'] == 'crossed':
                if past >= PEN_MIN:
                    st['phase'] = 'penetrated'; st['pen_ts'] = ms
                else:
                    continue
            # PENETRATED: wait for the trigger (LS flip against, or stall for noLS)
            trig = False
            if mode == 'noLS':
                trig = (h - l) <= STALL_RATIO * (atr[i] or 1e9)
            else:
                want = 'BEARISH' if st['dir'] > 0 else 'BULLISH'
                f = ls_flip_between(flips, st['cross_ts'], ms, want)
                trig = f is not None and ms >= f + LS_LAG_MS
            if not trig:
                continue
            fd = -st['dir']; entry = c        # fade the penetration (up-pen -> short)
            stop = (st['extreme'] + BUFFER) if fd < 0 else (st['extreme'] - BUFFER)  # behind the swing extreme
            risk = abs(entry - stop)
            state[gk] = dict(phase='watch', side=cur_side)
            if risk < 3 or risk > RISK_CAP:   # degenerate or too-wide structural stop
                continue
            target = entry + fd * RR_TARGET * risk   # continuation target in the fade direction
            dist_to_level = (entry - L) if fd < 0 else (L - entry)   # >0 = still beyond level (reverting) / <0 = already back
            res = resolve(reader, ms + T0_OFF_MS, entry, fd, stop, target, sym)
            if not res:
                continue
            q = f'{date[:4]}Q{(int(date[5:7])-1)//3+1}'
            trades.append(dict(date=date, quarter=q, kind=kind, dir=fd, entry=round(entry, 2),
                               dist_lvl=round(dist_to_level, 1),
                               level=round(L, 2), stop=round(stop, 2), target=round(target, 2), **res))
    # dedupe near-identical trades (same physical level fired under call_wall & R1, etc.)
    seen = set(); deduped = []
    for t in sorted(trades, key=lambda x: (x['date'], x['entry'])):
        key = (t['date'], round(t['entry']), round(t['level'] / 8), t['dir'])
        if key in seen:
            continue
        seen.add(key); deduped.append(t)
    print(f'  {len(trades)} raw -> {len(deduped)} after dedup')
    trades = deduped
    out = BASE / f'research/dealer-reaction/fsm_{mode}.csv'
    if trades:
        with open(out, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(trades[0].keys())); w.writeheader(); w.writerows(trades)
    print(f'{mode}: {len(trades)} trades -> {out}')


if __name__ == '__main__':
    run(sys.argv[1] if len(sys.argv) > 1 else 'full')
