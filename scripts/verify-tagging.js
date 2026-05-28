#!/usr/bin/env node
/**
 * Verify the live tradovate-connector tagging fix is working in production.
 *
 * Pulls recent orders for an account and checks each one's OrderVersion.text
 * and Command.clOrdId. For orders placed by the fixed connector, both fields
 * should contain a `${strategy}-${direction}-${price}-${ts}` signalId. For
 * older orders or manual ones, fields will be null/empty.
 *
 * Usage:
 *   node scripts/verify-tagging.js                  # live account, last 20 orders
 *   node scripts/verify-tagging.js --demo           # demo account
 *   node scripts/verify-tagging.js --limit 5        # only 5 most recent
 *   node scripts/verify-tagging.js --order 12345    # one specific orderId
 *
 * Env: TRADOVATE_USERNAME / PASSWORD / CID / SECRET / APP_ID / APP_VERSION,
 *      TRADOVATE_LIVE_ACCOUNT_ID + TRADOVATE_LIVE_URL (or _DEMO_ for --demo).
 */

import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../shared/.env') });

const argv = process.argv.slice(2);
const isDemo = argv.includes('--demo');
const limitArg = argv.indexOf('--limit');
const orderArg = argv.indexOf('--order');
const LIMIT = limitArg >= 0 ? Number(argv[limitArg + 1]) : 20;
const SINGLE_ORDER = orderArg >= 0 ? Number(argv[orderArg + 1]) : null;

const {
  TRADOVATE_USERNAME, TRADOVATE_PASSWORD,
  TRADOVATE_CID, TRADOVATE_SECRET,
  TRADOVATE_APP_ID, TRADOVATE_APP_VERSION,
} = process.env;

const BASE = (isDemo ? process.env.TRADOVATE_DEMO_URL : process.env.TRADOVATE_LIVE_URL)
  ?.replace(/\/$/, '');
const ACCOUNT_ID = Number(isDemo ? process.env.TRADOVATE_DEMO_ACCOUNT_ID : process.env.TRADOVATE_LIVE_ACCOUNT_ID);

if (!BASE || !ACCOUNT_ID) {
  console.error(`Missing TRADOVATE_${isDemo ? 'DEMO' : 'LIVE'}_URL / _ACCOUNT_ID in shared/.env`);
  process.exit(1);
}
if (!TRADOVATE_USERNAME || !TRADOVATE_PASSWORD) {
  console.error('Missing TRADOVATE_USERNAME / TRADOVATE_PASSWORD in shared/.env');
  process.exit(1);
}

let accessToken = null;

async function auth() {
  const body = {
    name: TRADOVATE_USERNAME, password: TRADOVATE_PASSWORD,
    appId: TRADOVATE_APP_ID, appVersion: TRADOVATE_APP_VERSION || '1.0',
    deviceId: `slingshot-verify-${Date.now()}`,
    cid: Number(TRADOVATE_CID), sec: TRADOVATE_SECRET,
  };
  const r = await axios.post(`${BASE}/auth/accesstokenrequest`, body, { headers: { 'Content-Type': 'application/json' } });
  if (r.data?.['p-ticket']) throw new Error(`Auth CAPTCHA p-ticket; wait ${r.data['p-time']}s`);
  if (!r.data?.accessToken) throw new Error(`Auth failed: ${r.data?.errorText || 'no accessToken'}`);
  accessToken = r.data.accessToken;
  console.log(`✅ Authed on ${isDemo ? 'DEMO' : 'LIVE'} accountId=${ACCOUNT_ID}`);
}

async function req(method, endpoint) {
  const r = await axios({
    method, url: `${BASE}${endpoint}`,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    validateStatus: () => true,
  });
  return { status: r.status, body: r.data };
}

function parseStrategyFromText(text) {
  if (!text || typeof text !== 'string') return { strategy: null, signalId: null };
  const trimmed = text.replace(/\.(sl|tp|flat)$/, '');
  const m = trimmed.match(/^(.+?)-(long|short)-([\d.]+)-(\d+)$/);
  if (m) return { strategy: m[1], signalId: trimmed };
  return { strategy: null, signalId: trimmed };
}

