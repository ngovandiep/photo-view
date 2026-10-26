'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openDb, upsertUser } = require('../db');

test('same provider identity returns the same user', () => {
  const db = openDb(':memory:');
  const a = upsertUser(db, { provider: 'github', providerUserId: '1', email: 'a@x.com', emailVerified: true });
  const b = upsertUser(db, { provider: 'github', providerUserId: '1' });
  assert.strictEqual(a, b);
});

test('verified email links a second provider to the same user', () => {
  const db = openDb(':memory:');
  const a = upsertUser(db, { provider: 'google', providerUserId: 'g1', email: 'a@x.com', emailVerified: true });
  const b = upsertUser(db, { provider: 'github', providerUserId: 'h1', email: 'a@x.com', emailVerified: true });
  assert.strictEqual(a, b);
});

test('unverified email does not link accounts', () => {
  const db = openDb(':memory:');
  const a = upsertUser(db, { provider: 'google', providerUserId: 'g1', email: 'a@x.com', emailVerified: true });
  const b = upsertUser(db, { provider: 'github', providerUserId: 'h1', email: 'a@x.com', emailVerified: false });
  assert.notStrictEqual(a, b);
});
