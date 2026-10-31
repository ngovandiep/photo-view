'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const store = require('../index-store.js');

async function harness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'family-admin-'));
  const handlers = new Map();
  const libraryId = 'c'.repeat(64);
  const manifest = path.join(root, 'libraries.json');
  await fs.writeFile(manifest, JSON.stringify({ libraries: [{ id: libraryId, name: 'Test library', path: root }] }));
  const index = store.create('Test library');
  index.albums = [{ id: 'album', name: 'Family album' }];
  const accounts = [{ id: 1, email: 'family@example.test', role: 'editor', disabled_at: null }];
  const filename = path.resolve(__dirname, '..', 'electron', 'wifi-sync', 'ipc.cjs');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const requireStub = name => name === 'electron' ? { nativeImage: {} } : realRequire(name);
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), { require: requireStub, module, exports: module.exports, Buffer, console }, { filename });
  let busy = false;
  const service = module.exports.register({
    app: { getPath: () => root, getVersion: () => 'test', on: () => {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    safeStorage: { isEncryptionAvailable: () => false }, getWindow: () => null,
    manifestPath: () => manifest, readIndex: async () => index, saveIndex: async () => {}, indexStore: store,
    getAccount: async () => null, listAccountUsers: () => accounts, backup: { busy: () => busy }
  });
  const invoke = (name, ...args) => handlers.get(name)({ sender: { id: 1 } }, ...args);
  t.after(async () => { await service.stop(); service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { invoke, service, libraryId, accounts, setBusy: value => { busy = value; } };
}

test('family administration is locked, audited, backup-gated and validates album references', async t => {
  const h = await harness(t);
  assert.equal((await h.invoke('admin:family')).locked, true);
  assert.equal((await h.invoke('admin:family-save', { action: 'mode', enabled: true })).locked, true);
  assert.equal(h.service.repo.getSettings().familyEnabled, false);
  assert.equal((await h.invoke('admin:login', 'admin', '123456')).ok, true);
  assert.equal((await h.invoke('admin:family-save', { action: 'profile', profile: { accountId: 1, name: 'Family', role: 'contributor', enabled: true } })).ok, true);
  let data = (await h.invoke('admin:family')).data;
  const profileId = data.profiles[0].id;
  assert.deepEqual(Object.keys(data.accounts[0]).sort(), ['disabled', 'email', 'id']);
  const code = h.service.repo.createPairingCode(120);
  const device = h.service.repo.claimPairingCode(code.code, 'Phone', 'android');
  assert.equal((await h.invoke('admin:family-save', { action: 'device', deviceId: device.id, policy: { profileId, uploadEnabled: true, allowImages: true, allowVideos: false, maxFileSizeMB: 100 } })).ok, true);
  const grant = { action: 'grant', profileId, libraryId: h.libraryId, albumId: 'album', enabled: true };
  assert.equal((await h.invoke('admin:family-save', { ...grant, albumId: 'not-an-album' })).ok, false);
  assert.equal((await h.invoke('admin:family-save', grant)).ok, true);
  h.setBusy(true);
  assert.equal((await h.invoke('admin:family-save', { action: 'mode', enabled: true })).ok, false);
  h.setBusy(false);
  assert.equal((await h.invoke('admin:family-save', { action: 'mode', enabled: true })).ok, true);
  data = (await h.invoke('admin:family')).data;
  assert.equal(data.enabled, true);
  assert.equal(data.devices[0].profile_id, profileId);
  assert.equal(data.grants[0].album_id, 'album');
  assert.ok(h.service.db.prepare("SELECT 1 FROM activity_log WHERE kind='family_mode_changed'").get());
  assert.throws(() => h.service.updateSettings({ familyEnabled: false }), /unlocked Admin/);
  await h.invoke('admin:logout');
  assert.equal((await h.invoke('admin:family-save', { ...grant, enabled: false })).locked, true);
});
