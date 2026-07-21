#!/usr/bin/env python3
"""
1s-honest independent verification of T7 Strategy A (ONH/ONL Aligned-Gap Break).

Written WITHOUT reading the JS research sim's execution code (independent
implementation per RESTART-PLAN.md Phase 2.2). Rules verified, from
T7-FINDINGS.md Strategy A spec only:

  - gap_up_strong  = (open0930 - prevRthClose)/prevRthClose > +0.4%  -> LONG,
    stop-market entry resting at ONH+5
  - gap_down_strong = < -0.4%                                        -> SHORT,
    stop-market entry resting at ONL-5
  - skip if the 09:30 open is already at/past the trigger (breakaway gap)
  - entry window 09:30-11:00 ET; stop 75pt; target 20pt (limit, exact fill);
    hard time exit 12:00 ET
  - fills simulated on 1s bars from the trigger instant onward (CLAUDE.md
    1s mandate). Entry = first 1s bar whose high/low crosses the trigger,
    filled at trigger +/- 1.5pt slip (stop-market). Stop exit slips 1.5pt,
    target is a limit (exact), time exit at next 1s open -1.0pt slip.
  - same-1s-bar stop+target: counted as STOP (conservative) and tallied.

Day setup (ONH/ONL, prevRthClose, 09:30 open) is computed from the same 1s
stream for the day's front contract. Front contract per date from
NQ_rollover_log.csv; days whose overnight session spans a roll are skipped
(T-plan hard rule 4).

Usage: python3 verify-T7A-1s.py [--start 2025-01-13] [--end 2026-04-23]
"""
import csv
import sys
import argparse
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
REPO = "/home/drew/projects/slingshot-services/backtest-engine"
OHLCV_1S = f"{REPO}/data/ohlcv/nq/NQ_ohlcv_1s.csv"
ROLL_LOG = f"{REPO}/data/ohlcv/nq/NQ_rollover_log.csv"

GAP_THRESH = 0.004
TRIGGER_OFF = 5.0
STOP_PTS = 75.0
TGT_PTS = 20.0
ENTRY_SLIP = 1.5   # stop-market entry through the level
STOP_SLIP = 1.5    # stop-loss exit
TIME_SLIP = 1.0    # 12:00 market exit
PT_VAL = 20.0      # $/pt NQ


def load_roll_schedule():
    """Return sorted list of (roll_date_iso, new_symbol). Front symbol for a
    date = symbol of the last roll at/before it."""
    rolls = []
    with open(ROLL_LOG) as f:
        rd = csv.DictReader(f)
        cols = rd.fieldnames
        datecol = next(c for c in cols if "date" in c.lower())
        symcol = next(c for c in cols if c.lower() in ("to_symbol", "new_symbol"))
        for row in rd:
            rolls.append((row[datecol][:10], row[symcol].strip()))
    rolls.sort()
    return rolls


