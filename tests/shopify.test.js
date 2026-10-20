'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopreply-test-'));
process.env.CSB_DATA_DIR = dataDir;
process.env.PUBLIC_BASE_URL = 'https://app.example.test';
process.env.SHOPIFY_API_KEY = 'test-client';
process.env.SHOPIFY_API_SECRET = 'test-secret-not-a-real-credential';
process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SHOPIFY_BILLING_TEST = 'true';
process.env.LLM_API_KEY = 'local-test';
process.env.LLM_BASE_URL = 'https://llm.example.test';
process.env.CSB_ALLOW_MOCK_BILLING = '1';
const app = require('../server');
const { db, ensureMonthReset, tryConsumeConvo } = require('../db');
const shopify = require('../shopify');
const nativeFetch = global.fetch;
const stores = new Map();
let calls = [];
let failBilling = false;
let answer = 'Shipping takes 3 days.';
let pauseLlm;
let releaseLlm;

function store(shop) {
  if (!stores.has(shop)) stores.set(shop, { subscriptions: [], pending: null, metafields: null });
  return stores.get(shop);
}
global.fetch = async function (url, opts) {
  const u = new URL(url);
  if (u.hostname === 'llm.example.test') {
    if (pauseLlm) { pauseLlm(); await new Promise(resolve => { releaseLlm = resolve; }); }
    return Response.json({ choices: [{ message: { content: answer } }] });
  }
  assert.match(u.hostname, /\.myshopify\.com$/);
  calls.push({ url: String(url), body: opts.body });
  const s = store(u.hostname);
  if (u.pathname === '/admin/oauth/access_token') {
    const p = new URLSearchParams(opts.body);
    if (p.get('grant_type') !== 'refresh_token') assert.equal(p.get('expiring'), '1');
    return Response.json({ access_token: 'fake-admin-access', refresh_token: 'fake-refresh', expires_in: 3600 });
  }
  const { query, variables } = JSON.parse(opts.body);
  if (query.includes('query Connect')) return Response.json({ data: { shop: { id: `gid://shopify/Shop/${u.hostname}`, name: 'Test store' }, currentAppInstallation: { id: 'gid://shopify/AppInstallation/1' } } });
  if (query.includes('mutation PublishWidget')) { s.metafields = variables.metafields; return Response.json({ data: { metafieldsSet: { userErrors: [] } } }); }
  if (query.includes('query Subscriptions')) {
    if (failBilling) return Response.json({ errors: [{ message: 'Temporary upstream failure' }] });
    return Response.json({ data: { currentAppInstallation: { activeSubscriptions: s.subscriptions } } });
  }
  if (query.includes('mutation Subscribe')) {
    s.pending = { id: 'gid://shopify/AppSubscription/' + crypto.randomUUID(), name: variables.name, status: 'ACTIVE', test: true,
      lineItems: [{ plan: { pricingDetails: variables.lineItems[0].plan.appRecurringPricingDetails } }] };
    return Response.json({ data: { appSubscriptionCreate: { confirmationUrl: `https://${u.hostname}/admin/charges/123/confirm`, userErrors: [] } } });
  }
  if (query.includes('mutation Cancel')) { s.subscriptions = []; return Response.json({ data: { appSubscriptionCancel: { userErrors: [] } } }); }
  throw new Error('Unexpected Shopify request');
};
function jwt(shop, overrides = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const parts = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...header })).toString('base64url'),
    Buffer.from(JSON.stringify({ dest: `https://${shop}`, iss: `https://${shop}/admin`, aud: 'test-client', sub: '123', sid: 'test-session', iat: now, nbf: now - 1, exp: now + 60, ...overrides })).toString('base64url')];
  return parts.join('.') + '.' + crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(parts.join('.')).digest('base64url');
}
function row(shop) { return db.prepare('SELECT * FROM shopify_shops WHERE shop=?').get(shop); }
function merchant(shop) { return db.prepare('SELECT * FROM merchants WHERE id=?').get(row(shop).merchant_id); }

