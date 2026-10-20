'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), http=require('node:http');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'csb-public-'));
let server, upstream, db;
async function main(){
  const requests=[];
  upstream=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req) body+=chunk;
    requests.push(JSON.parse(body));
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:'Test answer'}}]}));
  }).listen(0,'127.0.0.1');
  await require('node:events').once(upstream,'listening');
  Object.assign(process.env,{NODE_ENV:'test',CSB_DATA_DIR:temp,SESSION_SECRET:'public-regression-only-32-character-secret',PUBLIC_BASE_URL:'https://csb.example',LLM_API_KEY:'local-test',LLM_BASE_URL:'http://127.0.0.1:'+upstream.address().port,LLM_MODEL:'local-test',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:'',CSB_ENABLE_DEMO_KEY:'0',CSB_ALLOW_MOCK_BILLING:'0'});
  const app=require('../server');db=require('../db').db;
  server=app.listen(0,'127.0.0.1');await require('node:events').once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const req=(url,method='GET',body,cookie,extra={})=>fetch(base+url,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...extra},body:body?JSON.stringify(body):undefined});
  async function signup(email){
    const r=await req('/api/auth/signup','POST',{email,password:'test-password-123'});
    assert.equal(r.status,200);
    const c=r.headers.get('set-cookie');
    assert.match(c,/HttpOnly/i);assert.match(c,/Secure/i);assert.match(c,/SameSite=Lax/i);
    return c.split(';')[0];
  }
  const a=await signup('tenant-a@example.com'),b=await signup('tenant-b@example.com');
  const meA=await (await req('/api/admin/me','GET',null,a)).json();
  const meB=await (await req('/api/admin/me','GET',null,b)).json();
  const faq=await (await req('/api/admin/faqs','POST',{question:'Private A',answer:'Only A'},a)).json();
  assert.equal((await req('/api/admin/faqs/'+faq.id,'PUT',{question:'hacked',answer:'hacked'},b)).status,404);
  assert.equal((await req('/api/admin/faqs/'+faq.id,'DELETE',null,b)).status,404);
  assert.equal((await (await req('/api/admin/faqs','GET',null,b)).json()).faqs.length,0);
  assert.equal((await (await req('/api/admin/faqs','GET',null,a)).json()).faqs[0].answer,'Only A');
  const eid=db.prepare('INSERT INTO escalations(merchant_id,email,question) VALUES(?,?,?)').run(meA.merchant.id,'test@example.com','Private question').lastInsertRowid;
  assert.equal((await req('/api/admin/escalations/'+eid+'/resolve','POST',{},b)).status,404);
  assert.equal((await (await req('/api/admin/escalations','GET',null,b)).json()).escalations.length,0);
  const pre=await req('/api/chat','OPTIONS',null,null,{Origin:'https://merchant.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-api-key'});
  assert.equal(pre.status,204);assert.equal(pre.headers.get('access-control-allow-origin'),'*');
  for(const [key,message] of [[meA.apiKey,'Tenant A secret'],[meB.apiKey,'Tenant B question']]){
    const r=await req('/api/chat','POST',{message,session_key:'same-session'},null,{'x-api-key':key,Origin:'https://merchant.example'});
    assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),'*');
  }
  assert.equal(requests[0].messages.filter(m=>m.content==='Tenant A secret').length,1);
  assert.ok(!JSON.stringify(requests[1]).includes('Tenant A secret'));
  assert.ok(!JSON.stringify(requests[1]).includes('Only A'));
  assert.equal((await req('/api/admin/store','PUT',{brand_name:'bad'},a,{Origin:'https://evil.example'})).status,403);
  assert.equal((await req('/api/billing/upgrade-mock','POST',{price_key:'pro_monthly'},a)).status,403);
  assert.equal((await req('/api/demo/key')).status,404);
  const sign=require('cookie-signature').sign;
  const expired=sign('m:'+meA.merchant.id+'.'+(Date.now()-1000)+'.nonce',process.env.SESSION_SECRET);
  const expiredCookie='session='+encodeURIComponent('s:'+sign(expired,process.env.SESSION_SECRET));
  assert.equal((await req('/api/admin/me','GET',null,expiredCookie)).status,401);
  process.env.CSB_FREE_ONLY='1';
  assert.equal((await req('/api/billing/start-trial','POST',{},a)).status,403);
  const usage=await (await req('/api/admin/usage','GET',null,a)).json();
  assert.equal(usage.billing_enabled,false);
  db.prepare("UPDATE merchants SET monthly_convo_count=100,convo_count_reset_at=date('now') WHERE id=?").run(meA.merchant.id);
  const limited=await req('/api/chat','POST',{message:'Quota question',session_key:'quota'},null,{'x-api-key':meA.apiKey});
  assert.equal(limited.status,402);
  assert.equal((await limited.json()).upgrade_url,null);
  const callsBefore=requests.length;
  const handoff=await req('/api/chat','POST',{message:'Quota question',session_key:'quota',email:'quota@example.com'},null,{'x-api-key':meA.apiKey});
  assert.equal(handoff.status,200);assert.equal((await handoff.json()).escalated,true);
  assert.equal(requests.length,callsBefore);
  assert.equal(db.prepare('SELECT question FROM escalations WHERE email=?').get('quota@example.com').question,'Quota question');
  console.log('FREE MODE PASS: no trial, no upgrade URL, quota reached handoff preserves question without LLM call');
  let response;
  for(let i=0;i<21;i++) response=await req('/api/auth/login','POST',{email:'none@example.com',password:'wrong'});
  assert.equal(response.status,429);assert.ok(response.headers.get('retry-after'));
  console.log('PUBLIC REGRESSION OK: tenant FAQ/escalation/history isolation, widget CORS, single visitor turn, Secure cookies, expired session, origin checks, auth limit, demo/mock disabled');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  if(server) await new Promise(r=>server.close(r));
  if(upstream) await new Promise(r=>upstream.close(r));
  if(db) db.close();
  fs.rmSync(temp,{recursive:true,force:true});
});
