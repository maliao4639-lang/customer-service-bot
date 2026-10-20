'use strict';

// Static checks for the Shopify app config. No network and no database.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const failures = [];
function must(ok, message) { if (!ok) failures.push(message); }

const toml = read('shopify.app.toml');
const shopify = read('shopify.js');
const server = read('server.js');
const db = read('db.js');
const privacy = read('public/legal/privacy.html');
const terms = read('public/legal/terms.html');
const liquid = read('extensions/shopreply-theme/blocks/shopreply-embed.liquid');
const loader = read('extensions/shopreply-theme/assets/shopreply-loader.js');

must(toml.includes('client_id = "361cd9115e2b28f23410adcc5f64050c"'), 'client_id must stay the linked GetShopReply app');
must(toml.includes('application_url = "https://getshopreply.com/shopify"'), 'application_url');
must(toml.includes('embedded = true'), 'embedded');
must(/scopes\s*=\s*""/.test(toml), 'scopes must stay empty');
must(toml.includes('redirect_urls = ["https://getshopreply.com/shopify"]'), 'redirect URL');
must(toml.includes('api_version = "2026-10"'), 'webhook api version');
must(!toml.includes('example.com'), 'toml must not contain example.com');
for (const topic of ['app/uninstalled', 'app_subscriptions/update', 'customers/data_request', 'customers/redact', 'shop/redact']) {
  must(toml.includes(`"${topic}"`), `missing webhook topic ${topic}`);
}
const uris = [...toml.matchAll(/^uri\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
must(uris.length === 2 && uris.every((u) => u === '/webhooks'), 'both webhook uris must be /webhooks so CLI appends them to .../shopify');
must(shopify.includes('amount: 21') && shopify.includes("interval: 'EVERY_30_DAYS'"), 'Pro monthly is USD 21 / 30 days');
must(shopify.includes('amount: 205') && shopify.includes("interval: 'ANNUAL'"), 'Pro annual is USD 205 / year');
must(/case 'free':\s+return 100;/.test(db), 'free cap 100');
must(/case 'pro_annual':\s+return 500;/.test(db), 'pro cap 500');
must(server.includes("app.post('/webhooks'"), 'origin webhook alias');
must(server.includes("router is appended") || shopify.includes("router.post('/shopify/webhooks'"), 'doubled-prefix webhook route');
for (const text of ['Maliao', 'No. 269 Chenghua North Road', 'support@getshopreply.com', 'DeepSeek', 'Vultr']) {
  must(privacy.includes(text), `privacy page missing ${text}`);
}
must(terms.includes('support@getshopreply.com') && terms.includes('100 AI replies') && terms.includes('USD $21') && terms.includes('USD $205'), 'terms plan text');
must(liquid.includes('"target": "body"') && liquid.includes('shopreply-loader.js'), 'theme app embed');
must(loader.includes('requestIdleCallback'), 'widget loader waits until idle');
must(read('extensions/shopreply-theme/shopify.extension.toml').includes('type = "theme"'), 'theme extension');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Shopify config verification passed');
