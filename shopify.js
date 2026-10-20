'use strict';

const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { db, randomToken, ensureMonthReset, tierMonthlyCap } = require('./db');
const { generateAnswer, loadFaqs } = require('./llm');
const router = express.Router();
const API_VERSION = '2026-10';
const PLANS = Object.freeze({
  pro_monthly: { name: 'GetShopReply Pro Monthly', amount: 21, interval: 'EVERY_30_DAYS' },
  pro_annual: { name: 'GetShopReply Pro Annual', amount: 205, interval: 'ANNUAL' },
});

db.exec(`
  CREATE TABLE IF NOT EXISTS shopify_shops (
    shop TEXT PRIMARY KEY, merchant_id INTEGER UNIQUE REFERENCES merchants(id) ON DELETE SET NULL,
    shop_gid TEXT, installation_gid TEXT, credentials TEXT,
    installed_at INTEGER NOT NULL, uninstalled_at INTEGER,
    subscription_id TEXT, embed_published INTEGER NOT NULL DEFAULT 0,
    privacy_epoch INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS shopify_webhooks (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS visitor_sessions (
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    session_key TEXT NOT NULL, email TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (merchant_id, session_key)
  );
  CREATE TABLE IF NOT EXISTS shopify_privacy_requests (
    id TEXT PRIMARY KEY, shop TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
  );
`);

