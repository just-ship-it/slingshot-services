const DEFAULT_SENSITIVE_KEYS = new Set([
  'password',
  'pass',
  'token',
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'secret',
  'authorization',
  'auth',
  'pmttoken',
  'pmt_token',
  'tradovatepassword',
  'webhooksecret',
  'webhook_secret',
  'masterkey',
  'master_key',
  'access_token',
  'refresh_token',
  'bearer'
]);

const REDACTED = '[REDACTED]';

function isSensitiveKey(key, extra) {
  const lower = String(key).toLowerCase().replace(/[-_]/g, '');
  if (DEFAULT_SENSITIVE_KEYS.has(lower)) return true;
  if (extra && extra.has(lower)) return true;
  return false;
}

export function redactObject(input, options = {}) {
  const extra = options.additionalKeys
    ? new Set(options.additionalKeys.map(k => k.toLowerCase().replace(/[-_]/g, '')))
    : null;
  const seen = new WeakSet();

  function walk(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(walk);
    }

    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k, extra)) {
        if (v === null || v === undefined) {
          out[k] = v;
        } else if (typeof v === 'object' && v !== null && 'ciphertext' in v) {
          out[k] = { hasValue: true, lastFour: v.lastFour || null };
        } else {
          out[k] = REDACTED;
        }
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  }

  return walk(input);
}

export function createRedactingFormat(winstonFormat, options = {}) {
  return winstonFormat((info) => {
    const { level, message, timestamp, service, ...meta } = info;
    const cleanedMeta = redactObject(meta, options);
    return Object.assign({}, info, cleanedMeta);
  })();
}

export const SENSITIVE_KEYS = DEFAULT_SENSITIVE_KEYS;
