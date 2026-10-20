'use strict';
(async function(){
  const status=document.getElementById('billing-status');
  const labels={pro_monthly:'Pro monthly — US$21/month',pro_annual:'Pro annual — US$205/year',growth_monthly:'Growth monthly',growth_annual:'Growth annual'};
  async function post(path,body){
    const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json();if(!response.ok)throw new Error(data.error || 'Payment service unavailable');return data;
  }
  try{
    const response=await fetch('/api/paddle/config',{credentials:'same-origin'});
    if(response.status===401){location.href='/admin';return;}
    if(!response.ok)throw new Error('Payment service unavailable');
    const config=await response.json();
    if(!config.enabled){status.textContent='Paid plans are not available yet. Your free account remains available.';return;}
    await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://cdn.paddle.com/paddle/v2/paddle.js';s.onload=resolve;s.onerror=reject;document.head.appendChild(s);});
    if(config.environment==='sandbox')Paddle.Environment.set('sandbox');
    Paddle.Initialize({token:config.client_token,eventCallback(event){if(event.name==='checkout.completed')status.textContent='Payment submitted. Your access updates after server verification; return to your dashboard shortly.';}});
    status.textContent=config.environment==='sandbox'?'Sandbox checkout — no real payment.':'Select a plan to review its price and billing terms at checkout.';
    for(const key of config.plans){
      const button=document.createElement('button');button.textContent=labels[key] || key;
      button.addEventListener('click',async()=>{button.disabled=true;try{const data=await post('/api/paddle/checkout',{price_key:key});Paddle.Checkout.open({transactionId:data.transaction_id});}catch(error){status.textContent=error.message;}finally{button.disabled=false;}});
      document.getElementById('billing-plans').appendChild(button);
    }
    const portal=document.getElementById('billing-portal');portal.hidden=false;
    portal.addEventListener('click',async()=>{try{const data=await post('/api/paddle/portal',{});location.assign(data.url);}catch(error){status.textContent=error.message;}});
  }catch(error){status.textContent=error.message || 'Could not load payments. Please try again later.';}
})();
