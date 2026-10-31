'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createPhoneChat } = require('./phone-chat.cjs');

const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'dng']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', '3gp']);
const DOCUMENT = new Set(['pdf']);
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', dng: 'image/x-adobe-dng',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
  pdf: 'application/pdf'
};
const MAX_THUMB_SOURCE = 80 * 1024 * 1024;
const INDEX_TTL = 5000;

const kindOf = extension => (IMAGE.has(extension) ? 'photo' : VIDEO.has(extension) ? 'video' : DOCUMENT.has(extension) ? 'document' : null);
const isInside = (parent, candidate) => { const relative = path.relative(parent, candidate); return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative)); };

// Many phone cameras put the capture date in the filename (IMG_20240105_..., 2024-01-05 ...); otherwise fall back to the modified time.
function dateOf(entry) {
  const match = /(?:^|\D)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:\D|$)/.exec(entry.name);
  if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return entry.lastModified || 0;
}

function createLibraryApi({ listLibraries, resolveLibrary, readIndex, saveIndex, makeThumbnail, thumbDir, getAccount = async () => null, verifyLogin = null, chat = null, trashItem = null, onChange = () => {}, appVersion = '1.0.0', now = Date.now }) {
  const cache = new Map();
  const logins = new Map();
  const phoneChat = chat ? createPhoneChat({ chat }) : null;
  let loginsLoaded = false;
  // Sign-ins persist across restarts until the phone signs out (or the desktop account changes).
  const loginFile = thumbDir ? path.join(path.dirname(thumbDir), 'phone-logins.json') : '';
  async function loadLogins() {
    if (loginsLoaded) return;
    loginsLoaded = true;
    try { for (const [id, email] of Object.entries(JSON.parse(await fs.readFile(loginFile, 'utf8')))) logins.set(id, email); } catch { /* none saved yet */ }
  }
  async function saveLogins() {
    if (!loginFile) return;
    await fs.mkdir(path.dirname(loginFile), { recursive: true });
    await fs.writeFile(loginFile, JSON.stringify(Object.fromEntries(logins)), { mode: 0o600 }).catch(() => {});
  }
  const failures = new Map();
  const emailOf = user => String(user?.email || '').trim().toLowerCase();
  let thumbSlots = 0;
  const thumbWaiters = [];

  async function loadIndex(libraryId) {
    const hit = cache.get(libraryId);
    if (hit && now() - hit.at < INDEX_TTL) return hit.index;
    const index = await readIndex(libraryId);
    cache.set(libraryId, { at: now(), index });
    return index;
  }

  async function resolveFile(libraryId, relative, allowed, strict = false) {
    const library = resolveLibrary(libraryId);
    if (!library) return null;
    const clean = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || clean.split('/').some(part => part === '..' || part === '')) return null;
    const extension = path.extname(clean).slice(1).toLowerCase();
    if (!allowed.has(extension)) return null;
    const root = await fs.realpath(library.root);
    const candidate = path.resolve(root, ...clean.split('/'));
    if (!isInside(root, candidate)) return null;
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || !isInside(root, real)) return null;
    if (strict && path.relative(candidate, real) !== '') return null;
    const stats = await fs.stat(real);
    return stats.isFile() ? { file: real, stats, extension } : null;
  }

  const all = new Set([...IMAGE, ...VIDEO, ...DOCUMENT]);

  function summarize(entry) {
    const extension = entry.extension || path.extname(entry.name).slice(1).toLowerCase();
    return { path: entry.path, name: entry.name, folder: entry.folder, type: extension, kind: kindOf(extension), size: entry.size, date: dateOf(entry), favorite: !!entry.metadata?.favorite, tags: entry.metadata?.tags || [] };
  }

  const monthKey = date => (date ? new Date(date).toISOString().slice(0, 7) : 'undated');

  async function visibleIndex(libraryId, access) {
    if (!access) return loadIndex(libraryId);
    // Sharing changes and album membership must not be hidden by the legacy index cache.
    const index = await readIndex(libraryId);
    access.assert();
    const granted = new Set(access.repo.family.allowedAlbums(access.profile.id, libraryId));
    const albums = index.albums.filter(album => granted.has(album.id) && (!access.albumId || album.id === access.albumId));
    const ids = new Set(albums.map(album => album.id));
    return { ...index, albums, entries: index.entries.filter(entry => entry.metadata?.albumIds?.some(id => ids.has(id))) };
  }

  async function collect(url, libraryId, access) {
    const index = await visibleIndex(libraryId, access);
    const query = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
    const kind = url.searchParams.get('kind') || '';
    const favoritesOnly = url.searchParams.get('favorite') === '1';
    const counts = { all: 0, photo: 0, video: 0, document: 0 };
    const folderOnly = url.searchParams.has('folder');
    const folder = String(url.searchParams.get('folder') || '').replace(/^\/+|\/+$/g, '');
    const matched = [];
    for (const entry of index.entries) {
      if (entry.missing) continue;
      const summary = summarize(entry);
      if (!summary.kind) continue;
      if (folderOnly && (summary.folder || '') !== folder) continue;
      if (favoritesOnly && !summary.favorite) continue;
      if (query && !`${entry.path} ${summary.tags.join(' ')}`.toLowerCase().includes(query)) continue;
      counts.all++; counts[summary.kind]++;
      if (!kind || kind === summary.kind) matched.push(summary);
    }
    matched.sort((a, b) => b.date - a.date || a.path.localeCompare(b.path));
    return { counts, matched };
  }

  async function items(url, libraryId, access) {
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '60', 10) || 60));
    const month = url.searchParams.get('month') || '';
    const { counts, matched: all } = await collect(url, libraryId, access);
    const matched = /^(\d{4}-\d{2}|undated)$/.test(month) ? all.filter(item => monthKey(item.date) === month) : all;
    return { total: matched.length, counts, items: matched.slice(offset, offset + limit) };
  }

  // Month buckets (newest first) with a few sample items each, for the roadmap view.
  async function timeline(url, libraryId, access) {
    const { counts, matched } = await collect(url, libraryId, access);
    const buckets = new Map();
    for (const item of matched) {
      const key = monthKey(item.date);
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { key, count: 0, sample: [] }; buckets.set(key, bucket); }
      bucket.count++;
      if (bucket.sample.length < 6 && item.kind !== 'document') bucket.sample.push(item);
    }
    return { total: matched.length, counts, buckets: [...buckets.values()] };
  }

  async function streamFile(req, res, resolved, extra = {}) {
    const { file, stats, extension } = resolved;
    const size = stats.size;
    let start = 0; let end = size - 1; let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      else start = Math.max(0, size - Number(range[2]));
      if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      status = 206;
    }
    const headers = { 'Content-Type': MIME[extension] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(size ? end - start + 1 : 0), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', ...extra };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !size) { res.end(); return; }
    // fs streams keep delete-sharing on Windows, so serving a file never blocks renaming its folder on the PC.
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  async function withThumbSlot(work) {
    if (thumbSlots >= 2) await new Promise(resolve => thumbWaiters.push(resolve));
    thumbSlots++;
    try { return await work(); } finally { thumbSlots--; thumbWaiters.shift()?.(); }
  }

  async function thumbnail(req, res, resolved, width, authorize = null) {
    if (resolved.stats.size > MAX_THUMB_SOURCE || !makeThumbnail) return false;
    const key = crypto.createHash('sha1').update(`${resolved.file}|${resolved.stats.mtimeMs}|${resolved.stats.size}|${width}`).digest('hex');
    const cached = path.join(thumbDir, `${key}.jpg`);
    let data = await fs.readFile(cached).catch(() => null);
    if (!data) {
      data = await withThumbSlot(async () => makeThumbnail(resolved.file, width));
      if (!data || !data.length) return false;
      await fs.mkdir(thumbDir, { recursive: true });
      await fs.writeFile(cached, data).catch(() => {});
    }
    if (authorize) await authorize();
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(data.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  }

  // Immediate sub-folders of `parent` with the number of media files below each (nested ones included).
  async function folders(url, libraryId, access) {
    const index = await visibleIndex(libraryId, access);
    const parent = String(url.searchParams.get('parent') || '').replace(/^\/+|\/+$/g, '');
    const prefix = parent ? `${parent}/` : '';
    const children = new Map();
    let direct = 0;
    for (const entry of index.entries) {
      if (entry.missing || !kindOf(entry.extension || path.extname(entry.name).slice(1).toLowerCase())) continue;
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) { direct++; continue; }
      const name = rest.slice(0, slash);
      children.set(name, (children.get(name) || 0) + 1);
    }
    const list = [...children].map(([name, count]) => ({ name, path: prefix + name, count })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { parent, folders: list, direct };
  }

  // Moves files to the computer's Recycle Bin (recoverable) and marks them missing in the index.
  async function deleteItems(libraryId, body, HttpError) {
    if (!trashItem) throw new HttpError(501, 'not_supported', 'Deleting is not available.');
    const files = Array.isArray(body.paths) ? body.paths.filter(item => typeof item === 'string') : [];
    const folderList = Array.isArray(body.folders) ? body.folders.filter(item => typeof item === 'string').map(item => item.replace(/^\/+|\/+$/g, '')) : [];
    if (folderList.some(item => !item || item.split('/').includes('..'))) throw new HttpError(400, 'invalid_request', 'Invalid folder.');
    if (!files.length && !folderList.length) throw new HttpError(400, 'invalid_request', 'Nothing selected.');
    const index = await readIndex(libraryId);
    const targets = new Map();
    for (const entry of index.entries) {
      if (entry.missing || !kindOf(entry.extension || path.extname(entry.name).slice(1).toLowerCase())) continue;
      if (files.includes(entry.path) || folderList.some(item => entry.path.startsWith(`${item}/`))) targets.set(entry.path, entry);
    }
    if (targets.size > 5000) throw new HttpError(400, 'invalid_request', 'Too many items at once.');
    let deleted = 0; let failed = 0;
    for (const [relative, entry] of targets) {
      const resolved = await resolveFile(libraryId, relative, all).catch(() => null);
      try {
        if (!resolved) throw new Error('missing');
        await trashItem(resolved.file);
        entry.missing = true; entry.missingSince = new Date(now()).toISOString();
        deleted++;
      } catch { failed++; }
    }
    if (deleted) { index.updatedAt = now(); await saveIndex(libraryId, index); cache.delete(libraryId); onChange({ type: 'library-changed', libraryId }); }
    return { deleted, failed };
  }

  async function setFavorite(libraryId, relative, favorite) {
    const index = await readIndex(libraryId);
    const entry = index.entries.find(item => item.path === relative && !item.missing);
    if (!entry) return null;
    entry.metadata = { ...entry.metadata, favorite };
    index.updatedAt = now();
    await saveIndex(libraryId, index);
    cache.delete(libraryId);
    onChange({ type: 'library-changed', libraryId });
    return favorite;
  }

  // Returns true when the route belongs to this module.
  async function handle({ req, res, route, url, device, repo, send, readJson, HttpError, isActive }) {
    const method = req.method;
    // When the desktop is signed in to an account, a paired phone must also sign in to that same account.
    const user = await getAccount().catch(() => null);
    const familyMode = repo.getSettings().familyEnabled;
    const family = familyMode ? repo.family.context(device.id) : null;
    const loginRequired = familyMode || Boolean(user);
    await loadLogins();
    const session = logins.get(device.id);
    const loggedIn = familyMode ? family.signedIn : !loginRequired || Boolean(session && session === emailOf(user));
    const access = familyMode && family.profile ? { repo, profile: family.profile, albumId: url.searchParams.get('album') || '' } : null;
    if (access) access.assert = () => {
      const current = repo.family.context(device.id);
      if (!repo.getSettings().familyEnabled || !current.signedIn || current.profile?.id !== access.profile.id) throw new HttpError(403, 'login_required', 'Family access changed. Sign in again.');
    };
    if (route === '/me' && method === 'GET') {
      send(res, 200, { device: { id: device.id, name: device.name }, loginRequired, loggedIn, familyMode, readOnly: familyMode,
        uploadAllowed: !repo.family.uploadProblem(device.id),
        profileAssigned: !familyMode || Boolean(family.profile),
        chat: Boolean(!familyMode && phoneChat && loginRequired && loggedIn && chat.signedIn()),
        account: familyMode ? (loggedIn ? { name: family.profile.name, email: family.profile.email } : null) : user && loggedIn ? { name: user.displayName || user.name || '', email: user.email || '' } : null, appVersion });
      return true;
    }
    if (route === '/login' && method === 'POST') {
      if (!loginRequired) { send(res, 200, { ok: true }); return true; }
      if (!verifyLogin) throw new HttpError(503, 'login_unavailable', 'The local sign-in service is unavailable.');
      const record = failures.get(device.id);
      if (record && record.until > now() && record.count >= 5) throw new HttpError(429, 'rate_limited', 'Too many sign-in attempts. Wait a minute.');
      const body = await readJson(req);
      let verified = null;
      try { verified = await verifyLogin(String(body.email || '').slice(0, 320), String(body.password || '').slice(0, 200)); } catch { verified = null; }
      if (!verified || (familyMode ? !repo.family.signIn(device.id, verified) : emailOf(verified) !== emailOf(user))) {
        const fresh = record && record.until > now() ? record : { count: 0, until: now() + 60000 };
        fresh.count++; failures.set(device.id, fresh);
        throw new HttpError(403, 'login_failed', familyMode ? 'Sign in with the active local account assigned to this device by Admin.' : 'Wrong email or password, or this is not the account signed in on the computer.');
      }
      failures.delete(device.id);
      if (!familyMode) { logins.set(device.id, emailOf(user)); await saveLogins(); }
      send(res, 200, { ok: true });
      return true;
    }
    if (route === '/logout' && method === 'POST') { repo.family.signOut(device.id); logins.delete(device.id); await saveLogins(); phoneChat?.closeDevice(device.id); send(res, 200, { ok: true }); return true; }
    // Chat belongs to the account, so it needs both a signed-in computer and a phone signed in to that same account.
    if (route === '/chat' || route.startsWith('/chat/')) {
      if (familyMode) throw new HttpError(403, 'not_shared', 'Desktop account chat is not shared with family devices.');
      if (!phoneChat) throw new HttpError(404, 'not_found', 'Chat is not available.');
      if (!loginRequired || !chat.signedIn()) throw new HttpError(409, 'chat_unavailable', 'Sign in on the computer to use chat.');
      if (!loggedIn) throw new HttpError(403, 'login_required', 'Sign in to use chat.');
      const stillSignedIn = async () => { const current = await getAccount().catch(() => null); return !repo.getSettings().familyEnabled && Boolean(current) && logins.get(device.id) === emailOf(current); };
      return phoneChat.handle({ req, res, route, url, device, send, readJson, HttpError, isActive, stillSignedIn });
    }
    const gated = route === '/libraries' || route.startsWith('/libraries/');
    if (gated && !loggedIn) throw new HttpError(403, 'login_required', 'Sign in to use the library.');
    if (route === '/libraries' && method === 'GET') {
      const result = [];
      for (const library of listLibraries()) {
        const index = access ? await visibleIndex(library.id, access) : await loadIndex(library.id).catch(() => null);
        if (access && !index.albums.length) continue;
        result.push({ id: library.id, name: library.name, count: index ? index.entries.filter(entry => !entry.missing && kindOf(entry.extension)).length : 0, ...(access ? { albums: index.albums, readOnly: true } : {}) });
      }
      send(res, 200, { libraries: result });
      return true;
    }
    const match = /^\/libraries\/([0-9a-f]{64})\/(items|file|thumb|favorite|timeline|folders|delete)$/.exec(route);
    if (!match) return false;
    const [, libraryId, action] = match;
    if (!resolveLibrary(libraryId)) throw new HttpError(404, 'not_found', 'Library not found.');
    if (access) {
      const index = await visibleIndex(libraryId, access);
      if (!index.albums.length) throw new HttpError(403, 'not_shared', 'This library or album is not shared with your profile.');
      if (['favorite', 'delete'].includes(action)) throw new HttpError(403, 'read_only', 'Shared albums are read-only.');
      if (['file', 'thumb'].includes(action) && !index.entries.some(entry => !entry.missing && entry.path === url.searchParams.get('path'))) throw new HttpError(403, 'not_shared', 'This file is not in a shared album.');
    }

    if (action === 'items' && method === 'GET') { send(res, 200, await items(url, libraryId, access)); return true; }
    if (action === 'folders' && method === 'GET') { send(res, 200, await folders(url, libraryId, access)); return true; }
    if (action === 'delete' && method === 'POST') { send(res, 200, await deleteItems(libraryId, await readJson(req), HttpError)); return true; }
    if (action === 'timeline' && method === 'GET') { send(res, 200, await timeline(url, libraryId, access)); return true; }
    if (action === 'favorite' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.favorite !== 'boolean' || typeof body.path !== 'string') throw new HttpError(400, 'invalid_request', 'path and favorite are required.');
      const result = await setFavorite(libraryId, body.path, body.favorite);
      if (result === null) throw new HttpError(404, 'not_found', 'File not found in this library index.');
      send(res, 200, { favorite: result });
      return true;
    }
    if ((action === 'file' || action === 'thumb') && (method === 'GET' || method === 'HEAD')) {
      let resolved;
      try { resolved = await resolveFile(libraryId, url.searchParams.get('path'), action === 'thumb' ? IMAGE : all, Boolean(access)); }
      catch (error) {
        if (['ENOENT', 'EACCES', 'EPERM', 'ENOTCONN', 'ENETUNREACH', 'EIO'].includes(error.code)) throw new HttpError(503, 'storage_unavailable', 'Library storage is unavailable. Reconnect the drive or NAS and retry.');
        throw error;
      }
      if (!resolved) throw new HttpError(404, 'not_found', 'File not found.');
      const authorize = access ? async () => {
        const index = await visibleIndex(libraryId, access);
        if (!index.entries.some(entry => !entry.missing && entry.path === url.searchParams.get('path'))) throw new HttpError(403, 'not_shared', 'This file is no longer shared.');
      } : null;
      if (authorize) await authorize();
      if (action === 'file') { await streamFile(req, res, resolved); return true; }
      const width = Math.min(800, Math.max(64, Number.parseInt(url.searchParams.get('w') || '320', 10) || 320));
      if (!(await thumbnail(req, res, resolved, width, authorize))) throw new HttpError(415, 'no_thumbnail', 'No thumbnail available for this file.');
      return true;
    }
    return false;
  }

  return { handle, items, resolveFile, kindOf };
}

module.exports = { createLibraryApi, kindOf, dateOf };
