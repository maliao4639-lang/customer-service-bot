/*!
 * GetShopReply – embed loader.
 * Merchants paste exactly one <script> tag into their site:
 *   <script src="https://YOUR-HOST/embed.js" data-api-key="csb_xxx" defer></script>
 *
 * This loader reads its own attributes and then injects:
 *   - the widget stylesheet (once)
 *   - the widget UI (one bubble + one panel)
 * It exposes a tiny global `window.CSB` with `.open()` / `.close()`.
 */
(function () {
  'use strict';

  if (document.getElementById('csb-root')) return;
  // Resolve config from the loader <script> tag.
  var scripts = document.getElementsByTagName('script');
  var self = null;
  for (var i = scripts.length - 1; i >= 0; i--) {
    if (scripts[i].src && scripts[i].src.indexOf('/embed.js') !== -1) {
      self = scripts[i];
      break;
    }
  }
  var apiKey = self && self.getAttribute('data-api-key');
  var apiBase = (self && self.getAttribute('data-api-base')) || (self && self.src.replace(/\/embed\.js.*$/, ''));
  if (!apiKey) {
    console.warn('[csb] Missing data-api-key attribute on embed script.');
    return;
  }

  // Inject CSS once.
  if (!document.getElementById('csb-style')) {
    var link = document.createElement('link');
    link.id = 'csb-style';
    link.rel = 'stylesheet';
    link.href = apiBase + '/static/widget.css';
    document.head.appendChild(link);
  }

  // Build DOM.
  var root = document.createElement('div');
  root.id = 'csb-root';
  root.innerHTML = [
    '<button id="csb-bubble" type="button" aria-label="Open chat">',
    '  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>',
    '  <span id="csb-bubble-label">Chat</span>',
    '</button>',
    '<section id="csb-panel" hidden role="dialog" aria-label="Customer support chat">',
    '  <header id="csb-header">',
    '    <strong id="csb-title">Customer Support</strong>',
    '    <button id="csb-close" type="button" aria-label="Close chat">&times;</button>',
    '  </header>',
    '  <div id="csb-messages" aria-live="polite"></div>',
    '  <div id="csb-email-row" hidden>',
    '    <input id="csb-email" type="email" placeholder="Your email" autocomplete="email" />',
    '    <button id="csb-email-send" type="button">Save</button>',
    '  </div>',
    '  <form id="csb-form">',
    '    <input id="csb-input" type="text" placeholder="Type your question..." autocomplete="off" maxlength="2000" />',
    '    <button id="csb-send" type="submit">Send</button>',
    '  </form>',
    '</section>',
  ].join('');
  document.body.appendChild(root);

  // State
  var sessionKey = readStorage('csb_session') || (function () {
    var k = '';
    try { k = cryptoRandom(12); } catch (e) { k = String(Date.now()) + Math.random().toString(36).slice(2); }
    writeStorage('csb_session', k);
    return k;
  })();
  var visitorEmail = readStorage('csb_email') || '';
  var pendingQuestion = null;
  var quotaReached = false;

  // Elements
  var bubble = document.getElementById('csb-bubble');
  var panel = document.getElementById('csb-panel');
  var closeBtn = document.getElementById('csb-close');
  var messagesEl = document.getElementById('csb-messages');
  var form = document.getElementById('csb-form');
  var input = document.getElementById('csb-input');
  var sendBtn = document.getElementById('csb-send');
  var emailRow = document.getElementById('csb-email-row');
  var emailInput = document.getElementById('csb-email');
  var emailSendBtn = document.getElementById('csb-email-send');
  var orderLookupEnabled = false;
  var orderView = document.createElement('div');
  orderView.id = 'csb-order-view';
  orderView.hidden = true;
  orderView.innerHTML = [
    '<button type="button" id="csb-order-back">Back to chat</button>',
    '<h3>Find your order</h3>',
    '<p>Use the exact order number and checkout email. We will email a code to verify access.</p>',
    '<form id="csb-order-details">',
    '<label for="csb-order-number">Order number</label><input id="csb-order-number" placeholder="#1001" maxlength="41" autocomplete="off" required>',
    '<label for="csb-order-email">Checkout email</label><input id="csb-order-email" type="email" maxlength="254" autocomplete="off" required>',
    '<button type="submit">Email me a code</button></form>',
    '<p id="csb-order-message" role="status" aria-live="polite"></p>',
    '<form id="csb-order-verify" hidden>',
    '<label for="csb-order-code">Six-digit code</label><input id="csb-order-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>',
    '<button type="submit">View order status</button>',
    '<button type="button" id="csb-order-restart">Request another code</button></form>',
    '<div id="csb-order-result" hidden></div>',
    '<p class="csb-order-note">Only use this form for order lookup. Details entered here are not sent to the AI chat. Older orders or orders without an email may require help from the store.</p>',
    '<a id="csb-order-privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a>'
  ].join('');
  panel.insertBefore(orderView, messagesEl);
  var orderButton = document.createElement('button');
  orderButton.type = 'button'; orderButton.id = 'csb-order-open'; orderButton.textContent = 'Where is my order?'; orderButton.hidden = true;
  panel.insertBefore(orderButton, orderView);
  document.getElementById('csb-order-privacy').href = apiBase + '/privacy';
  var orderDetails = document.getElementById('csb-order-details');
  var orderVerify = document.getElementById('csb-order-verify');
  var orderMessage = document.getElementById('csb-order-message');
  var orderResult = document.getElementById('csb-order-result');
  var orderRestart = document.getElementById('csb-order-restart');
  var orderSession = '', orderChallenge = '', orderGeneration = 0, orderTimer, resultTimer;
  function orderRequest(endpoint, data) {
    return fetch(apiBase + '/api/order-lookup/' + endpoint, {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey }, body: JSON.stringify(data)
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || 'Order lookup is unavailable. Please contact the store.');
        return body;
      });
    });
  }
  if (!self.hasAttribute('data-shopify-app')) orderRequest('capabilities', {}).then(function (value) {
    orderLookupEnabled = value.enabled === true;
    orderButton.hidden = !orderLookupEnabled;
  }).catch(function () { /* Disabled stores keep the existing chat experience. */ });
  function clearOrder() {
    ++orderGeneration;
    if (orderChallenge && orderSession) orderRequest('cancel', { challenge: orderChallenge, session: orderSession }).catch(function () {});
    orderChallenge = ''; orderSession = '';
    clearTimeout(orderTimer); clearTimeout(resultTimer);
    orderDetails.reset(); orderVerify.reset();
    orderDetails.hidden = false; orderVerify.hidden = true; orderResult.hidden = true;
    orderResult.replaceChildren(); orderMessage.textContent = '';
    orderView.querySelectorAll('button').forEach(function (button) { button.disabled = false; });
  }
  function leaveOrders() {
    clearOrder(); orderView.hidden = true; messagesEl.hidden = false; form.hidden = false;
    orderButton.hidden = !orderLookupEnabled; input.focus();
  }
  function showOrders() {
    clearOrder();
    try { orderSession = cryptoRandom(32); } catch (_) { return; }
    orderView.hidden = false; messagesEl.hidden = true; form.hidden = true; emailRow.hidden = true; orderButton.hidden = true;
    document.getElementById('csb-order-number').focus();
  }
  function setOrderBusy(formEl, busy) {
    formEl.querySelector('button[type="submit"]').disabled = busy;
  }
  orderButton.addEventListener('click', showOrders);
  document.getElementById('csb-order-back').addEventListener('click', leaveOrders);
  orderDetails.addEventListener('submit', function (event) {
    event.preventDefault();
    var generation = orderGeneration;
    setOrderBusy(orderDetails, true); orderMessage.textContent = 'Requesting a code…';
    orderRequest('start', { order: document.getElementById('csb-order-number').value.trim(),
      email: document.getElementById('csb-order-email').value.trim(), session: orderSession }).then(function (value) {
      if (generation !== orderGeneration) return;
      orderChallenge = value.challenge; orderDetails.hidden = true; orderVerify.hidden = false;
      orderMessage.textContent = value.message + ' Codes expire in 5 minutes.';
      document.getElementById('csb-order-code').focus();
      orderRestart.disabled = true;
      orderTimer = setTimeout(function () { orderRestart.disabled = false; }, value.resend_after * 1000);
    }).catch(function (error) {
      if (generation === orderGeneration) orderMessage.textContent = error.message;
    }).finally(function () { if (generation === orderGeneration) setOrderBusy(orderDetails, false); });
  });
  orderRestart.addEventListener('click', showOrders);
  function resultLine(parent, tag, text) {
    var node = document.createElement(tag); node.textContent = text; parent.appendChild(node); return node;
  }
  orderVerify.addEventListener('submit', function (event) {
    event.preventDefault();
    var generation = orderGeneration;
    setOrderBusy(orderVerify, true);
    orderMessage.textContent = 'Verifying…';
    orderRequest('verify', { challenge: orderChallenge, session: orderSession,
      code: document.getElementById('csb-order-code').value.trim() }).then(function (value) {
      if (generation !== orderGeneration) return;
      orderChallenge = ''; orderVerify.reset(); orderVerify.hidden = true;
      orderDetails.reset(); orderMessage.textContent = '';
      orderResult.replaceChildren(); orderResult.hidden = false;
      resultLine(orderResult, 'h4', value.result.status);
      value.result.shipments.forEach(function (shipment, index) {
        var section = document.createElement('section'); orderResult.appendChild(section);
        resultLine(section, 'strong', 'Fulfillment ' + (index + 1) + ': ' + shipment.status);
        shipment.tracking.forEach(function (tracking) {
          resultLine(section, 'p', (tracking.carrier || 'Carrier not provided') + (tracking.number ? ' · ' + tracking.number : ' · Tracking number not provided'));
          if (tracking.url && /^https:\/\//.test(tracking.url)) {
            var link = resultLine(section, 'a', 'Track shipment'); link.href = tracking.url;
            link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
          }
        });
        if (!shipment.tracking.length) resultLine(section, 'p', 'Tracking has not been provided.');
      });
      if (!value.result.shipments.length) resultLine(orderResult, 'p', 'No shipment details are available yet.');
      resultLine(orderResult, 'p', value.result.note);
      resultLine(orderResult, 'small', 'Source: ' + value.result.source);
      resultTimer = setTimeout(function () { showOrders(); orderMessage.textContent = 'For your privacy, the result has been cleared. Verify again to view it.'; }, value.expires_in * 1000);
    }).catch(function (error) {
      if (generation === orderGeneration) orderMessage.textContent = error.message;
    }).finally(function () { if (generation === orderGeneration) setOrderBusy(orderVerify, false); });
  });
  window.addEventListener('pagehide', clearOrder);

  function cryptoRandom(bytes) {
    var arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.prototype.map.call(arr, function (b) { return (b + 0x100).toString(16).slice(1); }).join('');
  }

  function readStorage(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function writeStorage(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function open() {
    panel.hidden = false;
    bubble.setAttribute('aria-expanded', 'true');
    if (!messagesEl.childElementCount) addBubble('bot', "Hi! I'm the support assistant for this store. Ask me anything about shipping, returns, or product info.");
    setTimeout(function () { input.focus(); }, 50);
  }
  function close() {
    if (!orderView.hidden) leaveOrders();
    panel.hidden = true;
    bubble.setAttribute('aria-expanded', 'false');
  }
  function toggle() { panel.hidden ? open() : close(); }

  function addBubble(role, text) {
    var el = document.createElement('div');
    el.className = 'csb-msg csb-msg-' + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Renders a special card when the store has hit its monthly reply limit
  // (HTTP 402). Disables input so the visitor doesn't loop into another 402.
  function addUpgradeCard(used, cap, upgradeUrl) {
    var el = document.createElement('div');
    el.className = 'csb-msg csb-msg-bot csb-upgrade-card';
    el.innerHTML = [
      '<div class="csb-upgrade-eyebrow">Monthly limit reached</div>',
      '<div class="csb-upgrade-title">This store is out of instant replies for now</div>',
      '<div class="csb-upgrade-body">Leave your email below so the store’s support team can follow up.</div>',
      '<div class="csb-upgrade-foot">' + (used || '?') + ' / ' + (cap || '?') + ' used this month</div>'
    ].join('');
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Lock input so the visitor can't fire another 402 by typing more.
    input.disabled = true;
    sendBtn.disabled = true;
    input.placeholder = 'Monthly limit reached — leave your email below.';
    // Encourage the email fallback so the lead isn't lost.
    quotaReached = true;
    setEmailRowVisible(true);
  }

  function setEmailRowVisible(visible) {
    emailRow.hidden = !visible;
    if (visible) {
      emailInput.value = visitorEmail;
      setTimeout(function () { emailInput.focus(); }, 30);
    }
  }

  function send(message) {
    if (orderLookupEnabled && /where.*order|track.*order|order.*status|订单|物流|查单/i.test(message)) {
      showOrders(); return;
    }
    pendingQuestion = message;
    addBubble('user', message);
    sendBtn.disabled = true;
    input.disabled = true;
    addBubble('bot', '…');

    var placeholder = messagesEl.lastChild;

    fetch(apiBase + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ message: message, session_key: sessionKey, email: visitorEmail || undefined }),
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (r) {
        if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
        if (r.status === 402) {
          pendingQuestion = message;
          addUpgradeCard(r.body.used, r.body.cap, r.body.upgrade_url);
          return;
        }
        if (!r.ok) {
          addBubble('bot', r.body && r.body.error ? r.body.error : 'Something went wrong. Please try again.');
          return;
        }
        addBubble('bot', r.body.reply || '');
        if (r.body.needs_email) {
          pendingQuestion = message;
          setEmailRowVisible(true);
        }
      })
      .catch(function () {
        if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
        addBubble('bot', 'Network error. Please try again.');
      })
      .then(function () {
        sendBtn.disabled = quotaReached;
        input.disabled = quotaReached;
        if (!quotaReached) input.focus();
      });
  }

  bubble.addEventListener('click', toggle);
  closeBtn.addEventListener('click', close);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text);
  });

  emailSendBtn.addEventListener('click', function () {
    var email = emailInput.value.trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      emailInput.focus();
      return;
    }
    visitorEmail = email;
    writeStorage('csb_email', email);
    setEmailRowVisible(false);
    if (pendingQuestion) {
      var q = pendingQuestion;
      pendingQuestion = null;
      addBubble('user', q + '  (email: ' + email + ')');
      addBubble('bot', '…');
      var placeholder = messagesEl.lastChild;
      emailSendBtn.disabled = true;
      fetch(apiBase + '/api/chat/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ message: q, session_key: sessionKey, email: email }),
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
        .then(function (r) {
          if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
          if (r.status === 402) {
            addUpgradeCard(r.body.used, r.body.cap, r.body.upgrade_url);
            return;
          }
          if (!r.ok) { pendingQuestion = q; setEmailRowVisible(true); addBubble('bot', 'Could not save your question. Please try again.'); return; }
          addBubble('bot', r.body.reply || '');
        })
        .catch(function () {
          if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
          pendingQuestion = q;
          setEmailRowVisible(true);
          addBubble('bot', 'Network error. Please try saving again.');
        })
        .then(function () { emailSendBtn.disabled = false; });
    }
  });

  // Expose minimal API
  window.CSB = { open: open, close: close };
})();
