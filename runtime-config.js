'use strict';

// Shopify CLI supplies the tunnel origin for app dev. Production uses the
// explicitly configured canonical origin so a development URL cannot win.
function publicBaseUrl(env = process.env) {
  const cliOrigin = env.NODE_ENV !== 'production' && (env.APP_URL || env.SHOPIFY_APP_URL || env.HOST);
  const origin = cliOrigin || env.PUBLIC_BASE_URL || env.HOST || `http://localhost:${env.PORT || 3000}`;
  return origin.replace(/\/+$/, '');
}

module.exports = { publicBaseUrl };
