import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CURRENT_KEY_VERSION = 1;

let cachedKeys = null;

function loadKeys() {
  if (cachedKeys) return cachedKeys;

  const primary = process.env.SLINGSHOT_MASTER_KEY;
  if (!primary) {
    throw new Error('SLINGSHOT_MASTER_KEY is not set; cannot encrypt/decrypt credentials');
  }

  const keys = { 1: parseKey(primary, 'SLINGSHOT_MASTER_KEY') };

  for (const [envName, value] of Object.entries(process.env)) {
    const match = envName.match(/^SLINGSHOT_MASTER_KEY_V(\d+)$/);
    if (match) {
      const version = Number(match[1]);
      keys[version] = parseKey(value, envName);
    }
  }

  cachedKeys = keys;
  return keys;
}

function parseKey(value, envName) {
  let buf;
  try {
    buf = Buffer.from(value, 'base64');
  } catch {
    throw new Error(`${envName} is not valid base64`);
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(`${envName} must decode to ${KEY_BYTES} bytes (got ${buf.length})`);
  }
  return buf;
}

function getKey(version) {
  const keys = loadKeys();
  const key = keys[version];
  if (!key) {
    throw new Error(`No master key registered for keyVersion ${version}`);
  }
  return key;
}

export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) {
    throw new Error('Cannot encrypt null/undefined value');
  }
  const value = typeof plaintext === 'string' ? plaintext : String(plaintext);

  const key = getKey(CURRENT_KEY_VERSION);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    keyVersion: CURRENT_KEY_VERSION
  };
}

export function decrypt(blob) {
  if (!blob || typeof blob !== 'object') {
    throw new Error('decrypt: expected encrypted blob object');
  }
  const { ciphertext, iv, tag, keyVersion } = blob;
  if (!ciphertext || !iv || !tag || !keyVersion) {
    throw new Error('decrypt: blob missing required fields (ciphertext/iv/tag/keyVersion)');
  }

  const key = getKey(keyVersion);
  const ivBuf = Buffer.from(iv, 'base64');
  const tagBuf = Buffer.from(tag, 'base64');
  if (tagBuf.length !== TAG_BYTES) {
    throw new Error(`decrypt: auth tag length must be ${TAG_BYTES} bytes`);
  }

  const decipher = crypto.createDecipheriv(ALGO, key, ivBuf);
  decipher.setAuthTag(tagBuf);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

export function isEncryptedBlob(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.ciphertext === 'string' &&
    typeof value.iv === 'string' &&
    typeof value.tag === 'string' &&
    typeof value.keyVersion === 'number'
  );
}

export function redact(blob) {
  if (!isEncryptedBlob(blob)) return null;
  return { hasValue: true };
}

export function generateMasterKey() {
  return crypto.randomBytes(KEY_BYTES).toString('base64');
}

export function _resetCacheForTests() {
  cachedKeys = null;
}

export const CURRENT_VERSION = CURRENT_KEY_VERSION;
