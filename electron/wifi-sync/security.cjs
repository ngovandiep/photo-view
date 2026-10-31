'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const selfsigned = require('selfsigned');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha256Hex = value => crypto.createHash('sha256').update(value).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = token => sha256Hex(`device-token:${token}`);

function newPairingCode() {
  let code = '';
  for (const byte of crypto.randomBytes(8)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}
const normalizeCode = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = code => sha256Hex(`pairing-code:${normalizeCode(code)}`);
const formatCode = code => `${code.slice(0, 4)}-${code.slice(4)}`;

function isPrivateAddress(address) {
  let value = String(address || '');
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (net.isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (!net.isIPv6(value)) return false;
  const lower = value.toLowerCase();
  return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
}

function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && isPrivateAddress(item.address)) found.push({ name, address: item.address });
    }
  }
  const rank = address => (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2);
  return found.sort((a, b) => rank(a.address) - rank(b.address));
}

function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    // Returns true when the request is allowed.
    take(key) {
      const time = now();
      const recent = (hits.get(key) || []).filter(stamp => time - stamp < windowMs);
      if (recent.length >= limit) { hits.set(key, recent); return false; }
      recent.push(time);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(stamp => time - stamp < windowMs)) hits.delete(k);
      return true;
    }
  };
}

// The certificate is created once and kept stable so paired clients can pin its fingerprint.
async function ensureCertificate(directory, { protect, unprotect, now = Date.now } = {}) {
  const certFile = path.join(directory, 'server-cert.pem');
  const keyFile = path.join(directory, 'server-key.bin');
  try {
    const cert = await fs.readFile(certFile, 'utf8');
    const stored = await fs.readFile(keyFile);
    const x509 = new crypto.X509Certificate(cert);
    if (new Date(x509.validTo).getTime() - now() > 30 * 24 * 3600 * 1000) {
      return { cert, key: (unprotect ? unprotect(stored) : stored).toString('utf8'), fingerprint: x509.fingerprint256 };
    }
  } catch { /* missing or unreadable: create a new one */ }
  const altNames = [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }, ...lanAddresses().map(item => ({ type: 7, ip: item.address }))];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Still Wi-Fi Photo Sync' }], {
    days: 825, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }]
  });
  await fs.mkdir(directory, { recursive: true });
  const keyBytes = Buffer.from(pems.private, 'utf8');
  await fs.writeFile(certFile, pems.cert, 'utf8');
  await fs.writeFile(keyFile, protect ? protect(keyBytes) : keyBytes, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private, fingerprint: new crypto.X509Certificate(pems.cert).fingerprint256 };
}

module.exports = {
  sha256Hex, newToken, hashToken, newPairingCode, normalizeCode, hashCode, formatCode,
  isPrivateAddress, lanAddresses, createRateLimiter, ensureCertificate
};
