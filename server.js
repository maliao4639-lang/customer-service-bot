'use strict';

require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

const {
  db,
  randomToken,
  tryConsumeConvo,
  refundConvo,
  tierMonthlyCap,
  getLifetimeAvailability,
  tryReserveLifetime,
  startProTrial,
  expireTrials,
  getTrialStatus,
  TRIAL_DAYS,
  isWebhookEventProcessed,
  recordWebhookEvent,
} = require('./db');
const { generateAnswer, loadFaqs } = require('./llm');

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && SESSION_SECRET.length < 32) {
  throw new Error('Production SESSION_SECRET must contain at least 32 characters');
}
const PUBLIC_BASE_URL = require('./runtime-config').publicBaseUrl();

// ---- Pricing tiers (2026-09-23 update: B-option Lifetime 3-tier) ----------
// Display only; billing is not yet wired up. Mirrors the table in
// AI客服推广话术.md and DM操作清单.md so docs and code stay in sync.
//
// Changes (vs 2026-09-22 baseline):
//   - Pro monthly:    ¥99  -> ¥149 (+50%)
//   - Pro annual:     ¥949 -> ¥1439 (≈9.6 折, was 8 折)
//   - Growth monthly: ¥299 -> ¥399 (+33%)
//   - Growth annual:  ¥2999-> ¥3839 (≈9.6 折)
//   - Free unchanged (entry point stays open)
//   - Lifetime split into 3 tiers (B-option: 200 total slots):
//       L1: ¥2499, 1000 对话/月,  限量 120 个
//       L2: ¥4999, 2000 对话/月,  限量  60 个
//       L3: ¥9999, 5000 对话/月,  限量  20 个
//     Total Lifetime revenue potential: ¥799,800
//     Total Lifetime LLM cost over 5 yr: ~¥360,000
//     Total Lifetime profit over 5 yr:  ~¥440,000
const PRICING = {
  free: {
    name: 'Free',
    price_cny: 0,
    price_usd: 0,
    monthly_conversations: 100,
    note: '永久免费',
  },
  pro_monthly: {
    name: 'Pro 月付',
    price_cny: 149,
    price_usd: 21,
    monthly_conversations: 500,
    note: '小品牌主推档',
  },
  pro_annual: {
    name: 'Pro 年付',
    price_cny: 1439,
    price_usd: 205,
    monthly_conversations: 500,
    note: '9.6 折（约 ¥120/月）',
  },
  growth_monthly: {
    name: 'Growth 月付',
    price_cny: 399,
    price_usd: 56,
    monthly_conversations: 2000,
    note: '中型商家',
  },
  growth_annual: {
    name: 'Growth 年付',
    price_cny: 3839,
    price_usd: 540,
    monthly_conversations: 2000,
    note: '9.6 折（约 ¥320/月）',
  },
  lifetime_1: {
    name: 'Lifetime 1',
    price_cny: 2499,
    price_usd: 350,
    monthly_conversations: 1000,
    limit_total: 120,
    note: '一次性付费，约 17 个月 Pro',
  },
  lifetime_2: {
    name: 'Lifetime 2',
    price_cny: 4999,
    price_usd: 700,
    monthly_conversations: 2000,
    limit_total: 60,
    note: '一次性付费，约 33 个月 Pro',
  },
  lifetime_3: {
    name: 'Lifetime 3',
    price_cny: 9999,
    price_usd: 1400,
    monthly_conversations: 5000,
    limit_total: 20,
    note: '一次性付费，约 67 个月 Pro',
  },
};

