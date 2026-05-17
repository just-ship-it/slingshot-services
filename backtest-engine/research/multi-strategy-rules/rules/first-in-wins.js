// First-in-wins: take the first signal that arrives when flat; reject all
// other signals (same or opposite side) until the held position natively exits.
// Zero synthetic exits. Safest, but ignores potentially higher-quality later signals.

import { open, reject, realizeNativeClose } from './_base.js';

export const firstInWins = {
  name: 'first-in-wins',
  onSignal(state, trade) {
    if (state.position == null) {
      open(state, trade);
    } else {
      reject(state);
    }
  },
  onNativeExit(state, trade) {
    if (state.position && state.position.trade.id === trade.id) {
      realizeNativeClose(state, trade);
    }
  },
};
