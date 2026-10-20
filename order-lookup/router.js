'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { createSecurity, equal, normalizeEmail, normalizeOrder } = require('./security');
const TOKEN = /^[a-f0-9]{64}$/;
const GENERIC = 'If the details match an eligible order, we will email a code. Check spam, or contact the store for help.';
const INVALID = 'Code invalid or expired. Request a new code or contact the store.';

function createOrderRouter({ store, shopify, mailer, securityKey, merchantId, allowedOrigins, lookupMerchant,
  clientSecret, shop, now = Date.now, onDisable = () => {} }) {
  const router = express.Router();
  const security = createSecurity(securityKey);
  const jobs = new Set();
  const hashEmail = email => security.hash('email', merchantId, email);
  const binding = (session, origin) => security.hash('binding', merchantId, session, origin);
  const limited = (kind, value, max, window) => store.limit(security.hash('limit', merchantId, kind, value), max, window);
  function available() { return store.enabled(); }
  // Register this single Shopify subscription before enabling a remote pilot.
  router.post('/webhook', (req, res) => {
    const signature = req.get('X-Shopify-Hmac-Sha256');
    const expected = crypto.createHmac('sha256', clientSecret).update(req.rawBody || Buffer.alloc(0)).digest('base64');
    if (!Buffer.isBuffer(req.rawBody) || !equal(signature, expected)) return res.sendStatus(401);
    if (req.get('X-Shopify-Shop-Domain') !== shop) return res.sendStatus(400);
    if (req.get('X-Shopify-Topic') === 'app/uninstalled') {
      if (req.body?.myshopify_domain !== shop) return res.sendStatus(400);
      store.disable();
      onDisable();
    }
    return res.sendStatus(200);
  });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.vary('Origin');
    const origin = req.get('Origin');
    if (!allowedOrigins.includes(origin)) return res.status(403).json({ error: 'Untrusted origin' });
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST') return res.sendStatus(405);
    const key = req.get('X-API-Key');
    const merchant = typeof key === 'string' && key.length < 200 ? lookupMerchant(key) : null;
    if (!merchant || merchant.id !== merchantId || !available()) return res.status(404).json({ error: 'Order lookup is unavailable. Contact the store.' });
    if (!store.hasCapacity()) return res.status(503).json({ error: 'Order lookup is busy. Please try later.' });
    if (!limited('network', req.ip, 30, 60_000)) return res.status(429).json({ error: 'Please wait before trying again.' });
    next();
  });
  router.post('/capabilities', (_req, res) => res.json({ enabled: true }));
  router.post('/start', (req, res) => {
    const name = normalizeOrder(req.body?.order);
    const email = normalizeEmail(req.body?.email);
    const session = req.body?.session;
    if (!name || !email || typeof session !== 'string' || !TOKEN.test(session)) return res.status(400).json({ error: 'Enter the exact order number and checkout email.' });
    if (jobs.size >= 4 || !limited('starts-network', req.ip, 5, 60_000)
      || !limited('starts-hour', 'all', 60, 3600_000)
      || !limited('starts-day', 'all', 300, 86400_000)) {
      res.set('Retry-After', '60'); return res.status(429).json({ error: 'Please wait before trying again.' });
    }
    const id = crypto.randomBytes(32).toString('hex');
    const digest = security.hash('challenge', id);
    store.create(digest, merchantId, binding(session, req.get('Origin')), now() + 300_000);
    const emailLimit = limited('email-15min', email, 3, 900_000);
    const orderLimit = limited('order-15min', name, 3, 900_000);
    const cooldown = limited('email-cooldown', email, 1, 60_000);
    res.status(202).json({ challenge: id, expires_in: 300, resend_after: 60, message: GENERIC });
    // Respond before querying upstream; absent, mismatching, limited and valid orders have the same response.
    const job = new Promise(resolve => setImmediate(resolve)).then(async () => {
      if (!emailLimit || !orderLimit || !cooldown || !available()) return;
      const match = await shopify.match(name, email);
      if (!match || !available() || !store.get(digest)) return;
      if (!limited('email-day', 'all', 30, 86400_000)) return;
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const reference = security.seal({ id: match.id, emailHash: hashEmail(email) }, digest);
      await mailer.send(match.email, code, 'order-' + id);
      if (available()) store.ready(digest, security.hash('otp', digest, code), reference);
    }).catch(() => {
      // Do not log upstream errors: Shopify and Resend may echo personal data or credentials.
    }).finally(() => jobs.delete(job));
    jobs.add(job);
  });
  router.post('/verify', (req, res, next) => { (async () => {
    const { challenge, session, code } = req.body || {};
    if (typeof challenge !== 'string' || !TOKEN.test(challenge) || typeof session !== 'string' || !TOKEN.test(session) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: INVALID });
    }
    if (!limited('verify-network', req.ip, 15, 60_000)) return res.status(429).json({ error: 'Please wait before trying again.' });
    const id = security.hash('challenge', challenge);
    const row = store.get(id);
    if (!row || row.tenant !== merchantId || !equal(row.binding, binding(session, req.get('Origin')))) {
      return res.status(400).json({ error: INVALID });
    }
    const attempted = store.attempt(id);
    if (!attempted || !row.reference || !equal(row.otp, security.hash('otp', id, code))) return res.status(400).json({ error: INVALID });
    // Consume synchronously before any await, including simultaneous replay attempts.
    store.remove(id);
    try {
      const reference = security.open(row.reference, id);
      const status = await shopify.read(reference.id, reference.emailHash, hashEmail);
      if (!status || !available()) return res.status(400).json({ error: INVALID });
      return res.json({ result: status, expires_in: 300 });
    } catch { return res.status(503).json({ error: 'The store could not be reached. Request a new code later or contact the store.' }); }
  })().catch(next); });
  router.post('/cancel', (req, res) => {
    const { challenge, session } = req.body || {};
    if (TOKEN.test(challenge || '') && TOKEN.test(session || '')) {
      const id = security.hash('challenge', challenge), row = store.get(id);
      if (row && row.tenant === merchantId && equal(row.binding, binding(session, req.get('Origin')))) store.remove(id);
    }
    res.json({ ok: true });
  });
  // Express 4 does not automatically catch rejected async handlers.
  router.use((_err, _req, res, _next) => res.status(503).json({ error: 'Order lookup is temporarily unavailable.' }));
  return { router, drain: () => Promise.all([...jobs]), close: async () => { await Promise.all([...jobs]); store.close(); } };
}
module.exports = { createOrderRouter };
