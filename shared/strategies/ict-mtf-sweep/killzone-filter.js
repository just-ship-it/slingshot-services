/**
 * Killzone Filter
 *
 * ICT killzones are high-probability time windows where institutional
 * order flow creates the best setups. Lower timeframe setups are
 * restricted to these windows; higher TF setups can enter anytime.
 *
 * Killzones (ET):
 *   London:  2:00 AM - 5:00 AM
 *   NY AM:   9:30 AM - 11:00 AM
 *   NY PM:   1:30 PM - 3:00 PM
 */

const KILLZONES = [
  { name: 'LONDON', startHour: 2, startMin: 0, endHour: 5, endMin: 0 },
  { name: 'NY_AM', startHour: 9, startMin: 30, endHour: 11, endMin: 0 },
  { name: 'NY_PM', startHour: 13, startMin: 30, endHour: 15, endMin: 0 },
];

// Default: higher TF setups can enter anytime, lower TF require killzones
const DEFAULT_TF_REQUIREMENTS = {
  '4h': false,   // no killzone required
  '1h': false,   // no killzone required
  '15m': false,  // preferred but not required
  '5m': true,    // killzone required
};

export class KillzoneFilter {
  constructor(params = {}) {
    this.requireKillzone = params.requireKillzone || false; // Force all TFs
    this.tfRequirements = { ...DEFAULT_TF_REQUIREMENTS, ...params.tfRequirements };
    this.killzones = KILLZONES;
  }

  /**
   * Get ET hour as decimal from a UTC timestamp
   */
  getETHour(ts) {
    const d = new Date(ts);
    const str = d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', minute: 'numeric', hour12: false
    });
    const [h, m] = str.split(':').map(Number);
    return h + m / 60;
  }

  /**
   * Check if timestamp falls within any killzone
   * @returns {{ inKillzone: boolean, killzoneName: string|null }}
   */
  checkKillzone(ts) {
    const etHour = this.getETHour(ts);

    for (const kz of this.killzones) {
      const start = kz.startHour + kz.startMin / 60;
      const end = kz.endHour + kz.endMin / 60;
      if (etHour >= start && etHour < end) {
        return { inKillzone: true, killzoneName: kz.name };
      }
    }
    return { inKillzone: false, killzoneName: null };
  }

  /**
   * Check if an entry is allowed for the given structure timeframe
   * @param {number} ts - Entry timestamp (ms)
   * @param {string} structureTF - Structure timeframe (e.g., '4h', '15m')
   * @returns {{ allowed: boolean, inKillzone: boolean, killzoneName: string|null }}
   */
  isEntryAllowed(ts, structureTF) {
    const { inKillzone, killzoneName } = this.checkKillzone(ts);

    // If global require-killzone is on, all TFs must be in killzone
    if (this.requireKillzone) {
      return { allowed: inKillzone, inKillzone, killzoneName };
    }

    // Check TF-specific requirement
    const required = this.tfRequirements[structureTF] ?? false;
    if (required && !inKillzone) {
      return { allowed: false, inKillzone, killzoneName };
    }

    return { allowed: true, inKillzone, killzoneName };
  }
}
