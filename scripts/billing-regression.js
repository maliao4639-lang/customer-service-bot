'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-billing-'));
Object.assign(process.env, {NODE_ENV:'test', CSB_FREE_ONLY:'0', CSB_ENABLE_DEMO_KEY:'0', CSB_DATA_DIR:temp, SESSION_SECRET:'test-only-secret-with-at-least-32-characters', STRIPE_SECRET_KEY:'sk_test_local_only', STRIPE_WEBHOOK_SECRET:'whsec_local_only', PUBLIC_BASE_URL:'http://localhost', CSB_ALLOW_MOCK_BILLING:'0'});
const { db, ensureMonthReset, expireTrials } = require('../db');
const stripe = new (require('stripe'))(process.env.STRIPE_SECRET_KEY);
const app = require('../server');
const server = app.listen(0, '127.0.0.1');
async function send(id, object, type='checkout.session.completed', invalid=false) {
  const payload = JSON.stringify({id, type, data:{object}});
  const signature = stripe.webhooks.generateTestHeaderString({payload, secret:process.env.STRIPE_WEBHOOK_SECRET});
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/billing/webhook`, {method:'POST',headers:{'content-type':'application/json','stripe-signature':invalid?'invalid':signature},body:payload});
  await response.text();
  return response.status;
}
async function main() {
  if (!server.listening) await require('node:events').once(server, 'listening');
  db.prepare("INSERT INTO merchants(email,password_hash,api_key,tier,trial_ends_at,has_used_trial) VALUES('a@example.com','unused','test','pro_monthly','2000-01-01',1)").run();
  const checkout={id:'cs_local', client_reference_id:'1',metadata:{merchant_id:'1',price_key:'pro_monthly'},payment_status:'paid',customer:'cus_local',subscription:'sub_local'};
  assert.equal(await send('evt_invalid',checkout,undefined,true),400);
  assert.equal(await send('evt_paid',checkout),200);
  assert.equal(db.prepare('SELECT trial_ends_at FROM merchants WHERE id=1').get().trial_ends_at,null);
  expireTrials();
  assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'pro_monthly');
  assert.equal(await send('evt_paid',checkout),200);
  const life={...checkout, metadata:{merchant_id:'1',price_key:'lifetime_1'},subscription:null};
  // Force a late write failure: slot reservation and merchant upgrade must roll back.
  db.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON webhook_events BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  assert.equal(await send('evt_retry',life),500);
  assert.equal(db.prepare("SELECT sold_count FROM lifetime_slots WHERE tier_key='lifetime_1'").get().sold_count,0);
  assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'pro_monthly');
  db.exec('DROP TRIGGER fail_ledger');
  assert.equal(await send('evt_retry',life),200);
  assert.equal(await send('evt_retry',life),200);
  assert.equal(db.prepare("SELECT sold_count FROM lifetime_slots WHERE tier_key='lifetime_1'").get().sold_count,1);
  assert.equal(await send('evt_unknown',{...checkout,metadata:{}}),500);
  assert.equal(db.prepare("SELECT count(*) n FROM webhook_events WHERE event_id='evt_unknown'").get().n,0);
  const pending={...checkout,payment_status:'unpaid'};
  assert.equal(await send('evt_pending',pending),200);
  const today=db.prepare("SELECT date('now') d").get().d;
  db.prepare('UPDATE merchants SET monthly_convo_count=77,convo_count_reset_at=? WHERE id=1').run(today.slice(0,7)+'-01');
  ensureMonthReset(1);
  assert.equal(db.prepare('SELECT monthly_convo_count n FROM merchants WHERE id=1').get().n,77);
  db.prepare("UPDATE merchants SET convo_count_reset_at='2000-01-01' WHERE id=1").run();
  ensureMonthReset(1);
  assert.equal(db.prepare('SELECT monthly_convo_count n FROM merchants WHERE id=1').get().n,0);
  console.log('BILLING REGRESSION OK: signature, paid trial, duplicate, rollback/retry, unknown metadata, pending payment, calendar-month quota');
}
main().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>server.close(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});}));
