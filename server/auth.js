'use strict';
const crypto = require('node:crypto');

const b64 = buf => Buffer.from(buf).toString('base64url');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) { return false; }
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function signJwt(payload, secret, ttlSeconds) {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

// Returns the payload, or null when the token is malformed, tampered with, or expired.
function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) { return null; }
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') { return null; }
    const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const actual = Buffer.from(parts[2], 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { return null; }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) { return null; }
    return payload;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, signJwt, verifyJwt };