async function checkOrder(orderId) {
  const item = await req('GET', `/order/item?id=${orderId}`);
  const order = item.body || {};
  const ov = await req('GET', `/orderVersion/deps?masterid=${orderId}`);
  const cmd = await req('GET', `/command/deps?masterid=${orderId}`);

  let text = null;
  if (Array.isArray(ov.body)) {
    for (const v of ov.body) if (v?.text) { text = v.text; break; }
  }
  let clOrdId = null;
  if (Array.isArray(cmd.body)) {
    for (const c of cmd.body) if (c?.clOrdId) { clOrdId = c.clOrdId; break; }
  }

  const parsed = parseStrategyFromText(text);
  const role = order.parentId ? 'bracket-child' : (order.linkedId ? 'oso-parent' : 'standalone');

  return {
    orderId,
    timestamp: order.timestamp,
    ordStatus: order.ordStatus,
    action: order.action,
    contractId: order.contractId,
    role,
    text,
    clOrdId,
    decodedStrategy: parsed.strategy,
    decodedSignalId: parsed.signalId,
  };
}

function verdict(row) {
  // Bracket children carry text + .sl/.tp clOrdId; parent + standalone carry full signalId.
  if (!row.text && !row.clOrdId) return '❌ NO TAGS (pre-fix or manual)';
  const hasStrategy = !!row.decodedStrategy;
  if (hasStrategy) return `✅ ATTRIBUTED → ${row.decodedStrategy}`;
  if (row.text || row.clOrdId) return `⚠️  TAGGED but unparseable (manual/test text?)`;
  return '?';
}

(async () => {
  try {
    await auth();

    let rows;
    if (SINGLE_ORDER) {
      rows = [await checkOrder(SINGLE_ORDER)];
    } else {
      // Pull recent orders for this account. /order/list is global so we filter.
      const r = await req('GET', '/order/list');
      if (r.status !== 200 || !Array.isArray(r.body)) {
        console.error(`/order/list failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        process.exit(1);
      }
      const sorted = r.body
        .filter(o => o.accountId === ACCOUNT_ID)
        .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
        .slice(0, LIMIT);

      console.log(`Inspecting ${sorted.length} most recent orders for accountId=${ACCOUNT_ID}\n`);

      rows = [];
      for (const o of sorted) {
        rows.push(await checkOrder(o.id));
      }
    }

    // ── Per-order table ─────────────────────────────────────
    console.log('orderId         | when                 | role          | status     | text                                                  | verdict');
    console.log('----------------+----------------------+---------------+------------+--------------------------------------------------------+--------------------------');
    for (const r of rows) {
      const when = r.timestamp ? r.timestamp.slice(0, 19).replace('T', ' ') : '-';
      const text = (r.text || '-').padEnd(54).slice(0, 54);
      console.log(
        `${String(r.orderId).padEnd(15)} | ${when.padEnd(20)} | ${r.role.padEnd(13)} | ${(r.ordStatus || '-').padEnd(10)} | ${text} | ${verdict(r)}`
      );
    }

    // ── Aggregate summary ───────────────────────────────────
    const tagged = rows.filter(r => r.text || r.clOrdId).length;
    const attributed = rows.filter(r => r.decodedStrategy).length;
    const oldUntagged = rows.filter(r => !r.text && !r.clOrdId).length;
    const byStrategy = {};
    for (const r of rows) {
      if (r.decodedStrategy) byStrategy[r.decodedStrategy] = (byStrategy[r.decodedStrategy] || 0) + 1;
    }
    console.log('\n──── SUMMARY ────');
    console.log(`Total orders inspected:  ${rows.length}`);
    console.log(`Has text/clOrdId:        ${tagged}`);
    console.log(`Strategy decodable:      ${attributed}`);
    console.log(`No tags (pre-fix/manual): ${oldUntagged}`);
    if (Object.keys(byStrategy).length) {
      console.log('\nBy strategy:');
      for (const [s, n] of Object.entries(byStrategy).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${s.padEnd(28)} ${n}`);
      }
    }
    console.log('');

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Verify failed:', err.message);
    if (err.response?.data) console.error('Response:', JSON.stringify(err.response.data, null, 2));
    process.exit(1);
  }
})();
