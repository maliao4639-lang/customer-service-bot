'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'app.db');
const db = new DatabaseSync(dbPath);

// Recommended pragmas for a small web app
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS merchants (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    brand_name    TEXT NOT NULL DEFAULT 'Our Store',
    return_policy TEXT NOT NULL DEFAULT '',
    shipping_info TEXT NOT NULL DEFAULT '',
    extra_info    TEXT NOT NULL DEFAULT '',
    api_key       TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS faqs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id  INTEGER NOT NULL,
    question     TEXT NOT NULL,
    answer       TEXT NOT NULL,
    position     INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id  INTEGER NOT NULL,
    session_key  TEXT NOT NULL,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS escalations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id  INTEGER NOT NULL,
    email        TEXT NOT NULL,
    question     TEXT NOT NULL,
    resolved     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_faqs_merchant ON faqs(merchant_id);
  CREATE INDEX IF NOT EXISTS idx_convo_merchant ON conversations(merchant_id);
  CREATE INDEX IF NOT EXISTS idx_convo_session ON conversations(merchant_id, session_key);
  CREATE INDEX IF NOT EXISTS idx_escalations_merchant ON escalations(merchant_id);
`);

// ---- Schema migrations (idempotent) ---------------------------------------
// Each ALTER is wrapped because SQLite has no "ADD COLUMN IF NOT EXISTS".
function safeAlter(sql) {
  try { db.exec(sql); } catch (_e) { /* column already exists */ }
}
safeAlter("ALTER TABLE merchants ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'");
safeAlter("ALTER TABLE merchants ADD COLUMN monthly_convo_count INTEGER NOT NULL DEFAULT 0");
// SQLite ADD COLUMN doesn't allow non-constant DEFAULT like (date('now')),
// so seed empty string and rely on ensureMonthReset() to populate it.
safeAlter("ALTER TABLE merchants ADD COLUMN convo_count_reset_at TEXT NOT NULL DEFAULT ''");
// Trial tracking: NULL = never trialed, ISO date = trial expires then.
// has_used_trial prevents repeat trials even after the trial ends.
safeAlter("ALTER TABLE merchants ADD COLUMN trial_ends_at TEXT");
safeAlter("ALTER TABLE merchants ADD COLUMN has_used_trial INTEGER NOT NULL DEFAULT 0");

// Lifetime slot ledger (mirrors the 200-slot plan in PRICING). One row per
// tier_key; sold_count is incremented atomically by tryReserveLifetime().
db.exec(`
  CREATE TABLE IF NOT EXISTS lifetime_slots (
    tier_key    TEXT PRIMARY KEY,
    limit_total INTEGER NOT NULL,
    sold_count  INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO lifetime_slots (tier_key, limit_total, sold_count) VALUES
    ('lifetime_1', 120, 0),
    ('lifetime_2',  60, 0),
    ('lifetime_3',  20, 0);
`);

// ---- Helpers ---------------------------------------------------------------

function randomToken(bytes = 24) {
  return require('node:crypto').randomBytes(bytes).toString('hex');
}

// Ensure the per-merchant monthly counter is current. If today's date is past
// the stored reset anchor, zero the counter and roll the anchor forward. Cheap
// (one SELECT + occasional write) so safe to call on every chat request.
function ensureMonthReset(merchantId) {
  const row = db
    .prepare("SELECT date('now') AS today, convo_count_reset_at FROM merchants WHERE id = ?")
    .get(merchantId);
  if (!row) return;
  // First call after the column was added (reset_at = ''): just anchor it to
  // today, don't wipe the count — that would silently refund real usage.
  if (!row.convo_count_reset_at || row.convo_count_reset_at === '') {
    db.prepare('UPDATE merchants SET convo_count_reset_at = ? WHERE id = ?')
      .run(row.today, merchantId);
    return;
  }
  if (row.today > row.convo_count_reset_at) {
    db.prepare('UPDATE merchants SET monthly_convo_count = 0, convo_count_reset_at = ? WHERE id = ?')
      .run(row.today, merchantId);
  }
}

// Returns the merchant's current month usage object:
//   { tier, used, cap, reset_at }  (cap = Infinity for tiers without a cap)
function getMonthlyUsage(merchantId) {
  ensureMonthReset(merchantId);
  return db
    .prepare('SELECT tier, monthly_convo_count AS used, convo_count_reset_at AS reset_at FROM merchants WHERE id = ?')
    .get(merchantId);
}

// Atomically consume one conversation slot. Returns { ok, used, cap } where
// cap is the per-tier monthly limit (or Infinity for unlimited tiers).
// Caller decides whether to persist the message — if the message save fails we
// refund by decrementing so the cap stays honest.
function tryConsumeConvo(merchantId) {
  ensureMonthReset(merchantId);
  const row = db
    .prepare('SELECT tier, monthly_convo_count FROM merchants WHERE id = ?')
    .get(merchantId);
  if (!row) return { ok: false, reason: 'merchant_not_found' };
  const cap = tierMonthlyCap(row.tier);
  if (row.monthly_convo_count >= cap) {
    return { ok: false, reason: 'monthly_cap_reached', used: row.monthly_convo_count, cap };
  }
  db.prepare('UPDATE merchants SET monthly_convo_count = monthly_convo_count + 1 WHERE id = ?')
    .run(merchantId);
  return { ok: true, used: row.monthly_convo_count + 1, cap };
}

function refundConvo(merchantId) {
  // Never let it go negative.
  db.prepare('UPDATE merchants SET monthly_convo_count = MAX(0, monthly_convo_count - 1) WHERE id = ?')
    .run(merchantId);
}

// Map tier_key → monthly conversation cap. Mirror of PRICING in server.js.
function tierMonthlyCap(tier) {
  switch (tier) {
    case 'free':           return 100;
    case 'pro_monthly':
    case 'pro_annual':     return 500;
    case 'growth_monthly':
    case 'growth_annual':  return 2000;
    case 'lifetime_1':     return 1000;
    case 'lifetime_2':     return 2000;
    case 'lifetime_3':     return 5000;
    default:               return 100; // unknown tier defaults to free cap
  }
}

// Atomically reserve one Lifetime slot. Returns { ok, remaining } or
// { ok: false, reason: 'sold_out', tier_key }.
function tryReserveLifetime(tierKey) {
  // Atomic: only increment if sold_count < limit_total.
  const result = db
    .prepare(
      `UPDATE lifetime_slots
         SET sold_count = sold_count + 1
       WHERE tier_key = ?
         AND sold_count < limit_total`
    )
    .run(tierKey);
  if (result.changes === 1) {
    const row = db.prepare('SELECT limit_total, sold_count FROM lifetime_slots WHERE tier_key = ?').get(tierKey);
    return { ok: true, remaining: row.limit_total - row.sold_count };
  }
  return { ok: false, reason: 'sold_out', tier_key: tierKey };
}

function getLifetimeAvailability() {
  const rows = db.prepare('SELECT tier_key, limit_total, sold_count FROM lifetime_slots ORDER BY tier_key').all();
  return rows.map((r) => ({
    tier_key: r.tier_key,
    limit_total: r.limit_total,
    sold_count: r.sold_count,
    remaining: r.limit_total - r.sold_count,
  }));
}

// ---- Trial helpers --------------------------------------------------------
// One-shot 7-day Pro trial per merchant. Trial is independent of paid tiers:
// if a merchant upgrades to a paid tier mid-trial, we clear trial_ends_at so
// the auto-expiry doesn't knock them down to free at day 7.

const TRIAL_DAYS = 7;

function startProTrial(merchantId) {
  const row = db.prepare('SELECT tier, has_used_trial FROM merchants WHERE id = ?').get(merchantId);
  if (!row) return { ok: false, error: 'merchant_not_found' };
  if (row.has_used_trial) return { ok: false, error: 'already_used_trial' };
  // Refuse if merchant is already on a paid tier (no free trial for paying users).
  if (row.tier !== 'free') return { ok: false, error: 'not_eligible', current_tier: row.tier };

  const endsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare(
    `UPDATE merchants
        SET tier = 'pro_monthly',
            monthly_convo_count = 0,
            convo_count_reset_at = date('now'),
            trial_ends_at = ?,
            has_used_trial = 1
      WHERE id = ?`
  ).run(endsAt, merchantId);
  return { ok: true, tier: 'pro_monthly', trial_ends_at: endsAt };
}

// Run once at startup and periodically. Downgrades trial merchants whose
// trial has expired. Idempotent and cheap.
function expireTrials() {
  const res = db.prepare(
    `UPDATE merchants
        SET tier = 'free',
            monthly_convo_count = 0,
            convo_count_reset_at = date('now'),
            trial_ends_at = NULL
      WHERE trial_ends_at IS NOT NULL
        AND date(trial_ends_at) <= date('now')
        AND tier = 'pro_monthly'`
  ).run();
  return res.changes;
}

function getTrialStatus(merchantId) {
  return db
    .prepare('SELECT trial_ends_at, has_used_trial, tier FROM merchants WHERE id = ?')
    .get(merchantId);
}

module.exports = {
  db,
  randomToken,
  ensureMonthReset,
  getMonthlyUsage,
  tryConsumeConvo,
  refundConvo,
  tierMonthlyCap,
  tryReserveLifetime,
  getLifetimeAvailability,
  startProTrial,
  expireTrials,
  getTrialStatus,
  TRIAL_DAYS,
};