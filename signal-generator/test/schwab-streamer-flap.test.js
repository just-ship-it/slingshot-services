/**
 * Smoke test for the Schwab streamer flap/backoff guard.
 *
 * No framework. Run from signal-generator/:
 *   node test/schwab-streamer-flap.test.js
 *
 * Verifies the fix for the 2026-06-02 incident: two data-service instances both
 * logging into the same Schwab account boot each other with code=1000 right
 * after LOGIN. The OLD code reset reconnectAttempts on every LOGIN ack, so the
 * backoff stayed pinned at 5s forever and live candles never flowed. The fix:
 *   - a flap (connection that closed before STABLE_CONNECTION_MS) must NOT reset
 *     the backoff, so _scheduleReconnect escalates instead of hammering;
 *   - repeated flaps raise a 'session_conflict' alert;
 *   - a genuinely-stable connection dropping resets the flap counter.
 */

import SchwabStreamer from '../src/schwab/schwab-streamer.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

function makeStreamer() {
  const s = new SchwabStreamer({ appKey: 'x', appSecret: 'y' });
  // Neutralize the real reconnect path (it would setTimeout + connect()).
  let scheduled = 0;
  s._scheduleReconnect = () => { scheduled++; };
  s._getScheduled = () => scheduled;
  return s;
}

// ── Scenario 1: flaps don't reset backoff + alert fires after threshold ─────
(function flapsEscalateAndAlert() {
  const s = makeStreamer();
  s.reconnectAttempts = 5;          // pretend backoff already escalated
  s._lastConflictAlertAt = 0;       // allow an alert to fire

  const conflicts = [];
  s.on('session_conflict', (info) => conflicts.push(info));

  // Three short-lived connections in a row (1s uptime each → flap).
  for (let i = 0; i < 3; i++) {
    s._connectedAt = Date.now() - 1000; // 1s uptime, < STABLE_CONNECTION_MS
    s._handleClose(1000, 'none');
  }

  assert(s._consecutiveFlaps === 3, `expected 3 flaps, got ${s._consecutiveFlaps}`);
  assert(s.reconnectAttempts === 5, `_handleClose must NOT reset reconnectAttempts (got ${s.reconnectAttempts})`);
  assert(s._getScheduled() === 3, `each close should schedule a reconnect (got ${s._getScheduled()})`);
  assert(conflicts.length === 1, `session_conflict should fire once at the threshold (got ${conflicts.length})`);
  assert(/competing|second/i.test(conflicts[0].message), 'alert message should name the competing-session cause');
  console.log('  ✓ flaps escalate backoff (no reset) and raise a session_conflict alert');
})();

// ── Scenario 2: a stable connection dropping resets the flap counter ────────
(function stableDropResetsFlaps() {
  const s = makeStreamer();
  s._consecutiveFlaps = 4;          // pretend we'd been flapping

  s._connectedAt = Date.now() - 70_000; // 70s uptime, >= STABLE_CONNECTION_MS
  s._handleClose(1006, 'transient');

  assert(s._consecutiveFlaps === 0, `a stable drop must reset _consecutiveFlaps (got ${s._consecutiveFlaps})`);
  console.log('  ✓ a genuinely-stable connection dropping resets the flap counter');
})();

// ── Scenario 3: intentional disconnect never reconnects or counts a flap ────
(function intentionalDisconnect() {
  const s = makeStreamer();
  s.isDisconnecting = true;
  s._connectedAt = Date.now() - 1000;
  s._handleClose(1000, 'shutdown');

  assert(s._consecutiveFlaps === 0, 'intentional disconnect must not count as a flap');
  assert(s._getScheduled() === 0, 'intentional disconnect must not schedule a reconnect');
  console.log('  ✓ intentional disconnect does not reconnect or count a flap');
})();

// ── Scenario 4: single-reconnect guard — no chain multiplication ────────────
// The bug behind the 80-min prod flap: a pre-ack close double-scheduled
// reconnects, multiplying into ~7 parallel login loops. The guard ensures only
// ONE pending reconnect exists no matter how many times it's called.
(function singleReconnectGuard() {
  const s = new SchwabStreamer({ appKey: 'x', appSecret: 'y' });
  s.reconnectAttempts = 0;
  s._scheduleReconnect();  // first — schedules
  s._scheduleReconnect();  // second — must be a no-op (timer already pending)
  s._scheduleReconnect();  // third — no-op

  assert(s.reconnectAttempts === 1, `only the first call should schedule (attempts=${s.reconnectAttempts})`);
  assert(s._reconnectTimer != null, 'a reconnect timer should be pending');
  clearTimeout(s._reconnectTimer); s._reconnectTimer = null; // don't let it fire connect()
  console.log('  ✓ overlapping _scheduleReconnect calls collapse to one pending reconnect');
})();

// ── Scenario 5: a pre-ack close aborts the in-flight connect() ──────────────
(function preAckCloseAbortsLogin() {
  const s = makeStreamer();
  let aborted = false;
  s._loginAbort = () => { aborted = true; };
  s._hardReset = () => {}; // not under test here
  s._connectedAt = Date.now();
  s._handleClose(1000, 'pre-ack boot');

  assert(aborted === true, 'a close during LOGIN wait must abort the pending connect()');
  assert(s._loginAbort === null, '_loginAbort must be cleared after firing');
  console.log('  ✓ a close before LOGIN ack fails the pending connect() instead of hanging 30s');
})();

// ── Scenario 6: sustained flapping triggers a hard reset, not endless retries ─
(function hardResetOnSustainedFlap() {
  const s = makeStreamer();
  let hardResets = 0;
  s._hardReset = () => { hardResets++; };

  for (let i = 0; i < 5; i++) {
    s._connectedAt = Date.now() - 1000; // flap
    s._handleClose(1000, 'none');
  }

  assert(s._consecutiveFlaps === 5, `expected 5 flaps before reset (got ${s._consecutiveFlaps})`);
  assert(hardResets === 1, `hard reset should fire once at the threshold (got ${hardResets})`);
  // flaps 1-4 schedule a reconnect; flap 5 hard-resets instead (returns early).
  assert(s._getScheduled() === 4, `flaps below threshold reconnect; the threshold flap hard-resets (got ${s._getScheduled()})`);
  console.log('  ✓ sustained flapping triggers an in-process hard reset (no container restart)');
})();

// ── Scenario 7: disconnect() sends a Schwab LOGOUT before tearing down ──────
(async function disconnectSendsLogout() {
  const s = new SchwabStreamer({ appKey: 'x', appSecret: 'y' });
  s.streamerInfo = { schwabClientCustomerId: 'cust-1' };
  const sent = [];
  s.ws = {
    readyState: 1, // WebSocket.OPEN
    send: (data) => sent.push(data),
    removeAllListeners: () => {},
    terminate: () => {},
    close: () => {},
  };
  await s.disconnect();

  const loggedOut = sent.some(d => /"command":"LOGOUT"/.test(d));
  assert(loggedOut, 'disconnect() must send an ADMIN/LOGOUT to release the Schwab session');
  assert(s.ws === null, 'socket must be torn down after disconnect');
  console.log('  ✓ disconnect() sends LOGOUT (releases the account session — no ghost)');

  console.log('schwab-streamer-flap: all scenarios passed');
})();
