'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createStore } = require('../order-lookup/store');
const { createSecurity, normalizeEmail, normalizeOrder } = require('../order-lookup/security');
const { createShopify, createMailer, publicStatus, safeTrackingUrl } = require('../order-lookup/providers');
const { createOrderRouter } = require('../order-lookup/router');
const SHOP = 'getshopreply-test.myshopify.com';
const EMAIL = 'buyer+test@example.com';
const ID = 'gid://shopify/Order/1001';
const result = { status: 'Not yet fulfilled', shipments: [], source: 'Shopify store records', note: 'Test fulfillment record.' };

async function harness(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-regression-'));
  const filename = path.join(directory, 'state.db');
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const key = crypto.randomBytes(32);
  const store = createStore(filename, now);
  const messages = [];
  let reads = 0;
  const shopify = {
    async match(name, email) { return name === '#1001' && email === EMAIL ? { id: ID, email: EMAIL } : null; },
    async read(id, emailHash, hash) {
      assert.equal(id, ID); assert.equal(emailHash, hash(EMAIL)); ++reads;
      return structuredClone(result);
    }, ...options.shopify,
  };
  const mailer = { async send(email, code) { messages.push({ email, code }); }, ...options.mailer };
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
  let base;
  const origins = ['https://store.example', 'https://second.example'];
  const service = createOrderRouter({ store, shopify, mailer, securityKey: key, merchantId: 1, now,
    allowedOrigins: origins, lookupMerchant: value => value === 'public-one' ? { id: 1 } : value === 'public-two' ? { id: 2 } : null,
    clientSecret: 'fixture-client-secret', shop: SHOP });
  app.use('/api/order-lookup', service.router);
  if (options.browser) {
    app.get('/', (_req, res) => res.type('html').send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Development store preview</h1><script src="/embed.js" data-api-key="public-one" defer></script></body></html>'));
    app.get('/embed.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../public/widget/embed.js')));
    app.use('/static', express.static(path.resolve(__dirname, '../public/static')));
  }
  const server = app.listen(0, '127.0.0.1');
  await require('node:events').once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
  if (options.browser) origins.push(base);
  const session = crypto.randomBytes(32).toString('hex');
  async function post(endpoint, data, headers = {}) {
    const response = await fetch(base + '/api/order-lookup/' + endpoint, { method: 'POST',
      headers: { Origin: origins[0], 'X-API-Key': 'public-one', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { app, base, service, store, directory, filename, key, messages, session, now,
    advance(ms) { clock += ms; }, reads: () => reads, post,
    start: (fields = {}) => post('start', { order: '#1001', email: EMAIL, session, ...fields }),
    async close() { await new Promise(resolve => server.close(resolve)); await service.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

async function withHarness(fn, options) { const h = await harness(options); try { await fn(h); } finally { await h.close(); } }
async function main() {
  let passed = 0;
  async function test(name, fn) { await fn(); ++passed; console.log('PASS ' + name); }
  await test('valid code returns minimal status; single use and no plaintext storage', () => withHarness(async h => {
    const start = await h.start(); assert.equal(start.status, 202); await h.service.drain();
    assert.equal(h.messages.length, 1);
    const bytes = fs.readFileSync(h.filename).toString();
    for (const sensitive of [EMAIL, ID, h.messages[0].code, h.session, start.body.challenge]) assert.ok(!bytes.includes(sensitive));
    const request = { challenge: start.body.challenge, session: h.session, code: h.messages[0].code };
    const attempts = await Promise.all([h.post('verify', request), h.post('verify', request)]);
    assert.deepEqual(attempts.map(x => x.status).sort(), [200, 400]); assert.equal(h.reads(), 1);
    const value = attempts.find(x => x.status === 200); assert.deepEqual(value.body.result, result);
    assert.equal(value.headers.get('cache-control'), 'no-store');
  }));
  await test('wrong email, missing order and valid request have identical public shape', () => withHarness(async h => {
    const valid = await h.start(); await h.service.drain();
    const wrong = await h.start({ email: 'other@example.com' }); await h.service.drain();
    const absent = await h.start({ order: '#9999', email: 'unknown@example.com' }); await h.service.drain();
    for (const response of [valid, wrong, absent]) {
      assert.equal(response.status, 202); assert.deepEqual(Object.keys(response.body), Object.keys(valid.body));
      assert.equal(response.body.message, valid.body.message);
    }
    assert.equal(h.messages.length, 1);
  }));
  await test('tenant, browser binding and origin cannot be swapped', () => withHarness(async h => {
    const start = await h.start(); await h.service.drain();
    const request = { challenge: start.body.challenge, session: h.session, code: h.messages[0].code };
    assert.equal((await h.post('verify', request, { 'X-API-Key': 'public-two' })).status, 404);
    assert.equal((await h.post('verify', { ...request, session: 'a'.repeat(64) })).status, 400);
    assert.equal((await h.post('verify', request, { Origin: 'https://second.example' })).status, 400);
    assert.equal((await h.post('verify', request, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await h.post('verify', request)).status, 200);
  }));
  await test('five wrong codes permanently exhaust a challenge', () => withHarness(async h => {
    const start = await h.start(); await h.service.drain();
    const code = h.messages[0].code, wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await h.post('verify', { challenge: start.body.challenge, session: h.session, code: wrong })).status, 400);
    assert.equal((await h.post('verify', { challenge: start.body.challenge, session: h.session, code })).status, 400);
    assert.equal(h.reads(), 0);
  }));
  await test('expiry and cancellation revoke access', () => withHarness(async h => {
    const start = await h.start(); await h.service.drain(); h.advance(300_001);
    assert.equal((await h.post('verify', { challenge: start.body.challenge, session: h.session, code: h.messages[0].code })).status, 400);
    const next = await h.start(); await h.service.drain();
    await h.post('cancel', { challenge: next.body.challenge, session: h.session });
    assert.equal((await h.post('verify', { challenge: next.body.challenge, session: h.session, code: h.messages.at(-1).code })).status, 400);
  }));
  await test('resend cooldown and IP limit stop repeated sends', () => withHarness(async h => {
    for (let i = 0; i < 5; i++) { assert.equal((await h.start()).status, 202); await h.service.drain(); }
    assert.equal(h.messages.length, 1); assert.equal((await h.start()).status, 429);
  }));
  await test('malformed search input is rejected before Shopify', () => withHarness(async h => {
    for (const order of ['#1 OR email:*', '" OR *', { evil: true }]) assert.equal((await h.start({ order })).status, 400);
    assert.equal((await h.start({ session: [h.session] })).status, 400);
    assert.equal(h.messages.length, 0);
  }));
  await test('mailer and Shopify errors never escape to visitors', () => withHarness(async h => {
    const start = await h.start(); await h.service.drain();
    assert.equal(start.status, 202); assert.ok(!JSON.stringify(start).includes('PRIVATE_UPSTREAM'));
    assert.equal((await h.post('verify', { challenge: start.body.challenge, session: h.session, code: '123456' })).status, 400);
  }, { mailer: { async send() { throw new Error('PRIVATE_UPSTREAM'); } } }));
  await test('daily email budget cannot be bypassed by changing browser sessions', () => withHarness(async h => {
    for (let i = 0; i < 31; i++) {
      h.advance(16 * 60000);
      assert.equal((await h.start({ session: crypto.randomBytes(32).toString('hex') })).status, 202);
      await h.service.drain();
    }
    assert.equal(h.messages.length, 30);
  }));
  await test('ownership change or deleted order after OTP returns no result', () => withHarness(async h => {
    const start = await h.start(); await h.service.drain();
    const response = await h.post('verify', { challenge: start.body.challenge, session: h.session, code: h.messages[0].code });
    assert.equal(response.status, 400); assert.equal(response.body.result, undefined);
  }, { shopify: { async read() { return null; } } }));
  await test('status upstream failure consumes OTP and exposes no raw error', () => withHarness(async h => {
    const start = await h.start(); await h.service.drain();
    const request = { challenge: start.body.challenge, session: h.session, code: h.messages[0].code };
    const response = await h.post('verify', request);
    assert.equal(response.status, 503); assert.ok(!JSON.stringify(response).includes('PRIVATE_UPSTREAM'));
    assert.equal((await h.post('verify', request)).status, 400);
  }, { shopify: { async read() { throw new Error('PRIVATE_UPSTREAM'); } } }));
  await test('signed uninstall disables lookup, forged uninstall does not', () => withHarness(async h => {
    const body = { myshopify_domain: SHOP };
    const endpoint = h.base + '/api/order-lookup/webhook';
    const headers = { 'Content-Type': 'application/json', 'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Topic': 'app/uninstalled' };
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })).status, 401);
    assert.equal((await h.post('capabilities', {})).status, 200);
    headers['X-Shopify-Hmac-Sha256'] = crypto.createHmac('sha256', 'fixture-client-secret').update(JSON.stringify(body)).digest('base64');
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })).status, 200);
    assert.equal((await h.start()).status, 404);
  }));
  await test('limits persist and challenges invalidate after restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-restart-')), file = path.join(dir, 'state.db');
    try {
      let state = createStore(file);
      assert.equal(state.limit('budget', 1, 60000), true); state.create('challenge', 1, 'binding', Date.now() + 60000); state.close();
      state = createStore(file); assert.equal(state.limit('budget', 1, 60000), false); assert.equal(state.get('challenge'), undefined); state.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('authenticated encryption and exact normalization', async () => {
    const security = createSecurity(crypto.randomBytes(32));
    const sealed = security.seal({ secret: 'example' }, 'one');
    assert.deepEqual(security.open(sealed, 'one'), { secret: 'example' });
    assert.throws(() => security.open(sealed, 'other'));
    assert.equal(normalizeEmail('Buyer+tag@EXAMPLE.COM'), 'Buyer+tag@example.com');
    assert.equal(normalizeOrder('#1001'), '#1001');
  });
  await test('adapter exact match, token caching, no broad search or unwanted fields', async () => {
    const calls = [];
    const fetcher = async (url, options) => {
      calls.push({ url, options }); assert.equal(options.redirect, 'error');
      if (url.endsWith('access_token')) return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 86399, scope: 'read_orders' }));
      const request = JSON.parse(options.body);
      const data = request.query.includes('LookupIdentity')
        ? { shop: { myshopifyDomain: SHOP }, orders: { nodes: [{ id: ID, name: '#10010', email: EMAIL }, { id: ID, name: '#1001', email: EMAIL }] } }
        : { shop: { myshopifyDomain: SHOP }, order: { id: ID, email: EMAIL, displayFulfillmentStatus: 'UNFULFILLED', fulfillments: [] } };
      return new Response(JSON.stringify({ data }));
    };
    const adapter = createShopify({ shop: SHOP, clientId: 'fake', clientSecret: 'fake', fetcher });
    assert.deepEqual(await adapter.match('#1001', EMAIL), { id: ID, email: EMAIL });
    assert.equal(await adapter.match('#1001', 'other@example.com'), null);
    assert.equal((await adapter.read(ID, EMAIL, value => value)).status, 'Not yet fulfilled');
    assert.equal(calls.filter(x => x.url.endsWith('access_token')).length, 1);
    assert.equal(JSON.parse(calls[1].options.body).variables.search, 'name:"#1001"');
    assert.ok(!calls.some(x => /shippingAddress|phone|displayFinancialStatus/.test(x.options.body)));
    assert.throws(() => createShopify({ shop: 'unapproved.myshopify.com' }));
  });
  await test('safe public projection handles partial delivery, cancellation and tracking links', async () => {
    const projected = publicStatus({ displayFulfillmentStatus: 'PARTIALLY_FULFILLED', email: EMAIL, shippingAddress: 'PRIVATE',
      fulfillments: [{ status: 'SUCCESS', deliveredAt: null, trackingInfo: [{ company: '<script>', number: 'TEST', url: 'javascript:alert(1)' }] },
        { status: 'SUCCESS', deliveredAt: '2026-10-01', trackingInfo: [{ url: 'https://www.ups.com/track?number=TEST' }] },
        { status: 'CANCELLED', trackingInfo: [] }] });
    assert.equal(projected.status, 'Partially fulfilled'); assert.equal(projected.shipments.length, 2);
    assert.equal(projected.shipments[0].tracking[0].url, null);
    assert.equal(projected.shipments[1].status, 'Delivered (reported by Shopify)');
    assert.ok(!JSON.stringify(projected).includes(EMAIL)); assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
    for (const url of ['https://ups.com.evil.test/', 'https://evil@ups.com/', 'http://ups.com/', 'https://127.0.0.1/']) assert.equal(safeTrackingUrl(url), null);
    assert.equal(publicStatus({ cancelledAt: '2026-10-01' }).status, 'Cancelled');
  });
  await test('Resend uses only verified sender and order email', async () => {
    const mailer = createMailer({ apiKey: 'fake', from: 'GetShopReply <no-reply@notify.getshopreply.com>', fetcher: async (url, options) => {
      assert.equal(url, 'https://api.resend.com/emails'); assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body); assert.deepEqual(body.to, [EMAIL]); assert.ok(body.text.includes('123456'));
      assert.ok(!body.text.includes('#1001')); return new Response('{"id":"fixture-message"}');
    } });
    await mailer.send(EMAIL, '123456', 'fixture-idempotency');
  });
  console.log('ORDER LOOKUP: ' + passed + ' scenarios passed; no real emails or Shopify requests.');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { harness, EMAIL };
