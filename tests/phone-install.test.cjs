'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'install-phone.js'), 'utf8');

function setup({ desktop = true, canSync = true } = {}) {
  const nodes = new Map();
  const listeners = {};
  const timers = new Map();
  let nextTimer = 0;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', hidden: false, value: '', open: false, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      removeAttribute(name) { delete this[name]; },
      showModal() { this.open = true; },
      close() { this.open = false; this.listeners.close(); },
      focus() {}, select() {}
    });
    return nodes.get(id);
  };
  let status = { running: false, url: 'https://192.168.1.2:8443', libraries: [{}], devices: [], pairing: null, fingerprint: 'AA:BB' };
  let eventHandler;
  let starts = 0; let pairs = 0; let failure = '';
  const pairing = { code: 'ABCD-EFGH', link: 'https://192.168.1.2:8443/app#code=ABCDEFGH', qr: 'data:image/png;base64,abc', expiresAt: Date.now() + 120000 };
  const api = {
    status: async () => ({ ok: true, status }),
    start: async () => { starts++; status.running = true; return { ok: true, status }; },
    pair: async () => { pairs++; if (failure) return { ok: false, error: failure }; status.pairing = pairing; return { ok: true, pairing }; },
    onEvent: callback => { eventHandler = callback; }
  };
  const context = vm.createContext({
    window: { wifiSync: desktop ? api : undefined },
    document: { getElementById: node, body: { dataset: { canSync: String(canSync) } }, addEventListener: (name, callback) => { listeners[name] = callback; } },
    navigator: { clipboard: { writeText: async value => { context.copied = value; } } },
    setInterval: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval: id => timers.delete(id),
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(script, context);
  return {
    node, context, pairing, timers, status, api,
    counts: () => ({ starts, pairs }),
    emit: event => eventHandler(event),
    fail: message => { failure = message; },
    open: () => node('install-phone').listeners.click(),
    connect: () => node('phone-install-connect').listeners.click(),
    tick: () => { for (const callback of [...timers.values()]) callback(); }
  };
}

test('Install on Phone starts the existing server, pairs and copies the real URL', async () => {
  const h = setup();
  await h.open();
  assert.equal(h.node('phone-install-dialog').open, true);
  assert.match(h.node('phone-install-status').textContent, /stopped/);
  await h.connect();
  assert.deepEqual(h.counts(), { starts: 1, pairs: 1 });
  assert.equal(h.node('phone-install-qr').src, h.pairing.qr);
  assert.equal(h.node('phone-install-url').value, h.pairing.link);
  await h.node('phone-install-copy').listeners.click();
  assert.equal(h.context.copied, h.pairing.link);
  h.pairing.expiresAt = Date.now() - 1;
  h.tick();
  assert.equal(h.node('phone-install-qr').hidden, true);
  assert.equal(h.node('phone-install-url').value, `${h.status.url}/app`);
  h.node('phone-install-dialog').close();
  assert.equal(h.timers.size, 0);
});

test('existing server is reused and consumed pairing codes are removed', async () => {
  const h = setup(); h.status.running = true;
  await h.open(); await h.connect();
  assert.equal(h.counts().starts, 0);
  h.emit({ type: 'device-paired' }); h.tick();
  assert.equal(h.node('phone-install-qr').hidden, true);
  assert.equal(h.node('phone-install-url').value, `${h.status.url}/app`);
});

test('browser Preview and viewers receive explicit guidance without enabling pairing', async () => {
  for (const options of [{ desktop: false }, { canSync: false }]) {
    const h = setup(options);
    await h.open();
    assert.equal(h.node('phone-install-connect').disabled, true);
    assert.match(h.node('phone-install-status').textContent, options.desktop === false ? /MiLeo Photo Library desktop app/ : /Editor/);
    assert.deepEqual(h.counts(), { starts: 0, pairs: 0 });
  }
});

test('pairing failures are visible and do not display a success QR', async () => {
  const h = setup(); await h.open(); h.fail('No private LAN address');
  await h.connect();
  assert.match(h.node('phone-install-error').textContent, /No private LAN address/);
  assert.equal(h.node('phone-install-error').hidden, false);
  assert.equal(h.node('phone-install-qr').hidden, true);
});

test('missing libraries disable setup and Escape closes the modal and clears timers', async () => {
  const h = setup(); h.status.libraries = [];
  await h.open();
  assert.equal(h.node('phone-install-connect').disabled, true);
  assert.match(h.node('phone-install-status').textContent, /Add a photo folder/);
  h.node('phone-install-dialog').listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.node('phone-install-dialog').open, false);
  assert.equal(h.timers.size, 0);
});

test('clipboard failure selects the URL and reports a manual-copy fallback', async () => {
  const h = setup(); await h.open(); await h.connect();
  h.context.navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
  await h.node('phone-install-copy').listeners.click();
  assert.match(h.node('phone-install-error').textContent, /Copy the selected URL manually/);
  assert.equal(h.node('phone-install-url').value, h.pairing.link);
});

