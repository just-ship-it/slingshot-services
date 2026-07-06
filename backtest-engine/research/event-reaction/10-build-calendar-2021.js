/**
 * Build the EXTENDED event calendar (2021-01 → 2026-07) for the event-reaction
 * backtest. Same method as event-positioning/01-build-event-calendar.js but the
 * realtime window is widened to 2021 and FOMC dates cover 2021-2026.
 *
 * Non-destructive: writes to event-reaction/output/event-calendar-2021.csv,
 * leaving the concluded positioning audit's calendar untouched.
 *
 * Only CPI/NFP/PCE/PPI are traded by the strategy, but we pull all 6 FRED
 * releases (+ FOMC) for reuse/completeness. Requires FRED_API_KEY in shared/.env.
 *
 * Usage: node research/event-reaction/10-build-calendar-2021.js
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

function loadFredKey() {
  if (process.env.FRED_API_KEY) return process.env.FRED_API_KEY.trim();
  const envPath = path.resolve(__dirname, '..', '..', '..', 'shared', '.env');
  const m = fs.readFileSync(envPath, 'utf8').match(/^FRED_API_KEY=(.+)$/m);
  if (!m) throw new Error('FRED_API_KEY not found in shared/.env');
  return m[1].trim();
}
const KEY = loadFredKey();

const REALTIME_START = '2021-01-01';
const REALTIME_END = '2026-07-05';

const FRED_RELEASES = [
  { id: 10, type: 'CPI',    name: 'Consumer Price Index',        time: '08:30' },
  { id: 46, type: 'PPI',    name: 'Producer Price Index',        time: '08:30' },
  { id: 50, type: 'NFP',    name: 'Employment Situation',        time: '08:30' },
  { id: 54, type: 'PCE',    name: 'Personal Income and Outlays', time: '08:30' },
  { id: 53, type: 'GDP',    name: 'Gross Domestic Product',      time: '08:30' },
  { id:  9, type: 'RETAIL', name: 'Advance Retail Sales',        time: '08:30' },
];

// FOMC policy-statement dates (2nd meeting day, 14:00 ET). federalreserve.gov calendar.
// Non-critical for this strategy (FOMC not traded); included for calendar reuse.
const FOMC_DATES = [
  '2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16', '2021-07-28', '2021-09-22', '2021-11-03', '2021-12-15',
  '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
  '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
];

function etToEpochMs(dateStr, hhmm) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, hh, mm);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(guess)).reduce((a, p) => (a[p.type] = p.value, a), {});
  const shownHour = parts.hour === '24' ? 0 : Number(parts.hour);
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, shownHour, +parts.minute, +parts.second);
  return guess - (shown - guess);
}

async function fetchReleaseDates(releaseId) {
  const res = await axios.get('https://api.stlouisfed.org/fred/release/dates', {
    params: {
      release_id: releaseId, api_key: KEY, file_type: 'json',
      realtime_start: REALTIME_START, realtime_end: REALTIME_END,
      sort_order: 'asc', limit: 10000, include_release_dates_with_no_data: 'false',
    },
    timeout: 20000,
  });
  return (res.data.release_dates || []).map(r => r.date);
}

async function main() {
  const events = [];
  for (const rel of FRED_RELEASES) {
    const dates = await fetchReleaseDates(rel.id);
    // de-dup (GDP has multiple vintages per release date window) and bound to range
    const uniq = [...new Set(dates)].filter(d => d >= REALTIME_START && d <= REALTIME_END);
    for (const date of uniq) {
      events.push({ date, event_type: rel.type, release_time_et: rel.time, release_ts_ms: etToEpochMs(date, rel.time), source: `FRED:${rel.id}` });
    }
    console.log(`  FRED ${rel.type.padEnd(7)} (id ${rel.id}): ${uniq.length} dates  [${uniq[0]} → ${uniq[uniq.length - 1]}]`);
    await new Promise(r => setTimeout(r, 300));
  }
  for (const date of FOMC_DATES) {
    events.push({ date, event_type: 'FOMC', release_time_et: '14:00', release_ts_ms: etToEpochMs(date, '14:00'), source: 'hardcoded:federalreserve.gov' });
  }
  console.log(`  FOMC (hardcoded): ${FOMC_DATES.length} dates`);

  events.sort((a, b) => a.release_ts_ms - b.release_ts_ms);
  const HDR = ['date', 'event_type', 'release_time_et', 'release_ts_ms', 'source'];
  const lines = [HDR.join(',')];
  for (const e of events) lines.push([e.date, e.event_type, e.release_time_et, e.release_ts_ms, e.source].join(','));
  const outPath = path.join(OUT_DIR, 'event-calendar-2021.csv');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');

  const byType = {};
  for (const e of events) byType[e.event_type] = (byType[e.event_type] || 0) + 1;
  console.log(`\nTotal ${events.length} events → ${outPath}`);
  console.log('by type:', JSON.stringify(byType));
  const trade = events.filter(e => ['CPI', 'NFP', 'PCE', 'PPI'].includes(e.event_type));
  console.log(`tradeable (CPI/NFP/PCE/PPI): ${trade.length}  [${trade[0].date} → ${trade[trade.length - 1].date}]`);
}
main().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
