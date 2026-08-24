/**
 * Signal-lifecycle helpers for the trade-orchestrator.
 *
 * Pure functions extracted from index.js so they can be unit-tested without
 * booting the service (index.js runs main() on import). index.js binds the
 * EOD_CUTOFF_ET env value via thin wrappers; behavior is identical to the
 * previous inline definitions except where noted:
 *
 *   - normalizeOrderType now also maps 'place_stop' → 'Stop' (stop-market
 *     entry orders for the pattern strategies; opt-in — existing strategies
 *     never send place_stop, so nothing changes for them).
 *   - computeSignalExpiry now honors signal.exemptEodCutoff === true by
 *     skipping the EOD leg entirely (expiry = max-hold only). Default
 *     behavior for signals without the flag is unchanged.
 */

// Webhook/signal action → broker order type. Anything unrecognized returns
// null and the orchestrator drops the signal (existing behavior).
export function normalizeOrderType(action) {
  const a = String(action || '').toLowerCase();
  if (a === 'place_market') return 'Market';
  if (a === 'place_limit') return 'Limit';
  if (a === 'place_stop') return 'Stop';
  if (a === 'place_stop_limit') return 'StopLimit';
  return null;
}

// Entry actions that rest as a WORKING order at the broker until touched.
// Working orders are cancellable pre-fill: stale-limit timeout
// (timeoutCandles), pre-fill-extreme watcher, adverse-LS-flip watcher, and
// the cancel-on-close-beyond watcher all apply to these. place_market fills
// immediately and is never "working".
export function isWorkingEntryAction(action) {
  return action === 'place_limit' || action === 'place_stop' || action === 'place_stop_limit';
}

export function getEtParts(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return {
    weekday: o.weekday,
    dateKey: `${o.year}-${o.month}-${o.day}`,
    hour: parseInt(o.hour, 10),
    minute: parseInt(o.minute, 10),
  };
}

// Absolute UTC ms for an ET wall-clock (HH:MM) on a given ET calendar date.
// Computes the ET↔UTC offset empirically at the target instant so it's correct
// across DST without hardcoding -4/-5.
export function tsForEtWallClock(dateKey, hour, minute) {
  const [Y, Mo, D] = dateKey.split('-').map(Number);
  const utcGuess = Date.UTC(Y, Mo - 1, D, hour, minute, 0);
  const et = getEtParts(utcGuess);
  let delta = (hour * 60 + minute) - (et.hour * 60 + et.minute);
  if (delta > 720) delta -= 1440;
  if (delta < -720) delta += 1440;
  return utcGuess + delta * 60_000;
}

// Next EOD force-flat cutoff at/after `anchorTs` (skips weekends). null if EOD
// flattening is disabled (empty/unset cutoff string).
export function nextEodCutoffTs(anchorTs, eodCutoffEt) {
  if (!eodCutoffEt) return null;
  const [hStr, mStr] = eodCutoffEt.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr || '0', 10);
  if (!Number.isFinite(h)) return null;
  let probe = anchorTs;
  for (let i = 0; i < 8; i++) {
    const et = getEtParts(probe);
    if (et.weekday !== 'Sat' && et.weekday !== 'Sun') {
      const ts = tsForEtWallClock(et.dateKey, h, m);
      if (ts > anchorTs) return ts;
    }
    probe += 24 * 60 * 60 * 1000;
  }
  return null;
}

// When this trade would be force-closed if it never hits stop/target.
// maxHoldBars is per-signal (rule-dependent) and counted as MINUTES from entry
// (matching checkMaxHold); the EOD force-flat closes everything at the cutoff.
// The binding expiry is whichever comes first. `anchorTs` approximates
// entry/fill time.
//
// signal.exemptEodCutoff === true (opt-in, for 24/7 strategies that manage
// their own time caps) removes the EOD leg: expiry = max-hold only. The
// position-level EOD force-flat (checkEodForceFlat) honors the same flag.
export function computeSignalExpiry(signal, anchorTs = Date.now(), eodCutoffEt = null) {
  const exempt = signal?.exemptEodCutoff === true;
  const out = {
    expiresAt: null,
    expiryReason: null,
    eodCutoffEt: exempt ? null : (eodCutoffEt || null),
  };
  const maxHoldBars = Number(signal?.maxHoldBars);
  const maxHoldTs = Number.isFinite(maxHoldBars) && maxHoldBars > 0
    ? anchorTs + maxHoldBars * 60_000
    : null;
  const eodTs = exempt ? null : nextEodCutoffTs(anchorTs, eodCutoffEt);

  let ts = null, reason = null;
  if (maxHoldTs != null && eodTs != null) {
    if (eodTs <= maxHoldTs) { ts = eodTs; reason = 'eod'; }
    else { ts = maxHoldTs; reason = 'max_hold'; }
  } else if (maxHoldTs != null) {
    ts = maxHoldTs; reason = 'max_hold';
  } else if (eodTs != null) {
    ts = eodTs; reason = 'eod';
  }
  if (ts != null) { out.expiresAt = new Date(ts).toISOString(); out.expiryReason = reason; }
  return out;
}