def front_symbol(rolls, date_iso):
    sym = None
    for d, s in rolls:
        if d <= date_iso:
            sym = s
        else:
            break
    return sym


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-01-13")
    ap.add_argument("--end", default="2026-04-23")
    args = ap.parse_args()

    rolls = load_roll_schedule()

    # Per-ET-date state for the front contract
    # session accumulators keyed by ET trade-date (the date whose RTH we target)
    on_high = {}       # date -> overnight high (18:00 prev ET .. 09:29:59)
    on_low = {}
    rth_close = {}     # date -> last price <= 16:00 ET that day (prev day's needed)
    open930 = {}       # date -> first 1s open at/after 09:30
    day_sym = {}       # date -> front symbol used

    trades = []        # dicts: date, side, entry, exit, reason, pnl_pts
    ambiguous = 0
    skipped_roll = 0
    skipped_breakaway = 0

    # active trade state while streaming
    pending = None     # {date, side, trigger, armed_until_ts}
    live = None        # {date, side, entry, stop, tgt, hard_ts}

    # stream window: need prev-day RTH close and overnight from the day before
    start_stream = (datetime.fromisoformat(args.start) - timedelta(days=5)).date().isoformat()
    end_stream = (datetime.fromisoformat(args.end) + timedelta(days=1)).date().isoformat()

    prev_rth_date = {}  # date -> previous trading date seen with an rth_close

    last_rth_dates = []  # ordered list of dates that have rth_close

    with open(OHLCV_1S) as f:
        header = f.readline().rstrip("\n").split(",")
        i_ts = header.index("ts_event")
        i_open = header.index("open")
        i_high = header.index("high")
        i_low = header.index("low")
        i_close = header.index("close")
        i_sym = header.index("symbol")

        for line in f:
            # cheap lex prefilter on ISO timestamp
            ts10 = line[:10]
            if ts10 < start_stream:
                continue
            if ts10 > end_stream:
                break
            cols = line.rstrip("\n").split(",")
            sym = cols[i_sym]
            if "-" in sym:      # calendar spread rows
                continue
            ts_iso = cols[i_ts]
            # parse UTC ts (ISO, ns precision) -> ET
            t_utc = datetime.fromisoformat(ts_iso[:19]).replace(tzinfo=timezone.utc)
            t_et = t_utc.astimezone(ET)
            d_et = t_et.date().isoformat()
            hhmm = t_et.hour * 100 + t_et.minute

            # ---- determine which trade-date this row's overnight belongs to
            # overnight session 18:00 -> next day's 09:29
            if hhmm >= 1800:
                tgt_date = (t_et.date() + timedelta(days=1 if t_et.weekday() < 4 else (3 - t_et.weekday() + 4) % 7 or 1)).isoformat()
                # weekday<4: next calendar day; Fri(4)/Sat(5)/Sun(6) evening -> next Monday handled below
                wd = t_et.weekday()
                if wd == 4:      # Friday evening -> Monday
                    tgt_date = (t_et.date() + timedelta(days=3)).isoformat()
                elif wd == 5:    # Saturday (rare)
                    tgt_date = (t_et.date() + timedelta(days=2)).isoformat()
                elif wd == 6:    # Sunday evening -> Monday
                    tgt_date = (t_et.date() + timedelta(days=1)).isoformat()
            elif hhmm < 930:
                tgt_date = d_et
            else:
                tgt_date = None  # RTH+afternoon rows: not overnight

            fsym_today = front_symbol(rolls, d_et)
            if sym != fsym_today:
                continue        # only the front contract everywhere

            o = float(cols[i_open]); h = float(cols[i_high])
            lo = float(cols[i_low]); c = float(cols[i_close])

            # overnight accumulation
            if tgt_date is not None:
                if tgt_date not in on_high:
                    on_high[tgt_date] = h; on_low[tgt_date] = lo
                    day_sym[tgt_date] = sym
                else:
                    if day_sym.get(tgt_date) != sym:
                        day_sym[tgt_date] = "ROLL_MIX"
                    if h > on_high[tgt_date]: on_high[tgt_date] = h
                    if lo < on_low[tgt_date]: on_low[tgt_date] = lo

            # RTH close tracking (last price at/before 16:00)
            if 930 <= hhmm < 1600:
                rth_close[d_et] = c
                if not last_rth_dates or last_rth_dates[-1] != d_et:
                    last_rth_dates.append(d_et)

            # ---- 09:30 setup
            if hhmm >= 930 and d_et not in open930 and args.start <= d_et <= args.end:
                open930[d_et] = o
                # find prev rth date
                prev = None
                for pd in reversed(last_rth_dates):
                    if pd < d_et:
                        prev = pd
                        break
                if prev is None or prev not in rth_close:
                    pass
                elif day_sym.get(d_et) == "ROLL_MIX" or front_symbol(rolls, prev) != fsym_today:
                    skipped_roll += 1
                elif d_et in on_high:
                    gap = (o - rth_close[prev]) / rth_close[prev]
                    if gap > GAP_THRESH:
                        trig = on_high[d_et] + TRIGGER_OFF
                        if o >= trig:
                            skipped_breakaway += 1
                        else:
                            pending = {"date": d_et, "side": "long", "trigger": trig}
                    elif gap < -GAP_THRESH:
                        trig = on_low[d_et] - TRIGGER_OFF
                        if o <= trig:
                            skipped_breakaway += 1
                        else:
                            pending = {"date": d_et, "side": "short", "trigger": trig}

            # ---- pending entry (09:30-11:00)
            if pending and pending["date"] == d_et:
                if hhmm >= 1100:
                    pending = None
                elif hhmm >= 930:
                    if pending["side"] == "long" and h >= pending["trigger"]:
                        e = pending["trigger"] + ENTRY_SLIP
                        live = {"date": d_et, "side": "long", "entry": e,
                                "stop": e - STOP_PTS, "tgt": e + TGT_PTS,
                                "entry_line": True}
                        pending = None
                    elif pending["side"] == "short" and lo <= pending["trigger"]:
                        e = pending["trigger"] - ENTRY_SLIP
                        live = {"date": d_et, "side": "short", "entry": e,
                                "stop": e + STOP_PTS, "tgt": e - TGT_PTS,
                                "entry_line": True}
                        pending = None

            # ---- live trade management (walk every subsequent 1s bar)
            # The fill bar itself is NOT evaluated for exits: its high/low
            # include pre-fill ticks (the same-bar lookahead class).
            if live and live["date"] == d_et and live.pop("entry_line", False):
                pass
            elif live and d_et > live["date"]:
                # safety: data gap past the hard exit — close at next bar open
                px = o - TIME_SLIP if live["side"] == "long" else o + TIME_SLIP
                pts = (px - live["entry"]) if live["side"] == "long" else (live["entry"] - px)
                trades.append({"date": live["date"], "side": live["side"],
                               "entry": live["entry"], "exit": px,
                               "reason": "gap", "pts": pts})
                live = None
            elif live and live["date"] == d_et:
                done = None
                if hhmm >= 1200:
                    px = o - TIME_SLIP if live["side"] == "long" else o + TIME_SLIP
                    done = ("time", px)
                elif live["side"] == "long":
                    hit_stop = lo <= live["stop"]
                    hit_tgt = h >= live["tgt"]
                    if hit_stop and hit_tgt:
                        ambiguous += 1
                        done = ("stop*", live["stop"] - STOP_SLIP)
                    elif hit_stop:
                        done = ("stop", live["stop"] - STOP_SLIP)
                    elif hit_tgt:
                        done = ("target", live["tgt"])
                else:
                    hit_stop = h >= live["stop"]
                    hit_tgt = lo <= live["tgt"]
                    if hit_stop and hit_tgt:
                        ambiguous += 1
                        done = ("stop*", live["stop"] + STOP_SLIP)
                    elif hit_stop:
                        done = ("stop", live["stop"] + STOP_SLIP)
                    elif hit_tgt:
                        done = ("target", live["tgt"])
                if done:
                    reason, px = done
                    pts = (px - live["entry"]) if live["side"] == "long" else (live["entry"] - px)
                    trades.append({"date": d_et, "side": live["side"],
                                   "entry": live["entry"], "exit": px,
                                   "reason": reason, "pts": pts})
                    live = None

    # ---- report
    n = len(trades)
    wins = [t for t in trades if t["pts"] > 0]
    gp = sum(t["pts"] for t in wins)
    gl = -sum(t["pts"] for t in trades if t["pts"] <= 0)
    pf = (gp / gl) if gl > 0 else float("inf")
    tot = sum(t["pts"] for t in trades)
    print(f"T7-A 1s-honest verification {args.start} -> {args.end}")
    print(f"trades={n} WR={100*len(wins)/n if n else 0:.1f}% PF={pf:.2f} "
          f"totalPts={tot:+.1f} (${tot*PT_VAL:+,.0f}/NQ) "
          f"ambiguous1sBars={ambiguous} skippedRoll={skipped_roll} "
          f"skippedBreakaway={skipped_breakaway}")
    by = {}
    for t in trades:
        k = t["reason"]
        by[k] = by.get(k, [0, 0.0])
        by[k][0] += 1
        by[k][1] += t["pts"]
    for k, (cnt, pts) in sorted(by.items()):
        print(f"  {k:8s} n={cnt:3d} pts={pts:+9.1f}")
    for t in trades:
        print(f"  {t['date']} {t['side']:5s} in={t['entry']:.2f} out={t['exit']:.2f} "
              f"{t['reason']:6s} {t['pts']:+7.2f}")


if __name__ == "__main__":
    main()
