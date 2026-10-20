'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'shopify.app.linked.toml'), 'utf8');
const client = source.match(/^client_id\s*=\s*"([a-f0-9]{32})"/m)?.[1];
if (!client) throw new Error('Link the existing GetShopReply app with: shopify app config link --file-name linked');
const target = path.join(root, 'shopify.app.toml');
let config = fs.readFileSync(target, 'utf8');
config = config.replace(/^client_id\s*=.*$/m, `client_id = "${client}"`);
fs.writeFileSync(target, config);
// Never print app credentials. Only the public client ID is copied to TOML.
console.log('Linked client ID copied. Canonical URLs, empty scopes and five webhook topics retained.');
