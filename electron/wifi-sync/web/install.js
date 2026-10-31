(() => {
  'use strict';
  const panel = document.getElementById('phone-install');
  const bar = panel.querySelector('.phone-install-bar');
  const help = document.getElementById('phone-install-help');
  const button = document.getElementById('phone-pwa-install');
  const headerButton = document.getElementById('header-install');
  const closeButton = document.getElementById('phone-install-close');
  const status = document.getElementById('phone-pwa-status');
  const support = document.getElementById('phone-pwa-support');
  const connection = document.getElementById('phone-connection-status');
  const guide = document.getElementById('a2hs-guide');
  const guideSteps = document.getElementById('a2hs-steps');
  const guideClose = document.getElementById('a2hs-close');
  const dismissKey = 'still.installBarHidden';
  const brand = () => window.PhoneBrand?.current || { appName: 'MiLeo Photo Library', shortName: 'MiLeo', syncName: 'MiLeo Sync' };
  let prompt;
  let installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  const ua = navigator.userAgent || '';
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const platform = ipad || /iPhone|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : '';
  const iosOtherBrowser = platform === 'ios' && /CriOS|FxiOS|EdgiOS/.test(ua);
  if (platform) help.querySelectorAll('[data-platform]').forEach(node => { node.hidden = node.dataset.platform !== platform; });

  // Where the browser's own "Add to Home Screen" command lives, since pages cannot press it themselves.
  const guides = {
    android: { arrow: 'top-right', steps: ['Tap the <b>⋮</b> menu at the top-right of Chrome.', 'Tap <b>Add to Home screen</b> (or <b>Install app</b>).', 'Tap <b>Add</b>.'] },
    ios: { arrow: ipad ? 'top-right' : 'bottom', steps: [`Tap the <b>Share</b> button <span class="a2hs-share" aria-hidden="true">⬆︎</span> ${ipad ? 'at the top-right of Safari' : 'in Safari’s toolbar (bottom of the screen, or next to the address bar)'}.`, 'Scroll down and tap <b>Add to Home Screen</b>.', 'Tap <b>Add</b>.'] },
    ios_other: { arrow: '', steps: ['Open this page in <b>Safari</b> — only Safari can add it to the Home Screen on iPhone.', 'Tap <b>Share</b>, then <b>Add to Home Screen</b>.'] },
    other: { arrow: 'top-right', steps: ['Open the browser menu.', 'Choose <b>Add to Home screen</b> or <b>Install app</b>.'] }
  };

  function showGuide() {
    const chosen = guides[iosOtherBrowser ? 'ios_other' : platform || 'other'];
    guideSteps.innerHTML = chosen.steps.map(step => `<li>${step}</li>`).join('');
    guide.dataset.arrow = chosen.arrow;
    guide.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    guideClose.focus();
  }
  function hideGuide() { guide.hidden = true; button.setAttribute('aria-expanded', 'false'); }
  guideClose.addEventListener('click', hideGuide);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !guide.hidden) hideGuide(); });
  guide.addEventListener('click', event => { if (event.target === guide) hideGuide(); });

  function storage(action, value) {
    try { return action === 'get' ? localStorage.getItem(dismissKey) : action === 'set' ? localStorage.setItem(dismissKey, value) : localStorage.removeItem(dismissKey); }
    catch { return null; }
  }

  function render() {
    bar.hidden = installed || storage('get') === '1';
    headerButton.hidden = installed;
  }

  async function install() {
    if (!prompt) { showGuide(); return; }
    const pending = prompt;
    prompt = null;
    try {
      await pending.prompt();
      const choice = await pending.userChoice;
      status.textContent = choice.outcome === 'accepted' ? `Installation accepted. Look for ${brand().shortName} on your Home Screen.` : 'Installation dismissed. Tap Add to Home Screen again any time.';
    } catch (error) {
      status.textContent = `Installation could not start: ${error.message}. Use the steps instead.`;
      showGuide();
    }
  }

  button.addEventListener('click', install);
  headerButton.addEventListener('click', () => {
    storage('remove');
    render();
    install();
  });
  closeButton.addEventListener('click', () => { storage('set', '1'); render(); });

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    prompt = event;
    status.textContent = `This browser can install ${brand().syncName}. Tap Add to Home Screen.`;
  });
  window.addEventListener('appinstalled', () => {
    prompt = null;
    installed = true;
    render();
    status.textContent = `${brand().syncName} is installed. Open it from your Home Screen.`;
  });

  let checking = false;
  async function checkConnection() {
    if (checking) return;
    checking = true;
    try {
      if (!navigator.onLine) throw new Error('Phone is offline');
      const response = await fetch('/api/v1/ping', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Desktop returned ${response.status}`);
      connection.textContent = '';
    } catch {
      connection.textContent = `Desktop unavailable. Reconnect to the same Wi-Fi and keep ${brand().appName} running on the Desktop. Photos and sync are unavailable offline.`;
    } finally { checking = false; }
  }
  window.addEventListener('online', checkConnection);
  window.addEventListener('offline', checkConnection);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkConnection(); });
  checkConnection();

  const shortcutNote = () => `${brand().shortName} will be added as a Home Screen shortcut. Offline mode is off because this phone does not trust the Desktop’s security certificate yet — everything works normally while you are on the same Wi-Fi as the Desktop.`;
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      support.textContent = 'Offline app shell is ready; photos are never cached.';
    }).catch(error => {
      // An untrusted self-signed certificate makes registration fail; that is expected, not an install failure.
      console.warn('Service worker unavailable:', error);
      support.textContent = shortcutNote();
    });
  } else {
    support.textContent = shortcutNote();
  }

  render();
})();