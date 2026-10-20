'use strict';
(()=>{
const status=document.getElementById('status');
try {
 if(!window.Paddle) throw new Error('Payment service could not load. Please refresh or contact support.');
 Paddle.Initialize({token:"live_8a16154970209781ec980231ec0",eventCallback(event){
  if(event.name==='checkout.completed') status.textContent='Payment submitted. Return to your account shortly to check your subscription status.';
  if(event.name==='checkout.closed') status.textContent='Checkout closed. You can return to your account or reopen the original payment link.';
  if(event.name==='checkout.error') status.textContent='Checkout could not complete. Please retry your original payment link or contact support.';
 }});
 status.textContent=new URLSearchParams(location.search).has('_ptxn')?'Opening secure checkout...':'Open the payment link from your account or Paddle email to continue.';
} catch(error){status.textContent=error.message || 'Payment service unavailable. Please contact support.';}
})();
