'use strict';
const test = require('node:test');
const assert = require('node:assert');
const indexStore = require('../index-store.js');
const { extractAnnotations, mergeAnnotations } = require('../electron/sync.cjs');

function sample() {
  const index = indexStore.create('Photos');
  const record = (path, metadata) => ({
    id: path, path, name: path, folder: '', extension: 'jpg', size: 1, lastModified: 1, dateTaken: null,
    metadata, contentHash: null, firstIndexedAt: new Date().toISOString(), missing: false, missingSince: null
  });
  index.entries = [
    record('a.jpg', { favorite: true, tags: ['x'], albumIds: [] }),
    record('b.jpg', { favorite: false, tags: [], albumIds: [] })
  ];
  return index;
}

test('extract keeps only annotated entries', () => {
  const out = extractAnnotations(sample());
  assert.deepStrictEqual(out.entries.map(entry => entry.path), ['a.jpg']);
});

test('merge adds remote annotations without removing local ones and stays valid', () => {
  const index = sample();
  const remote = {
    albums: [{ id: 'al1', name: 'Trip' }],
    entries: [
      { path: 'b.jpg', favorite: true, tags: ['y'], albumIds: ['al1', 'missing'] },
      { path: 'a.jpg', favorite: false, tags: [], albumIds: [] },
      { path: 'gone.jpg', favorite: true, tags: [], albumIds: [] }
    ]
  };
  const { index: merged, changed } = mergeAnnotations(index, remote);
  assert.strictEqual(changed, 1);
  assert.deepStrictEqual(merged.entries[1].metadata, { favorite: true, tags: ['y'], albumIds: ['al1'] });
  assert.strictEqual(merged.entries[0].metadata.favorite, true);
  assert.strictEqual(indexStore.validate(merged).ok, true);
});
