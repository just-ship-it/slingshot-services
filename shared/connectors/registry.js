/**
 * Connector Registry
 *
 * Maps broker key (e.g. "tradovate", "pickmytrade") → connector class.
 * Services register their available connector classes at startup.
 * The router and account-management API use this to look up the correct
 * connector for a given account.
 */

import { BaseConnector } from './base-connector.js';

const registry = new Map();

export function registerConnector(ConnectorClass) {
  if (!(ConnectorClass.prototype instanceof BaseConnector)) {
    throw new Error(`registerConnector: ${ConnectorClass.name} must extend BaseConnector`);
  }
  const key = ConnectorClass.brokerKey();
  if (!key) {
    throw new Error(`registerConnector: ${ConnectorClass.name}.brokerKey() returned empty value`);
  }
  registry.set(key, ConnectorClass);
  return ConnectorClass;
}

export function getConnectorClass(brokerKey) {
  return registry.get(brokerKey) || null;
}

export function listBrokers() {
  return [...registry.keys()];
}

export function listSchemas() {
  const out = {};
  for (const [key, Cls] of registry.entries()) {
    out[key] = {
      brokerKey: key,
      displayName: Cls.displayName(),
      ...Cls.credentialSchema()
    };
  }
  return out;
}

export function _resetRegistryForTests() {
  registry.clear();
}
