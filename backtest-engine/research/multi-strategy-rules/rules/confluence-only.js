// Confluence-only: only enter when at least 2 strategies hold same-side positions
// at the moment of a new signal. The triggering signal becomes the governing trade
// (its stop/target are freshest).
//
// Two exit variants:
//   * first-exit: close as soon as ANY cluster member exits (conservative).
//   * last-exit:  hold the governing trade through its own native exit, ignoring
//                 other cluster members' exits (more PnL, more risk).

import { open, reject, realizeNativeClose, realizeSyntheticClose } from './_base.js';

function makeRule(variant) {
  return {
    name: `confluence-only-${variant}`,
    onSignal(state, trade) {
      if (state.position) { reject(state); return; }
      // Count same-side actives (excluding the triggering trade itself).
      let sameSide = 0;
      const clusterIds = new Set([trade.id]);
      for (const [, other] of state.activeByStrategy) {
        if (other.id !== trade.id && other.side === trade.side) {
          sameSide += 1;
          clusterIds.add(other.id);
        }
      }
      if (sameSide >= 1) {
        // We need >= 2 total same-side trades active. trade itself + sameSide >= 2.
        open(state, trade, { clusterIds });
      } else {
        reject(state);
      }
    },
    onNativeExit(state, trade) {
      if (!state.position) return;
      const isGoverning = state.position.trade.id === trade.id;

      if (variant === 'last-exit') {
        if (isGoverning) realizeNativeClose(state, trade);
        return;
      }
      // first-exit
      if (isGoverning) {
        realizeNativeClose(state, trade);
        return;
      }
      // Other cluster member exits first → synthetic-close governing trade now.
      if (state.position.clusterIds && state.position.clusterIds.has(trade.id)) {
        // Use the exiting trade's actualExit as a proxy for "current price".
        realizeSyntheticClose(state, trade.exitTime, trade.actualExit, 'confluence-first-exit');
      }
    },
  };
}

export const confluenceFirstExit = makeRule('first-exit');
export const confluenceLastExit  = makeRule('last-exit');
