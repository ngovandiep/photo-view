'use strict';

// Starts the real MiLeo desktop sync service (electron/wifi-sync) with TLS and a temporary library so the
// Android client's JVM contract tests can run against it. Control API on 127.0.0.1 (plain HTTP, test only):
//   POST /pair           -> { link }            new one-time pairing link (QR payload)
//   POST /stop | /start  -> simulate the desktop going offline / coming back (same port and data)
//   POST /restart        -> close and recreate the service from its persisted database
//   POST /revoke {deviceId}
//   GET  /library        -> [{ path, size, sha256 }]  entries in the library index (verified from disk)
//   GET  /devices        -> registered devices
//   POST /shutdown       -> stop and delete the temporary library
// Usage: node tools/contract-server.cjs   (prints "CONTROL_URL=http://127.0.0.1:<port>")

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const indexStore = require(path.join(repoRoot, 'index-store.js'));
const { createService } = require(path.join(repoRoot, 'electron', 'wifi-sync', 'service.cjs'));

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  probe.on('error', reject);
});
const sha256 = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mileo-contract-'));
  const library = { id: 'c'.repeat(64), root: path.join(root, 'photos'), name: 'photos' };
  await fs.mkdir(library.root, { recursive: true });
  let index = indexStore.create('photos');
  const create = () => createService({
    dataDir: path.join(root, 'data'),
    resolveLibrary: id => (!id || id === library.id ? library : null),
    listLibraries: () => [library],
    findDuplicate: async (_libraryId, size, hash) => {
      for (const entry of index.entries) {
        if (entry.missing || entry.size !== size) continue;
        const file = path.join(library.root, ...entry.path.split('/'));
        try { if (await sha256(file) === hash) return entry.path; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return null;
    },
    indexPhoto: async (_id, photo, hash) => { index = indexStore.addPhoto(index, photo, hash); },
    tls: true,
    host: '127.0.0.1'
  });
  let service = create();
  service.repo.setSettings({ port: await freePort(), destinationLibraryId: library.id, minFreeSpaceMB: 0, pairingTtlSeconds: 120 });
  await service.start();

  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = async req => { let text = ''; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; };

  const control = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/pair') return json(res, 200, { link: (await service.createPairing()).link });
      if (req.method === 'POST' && req.url === '/stop') { await service.stop({ persist: false }); return json(res, 200, { running: false }); }
      if (req.method === 'POST' && req.url === '/start') { await service.start(); return json(res, 200, { running: true }); }
      if (req.method === 'POST' && req.url === '/restart') {
        await service.stop({ persist: false }); service.close(); service = create(); await service.start();
        return json(res, 200, { restarted: true });
      }
      if (req.method === 'POST' && req.url === '/revoke') {
        const { deviceId } = await readBody(req);
        return json(res, 200, service.repo.revokeDevice(deviceId));
      }
      if (req.method === 'GET' && req.url === '/library') {
        const entries = [];
        for (const entry of index.entries) {
          const file = path.join(library.root, ...entry.path.split('/'));
          entries.push({ path: entry.path, size: entry.size, sha256: await sha256(file).catch(() => null) });
        }
        return json(res, 200, entries);
      }
      if (req.method === 'GET' && req.url === '/devices') return json(res, 200, service.repo.listDevices());
      if (req.method === 'POST' && req.url === '/shutdown') { json(res, 200, { ok: true }); setImmediate(shutdown); return; }
      json(res, 404, { error: 'unknown' });
    } catch (error) {
      json(res, 500, { error: String(error && error.message || error) });
    }
  });
  control.listen(0, '127.0.0.1', () => console.log(`CONTROL_URL=http://127.0.0.1:${control.address().port}`));

  const shutdown = async () => {
    control.close();
    try { await service.stop({ persist: false }); service.close(); } catch { /* already stopped */ }
    await fs.rm(root, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => { console.error(error); process.exit(1); });
