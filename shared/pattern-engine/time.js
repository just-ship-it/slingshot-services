/**
 * ET time utilities for the pattern engine (fast, allocation-light).
 *
 * Futures session convention: a trading session opens 18:00 ET and closes 17:00 ET next day.
 * All intraday bars are anchored to the 18:00 ET session open (TradingView futures convention),
 * so a 15m bar always starts at :00/:15/:30/:45 relative to 18:00 and 4h bars start at
 * 18:00/22:00/02:00/06:00/10:00/14:00 ET. The daily bar = the whole session, labelled by the
 * session's trade date (the ET calendar date of the 17:00 close).
 *
 * DST: on the spring-forward session (23 real hours) periods follow the ET wall clock exactly
 * like every other day. On the fall-back session the wall clock repeats 01:00-02:00, which would
 * make two real 15m bars share one period key; that ONE session is therefore laid out by real
 * elapsed minutes since its 18:00 EDT open (its bars after 02:00 EDT are shifted +60 wall-min).
 */

const MIN = 60_000;
const DAY = 86_400_000;
const NY = 'America/New_York';

const _offsetCache = new Map();
const _fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function _etOffsetExact(ms) {
  const parts = _fmt.formatToParts(new Date(ms));
  const p = {};
  for (const x of parts) if (x.type !== 'literal') p[x.type] = +x.value;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** ET offset in ms (ET wall = UTC + offset; -4h EDT / -5h EST). Cached per UTC day. */
export function etOffsetMs(ms) {
  const dayKey = Math.floor(ms / DAY);
  let ent = _offsetCache.get(dayKey);
  if (!ent) {
    const start = dayKey * DAY;
    const o1 = _etOffsetExact(start), o2 = _etOffsetExact(start + DAY - 1);
    ent = o1 === o2 ? { simple: true, o: o1 } : { simple: false };
    _offsetCache.set(dayKey, ent);
  }
  return ent.simple ? ent.o : _etOffsetExact(ms);
}

/** ET wall clock of `ms` expressed as fake-UTC ms. */
export function toEt(ms) { return ms + etOffsetMs(ms); }

/** Convert an ET wall-clock instant (fake-UTC ms) back to real UTC ms. */
export function etToUtc(etMs) {
  let utc = etMs - etOffsetMs(etMs);
  const off = etOffsetMs(utc);
  if (utc + off !== etMs) utc = etMs - off;
  return utc;
}

/** ET minute-of-day 0..1439 (wall clock). */
export function etMinuteOfDay(ms) {
  const et = toEt(ms);
  return Math.floor(((et % DAY) + DAY) % DAY / MIN);
}

/**
 * Session info for the instant `ms`:
 *  ssUtc     UTC ms of the 18:00 ET session open
 *  fallBack  true if this session contains the November fall-back
 *  mos       minutes since session open (wall-clock minutes; real elapsed on the fall-back session)
 *  endMos    session end in the same units (17:00 close): 1380 normally, 1440 on the fall-back session
 */
export function sessionInfo(ms) {
  const off = etOffsetMs(ms);
  const et = ms + off;
  const etMinOfDay = Math.floor(((et % DAY) + DAY) % DAY / MIN);
  const wallMos = (etMinOfDay - 18 * 60 + 1440) % 1440;
  const ssEt = et - wallMos * MIN - ((et % MIN) + MIN) % MIN;
  const ssUtc = etToUtc(ssEt);
  const offSS = etOffsetMs(ssUtc);
  const fallBack = etOffsetMs(ssUtc + 12 * 60 * MIN) < offSS;   // session opened EDT, ends EST
  let mos = wallMos;
  if (fallBack) mos = Math.floor((ms - ssUtc) / MIN);            // real elapsed on that session
  return { ssUtc, fallBack, mos, endMos: fallBack ? 1440 : 1380 };
}

/** UTC ms of session-minute `m` within the session that opened at ssUtc. */
export function sessionMinuteToUtc(ssUtc, m, fallBack) {
  if (fallBack) return ssUtc + m * MIN;
  return etToUtc(toEt(ssUtc) + m * MIN);
}

export function minuteOfSession(ms) { return sessionInfo(ms).mos; }
export function sessionStartMs(ms) { return sessionInfo(ms).ssUtc; }

/** ET calendar date (YYYY-MM-DD) of the session's 17:00 close = trade date. */
export function tradeDate(ms) {
  const { ssUtc } = sessionInfo(ms);
  const closeEt = toEt(ssUtc) + 23 * 60 * MIN;
  return new Date(closeEt).toISOString().slice(0, 10);
}

/** Day-of-week 0..6 (Sun..Sat) of the trade date */
export function tradeDow(ms) {
  return new Date(tradeDate(ms) + 'T12:00:00Z').getUTCDay();
}

export function sessionLabel(ms) {
  const m = etMinuteOfDay(ms);
  if (m >= 18 * 60 || m < 4 * 60) return 'overnight';
  if (m < 9 * 60 + 30) return 'premarket';
  if (m < 16 * 60) return 'rth';
  return 'afterhours';   // 16:00-17:00 (17:00-18:00 has no data)
}

/** Timeframe label -> minutes. '1d' = one session. */
export function tfMinutes(tf) {
  const m = /^(\d+)(m|h|d)$/.exec(tf);
  if (!m) throw new Error(`bad tf ${tf}`);
  const n = +m[1];
  return m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : n * 1440;
}

/**
 * Period bounds (UTC ms, end exclusive) of the tf bar containing `ms`, anchored to the session open.
 * The last period of a session ends at the session close (17:00 ET); a daily bar is the session.
 */
export function periodBounds(ms, tfMin) {
  const { ssUtc, fallBack, mos, endMos } = sessionInfo(ms);
  const t = Math.min(tfMin, 1440);
  const k = Math.floor(mos / t);
  const startMos = k * t;
  let endM = (k + 1) * t;
  if (endM > endMos) endM = Math.max(endMos, startMos + 1);   // clamp to session close (17:00 ET)
  return { start: sessionMinuteToUtc(ssUtc, startMos, fallBack), end: sessionMinuteToUtc(ssUtc, endM, fallBack) };
}
