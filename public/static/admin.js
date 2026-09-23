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

  // ----- Plan and usage ----------------------------------------------------
  var usageSummary = document.getElementById('usage-summary');
  var usageFill = document.getElementById('usage-fill');
  var usageText = document.getElementById('usage-text');
  var upgradeTiersEl = document.getElementById('upgrade-tiers');
  var upgradeMsg = document.getElementById('upgrade-msg');

  var TIER_LABEL = {
    free: 'Free',
    pro_monthly: 'Pro Monthly', pro_annual: 'Pro Annual',
    growth_monthly: 'Growth Monthly', growth_annual: 'Growth Annual',
    lifetime_1: 'Lifetime 1', lifetime_2: 'Lifetime 2', lifetime_3: 'Lifetime 3',
  };

  var PRICE_INFO = [
    { key: 'pro_monthly',    label: 'Pro Monthly',    price: '$21/mo',   convos: 500,   note: 'Most stores fit here.' },
    { key: 'pro_annual',     label: 'Pro Annual',     price: '$205/yr',  convos: 500,   note: 'About 17% off vs monthly.' },
    { key: 'growth_monthly', label: 'Growth Monthly', price: '$56/mo',   convos: 2000,  note: 'For 30K+ visits/mo.' },
    { key: 'growth_annual',  label: 'Growth Annual',  price: '$540/yr',  convos: 2000,  note: 'About 19% off vs monthly.' },
    { key: 'lifetime_1',     label: 'Lifetime 1',     price: '$350 once', convos: 1000,  note: 'Pay once, 1,000/mo forever.' },
    { key: 'lifetime_2',     label: 'Lifetime 2',     price: '$700 once', convos: 2000,  note: 'Pay once, 2,000/mo forever.' },
    { key: 'lifetime_3',     label: 'Lifetime 3',     price: '$1,400 once', convos: 5000, note: 'Pay once, 5,000/mo forever.' },
  ];

  function loadUsage() {
    fetch('/api/admin/usage', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var label = TIER_LABEL[data.tier] || data.tier;
        var pct = data.cap === Infinity ? 0 : Math.min(100, Math.round((data.used / data.cap) * 100));
        usageSummary.querySelector('.usage-tier').textContent = label;
        usageFill.style.width = pct + '%';
        usageFill.classList.toggle('usage-fill-warn', pct >= 80);
        usageText.textContent = data.used + ' of ' + data.cap + ' conversations used this month (resets ' + (data.reset_at || 'on the 1st') + ')';
        renderUpgradeTiers(data.tier);
      });
  }

  function renderUpgradeTiers(currentTier) {
    upgradeTiersEl.innerHTML = '';
    Promise.all([
      fetch('/api/admin/lifetime-availability', { credentials: 'include' }).then(function (r) { return r.json(); }).catch(function () { return { slots: [] }; }),
      Promise.resolve(),
    ]).then(function (results) {
      var slots = results[0].slots || [];
      var byTier = {};
      slots.forEach(function (s) { byTier[s.tier_key] = s.remaining; });
      PRICE_INFO.forEach(function (p) {
        var isCurrent = p.key === currentTier || (p.key === 'pro_monthly' && currentTier === 'pro_monthly');
        var row = document.createElement('div');
        row.className = 'upgrade-row' + (isCurrent ? ' current' : '');
        var remaining = p.key.indexOf('lifetime_') === 0 ? (byTier[p.key] != null ? byTier[p.key] : null) : null;
        var slotsLabel = remaining == null ? '' :
          (remaining <= 0
            ? '<span class="upgrade-slots sold-out">Sold out</span>'
            : '<span class="upgrade-slots">' + remaining + ' of ' + (p.key === 'lifetime_1' ? 120 : p.key === 'lifetime_2' ? 60 : 20) + ' left</span>');
        row.innerHTML =
          '<div class="upgrade-info">' +
            '<div class="upgrade-label">' + escapeHtml(p.label) + (isCurrent ? ' <span class="current-tag">current</span>' : '') + '</div>' +
            '<div class="upgrade-price">' + escapeHtml(p.price) + ' &middot; ' + p.convos + ' conversations/mo</div>' +
            '<div class="upgrade-note muted">' + escapeHtml(p.note) + '</div>' +
          '</div>' +
          '<div class="upgrade-action">' + slotsLabel +
            (isCurrent
              ? '<button class="link" disabled>Active</button>'
              : '<button class="primary upgrade-btn" data-key="' + p.key + '">Upgrade</button>') +
          '</div>';
        upgradeTiersEl.appendChild(row);
      });
      upgradeTiersEl.querySelectorAll('.upgrade-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { doUpgrade(btn.getAttribute('data-key')); });
      });
    });
  }

  function showUpgradeMsg(text, ok) {
    upgradeMsg.hidden = false;
    upgradeMsg.textContent = text;
    upgradeMsg.classList.toggle('upgrade-msg-ok', !!ok);
    upgradeMsg.classList.toggle('upgrade-msg-err', !ok);
    if (ok) setTimeout(function () { upgradeMsg.hidden = true; }, 3000);
  }

  function doUpgrade(priceKey) {
    upgradeMsg.hidden = true;
    fetch('/api/billing/upgrade-mock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ price_key: priceKey }),
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok || !r.body.ok) {
          showUpgradeMsg(r.body && r.body.error ? r.body.error : 'Upgrade failed.', false);
          return;
        }
        if (r.body.no_op) {
          showUpgradeMsg('You are already at ' + TIER_LABEL[r.body.tier] + ' or higher.', false);
        } else {
          var extra = r.body.lifetime_remaining != null ? ' (' + r.body.lifetime_remaining + ' Lifetime slots left)' : '';
          showUpgradeMsg('Upgraded to ' + TIER_LABEL[r.body.tier] + extra, true);
        }
        loadUsage();
      })
      .catch(function () { showUpgradeMsg('Network error.', false); });
  }

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
    loadUsage();
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