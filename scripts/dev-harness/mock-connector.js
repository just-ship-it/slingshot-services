/**
 * MockConnector — a BaseConnector that records every call instead of
 * hitting a real broker. Useful for exercising routing end-to-end in a
 * dev environment without live credentials.
 *
 * Account shape:
 *   { id, broker: 'mock', config: { simulateLatencyMs?, simulateFailure? } }
 */

import { BaseConnector } from '../../shared/connectors/base-connector.js';
import { registerConnector } from '../../shared/connectors/registry.js';

const globalLog = [];

export class MockConnector extends BaseConnector {
  constructor(account, logger, deps = {}) {
    super(account, logger, deps);
    const cfg = account.config || {};
    this.latencyMs = cfg.simulateLatencyMs || 0;
    this.fail = !!cfg.simulateFailure;
    this.calls = [];
  }

  static brokerKey() { return 'mock'; }
  static displayName() { return 'Mock Broker (dev only)'; }
  static credentialSchema() {
    return {
      configFields: [
        { key: 'simulateLatencyMs', label: 'Simulated latency (ms)', type: 'number', required: false },
        { key: 'simulateFailure', label: 'Simulate failure', type: 'boolean', required: false }
      ],
      fields: []
    };
  }

  async init() { this.ready = true; }
  async shutdown() { this.ready = false; }
  async testConnection() { return { ok: true }; }
  async healthCheck() { return { ok: this.ready, latencyMs: this.latencyMs, lastError: null }; }
  async getPositions() { return []; }

  async _record(method, args) {
    const entry = {
      accountId: this.account.id,
      method,
      args,
      at: new Date().toISOString()
    };
    this.calls.push(entry);
    globalLog.push(entry);
    if (this.latencyMs) await new Promise(r => setTimeout(r, this.latencyMs));
    if (this.fail) throw new Error(`Mock ${method} failure (accountId=${this.account.id})`);
    return { ok: true, method, accountId: this.account.id };
  }

  async placeOrder(order) { return this._record('placeOrder', order); }
  async cancelOrder(id) { return this._record('cancelOrder', { orderId: id }); }
  async modifyStop(id, price) { return this._record('modifyStop', { orderId: id, price }); }
  async closePosition(sym) { return this._record('closePosition', { symbol: sym }); }
}

registerConnector(MockConnector);

export function drainMockCalls() {
  const out = globalLog.splice(0);
  return out;
}

export default MockConnector;
