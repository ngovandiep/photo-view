'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const thumbnailCode = source.slice(source.indexOf('  const thumbCacheLimit ='), source.indexOf('  function toggleFavorite('));

function setup(overrides = {}) {
  const revoked = [];
  let nextUrl = 0;
  const state = { sessionKey: 'user', desktopLibraryId: 'library', root: 'Photos', generation: 1, thumbCache: new Map() };
  const make = (tag, className, textContent) => ({
    tag, className, textContent, listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; }
  });
  const context = vm.createContext({
    state, make,
    URL: { createObjectURL: () => `blob:${++nextUrl}`, revokeObjectURL: url => revoked.push(url) },
    isDocument: () => false, isVideo: () => false,
    getPreviewFile: async () => ({}),
    decodeImage: async () => ({ naturalWidth: 1200, naturalHeight: 800 }),
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: callback => callback({}) }) },
    ...overrides
  });
  vm.runInContext(thumbnailCode + '\nthis.api = { thumbKey, rememberThumbnail, loadThumbnail };', context);
  const photo = { id: 'one', path: 'one.jpg', name: 'one.jpg', type: 'jpg', modified: 1, size: 100 };
  const button = item => ({
    photo: item, children: [],
    replaceChildren(child) {
      for (const previous of this.children) previous.parentElement = null;
      this.children = [child]; child.parentElement = this;
    }
  });
  return { ...context.api, state, photo, button, revoked };
}

test('thumbnail cache distinguishes files, versions, libraries, roots and accounts', () => {
  const { thumbKey, state, photo } = setup();
  const key = thumbKey(photo);
  for (const [field, value] of Object.entries({ id: 'two', path: 'two.heic', modified: 2, size: 200 })) {
    assert.notEqual(thumbKey({ ...photo, [field]: value }), key, field);
  }
  for (const field of ['sessionKey', 'desktopLibraryId', 'root']) {
    const original = state[field]; state[field] = 'other';
    assert.notEqual(thumbKey(photo), key, field); state[field] = original;
  }
});

test('unpreviewable HEIC never reuses a different photo thumbnail', async () => {
  const api = setup({ getPreviewFile: async () => { throw new Error('Unsupported HEIC'); } });
  api.rememberThumbnail(api.photo, 'blob:avatar');
  const button = api.button({ ...api.photo, id: 'heic', path: 'two.heic', name: 'two.heic', type: 'heic' });
  await api.loadThumbnail(button, 1);
  assert.equal(button.children[0].tag, 'span');
  assert.equal(button.children[0].textContent, 'HEIC · No preview available');
  assert.equal(api.state.thumbCache.size, 1);
});

test('decoded photos reuse only their own thumbnail and dimensions', async () => {
  let reads = 0;
  const api = setup({ getPreviewFile: async () => { reads++; return {}; } });
  const first = api.button(api.photo);
  await api.loadThumbnail(first, 1);
  const second = api.button({ ...api.photo, dimensions: undefined });
  await api.loadThumbnail(second, 1);
  assert.equal(reads, 1);
  assert.equal(first.children[0].src, second.children[0].src);
  assert.equal(second.photo.dimensions.width, 1200);
  assert.equal(api.revoked[0], 'blob:1');
});

test('decode and thumbnail generation failures replace loading text with no preview', async () => {
  for (const overrides of [
    { decodeImage: async () => { throw new Error('Corrupt image'); } },
    { document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: callback => callback(null) }) } }
  ]) {
    const api = setup(overrides); const button = api.button(api.photo);
    await api.loadThumbnail(button, 1);
    assert.equal(button.children[0].textContent, 'JPG · No preview available');
    assert.equal(api.state.thumbCache.size, 0);
    assert.deepEqual(api.revoked, ['blob:1']);
  }
});

test('broken rendered thumbnails are removed from the cache and show no preview', async () => {
  const api = setup(); const button = api.button(api.photo);
  await api.loadThumbnail(button, 1);
  const image = button.children[0]; const url = image.src;
  image.listeners.error();
  assert.equal(button.children[0].textContent, 'JPG · No preview available');
  assert.equal(api.state.thumbCache.size, 0);
  assert.ok(api.revoked.includes(url));
});

test('obsolete preview failures cannot replace a newer grid', async () => {
  const api = setup({ getPreviewFile: async () => { api.state.generation++; throw new Error('Unsupported'); } });
  const button = api.button(api.photo);
  await api.loadThumbnail(button, 1);
  assert.equal(button.children.length, 0);
});

test('large images resize asynchronously to a 480px edge and release bitmap memory', async () => {
  const closed = []; const calls = [];
  const bitmap = { width: 6000, height: 4000, close() { closed.push('original'); } };
  const small = { close() { closed.push('resized'); } };
  const api = setup({
    createImageBitmap: async (input, options) => {
      calls.push(options);
      return options ? small : bitmap;
    },
    decodeImage: async () => { throw new Error('Full-resolution DOM decode must not run'); }
  });
  const button = api.button(api.photo);
  await api.loadThumbnail(button, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].resizeWidth, 480);
  assert.equal(calls[1].resizeHeight, 320);
  assert.equal(api.photo.dimensions.width, 6000);
  assert.deepEqual(closed, ['resized', 'original']);
  assert.deepEqual(api.revoked, []);
  assert.equal(button.children[0].tag, 'img');
});

test('obsolete bitmap jobs release decoded memory without drawing', async () => {
  let closed = false;
  const api = setup({
    createImageBitmap: async () => {
      api.state.generation++;
      return { width: 6000, height: 4000, close() { closed = true; } };
    },
    document: { createElement() { throw new Error('Stale preview must not draw'); } }
  });
  const button = api.button(api.photo);
  await api.loadThumbnail(button, 1);
  assert.equal(closed, true);
  assert.equal(button.children.length, 0);
});

test('thumbnail scheduling limits concurrency, yields between batches and skips detached work', async () => {
  const started = []; const pending = []; const timers = [];
  const context = vm.createContext({
    state: { generation: 1 }, observer: { unobserve() {} },
    setTimeout: callback => timers.push(callback),
    loadThumbnail: button => {
      started.push(button.id);
      return new Promise(resolve => pending.push(resolve));
    }
  });
  vm.runInContext(source.slice(source.indexOf('  const thumbnailQueue ='), source.indexOf('  async function getFile(')) + '\nthis.enqueue = enqueueThumbnail;', context);
  context.enqueue({ id: 'stale', isConnected: true }, 0);
  context.enqueue({ id: 'detached', isConnected: false }, 1);
  for (let id = 0; id < 5; id++) context.enqueue({ id, isConnected: true }, 1);
  assert.deepEqual(started, [0, 1, 2]);
  pending.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2], 'next batch must yield to the event loop');
  timers.shift()();
  assert.deepEqual(started, [0, 1, 2, 3]);
  for (const resolve of pending) resolve();
});

test('scrolling off-screen removes pending thumbnails without starting a decode', () => {
  let callback;
  const queue = [];
  const context = vm.createContext({
    generation: 1, thumbnailQueue: queue,
    enqueueThumbnail: (button, generation) => queue.push({ button, generation }),
    IntersectionObserver: function (handler) { callback = handler; }
  });
  const start = source.indexOf('    observer = new IntersectionObserver(');
  vm.runInContext(source.slice(start, source.indexOf('    const pagePhotos =', start)), context);
  const button = {};
  callback([{ target: button, isIntersecting: true }]);
  assert.equal(queue.length, 1);
  callback([{ target: button, isIntersecting: false }]);
  assert.equal(queue.length, 0);
});
