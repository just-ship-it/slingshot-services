/**
 * BaseConnector
 *
 * Abstract contract every broker connector must implement. Each connector
 * instance represents ONE configured account. The router asks a connector
 * to place an order; the connector knows how to talk to its broker.
 *
 * Subclasses must override the abstract methods. Static methods describe
 * the connector to the UI (display name, credential schema).
 *
 * Account record passed to the constructor is the *decrypted* form:
 *   { id, displayName, broker, enabled, config, credentials, tracking }
 */

const NOT_IMPLEMENTED = (cls, method) => {
  throw new Error(`${cls.constructor.name}.${method}() must be implemented by subclass`);
};

export class BaseConnector {
  constructor(account, logger, deps = {}) {
    if (new.target === BaseConnector) {
      throw new Error('BaseConnector is abstract — extend it for each broker');
    }
    if (!account || !account.id) {
      throw new Error('BaseConnector: account record with id is required');
    }
    if (!logger) {
      throw new Error('BaseConnector: logger is required');
    }
    this.account = account;
    this.logger = logger;
    this.deps = deps;
    this.ready = false;
  }

  // ---- Abstract surface ----

  async init() { NOT_IMPLEMENTED(this, 'init'); }
  async placeOrder(_order) { NOT_IMPLEMENTED(this, 'placeOrder'); }
  async cancelOrder(_orderId) { NOT_IMPLEMENTED(this, 'cancelOrder'); }
  async modifyStop(_orderId, _newStopPrice) { NOT_IMPLEMENTED(this, 'modifyStop'); }
  async closePosition(_symbol) { NOT_IMPLEMENTED(this, 'closePosition'); }
  async getPositions() { NOT_IMPLEMENTED(this, 'getPositions'); }
  async testConnection() { NOT_IMPLEMENTED(this, 'testConnection'); }

  // ---- Optional hooks with safe defaults ----

  async healthCheck() {
    return { ok: this.ready, latencyMs: null, lastError: null };
  }

  async shutdown() {
    this.ready = false;
  }

  // ---- Static descriptors (UI-facing) ----

  static brokerKey() {
    throw new Error('Subclass must implement static brokerKey()');
  }

  static displayName() {
    throw new Error('Subclass must implement static displayName()');
  }

  /**
   * Schema describing what credential fields this broker requires.
   * Frontend uses this to render the "Add Account" form dynamically.
   *
   * Shape:
   *   {
   *     fields: [
   *       { key, label, type, sensitive, options?, required?, placeholder?, help? }
   *     ],
   *     configFields: [...]   // non-sensitive broker-specific config
   *     tracking?: { supports, label, options }   // optional shadow-account
   *   }
   */
  static credentialSchema() {
    throw new Error('Subclass must implement static credentialSchema()');
  }
}

export default BaseConnector;