test('mobile install button invokes the browser prompt and handles acceptance or dismissal', async () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'electron', 'wifi-sync', 'web', 'install.js'), 'utf8');
  for (const outcome of ['accepted', 'dismissed']) {
    const listeners = {};
    const nodes = {};
    const store = {};
    const node = id => nodes[id] ||= {
      textContent: '', innerHTML: '', hidden: false, attributes: {}, dataset: {},
      focus() {},
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector: selector => node(selector),
      querySelectorAll: () => [],
      addEventListener: (name, callback) => { listeners[`${id}:${name}`] = callback; }
    };
    let rejectRegistration;
    const context = vm.createContext({
      window: { isSecureContext: true, matchMedia: () => ({ matches: false }), scrollTo() {}, addEventListener: (name, callback) => { listeners[name] = callback; } },
      document: { getElementById: node, addEventListener() {} },
      localStorage: { getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = value; }, removeItem: key => { delete store[key]; } },
      navigator: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130', serviceWorker: { register: () => new Promise((_, reject) => { rejectRegistration = reject; }) } },
      console: { warn() {} }, AbortSignal,
      fetch: async () => ({ ok: true })
    });
    vm.runInContext(code, context);
    const bar = node('.phone-install-bar');
    const guide = node('a2hs-guide');
    assert.equal(bar.hidden, false);
    assert.equal(node('header-install').hidden, false);

    rejectRegistration(new Error('An SSL certificate error occurred when fetching the script.'));
    await new Promise(resolve => setImmediate(resolve));
    const note = node('phone-pwa-support').textContent;
    assert.match(note, /Home Screen shortcut/);
    assert.doesNotMatch(note, /SSL|failed|unavailable:/i, 'certificate failure is explained, not shown as a raw error');

    guide.hidden = true;
    await listeners['phone-pwa-install:click']();
    assert.equal(guide.hidden, false, 'without a browser prompt the button shows where Add to Home Screen is');
    assert.equal(guide.dataset.arrow, 'top-right');
    assert.match(node('a2hs-steps').innerHTML, /⋮.*Add to Home screen/s);
    listeners['a2hs-close:click']();
    assert.equal(guide.hidden, true);
    listeners['phone-install-close:click']();
    assert.equal(bar.hidden, true);
    assert.equal(store['still.installBarHidden'], '1');

    let prompted = 0; let prevented = false;
    listeners.beforeinstallprompt({
      preventDefault() { prevented = true; },
      prompt: async () => { prompted++; },
      userChoice: Promise.resolve({ outcome })
    });
    assert.equal(prevented, true);
    await listeners['header-install:click']();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bar.hidden, false, 'header button restores the install bar');
    assert.equal(prompted, 1);
    assert.match(node('phone-pwa-status').textContent, outcome === 'accepted' ? /accepted/ : /dismissed/);
    listeners.appinstalled();
    assert.match(node('phone-pwa-status').textContent, /MiLeo Sync is installed/);
    assert.equal(bar.hidden, true);
    assert.equal(node('header-install').hidden, true);
  }
});

test('service worker caches only the public shell and never intercepts APIs or photos', async () => {
  const handlers = {}; const cachedFiles = []; const deleted = [];
  const context = vm.createContext({
    URL, Response,
    self: { location: { origin: 'https://still.local' }, clients: { claim() {} }, addEventListener: (name, callback) => { handlers[name] = callback; } },
    caches: {
      open: async () => ({ addAll: async files => cachedFiles.push(...files) }),
      keys: async () => ['still-shell-v0', 'unrelated-cache'],
      delete: async key => deleted.push(key),
      match: async pathname => ({ pathname })
    },
    fetch: async () => { throw new Error('Offline'); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'electron', 'wifi-sync', 'web', 'sw.js'), 'utf8'), context);
  await new Promise((resolve, reject) => handlers.install({ waitUntil: promise => promise.then(resolve, reject) }));
  assert.ok(cachedFiles.includes('/app'));
  assert.ok(cachedFiles.every(file => !file.includes('/api/')));
  for (const file of cachedFiles) {
    const filename = file === '/app' ? 'app.html' : file === '/pair' ? 'index.html' : file === '/device' ? 'device.html' : file.slice(1);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'electron', 'wifi-sync', 'web', filename)), file);
  }
  await new Promise((resolve, reject) => handlers.activate({ waitUntil: promise => promise.then(resolve, reject) }));
  assert.deepEqual(deleted, ['still-shell-v0']);
  for (const [url, method] of [
    ['/api/v1/libraries', 'GET'], ['/api/v1/pairing/claim', 'POST'],
    ['/api/v1/libraries/id/content?path=photo.jpg', 'GET'],
    ['/app?secret=123', 'GET'], ['https://other.local/app', 'GET']
  ]) {
    handlers.fetch({ request: { url: new URL(url, 'https://still.local').href, method }, respondWith() { assert.fail(`Must not cache ${url}`); } });
  }
  let response;
  handlers.fetch({ request: { url: 'https://still.local/', method: 'GET' }, respondWith: promise => { response = promise; } });
  assert.equal((await response).pathname, '/app');
});
