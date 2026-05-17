// Flip-on-conflict: same-direction signals are rejected; opposite-direction
// signals close the current position at the new signal's entry price (synthetic)
// and immediately open the opposite-side trade.
//
// CAVEAT: the displaced trade may have hit its stop or target BEFORE the
// opposite signal arrived — we can't know without re-simulating against
// 1m/1s bars (which the research constraint forbids). So this rule's PnL
// has a known optimistic bias. The `syntheticExits` counter in the output
// flags how often this approximation is used.

import { open, reject, realizeNativeClose, realizeSyntheticClose } from './_base.js';

export const flipOnConflict = {
  name: 'flip-on-conflict',
  onSignal(state, trade) {
    if (state.position == null) {
      open(state, trade);
      return;
    }
    if (state.position.trade.side === trade.side) {
      reject(state);
      return;
    }
    // Opposite side: synthetic-close current at the new signal's entry price, then open new.
    realizeSyntheticClose(state, trade.entryTime, trade.actualEntry, 'flipped');
    open(state, trade);
  },
  onNativeExit(state, trade) {
    if (state.position && state.position.trade.id === trade.id) {
      realizeNativeClose(state, trade);
    }
  },
};
