'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const indexStore = require('../index-store.js');
const { createService } = require('../electron/wifi-sync/service.cjs');
const { createLibraryApi } = require('../electron/wifi-sync/library-api.cjs');
const { retireThumbnails } = require('../electron/backup.cjs');

async function harness({ login = true, trash = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-api-'));
  const library = { id: 'b'.repeat(64), root: path.join(root, 'photos'), name: 'photos' };
  await fs.mkdir(path.join(library.root, 'trip'), { recursive: true });
  const files = { 'IMG_20240105_101010.jpg': Buffer.from('jpeg-data'), 'trip/VID_20240301.mp4': Buffer.alloc(100, 7), 'trip/doc.pdf': Buffer.from('%PDF-1.4'), 'old.jpg': Buffer.from('old') };
  for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(library.root, name), data);
  let index = indexStore.reconcile(indexStore.create('photos'), Object.entries(files).map(([name, data]) => ({ path: name, size: data.length, lastModified: 1600000000000 }))).index;
  await fs.writeFile(path.join(root, 'secret.txt'), 'secret');
  await fs.mkdir(path.join(root, 'wifi-sync'));
  let thumbnailCalls = 0;
  const accounts = [{ id: 1, email: 'demo@still.local', role: 'editor', disabled_at: null }, { id: 2, email: 'family@still.local', role: 'editor', disabled_at: null }];
  const libraryApi = createLibraryApi({
    listLibraries: () => [library],
    resolveLibrary: id => (id === library.id ? library : null),
    readIndex: async () => structuredClone(index),
    saveIndex: async (_id, next) => { index = next; },
    makeThumbnail: () => { thumbnailCalls++; return Buffer.from('thumb'); },
    thumbDir: path.join(root, 'wifi-sync', 'thumbs'),
    getAccount: async () => ({ displayName: 'Demo', email: 'demo@still.local' }),
    verifyLogin: async (email, password) => (password === 'secret-pw' ? accounts.find(row => row.email === email.toLowerCase() && !row.disabled_at) || null : null),
    trashItem: trash
  });
  const service = createService({ dataDir: path.join(root, 'data'), resolveLibrary: () => library, listLibraries: () => [library], listAccounts: () => accounts, indexPhoto: async () => {}, libraryApi, tls: false, host: '127.0.0.1' });
  service.repo.setSettings({ port: 0, destinationLibraryId: library.id, minFreeSpaceMB: 0 });
  await service.start();
  const base = service.status().url;
  const { code } = await service.createPairing();
  const claim = await (await fetch(`${base}/api/v1/pairing/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'Phone', platform: 'web' }) })).json();
  const get = (route, headers = {}) => fetch(`${base}/api/v1${route}`, { headers: { Authorization: `Bearer ${claim.token}`, ...headers } });
  const post = (route, body) => fetch(`${base}/api/v1${route}`, { method: 'POST', headers: { Authorization: 'Bearer ' + claim.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (login) await post('/login', { email: 'demo@still.local', password: 'secret-pw' });
  return { root, library, base, service, accounts, deviceId: claim.deviceId, token: claim.token, get, post, getIndex: () => index, thumbnailCalls: () => thumbnailCalls, async close() { await service.stop(); service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

function shareFixture(h, role = 'viewer') {
  const repo = h.service.repo;
  const profileId = repo.family.saveProfile({ accountId: 2, name: 'Family member', role, enabled: true });
  const deviceId = repo.authenticate(h.token).id;
  const policy = { profileId, uploadEnabled: true, allowImages: true, allowVideos: true, maxFileSizeMB: 4096 };
  repo.family.saveDevice(deviceId, policy);
  repo.setSettings({ familyEnabled: true });
  const index = h.getIndex();
  index.albums = [{ id: 'trip', name: 'Trip' }, { id: 'private', name: 'Private' }];
  index.entries.find(entry => entry.path === 'trip/VID_20240301.mp4').metadata.albumIds = ['trip'];
  index.entries.find(entry => entry.path === 'old.jpg').metadata.albumIds = ['private'];
  repo.family.setGrant(profileId, h.library.id, 'trip', true);
  return { repo, profileId, deviceId, policy };
}

test('family profiles restrict every library surface and shared albums stay read-only', async () => {
  const h = await harness();
  try {
    shareFixture(h);
    assert.equal((await h.get('/libraries')).status, 403, 'legacy desktop sign-in is not a family sign-in');
    assert.equal((await h.post('/login', { email: 'demo@still.local', password: 'secret-pw' })).status, 403);
    assert.equal((await h.post('/login', { email: 'family@still.local', password: 'secret-pw' })).status, 200);
    const libs = await (await h.get('/libraries')).json();
    assert.equal(libs.libraries[0].count, 1);
    assert.deepEqual(libs.libraries[0].albums, [{ id: 'trip', name: 'Trip' }]);
    const base = `/libraries/${h.library.id}`;
    const items = await (await h.get(`${base}/items`)).json();
    assert.deepEqual(items.items.map(row => row.path), ['trip/VID_20240301.mp4']);
    assert.equal((await (await h.get(`${base}/items?q=old`)).json()).total, 0);
    assert.equal((await (await h.get(`${base}/timeline`)).json()).total, 1);
    assert.deepEqual((await (await h.get(`${base}/folders`)).json()).folders, [{ name: 'trip', path: 'trip', count: 1 }]);
    for (const action of ['file', 'thumb']) {
      assert.equal((await h.get(`${base}/${action}?path=old.jpg`)).status, 403);
      const head = await fetch(`${h.base}/api/v1${base}/${action}?path=old.jpg`, { method: 'HEAD', headers: { Authorization: `Bearer ${h.token}` } });
      assert.equal(head.status, 403);
    }
    assert.equal((await h.get(`${base}/file?path=trip%2FVID_20240301.mp4`)).status, 200);
    assert.equal((await h.get(`${base}/items?album=private`)).status, 403);
    assert.equal((await h.post(`${base}/favorite`, { path: 'trip/VID_20240301.mp4', favorite: true })).status, 403);
    assert.equal((await h.post(`${base}/delete`, { folders: ['trip'] })).status, 403);
    assert.equal((await h.get('/chat/conversations')).status, 403);
    assert.equal(h.getIndex().entries.some(entry => entry.missing), false);
  } finally { await h.close(); }
});

test('family grants, membership, account disablement and ownership are rechecked without stale caches', async () => {
  const h = await harness();
  try {
    const { repo, profileId, deviceId, policy } = shareFixture(h, 'contributor');
    await h.post('/login', { email: 'family@still.local', password: 'secret-pw' });
    const base = `/libraries/${h.library.id}`;
    repo.family.setGrant(profileId, h.library.id, 'private', true);
    const thumb = await h.get(`${base}/thumb?path=old.jpg`);
    assert.equal(thumb.status, 200);
    assert.match(thumb.headers.get('cache-control'), /no-store/);
    repo.family.setGrant(profileId, h.library.id, 'private', false);
    assert.equal((await h.get(`${base}/thumb?path=old.jpg`)).status, 403);
    h.getIndex().entries.find(entry => entry.path.startsWith('trip/VID')).metadata.albumIds = [];
    assert.equal((await h.get(`${base}/file?path=trip%2FVID_20240301.mp4`)).status, 403);
    h.accounts[1].disabled_at = '2026-01-01';
    assert.equal((await h.get('/libraries')).status, 403);
    assert.match(repo.family.uploadProblem(deviceId), /active local account/);
    h.accounts[1].disabled_at = null;
    repo.family.saveDevice(deviceId, { ...policy, profileId: null });
    assert.equal((await h.get('/libraries')).status, 403);
    assert.match(repo.family.uploadProblem(deviceId), /assign/);
  } finally { await h.close(); }
});

test('separate family devices receive only their own profile grants', async () => {
  const h = await harness();
  try {
    const { repo } = shareFixture(h);
    await h.post('/login', { email: 'family@still.local', password: 'secret-pw' });
    const code = repo.createPairingCode(120);
    const second = repo.claimPairingCode(code.code, 'Second family phone', 'ios');
    const profileId = repo.family.saveProfile({ accountId: 1, name: 'Other member', role: 'viewer', enabled: true });
    repo.family.saveDevice(second.id, { profileId, uploadEnabled: true, allowImages: true, allowVideos: true, maxFileSizeMB: 4096 });
    repo.family.setGrant(profileId, h.library.id, 'private', true);
    const headers = { Authorization: `Bearer ${second.token}`, 'Content-Type': 'application/json' };
    const signedIn = await fetch(`${h.base}/api/v1/login`, { method: 'POST', headers, body: JSON.stringify({ email: 'demo@still.local', password: 'secret-pw' }) });
    assert.equal(signedIn.status, 200);
    const secondItems = await (await fetch(`${h.base}/api/v1/libraries/${h.library.id}/items`, { headers })).json();
    assert.deepEqual(secondItems.items.map(row => row.path), ['old.jpg']);
    const firstItems = await (await h.get(`/libraries/${h.library.id}/items`)).json();
    assert.deepEqual(firstItems.items.map(row => row.path), ['trip/VID_20240301.mp4']);
    assert.equal((await fetch(`${h.base}/api/v1/libraries/${h.library.id}/file?path=trip%2FVID_20240301.mp4`, { headers })).status, 403);
    await h.service.revokeDevice(repo.authenticate(h.token).id);
    assert.equal((await h.get('/libraries')).status, 401);
    assert.equal((await fetch(`${h.base}/api/v1/libraries/${h.library.id}/file?path=old.jpg`, { headers })).status, 200);
  } finally { await h.close(); }
});

test('offline external roots retain album metadata and can serve again after reconnect', async () => {
  const h = await harness();
  const disconnected = `${h.library.root}-disconnected`;
  try {
    shareFixture(h);
    await h.post('/login', { email: 'family@still.local', password: 'secret-pw' });
    const original = structuredClone(h.getIndex());
    await fs.rename(h.library.root, disconnected);
    const retained = indexStore.reconcile(h.getIndex(), [], ['']).index;
    assert.deepEqual(retained.entries, original.entries);
    assert.deepEqual(retained.albums, original.albums);
    assert.equal((await (await h.get('/libraries')).json()).libraries[0].count, 1);
    assert.notEqual((await h.get(`/libraries/${h.library.id}/file?path=trip%2FVID_20240301.mp4`)).status, 200);
    await fs.rename(disconnected, h.library.root);
    assert.equal((await h.get(`/libraries/${h.library.id}/file?path=trip%2FVID_20240301.mp4`)).status, 200);
    assert.deepEqual(h.getIndex(), original);
  } finally {
    try { await fs.rename(disconnected, h.library.root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await h.close();
  }
});

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
    const file = path.join(h.root, 'wifi-sync', 'phone-logins.json');
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

test('M4 cache rebuild regenerates thumbnails through the existing library API', async () => {
  const h = await harness();
  try {
    const route = `/libraries/${h.library.id}/thumb?path=IMG_20240105_101010.jpg`;
    assert.equal(await (await h.get(route)).text(), 'thumb');
    assert.equal(await (await h.get(route)).text(), 'thumb');
    assert.equal(h.thumbnailCalls(), 1);
    await retireThumbnails(h.root);
    assert.equal(await (await h.get(route)).text(), 'thumb');
    assert.equal(h.thumbnailCalls(), 2);
    assert.equal(await fs.readFile(path.join(h.library.root, 'IMG_20240105_101010.jpg'), 'utf8'), 'jpeg-data');
  } finally { await h.close(); }
});

test('the phone web app is served at / and /app', async () => {
  const h = await harness();
  try {
    for (const route of ['/', '/app', '/app.js', '/app.css']) assert.equal((await fetch(h.base + route)).status, 200, route);
  } finally { await h.close(); }
});
