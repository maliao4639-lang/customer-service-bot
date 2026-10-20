(function () {
  'use strict';
  function load() {
    var config = document.querySelector('[data-shopreply-embed]');
    if (!config || document.getElementById('csb-root') || document.querySelector('script[data-shopreply-loader]')) return;
    var base = config.getAttribute('data-base-url');
    if (!/^https:\/\//.test(base || '')) return;
    var script = document.createElement('script');
    script.src = base + '/embed.js';
    script.async = true;
    script.setAttribute('data-shopreply-loader', 'true');
    script.setAttribute('data-shopify-app', 'true');
    script.setAttribute('data-api-key', config.getAttribute('data-api-key'));
    script.setAttribute('data-api-base', base);
    document.head.appendChild(script);
  }
  // Do not block storefront rendering. The AI API is only called on a question.
  function schedule() {
    if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 2000 });
    else window.setTimeout(load, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
  else schedule();
})();