test('Shopify integration: isolated database and mocked external services', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const A = 'alpha-test.myshopify.com', B = 'beta-test.myshopify.com';
  async function request(route, { method = 'GET', token, body, headers = {} } = {}) {
    const r = await nativeFetch(base + route, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: r.status, data, headers: r.headers };
  }
  const api = (shop, route, method = 'GET', body) => request('/shopify/api/' + route, { token: jwt(shop), method, body });
  async function webhook(shop, topic, payload = {}, id = crypto.randomUUID(), extraHeaders = {}) {
    const raw = JSON.stringify(payload);
    return request('/shopify/webhooks', { method: 'POST', body: payload, headers: {
      'x-shopify-shop-domain': shop, 'x-shopify-topic': topic, 'x-shopify-webhook-id': id,
      'x-shopify-triggered-at': new Date(Date.now() + 5).toISOString(),
      'x-shopify-hmac-sha256': crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(raw).digest('base64'), ...extraHeaders,
    } });
  }
  try {
    await t.test('rejects absent, tampered, expired and wrong-store session claims', async () => {
      assert.equal((await request('/shopify/api/state')).status, 401);
      for (const claims of [{ aud: 'other' }, { exp: 1 }, { nbf: Date.now() / 1000 + 60 }, { iss: 'https://other.myshopify.com/admin' }, { dest: 'https://evil.test' }, { iat: 'not-a-time' }, { sub: '' }, { sid: '' }]) {
        assert.equal((await request('/shopify/api/state', { token: jwt(A, claims) })).status, 401);
      }
      assert.equal((await request('/shopify/api/state', { token: jwt(A) + 'bad' })).status, 401);
      assert.equal((await request('/shopify/api/state', { token: jwt(A, {}, { alg: 'none' }) })).status, 401);
    });
    await t.test('connect creates separate accounts and encrypts credentials, publishes public config', async () => {
      assert.equal((await api(A, 'connect', 'POST', {})).status, 200);
      assert.equal((await api(B, 'connect', 'POST', {})).status, 200);
      assert.notEqual(row(A).merchant_id, row(B).merchant_id);
      assert.ok(!row(A).credentials.includes('fake-admin-access'));
      assert.equal(shopify.unseal(row(A).credentials).access, 'fake-admin-access');
      const widget = JSON.parse(store(A).metafields[0].value);
      assert.equal(widget.api_key, merchant(A).api_key);
      assert.equal(widget.base_url, process.env.PUBLIC_BASE_URL);
      assert.ok(!JSON.stringify(widget).includes('fake-admin-access'));
      const count = db.prepare('SELECT count(*) AS n FROM merchants').get().n;
      await api(A, 'connect', 'POST', {});
      assert.equal(db.prepare('SELECT count(*) AS n FROM merchants').get().n, count);
    });
    await t.test('settings stay scoped to the authenticated shop; HTML is stored as text', async () => {
      const settings = { brand_name: 'Alpha', shipping_info: '3 days', return_policy: '30 days', extra_info: '', faqs: [{ question: '<img src=x onerror=alert(1)>', answer: 'Text only' }] };
      assert.equal((await api(A, 'settings', 'PUT', settings)).status, 200);
      assert.equal((await api(A, 'state')).data.merchant.brand_name, 'Alpha');
      assert.equal((await api(B, 'state')).data.merchant.brand_name, 'Test store');
      assert.equal((await api(A, 'settings', 'PUT', { ...settings, faqs: [{ question: '', answer: 'x' }] })).status, 400);
      assert.equal((await api(A, 'state')).data.faqs.length, 1);
    });
    await t.test('monthly allowance does not reset on a new day, resets across UTC month', () => {
      const id = row(A).merchant_id;
      const today = new Date().toISOString().slice(0, 10);
      db.prepare('UPDATE merchants SET monthly_convo_count=77, convo_count_reset_at=? WHERE id=?').run(today.slice(0, 8) + '01', id);
      ensureMonthReset(id); assert.equal(merchant(A).monthly_convo_count, 77);
      db.prepare("UPDATE merchants SET convo_count_reset_at='2020-01-01' WHERE id=?").run(id);
      ensureMonthReset(id); assert.equal(merchant(A).monthly_convo_count, 0);
      db.prepare('UPDATE merchants SET monthly_convo_count=100 WHERE id=?').run(id);
      assert.equal(tryConsumeConvo(id).ok, false);
    });
    await t.test('quota exhaustion still allows email handoff without an AI request', async () => {
      const key = merchant(A).api_key;
      const chat = await request('/api/chat', { method: 'POST', headers: { 'X-API-Key': key }, body: { message: 'Help', session_key: 'visitor-a' } });
      assert.equal(chat.status, 402); assert.equal(chat.data.upgrade_url, undefined);
      const handoff = await request('/api/chat/handoff', { method: 'POST', headers: { 'X-API-Key': key }, body: { message: 'Help', email: 'visitor@example.test', session_key: 'visitor-a' } });
      assert.equal(handoff.status, 200); assert.equal(merchant(A).monthly_convo_count, 100);
      assert.equal((await api(A, 'state')).data.escalations.length, 1);
      assert.equal((await api(B, 'state')).data.escalations.length, 0);
      const cors = await request('/api/chat', { method: 'OPTIONS', headers: { Origin: 'https://custom-store.test' } });
      assert.equal(cors.status, 204); assert.equal(cors.headers.get('access-control-allow-origin'), '*');
    });
    await t.test('only confirmed Shopify plans grant Pro; usage is preserved', async () => {
      assert.equal((await api(A, 'billing', 'POST', { plan: 'growth_monthly' })).status, 400);
      const checkout = await api(A, 'billing', 'POST', { plan: 'pro_monthly' });
      assert.equal(checkout.status, 200); assert.match(checkout.data.confirmation_url, /alpha-test/);
      assert.equal(merchant(A).tier, 'free');
      store(A).subscriptions = [store(A).pending];
      assert.equal((await webhook(A, 'app_subscriptions/update', { app_subscription: { status: 'CANCELLED' } })).status, 200);
      assert.equal(merchant(A).tier, 'pro_monthly'); assert.equal(merchant(A).monthly_convo_count, 100);
      await api(A, 'billing', 'POST', { plan: 'pro_annual' });
      const pricing = store(A).pending.lineItems[0].plan.pricingDetails;
      assert.equal(pricing.interval, 'ANNUAL'); assert.equal(pricing.price.amount, 205);
      store(A).subscriptions = [store(A).pending];
      assert.equal((await api(A, 'state')).data.billing.tier, 'pro_annual');
    });
    await t.test('expired offline tokens refresh under a single per-shop lock', async () => {
      const current = shopify.unseal(row(A).credentials); current.expires = 1;
      db.prepare('UPDATE shopify_shops SET credentials=? WHERE shop=?').run(shopify.seal(current), A);
      const before = calls.filter(c => c.url.endsWith('access_token')).length;
      await Promise.all([api(A, 'state'), api(A, 'state')]);
      assert.equal(calls.filter(c => c.url.endsWith('access_token')).length - before, 1);
    });
    await t.test('invalid webhook signatures and upstream failures do not change entitlements', async () => {
      assert.equal((await webhook(A, 'app/uninstalled', {}, crypto.randomUUID(), { 'x-shopify-hmac-sha256': 'bad' })).status, 401);
      assert.equal((await webhook(A, 'customers/redact', { shop_domain: B, customer: { email: 'visitor@example.test' } })).status, 400);
      assert.equal(merchant(A).tier, 'pro_annual');
      failBilling = true;
      const event = crypto.randomUUID();
      assert.equal((await webhook(A, 'app_subscriptions/update', {}, event)).status, 502);
      assert.equal(db.prepare('SELECT 1 FROM shopify_webhooks WHERE id=?').get(event), undefined);
      failBilling = false;
      assert.equal((await webhook(A, 'app_subscriptions/update', {}, event)).status, 200);
    });
    await t.test('paid subscription cancellation requires confirmation and preserves used quota', async () => {
      assert.equal((await api(A, 'billing/cancel', 'POST', {})).status, 400);
      assert.equal((await api(A, 'billing/cancel', 'POST', { confirmed: true })).status, 200);
      assert.equal(merchant(A).tier, 'free'); assert.equal(merchant(A).monthly_convo_count, 100);
    });
    await t.test('privacy export is durable, encrypted, deduplicated and inaccessible to another shop', async () => {
      const id = crypto.randomUUID();
      assert.equal((await webhook(A, 'customers/data_request', { customer: { email: 'visitor@example.test' } }, id)).status, 200);
      await webhook(A, 'customers/data_request', { customer: { email: 'visitor@example.test' } }, id);
      assert.ok(!db.prepare('SELECT payload FROM shopify_privacy_requests WHERE id=?').get(id).payload.includes('visitor@example.test'));
      assert.equal((await api(A, 'privacy/' + id)).data.escalations.length, 1);
      assert.equal((await api(B, 'privacy/' + id)).status, 404);
      assert.equal(db.prepare('SELECT count(*) AS n FROM shopify_privacy_requests WHERE id=?').get(id).n, 1);
    });
    await t.test('redaction clears matching visitor records and previously generated exports', async () => {
      const id = row(A).merchant_id;
      db.prepare("INSERT INTO conversations (merchant_id, session_key, role, content) VALUES (?, 'visitor-a', 'user', 'Help')").run(id);
      assert.equal((await webhook(A, 'customers/redact', { customer: { email: 'visitor@example.test' } })).status, 200);
      for (const table of ['escalations', 'conversations', 'visitor_sessions']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE merchant_id=?`).get(id).n, 0);
      assert.equal((await api(A, 'state')).data.privacy_requests.length, 0);
      assert.equal(row(A).privacy_epoch, 1);
    });
    await t.test('successful answers count once; escalation and previews do not consume allowance', async () => {
      db.prepare('UPDATE merchants SET monthly_convo_count=0 WHERE id=?').run(row(A).merchant_id);
      const headers = { 'X-API-Key': merchant(A).api_key };
      assert.equal((await request('/api/chat', { method: 'POST', headers, body: { message: 'Shipping?', session_key: 'answer-a' } })).status, 200);
      assert.equal(merchant(A).monthly_convo_count, 1);
      answer = 'ESCALATE';
      assert.equal((await request('/api/chat', { method: 'POST', headers, body: { message: 'Other?', session_key: 'answer-b' } })).data.needs_email, true);
      assert.equal(merchant(A).monthly_convo_count, 1);
      assert.equal((await api(A, 'preview', 'POST', { message: 'Other?' })).status, 200);
      assert.equal(merchant(A).monthly_convo_count, 1); answer = 'Shipping takes 3 days.';
    });
    await t.test('in-flight AI replies cannot recreate data after customer erasure', async () => {
      const started = new Promise(resolve => { pauseLlm = resolve; });
      const reply = request('/api/chat', { method: 'POST', headers: { 'X-API-Key': merchant(A).api_key }, body: { message: 'Shipping?', session_key: 'in-flight' } });
      await started;
      await webhook(A, 'customers/redact', { customer: { email: 'visitor@example.test' } });
      pauseLlm = null; releaseLlm();
      assert.equal((await reply).status, 409);
      assert.equal(db.prepare('SELECT count(*) AS n FROM conversations WHERE merchant_id=?').get(row(A).merchant_id).n, 0);
    });
    await t.test('retention removes expired Shopify records but keeps current records', () => {
      const id = row(A).merchant_id;
      db.prepare("INSERT INTO escalations (merchant_id,email,question,created_at) VALUES (?, 'old@example.test', 'old', '2020-01-01')").run(id);
      db.prepare("INSERT INTO escalations (merchant_id,email,question) VALUES (?, 'new@example.test', 'new')").run(id);
      shopify.purgeExpired();
      assert.equal(db.prepare('SELECT count(*) AS n FROM escalations WHERE merchant_id=?').get(id).n, 1);
    });
    await t.test('standalone login remains functional and Shopify-linked accounts cannot use mock billing', async () => {
      const signup = await request('/api/auth/signup', { method: 'POST', body: { email: 'standalone@example.test', password: 'test-password' } });
      assert.equal(signup.status, 200);
      const cookie = signup.headers.get('set-cookie').split(';')[0];
      assert.equal((await request('/api/admin/me', { headers: { Cookie: cookie } })).status, 200);
      const standalone = db.prepare("SELECT id FROM merchants WHERE email='standalone@example.test'").get();
      // Simulate an explicitly migrated account retaining its old cookie.
      db.prepare('UPDATE shopify_shops SET merchant_id=? WHERE shop=?').run(standalone.id, B);
      assert.equal((await request('/api/billing/upgrade-mock', { method: 'POST', headers: { Cookie: cookie }, body: { price_key: 'pro_monthly' } })).status, 409);
      assert.equal((await request('/api/billing/start-trial', { method: 'POST', headers: { Cookie: cookie }, body: {} })).status, 409);
      assert.equal((await request('/api/billing/checkout', { method: 'POST', headers: { Cookie: cookie }, body: {} })).status, 409);
    });
    await t.test('shell and legal pages render; shell contains no secret', async () => {
      const shell = await request('/shopify?shop=' + A);
      assert.equal(shell.status, 200); assert.ok(shell.data.includes('test-client'));
      assert.ok(!shell.data.includes(process.env.SHOPIFY_API_SECRET));
      assert.ok(shell.headers.get('content-security-policy').includes(A));
      assert.equal((await request('/privacy')).status, 200); assert.equal((await request('/terms')).status, 200);
      assert.equal((await request('/embed.js')).status, 200);
    });
    await t.test('uninstall deletes owned data, invalidates key and cannot erase another shop', async () => {
      const key = merchant(A).api_key, merchantId = row(A).merchant_id;
      const started = new Promise(resolve => { pauseLlm = resolve; });
      const pendingReply = request('/api/chat', { method: 'POST', headers: { 'X-API-Key': key }, body: { message: 'Shipping?', session_key: 'uninstall-in-flight' } });
      await started;
      const id = crypto.randomUUID();
      assert.equal((await webhook(A, 'app/uninstalled', {}, id)).status, 200);
      pauseLlm = null; releaseLlm();
      assert.equal((await pendingReply).status, 401);
      assert.equal((await webhook(A, 'app/uninstalled', {}, id)).status, 200);
      assert.equal(db.prepare('SELECT 1 FROM merchants WHERE id=?').get(merchantId), undefined);
      assert.equal(row(A).credentials, null);
      assert.equal((await api(A, 'state')).status, 401);
      assert.equal((await request('/api/chat/handoff', { method: 'POST', headers: { 'X-API-Key': key }, body: { email: 'x@y.test', message: 'Hello', session_key: 'x' } })).status, 401);
      assert.ok(merchant(B));
      assert.equal((await api(A, 'connect', 'POST', {})).status, 401);
    });
    await t.test('reinstall creates a fresh widget key and ignores stale lifecycle events', async () => {
      db.prepare('UPDATE shopify_shops SET uninstalled_at=? WHERE shop=?').run(Date.now() - 120000, A);
      assert.equal((await api(A, 'connect', 'POST', {})).status, 200);
      const id = row(A).merchant_id;
      assert.equal((await webhook(A, 'app/uninstalled', {}, crypto.randomUUID(), { 'x-shopify-triggered-at': '2020-01-01T00:00:00Z' })).status, 200);
      assert.equal(row(A).merchant_id, id);
      assert.equal((await webhook(A, 'shop/redact')).status, 200); assert.equal(row(A).merchant_id, id);
      await webhook(A, 'app/uninstalled');
      assert.equal((await webhook(A, 'shop/redact')).status, 200); assert.equal(row(A), undefined);
    });
  } finally {
    global.fetch = nativeFetch;
    await new Promise(resolve => server.close(resolve));
    db.close();
    if (path.dirname(dataDir) === os.tmpdir() && path.basename(dataDir).startsWith('shopreply-test-')) fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
