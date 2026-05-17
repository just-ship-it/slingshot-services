// Minimal ms-epoch → America/New_York display formatter using Intl.DateTimeFormat.
// All internal math stays in ms; this is for CSV / SUMMARY readability only.

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

export function fmtET(ms) {
  if (ms == null) return '';
  const parts = fmt.formatToParts(new Date(ms)).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

export function fmtETDate(ms) {
  if (ms == null) return '';
  return fmtET(ms).slice(0, 10);
}

export function fmtETMonth(ms) {
  if (ms == null) return '';
  return fmtET(ms).slice(0, 7);
}
