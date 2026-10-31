(() => {
  'use strict';
  // Applies the branding configured by the Desktop admin. Static MiLeo defaults are already in the HTML.
  const DEFAULTS = { appName: 'MiLeo Photo Library', shortName: 'MiLeo', syncName: 'MiLeo Sync', aiName: 'MiLeo AI', tagline: 'Your memories. Your library. Your world.', websiteUrl: '', logoUrl: '' };
  const CACHE_KEY = 'still-brand';
  let current = { ...DEFAULTS };

  const fill = template => String(template).replace(/\{(\w+)\}/g, (match, key) => (typeof current[key] === 'string' ? current[key] : match));
  function sanitize(value) {
    const next = { ...DEFAULTS };
    if (!value || typeof value !== 'object') return next;
    for (const key of Object.keys(DEFAULTS)) if (typeof value[key] === 'string' && (value[key] || key === 'websiteUrl' || key === 'logoUrl')) next[key] = value[key].slice(0, 400);
    if (!/^\/brand-logo\?v=[a-f0-9]{1,64}$/.test(next.logoUrl)) next.logoUrl = '';
    try { if (next.websiteUrl && !['http:', 'https:'].includes(new URL(next.websiteUrl).protocol)) next.websiteUrl = ''; } catch { next.websiteUrl = ''; }
    return next;
  }

  function apply(value) {
    current = sanitize(value);
    const root = document.documentElement;
    if (root.dataset.brandTitle) document.title = fill(root.dataset.brandTitle);
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', current.shortName);
    document.querySelectorAll('[data-brand]').forEach(node => { const text = current[node.dataset.brand]; if (typeof text === 'string') node.textContent = text; });
    document.querySelectorAll('[data-brand-text]').forEach(node => { node.textContent = fill(node.dataset.brandText); });
    document.querySelectorAll('[data-brand-label]').forEach(node => { node.setAttribute('aria-label', fill(node.dataset.brandLabel)); });
    document.querySelectorAll('img[data-brand-logo]').forEach(image => {
      if (!image.dataset.defaultSrc) image.dataset.defaultSrc = image.getAttribute('src');
      image.src = current.logoUrl || image.dataset.defaultSrc;
    });
    document.querySelectorAll('.logo').forEach(mark => {
      if (current.logoUrl) mark.replaceChildren(Object.assign(document.createElement('img'), { src: current.logoUrl, alt: '' }));
      else mark.textContent = (current.shortName.trim()[0] || 'M').toUpperCase();
      mark.classList.toggle('has-logo', Boolean(current.logoUrl));
    });
    document.querySelectorAll('a[data-brand-website]').forEach(link => {
      link.hidden = !current.websiteUrl;
      if (current.websiteUrl) link.href = current.websiteUrl; else link.removeAttribute('href');
    });
    window.dispatchEvent(new CustomEvent('brand:change', { detail: { ...current } }));
  }

  window.PhoneBrand = Object.freeze({ get current() { return { ...current }; } });
  try { apply(JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')); } catch { apply(null); }
  fetch('/api/v1/branding', { cache: 'no-cache' })
    .then(response => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
    .then(value => {
      apply(value);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(current)); } catch { /* storage may be full or disabled */ }
    })
    .catch(() => {});
})();
