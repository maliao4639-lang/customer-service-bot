'use strict';
const crypto = require('node:crypto');

function verifySignature(raw, header, secret, now = Date.now()) {
  if (!Buffer.isBuffer(raw) || !secret || typeof header !== 'string') return false;
  const fields = header.split(';').map(x => x.trim().split('='));
  const timestamps = fields.filter(x => x[0] === 'ts');
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0][1])) return false;
  const ts = timestamps[0][1];
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(ts + ':').update(raw).digest();
  return fields.some(([key, value]) => key === 'h1' && /^[a-f\d]{64}$/i.test(value || '') &&
    crypto.timingSafeEqual(expected, Buffer.from(value, 'hex')));
}

function createPaddle({db, env = process.env, fetchImpl = fetch, now = Date.now, isShopifyMerchant = () => false}) {
  const environment = env.PADDLE_ENVIRONMENT || 'sandbox';
  const plans = Object.fromEntries(['pro_monthly','pro_annual','growth_monthly','growth_annual']
    .map(tier => [tier, env['PADDLE_PRICE_' + tier.toUpperCase()] || '']).filter(([,id]) => /^pri_[a-z\d]{26}$/.test(id)));
  const enabled = env.PADDLE_ENABLED === '1' && env.CSB_FREE_ONLY !== '1' &&
    ['sandbox','live'].includes(environment) && !!env.PADDLE_API_KEY && !!env.PADDLE_WEBHOOK_SECRET &&
    !!env.PADDLE_CLIENT_TOKEN && Object.keys(plans).length > 0 &&
    !(env.NODE_ENV === 'production' && environment === 'sandbox');
  const webhookReady = enabled || (env.PADDLE_WEBHOOK_ENABLED === '1' &&
    environment === 'live' && !!env.PADDLE_WEBHOOK_SECRET);
  // A test provider must never grant production entitlements.
  const apiBase = environment === 'live' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
  db.exec(`
    CREATE TABLE IF NOT EXISTS paddle_checkouts (
      token TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, tier TEXT NOT NULL,
      price_id TEXT NOT NULL, transaction_id TEXT UNIQUE, created_at INTEGER NOT NULL,
      environment TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paddle_subscriptions (
      id TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, customer_id TEXT NOT NULL,
      tier TEXT NOT NULL, environment TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paddle_payments (
      id TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, subscription_id TEXT NOT NULL,
      tier TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      environment TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paddle_revocations (transaction_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS paddle_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS paddle_payment_merchant ON paddle_payments(merchant_id,ends_at);
  `);
  async function api(path, method = 'GET', body) {
    const response = await fetchImpl(apiBase + path, {method,
      headers:{Authorization:'Bearer ' + env.PADDLE_API_KEY,'Content-Type':'application/json','Paddle-Version':'1'},
      ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('Paddle request failed (' + response.status + ')');
    const result = await response.json();
    if (!result.data) throw new Error('Invalid Paddle response');
    return result.data;
  }
  function refreshMerchant(id) {
    if (isShopifyMerchant(id)) return;
    if (!db.prepare('SELECT 1 FROM paddle_subscriptions WHERE merchant_id=?').get(id)) return;
    const current = db.prepare('SELECT tier FROM merchants WHERE id=?').get(id);
    if (!current || current.tier.startsWith('lifetime_')) return;
    const active = db.prepare(`SELECT p.tier FROM paddle_payments p
      WHERE p.merchant_id=? AND p.environment=? AND p.starts_at<=? AND p.ends_at>?
      AND NOT EXISTS(SELECT 1 FROM paddle_revocations r WHERE r.transaction_id=p.id)
      ORDER BY CASE WHEN p.tier LIKE 'growth_%' THEN 2 ELSE 1 END DESC,p.ends_at DESC LIMIT 1`)
      .get(id,environment,now(),now());
    db.prepare('UPDATE merchants SET tier=?,trial_ends_at=NULL WHERE id=?').run(active?.tier || 'free',id);
  }
  function refreshAll() {
    if (!webhookReady) return;
    for (const row of db.prepare('SELECT DISTINCT merchant_id FROM paddle_subscriptions').all()) refreshMerchant(row.merchant_id);
  }
  const busy = new Set();
  async function checkout(merchantId,tier) {
    if (isShopifyMerchant(merchantId)) throw new Error('use_shopify_billing');
    if (!enabled) throw new Error('Paddle checkout is not enabled');
    if (!plans[tier]) throw new Error('Unknown plan');
    if (busy.has(merchantId)) throw new Error('Checkout is already being created');
    busy.add(merchantId);
    try {
      // Verify current provider state, rather than permanently blocking every past subscriber.
      const subscriptions=db.prepare('SELECT * FROM paddle_subscriptions WHERE merchant_id=? AND environment=?').all(merchantId,environment);
      for (const sub of subscriptions) {
        const current=await api('/subscriptions/'+sub.id);
        if (current.id!==sub.id || current.customer_id!==sub.customer_id || current.status!=='canceled')
          throw new Error('Manage your existing subscription in the billing portal');
      }
      if (subscriptions.length && db.prepare(`SELECT 1 FROM paddle_payments p WHERE p.merchant_id=? AND p.environment=? AND p.ends_at>?
          AND NOT EXISTS(SELECT 1 FROM paddle_revocations r WHERE r.transaction_id=p.id)`).get(merchantId,environment,now()))
        throw new Error('Your paid period has not ended yet');
      // Reuse the existing transaction; abandoned checkouts are managed explicitly, not duplicated.
      const prior=db.prepare('SELECT * FROM paddle_checkouts WHERE merchant_id=? AND environment=? ORDER BY created_at DESC LIMIT 1').get(merchantId,environment);
      if (prior) {
        if (!prior.transaction_id) throw new Error('Prior checkout outcome needs reconciliation');
        const transaction=await api('/transactions/'+prior.transaction_id);
        if (transaction.id!==prior.transaction_id || transaction.custom_data?.csb_checkout!==prior.token)
          throw new Error('Prior checkout ownership mismatch');
        if (['draft','ready'].includes(transaction.status)) {
          if (prior.tier !== tier || transaction.items?.length!==1 || transaction.items[0].quantity!==1 || transaction.items[0].price?.id!==prior.price_id)
            throw new Error('An existing checkout needs review before changing plans');
          return {transaction_id:prior.transaction_id};
        }
        if (transaction.status!=='canceled' && !(transaction.status==='completed' &&
            db.prepare('SELECT 1 FROM paddle_payments WHERE id=? AND merchant_id=? AND environment=?').get(prior.transaction_id,merchantId,environment)))
          throw new Error('Prior payment outcome needs reconciliation');
      }
      const token=crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT INTO paddle_checkouts VALUES(?,?,?,?,NULL,?,?)').run(token,merchantId,tier,plans[tier],now(),environment);
      const tx=await api('/transactions','POST',{items:[{price_id:plans[tier],quantity:1}],collection_mode:'automatic',custom_data:{csb_checkout:token}});
      if (!/^txn_[a-z\d]{26}$/.test(tx.id || '')) throw new Error('Invalid transaction ID');
      db.prepare('UPDATE paddle_checkouts SET transaction_id=? WHERE token=?').run(tx.id,token);
      return {transaction_id:tx.id};
    } finally {busy.delete(merchantId);}
  }
  function processEvent(event) {
    if (!webhookReady) throw new Error('Paddle is disabled');
    // Signed non-billing events need no persistence or entitlement changes.
    // Simulator identifiers may differ from production event identifiers.
    if (event?.event_type === 'customer.created') return {received:true,ignored:true};

    if (!/^evt_[a-z\d]{26}$/.test(event.event_id || '')) throw new Error('Invalid event ID');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT 1 FROM paddle_events WHERE id=?').get(event.event_id)) {db.exec('COMMIT');return {duplicate:true};}
      const d=event.data;
      if (event.event_type === 'transaction.completed') {
        if (!d || d.status!=='completed' || !/^txn_[a-z\d]{26}$/.test(d.id || '') || !/^sub_[a-z\d]{26}$/.test(d.subscription_id || '') || !/^ctm_[a-z\d]{26}$/.test(d.customer_id || '')) throw new Error('Incomplete paid transaction');
        const initial=db.prepare('SELECT * FROM paddle_checkouts WHERE transaction_id=? AND environment=?').get(d.id,environment);
        const sub=db.prepare('SELECT * FROM paddle_subscriptions WHERE id=? AND environment=?').get(d.subscription_id,environment);
        if (!initial && !sub) throw new Error('Unmapped payment; retry after initial checkout is reconciled');
        const merchantId=initial?.merchant_id || sub.merchant_id;
        if (isShopifyMerchant(merchantId)) {
          db.prepare('INSERT INTO paddle_events VALUES(?,?)').run(event.event_id,event.event_type);
          db.exec('COMMIT');return {received:true,ignored:true};
        }
        const tier=initial?.tier || sub.tier;
        const firstCheckout=sub && db.prepare(`SELECT c.price_id FROM paddle_checkouts c JOIN paddle_payments p ON p.id=c.transaction_id
          WHERE p.subscription_id=? AND p.environment=? LIMIT 1`).get(sub.id,environment);
        const priceId=initial?.price_id || firstCheckout?.price_id || plans[tier];
        if (sub && (sub.merchant_id!==merchantId || sub.customer_id!==d.customer_id)) throw new Error('Subscription ownership mismatch');
        if (initial && d.custom_data?.csb_checkout!==initial.token) throw new Error('Checkout mapping mismatch');
        if (d.items?.length!==1 || d.items[0].quantity!==1 || d.items[0].price?.id!==priceId) throw new Error('Paid price mismatch');
        const start=Date.parse(d.billing_period?.starts_at),end=Date.parse(d.billing_period?.ends_at);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end<=start || end-start>370*86400000) throw new Error('Invalid paid period');
        if (!db.prepare('SELECT 1 FROM merchants WHERE id=?').get(merchantId)) throw new Error('Merchant missing');
        db.prepare('INSERT OR IGNORE INTO paddle_subscriptions VALUES(?,?,?,?,?)').run(d.subscription_id,merchantId,d.customer_id,tier,environment);
        db.prepare('INSERT OR IGNORE INTO paddle_payments VALUES(?,?,?,?,?,?,?)').run(d.id,merchantId,d.subscription_id,tier,start,end,environment);
        refreshMerchant(merchantId);
      } else if (['adjustment.created','adjustment.updated'].includes(event.event_type)) {
        // Full approved refunds/chargebacks revoke only the related payment period.
        if (d?.status==='approved' && ['refund','chargeback'].includes(d.action) && d.type==='full') {
          if (!/^txn_[a-z\d]{26}$/.test(d.transaction_id || '')) throw new Error('Invalid refund transaction');
          db.prepare('INSERT OR IGNORE INTO paddle_revocations VALUES(?)').run(d.transaction_id);
          const payment=db.prepare('SELECT merchant_id FROM paddle_payments WHERE id=?').get(d.transaction_id);
          if(payment) refreshMerchant(payment.merchant_id);
        }
      }
      // Subscription status events never grant access. Completed payments govern access expiry.
      db.prepare('INSERT INTO paddle_events VALUES(?,?)').run(event.event_id,event.event_type);
      db.exec('COMMIT');return {received:true};
    } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  async function portal(merchantId) {
    if (isShopifyMerchant(merchantId)) throw new Error('use_shopify_billing');
    const sub=db.prepare('SELECT customer_id FROM paddle_subscriptions WHERE merchant_id=? AND environment=? LIMIT 1').get(merchantId,environment);
    if(!sub) throw new Error('No Paddle subscription');
    const result=await api('/customers/'+sub.customer_id+'/portal-sessions','POST',{});
    const url=new URL(result.urls.general.overview);
    if(url.protocol!=='https:' || !['customer-portal.paddle.com','sandbox-customer-portal.paddle.com'].includes(url.hostname)) throw new Error('Unexpected portal URL');
    return {url:url.href};
  }
  function mount(app,requireAuth) {
    const origin=new URL(env.PUBLIC_BASE_URL || 'http://localhost:3000').origin;
    app.get('/api/paddle/config',requireAuth,(req,res)=>{
      if(isShopifyMerchant(req.merchant.id))return res.status(409).json({error:'use_shopify_billing'});
      res.json(enabled?{enabled:true,environment,client_token:env.PADDLE_CLIENT_TOKEN,plans:Object.keys(plans)}:{enabled:false});
    });
    function ready(req,res,next){
      if(isShopifyMerchant(req.merchant.id))return res.status(409).json({error:'use_shopify_billing'});
      if(!enabled)return res.status(503).json({error:'Payments are not available yet'});
      if(req.get('Origin') && req.get('Origin')!==origin)return res.status(403).json({error:'Untrusted origin'});
      next();
    }
    app.post('/api/paddle/checkout',requireAuth,ready,async(req,res)=>{
      try{res.json(await checkout(req.merchant.id,String(req.body?.price_key || '')));}
      catch{res.status(409).json({error:'Unable to start checkout; try again or manage your existing subscription'});}
    });
    app.post('/api/paddle/portal',requireAuth,ready,async(req,res)=>{
      try{res.json(await portal(req.merchant.id));}catch{res.status(409).json({error:'Billing portal unavailable'});}
    });
    app.post('/api/paddle/webhook',(req,res)=>{
      if(!webhookReady)return res.sendStatus(503);
      if(!verifySignature(req.rawBody,req.get('Paddle-Signature'),env.PADDLE_WEBHOOK_SECRET,now()))return res.sendStatus(400);
      try{res.json(processEvent(req.body));}catch(error){
        const known = ['Invalid event ID','Paddle is disabled','Incomplete paid transaction','Unmapped payment; retry after initial checkout is reconciled','Subscription ownership mismatch','Checkout mapping mismatch','Paid price mismatch','Invalid paid period','Merchant missing','Invalid refund transaction'];
        console.error('[paddle webhook]', JSON.stringify({
          reason:known.includes(error.message)?error.message:'database_or_unexpected_error',
          code:typeof error.code==='string'?error.code.slice(0,50):null,
          eventIdLength:typeof req.body?.event_id==='string'?req.body.event_id.length:null,
          eventType:typeof req.body?.event_type==='string' && /^[a-z.]+$/.test(req.body.event_type)?req.body.event_type:null
        }));
        res.status(500).json({error:'Webhook processing failed; retry required'});
      }
    });
  }
  return {enabled,checkout,processEvent,refreshAll,portal,mount};
}
module.exports={createPaddle,verifySignature};
