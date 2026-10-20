'use strict';
const crypto = require('node:crypto');

function createSecurity(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid order security key');
  const encryptionKey = Buffer.from(crypto.hkdfSync('sha256', key, '', 'order-encryption-v1', 32));
  const hmacKey = Buffer.from(crypto.hkdfSync('sha256', key, '', 'order-hmac-v1', 32));
  return {
    hash(...parts) { return crypto.createHmac('sha256', hmacKey).update(JSON.stringify(parts)).digest('hex'); },
    seal(value, context) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(Buffer.from(context));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    },
    open(value, context) {
      const bytes = Buffer.from(value, 'base64');
      const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
    },
  };
}
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
    && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  value = value.trim();
  // Conservative exact match: preserve local-part case, plus tags and dots.
  if (value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value)) return null;
  const at = value.lastIndexOf('@');
  return value.slice(0, at) + '@' + value.slice(at + 1).toLowerCase();
}
function normalizeOrder(value) {
  if (typeof value !== 'string') return null;
  value = value.trim();
  return /^#?[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value) ? value : null;
}
module.exports = { createSecurity, equal, normalizeEmail, normalizeOrder };
