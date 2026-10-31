(() => {
  'use strict';
  // Applies admin-configurable branding to the desktop page. MiLeo defaults are used in the browser-only Preview.
  const DEFAULTS = Object.freeze({
    appName: 'MiLeo Photo Library',
    shortName: 'MiLeo',
    syncName: 'MiLeo Sync',
    aiName: 'MiLeo AI',
    tagline: 'Your memories. Your library. Your world.',
    websiteUrl: '',
    logo: ''
  });
  let current = { ...DEFAULTS };
  const safeLogo = value => (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value || '') ? value : '');
  const safeUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };

  function apply(value) {
    const next = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) if (value && typeof value[key] === 'string' && (value[key] || key === 'websiteUrl' || key === 'logo')) next[key] = value[key];
    next.logo = safeLogo(next.logo);
    next.websiteUrl = safeUrl(next.websiteUrl);
    current = next;
    document.title = next.appName;
    document.querySelectorAll('[data-brand]').forEach(node => { const text = next[node.dataset.brand]; if (typeof text === 'string') node.textContent = text; });
    document.querySelectorAll('a.brand').forEach(link => link.setAttribute('aria-label', `${next.appName} home`));
    document.querySelectorAll('.brand-mark').forEach(mark => {
      if (next.logo) {
        const image = mark.querySelector('img') || document.createElement('img');
        image.alt = '';
        image.src = next.logo;
        mark.replaceChildren(image);
        mark.classList.add('has-logo');
      } else {
        mark.textContent = (next.shortName.trim()[0] || 'M').toUpperCase();
        mark.classList.remove('has-logo');
      }
    });
    document.querySelectorAll('[data-brand-website]').forEach(link => {
      link.hidden = !next.websiteUrl;
      if (next.websiteUrl) { link.href = next.websiteUrl; link.title = next.websiteUrl; } else link.removeAttribute('href');
    });
    document.dispatchEvent(new CustomEvent('brand:change', { detail: { ...next } }));
  }

  window.AppBrand = Object.freeze({ get current() { return { ...current }; }, defaults: DEFAULTS });
  const start = () => {
    apply(current);
    const api = window.desktopBranding;
    if (!api) return;
    api.get().then(apply).catch(() => {});
    api.onChange(apply);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
