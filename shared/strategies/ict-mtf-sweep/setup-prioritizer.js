/**
 * Setup Prioritizer
 *
 * When multiple setups are entry-ready simultaneously, pick the best one.
 * Only one position at a time (TradeSimulator enforces this).
 */

const TF_RANK = { '4h': 4, '1h': 3, '15m': 2, '5m': 1 };

export class SetupPrioritizer {
  constructor(params = {}) {
    this.mode = params.priorityMode || 'highest_tf';
  }

  /**
   * Pick the best setup from a list of entry-ready setups
   * @param {Array} setups - Array of setup objects with entryReady === true
   * @returns {Object|null} Best setup, or null if none
   */
  pick(setups) {
    if (!setups || setups.length === 0) return null;
    if (setups.length === 1) return setups[0];

    switch (this.mode) {
      case 'highest_tf':
        return this._byHighestTF(setups);
      case 'best_rr':
        return this._byBestRR(setups);
      case 'most_recent':
        return this._byMostRecent(setups);
      case 'killzone_first':
        return this._byKillzone(setups);
      default:
        return this._byHighestTF(setups);
    }
  }

  _byHighestTF(setups) {
    return setups.sort((a, b) => {
      const rankA = TF_RANK[a.structureTF] || 0;
      const rankB = TF_RANK[b.structureTF] || 0;
      if (rankB !== rankA) return rankB - rankA;
      // Tiebreak: MW_PATTERN (sweep-backed) preferred over STRUCTURE_RETRACE
      const modelRankA = a.entryModel === 'MW_PATTERN' ? 1 : 0;
      const modelRankB = b.entryModel === 'MW_PATTERN' ? 1 : 0;
      if (modelRankB !== modelRankA) return modelRankB - modelRankA;
      // Tiebreak: killzone entries preferred
      if (a.isKillzone && !b.isKillzone) return -1;
      if (!a.isKillzone && b.isKillzone) return 1;
      // Tiebreak: better R:R
      return (b.riskReward || 0) - (a.riskReward || 0);
    })[0];
  }

  _byBestRR(setups) {
    return setups.sort((a, b) => (b.riskReward || 0) - (a.riskReward || 0))[0];
  }

  _byMostRecent(setups) {
    return setups.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  }

  _byKillzone(setups) {
    const kzSetups = setups.filter(s => s.isKillzone);
    if (kzSetups.length > 0) return this._byHighestTF(kzSetups);
    return this._byHighestTF(setups);
  }
}