function config() {
  const c = {
    client: process.env.SHOPIFY_API_KEY, secret: process.env.SHOPIFY_API_SECRET,
    key: process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY,
    base: require('./runtime-config').publicBaseUrl(),
    test: process.env.SHOPIFY_BILLING_TEST === 'true',
  };
  if (!c.client || !c.secret || !/^[a-f\d]{64}$/i.test(c.key || '') || !/^https:\/\//.test(c.base)) {
    throw Object.assign(new Error('Shopify is not configured'), { status: 503 });
  }
  if (process.env.NODE_ENV === 'production' && c.test) {
    throw Object.assign(new Error('Test billing is disabled in production'), { status: 503 });
  }
  return c;
}
function validShop(shop) { return typeof shop === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop); }
function equal(a, b) { return a.length === b.length && crypto.timingSafeEqual(a, b); }
function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(config().key, 'hex'), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
function unseal(value) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(config().key, 'hex'), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
}
function verifySession(token) {
  const { client, secret } = config();
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    if (header.alg !== 'HS256') throw new Error();
    const sig = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    if (!equal(sig, Buffer.from(parts[2], 'base64url'))) throw new Error();
    const p = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const now = Date.now() / 1000;
    const dest = new URL(p.dest);
    if (!validShop(dest.hostname) || p.dest !== `https://${dest.hostname}` || p.iss !== `${p.dest}/admin` ||
        p.aud !== client || !p.sub || !p.sid || !Number.isFinite(p.exp) || !Number.isFinite(p.nbf) ||
        !Number.isFinite(p.iat) || p.exp <= now || p.nbf > now + 5 || p.iat > now + 5 || p.exp - p.iat > 120) throw new Error();
    return { shop: dest.hostname, issued: p.iat * 1000 };
  } catch (_) { throw Object.assign(new Error('Invalid session token'), { status: 401 }); }
}
function session(req, res, next) {
  try {
    req.idToken = String(req.headers.authorization || '').replace(/^Bearer /, '');
    req.shopifySession = verifySession(req.idToken);
    next();
  } catch (e) {
    if (e.status === 401) res.set('X-Shopify-Retry-Invalid-Session-Request', '1');
    res.status(e.status || 401).json({ error: e.message });
  }
}
const locks = new Map();
async function locked(shop, fn) {
  const prior = locks.get(shop) || Promise.resolve();
  const task = prior.catch(() => {}).then(fn);
  locks.set(shop, task);
  try { return await task; } finally { if (locks.get(shop) === task) locks.delete(shop); }
}
function shopRow(shop) { return db.prepare('SELECT * FROM shopify_shops WHERE shop = ?').get(shop); }
function activeRow(shop) {
  const row = shopRow(shop);
  if (!row?.merchant_id || row.uninstalled_at || !row.credentials) throw Object.assign(new Error('Open the app again to connect this store'), { status: 401 });
  return row;
}
async function postToken(shop, params) {
  const c = config();
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client, client_secret: c.secret, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error('Shopify authentication failed; reopen the app'), { status: [400, 401].includes(r.status) ? 401 : 502 });
  const t = await r.json();
  if (!t.access_token || !t.refresh_token || !(t.expires_in > 0)) throw new Error('Invalid expiring token response');
  return { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000 };
}
async function accessToken(shop) {
  const row = activeRow(shop);
  let t = unseal(row.credentials);
  if (t.expires < Date.now() + 60000) {
    t = await postToken(shop, { grant_type: 'refresh_token', refresh_token: t.refresh });
    db.prepare('UPDATE shopify_shops SET credentials = ? WHERE shop = ? AND uninstalled_at IS NULL').run(seal(t), shop);
  }
  return t.access;
}
async function graphql(shop, query, variables = {}, token) {
  const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token || await accessToken(shop) },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error('Shopify API unavailable'), { status: 502 });
  const result = await r.json();
  if (result.errors || !result.data) throw Object.assign(new Error('Shopify API rejected the request'), { status: 502 });
  return result.data;
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function recognizedTier(sub) {
  if (sub.status !== 'ACTIVE' || (sub.test && !config().test)) return null;
  return Object.entries(PLANS).find(([, p]) => sub.name === p.name && sub.lineItems?.some(l => {
    const d = l.plan?.pricingDetails;
    return d?.interval === p.interval && d.price?.currencyCode === 'USD' && Number(d.price.amount) === p.amount;
  }))?.[0] || null;
}
const SUBSCRIPTIONS = `query Subscriptions { currentAppInstallation { activeSubscriptions {
  id name status test lineItems { plan { pricingDetails { ... on AppRecurringPricing { interval price { amount currencyCode } } } } }
} } }`;
async function syncBilling(shop) {
  const row = activeRow(shop);
  const data = await graphql(shop, SUBSCRIPTIONS);
  const subs = data.currentAppInstallation.activeSubscriptions;
  const paid = subs.find(s => recognizedTier(s));
  // Unknown paid plans are surfaced rather than charged over or silently downgraded.
  if (subs.some(s => s.status === 'ACTIVE' && !recognizedTier(s))) throw Object.assign(new Error('Unrecognized Shopify subscription; contact support'), { status: 409 });
  const tier = paid ? recognizedTier(paid) : 'free';
  transaction(() => {
    db.prepare('UPDATE merchants SET tier = ?, trial_ends_at = NULL WHERE id = ?').run(tier, row.merchant_id);
    db.prepare('UPDATE shopify_shops SET subscription_id = ? WHERE shop = ?').run(paid?.id || null, shop);
  });
  return { tier, subscription_id: paid?.id || null };
}
async function publishEmbed(shop) {
  const row = activeRow(shop);
  const merchant = db.prepare('SELECT api_key FROM merchants WHERE id = ?').get(row.merchant_id);
  const result = await graphql(shop, `mutation PublishWidget($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`, { metafields: [{ ownerId: row.installation_gid, namespace: 'shopreply', key: 'widget', type: 'json',
    value: JSON.stringify({ api_key: merchant.api_key, base_url: config().base }) }] });
  if (result.metafieldsSet.userErrors.length) throw new Error('Could not publish widget settings');
  db.prepare('UPDATE shopify_shops SET embed_published = 1 WHERE shop = ?').run(shop);
}
const safe = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/', (req, res) => {
  try {
    const c = config();
    // Query parameters cannot widen framing to an arbitrary origin.
    const shop = validShop(req.query.shop) ? req.query.shop : null;
    res.set('Content-Security-Policy', `frame-ancestors https://admin.shopify.com${shop ? ` https://${shop}` : ''};`);
    res.type('html').send(fs.readFileSync(path.join(__dirname, 'public/shopify/index.html'), 'utf8')
      .replaceAll('__SHOPIFY_API_KEY__', c.client.replace(/[^a-zA-Z0-9_-]/g, '')));
  } catch (_) { res.status(503).send('Shopify app setup is pending.'); }
});
router.use('/api', session);
router.post('/api/connect', safe(async (req, res) => {
  const { shop, issued } = req.shopifySession;
  await locked(shop, async () => {
    let row = shopRow(shop);
    if (row?.uninstalled_at && issued <= row.uninstalled_at) throw Object.assign(new Error('Session predates uninstall'), { status: 401 });
    // ID-token exchange is also used to recover an expired offline token.
    if (!row?.credentials || unseal(row.credentials).expires < Date.now() + 60000) {
      const t = await postToken(shop, {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: req.idToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token', expiring: '1',
      });
      const data = await graphql(shop, 'query Connect { shop { id name } currentAppInstallation { id } }', {}, t.access);
      transaction(() => {
        row = shopRow(shop);
        let merchantId = row?.merchant_id;
        if (!merchantId) {
          merchantId = Number(db.prepare(`INSERT INTO merchants (email, password_hash, brand_name, api_key)
            VALUES (?, 'SHOPIFY_ONLY', ?, ?)`).run(`${randomToken(16)}@shopify.invalid`, data.shop.name, 'csb_' + randomToken(16)).lastInsertRowid);
        }
        db.prepare(`INSERT INTO shopify_shops (shop, merchant_id, shop_gid, installation_gid, credentials, installed_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(shop) DO UPDATE SET merchant_id=excluded.merchant_id,
          shop_gid=excluded.shop_gid, installation_gid=excluded.installation_gid, credentials=excluded.credentials,
          installed_at=CASE WHEN shopify_shops.uninstalled_at IS NULL THEN shopify_shops.installed_at ELSE excluded.installed_at END,
          uninstalled_at=NULL`).run(shop, merchantId, data.shop.id, data.currentAppInstallation.id, seal(t), issued);
      });
    }
    await publishEmbed(shop);
    await syncBilling(shop);
  });
  res.json({ ok: true });
}));
router.use('/api', (req, res, next) => {
  try { req.shopRow = activeRow(req.shopifySession.shop); next(); } catch (e) { res.status(401).json({ error: e.message }); }
});
router.get('/api/state', safe(async (req, res) => {
  const row = req.shopRow;
  const billing = await locked(row.shop, () => syncBilling(row.shop));
  ensureMonthReset(row.merchant_id);
  const m = db.prepare(`SELECT brand_name, shipping_info, return_policy, extra_info, monthly_convo_count AS used FROM merchants WHERE id = ?`).get(row.merchant_id);
  res.json({ shop: row.shop, merchant: m, faqs: loadFaqs(row.merchant_id), billing,
    cap: tierMonthlyCap(billing.tier), embed_url: `https://${row.shop}/admin/themes/current/editor?context=apps&activateAppId=${config().client}/shopreply-embed`,
    privacy_requests: db.prepare('SELECT id, created_at FROM shopify_privacy_requests WHERE shop = ? ORDER BY created_at DESC').all(row.shop),
    escalations: db.prepare('SELECT id, email, question, resolved, created_at FROM escalations WHERE merchant_id = ? ORDER BY id DESC LIMIT 200').all(row.merchant_id),
  });
}));
router.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const fields = ['brand_name', 'shipping_info', 'return_policy', 'extra_info'];
  if (fields.some(k => typeof b[k] !== 'string' || b[k].length > 16000) || !b.brand_name.trim() || b.brand_name.length > 120 ||
      !Array.isArray(b.faqs) || b.faqs.length > 100 || b.faqs.some(f => typeof f.question !== 'string' || typeof f.answer !== 'string' ||
        !f.question.trim() || !f.answer.trim() || f.question.length > 2000 || f.answer.length > 8000)) return res.status(400).json({ error: 'Invalid settings or FAQs' });
  transaction(() => {
    db.prepare('UPDATE merchants SET brand_name=?, shipping_info=?, return_policy=?, extra_info=? WHERE id=?')
      .run(...fields.map(k => b[k].trim()), req.shopRow.merchant_id);
    db.prepare('DELETE FROM faqs WHERE merchant_id=?').run(req.shopRow.merchant_id);
    b.faqs.forEach((f, i) => db.prepare('INSERT INTO faqs (merchant_id, question, answer, position) VALUES (?, ?, ?, ?)')
      .run(req.shopRow.merchant_id, f.question.trim(), f.answer.trim(), i));
  });
  res.json({ ok: true });
});
router.post('/api/preview', safe(async (req, res) => {
  const message = req.body?.message;
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) return res.status(400).json({ error: 'Enter a question up to 2,000 characters' });
  if (!previewLimit(req.shopRow.shop)) return res.status(429).json({ error: 'Please wait before another preview' });
  const merchant = db.prepare('SELECT * FROM merchants WHERE id=?').get(req.shopRow.merchant_id);
  const result = await generateAnswer({ merchant, faqs: loadFaqs(merchant.id), history: [], visitorMessage: message });
  if (!result.ok && !result.escalate) return res.status(502).json({ error: 'Assistant unavailable. Check your AI provider configuration.' });
  res.json({ reply: result.ok ? result.content : 'This question would be handed to your support team with a request for the visitor’s email.' });
}));
const previews = new Map();
function previewLimit(shop) {
  const now = Date.now();
  let b = previews.get(shop);
  if (!b || b.until < now) { b = { n: 0, until: now + 60000 }; previews.set(shop, b); }
  return ++b.n <= 10;
}
router.post('/api/escalations/:id/resolve', (req, res) => {
  const r = db.prepare('UPDATE escalations SET resolved=1 WHERE merchant_id=? AND id=?').run(req.shopRow.merchant_id, Number(req.params.id));
  res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
});
router.get('/api/conversations', (req, res) => {
  const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
  if (!Number.isSafeInteger(before) || before < 1) return res.status(400).json({ error: 'Invalid conversation cursor' });
  const messages = db.prepare(`SELECT id, session_key, role, content, created_at FROM conversations
    WHERE merchant_id=? AND id < ? ORDER BY id DESC LIMIT 100`).all(req.shopRow.merchant_id, before);
  res.json({ messages, next_before: messages.length === 100 ? messages[messages.length - 1].id : null });
});
router.post('/api/billing', safe(async (req, res) => {
  const plan = PLANS[req.body?.plan];
  if (!plan) return res.status(400).json({ error: 'Choose Pro monthly or annual' });
  const result = await locked(req.shopRow.shop, async () => {
    const current = await syncBilling(req.shopRow.shop);
    if (current.tier === req.body.plan) return { already_active: true };
    const data = await graphql(req.shopRow.shop, `mutation Subscribe($name: String!, $returnUrl: URL!, $test: Boolean!, $lineItems: [AppSubscriptionLineItemInput!]!) {
      appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, replacementBehavior: APPLY_IMMEDIATELY, lineItems: $lineItems) {
        confirmationUrl userErrors { field message }
      }
    }`, { name: plan.name, returnUrl: `${config().base}/shopify?shop=${req.shopRow.shop}`, test: config().test,
      lineItems: [{ plan: { appRecurringPricingDetails: { price: { amount: plan.amount, currencyCode: 'USD' }, interval: plan.interval } } }] });
    const p = data.appSubscriptionCreate;
    if (p.userErrors.length) throw Object.assign(new Error('Shopify could not create this subscription'), { status: 409 });
    const u = new URL(p.confirmationUrl);
    if (u.protocol !== 'https:' || ![req.shopRow.shop, 'admin.shopify.com'].includes(u.hostname)) throw new Error('Invalid confirmation URL');
    return { confirmation_url: u.href };
  });
  res.json(result);
}));
router.post('/api/billing/cancel', safe(async (req, res) => {
  if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Confirm cancellation first' });
  await locked(req.shopRow.shop, async () => {
    const current = await syncBilling(req.shopRow.shop);
    if (current.subscription_id) {
      const d = await graphql(req.shopRow.shop, `mutation Cancel($id: ID!) { appSubscriptionCancel(id: $id, prorate: true) { userErrors { field message } } }`, { id: current.subscription_id });
      if (d.appSubscriptionCancel.userErrors.length) throw new Error('Shopify could not cancel this subscription');
    }
    await syncBilling(req.shopRow.shop);
  });
  res.json({ ok: true });
}));
router.get('/api/privacy/:id', (req, res) => {
  const row = db.prepare('SELECT payload FROM shopify_privacy_requests WHERE id=? AND shop=?').get(req.params.id, req.shopRow.shop);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(unseal(row.payload));
});
router.delete('/api/privacy/:id', (req, res) => {
  db.prepare('DELETE FROM shopify_privacy_requests WHERE id=? AND shop=?').run(req.params.id, req.shopRow.shop);
  res.json({ ok: true });
});

