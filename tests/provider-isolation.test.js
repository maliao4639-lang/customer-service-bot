'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'shopreply-provider-test-'));
const providerId=(prefix,n)=>prefix+'_'+String(n).padStart(26,'0');
Object.assign(process.env,{NODE_ENV:'test',CSB_DATA_DIR:dataDir,PUBLIC_BASE_URL:'https://fixture.example.test',
  SESSION_SECRET:'provider-isolation-test-secret-at-least-32',CSB_FREE_ONLY:'0',CSB_ALLOW_MOCK_BILLING:'0',
  STRIPE_SECRET_KEY:'sk_test_local_only',STRIPE_WEBHOOK_SECRET:'whsec_fixture_only',
  PADDLE_ENABLED:'1',PADDLE_ENVIRONMENT:'sandbox',PADDLE_API_KEY:'fixture-only',PADDLE_CLIENT_TOKEN:'fixture-public',
  PADDLE_WEBHOOK_SECRET:'paddle_fixture_secret',PADDLE_PRICE_PRO_MONTHLY:providerId('pri',1)});
const app=require('../server');
const {db}=require('../db');
test('retained standalone billing cannot alter Shopify accounts',async t=>{
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const signup=await fetch(base+'/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'isolation@example.test',password:'fixture-password'})});
  assert.equal(signup.status,200);
  const cookie=signup.headers.get('set-cookie').split(';')[0];
  const mid=db.prepare('SELECT id FROM merchants WHERE email=?').get('isolation@example.test').id;
  const request=(route,body,headers={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const snapshot=()=>({...db.prepare('SELECT tier,monthly_convo_count FROM merchants WHERE id=?').get(mid)});
  try{
    db.prepare('INSERT INTO shopify_shops(shop,merchant_id,installed_at) VALUES(?,?,?)').run('billing-fixture.myshopify.com',mid,Date.now());
    db.prepare("UPDATE merchants SET tier='pro_annual',monthly_convo_count=12,stripe_customer_id='cus_fixture',stripe_subscription_id='sub_fixture' WHERE id=?").run(mid);
    const unchanged={tier:'pro_annual',monthly_convo_count:12};
    await t.test('old session cannot start Paddle checkout, open portal or obtain provider config',async()=>{
      for(const [route,body] of [['/api/paddle/config',undefined],['/api/paddle/checkout',{price_key:'pro_monthly'}],['/api/paddle/portal',{}],['/billing/paddle',undefined]]){
        const r=await request(route,body);assert.equal(r.status,409);assert.equal((await r.json()).error,'use_shopify_billing');
      }
      assert.equal(db.prepare('SELECT count(*) n FROM paddle_checkouts').get().n,0);
      assert.deepEqual(snapshot(),unchanged);
    });
    await t.test('Paddle renewal and global refresh cannot grant or downgrade Shopify access',async()=>{
      const pid=providerId('txn',1),sid=providerId('sub',1),cid=providerId('ctm',1),price=providerId('pri',1);
      db.prepare('INSERT INTO paddle_checkouts VALUES(?,?,?,?,?,?,?)').run('fixture-checkout',mid,'pro_monthly',price,pid,Date.now(),'sandbox');
      db.prepare('INSERT INTO paddle_subscriptions VALUES(?,?,?,?,?)').run(sid,mid,cid,'pro_monthly','sandbox');
      const event={event_id:providerId('evt',1),event_type:'transaction.completed',data:{id:pid,status:'completed',subscription_id:sid,customer_id:cid,custom_data:{csb_checkout:'fixture-checkout'},items:[{quantity:1,price:{id:price}}],billing_period:{starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+86400000).toISOString()}}};
      const ts=String(Math.floor(Date.now()/1000));const signature=crypto.createHmac('sha256',process.env.PADDLE_WEBHOOK_SECRET).update(ts+':'+JSON.stringify(event)).digest('hex');
      const r=await request('/api/paddle/webhook',event,{'Paddle-Signature':'ts='+ts+';h1='+signature});assert.equal(r.status,200);assert.equal((await r.json()).ignored,true);
      assert.equal(db.prepare('SELECT count(*) n FROM paddle_payments').get().n,0);
      assert.equal((await request('/healthz')).status,200);assert.deepEqual(snapshot(),unchanged);
    });
    await t.test('signed Stripe checkout, cancellation, renewal and failure cannot change tier or quota',async()=>{
      const stripe=new(require('stripe'))(process.env.STRIPE_SECRET_KEY);
      const samples=[['checkout.session.completed',{client_reference_id:String(mid),metadata:{merchant_id:String(mid),price_key:'pro_monthly'},payment_status:'paid',customer:'cus_fixture',subscription:'sub_fixture'}],['customer.subscription.deleted',{id:'sub_fixture',customer:'cus_fixture',status:'canceled'}],['invoice.payment_succeeded',{subscription:'sub_fixture',customer:'cus_fixture'}],['invoice.payment_failed',{subscription:'sub_fixture',customer:'cus_fixture'}]];
      for(const [index,[type,object]] of samples.entries()){
        const event={id:'evt_fixture_'+index,type,data:{object}};
        const signature=stripe.webhooks.generateTestHeaderString({payload:JSON.stringify(event),secret:process.env.STRIPE_WEBHOOK_SECRET});
        const r=await request('/api/billing/webhook',event,{'stripe-signature':signature});assert.equal(r.status,200);assert.equal((await r.json()).ignored,true);assert.deepEqual(snapshot(),unchanged);
      }
    });
  }finally{
    server.closeAllConnections();await new Promise(r=>server.close(r));db.close();
    if(path.dirname(dataDir)===os.tmpdir()&&path.basename(dataDir).startsWith('shopreply-provider-test-'))fs.rmSync(dataDir,{recursive:true,force:true});
  }
});
