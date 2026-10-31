'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../index-store.js');

test('reconciles discovered files while preserving annotations', () => {
  const index = store.create('Photos');
  let result = store.reconcile(index, [{ path: 'Trip/IMG_20240102.jpg', size: 120, lastModified: 456 }]);
  const entry = result.index.entries[0];
  entry.metadata.favorite = true;
  entry.metadata.tags = ['trip'];
  result = store.reconcile(result.index, [{ path: 'Trip/IMG_20240102.jpg', size: 120, lastModified: 456 }]);
  assert.equal(result.summary.unchanged, 1);
  assert.equal(result.index.entries[0].metadata.favorite, true);
  assert.deepEqual(result.index.entries[0].metadata.tags, ['trip']);
});

test('retains entries below inaccessible folders without marking them missing', () => {
  const index = store.reconcile(store.create('Photos'), [{ path: 'Private/a.jpg', size: 10, lastModified: 20 }]).index;
  const result = store.reconcile(index, [], ['Private']);
  assert.equal(result.index.entries[0].missing, false);
  assert.equal(result.summary.protected, 1);
});

test('refreshing changed file metadata invalidates its cached checksum', () => {
  const index = store.addPhoto(store.create('Photos'), { path: 'a.jpg', size: 10, lastModified: 20 }, 'a'.repeat(64));
  const changed = store.addPhoto(index, { path: 'a.jpg', size: 11, lastModified: 21 });
  assert.equal(changed.entries[0].contentHash, null);
});

test('addPhoto preserves an existing capture date unless a new one is supplied', () => {
  const dateTaken = '2024-01-02T00:00:00.000Z';
  const first = store.addPhoto(store.create('Photos'), { path: 'a.jpg', size: 10, lastModified: 20, dateTaken });
  const refreshed = store.addPhoto(first, { path: 'a.jpg', size: 10, lastModified: 20 });
  assert.equal(refreshed.entries[0].dateTaken, dateTaken);
});

test('rejects invalid index paths and accepts a normalized valid index', () => {
  const index = store.reconcile(store.create('Photos'), [{ path: 'a.jpg', size: 10, lastModified: 20 }]).index;
  assert.equal(store.validate(index).ok, true);
  assert.throws(() => store.normalizePath('../outside.jpg'));
  const invalid = { ...index, entries: [{ ...index.entries[0], path: '../outside.jpg', id: '../outside.jpg' }] };
  assert.equal(store.validate(invalid).ok, false);
});
