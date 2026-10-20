'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createPaddle,verifySignature}=require('../paddle');
const db=new DatabaseSync(':memory:');
db.exec("CREATE TABLE merchants(id INTEGER PRIMARY KEY,tier TEXT,trial_ends_at TEXT,monthly_convo_count INTEGER);INSERT INTO merchants VALUES(1,'free',NULL,73),(2,'free',NULL,18)");
const id=(prefix,n)=>prefix+'_'+String(n).padStart(26,'0');
let clock=Date.now(),calls=[];
const env={NODE_ENV:'test',PADDLE_ENABLED:'1',CSB_FREE_ONLY:'0',PADDLE_ENVIRONMENT:'sandbox',PADDLE_API_KEY:'test-only',PADDLE_CLIENT_TOKEN:'test_public',PADDLE_WEBHOOK_SECRET:'test-secret',PADDLE_PRICE_PRO_MONTHLY:id('pri',1)};
let subscriptionStatus='active',transactionStatus='ready',nextTransaction=1,apiFails=false;
const transactions=new Map();
const fetchImpl=async(url,opts)=>{
 calls.push({url,opts});if(apiFails)return {ok:false,status:403};
 let data;
 if(url.includes('/subscriptions/'))data={id:id('sub',1),customer_id:id('ctm',1),status:subscriptionStatus};
 else if(opts.method==='POST'){
  const body=JSON.parse(opts.body);data={id:id('txn',nextTransaction++),custom_data:body.custom_data,items:body.items.map(i=>({...i,price:{id:i.price_id}}))};transactions.set(data.id,data);
 }else data={...transactions.get(url.split('/').pop()),status:transactionStatus};
 return {ok:true,json:async()=>({data})};
};
const p=createPaddle({db,env,fetchImpl,now:()=>clock});
const raw=Buffer.from('{"hello":"world"}'),ts=Math.floor(clock/1000);
const h=crypto.createHmac('sha256',env.PADDLE_WEBHOOK_SECRET).update(ts+':').update(raw).digest('hex');
assert.equal(verifySignature(raw,'ts='+ts+';h1='+h,env.PADDLE_WEBHOOK_SECRET,clock),true);
assert.equal(verifySignature(Buffer.from('{}'),'ts='+ts+';h1='+h,env.PADDLE_WEBHOOK_SECRET,clock),false);
assert.equal(verifySignature(raw,'ts='+ts+';h1='+h,env.PADDLE_WEBHOOK_SECRET,clock+301000),false);
assert.equal(verifySignature(raw,'ts='+ts+';ts='+ts+';h1='+h,env.PADDLE_WEBHOOK_SECRET,clock),false);
function event(n,data,type='transaction.completed'){return {event_id:id('evt',n),event_type:type,data};}
async function main(){
 assert.equal(p.enabled,true);
 assert.equal(createPaddle({db,env:{...env,NODE_ENV:'production'}}).enabled,false);
 assert.equal(createPaddle({db,env:{...env,CSB_FREE_ONLY:'1'}}).enabled,false);
 await assert.rejects(()=>p.checkout(1,'lifetime_1'));
 const checkout=await p.checkout(1,'pro_monthly');assert.equal(checkout.transaction_id,id('txn',1));
 await p.checkout(1,'pro_monthly');assert.equal(calls.filter(c=>c.opts.method==='POST').length,1);
 const body=JSON.parse(calls[0].opts.body);assert.equal(body.items[0].price_id,env.PADDLE_PRICE_PRO_MONTHLY);assert.equal(body.items[0].quantity,1);
 const paid={id:id('txn',1),status:'completed',subscription_id:id('sub',1),customer_id:id('ctm',1),custom_data:body.custom_data,items:[{quantity:1,price:{id:env.PADDLE_PRICE_PRO_MONTHLY}}],billing_period:{starts_at:new Date(clock-1000).toISOString(),ends_at:new Date(clock+86400000).toISOString()}};
 assert.throws(()=>p.processEvent(event(1,{...paid,status:'paid'})));assert.equal(db.prepare('SELECT count(*) n FROM paddle_events').get().n,0);
 assert.throws(()=>p.processEvent(event(1,{...paid,custom_data:{csb_checkout:'forged'}})));
 assert.throws(()=>p.processEvent(event(1,{...paid,items:[{quantity:1,price:{id:id('pri',2)}}]})));
 db.exec("CREATE TRIGGER fail_paddle_event BEFORE INSERT ON paddle_events BEGIN SELECT RAISE(ABORT,'test failure'); END");
 assert.throws(()=>p.processEvent(event(1,paid)));
 assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'free');
 assert.equal(db.prepare('SELECT count(*) n FROM paddle_payments').get().n,0);
 db.exec('DROP TRIGGER fail_paddle_event');p.processEvent(event(1,paid));
 assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'pro_monthly');
 assert.equal(db.prepare('SELECT monthly_convo_count n FROM merchants WHERE id=1').get().n,73);
 assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=2').get().tier,'free');
 assert.equal(p.processEvent(event(1,paid)).duplicate,true);
 await assert.rejects(()=>p.checkout(1,'pro_monthly'));
 assert.throws(()=>p.processEvent(event(2,{...paid,id:id('txn',2),customer_id:id('ctm',2)})));
 p.processEvent(event(2,{...paid,id:id('txn',2),billing_period:{starts_at:new Date(clock).toISOString(),ends_at:new Date(clock+2*86400000).toISOString()}}));
 p.processEvent(event(3,{transaction_id:id('txn',1),status:'approved',action:'refund',type:'full'},'adjustment.updated'));
 assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'pro_monthly');
 p.processEvent(event(4,{transaction_id:id('txn',2),status:'approved',action:'refund',type:'full'},'adjustment.updated'));
 assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'free');
 p.processEvent(event(5,{...paid,id:id('txn',2)})); // late completion cannot undo a refund
 assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'free');
 p.processEvent(event(6,{transaction_id:id('txn',3),status:'approved',action:'refund',type:'full'},'adjustment.created'));
 p.processEvent(event(7,{...paid,id:id('txn',3)}));assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'free');
 p.processEvent(event(8,{...paid,id:id('txn',4)}));assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'pro_monthly');
 p.processEvent(event(9,{id:id('sub',1),status:'canceled'},'subscription.canceled'));
 assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'pro_monthly');
 subscriptionStatus='canceled';transactionStatus='completed';
 await assert.rejects(()=>p.checkout(1,'pro_monthly'),/paid period/);
 subscriptionStatus='active';
 clock+=3*86400000;p.refreshAll();assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'free');
 // Expiry alone must not permit a duplicate of an active/past-due subscription.
 await assert.rejects(()=>p.checkout(1,'pro_monthly'));
 subscriptionStatus='past_due';await assert.rejects(()=>p.checkout(1,'pro_monthly'));
 subscriptionStatus='canceled';transactionStatus='completed';
 apiFails=true;await assert.rejects(()=>p.checkout(1,'pro_monthly'));apiFails=false;
 nextTransaction=10;
 const again=await p.checkout(1,'pro_monthly');assert.equal(again.transaction_id,id('txn',10));
 assert.equal(db.prepare('SELECT monthly_convo_count n FROM merchants WHERE id=1').get().n,73);
 transactionStatus='ready';assert.equal((await p.checkout(1,'pro_monthly')).transaction_id,again.transaction_id);
 // A delayed successful checkout without a recorded entitlement must never create another charge.
 transactionStatus='completed';await assert.rejects(()=>p.checkout(1,'pro_monthly'));
 // Rejected/pending/partial refunds do not revoke the paid period.
 const nextPaid={...paid,id:id('txn',10),subscription_id:id('sub',10),custom_data:transactions.get(id('txn',10)).custom_data,
  billing_period:{starts_at:new Date(clock).toISOString(),ends_at:new Date(clock+86400000).toISOString()}};
 p.processEvent(event(10,nextPaid));
 for(const [n,status,type] of [[11,'pending_approval','full'],[12,'rejected','full'],[13,'approved','partial']]){
  p.processEvent(event(n,{transaction_id:nextPaid.id,status,action:'refund',type},'adjustment.updated'));
  assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'pro_monthly');
 }
 p.processEvent(event(14,{transaction_id:nextPaid.id,status:'approved',action:'refund',type:'full'},'adjustment.updated'));
 assert.equal(db.prepare('SELECT tier FROM merchants WHERE id=1').get().tier,'free');
 console.log('PADDLE REGRESSION PASS: signature/tamper/replay, disabled and sandbox isolation, server-priced checkout reuse, payment-only grants, merchant binding, atomic rollback/retry, idempotency, quota preserved, renewal, out-of-order full refunds, paid-period cancellation and expiry');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>db.close());
