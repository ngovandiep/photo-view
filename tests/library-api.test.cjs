'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const indexStore = require('../index-store.js');
const { createService } = require('../electron/wifi-sync/service.cjs');
const { createLibraryApi } = require('../electron/wifi-sync/library-api.cjs');

async function harness({ login = true, trash = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-api-'));
  const library = { id: 'b'.repeat(64), root: path.join(root, 'photos'), name: 'photos' };
  await fs.mkdir(path.join(library.root, 'trip'), { recursive: true });
  const files = { 'IMG_20240105_101010.jpg': Buffer.from('jpeg-data'), 'trip/VID_20240301.mp4': Buffer.alloc(100, 7), 'trip/doc.pdf': Buffer.from('%PDF-1.4'), 'old.jpg': Buffer.from('old') };
  for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(library.root, name), data);
  let index = indexStore.reconcile(indexStore.create('photos'), Object.entries(files).map(([name, data]) => ({ path: name, size: data.length, lastModified: 1600000000000 }))).index;
  await fs.writeFile(path.join(root, 'secret.txt'), 'secret');
  const libraryApi = createLibraryApi({
    listLibraries: () => [library],
    resolveLibrary: id => (id === library.id ? library : null),
    readIndex: async () => structuredClone(index),
    saveIndex: async (_id, next) => { index = next; },
    makeThumbnail: () => Buffer.from('thumb'),
    thumbDir: path.join(root, 'thumbs'),
    getAccount: async () => ({ displayName: 'Demo', email: 'demo@still.local' }),
    verifyLogin: async (email, password) => (password === 'secret-pw' ? { email } : null),
    trashItem: trash
  });
  const service = createService({ dataDir: path.join(root, 'data'), resolveLibrary: () => library, listLibraries: () => [library], indexPhoto: async () => {}, libraryApi, tls: false, host: '127.0.0.1' });
  service.repo.setSettings({ port: 0, destinationLibraryId: library.id, minFreeSpaceMB: 0 });
  await service.start();
  const base = service.status().url;
  const { code } = await service.createPairing();
  const claim = await (await fetch(`${base}/api/v1/pairing/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'Phone', platform: 'web' }) })).json();
  const get = (route, headers = {}) => fetch(`${base}/api/v1${route}`, { headers: { Authorization: `Bearer ${claim.token}`, ...headers } });
  const post = (route, body) => fetch(`${base}/api/v1${route}`, { method: 'POST', headers: { Authorization: 'Bearer ' + claim.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (login) await post('/login', { email: 'demo@still.local', password: 'secret-pw' });
  return { root, library, base, token: claim.token, get, post, getIndex: () => index, async close() { await service.stop(); service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('a paired phone must sign in to the desktop account before browsing', async () => {
  const h = await harness({ login: false });
  try {
    const me = await (await h.get('/me')).json();
    assert.equal(me.loginRequired, true);
    assert.equal(me.loggedIn, false);
    assert.equal(me.account, null);
    const blocked = await h.get('/libraries');
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'login_required');
    assert.equal((await h.get(`/libraries/${h.library.id}/file?path=old.jpg`)).status, 403);
    assert.equal((await h.post('/login', { email: 'demo@still.local', password: 'wrong' })).status, 403);
    assert.equal((await h.post('/login', { email: 'other@x.com', password: 'secret-pw' })).status, 403);
    assert.equal((await h.get('/libraries')).status, 403);
    assert.equal((await h.post('/login', { email: 'Demo@still.local', password: 'secret-pw' })).status, 200);
    assert.equal((await h.get('/libraries')).status, 200);
    await h.post('/logout', {});
    assert.equal((await h.get('/libraries')).status, 403);
  } finally { await h.close(); }
});

test('a phone sign-in is saved to disk and survives a restart until sign-out', async () => {
  const h = await harness();
  try {
    const file = path.join(h.root, 'phone-logins.json');
    assert.deepEqual(Object.values(JSON.parse(await fs.readFile(file, 'utf8'))), ['demo@still.local']);
    await h.post('/logout', {});
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
  } finally { await h.close(); }
});

test('library browsing requires pairing and lists filtered, counted, date-sorted items', async () => {
  const h = await harness();
  try {
    assert.equal((await fetch(`${h.base}/api/v1/libraries`)).status, 401);
    const me = await (await h.get('/me')).json();
    assert.equal(me.account.email, 'demo@still.local');
    const libs = await (await h.get('/libraries')).json();
    assert.deepEqual(libs.libraries.map(l => [l.id, l.count]), [[h.library.id, 4]]);
    const all = await (await h.get(`/libraries/${h.library.id}/items`)).json();
    assert.equal(all.total, 4);
    assert.deepEqual(all.counts, { all: 4, photo: 2, video: 1, document: 1 });
    assert.equal(all.items[0].path, 'trip/VID_20240301.mp4');
    const videos = await (await h.get(`/libraries/${h.library.id}/items?kind=video`)).json();
    assert.deepEqual(videos.items.map(item => item.kind), ['video']);
    const search = await (await h.get(`/libraries/${h.library.id}/items?q=doc`)).json();
    assert.equal(search.total, 1);
  } finally { await h.close(); }
});

test('timeline groups items into month buckets and items can be filtered by month', async () => {
  const h = await harness();
  try {
    const t = await (await h.get(`/libraries/${h.library.id}/timeline`)).json();
    assert.equal(t.total, 4);
    assert.deepEqual(t.buckets.map(b => [b.key, b.count]), [['2024-03', 1], ['2024-01', 1], ['2020-09', 2]]);
    assert.equal(t.buckets[0].sample[0].path, 'trip/VID_20240301.mp4');
    assert.equal(t.buckets[2].sample.length, 1);
    const month = await (await h.get(`/libraries/${h.library.id}/items?month=2024-01`)).json();
    assert.deepEqual(month.items.map(i => i.path), ['IMG_20240105_101010.jpg']);
    const photos = await (await h.get(`/libraries/${h.library.id}/timeline?kind=photo`)).json();
    assert.equal(photos.total, 2);
  } finally { await h.close(); }
});

test('folders can be listed and filtered, and deleting moves files to the bin and hides them', async () => {
  const trashed = [];
  const h = await harness({ trash: async file => { trashed.push(path.relative(h0.library.root, file).replace(/\\/g, '/')); await fs.rm(file); } });
  const h0 = h;
  try {
    const base = `/libraries/${h.library.id}`;
    const root = await (await h.get(`${base}/folders`)).json();
    assert.deepEqual(root.folders, [{ name: 'trip', path: 'trip', count: 2 }]);
    assert.equal(root.direct, 2);
    const inTrip = await (await h.get(`${base}/items?folder=trip`)).json();
    assert.equal(inTrip.total, 2);
    assert.equal((await (await h.get(`${base}/items?folder=`)).json()).total, 2);
    assert.equal((await h.post(`${base}/delete`, {})).status, 400);
    assert.equal((await h.post(`${base}/delete`, { folders: [''] })).status, 400);
    assert.equal((await h.post(`${base}/delete`, { folders: ['../x'] })).status, 400);
    const one = await (await h.post(`${base}/delete`, { paths: ['old.jpg', '../secret.txt'] })).json();
    assert.deepEqual(one, { deleted: 1, failed: 0 });
    const gone = await (await h.post(`${base}/delete`, { folders: ['trip'] })).json();
    assert.deepEqual(gone, { deleted: 2, failed: 0 });
    assert.deepEqual(trashed.sort(), ['old.jpg', 'trip/VID_20240301.mp4', 'trip/doc.pdf']);
    const left = await (await h.get(`${base}/items`)).json();
    assert.deepEqual(left.items.map(item => item.path), ['IMG_20240105_101010.jpg']);
    assert.equal(h.getIndex().entries.find(entry => entry.path === 'old.jpg').missing, true);
    await fs.access(path.join(h.root, 'secret.txt'));
  } finally { await h.close(); }
});

test('files stream with ranges, thumbnails work, and paths cannot escape the library', async () => {
  const h = await harness();
  try {
    const base = `/libraries/${h.library.id}`;
    const ranged = await h.get(`${base}/file?path=${encodeURIComponent('trip/VID_20240301.mp4')}`, { Range: 'bytes=10-19' });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), 'bytes 10-19/100');
    assert.equal((await ranged.arrayBuffer()).byteLength, 10);
    assert.equal(ranged.headers.get('content-type'), 'video/mp4');
    const thumb = await h.get(`${base}/thumb?path=IMG_20240105_101010.jpg`);
    assert.equal(thumb.status, 200);
    assert.equal(await thumb.text(), 'thumb');
    for (const bad of ['../secret.txt', '..%2Fsecret.txt', 'trip/../../secret.txt', 'secret.txt', 'C:\\Windows\\win.ini']) {
      assert.equal((await h.get(`${base}/file?path=${bad}`)).status, 404, bad);
    }
    assert.equal((await h.get(`${base}/thumb?path=trip/VID_20240301.mp4`)).status, 404);
  } finally { await h.close(); }
});

test('favorite is saved to the library index; cookie sessions need the app header for writes', async () => {
  const h = await harness();
  try {
    const route = `/libraries/${h.library.id}/favorite`;
    const post = (headers, body) => fetch(`${h.base}/api/v1${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const ok = await post({ Authorization: `Bearer ${h.token}` }, { path: 'old.jpg', favorite: true });
    assert.equal(ok.status, 200);
    assert.equal(h.getIndex().entries.find(e => e.path === 'old.jpg').metadata.favorite, true);
    const favs = await (await h.get(`/libraries/${h.library.id}/items?favorite=1`)).json();
    assert.deepEqual(favs.items.map(i => i.path), ['old.jpg']);
    const session = await fetch(`${h.base}/api/v1/session`, { method: 'POST', headers: { Authorization: `Bearer ${h.token}` } });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    assert.match(session.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await fetch(`${h.base}/api/v1/libraries`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await post({ Cookie: cookie }, { path: 'old.jpg', favorite: false })).status, 403);
    assert.equal((await post({ Cookie: cookie, 'X-Still-App': '1' }, { path: 'old.jpg', favorite: false })).status, 200);
    assert.equal((await post({ Authorization: `Bearer ${h.token}` }, { path: 'missing.jpg', favorite: true })).status, 404);
  } finally { await h.close(); }
});

test('the phone web app is served at / and /app', async () => {
  const h = await harness();
  try {
    for (const route of ['/', '/app', '/app.js', '/app.css']) assert.equal((await fetch(h.base + route)).status, 200, route);
  } finally { await h.close(); }
});
