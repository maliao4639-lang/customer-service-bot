'use strict';
const { normalizeEmail, normalizeOrder, equal } = require('./security');

const API_VERSION = '2026-07';
const TRACKING_HOSTS = ['ups.com', 'fedex.com', 'usps.com', 'dhl.com', 'dhl.de', 'dhlglobalmail.com', '17track.net', 'aftership.com'];
async function jsonRequest(fetcher, url, options) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Upstream request rejected');
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error('Upstream response too large');
  return JSON.parse(text);
}
function safeTrackingUrl(value, hosts = TRACKING_HOSTS) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (!hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return null;
    return url.href;
  } catch { return null; }
}
function publicStatus(order) {
  const states = { UNFULFILLED: 'Not yet fulfilled', PARTIALLY_FULFILLED: 'Partially fulfilled', FULFILLED: 'Fulfilled',
    IN_PROGRESS: 'Fulfillment in progress', ON_HOLD: 'On hold', SCHEDULED: 'Scheduled',
    OPEN: 'Awaiting fulfillment', PENDING_FULFILLMENT: 'Awaiting fulfillment', RESTOCKED: 'Restocked', REQUEST_DECLINED: 'Fulfillment request declined' };
  const shipments = (Array.isArray(order.fulfillments) ? order.fulfillments : [])
    .filter(item => item.status !== 'CANCELLED' && item.status !== 'ERROR' && item.status !== 'FAILURE').slice(0, 20)
    .map(item => ({
      status: item.deliveredAt ? 'Delivered (reported by Shopify)' : 'Fulfillment recorded',
      tracking: (Array.isArray(item.trackingInfo) ? item.trackingInfo : []).slice(0, 10).map(info => ({
        carrier: typeof info.company === 'string' ? info.company.slice(0, 100) : '',
        number: typeof info.number === 'string' ? info.number.slice(0, 100) : '',
        url: safeTrackingUrl(info.url),
      })),
    }));
  return { status: order.cancelledAt ? 'Cancelled' : (states[order.displayFulfillmentStatus] || 'Status unavailable'),
    shipments, source: 'Shopify store records',
    note: 'This is the store’s fulfillment record, not a live carrier location. Contact the store for older orders or missing tracking.'
      + (shipments.length >= 20 ? ' Up to 20 fulfillments are shown; contact the store for the complete record.' : '') };
}

function createShopify({ shop, clientId, clientSecret, fetcher = fetch, now = Date.now }) {
  // This credential flow is deliberately restricted to the owner's development store.
  if (shop !== 'getshopreply-test.myshopify.com') throw new Error('Only the approved development store is supported');
  let token, expires = 0, refreshing;
  async function getToken() {
    if (token && expires > now() + 60_000) return token;
    if (!refreshing) refreshing = (async () => {
      const value = await jsonRequest(fetcher, `https://${shop}/admin/oauth/access_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
      });
      if (typeof value.access_token !== 'string' || !value.scope?.split(',').map(x => x.trim()).includes('read_orders')
        || !Number.isFinite(value.expires_in) || value.expires_in < 120) throw new Error('Order read permission unavailable');
      token = value.access_token; expires = now() + Math.min(value.expires_in, 86400) * 1000;
      return token;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function graphql(query, variables) {
    try {
      const result = await jsonRequest(fetcher, `https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
        body: JSON.stringify({ query, variables }),
      });
      if (result.errors?.length || !result.data || result.data.shop?.myshopifyDomain !== shop) throw new Error('Shopify lookup unavailable');
      return result.data;
    } catch { token = null; expires = 0; throw new Error('Shopify lookup unavailable'); }
  }
  return {
    async check() {
      const data = await graphql('query CheckOrderAccess { shop { myshopifyDomain } currentAppInstallation { accessScopes { handle } } }', {});
      if (!data.currentAppInstallation?.accessScopes?.some(scope => scope.handle === 'read_orders')) throw new Error('Order read permission unavailable');
      return true;
    },
    async match(orderName, email) {
      if (!normalizeOrder(orderName) || !normalizeEmail(email)) return null;
      const data = await graphql(`query LookupIdentity($search:String!) {
        shop { myshopifyDomain }
        orders(first:5,query:$search) { nodes { id name email } }
      }`, { search: `name:"${orderName}"` });
      const exact = (data.orders?.nodes || []).filter(order => order.name === orderName);
      if (exact.length !== 1 || !equal(normalizeEmail(exact[0].email), email)
        || !/^gid:\/\/shopify\/Order\/\d+$/.test(exact[0].id)) return null;
      return { id: exact[0].id, email: exact[0].email };
    },
    async read(id, emailHash, hashEmail) {
      if (!/^gid:\/\/shopify\/Order\/\d+$/.test(id)) return null;
      const data = await graphql(`query LookupStatus($id:ID!) {
        shop { myshopifyDomain }
        order(id:$id) { id email cancelledAt displayFulfillmentStatus
          fulfillments(first:20) { status deliveredAt trackingInfo(first:10) { company number url } }
        }
      }`, { id });
      if (!data.order || data.order.id !== id || !normalizeEmail(data.order.email)
        || !equal(emailHash, hashEmail(normalizeEmail(data.order.email)))) return null;
      return publicStatus(data.order);
    },
  };
}
function createMailer({ apiKey, from, fetcher = fetch }) {
  if (from !== 'GetShopReply <no-reply@notify.getshopreply.com>') throw new Error('Invalid verified sender');
  return {
    async send(email, code, messageId) {
      const data = await jsonRequest(fetcher, 'https://api.resend.com/emails', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, 'Idempotency-Key': messageId },
        body: JSON.stringify({ from, to: [email], subject: 'Your GetShopReply order verification code',
          text: `Your order lookup verification code is: ${code}\n\nIt expires in 5 minutes and can be used once. Never share this code. If you did not request it, ignore this email.\n\nGetShopReply` }),
      });
      if (typeof data.id !== 'string') throw new Error('Email was not accepted');
    },
  };
}
module.exports = { createShopify, createMailer, publicStatus, safeTrackingUrl };
