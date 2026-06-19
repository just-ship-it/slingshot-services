#!/usr/bin/env node
// Build a unified major-economic-event calendar for event-positioning research.
//
// Sources:
//   - FRED release-dates API (/fred/release/dates) for scheduled DATA releases:
//       CPI, PPI, Employment Situation (NFP), Personal Income & Outlays (PCE),
//       GDP, Advance Retail Sales. These are ACTUAL publication dates, so the
//       2025 gov't-shutdown reschedules are handled automatically.
//   - Hardcoded FOMC policy-statement dates (the Fed publishes a rate decision,
//       NOT a FRED data release, so FRED can't supply these).
//
// Release times (ET): all data releases land 08:30 ET; FOMC statement 14:00 ET.
//
// Output: output/event-calendar.csv  with columns
//   date,event_type,release_time_et,release_ts_ms,source
// release_ts_ms is the epoch-ms of the release INSTANT (ET wall time → UTC),
// which the audit script compares against trade entry/exit timestamps.
//
// Run:  node 01-build-event-calendar.js
// Requires FRED_API_KEY in shared/.env (loaded below).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Load FRED_API_KEY from shared/.env (no dotenv dependency) ───────────────
function loadFredKey() {
  if (process.env.FRED_API_KEY) return process.env.FRED_API_KEY.trim();
  const envPath = path.resolve(__dirname, '..', '..', '..', 'shared', '.env');
  const txt = fs.readFileSync(envPath, 'utf8');
  const m = txt.match(/^FRED_API_KEY=(.+)$/m);
  if (!m) throw new Error('FRED_API_KEY not found in shared/.env');
  return m[1].trim();
}
const KEY = loadFredKey();

// ── Config ──────────────────────────────────────────────────────────────────
// Pull release dates from this point forward (covers the FCFS gold-standard span
// Jan 2025 → mid-2026 with margin).
const REALTIME_START = '2024-12-01';

// FRED release IDs (verified via /fred/releases). All release at 08:30 ET.
const FRED_RELEASES = [
  { id: 10, type: 'CPI',    name: 'Consumer Price Index',          time: '08:30' },
  { id: 46, type: 'PPI',    name: 'Producer Price Index',          time: '08:30' },
  { id: 50, type: 'NFP',    name: 'Employment Situation',          time: '08:30' },
  { id: 54, type: 'PCE',    name: 'Personal Income and Outlays',   time: '08:30' },
  { id: 53, type: 'GDP',    name: 'Gross Domestic Product',        time: '08:30' },
  { id:  9, type: 'RETAIL', name: 'Advance Retail Sales',          time: '08:30' },
];

// FOMC policy-statement dates (2nd day of meeting, 14:00 ET statement).
// Source: federalreserve.gov FOMC calendar. Mirrors research/first-hour/T9-dow-events.js.
const FOMC_DATES = [
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
  '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
];

// ── ET wall-time → epoch ms (DST-correct via Intl) ──────────────────────────
function etToEpochMs(dateStr, hhmm) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [hh, mm]  = hhmm.split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, hh, mm);
  // What does this UTC instant read as in ET? The delta is the ET offset.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(guess)).reduce((a, p) => (a[p.type] = p.value, a), {});
  const shownHour = parts.hour === '24' ? 0 : Number(parts.hour);
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, shownHour, +parts.minute, +parts.second);
  const offset = shown - guess;          // ET offset (negative in EST/EDT)
  return guess - offset;                 // back out the offset to get true UTC of the ET wall time
}

// ── Fetch one FRED release's publication dates ──────────────────────────────
async function fetchReleaseDates(releaseId) {
  const res = await axios.get('https://api.stlouisfed.org/fred/release/dates', {
    params: {
      release_id: releaseId,
      api_key: KEY,
      file_type: 'json',
      realtime_start: REALTIME_START,
      sort_order: 'asc',
      limit: 1000,
      include_release_dates_with_no_data: 'false',
    },
    timeout: 20000,
  });
  return (res.data.release_dates || []).map(r => r.date);
}

async function main() {
  const events = [];

  for (const rel of FRED_RELEASES) {
    const dates = await fetchReleaseDates(rel.id);
    for (const date of dates) {
      events.push({
        date,
        event_type: rel.type,
        release_time_et: rel.time,
        release_ts_ms: etToEpochMs(date, rel.time),
        source: `FRED:${rel.id}`,
      });
    }
    console.log(`  FRED ${rel.type.padEnd(7)} (id ${rel.id}): ${dates.length} dates  [${dates[0]} → ${dates[dates.length - 1]}]`);
    await new Promise(r => setTimeout(r, 300)); // gentle on rate limit
  }

  for (const date of FOMC_DATES) {
    events.push({
      date,
      event_type: 'FOMC',
      release_time_et: '14:00',
      release_ts_ms: etToEpochMs(date, '14:00'),
      source: 'hardcoded:federalreserve.gov',
    });
  }
  console.log(`  FOMC (hardcoded): ${FOMC_DATES.length} dates`);

  events.sort((a, b) => a.release_ts_ms - b.release_ts_ms);

  // ── Write CSV ─────────────────────────────────────────────────────────────
  const HDR = ['date', 'event_type', 'release_time_et', 'release_ts_ms', 'source'];
  const lines = [HDR.join(',')];
  for (const e of events) {
    lines.push([e.date, e.event_type, e.release_time_et, e.release_ts_ms, e.source].join(','));
  }
  const outPath = path.join(OUT_DIR, 'event-calendar.csv');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');

  // Summary by type.
  const byType = {};
  for (const e of events) byType[e.event_type] = (byType[e.event_type] || 0) + 1;
  console.log('\nEvent counts by type:');
  for (const [t, n] of Object.entries(byType).sort()) console.log(`  ${t.padEnd(8)} ${n}`);
  console.log(`\n✓ Wrote ${outPath} (${events.length} events)`);
}

main().catch(e => { console.error(e?.response?.data || e); process.exit(1); });
