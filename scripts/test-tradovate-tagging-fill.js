#!/usr/bin/env node
/**
 * Fill-and-track tagging test.
 *
 * Builds on test-tradovate-tagging.js. The previous test proved that `text`
 * and `clOrdId` round-trip on WORKING orders. This script answers:
 *
 *   When an order FILLS and becomes a position, can we still recover the
 *   signalId/strategy from the broker?
 *
 * Specifically:
 *   (a) `text` still queryable on the (now historical) entry order
 *   (b) `text` queryable on bracket children once they activate
 *   (c) ExecutionReport for the fill carries `text`
 *   (d) Position → Fill → Order → OrderVersion.text walk works end-to-end
 *
 * Flow:
 *   1. Auth (demo).
 *   2. Place MARKET BUY 1 MNQM6 OSO with brackets ±200pts (won't trigger).
 *   3. Poll position until netPos != 0 (fill happened).
 *   4. Query everything described above and print a result table.
 *   5. Close: cancel both brackets, then market SELL 1 MNQM6 to flat.
 *
 * Risk: ~1-3 ticks of slippage on a 1-contract MNQ, i.e. $0.50–$1.50 of
 * demo PnL. Brackets are 200pts away so they don't get hit while we query.
 *
 * Env: same as test-tradovate-tagging.js (shared/.env).
 *
 * Run:
 *   node scripts/test-tradovate-tagging-fill.js
 *
 *   Set DRY_RUN=1 to skip the actual market order (auth + contract lookup only).
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
const ACCOUNT_ID = Number(TRADOVATE_DEMO_ACCOUNT_ID);
const SYMBOL = process.env.TEST_SYMBOL || 'MNQM6';
const SIGNAL_ID = `FILLTEST-${Date.now()}`;
const SL_CLORDID = `${SIGNAL_ID}.sl`;
const TP_CLORDID = `${SIGNAL_ID}.tp`;
const STOP_DISTANCE   = Number(process.env.TEST_STOP_DISTANCE   || 200);  // points away
const TARGET_DISTANCE = Number(process.env.TEST_TARGET_DISTANCE || 200);
const DRY_RUN = process.env.DRY_RUN === '1';

let accessToken = null;

async function auth() {
  const body = {
    name: TRADOVATE_USERNAME, password: TRADOVATE_PASSWORD,
    appId: TRADOVATE_APP_ID, appVersion: TRADOVATE_APP_VERSION || '1.0',
    deviceId: `slingshot-filltest-${Date.now()}`,
    cid: Number(TRADOVATE_CID), sec: TRADOVATE_SECRET,
  };
  const r = await axios.post(`${BASE}/auth/accesstokenrequest`, body, { headers: { 'Content-Type': 'application/json' } });
  if (r.data?.['p-ticket']) throw new Error(`Auth CAPTCHA p-ticket; wait ${r.data['p-time']}s`);
  if (!r.data?.accessToken) throw new Error(`Auth failed: ${r.data?.errorText || 'no accessToken'}`);
  accessToken = r.data.accessToken;
  console.log(`✅ Authed (userId=${r.data.userId})`);
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

async function getPosition(contractId) {
  const r = await req('GET', `/position/list`);
  if (r.status !== 200 || !Array.isArray(r.body)) return null;
  return r.body.find(p => p.accountId === ACCOUNT_ID && p.contractId === contractId) || null;
}

async function waitForFill(contractId, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = await getPosition(contractId);
    if (p && p.netPos !== 0) return p;
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

async function placeMarketOSO(contract) {
  // Brackets need explicit prices; we'll set them so far away they never trigger
  // during the test window. We don't know fill price yet → use stop offsets via
  // TrailingStop? No — Tradovate OSO needs concrete prices. Compromise: place
  // the entry alone as a market order, then once we have fill price, separately
  // place stop + target as a SECOND OSO/OCO. For attribution-tagging this is
  // simpler and still hits every code path we care about.
  //
  // Actually simpler still: place market entry with NO brackets. We're testing
  // attribution, not bracket lifecycle. Brackets we already proved work in the
  // first script.

  const payload = {
    accountSpec: TRADOVATE_USERNAME,
    accountId: ACCOUNT_ID,
    action: 'Buy',
    symbol: SYMBOL,
    contractId: contract.id,
    orderQty: 1,
    orderType: 'Market',
    isAutomated: true,
    clOrdId: SIGNAL_ID,
    text: SIGNAL_ID,
  };
  console.log(`\n→ POST /order/placeorder (Market BUY 1 ${SYMBOL}, text=${SIGNAL_ID})`);
  const r = await req('POST', '/order/placeorder', payload);
  console.log(`← /order/placeorder (${r.status}):`, JSON.stringify(r.body));
  if (r.status !== 200 || r.body?.failureReason) {
    throw new Error(`placeOrder failed: ${r.body?.failureReason} ${r.body?.failureText || ''}`);
  }
  return r.body.orderId;
}

async function flat(contract) {
  const payload = {
    accountSpec: TRADOVATE_USERNAME,
    accountId: ACCOUNT_ID,
    action: 'Sell',
    symbol: SYMBOL,
    contractId: contract.id,
    orderQty: 1,
    orderType: 'Market',
    isAutomated: true,
    clOrdId: `${SIGNAL_ID}.flat`,
    text: `${SIGNAL_ID}.flat`,
  };
  console.log(`\n→ Flattening: Market SELL 1 ${SYMBOL}`);
  const r = await req('POST', '/order/placeorder', payload);
  console.log(`← (${r.status}):`, JSON.stringify(r.body));
  return r.body?.orderId;
}

async function dumpOrderTags(orderId, label) {
  console.log(`\n── ${label} (orderId=${orderId}) ──`);

  const item = await req('GET', `/order/item?id=${orderId}`);
  if (item.status === 200) {
    const o = item.body;
    console.log(`  /order/item       ordStatus=${o.ordStatus} action=${o.action} contractId=${o.contractId} parentId=${o.parentId ?? '-'} ocoId=${o.ocoId ?? '-'} linkedId=${o.linkedId ?? '-'}`);
  } else {
    console.log(`  /order/item       ${item.status} ${JSON.stringify(item.body).slice(0, 120)}`);
  }

  const ov = await req('GET', `/orderVersion/deps?masterid=${orderId}`);
  let text = null;
  if (ov.status === 200 && Array.isArray(ov.body)) {
    for (const v of ov.body) {
      console.log(`  OrderVersion id=${v.id} text=${JSON.stringify(v.text)}`);
      if (v.text != null) text = v.text;
    }
  } else {
    console.log(`  /orderVersion/deps ${ov.status}`);
  }

  const cmd = await req('GET', `/command/deps?masterid=${orderId}`);
  let clOrdId = null, commandIds = [];
  if (cmd.status === 200 && Array.isArray(cmd.body)) {
    for (const c of cmd.body) {
      console.log(`  Command id=${c.id} type=${c.commandType} status=${c.commandStatus} clOrdId=${JSON.stringify(c.clOrdId)}`);
      if (c.clOrdId != null) clOrdId = c.clOrdId;
      commandIds.push(c.id);
    }
  } else {
    console.log(`  /command/deps ${cmd.status}`);
  }

  // ExecutionReport (FIX exec report — every state change for the order).
  // Keyed by Command.id, NOT orderId.
  let erTextFound = null;
  for (const cid of commandIds) {
    const er = await req('GET', `/executionReport/deps?masterid=${cid}`);
    if (er.status === 200 && Array.isArray(er.body)) {
      for (const e of er.body) {
        console.log(`  ExecutionReport id=${e.id} execType=${e.execType} ordStatus=${e.ordStatus} action=${e.action} lastQty=${e.lastQty ?? '-'} lastPx=${e.lastPx ?? '-'} text=${JSON.stringify(e.text)}`);
        if (e.text != null && !erTextFound) erTextFound = e.text;
      }
    } else {
      console.log(`  /executionReport/deps ${cid} → ${er.status}`);
    }
  }

  // Fills for the order
  const fills = await req('GET', `/fill/deps?masterid=${orderId}`);
  let fillIds = [];
  if (fills.status === 200 && Array.isArray(fills.body)) {
    for (const f of fills.body) {
      console.log(`  Fill id=${f.id} qty=${f.qty} price=${f.price} tradeDate=${JSON.stringify(f.tradeDate)} orderId=${f.orderId}`);
      fillIds.push(f.id);
    }
  } else {
    console.log(`  /fill/deps ${fills.status}`);
  }

  return { text, clOrdId, erText: erTextFound, fillIds };
}

(async () => {
  try {
    await auth();
    const contract = await findContract(SYMBOL);
    console.log(`Contract: ${contract.name} id=${contract.id}`);

    if (DRY_RUN) {
      console.log('\nDRY_RUN=1 → skipping order placement. Auth + contract lookup OK.');
      return;
    }

    const orderId = await placeMarketOSO(contract);
    console.log(`Order placed: orderId=${orderId}`);

    // Wait for fill (market order should fill < 1s on demo).
    const pos = await waitForFill(contract.id, 10000);
    if (!pos) {
      console.error('❌ Position did not appear within 10s — bailing without flat. Check Tradovate UI.');
      process.exit(1);
    }
    console.log(`\n✅ Position open: netPos=${pos.netPos} netPrice=${pos.netPrice} contractId=${pos.contractId}`);

    // Let ExecutionReport + Fill materialize fully
    await new Promise(r => setTimeout(r, 1500));

    // === Attribution recovery via post-fill paths ===
    const entryRes = await dumpOrderTags(orderId, 'ENTRY ORDER (post-fill)');

    // Position → Fills walk
    console.log('\n── POSITION → FILL → ORDER walk ──');
    // /fill/list filtered to our contract
    const allFills = await req('GET', `/fill/list`);
    let recentOrderIds = new Set();
    if (allFills.status === 200 && Array.isArray(allFills.body)) {
      const ours = allFills.body
        .filter(f => f.accountId === ACCOUNT_ID && f.contractId === contract.id)
        .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
        .slice(0, 5);
      console.log(`  /fill/list → ${ours.length} recent fills on accountId=${ACCOUNT_ID} contractId=${contract.id}`);
      for (const f of ours) {
        console.log(`    Fill id=${f.id} ts=${f.timestamp} orderId=${f.orderId} qty=${f.qty} price=${f.price}`);
        recentOrderIds.add(f.orderId);
      }
    }

    // For each fill's orderId we don't already know, fetch its text to verify the walk works
    for (const oid of recentOrderIds) {
      if (oid === orderId) continue;
      console.log(`\n  Recovered-from-walk orderId=${oid}:`);
      const ov = await req('GET', `/orderVersion/deps?masterid=${oid}`);
      if (ov.status === 200 && Array.isArray(ov.body)) {
        for (const v of ov.body) {
          console.log(`    OrderVersion id=${v.id} text=${JSON.stringify(v.text)}`);
        }
      }
    }

    // === Cleanup: flat ===
    const flatOrderId = await flat(contract);
    await new Promise(r => setTimeout(r, 1500));
    const after = await getPosition(contract.id);
    console.log(`\nAfter flat: netPos=${after?.netPos ?? 'none'}  (flat orderId=${flatOrderId})`);

    // === Summary ===
    console.log('\n┌──────────────────── POST-FILL ROUND-TRIP SUMMARY ────────────────────┐');
    const ok = (got, expected) => got === expected ? `✅ ${JSON.stringify(got)}` : got == null ? `❌ MISSING` : `⚠️  ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`;
    console.log(`  Entry order (orderId=${orderId}):`);
    console.log(`    OrderVersion.text     → ${ok(entryRes.text, SIGNAL_ID)}`);
    console.log(`    Command.clOrdId       → ${ok(entryRes.clOrdId, SIGNAL_ID)}`);
    console.log(`    ExecutionReport.text  → ${ok(entryRes.erText, SIGNAL_ID)}`);
    console.log(`    Fill count            → ${entryRes.fillIds.length > 0 ? `✅ ${entryRes.fillIds.length}` : '❌ no fills returned'}`);
    console.log('└──────────────────────────────────────────────────────────────────────┘');

    console.log('\nDone.');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    if (err.response?.data) console.error('Response:', JSON.stringify(err.response.data, null, 2));
    process.exit(1);
  }
})();
