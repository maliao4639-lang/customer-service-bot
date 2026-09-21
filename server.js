'use strict';

require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

const { db, randomToken } = require('./db');
const { generateAnswer, loadFaqs } = require('./llm');

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser(SESSION_SECRET));

// ---- Signed session cookie helpers ----------------------------------------

const cookieSignature = require('cookie-signature');

function makeSessionCookie(merchantId) {
  // cookie-signature expects a string payload and a secret.
  // The output is `payload.signature`, where signature is base64(HMAC-SHA256(payload)).
  const payload = `m:${merchantId}.${randomToken(12)}`;
  return cookieSignature.sign(payload, SESSION_SECRET);
}

function readSession(req) {
  const raw = req.signedCookies?.session;
  if (!raw) return null;
  // cookie-parser puts the unsigned value on req.signedCookies when verification passes.
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('m:')) return null;
  const merchantId = Number(raw.slice(2).split('.')[0]);
  if (!Number.isInteger(merchantId)) return null;
  return merchantId;
}

function requireAuth(req, res, next) {
  const merchantId = readSession(req);
  if (!merchantId) return res.status(401).json({ error: 'Not logged in' });
  const merchant = db
    .prepare('SELECT id, email, brand_name, return_policy, shipping_info, extra_info FROM merchants WHERE id = ?')
    .get(merchantId);
  if (!merchant) return res.status(401).json({ error: 'Account no longer exists' });
  req.merchant = merchant;
  next();
}

// ---- Static files ----------------------------------------------------------

app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use('/static', express.static(path.join(__dirname, 'public', 'static')));

// Public widget loader (the one snippet merchants paste)
app.get('/embed.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'widget', 'embed.js'));
});

// ---- Public auth (signup / login) ------------------------------------------

app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

  const existing = db.prepare('SELECT id FROM merchants WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const hash = await bcrypt.hash(password, 10);
  const apiKey = 'csb_' + randomToken(16);
  const info = db
    .prepare(
      `INSERT INTO merchants (email, password_hash, brand_name, api_key)
       VALUES (?, ?, ?, ?)`
    )
    .run(email, hash, email.split('@')[0], apiKey);

  res.cookie('session', makeSessionCookie(info.lastInsertRowid), {
    httpOnly: true,
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

app.post('/api/chat', async (req, res) => {
  const apiKey = String(req.headers['x-api-key'] || req.body?.api_key || '').trim();
  const merchant = lookupMerchantByApiKey(apiKey);
  if (!merchant) return res.status(401).json({ error: 'Invalid API key' });

  const message = String(req.body?.message ?? '').trim();
  const email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
  const sessionKey = String(req.body?.session_key ?? '').slice(0, 64) || randomToken(12);

  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (message.length > 2000) return res.status(400).json({ error: 'Message too long' });

  // Save visitor turn first
  db.prepare(
    `INSERT INTO conversations (merchant_id, session_key, role, content) VALUES (?, ?, 'user', ?)`
  ).run(merchant.id, sessionKey, message);

  const history = db
    .prepare(
      `SELECT role, content FROM conversations
        WHERE merchant_id = ? AND session_key = ?
        ORDER BY id ASC`
    )
    .all(merchant.id, sessionKey);

  const faqs = loadFaqs(merchant.id);
  const result = await generateAnswer({ merchant, faqs, history, visitorMessage: message });

  if (result.ok) {
    db.prepare(
      `INSERT INTO conversations (merchant_id, session_key, role, content) VALUES (?, ?, 'assistant', ?)`
    ).run(merchant.id, sessionKey, result.content);
    return res.json({ reply: result.content, escalated: false, session_key: sessionKey });
  }

  if (result.escalate) {
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

  // Hard error from LLM — log to stderr only when CSB_DEBUG_LLM=1 is set,
  // so transient upstream hiccups don't pollute normal output.
  if (process.env.CSB_DEBUG_LLM === '1') {
    process.stderr.write(`[chat] LLM error: ${result.error}\n`);
  }
  res.status(502).json({ error: 'Our assistant is having trouble right now. Please try again in a moment.' });
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
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

// ---- Boot ------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI customer-service bot listening on ${PUBLIC_BASE_URL}`);
  });
}

module.exports = app;