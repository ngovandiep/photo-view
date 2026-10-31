'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Admin-editable product branding. Defaults are the MiLeo brand; values are stored in userData/branding.json.
const DEFAULTS = Object.freeze({
  appName: 'MiLeo Photo Library',
  shortName: 'MiLeo',
  syncName: 'MiLeo Sync',
  aiName: 'MiLeo AI',
  tagline: 'Your memories. Your library. Your world.',
  websiteUrl: '',
  logo: ''
});
const TEXT_LIMITS = Object.freeze({ appName: 60, shortName: 24, syncName: 40, aiName: 40, tagline: 120 });
const URL_LIMIT = 300;
const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

class BrandingError extends Error {}

function cleanText(key, value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new BrandingError(`${label(key)} cannot be empty.`);
  if (text.length > TEXT_LIMITS[key]) throw new BrandingError(`${label(key)} must be ${TEXT_LIMITS[key]} characters or fewer.`);
  return text;
}

function cleanUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > URL_LIMIT) throw new BrandingError(`Website URL must be ${URL_LIMIT} characters or fewer.`);
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`); } catch { throw new BrandingError('Website URL is not valid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new BrandingError('Website URL must start with http:// or https://.');
  if (url.username || url.password) throw new BrandingError('Website URL must not contain a user name or password.');
  return url.href;
}

function decodeLogo(value) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value || ''));
  if (!match) throw new BrandingError('Logo must be a PNG, JPEG or WebP image.');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length) throw new BrandingError('Logo image is empty.');
  if (data.length > LOGO_MAX_BYTES) throw new BrandingError(`Logo must be ${LOGO_MAX_BYTES / 1024} KB or smaller.`);
  const magic = LOGO_TYPES[match[1]];
  const webpOk = match[1] !== 'image/webp' || data.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!magic.every((byte, index) => data[index] === byte) || !webpOk) throw new BrandingError('Logo file content does not match its image type.');
  return { type: match[1], data };
}

function cleanLogo(value) {
  if (!value) return '';
  const { type, data } = decodeLogo(value);
  return `data:${type};base64,${data.toString('base64')}`;
}

function label(key) {
  return { appName: 'Application name', shortName: 'Short name', syncName: 'Sync feature name', aiName: 'AI feature name', tagline: 'Slogan' }[key] || key;
}

// Applies a partial update on top of `base`. Unknown keys are ignored; invalid values throw.
function merge(base, patch) {
  const next = { ...base };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return next;
  for (const key of Object.keys(TEXT_LIMITS)) if (key in patch) next[key] = cleanText(key, patch[key]);
  if ('websiteUrl' in patch) next.websiteUrl = cleanUrl(patch.websiteUrl);
  if ('logo' in patch) next.logo = cleanLogo(patch.logo);
  return next;
}

// Reading is lenient: a damaged or hand-edited field falls back to its default instead of failing startup.
function fromStored(raw) {
  const result = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return result;
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in raw)) continue;
    try { Object.assign(result, merge(result, { [key]: raw[key] })); } catch { /* keep default */ }
  }
  return result;
}

function createBrandingStore({ file }) {
  let cache = null;
  const read = () => {
    if (cache) return cache;
    try { cache = fromStored(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { cache = { ...DEFAULTS }; }
    return cache;
  };
  const write = value => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, ...value }, null, 2), 'utf8');
    fs.renameSync(temp, file);
    cache = { ...value };
    return get();
  };
  const get = () => ({ ...read() });
  return {
    get,
    defaults: () => ({ ...DEFAULTS }),
    set: patch => write(merge(read(), patch)),
    reset: () => write({ ...DEFAULTS }),
    // Phone-facing view: the logo is served from its own URL so the JSON stays small.
    publicView() {
      const { logo, ...rest } = read();
      return { ...rest, logoUrl: logo ? `/brand-logo?v=${crypto.createHash('sha256').update(logo).digest('hex').slice(0, 12)}` : '' };
    },
    logo() {
      const { logo } = read();
      return logo ? decodeLogo(logo) : null;
    }
  };
}

module.exports = { DEFAULTS, TEXT_LIMITS, LOGO_MAX_BYTES, BrandingError, createBrandingStore, merge, cleanUrl };
