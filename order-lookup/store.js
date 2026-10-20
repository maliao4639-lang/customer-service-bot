'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// Separate database: no changes to merchant, chat, billing or usage tables.
function createStore(filename, now = Date.now) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filename, 'a', 0o600); fs.closeSync(fd);
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, tenant INTEGER NOT NULL, binding TEXT NOT NULL,
      otp TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL DEFAULT '',
      expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  // In-flight email work does not survive a restart; all challenges fail closed.
  db.exec('DELETE FROM challenges');
  const cleanup = () => {
    db.prepare('DELETE FROM challenges WHERE expires <= ?').run(now());
    db.prepare('DELETE FROM limits WHERE expires <= ?').run(now());
  };
  cleanup();
  const timer = setInterval(cleanup, 60_000); timer.unref();
  return {
    cleanup,
    enabled: () => !db.prepare("SELECT 1 FROM settings WHERE id='disabled'").get(),
    disable() {
      db.exec("INSERT OR REPLACE INTO settings VALUES ('disabled','1'); DELETE FROM challenges;");
    },
    limit(id, maximum, window) {
      const result = db.prepare(`INSERT INTO limits VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET
        count=CASE WHEN limits.expires <= ? THEN 1 ELSE limits.count+1 END,
        expires=CASE WHEN limits.expires <= ? THEN excluded.expires ELSE limits.expires END
        RETURNING count`).get(id, now() + window, now(), now());
      return result.count <= maximum;
    },
    hasCapacity() { cleanup(); return db.prepare('SELECT count(*) AS n FROM limits').get().n < 10000
      && db.prepare('SELECT count(*) AS n FROM challenges').get().n < 1000; },
    create(id, tenant, binding, expires) {
      db.prepare('INSERT INTO challenges(id,tenant,binding,expires) VALUES (?,?,?,?)').run(id, tenant, binding, expires);
    },
    ready(id, otp, reference) {
      db.prepare('UPDATE challenges SET otp=?,reference=? WHERE id=? AND expires>? AND attempts<5')
        .run(otp, reference, id, now());
    },
    get(id) { return db.prepare('SELECT * FROM challenges WHERE id=? AND expires>?').get(id, now()); },
    attempt(id) { return db.prepare('UPDATE challenges SET attempts=attempts+1 WHERE id=? AND expires>? AND attempts<5 RETURNING *').get(id, now()); },
    remove(id) { db.prepare('DELETE FROM challenges WHERE id=?').run(id); },
    close() { clearInterval(timer); db.close(); },
  };
}
module.exports = { createStore };
