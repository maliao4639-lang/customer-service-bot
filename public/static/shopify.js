(function () {
  'use strict';
  var state;
  var busy = false;
  var $ = function (id) { return document.getElementById(id); };
  function status(text, error) {
    $('status').textContent = text;
    $('status').setAttribute('tone', error ? 'critical' : 'info');
  }
  async function api(route, method, body) {
    var token = await window.shopify.idToken();
    var response = await fetch('/shopify/api/' + route, {
      method: method || 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    try { await action(); } catch (e) { status(e.message, true); } finally { busy = false; }
  }
  function element(tag, text) { var e = document.createElement(tag); if (text) e.textContent = text; return e; }
  function addFaq(faq) {
    var row = element('div');
    var q = element('s-text-field'); q.setAttribute('label', 'Question'); q.value = faq.question || ''; q.className = 'faq-question';
    var a = element('s-text-area'); a.setAttribute('label', 'Answer'); a.value = faq.answer || ''; a.className = 'faq-answer';
    var remove = element('s-button', 'Remove FAQ'); remove.addEventListener('click', function () { row.remove(); });
    row.append(q, a, remove); $('faq-list').appendChild(row);
  }
  async function refresh(loadSettings) {
    state = await api('state');
    $('workspace').hidden = false;
    $('embed-link').href = state.embed_url;
    var planName = { free: 'Free', pro_monthly: 'Pro monthly', pro_annual: 'Pro annual' }[state.billing.tier] || 'Plan';
    $('usage').textContent = planName + ' · ' + state.merchant.used + ' of ' + state.cap + ' AI replies used this UTC month';
    $('cancel').disabled = !state.billing.subscription_id;
    if (loadSettings) {
      ['brand_name', 'shipping_info', 'return_policy', 'extra_info'].forEach(function (key) { $(key).value = state.merchant[key]; });
      $('faq-list').replaceChildren(); state.faqs.forEach(addFaq);
    }
    $('escalations').replaceChildren();
    if (!state.escalations.length) $('escalations').append(element('s-paragraph', 'No questions yet.'));
    state.escalations.forEach(function (item) {
      var box = element('s-section');
      box.append(element('s-paragraph', item.email + ' · ' + item.created_at + ' UTC'), element('s-paragraph', item.question));
      var button = element('s-button', item.resolved ? 'Resolved' : 'Mark resolved'); button.disabled = !!item.resolved;
      button.addEventListener('click', function () { run(async function () { await api('escalations/' + item.id + '/resolve', 'POST', {}); await refresh(false); }); });
      box.appendChild(button); $('escalations').appendChild(box);
    });
    $('privacy-requests').replaceChildren();
    if (!state.privacy_requests.length) $('privacy-requests').append(element('s-paragraph', 'No pending data requests.'));
    state.privacy_requests.forEach(function (item) {
      var row = element('div');
      row.append(element('s-paragraph', 'Received ' + new Date(item.created_at).toISOString()));
      var download = element('s-button', 'Download data export');
      download.addEventListener('click', function () { run(async function () {
        var data = await api('privacy/' + encodeURIComponent(item.id));
        var url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        var link = element('a'); link.href = url; link.download = 'shopreply-data-request.json'; link.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      }); });
      var complete = element('s-button', 'Delivered — remove export');
      complete.addEventListener('click', function () { run(async function () {
        await api('privacy/' + encodeURIComponent(item.id), 'DELETE'); await refresh(false); status('Export removed.');
      }); });
      row.append(download, complete); $('privacy-requests').appendChild(row);
    });
  }
  function upgrade(plan) { run(async function () {
    status('Opening Shopify to confirm your plan…');
    var data = await api('billing', 'POST', { plan: plan });
    if (data.confirmation_url) window.open(data.confirmation_url, '_top');
    else { await refresh(false); status('This plan is already active.'); }
  }); }
  $('add-faq').addEventListener('click', function () { addFaq({}); });
  var conversationCursor = null;
  function loadConversations(older) { run(async function () {
    var result = await api('conversations' + (older && conversationCursor ? '?before=' + conversationCursor : ''));
    if (!older) $('conversations').replaceChildren();
    if (!result.messages.length && !older) $('conversations').append(element('s-paragraph', 'No conversations yet.'));
    result.messages.forEach(function (m) {
      var row = element('s-section');
      row.append(element('s-paragraph', (m.role === 'user' ? 'Visitor' : 'Assistant') + ' · ' + m.created_at + ' UTC · Conversation ' + m.session_key.slice(0, 8)), element('s-paragraph', m.content));
      $('conversations').appendChild(row);
    });
    conversationCursor = result.next_before;
    $('older-conversations').style.display = conversationCursor ? '' : 'none';
    status('Conversation history loaded.');
  }); }
  $('load-conversations').addEventListener('click', function () { loadConversations(false); });
  $('older-conversations').addEventListener('click', function () { loadConversations(true); });
  $('save').addEventListener('click', function () { run(async function () {
    var body = {}; ['brand_name', 'shipping_info', 'return_policy', 'extra_info'].forEach(function (key) { body[key] = $(key).value || ''; });
    body.faqs = Array.from($('faq-list').children).map(function (row) { return { question: row.querySelector('.faq-question').value || '', answer: row.querySelector('.faq-answer').value || '' }; });
    await api('settings', 'PUT', body); status('Policies and FAQs saved.');
  }); });
  $('preview').addEventListener('click', function () { run(async function () {
    var data = await api('preview', 'POST', { message: $('preview-question').value || '' }); $('preview-answer').textContent = data.reply; status('Preview ready.');
  }); });
  $('monthly').addEventListener('click', function () { upgrade('pro_monthly'); });
  $('annual').addEventListener('click', function () { upgrade('pro_annual'); });
  $('refresh').addEventListener('click', function () { run(async function () { await refresh(false); status('Subscription status updated.'); }); });
  $('cancel').addEventListener('click', function () { $('cancel-confirm').hidden = false; });
  $('keep-plan').addEventListener('click', function () { $('cancel-confirm').hidden = true; });
  $('confirm-cancel').addEventListener('click', function () { run(async function () {
    await api('billing/cancel', 'POST', { confirmed: true }); $('cancel-confirm').hidden = true; await refresh(false); status('Paid subscription cancelled. Free plan is active.');
  }); });
  run(async function () {
    if (!window.shopify) throw new Error('Open GetShopReply from your Shopify admin to continue.');
    await Promise.all(['s-text-field', 's-text-area', 's-button'].map(function (name) { return customElements.whenDefined(name); }));
    await api('connect', 'POST', {}); await refresh(true); status('Connected. Complete the steps below to start answering questions.');
  });
})();
