'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStore, sanitizeUi } = require('../electron/session-state.cjs');

const id = 'a'.repeat(64);
const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'still-session-'));
  const holder = { key: 'u1' };
  return { dir, holder, store: createSessionStore({ dir, getUserKey: async () => holder.key, maxFiles: 10 }) };
};

test('UI state is remembered per account and restored on the next sign-in', async () => {
  const { dir, holder, store } = setup();
  try {
    await store.saveUi({ libraryId: id, view: 'folders', kind: '', folder: 'Trips/2024', search: 'beach', sort: 'date-desc', page: 3, pinnedLibraries: [id], pinnedFoldersByLibrary: { [id]: ['Trips/2024'] } });
    holder.key = 'u2';
    assert.equal(await store.loadUi(), null);
    await store.saveUi({ libraryId: id, view: 'favorites' });
    holder.key = 'u1';
    const first = await store.loadUi();
    assert.deepEqual([first.view, first.folder, first.search, first.sort, first.page, first.pinnedLibraries, first.pinnedFoldersByLibrary[id]], ['folders', 'Trips/2024', 'beach', 'date-desc', 3, [id], ['Trips/2024']]);
    holder.key = 'u2';
    assert.equal((await store.loadUi()).view, 'favorites');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('saved UI state is sanitized and unsafe account keys cannot escape the session folder', async () => {
  const ui = sanitizeUi({ libraryId: '../x', view: 'evil', kind: 'x', sort: 'nope', page: -4, folder: 'f'.repeat(5000), extra: 'ignored' });
  assert.deepEqual([ui.libraryId, ui.view, ui.kind, ui.sort, ui.page, ui.folder.length, 'extra' in ui], ['', 'photos', 'photo', 'name', 0, 1024, false]);
  const pins = sanitizeUi({ pinnedLibraries: ['../bad', id, id], pinnedFoldersByLibrary: { [id]: ['Trips/2024', '../outside', 'C:\\Photos', 'x'.repeat(1025)] } });
  assert.deepEqual([pins.pinnedLibraries, pins.pinnedFoldersByLibrary[id]], [[id], ['Trips/2024']]);
  const { dir, holder, store } = setup();
  try {
    holder.key = '../../escape';
    await store.saveUi({ view: 'tags' });
    assert.ok(fs.existsSync(path.join(dir, 'users', 'local', 'ui.json')));
    assert.ok(!fs.existsSync(path.join(dir, '..', 'escape')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan cache is reused only for the same folder path and valid, bounded data', async () => {
  const { dir, store } = setup();
  try {
    const scan = { files: [{ path: 'a.jpg', size: 5, lastModified: 7 }], folders: ['Trips'], inaccessiblePaths: [], processed: 1 };
    await store.saveScan(id, 'D:\\Photos', scan);
    const hit = await store.loadScan(id, 'D:\\Photos');
    assert.deepEqual([hit.files.length, hit.folders[0], hit.processed], [1, 'Trips', 1]);
    assert.equal(await store.loadScan(id, 'E:\\Other'), null);
    assert.equal(await store.loadScan('bad', 'D:\\Photos'), null);
    await store.saveScan(id, 'D:\\Photos', { ...scan, files: Array.from({ length: 11 }, (_, i) => ({ path: `${i}.jpg`, size: 1, lastModified: 1 })) });
    assert.equal(await store.loadScan(id, 'D:\\Photos'), null);
    await store.saveScan(id, 'D:\\Photos', scan);
    await store.clearScan(id);
    assert.equal(await store.loadScan(id, 'D:\\Photos'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