const app = express();
app.disable('x-powered-by');
require('./public-guards')(app, PUBLIC_BASE_URL);
app.use(express.json({
  limit: '64kb',
  // Preserve the raw body so the Stripe webhook handler can verify the
  // signature against the original bytes (req.body is the parsed object).
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use((error, req, res, next) => {
  if (/^\/api\/order-lookup(?:\/|$)/i.test(req.path)) {
    return res.status(400).set('Cache-Control', 'no-store').json({ error: 'Invalid order lookup request.' });
  }
  next(error);
});
app.use(cookieParser(SESSION_SECRET));
// Shopify ownership is established independently from standalone login/billing.
const shopify = require('./shopify');
require('./order-lookup/bootstrap').mountPilot(app, key => {
  const merchant = lookupMerchantByApiKey(key);
  return merchant && !shopify.isShopifyMerchant(merchant.id) ? merchant : null;
});
const paddleBilling = require('./paddle').createPaddle({db, isShopifyMerchant: shopify.isShopifyMerchant});
paddleBilling.mount(app, requireAuth);
app.use((_req, _res, next) => { paddleBilling.refreshAll(); next(); });
app.get('/billing/paddle', requireAuth, (req, res) => {
  if (shopify.isShopifyMerchant(req.merchant.id)) return res.status(409).json({error:'use_shopify_billing'});
  res.sendFile(path.join(__dirname, 'public', 'paddle.html'));
});


// Shopify APIs authenticate with App Bridge ID tokens, independently of cookies.
// CLI appends the toml uri (/webhooks) to application_url (.../shopify), which
// is this mount. A dev tunnel whose origin has no /shopify path posts to /webhooks.
app.post('/webhooks', (req, res, next) => { req.url = '/webhooks'; shopify.router(req, res, next); });
app.use('/shopify', shopify.router);
app.use('/api/chat', shopify.storefrontCors);

// ---- Signed session cookie helpers ----------------------------------------

const cookieSignature = require('cookie-signature');

function makeSessionCookie(merchantId) {
  // cookie-signature expects a string payload and a secret.
  // The output is `payload.signature`, where signature is base64(HMAC-SHA256(payload)).
  const payload = `m:${merchantId}.${Date.now() + 30 * 24 * 60 * 60 * 1000}.${randomToken(12)}`;
  return cookieSignature.sign(payload, SESSION_SECRET);
}

function readSession(req) {
  const raw = req.signedCookies?.session;
  if (!raw) return null;
  // cookie-parser puts the unsigned value on req.signedCookies when verification passes.
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('m:')) return null;
  const parts = raw.slice(2).split('.');
  if (parts.length !== 4 || !Number.isFinite(Number(parts[1])) || Number(parts[1]) <= Date.now()) return null;
  const merchantId = Number(parts[0]);
  if (!Number.isInteger(merchantId)) return null;
  return merchantId;
}

function requireAuth(req, res, next) {
  const merchantId = readSession(req);
  if (!merchantId) return res.status(401).json({ error: 'Not logged in' });
  const merchant = db
    .prepare('SELECT id, email, brand_name, return_policy, shipping_info, extra_info, tier FROM merchants WHERE id = ?')
    .get(merchantId);
  if (!merchant) return res.status(401).json({ error: 'Account no longer exists' });
  req.merchant = merchant;
  next();
}

// ---- Per-merchant + IP rate limit for chat ---------------------------------
// Cheap in-memory sliding window. Resets on process restart; that's fine for
// abuse deterrence (a single attacker doesn't persist across restarts).
// Key: <merchantId>|<sessionKey>  →  minute and hour buckets.
const chatMinuteBuckets = new Map(); // key → { count, resetAt }
const chatHourBuckets = new Map();
const rateCleanup = setInterval(() => {
  for (const map of [chatMinuteBuckets, chatHourBuckets]) {
    for (const [key, entry] of map) if (entry.resetAt <= Date.now()) map.delete(key);
  }
}, 60000);
rateCleanup.unref();

function consumeToken(map, key, windowMs, max) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || entry.resetAt <= now) {
    if (map.size >= 10000 && !map.has(key)) return {ok:false, remaining:0, resetInMs:windowMs};
    map.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1, resetInMs: windowMs };
  }
  if (entry.count >= max) {
    return { ok: false, remaining: 0, resetInMs: entry.resetAt - now };
  }
  entry.count += 1;
  return { ok: true, remaining: max - entry.count, resetInMs: entry.resetAt - now };
}

// Visitor chat is rate-limited per (merchant, session, ip) to deter scripted
// abuse before monthly caps even matter.
function chatRateLimit(req, res, next) {
  const ip = req.ip;
  const merchant = lookupMerchantByApiKey(String(req.headers['x-api-key'] || req.body?.api_key || '').trim());
  if (!merchant) return res.status(401).json({error:'Invalid API key'});
  const merchantId = merchant.id;
  const sessionKey = String(req.body?.session_key || 'anon').slice(0, 64);
  // Per session per minute: 30 messages (visitor burst).
  const m1 = consumeToken(chatMinuteBuckets, `${merchantId}|${sessionKey}`, 60_000, 30);
  if (!m1.ok) return res.status(429).json({ error: 'Too many messages, please slow down.', retry_in_ms: m1.resetInMs });
  // Per IP per hour: 500 messages across all merchants (script flood guard).
  const h1 = consumeToken(chatHourBuckets, ip || 'unknown', 60 * 60_000, 500);
  if (!h1.ok) return res.status(429).json({ error: 'Hourly limit reached for this network.', retry_in_ms: h1.resetInMs });
  next();
}

app.get('/healthz', (_req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ok:true}); }
  catch { res.status(503).json({ok:false}); }
});

// ---- Static files ----------------------------------------------------------

app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use('/static', express.static(path.join(__dirname, 'public', 'static')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'privacy.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', 'terms.html')));

// Public widget loader (the one snippet merchants paste)
app.get('/embed.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'widget', 'embed.js'));
});

// ---- Public auth (signup / login) ------------------------------------------

