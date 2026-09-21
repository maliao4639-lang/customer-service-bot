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

// ---- Helpers ---------------------------------------------------------------

function randomToken(bytes = 24) {
  return require('node:crypto').randomBytes(bytes).toString('hex');
}

module.exports = { db, randomToken };