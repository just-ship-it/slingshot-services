#!/usr/bin/env node
/**
 * Standalone test: prove that Tradovate's custom-id fields (text / customTag50 /
 * clOrdId) round-trip through /order/placeOSO so we can attribute strategies
 * server-side and stop relying on the connector's in-memory orderStrategyMap.
 *
 * What it does:
 *   1. Auths against DEMO Tradovate using shared/.env credentials.
 *   2. Looks up MNQM6 contract.
 *   3. Places an OSO with a BUY Limit @ 1000 (guaranteed unfilled — far below
 *      any plausible market). Brackets are nominal; nothing will execute.
 *   4. Stamps all three tag fields with a unique signalId-shaped value on the
 *      parent, and bracket1/bracket2 each get `text` + `clOrdId`.
 *   5. Reads back via:
 *        GET /order/item        (Order entity — for reference)
 *        GET /orderVersion/deps (text round-trip for parent + children)
 *        GET /command/deps      (clOrdId + customTag50 round-trip)
 *   6. Prints a clean table: sent vs received per field per order.
 *   7. Cancels the parent (cascade-cancels the bracket children).
 *
 * Run:
 *   node scripts/test-tradovate-tagging.js
 *
 * Requires in shared/.env:
 *   TRADOVATE_USERNAME, TRADOVATE_PASSWORD, TRADOVATE_CID, TRADOVATE_SECRET,
 *   TRADOVATE_APP_ID, TRADOVATE_APP_VERSION, TRADOVATE_DEMO_ACCOUNT_ID,
 *   TRADOVATE_DEMO_URL  (e.g. https://demo.tradovateapi.com/v1)
 */

import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../shared/.env') });

const {
  TRADOVATE_USERNAME, TRADOVATE_PASSWORD,
  TRADOVATE_CID, TRADOVATE_SECRET,
  TRADOVATE_APP_ID, TRADOVATE_APP_VERSION,
  TRADOVATE_DEMO_ACCOUNT_ID,
  TRADOVATE_DEMO_URL = 'https://demo.tradovateapi.com/v1',
} = process.env;

if (!TRADOVATE_USERNAME || !TRADOVATE_PASSWORD || !TRADOVATE_DEMO_ACCOUNT_ID) {
  console.error('Missing TRADOVATE_USERNAME / TRADOVATE_PASSWORD / TRADOVATE_DEMO_ACCOUNT_ID in shared/.env');
  process.exit(1);
}

const BASE = TRADOVATE_DEMO_URL.replace(/\/$/, '');
const SYMBOL = process.env.TEST_SYMBOL || 'MNQM6';
const SAFE_LIMIT_PRICE = Number(process.env.TEST_LIMIT_PRICE || 1000);
const SAFE_STOP_PRICE   = Number(process.env.TEST_STOP_PRICE  || 900);
const SAFE_TARGET_PRICE = Number(process.env.TEST_TARGET_PRICE || 1100);

const SIGNAL_ID = `TEST-TAG-${Date.now()}`;        // doubles as parent clOrdId / text
const SL_CLORDID = `${SIGNAL_ID}.sl`;
const TP_CLORDID = `${SIGNAL_ID}.tp`;
// customTag50 is FIX tag 50 (sender sub-id) — CME requires it to be pre-registered.
// Sending an arbitrary string returns "Unregisted Tag50". Opt-in only.
const USE_CUSTOM_TAG50 = process.env.TEST_USE_CUSTOM_TAG50 === '1';
const STRATEGY = 'TEST_STRATEGY';

let accessToken = null;

async function auth() {
  const body = {
    name: TRADOVATE_USERNAME,
    password: TRADOVATE_PASSWORD,
    appId: TRADOVATE_APP_ID,
    appVersion: TRADOVATE_APP_VERSION || '1.0',
    deviceId: `slingshot-tagtest-${Date.now()}`,
    cid: Number(TRADOVATE_CID),
    sec: TRADOVATE_SECRET,
  };
  const r = await axios.post(`${BASE}/auth/accesstokenrequest`, body, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.data?.['p-ticket']) {
    throw new Error(`Auth returned CAPTCHA p-ticket; re-run after wait of ${r.data['p-time']}s`);
  }
  if (!r.data?.accessToken) throw new Error(`Auth failed: ${r.data?.errorText || 'no accessToken'}`);
  accessToken = r.data.accessToken;
  console.log(`✅ Authed as ${TRADOVATE_USERNAME} on DEMO (userId=${r.data.userId})`);
}

