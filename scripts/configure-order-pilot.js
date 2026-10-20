'use strict';
// Server-only operator tool. Input JSON arrives over stdin, never argv or logs.
// Configuration is staged DISABLED. Enabling requires separate deployment review.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createSecurity } = require('../order-lookup/security');
const { createShopify } = require('../order-lookup/providers');

function writeAtomic(filename, bytes, uid, gid, mode) {
  const temporary = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.fchownSync(fd, uid, gid); fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, filename); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Root required');
  const appRoot = path.resolve(__dirname, '..');
  if (appRoot !== '/opt/csb') throw new Error('Unexpected application location');
  const configPath = path.join(appRoot, 'private', 'order-lookup.enc');
  if (fs.existsSync(configPath)) throw new Error('Existing configuration must be reviewed before replacement');
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 8192) throw new Error('Input too large'); }
  const input = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (typeof input.merchantEmail !== 'string' || typeof input.clientId !== 'string' || typeof input.clientSecret !== 'string'
    || input.clientId.length < 16 || input.clientSecret.length < 16) throw new Error('Invalid input');
  const db = new DatabaseSync(path.join(appRoot, 'data', 'app.db'), { readOnly: true });
  let merchant;
  try { merchant = db.prepare('SELECT id FROM merchants WHERE email=?').get(input.merchantEmail.trim().toLowerCase()); }
  finally { db.close(); }
  if (!merchant) throw new Error('Merchant not found');
  const config = { enabled: false, merchantId: merchant.id, shop: 'getshopreply-test.myshopify.com',
    allowedOrigins: ['https://getshopreply-test.myshopify.com', 'https://getshopreply.com'],
    clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim() };
  await createShopify(config).check();
  const resend = fs.readFileSync('/etc/csb-resend.env', 'utf8').split(/\r?\n/).find(line => line.startsWith('RESEND_API_KEY='));
  config.resendKey = resend?.slice('RESEND_API_KEY='.length);
  if (!/^re_[A-Za-z0-9_-]{16,200}$/.test(config.resendKey || '')) throw new Error('Resend configuration unavailable');
  const uid = Number(execFileSync('id', ['-u', 'csb'], { encoding: 'utf8' }).trim());
  const gid = Number(execFileSync('id', ['-g', 'csb'], { encoding: 'utf8' }).trim());
  const keyPath = '/etc/csb-order-lookup.key';
  let key;
  if (fs.existsSync(keyPath)) key = fs.readFileSync(keyPath);
  else { key = crypto.randomBytes(32); writeAtomic(keyPath, key, 0, gid, 0o640); }
  const sealed = createSecurity(key).seal(config, 'pilot-config-v1');
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.chownSync(path.dirname(configPath), uid, gid); fs.chmodSync(path.dirname(configPath), 0o700);
  writeAtomic(configPath, sealed, 0, gid, 0o640);
  console.log(JSON.stringify({ credentials_saved: true, encrypted: true, shop_access_verified: true, pilot_enabled: false }));
}
if (require.main === module) main().catch(() => {
  console.error('Order pilot setup failed. No credentials or upstream responses printed. Review the account binding and app access.');
  process.exitCode = 1;
});
module.exports = { writeAtomic };
