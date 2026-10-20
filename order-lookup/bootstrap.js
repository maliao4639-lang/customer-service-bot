'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createSecurity } = require('./security');
const { createStore } = require('./store');
const { createShopify, createMailer } = require('./providers');
const { createOrderRouter } = require('./router');

// No new environment variables. A missing encrypted pilot config leaves the feature disabled.
function mountPilot(app, lookupMerchant, configPath = path.join(__dirname, '..', 'private', 'order-lookup.enc'), keyPath = '/etc/csb-order-lookup.key') {
  if (!fs.existsSync(configPath)) return null;
  try {
    const securityKey = fs.readFileSync(keyPath);
    const config = createSecurity(securityKey).open(fs.readFileSync(configPath, 'utf8'), 'pilot-config-v1');
    if (config.enabled !== true) return null;
    if (!Number.isSafeInteger(config.merchantId) || config.merchantId < 1 || !Array.isArray(config.allowedOrigins)
      || config.allowedOrigins.length < 1 || config.allowedOrigins.length > 5
      || !config.allowedOrigins.every(origin => typeof origin === 'string' && new URL(origin).origin === origin && origin.startsWith('https://'))
      || !['clientId', 'clientSecret', 'resendKey'].every(key => typeof config[key] === 'string' && config[key].length >= 16)) {
      throw new Error('Invalid pilot configuration');
    }
    const shopify = createShopify(config);
    const mailer = createMailer({ apiKey: config.resendKey, from: 'GetShopReply <no-reply@notify.getshopreply.com>' });
    const store = createStore(path.join(__dirname, '..', 'private', 'order-state', 'state.db'));
    const service = createOrderRouter({ ...config, store, shopify, mailer, securityKey, lookupMerchant,
      onDisable: () => { fs.unlinkSync(configPath); } });
    app.use('/api/order-lookup', service.router);
    return service;
  } catch {
    // Fail closed for the new feature while keeping the existing website available.
    console.error('[order-lookup] Pilot configuration unavailable; feature disabled.');
    return null;
  }
}
module.exports = { mountPilot };