app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const brandName = String(req.body?.brand_name || '').trim().slice(0, 120);
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

  const existing = db.prepare('SELECT id FROM merchants WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const hash = await bcrypt.hash(password, 10);
  const apiKey = 'csb_' + randomToken(16);
  const fallbackBrand = email.split('@')[0] || 'My Store';
  const info = db
    .prepare(
      `INSERT INTO merchants (email, password_hash, brand_name, api_key)
       VALUES (?, ?, ?, ?)`
    )
    .run(email, hash, brandName || fallbackBrand, apiKey);

  res.cookie('session', makeSessionCookie(info.lastInsertRowid), {
    httpOnly: true,
    secure: PUBLIC_BASE_URL.startsWith('https://'),
    sameSite: 'lax',
    signed: true,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  res.json({ ok: true });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const row = db.prepare('SELECT id, password_hash FROM merchants WHERE email = ?').get(email);
  if (!row) return res.status(401).json({ error: 'Wrong email or password' });
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Wrong email or password' });

  res.cookie('session', makeSessionCookie(row.id), {
    httpOnly: true,
    secure: PUBLIC_BASE_URL.startsWith('https://'),
    sameSite: 'lax',
    signed: true,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

// ---- Admin (authenticated) -------------------------------------------------

app.get('/api/admin/me', requireAuth, (req, res) => {
  res.json({ merchant: req.merchant, apiKey: db.prepare('SELECT api_key FROM merchants WHERE id = ?').get(req.merchant.id).api_key });
});

app.put('/api/admin/store', requireAuth, (req, res) => {
  const brand = String(req.body?.brand_name ?? '').trim().slice(0, 120);
  const ret = String(req.body?.return_policy ?? '');
  const ship = String(req.body?.shipping_info ?? '');
  const extra = String(req.body?.extra_info ?? '');
  if (!brand) return res.status(400).json({ error: 'Brand name is required' });
  db.prepare(
    `UPDATE merchants
        SET brand_name = ?, return_policy = ?, shipping_info = ?, extra_info = ?
      WHERE id = ?`
  ).run(brand, ret, ship, extra, req.merchant.id);
  res.json({ ok: true });
});

app.get('/api/admin/faqs', requireAuth, (req, res) => {
  res.json({ faqs: loadFaqs(req.merchant.id) });
});

app.post('/api/admin/faqs', requireAuth, (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  const answer = String(req.body?.answer ?? '').trim();
  if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required' });
  const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM faqs WHERE merchant_id = ?').get(req.merchant.id).m;
  const info = db
    .prepare('INSERT INTO faqs (merchant_id, question, answer, position) VALUES (?, ?, ?, ?)')
    .run(req.merchant.id, question, answer, max + 1);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/admin/faqs/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const question = String(req.body?.question ?? '').trim();
  const answer = String(req.body?.answer ?? '').trim();
  if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required' });
  const result = db
    .prepare('UPDATE faqs SET question = ?, answer = ? WHERE id = ? AND merchant_id = ?')
    .run(question, answer, id, req.merchant.id);
  if (result.changes === 0) return res.status(404).json({ error: 'FAQ not found' });
  res.json({ ok: true });
});

app.delete('/api/admin/faqs/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM faqs WHERE id = ? AND merchant_id = ?').run(id, req.merchant.id);
  if (result.changes === 0) return res.status(404).json({ error: 'FAQ not found' });
  res.json({ ok: true });
});

app.get('/api/admin/escalations', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, email, question, resolved, created_at FROM escalations WHERE merchant_id = ? ORDER BY id DESC LIMIT 200')
    .all(req.merchant.id);
  res.json({ escalations: rows });
});

app.post('/api/admin/escalations/:id/resolve', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('UPDATE escalations SET resolved = 1 WHERE id = ? AND merchant_id = ?').run(id, req.merchant.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.get('/api/admin/embed-snippet', requireAuth, (req, res) => {
  const apiKey = db.prepare('SELECT api_key FROM merchants WHERE id = ?').get(req.merchant.id).api_key;
  const snippet = `<script src="${PUBLIC_BASE_URL}/embed.js" data-api-key="${apiKey}" defer></script>`;
  res.json({ snippet });
});

// ---- Visitor chat API (key-authenticated, no login required) ---------------

function lookupMerchantByApiKey(apiKey) {
  if (!apiKey) return null;
  return db
    .prepare(
      'SELECT id, brand_name, return_policy, shipping_info, extra_info FROM merchants WHERE api_key = ?'
    )
    .get(apiKey);
}

app.post('/api/chat', chatRateLimit, async (req, res) => {
  const apiKey = String(req.headers['x-api-key'] || req.body?.api_key || '').trim();
  const merchant = lookupMerchantByApiKey(apiKey);
  if (!merchant) return res.status(401).json({ error: 'Invalid API key' });
  const privacyEpoch = shopify.privacyEpoch(merchant.id);

  const message = String(req.body?.message ?? '').trim();
  const email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
  const sessionKey = String(req.body?.session_key ?? '').slice(0, 64) || randomToken(12);

  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (message.length > 2000) return res.status(400).json({ error: 'Message too long' });

  // ---- Hard limit: enforce monthly conversation cap (anti-abuse) ----------
  // Consume a slot up-front; if the LLM call fails after this, we refund so the
  // cap stays honest. Returning 402 (Payment Required) signals the visitor-side
  // widget to surface an upgrade prompt instead of looping forever.
  const consume = tryConsumeConvo(merchant.id);
  if (!consume.ok) {
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      db.prepare('INSERT INTO escalations (merchant_id, email, question) VALUES (?, ?, ?)').run(merchant.id,email,message);
      shopify.rememberVisitor(merchant.id, sessionKey, email);
      return res.json({reply:'Your question has been saved for the store team to review.',escalated:true,session_key:sessionKey});
    }
    return res.status(402).json({
      error: 'monthly_cap_reached',
      used: consume.used,
      cap: consume.cap,
      ...(shopify.isShopifyMerchant(merchant.id) ? {} : {upgrade_url: process.env.CSB_FREE_ONLY === '1' ? null : `${PUBLIC_BASE_URL}/pricing`}),
    });
  }

  // Save visitor turn first
  db.prepare(
    `INSERT INTO conversations (merchant_id, session_key, role, content) VALUES (?, ?, 'user', ?)`
  ).run(merchant.id, sessionKey, message);

  const history = db
    .prepare(
      `SELECT role, content FROM conversations
        WHERE merchant_id = ? AND session_key = ?
        ORDER BY id DESC LIMIT 11`
    )
    .all(merchant.id, sessionKey).reverse().slice(0, -1);

  const faqs = loadFaqs(merchant.id);
  let result;
  try {
    result = await generateAnswer({ merchant, faqs, history, visitorMessage: message });
  } catch (err) {
    // LLM call threw — refund the slot so a transient outage doesn't burn quota.
    refundConvo(merchant.id);
    if (process.env.CSB_DEBUG_LLM === '1') {
      process.stderr.write(`[chat] LLM exception: ${err?.message || err}\n`);
    }
    return res.status(502).json({ error: 'Our assistant is having trouble right now. Please try again in a moment.' });
  }
  // An uninstall/redaction may have arrived while the AI provider was replying.
  if (!db.prepare('SELECT 1 FROM merchants WHERE id=?').get(merchant.id)) return res.status(401).json({ error: 'Store disconnected' });
  if (shopify.privacyEpoch(merchant.id) !== privacyEpoch) {
    refundConvo(merchant.id);
    return res.status(409).json({ error: 'Conversation was cleared. Please start a new question.' });
  }
  // If we got back but the LLM returned ok:false (network/parse error), still refund.
  if (!result.ok && !result.escalate) {
    refundConvo(merchant.id);
  }

  if (result.ok) {
    db.prepare(
      `INSERT INTO conversations (merchant_id, session_key, role, content) VALUES (?, ?, 'assistant', ?)`
    ).run(merchant.id, sessionKey, result.content);
    return res.json({ reply: result.content, escalated: false, session_key: sessionKey });
  }

  if (result.escalate) {
    refundConvo(merchant.id);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.json({
        reply:
          "I’m not sure I can answer that one. Could you share your email so our support team can follow up with you?",
        needs_email: true,
        escalated: false,
        session_key: sessionKey,
      });
    }

    db.prepare(
      `INSERT INTO escalations (merchant_id, email, question) VALUES (?, ?, ?)`
    ).run(merchant.id, email, message);
    shopify.rememberVisitor(merchant.id, sessionKey, email);

    db.prepare(
      `INSERT INTO conversations (merchant_id, session_key, role, content) VALUES (?, ?, 'assistant', ?)`
    ).run(
      merchant.id,
      sessionKey,
      'Thanks! I’ve logged your question and our support team will get back to you by email shortly.'
    );

    return res.json({
      reply:
        "Thanks! I’ve logged your question and our support team will get back to you by email shortly.",
      escalated: true,
      session_key: sessionKey,
    });
  }

  // LLM hard error (refunded above). Log only when debug flag is set.
  if (process.env.CSB_DEBUG_LLM === '1') {
    process.stderr.write(`[chat] LLM error: ${result.error}\n`);
  }
  res.status(502).json({ error: 'Our assistant is having trouble right now. Please try again in a moment.' });
});

// Human handoff must remain available without an AI reply allowance.
app.post('/api/chat/handoff', chatRateLimit, (req, res) => {
  const merchant = lookupMerchantByApiKey(String(req.headers['x-api-key'] || '').trim());
  if (!merchant) return res.status(401).json({ error: 'Invalid API key' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const question = String(req.body?.message || '').trim();
  const sessionKey = String(req.body?.session_key || '').slice(0, 64);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254 || !question || question.length > 2000 || !sessionKey) {
    return res.status(400).json({ error: 'A question, session and valid email are required' });
  }
  db.prepare('INSERT INTO escalations (merchant_id, email, question) VALUES (?, ?, ?)').run(merchant.id, email, question);
  shopify.rememberVisitor(merchant.id, sessionKey, email);
  res.json({ reply: 'Thanks! Your question has been saved for the store’s support team.', escalated: true });
});

// ---- Admin: lifetime slot visibility ---------------------------------------
// Owners see how many Lifetime slots are left across the 3 tiers. Public-read
// counts (no PII) so the landing page could surface "X of 200 Lifetime spots
// remaining" later without leaking merchant identities.
app.get('/api/admin/lifetime-availability', requireAuth, (_req, res) => {
  res.json({ slots: getLifetimeAvailability() });
});

// ---- Admin: usage snapshot (so merchant sees their own remaining quota) ----
app.get('/api/admin/usage', requireAuth, (req, res) => {
  const m = db
    .prepare('SELECT tier, monthly_convo_count AS used, convo_count_reset_at AS reset_at, trial_ends_at, has_used_trial FROM merchants WHERE id = ?')
    .get(req.merchant.id);
  let daysLeft = null;
  if (m?.trial_ends_at) {
    const end = new Date(m.trial_ends_at + 'T00:00:00Z').getTime();
    const now = Date.now();
    daysLeft = Math.max(0, Math.ceil((end - now) / (24 * 60 * 60 * 1000)));
  }
  res.json({
    billing_enabled: process.env.CSB_FREE_ONLY !== '1',
    billing_provider: paddleBilling.enabled ? 'paddle' : null,
    tier: m?.tier || 'free',
    used: m?.used || 0,
    cap: tierMonthlyCap(m?.tier || 'free'),
    reset_at: m?.reset_at || null,
    trial_ends_at: m?.trial_ends_at || null,
    trial_days_left: daysLeft,
    has_used_trial: !!m?.has_used_trial,
  });
});

// Returns the first merchant's API key for the local demo page so it can
// auto-load the widget without anyone logging in. Refuse path: not safe
// in production — it's fine because this is gated by the merchant count,
// not exposed by default. We only enable it when CSB_ENABLE_DEMO_KEY=1.
app.get('/api/demo/key', (_req, res) => {
  if (process.env.CSB_ENABLE_DEMO_KEY !== '1') {
    return res.status(404).json({ error: 'demo key disabled' });
  }
  const m = db.prepare('SELECT api_key, brand_name FROM merchants ORDER BY id ASC LIMIT 1').get();
  if (!m) return res.status(404).json({ error: 'no merchant yet — run `npm run seed`' });
  res.json({ api_key: m.api_key, brand_name: m.brand_name });
});

// ---- Demo page so merchants can preview the widget ------------------------

app.get('/', (_req, res) => {
  // app dev can open the tunnel root even when production uses /shopify.
  if (typeof _req.query.shop === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(_req.query.shop)) {
    const params = new URLSearchParams();
    for (const key of ['shop', 'host', 'embedded']) if (typeof _req.query[key] === 'string') params.set(key, _req.query[key]);
    return res.redirect(`/shopify?${params}`);
  }
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// ---- Public landing / pricing page ----------------------------------------
// Static HTML that fetches /api/pricing and /api/lifetime-availability at
// load time so the Lifetime "X of Y left" pills stay honest.
app.get('/pricing', (_req, res) => {
  // Public planned prices remain visible while paid checkout is disabled.
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

// ---- Public signup page ----------------------------------------------------
// Form posts to /api/auth/signup; server sets the session cookie on success,
// then the page redirects to /admin.
app.get('/signup', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// ---- Public pricing endpoint (no auth) -----------------------------------
// Landing pages and sales replies link to /pricing for a single source of truth.
app.get('/api/pricing', (_req, res) => {
  res.json({ tiers: process.env.CSB_FREE_ONLY === '1' ? {free:PRICING.free} : (paddleBilling.enabled ? {free:PRICING.free,pro_monthly:PRICING.pro_monthly,pro_annual:PRICING.pro_annual} : PRICING), currency: 'CNY/USD', as_of: '2026-09-23' });
});

// ---- Public lifetime availability (no auth) -------------------------------
// Counts only — no merchant identities. Safe to embed in the public landing page
// to add scarcity ("X of 200 Lifetime spots left") without leaking who paid.
app.get('/api/lifetime-availability', (_req, res) => {
  const slots = getLifetimeAvailability().map((s) => ({
    tier_key: s.tier_key,
    limit_total: s.limit_total,
    remaining: s.remaining,
  }));
  res.json({ slots });
});

// ---- Billing (Stripe + mock fallback) -------------------------------------
// Two paths converge on applyUpgrade():
//   1) POST /api/billing/checkout    real Stripe Checkout Session → user pays
//      on Stripe-hosted page → Stripe POSTs webhook → /api/billing/webhook
//      → applyUpgrade (needs STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET).
//   2) POST /api/billing/upgrade-mock immediate local upgrade for demos
//      (no Stripe round-trip; always enabled for testing).
//
// Price keys map to (Stripe price id, internal tier key, lifetime slot key).
// Anything not listed is rejected.

const PRICE_CATALOG = {
  pro_monthly:    { stripe_price_env: 'STRIPE_PRICE_PRO_MONTHLY',    tier: 'pro_monthly',    lifetime: null },
  pro_annual:     { stripe_price_env: 'STRIPE_PRICE_PRO_ANNUAL',     tier: 'pro_annual',     lifetime: null },
  growth_monthly: { stripe_price_env: 'STRIPE_PRICE_GROWTH_MONTHLY', tier: 'growth_monthly', lifetime: null },
  growth_annual:  { stripe_price_env: 'STRIPE_PRICE_GROWTH_ANNUAL',  tier: 'growth_annual',  lifetime: null },
  lifetime_1:     { stripe_price_env: 'STRIPE_PRICE_LIFETIME_1',     tier: 'lifetime_1',     lifetime: 'lifetime_1' },
  lifetime_2:     { stripe_price_env: 'STRIPE_PRICE_LIFETIME_2',     tier: 'lifetime_2',     lifetime: 'lifetime_2' },
  lifetime_3:     { stripe_price_env: 'STRIPE_PRICE_LIFETIME_3',     tier: 'lifetime_3',     lifetime: 'lifetime_3' },
};

const TIER_LABEL = {
  pro_monthly: 'Pro Monthly', pro_annual: 'Pro Annual',
  growth_monthly: 'Growth Monthly', growth_annual: 'Growth Annual',
  lifetime_1: 'Lifetime 1', lifetime_2: 'Lifetime 2', lifetime_3: 'Lifetime 3',
};

// Used to decide whether an upgrade is a real tier change (worth reserving a
// Lifetime slot) or a no-op (merchant already at or above this tier).
const TIER_RANK = {
  free: 0, pro_monthly: 1, pro_annual: 2,
  growth_monthly: 3, growth_annual: 4,
  lifetime_1: 5, lifetime_2: 6, lifetime_3: 7,
};

function getStripePriceId(priceKey) {
  const envName = PRICE_CATALOG[priceKey]?.stripe_price_env;
  return envName ? (process.env[envName] || null) : null;
}

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;

// Core upgrade logic shared by mock + real paths. Idempotent: if the merchant
// already has a higher tier, we still update (allows downgrade-free upgrades
// from monthly → annual; doesn't overwrite a higher Lifetime tier).
// Returns { ok, tier, lifetime_remaining }.
function applyUpgrade(merchantId, priceKey) {
  if (shopify.isShopifyMerchant(merchantId)) return { ok: false, error: 'use_shopify_billing' };
  const entry = PRICE_CATALOG[priceKey];
  if (!entry) return { ok: false, error: 'unknown_price_key' };

  const current = db.prepare('SELECT tier FROM merchants WHERE id = ?').get(merchantId);
  if (!current) return { ok: false, error: 'merchant_not_found' };
  const currentTier = current.tier;
  const currentRank = TIER_RANK[currentTier] ?? 0;
  const newRank = TIER_RANK[entry.tier] ?? 0;

  // If the merchant is already at this tier or higher, no-op. Returning ok
  // keeps webhook idempotent (Stripe sends the same event on retries).
  if (currentRank >= newRank) {
    db.prepare('UPDATE merchants SET trial_ends_at = NULL WHERE id = ?').run(merchantId);
    return { ok: true, tier: currentTier, lifetime_remaining: null, no_op: true };
  }

  // Lifetime slots are scarce: reserve before committing the tier change so a
  // sold-out tier never silently upgrades a merchant to a "dead" tier.
  let lifetimeRemaining = null;
  if (entry.lifetime) {
    const slot = tryReserveLifetime(entry.lifetime);
    if (!slot.ok) {
      return { ok: false, error: 'lifetime_sold_out', tier_key: entry.lifetime };
    }
    lifetimeRemaining = slot.remaining;
  }

  // Reset monthly counter on upgrade so a fresh tier starts fresh.
  db.prepare(
      `UPDATE merchants
          SET tier = ?,
              trial_ends_at = NULL,
              monthly_convo_count = 0,
              convo_count_reset_at = date('now')
        WHERE id = ?`
    ).run(entry.tier, merchantId);

  return { ok: true, tier: entry.tier, lifetime_remaining: lifetimeRemaining };
}

// 1) Real Stripe Checkout (only when keys are configured).
app.post('/api/billing/checkout', requireAuth, async (req, res) => {
  if (shopify.isShopifyMerchant(req.merchant.id)) return res.status(409).json({ error: 'use_shopify_billing' });
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'stripe_not_configured' });
  }
  const priceKey = String(req.body?.price_key || '');
  const stripePriceId = getStripePriceId(priceKey);
  if (!stripePriceId) return res.status(400).json({ error: 'unknown_price_key' });

  try {
    const form = new URLSearchParams();
    form.set('mode', PRICE_CATALOG[priceKey].lifetime ? 'payment' : 'subscription');
    form.set('line_items[0][price]', stripePriceId);
    form.set('line_items[0][quantity]', '1');
    form.set('client_reference_id', String(req.merchant.id));
    form.set('metadata[price_key]', priceKey);
    form.set('metadata[merchant_id]', String(req.merchant.id));
    form.set('customer_email', req.merchant.email);
    form.set('success_url', `${PUBLIC_BASE_URL}/admin?billing=success&tier=${PRICE_CATALOG[priceKey].tier}`);
    form.set('cancel_url', `${PUBLIC_BASE_URL}/admin?billing=cancelled`);
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const data = await stripeRes.json();
    if (!stripeRes.ok) {
      console.error('[billing] stripe error:', data);
      return res.status(502).json({ error: 'stripe_error', detail: data?.error?.message });
    }
    res.json({ ok: true, url: data.url, session_id: data.id });
  } catch (err) {
    console.error('[billing] exception:', err);
    res.status(500).json({ error: 'internal' });
  }
});

// 2) Mock checkout: instant upgrade (test/demo only). Always available so we
// can exercise the upgrade UI without a Stripe round-trip.
app.post('/api/billing/upgrade-mock', requireAuth, (req, res) => {
  if (process.env.CSB_ALLOW_MOCK_BILLING !== '1') {
    return res.status(403).json({ error: 'mock_billing_disabled' });
  }
  const priceKey = String(req.body?.price_key || '');
  const result = applyUpgrade(req.merchant.id, priceKey);
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

// 3) Stripe webhook receiver. Only registered when STRIPE_WEBHOOK_SECRET is
// set so dev servers without it don't reject real requests by accident.
//
// Idempotency: every event id is recorded in `webhook_events`; if we see the
// same id twice (Stripe always retries on 5xx, sometimes retries on 4xx, and
// also sends duplicates during dev replays), we no-op the second delivery.
// This is the only safe way to apply upgrades from webhooks — otherwise a
// Stripe outage could double-charge a Lifetime slot.
//
// Events we care about:
//   - checkout.session.completed         -> apply upgrade once
//   - customer.subscription.created      -> link subscription to merchant
//   - customer.subscription.updated      -> track subscription_status
//   - customer.subscription.deleted      -> downgrade to free
//   - invoice.payment_succeeded          -> reset monthly counter on renew
//   - invoice.payment_failed             -> note grace-period state
if (STRIPE_WEBHOOK_SECRET) {
  app.post('/api/billing/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      // Lazy-require so dev installs without `stripe` package still work.
      const Stripe = require('stripe');
      const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
      event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[billing webhook] signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // A valid standalone-provider event must never alter Shopify entitlements.
    const object = event.data?.object || {};
    const refs = [Number(object.client_reference_id), Number(object.metadata?.merchant_id)];
    const id = typeof object.id === 'string' ? object.id : '';
    const subscription = typeof object.subscription === 'string' ? object.subscription : '';
    const customer = typeof object.customer === 'string' ? object.customer : '';
    refs.push(...db.prepare(`SELECT id FROM merchants WHERE stripe_subscription_id IN (?, ?)
      OR (stripe_customer_id = ? AND stripe_customer_id <> '')`).all(id, subscription, customer).map(row => row.id));
    if (refs.some(id => Number.isSafeInteger(id) && id > 0 && shopify.isShopifyMerchant(id))) {
      recordWebhookEvent(event.id, event.type);
      return res.json({received:true, ignored:true});
    }

    // ---- Idempotency gate -----------------------------------------------
    if (isWebhookEventProcessed(event.id)) {
      console.log(`[billing webhook] duplicate event ${event.id} (${event.type}), skipping`);
      return res.json({ received: true, duplicate: true });
    }

    const log = (...args) => console.log('[billing webhook]', event.id, event.type, ...args);

    try {
      db.exec('BEGIN IMMEDIATE');
      // ---- 1) Initial upgrade from Checkout -------------------------------
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const session = event.data.object;
        const merchantId = Number(session.client_reference_id);
        if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
          recordWebhookEvent(event.id, event.type);
          db.exec('COMMIT');
          return res.json({ received: true, pending: true });
        }
        const priceKey = session.metadata?.price_key;
        if (!PRICE_CATALOG[priceKey] || String(merchantId) !== session.metadata?.merchant_id) {
          throw new Error('Checkout metadata cannot resolve merchant and price');
        }
        if (merchantId && priceKey) {
          const result = applyUpgrade(merchantId, priceKey);
          if (!result.ok) throw new Error(result.error);
          // Link the Stripe customer / subscription ids so future renewals /
          // cancellations route back to this merchant without client_reference_id.
          if (session.customer && session.subscription) {
            db.prepare(
              'UPDATE merchants SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ? WHERE id = ?'
            ).run(String(session.customer), String(session.subscription), 'active', merchantId);
          }
          log(`upgrade ${merchantId} -> ${priceKey}`, result);
        } else {
          throw new Error('Checkout merchant missing');
        }

      // ---- 2) Subscription lifecycle -------------------------------------
      } else if (
        event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted'
      ) {
        const sub = event.data.object;
        const subId = String(sub.id);
        const merchant = db.prepare(
          'SELECT id FROM merchants WHERE stripe_subscription_id = ? OR stripe_customer_id = ? LIMIT 1'
        ).get(subId, String(sub.customer));

        if (merchant) {
          if (event.type === 'customer.subscription.deleted' || sub.status === 'canceled') {
            db.prepare(
              `UPDATE merchants
                  SET tier = 'free',
                      monthly_convo_count = 0,
                      convo_count_reset_at = date('now'),
                      subscription_status = 'canceled'
                WHERE id = ?`
            ).run(merchant.id);
            log(`canceled subscription, downgraded merchant ${merchant.id}`);
          } else {
            db.prepare(
              'UPDATE merchants SET subscription_status = ?, stripe_subscription_id = ? WHERE id = ?'
            ).run(sub.status, subId, merchant.id);
            log(`subscription ${event.type} -> ${sub.status} for merchant ${merchant.id}`);
          }
        } else {
          log(`no merchant linked to subscription ${subId} (customer=${sub.customer})`);
        }

      // ---- 3) Recurring payment success / failure ------------------------
      } else if (event.type === 'invoice.payment_succeeded') {
        const inv = event.data.object;
        const subId = inv.subscription ? String(inv.subscription) : null;
        if (subId) {
          // On a successful renewal we reset the monthly counter so the
          // subscription stays usable even if they hit the cap mid-cycle.
          const result = db.prepare(
            `UPDATE merchants
                SET subscription_status = 'active',
                    monthly_convo_count = 0,
                    convo_count_reset_at = date('now')
              WHERE stripe_subscription_id = ?`
          ).run(subId);
          log(`payment_succeeded sub=${subId} rows=${result.changes}`);
        }
      } else if (event.type === 'invoice.payment_failed') {
        const inv = event.data.object;
        const subId = inv.subscription ? String(inv.subscription) : null;
        if (subId) {
          db.prepare(
            'UPDATE merchants SET subscription_status = ? WHERE stripe_subscription_id = ?'
          ).run('past_due', subId);
          log(`payment_failed sub=${subId} marked past_due`);
        }
      } else {
        log('ignored (unhandled event type)');
      }

      // Only commit the event id AFTER successful processing. If we crashed
      // mid-handler, Stripe will retry and we'll re-process from scratch.
      recordWebhookEvent(event.id, event.type);
      db.exec('COMMIT');
      res.json({ received: true });
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      console.error('[billing webhook] handler error:', err.message);
      // Return 500 so Stripe retries (and we won't have recorded the event id).
      res.status(500).send('Webhook handler error');
    }
  });
}

// ---- Trial (7-day Pro) ----------------------------------------------------
// One trial per merchant. Refuses if they've already used it, or if they're
// already on a paid tier (no "double dipping" free trial after upgrading).
app.post('/api/billing/start-trial', requireAuth, (req, res) => {
  if (shopify.isShopifyMerchant(req.merchant.id)) return res.status(409).json({ error: 'use_shopify_billing' });
  const result = startProTrial(req.merchant.id);
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

if (require.main === module) {
  shopify.purgeExpired();
  setInterval(() => shopify.purgeExpired(), 60 * 60 * 1000).unref();
  // Expire any trials whose 7 days have already passed (e.g. server was off
  // when they expired). Cheap (single UPDATE).
  const expired = expireTrials();
  if (expired > 0) console.log(`[trial] expired ${expired} trial(s) at startup`);

  // Run hourly to catch expirations while the server is up.
  setInterval(() => {
    const n = expireTrials();
    if (n > 0) console.log(`[trial] expired ${n} trial(s)`);
  }, 60 * 60 * 1000);

  // CLI HOST can be a public HTTPS URL; it is not a local listening interface.
  const bindHost = process.env.BIND_HOST || (process.env.HOST && !process.env.HOST.includes('://') ? process.env.HOST : '127.0.0.1');
  app.listen(PORT, bindHost, () => {
    const llmBase = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
    const llmModel = process.env.LLM_MODEL || 'gpt-4o-mini';
    const shopifyReady = Boolean(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET
      && /^[a-f\d]{64}$/i.test(process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY || '')
      && /^https:\/\//.test(PUBLIC_BASE_URL));
    console.log(`[boot] public_base=${PUBLIC_BASE_URL} llm_base=${llmBase} llm_model=${llmModel} shopify_configured=${shopifyReady}`);
    console.log(`AI customer-service bot listening on ${PUBLIC_BASE_URL}`);
  });
}

module.exports = app;
app.get('/refunds', (_req,res)=>res.sendFile(path.join(__dirname,'public','refunds.html')));