function isShopifyMerchant(id) { return !!db.prepare('SELECT 1 FROM shopify_shops WHERE merchant_id=?').get(id); }
function privacyEpoch(id) { return db.prepare('SELECT privacy_epoch FROM shopify_shops WHERE merchant_id=?').get(id)?.privacy_epoch ?? null; }
function rememberVisitor(merchantId, sessionKey, email) {
  if (!isShopifyMerchant(merchantId)) return;
  db.prepare(`INSERT INTO visitor_sessions VALUES (?, ?, ?, ?) ON CONFLICT(merchant_id,session_key)
    DO UPDATE SET email=excluded.email, updated_at=excluded.updated_at`).run(merchantId, sessionKey, email, Date.now());
}
function storefrontCors(req, res, next) {
  const origin = req.headers.origin;
  // Widget uses a public, revocable store identifier, never an Admin API token.
  // No credentials/cookies are accepted by this API; allow custom store domains.
  if (origin) res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-API-Key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
function privacyExport(row, email) {
  const sessions = email ? db.prepare('SELECT session_key FROM visitor_sessions WHERE merchant_id=? AND email=?').all(row.merchant_id, email) : [];
  return { email: email || null,
    escalations: email ? db.prepare('SELECT email, question, created_at FROM escalations WHERE merchant_id=? AND lower(email)=?').all(row.merchant_id, email) : [],
    conversations: sessions.flatMap(s => db.prepare('SELECT role, content, created_at FROM conversations WHERE merchant_id=? AND session_key=?').all(row.merchant_id, s.session_key)),
    note: 'Anonymous chats cannot be matched without a captured email. Verify the requester before delivering this export.',
  };
}
router.post('/webhooks', safe(async (req, res) => {
  const c = config();
  const expected = crypto.createHmac('sha256', c.secret).update(req.rawBody || Buffer.alloc(0)).digest();
  if (!req.rawBody || !equal(expected, Buffer.from(String(req.headers['x-shopify-hmac-sha256'] || ''), 'base64'))) return res.sendStatus(401);
  const shop = req.headers['x-shopify-shop-domain'];
  const id = req.headers['x-shopify-webhook-id'];
  const topic = req.headers['x-shopify-topic'];
  const topics = ['app/uninstalled', 'app_subscriptions/update', 'customers/data_request', 'customers/redact', 'shop/redact'];
  if (!validShop(shop) || typeof id !== 'string' || id.length > 200 || !topics.includes(topic)) return res.sendStatus(400);
  await locked(shop, async () => {
    if (db.prepare('SELECT 1 FROM shopify_webhooks WHERE id=?').get(id)) return;
    const row = shopRow(shop);
    // HMAC signs the body, not HTTP headers. Bind any body shop identity as well.
    const bodyShop = req.body?.shop_domain || req.body?.myshopify_domain;
    const bodyId = req.body?.shop_id || (topic === 'app/uninstalled' ? req.body?.id : null);
    const bodyGid = req.body?.app_subscription?.admin_graphql_api_shop_id;
    if ((bodyShop && bodyShop !== shop) || (row && bodyId && row.shop_gid !== `gid://shopify/Shop/${bodyId}`) ||
        (row && bodyGid && row.shop_gid !== bodyGid)) throw Object.assign(new Error('Webhook shop mismatch'), { status: 400 });
    if (row?.merchant_id && !row.uninstalled_at && topic === 'app_subscriptions/update') await syncBilling(shop);
    transaction(() => {
      if (row && topic === 'app/uninstalled') {
        const triggered = Date.parse(req.headers['x-shopify-triggered-at']);
        if (!Number.isFinite(triggered)) throw Object.assign(new Error('Missing webhook timestamp'), { status: 400 });
        if (triggered >= row.installed_at) {
          db.prepare('DELETE FROM merchants WHERE id=?').run(row.merchant_id);
          db.prepare('DELETE FROM shopify_privacy_requests WHERE shop=?').run(shop);
          db.prepare(`UPDATE shopify_shops SET credentials=NULL, subscription_id=NULL, uninstalled_at=?, embed_published=0 WHERE shop=?`).run(triggered, shop);
        }
      }
      if (topic === 'shop/redact' && (!row || row.uninstalled_at)) {
        db.prepare('DELETE FROM shopify_privacy_requests WHERE shop=?').run(shop);
        db.prepare('DELETE FROM shopify_shops WHERE shop=?').run(shop);
      }
      const email = typeof req.body?.customer?.email === 'string' ? req.body.customer.email.trim().toLowerCase() : '';
      if (topic === 'customers/data_request') {
        const exported = row?.merchant_id ? privacyExport(row, email) : { email: email || null, escalations: [], conversations: [] };
        db.prepare('INSERT INTO shopify_privacy_requests VALUES (?, ?, ?, ?)').run(id, shop, seal(exported), Date.now());
      }
      if (topic === 'customers/redact') {
        db.prepare('UPDATE shopify_shops SET privacy_epoch=privacy_epoch+1 WHERE shop=?').run(shop);
        // Previous encrypted exports may contain this visitor; purge all for the shop.
        db.prepare('DELETE FROM shopify_privacy_requests WHERE shop=?').run(shop);
        if (row?.merchant_id) {
          // Conservative erasure also covers anonymous messages with no reliable identity.
          db.prepare('DELETE FROM conversations WHERE merchant_id=?').run(row.merchant_id);
          if (email) {
            db.prepare('DELETE FROM escalations WHERE merchant_id=? AND lower(email)=?').run(row.merchant_id, email);
            db.prepare('DELETE FROM visitor_sessions WHERE merchant_id=? AND email=?').run(row.merchant_id, email);
          } else {
            db.prepare('DELETE FROM escalations WHERE merchant_id=?').run(row.merchant_id);
            db.prepare('DELETE FROM visitor_sessions WHERE merchant_id=?').run(row.merchant_id);
          }
        }
      }
      db.prepare('INSERT INTO shopify_webhooks VALUES (?, ?)').run(id, Date.now());
    });
  });
  res.sendStatus(200);
}));
function purgeExpired() {
  const cutoff = Date.now() - 90 * 86400000;
  transaction(() => {
    for (const table of ['conversations', 'escalations']) db.prepare(`DELETE FROM ${table} WHERE merchant_id IN
      (SELECT merchant_id FROM shopify_shops WHERE merchant_id IS NOT NULL) AND created_at < datetime(?, 'unixepoch')`).run(cutoff / 1000);
    db.prepare('DELETE FROM visitor_sessions WHERE updated_at < ?').run(cutoff);
    db.prepare('DELETE FROM shopify_privacy_requests WHERE created_at < ?').run(Date.now() - 30 * 86400000);
    db.prepare('DELETE FROM shopify_webhooks WHERE received_at < ?').run(cutoff);
  });
}
router.use((err, _req, res, _next) => {
  if (err.status === 401) res.set('X-Shopify-Retry-Invalid-Session-Request', '1');
  res.status(err.status || 502).json({ error: err.status ? err.message : 'Shopify request failed. Please try again.' });
});
module.exports = { router, verifySession, seal, unseal, isShopifyMerchant, privacyEpoch, rememberVisitor, storefrontCors, purgeExpired, PLANS };
