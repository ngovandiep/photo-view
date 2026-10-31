'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, createBrandingStore } = require('../electron/branding.cjs');
const { createSyncServer } = require('../electron/wifi-sync/server.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const pngUrl = `data:image/png;base64,${PNG.toString('base64')}`;
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brand-')), 'branding.json');

test('branding defaults to MiLeo when nothing is stored', () => {
  const store = createBrandingStore({ file: tempFile() });
  assert.deepEqual(store.get(), { ...DEFAULTS });
  assert.equal(store.get().appName, 'MiLeo Photo Library');
  assert.equal(store.get().tagline, 'Your memories. Your library. Your world.');
});

test('branding saves, persists, validates and resets', () => {
  const file = tempFile();
  const store = createBrandingStore({ file });
  const saved = store.set({ appName: '  Family   Photos ', shortName: 'Fam', tagline: 'Hello', websiteUrl: 'example.com/about', logo: pngUrl, ignored: 'x' });
  assert.equal(saved.appName, 'Family Photos');
  assert.equal(saved.websiteUrl, 'https://example.com/about');
  assert.equal(saved.logo, pngUrl);
  assert.equal('ignored' in saved, false);
  assert.deepEqual(createBrandingStore({ file }).get(), saved);

  assert.throws(() => store.set({ appName: '   ' }), /cannot be empty/);
  assert.throws(() => store.set({ shortName: 'x'.repeat(25) }), /24 characters/);
  assert.throws(() => store.set({ websiteUrl: 'javascript:alert(1)' }), /http/);
  assert.throws(() => store.set({ websiteUrl: 'https://user:pw@example.com' }), /user name/);
  assert.throws(() => store.set({ logo: 'data:image/svg+xml;base64,PHN2Zz4=' }), /PNG, JPEG or WebP/);
  assert.throws(() => store.set({ logo: `data:image/jpeg;base64,${PNG.toString('base64')}` }), /does not match/);
  assert.throws(() => store.set({ logo: `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(600 * 1024)]).toString('base64')}` }), /512 KB/);
  assert.equal(store.get().appName, 'Family Photos', 'a rejected update leaves the saved branding untouched');

  assert.equal(store.set({ websiteUrl: '', logo: '' }).logo, '');
  assert.deepEqual(store.reset(), { ...DEFAULTS });
  assert.deepEqual(createBrandingStore({ file }).get(), { ...DEFAULTS });
});

test('damaged branding fields fall back to defaults individually', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ appName: 'Kept', shortName: '', websiteUrl: 'ftp://x', logo: 'data:text/html,hi' }));
  const brand = createBrandingStore({ file }).get();
  assert.equal(brand.appName, 'Kept');
  assert.equal(brand.shortName, DEFAULTS.shortName);
  assert.equal(brand.websiteUrl, '');
  assert.equal(brand.logo, '');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(createBrandingStore({ file }).get(), { ...DEFAULTS });
});

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('phone server exposes public branding, the logo and a branded manifest', async () => {
  const store = createBrandingStore({ file: tempFile() });
  const server = createSyncServer({ repo: { logEvent() {}, authenticate: () => null }, importer: {}, tls: null, branding: store });
  const { port } = await server.listen({ host: '127.0.0.1', port: 0, attempts: 1 });
  try {
    let response = await get(port, '/api/v1/branding');
    assert.equal(response.status, 200);
    let body = JSON.parse(response.body);
    assert.equal(body.syncName, 'MiLeo Sync');
    assert.equal(body.logoUrl, '');
    assert.equal('logo' in body, false);
    assert.equal((await get(port, '/brand-logo')).status, 404);

    store.set({ shortName: 'Fam', syncName: 'Fam Sync', logo: pngUrl });
    body = JSON.parse((await get(port, '/api/v1/branding')).body);
    assert.match(body.logoUrl, /^\/brand-logo\?v=[a-f0-9]{12}$/);
    response = await get(port, body.logoUrl);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.deepEqual(response.body, PNG);

    const manifest = JSON.parse((await get(port, '/manifest.webmanifest')).body);
    assert.equal(manifest.name, 'Fam Sync');
    assert.equal(manifest.short_name, 'Fam');
    assert.equal(manifest.start_url, '/app');
    assert.equal((await get(port, '/brand.js')).status, 200);
  } finally { await server.close(); }
});
