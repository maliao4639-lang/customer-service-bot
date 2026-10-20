'use strict';

// Self-contained smoke test: boots the server in-process on a random port
// against a throwaway SQLite file, then exercises the major endpoints.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'csb-smoke-'));
process.env.CSB_DATA_DIR = tempDir;
const TMP_DB = path.join(tempDir, 'app.db');

// Isolated audit copy uses the actual database schema.
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_WEBHOOK_SECRET = '';
process.env.CSB_ENABLE_DEMO_KEY = '0';
process.env.CSB_ALLOW_MOCK_BILLING = '0';
process.env.PORT = '0'; // let the OS pick
process.env.LLM_API_KEY = 'sk-smoke-no-real-call';
process.env.LLM_BASE_URL = 'http://127.0.0.1:1'; // closed port => fetch will fail loudly
process.env.SESSION_SECRET = 'smoke-only-secret-with-at-least-32-characters';
process.env.PUBLIC_BASE_URL = 'http://placeholder';

const app = require('../server');

function getBaseUrl(server) {
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}`;
}

async function waitReady(server) {
  if (!server.listening) await require('node:events').once(server, 'listening');
  const base = getBaseUrl(server);
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/`);
      if (r.status === 200) return base;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not become ready');
}

function fail(msg) {
  console.error('SMOKE FAIL:', msg);
  process.exit(1);
}

async function main() {
  const server = app.listen(0, '127.0.0.1');
  try {
    const base = await waitReady(server);

    // 1) Static routes
    const home = await fetch(`${base}/`);
    if (home.status !== 200) fail(`home status ${home.status}`);
    const embed = await fetch(`${base}/embed.js`);
    if (embed.status !== 200) fail(`embed status ${embed.status}`);
    const embedText = await embed.text();
    if (!embedText.includes('window.CSB')) fail('embed.js missing window.CSB');
    const adminHtml = await fetch(`${base}/admin`);
    if (adminHtml.status !== 200) fail(`admin status ${adminHtml.status}`);

    // 2) Sign up
    const cookieJar = new Map();
    async function req(pathname, opts = {}) {
      const headers = new Headers(opts.headers || {});
      if (cookieJar.size) {
        headers.set('cookie', [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
      }
      const r = await fetch(`${base}${pathname}`, { ...opts, headers, redirect: 'manual' });
      const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const [pair] = sc.split(';');
        const [k, v] = pair.split('=');
        if (v === '' || v === undefined) cookieJar.delete(k);
        else cookieJar.set(k, v);
      }
      return r;
    }

    const su = await req('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `smoke+${Date.now()}@example.com`, password: 'hunter2' }),
    });
    if (su.status !== 200) fail(`signup status ${su.status}`);

    const me = await req('/api/admin/me');
    if (me.status !== 200) fail(`me status ${me.status}`);
    const meBody = await me.json();

    const saveStore = await req('/api/admin/store', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand_name: 'Smoke Co',
        return_policy: '30-day returns',
        shipping_info: 'US 5-8 days',
        extra_info: '',
      }),
    });
    if (saveStore.status !== 200) fail(`store save status ${saveStore.status}`);

    const addFaq = await req('/api/admin/faqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Do you ship to the US?', answer: 'Yes, 5-8 days.' }),
    });
    if (addFaq.status !== 200) fail(`addFaq status ${addFaq.status}`);

    const listFaqs = await req('/api/admin/faqs');
    const listFaqsBody = await listFaqs.json();
    if (listFaqsBody.faqs.length !== 1) fail(`expected 1 FAQ, got ${listFaqsBody.faqs.length}`);

    const snippet = await req('/api/admin/embed-snippet');
    const snippetBody = await snippet.json();
    if (!snippetBody.snippet.includes('embed.js')) fail('snippet missing embed.js');

    // 3) Visitor chat endpoint: needs an API key
    const apiKey = meBody.apiKey;
    if (!apiKey) fail('no api_key returned from /me');

    // With no real LLM, the chat endpoint should return 502 with a clear error.
    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ message: 'hello', session_key: 'sess-1' }),
    });
    if (chat.status !== 502) fail(`expected 502 from /api/chat with bogus LLM key, got ${chat.status}`);

    // Bad api key
    const chatBad = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'wrong' },
      body: JSON.stringify({ message: 'hello' }),
    });
    if (chatBad.status !== 401) fail(`expected 401 for bad key, got ${chatBad.status}`);

    console.log('SMOKE OK ✓');
    console.log('  static routes:           home, embed.js, admin OK');
    console.log('  auth + admin CRUD:       signup, me, store, FAQ OK');
    console.log('  visitor chat api:        502 with bogus LLM key (expected), 401 with bad api_key (expected)');
    console.log('  generated test key: redacted');
  } finally {
    server.close();
    require('../db').db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((e) => fail(e.stack || e.message));