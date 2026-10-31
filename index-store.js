(() => {
  'use strict';

  const FORMAT = 'still-photo-library-index';
  const VERSION = 1;
  const now = () => new Date().toISOString();

  function normalizePath(path) {
    if (typeof path !== 'string' || !path) { throw new Error('Entry paths must be relative.'); }
    const canonical = path.replace(/\\/g, '/').normalize('NFC');
    if (canonical.startsWith('/') || (/^[a-z]:/i).test(canonical)) { throw new Error('Entry paths must be relative.'); }
    const segments = canonical.split('/').filter(segment => segment && segment !== '.');
    if (!segments.length || segments.some(segment => segment === '..')) throw new Error('Entry path contains an invalid segment.');
    return segments.join('/');
  }

  function metadataCopy(metadata) {
    const value = metadata && typeof metadata === 'object' ? metadata : {};
    return {
      tags: Array.isArray(value.tags) ? [...new Set(value.tags.filter(tag => typeof tag === 'string'))] : [],
      favorite: value.favorite === true,
      albumIds: Array.isArray(value.albumIds) ? [...new Set(value.albumIds.filter(id => typeof id === 'string'))] : []
    };
  }

  function create(root = '') {
    const timestamp = now();
    return { format: FORMAT, version: VERSION, root, createdAt: timestamp, updatedAt: timestamp, albums: [], entries: [] };
  }

  function createRecord(photo, previous, firstIndexedAt) {
    const path = normalizePath(photo.path);
    const name = path.split('/').pop();
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return {
      id: path,
      path,
      name,
      folder,
      extension,
      size: Number.isFinite(photo.size) && photo.size >= 0 ? photo.size : null,
      lastModified: Number.isFinite(photo.lastModified) && photo.lastModified >= 0 ? photo.lastModified : null,
      dateTaken: photo.dateTaken ?? previous?.dateTaken ?? null,
      metadata: metadataCopy(previous?.metadata),
      contentHash: previous && previous.size === photo.size && previous.lastModified === photo.lastModified ? previous.contentHash ?? null : null,
      firstIndexedAt: previous?.firstIndexedAt || firstIndexedAt || now(),
      missing: false,
      missingSince: null
    };
  }

  function isProtectedPath(path, protectedPaths) {
    return protectedPaths.some(blocked => blocked === '' || path === blocked || path.startsWith(`${blocked}/`));
  }

  function reconcile(index, discovered, inaccessiblePaths = []) {
    const previousEntries = new Map(index.entries.map(entry => [entry.id, entry]));
    const discoveredIds = new Set();
    const entries = [];
    const summary = { added: 0, updated: 0, unchanged: 0, missing: 0, protected: 0 };
    const timestamp = now();

    for (const photo of discovered) {
      const id = normalizePath(photo.path);
      if (discoveredIds.has(id)) continue;
      discoveredIds.add(id);
      const previous = previousEntries.get(id);
      const entry = createRecord(photo, previous, timestamp);
      if (!previous) summary.added++;
      else {
        const changed = previous.size !== entry.size || previous.lastModified !== entry.lastModified || previous.name !== entry.name || previous.folder !== entry.folder || previous.extension !== entry.extension;
        summary[changed ? 'updated' : 'unchanged']++;
      }
      entries.push(entry);
    }

    for (const previous of previousEntries.values()) {
      if (discoveredIds.has(previous.id)) continue;
      if (isProtectedPath(previous.path, inaccessiblePaths)) {
        entries.push(previous);
        summary.protected++;
      } else {
        entries.push({ ...previous, missing: true, missingSince: previous.missingSince || timestamp });
        summary.missing++;
      }
    }

    return {
      index: { ...index, updatedAt: timestamp, entries },
      summary
    };
  }

  function validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Index must be a JSON object.' };
    if (raw.format !== FORMAT) return { ok: false, error: 'This file is not a MiLeo Photo Library index.' };
    if (raw.version !== VERSION) return { ok: false, error: `Unsupported index version: ${String(raw.version)}. This app supports version ${VERSION}.` };
    if (typeof raw.root !== 'string' || raw.root.length > 1024 || !Array.isArray(raw.entries) || !Array.isArray(raw.albums)) return { ok: false, error: 'Index structure is incomplete or invalid.' };
    if (raw.entries.length > 500000 || raw.albums.length > 50000) return { ok: false, error: 'Index exceeds supported entry limits.' };

    const albumIds = new Set();
    const albums = [];
    for (const album of raw.albums) {
      if (!album || typeof album.id !== 'string' || !album.id || album.id.length > 256 || typeof album.name !== 'string' || !album.name || album.name.length > 512 || albumIds.has(album.id)) return { ok: false, error: 'Index contains an invalid or duplicate album.' };
      albumIds.add(album.id);
      albums.push({ id: album.id, name: album.name });
    }

    const seen = new Set();
    const entries = [];
    for (const candidate of raw.entries) {
      if (!candidate || typeof candidate !== 'object') return { ok: false, error: 'Index contains an invalid file entry.' };
      let path;
      try { path = normalizePath(candidate.path); } catch (error) { return { ok: false, error: error.message }; }
      if (candidate.id !== path || seen.has(path)) return { ok: false, error: `Index contains a duplicate or mismatched path: ${path}` };
      if (!(candidate.size === null || (Number.isFinite(candidate.size) && candidate.size >= 0)) || !(candidate.lastModified === null || (Number.isFinite(candidate.lastModified) && candidate.lastModified >= 0))) return { ok: false, error: `Invalid file metadata for ${path}.` };
      if (!(candidate.dateTaken === null || (typeof candidate.dateTaken === 'string' && Number.isFinite(Date.parse(candidate.dateTaken))))) return { ok: false, error: `Invalid dateTaken value for ${path}.` };
      const metadata = candidate.metadata;
      if (!metadata || typeof metadata.favorite !== 'boolean' || !Array.isArray(metadata.tags) || !Array.isArray(metadata.albumIds) || metadata.tags.length > 100 || metadata.albumIds.length > 100) return { ok: false, error: `Invalid user metadata for ${path}.` };
      if (metadata.tags.some(tag => typeof tag !== 'string' || tag.length > 512) || metadata.albumIds.some(id => typeof id !== 'string' || !albumIds.has(id))) return { ok: false, error: `Invalid tags or album references for ${path}.` };
      if (candidate.contentHash !== null && typeof candidate.contentHash !== 'string') return { ok: false, error: `Invalid content hash for ${path}.` };
      if (typeof candidate.missing !== 'boolean') return { ok: false, error: `Invalid missing-file state for ${path}.` };
      if (!(candidate.firstIndexedAt === null || (typeof candidate.firstIndexedAt === 'string' && Number.isFinite(Date.parse(candidate.firstIndexedAt))))) return { ok: false, error: `Invalid first-indexed date for ${path}.` };
      if (!(candidate.missingSince === null || (typeof candidate.missingSince === 'string' && Number.isFinite(Date.parse(candidate.missingSince))))) return { ok: false, error: `Invalid missing date for ${path}.` };
      const record = createRecord({ path, size: candidate.size, lastModified: candidate.lastModified }, candidate, candidate.firstIndexedAt);
      record.dateTaken = candidate.dateTaken;
      record.metadata = metadataCopy(metadata);
      record.contentHash = candidate.contentHash;
      record.missing = candidate.missing;
      record.missingSince = candidate.missingSince;
      seen.add(path);
      entries.push(record);
    }

    const index = {
      format: FORMAT,
      version: VERSION,
      root: raw.root,
      createdAt: typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : now(),
      updatedAt: typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : now(),
      albums,
      entries
    };
    return { ok: true, index };
  }

  function mergeLegacy(index, legacy) {
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return index;
    const entries = new Map(index.entries.map(entry => [entry.id, entry]));
    const albums = new Map(index.albums.map(album => [album.name, album]));
    for (const [oldPath, oldMetadata] of Object.entries(legacy)) {
      if (!oldMetadata || typeof oldMetadata !== 'object') continue;
      let path;
      try { path = normalizePath(oldPath); } catch { continue; }
      let entry = entries.get(path);
      if (!entry) {
        entry = createRecord({ path }, null);
        entry.missing = true;
        entry.missingSince = now();
        entries.set(path, entry);
      }
      const legacyAlbumIds = [];
      for (const name of Array.isArray(oldMetadata.albums) ? oldMetadata.albums : []) {
        if (typeof name !== 'string' || !name) continue;
        if (!albums.has(name)) {
          const id = `legacy-${name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-') || 'album'}`;
          let uniqueId = id;
          let suffix = 2;
          while (index.albums.some(album => album.id === uniqueId && album.name !== name)) uniqueId = `${id}-${suffix++}`;
          const album = { id: uniqueId, name };
          index.albums.push(album);
          albums.set(name, album);
        }
        legacyAlbumIds.push(albums.get(name).id);
      }
      entry.metadata = {
        tags: [...new Set([...entry.metadata.tags, ...(Array.isArray(oldMetadata.tags) ? oldMetadata.tags.filter(tag => typeof tag === 'string') : [])])],
        favorite: entry.metadata.favorite || oldMetadata.favorite === true,
        albumIds: [...new Set([...entry.metadata.albumIds, ...legacyAlbumIds])]
      };
      if (!entry.firstIndexedAt && Number.isFinite(oldMetadata.added)) entry.firstIndexedAt = new Date(oldMetadata.added).toISOString();
    }
    index.entries = [...entries.values()];
    return index;
  }

  // Adds or refreshes one entry without touching the rest of the index.
  function addPhoto(index, photo, contentHash = null) {
    const id = normalizePath(photo.path);
    const previous = index.entries.find(entry => entry.id === id);
    const entry = createRecord({ ...photo, dateTaken: photo.dateTaken ?? previous?.dateTaken ?? null }, previous, now());
    if (contentHash) entry.contentHash = contentHash;
    const entries = previous ? index.entries.map(item => (item.id === id ? entry : item)) : [...index.entries, entry];
    return { ...index, updatedAt: now(), entries };
  }

  // Rewrites every entry under `from` to live under `to`, keeping tags, favorites and albums.
  function moveFolder(index, from, to) {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (target === source || target.startsWith(`${source}/`)) throw new Error('A folder cannot be moved into itself.');
    const moved = index.entries.map(entry => {
      if (entry.path !== source && !entry.path.startsWith(`${source}/`)) return entry;
      const next = createRecord({ path: target + entry.path.slice(source.length), size: entry.size, lastModified: entry.lastModified }, entry, entry.firstIndexedAt);
      next.missing = entry.missing; next.missingSince = entry.missingSince;
      return next;
    });
    const ids = new Set();
    for (const entry of moved) {
      if (ids.has(entry.id)) throw new Error('Moving would create duplicate entries.');
      ids.add(entry.id);
    }
    return { index: { ...index, updatedAt: now(), entries: moved }, changed: moved.filter((entry, i) => entry !== index.entries[i]).length };
  }

  const store = { FORMAT, VERSION, create, normalizePath, reconcile, validate, mergeLegacy, addPhoto, moveFolder };
  if (typeof module !== 'undefined' && module.exports) module.exports = store;
  if (typeof window !== 'undefined') window.PhotoIndexStore = store;
})();