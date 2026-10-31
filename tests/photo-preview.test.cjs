'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertHeicPreview } = require('../electron/photo-preview.cjs');

test('HEIC preview conversion returns JPEG bytes without modifying input', async () => {
  const input = Buffer.from([0, 1, 2, 3]);
  const original = Buffer.from(input);
  const jpeg = await convertHeicPreview(input, async options => {
    assert.equal(options.buffer, input);
    assert.deepEqual([options.format, options.quality], ['JPEG', 0.85]);
    return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  });
  assert.equal(Buffer.from(jpeg).toString('hex'), 'ffd8ffd9');
  assert.deepEqual(input, original);
});

test('HEIC preview conversion reports invalid image data', async () => {
  await assert.rejects(convertHeicPreview(Buffer.from('not-heic')), /not a HEIC image/i);
});

test('HEIC worker keeps the event loop responsive and continues after failed jobs', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const jobs = Array.from({ length: 3 }, () => convertHeicPreview(Buffer.from('invalid')));
    const results = await Promise.allSettled(jobs);
    assert.ok(ticks > 0, 'main event loop must run while the worker handles conversions');
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.message, /not a HEIC image/i);
    }
  } finally { clearInterval(timer); }
});
