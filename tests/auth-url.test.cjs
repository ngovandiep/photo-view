'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeApiUrl } = require('../electron/auth.cjs');

test('API URL allows https and loopback http only', () => {
  assert.strictEqual(normalizeApiUrl('http://127.0.0.1:3000/x'), 'http://127.0.0.1:3000');
  assert.strictEqual(normalizeApiUrl('https://api.example.com'), 'https://api.example.com');
  assert.throws(() => normalizeApiUrl('http://example.com'));
  assert.throws(() => normalizeApiUrl('file:///etc/passwd'));
});
