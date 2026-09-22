'use strict';

(function () {
  // ----- Auth state ---------------------------------------------------------
  var mode = 'login';
  var authView = document.getElementById('auth-view');
  var consoleView = document.getElementById('console-view');
  var authForm = document.getElementById('auth-form');
  var authError = document.getElementById('auth-error');
  var who = document.getElementById('who');
  var logoutBtn = document.getElementById('logout-btn');

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      mode = t.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === t); });
      authError.hidden = true;
    });
  });

  authForm.addEventListener('submit', function (e) {
    e.preventDefault();
    authError.hidden = true;
    var fd = new FormData(authForm);
    var url = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: fd.get('email'),
        password: fd.get('password'),
      }),
      credentials: 'include',
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok) { authError.textContent = r.body.error || 'Failed'; authError.hidden = false; return; }
        showConsole();
      })
      .catch(function () { authError.textContent = 'Network error'; authError.hidden = false; });
  });

  logoutBtn.addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).then(function () { showAuth(); });
  });

  function showAuth() {
    authView.hidden = false;
    consoleView.hidden = true;
  }
  function showConsole() {
    authView.hidden = true;
    consoleView.hidden = false;
    loadAll();
  }

  // ----- Store info ---------------------------------------------------------
  var storeForm = document.getElementById('store-form');
  var storeSaved = document.getElementById('store-saved');

  storeForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(storeForm);
    var body = {
      brand_name: fd.get('brand_name'),
      return_policy: fd.get('return_policy'),
      shipping_info: fd.get('shipping_info'),
      extra_info: fd.get('extra_info'),
    };
    fetch('/api/admin/store', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok) { alert(r.body.error || 'Save failed'); return; }
        storeSaved.hidden = false;
        setTimeout(function () { storeSaved.hidden = true; }, 1800);
      });
  });

  // ----- FAQs ---------------------------------------------------------------
  var faqForm = document.getElementById('faq-form');
  var faqList = document.getElementById('faq-list');

  faqForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(faqForm);
    fetch('/api/admin/faqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: fd.get('question'), answer: fd.get('answer') }),
      credentials: 'include',
    })
      .then(function (r) { return r.json(); })
      .then(function () { faqForm.reset(); loadFaqs(); });
  });

  function loadFaqs() {
    fetch('/api/admin/faqs', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        faqList.innerHTML = '';
        data.faqs.forEach(function (f) { faqList.appendChild(renderFaq(f)); });
      });
  }

  function renderFaq(f) {
    var li = document.createElement('li');
    li.dataset.id = f.id;
    li.innerHTML =
      '<div class="q"></div><div class="a"></div>' +
      '<div class="row">' +
        '<button class="link edit-btn">Edit</button>' +
        '<button class="link del-btn">Delete</button>' +
      '</div>';
    li.querySelector('.q').textContent = f.question;
    li.querySelector('.a').textContent = f.answer;

    li.querySelector('.edit-btn').addEventListener('click', function () { startEdit(li, f); });
    li.querySelector('.del-btn').addEventListener('click', function () {
      if (!confirm('Delete this FAQ?')) return;
      fetch('/api/admin/faqs/' + f.id, { method: 'DELETE', credentials: 'include' }).then(loadFaqs);
    });
    return li;
  }

  function startEdit(li, f) {
    li.innerHTML =
      '<label>Question<input type="text" class="q-input" /></label>' +
      '<label>Answer<textarea rows="3" class="a-input"></textarea></label>' +
      '<div class="row"><button class="link save-btn">Save</button><button class="link cancel-btn">Cancel</button></div>';
    li.querySelector('.q-input').value = f.question;
    li.querySelector('.a-input').value = f.answer;
    li.querySelector('.save-btn').addEventListener('click', function () {
      var q = li.querySelector('.q-input').value.trim();
      var a = li.querySelector('.a-input').value.trim();
      if (!q || !a) return;
      fetch('/api/admin/faqs/' + f.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, answer: a }),
        credentials: 'include',
      }).then(loadFaqs);
    });
    li.querySelector('.cancel-btn').addEventListener('click', loadFaqs);
  }

  // ----- Embed snippet ------------------------------------------------------
  var snippetEl = document.getElementById('snippet');
  var copyBtn = document.getElementById('copy-snippet');
  copyBtn.addEventListener('click', function () {
    navigator.clipboard.writeText(snippetEl.textContent).then(function () {
      copyBtn.textContent = 'Copied ✓';
      setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
    });
  });

  // ----- Escalations --------------------------------------------------------
  var escalationsEl = document.getElementById('escalations');

  function loadEscalations() {
    fetch('/api/admin/escalations', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        escalationsEl.innerHTML = '';
        if (!data.escalations.length) {
          var li = document.createElement('li');
          li.className = 'muted';
          li.textContent = 'Nothing here yet.';
          escalationsEl.appendChild(li);
          return;
        }
        data.escalations.forEach(function (e) {
          var item = document.createElement('li');
          if (e.resolved) item.className = 'resolved';
          item.innerHTML =
            '<div class="meta"><strong></strong> &middot; ' + escapeHtml(e.created_at) + '</div>' +
            '<div class="q"></div>' +
            (e.resolved ? '' : '<div class="row"><button class="link resolve-btn">Mark resolved</button></div>');
          item.querySelector('strong').textContent = e.email;
          item.querySelector('.q').textContent = e.question;
          if (!e.resolved) {
            item.querySelector('.resolve-btn').addEventListener('click', function () {
              fetch('/api/admin/escalations/' + e.id + '/resolve', { method: 'POST', credentials: 'include' }).then(loadEscalations);
            });
          }
          escalationsEl.appendChild(item);
        });
      });
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ----- Bootstrap ----------------------------------------------------------
  function loadAll() {
    fetch('/api/admin/me', { credentials: 'include' })
      .then(function (r) {
        if (r.status === 401) { showAuth(); return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        who.textContent = data.merchant.email;
        var m = data.merchant;
        storeForm.brand_name.value = m.brand_name || '';
        storeForm.return_policy.value = m.return_policy || '';
        storeForm.shipping_info.value = m.shipping_info || '';
        storeForm.extra_info.value = m.extra_info || '';
      });
    loadFaqs();
    loadEscalations();
    fetch('/api/admin/embed-snippet', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (data) { snippetEl.textContent = data.snippet; });
  }

  // Initial probe: are we already logged in?
  fetch('/api/admin/me', { credentials: 'include' })
    .then(function (r) {
      if (r.ok) showConsole();
      // Not logged in: default to Sign up tab so first-time visitors see the right form.
      else { mode = 'signup'; document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-tab') === 'signup'); }); }
    });
})();