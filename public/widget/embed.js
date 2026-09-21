/*!
 * Customer Service Bot – embed loader.
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
    if (!messagesEl.childElementCount) addBot("Hi! I'm the support assistant for this store. Ask me anything about shipping, returns, or product info.");
    setTimeout(function () { input.focus(); }, 50);
  }
  function close() {
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

  function setEmailRowVisible(visible) {
    emailRow.hidden = !visible;
    if (visible) {
      emailInput.value = visitorEmail;
      setTimeout(function () { emailInput.focus(); }, 30);
    }
  }

  function send(message) {
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
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
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
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
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
      fetch(apiBase + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ message: q, session_key: sessionKey, email: email }),
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (r) {
          if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
          if (!r.ok) { addBubble('bot', 'Something went wrong.'); return; }
          addBubble('bot', r.body.reply || '');
        })
        .catch(function () {
          if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
          addBubble('bot', 'Network error.');
        });
    }
  });

  // Expose minimal API
  window.CSB = { open: open, close: close };
})();