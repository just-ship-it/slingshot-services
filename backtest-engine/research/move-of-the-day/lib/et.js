// ET (America/New_York) time helpers — DST-correct via Intl.
// Used across the move-of-the-day pipeline so session/day bucketing is consistent.

const _fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, weekday: 'short',
});

const _dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Returns {dateET:'YYYY-MM-DD', hour, minute, second, dow(0=Sun), dowName, minutesOfDay} */
export function etParts(ts) {
  const p = {};
  for (const part of _fmt.formatToParts(new Date(ts))) p[part.type] = part.value;
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // Intl quirk: midnight can render as 24
  const minute = parseInt(p.minute, 10);
  return {
    dateET: `${p.year}-${p.month}-${p.day}`,
    hour,
    minute,
    second: parseInt(p.second, 10),
    dow: _dowMap[p.weekday],
    dowName: p.weekday,
    minutesOfDay: hour * 60 + minute,
  };
}

// RTH = 09:30–16:00 ET. Production force-flat EOD cutoff = 15:45 ET (see memory/production-eod-cutoff).
export const RTH_OPEN_MIN = 9 * 60 + 30;   // 570
export const RTH_CLOSE_MIN = 16 * 60;       // 960
export const EOD_CUTOFF_MIN = 15 * 60 + 45; // 945

/** Is this timestamp inside the RTH entry window (open .. EOD cutoff)? */
export function inRTHEntryWindow(ts) {
  const { minutesOfDay, dow } = etParts(ts);
  if (dow === 0 || dow === 6) return false; // weekend guard
  return minutesOfDay >= RTH_OPEN_MIN && minutesOfDay < EOD_CUTOFF_MIN;
}
