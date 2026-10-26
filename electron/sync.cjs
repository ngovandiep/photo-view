'use strict';

// Only user annotations (favorites, tags, albums) are synced; photos and file metadata stay local.
function extractAnnotations(index) {
  const entries = index.entries
    .filter(entry => entry.metadata.favorite || entry.metadata.tags.length || entry.metadata.albumIds.length)
    .map(entry => ({ path: entry.path, favorite: entry.metadata.favorite, tags: entry.metadata.tags, albumIds: entry.metadata.albumIds }));
  return { albums: index.albums.map(album => ({ id: album.id, name: album.name })), entries };
}

// Additive merge: remote annotations are added to the local index and nothing local is removed.
function mergeAnnotations(index, remote) {
  const albums = new Map(index.albums.map(album => [album.id, album]));
  const knownNames = new Set(index.albums.map(album => album.name));
  for (const album of remote.albums || []) {
    if (typeof album.id === 'string' && typeof album.name === 'string' && !albums.has(album.id) && !knownNames.has(album.name)) {
      albums.set(album.id, { id: album.id, name: album.name });
    }
  }
  const byPath = new Map(index.entries.map(entry => [entry.path, entry]));
  let changed = 0;
  for (const item of remote.entries || []) {
    const entry = byPath.get(item.path);
    if (!entry) continue;
    const before = JSON.stringify(entry.metadata);
    const meta = entry.metadata;
    if (item.favorite === true) meta.favorite = true;
    for (const tag of Array.isArray(item.tags) ? item.tags : []) {
      if (typeof tag === 'string' && tag.length <= 512 && !meta.tags.includes(tag) && meta.tags.length < 100) meta.tags.push(tag);
    }
    for (const id of Array.isArray(item.albumIds) ? item.albumIds : []) {
      if (albums.has(id) && !meta.albumIds.includes(id) && meta.albumIds.length < 100) meta.albumIds.push(id);
    }
    if (JSON.stringify(meta) !== before) changed += 1;
  }
  return { index: { ...index, albums: [...albums.values()], updatedAt: new Date().toISOString() }, changed };
}

module.exports = { extractAnnotations, mergeAnnotations };