async function req(method, endpoint, data) {
  const r = await axios({
    method, url: `${BASE}${endpoint}`,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    data, validateStatus: () => true,
  });
  return { status: r.status, body: r.data };
}

async function findContract(name) {
  const r = await req('GET', `/contract/find?name=${encodeURIComponent(name)}`);
  if (r.status !== 200 || !r.body?.id) throw new Error(`/contract/find ${name} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

async function placeOSO(contractId) {
  const payload = {
    accountSpec: TRADOVATE_USERNAME,
    accountId: Number(TRADOVATE_DEMO_ACCOUNT_ID),
    action: 'Buy',
    symbol: SYMBOL,
    contractId,
    orderQty: 1,
    orderType: 'Limit',
    price: SAFE_LIMIT_PRICE,
    timeInForce: 'GTC',
    isAutomated: true,
    // === Custom-id fields under test ===
    clOrdId: SIGNAL_ID,
    text: SIGNAL_ID,
    ...(USE_CUSTOM_TAG50 ? { customTag50: STRATEGY } : {}),
    // ===================================
    bracket1: {
      action: 'Sell', orderType: 'Stop', stopPrice: SAFE_STOP_PRICE,
      clOrdId: SL_CLORDID, text: SIGNAL_ID,    // children: clOrdId + text only
    },
    bracket2: {
      action: 'Sell', orderType: 'Limit', price: SAFE_TARGET_PRICE,
      clOrdId: TP_CLORDID, text: SIGNAL_ID,
    },
  };
  console.log('\n→ POST /order/placeOSO with payload:');
  console.log(JSON.stringify(payload, null, 2));
  const r = await req('POST', '/order/placeoso', payload);
  console.log(`\n← /order/placeOSO (${r.status}):`, JSON.stringify(r.body));
  if (r.status !== 200 || r.body?.failureReason) {
    throw new Error(`placeOSO failed: ${r.body?.failureReason} ${r.body?.failureText || ''}`);
  }
  // Tradovate returns { orderId, oso1Id, oso2Id } for OSO.
  return {
    parentOrderId: r.body.orderId,
    bracket1OrderId: r.body.oso1Id ?? r.body.bracket1OrderId ?? null,
    bracket2OrderId: r.body.oso2Id ?? r.body.bracket2OrderId ?? null,
  };
}

async function readBack(orderId, label) {
  console.log(`\n── Read-back for ${label} (orderId=${orderId}) ──`);

  // 1) Order entity (does not expose tags directly per schema, sanity check)
  const itemRes = await req('GET', `/order/item?id=${orderId}`);
  console.log(`  /order/item             → ${itemRes.status}`);
  if (itemRes.status === 200) {
    const o = itemRes.body || {};
    console.log(`    ordStatus=${o.ordStatus} action=${o.action} parentId=${o.parentId ?? '-'} ocoId=${o.ocoId ?? '-'} linkedId=${o.linkedId ?? '-'}`);
  }

  // 2) orderVersion/deps — should carry `text`
  const ovRes = await req('GET', `/orderVersion/deps?masterid=${orderId}`);
  console.log(`  /orderVersion/deps      → ${ovRes.status}`);
  let textField = null;
  if (ovRes.status === 200 && Array.isArray(ovRes.body)) {
    for (const ov of ovRes.body) {
      console.log(`    OrderVersion id=${ov.id} orderType=${ov.orderType} price=${ov.price ?? ov.stopPrice ?? '-'} text=${JSON.stringify(ov.text)}`);
      if (ov.text != null) textField = ov.text;
    }
  }

  // 3) command/deps — should carry `clOrdId` and `customTag50`
  const cmdRes = await req('GET', `/command/deps?masterid=${orderId}`);
  console.log(`  /command/deps           → ${cmdRes.status}`);
  let clOrdIdField = null, customTag50Field = null;
  if (cmdRes.status === 200 && Array.isArray(cmdRes.body)) {
    for (const cmd of cmdRes.body) {
      console.log(`    Command id=${cmd.id} type=${cmd.commandType} status=${cmd.commandStatus} clOrdId=${JSON.stringify(cmd.clOrdId)} customTag50=${JSON.stringify(cmd.customTag50)}`);
      if (cmd.clOrdId != null) clOrdIdField = cmd.clOrdId;
      if (cmd.customTag50 != null) customTag50Field = cmd.customTag50;
    }
  }

  return { textField, clOrdIdField, customTag50Field };
}

async function cancel(orderId) {
  if (!orderId) return;
  const r = await req('POST', '/order/cancelorder', { orderId: Number(orderId), isAutomated: true });
  console.log(`  /order/cancelorder ${orderId} → ${r.status} ${JSON.stringify(r.body)}`);
}

function summary(rows) {
  const cell = (sent, got) => {
    if (got == null) return `❌ MISSING (sent: ${JSON.stringify(sent)})`;
    if (got === sent) return `✅ ${JSON.stringify(got)}`;
    return `⚠️  MISMATCH — sent: ${JSON.stringify(sent)}, got: ${JSON.stringify(got)}`;
  };
  console.log('\n┌──────────────────────────────── ROUND-TRIP SUMMARY ────────────────────────────────┐');
  for (const r of rows) {
    console.log(`\n  ${r.label}  (orderId=${r.orderId})`);
    console.log(`    text         → ${cell(r.sent.text, r.got.textField)}`);
    console.log(`    clOrdId      → ${cell(r.sent.clOrdId, r.got.clOrdIdField)}`);
    if (r.sent.customTag50 !== undefined) {
      console.log(`    customTag50  → ${cell(r.sent.customTag50, r.got.customTag50Field)}`);
    }
  }
  console.log('\n└────────────────────────────────────────────────────────────────────────────────────┘');
}

(async () => {
  try {
    await auth();
    const contract = await findContract(SYMBOL);
    console.log(`\nContract: ${contract.name} id=${contract.id}`);

    const { parentOrderId, bracket1OrderId, bracket2OrderId } = await placeOSO(contract.id);
    console.log(`\nIDs → parent=${parentOrderId} oso1=${bracket1OrderId} oso2=${bracket2OrderId}`);

    // Give Tradovate a beat to materialize OrderVersion + Command rows.
    await new Promise(r => setTimeout(r, 1500));

    const parent = await readBack(parentOrderId, 'PARENT (entry)');
    const b1 = bracket1OrderId ? await readBack(bracket1OrderId, 'bracket1 (stop)') : null;
    const b2 = bracket2OrderId ? await readBack(bracket2OrderId, 'bracket2 (target)') : null;

    summary([
      { label: 'PARENT (entry)', orderId: parentOrderId,
        sent: { text: SIGNAL_ID, clOrdId: SIGNAL_ID, ...(USE_CUSTOM_TAG50 ? { customTag50: STRATEGY } : {}) },
        got: parent },
      ...(b1 ? [{ label: 'bracket1 (stop)', orderId: bracket1OrderId,
        sent: { text: SIGNAL_ID, clOrdId: SL_CLORDID },
        got: b1 }] : []),
      ...(b2 ? [{ label: 'bracket2 (target)', orderId: bracket2OrderId,
        sent: { text: SIGNAL_ID, clOrdId: TP_CLORDID },
        got: b2 }] : []),
    ]);

    console.log('\n→ Cleanup: cancelling parent (children cancel via OSO cascade)');
    await cancel(parentOrderId);
    // Some Tradovate setups don't cascade OSO cancels until the parent fills; cancel children defensively.
    await cancel(bracket1OrderId);
    await cancel(bracket2OrderId);

    console.log('\nDone.');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    if (err.response?.data) console.error('Response:', JSON.stringify(err.response.data, null, 2));
    process.exit(1);
  }
})();
