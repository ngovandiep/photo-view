'use strict';

const path = require('node:path');
const QRCode = require('qrcode');
const { openSyncDb } = require('./db.cjs');
const { createRepo } = require('./repo.cjs');
const { createImporter } = require('./importer.cjs');
const { createSyncServer } = require('./server.cjs');
const security = require('./security.cjs');

function createService({ dataDir, resolveLibrary, listLibraries, indexPhoto, libraryApi = null, protect, unprotect, emit = () => {}, tls = true, host, now = Date.now }) {
  const db = openSyncDb(path.join(dataDir, 'wifi-sync.db'));
  const repo = createRepo(db, { now });
  const importer = createImporter({ repo, tempDir: path.join(dataDir, 'incoming'), resolveLibrary, indexPhoto, now });
  let server = null;
  let running = null;
  let retryTimer = null;
  let pairing = null;
  let certificate = null;
  const samples = [];

  const recordBytes = count => { samples.push([now(), count]); if (samples.length > 2000) samples.splice(0, 1000); };
  function speed() {
    const cutoff = now() - 5000;
    while (samples.length && samples[0][0] < cutoff) samples.shift();
    return Math.round(samples.reduce((sum, item) => sum + item[1], 0) / 5);
  }

  async function runRetries() {
    const due = db.prepare("SELECT id FROM assets WHERE state = 'failed_retryable' AND next_retry_at IS NOT NULL AND next_retry_at <= ?").all(now());
    for (const { id } of due) { await importer.retry(id); emit({ type: 'assets' }); }
  }

  async function start() {
    if (running) return status();
    const settings = repo.getSettings();
    const addresses = host ? [{ address: host }] : security.lanAddresses();
    if (!addresses.length) throw new Error('No private Wi-Fi/LAN address found. Connect this PC to a local network.');
    const address = addresses[0].address;
    try {
      certificate = tls ? await security.ensureCertificate(dataDir, { protect, unprotect }) : null;
      server = createSyncServer({ repo, importer, tls: certificate, libraryApi, onChange: emit, onBytes: recordBytes, now });
      const bound = await server.listen({ host: address, port: settings.port });
      running = { host: bound.host, port: bound.port, startedAt: now() };
    } catch (error) {
      server = null;
      repo.logEvent({ severity: 'error', kind: 'server_error', message: `Sync server failed to start: ${error.message}`, result: 'failed' });
      throw error;
    }
    repo.setSettings({ enabled: true });
    repo.logEvent({ kind: 'server_started', message: `Sync server started on ${address}:${running.port}.` });
    await importer.recover();
    retryTimer = setInterval(() => runRetries().catch(() => {}), 15000);
    retryTimer.unref?.();
    emit({ type: 'status' });
    return status();
  }

  async function stop({ persist = true } = {}) {
    clearInterval(retryTimer);
    retryTimer = null;
    const wasRunning = Boolean(running);
    if (server) await server.close();
    server = null;
    running = null;
    pairing = null;
    if (persist) repo.setSettings({ enabled: false });
    if (wasRunning && persist) repo.logEvent({ kind: 'server_stopped', message: 'Sync server stopped.' });
    emit({ type: 'status' });
    return status();
  }

  function url() { return running ? `${certificate ? 'https' : 'http'}://${running.host}:${running.port}` : null; }

  function status() {
    const settings = repo.getSettings();
    return {
      running: Boolean(running),
      url: url(),
      fingerprint: certificate?.fingerprint || null,
      settings,
      libraries: listLibraries(),
      devices: repo.listDevices(),
      stats: repo.stats(),
      speedBytesPerSecond: speed(),
      pairing: pairing && pairing.expiresAt > now() ? { code: security.formatCode(pairing.code), expiresAt: pairing.expiresAt } : null
    };
  }

  async function createPairing() {
    if (!running) throw new Error('Start Wi-Fi sync first.');
    const settings = repo.getSettings();
    const { code, expiresAt } = repo.createPairingCode(settings.pairingTtlSeconds);
    pairing = { code, expiresAt };
    repo.logEvent({ category: 'security', kind: 'pairing_code_created', message: 'A one-time pairing code was generated.' });
    const link = `${url()}/app#code=${code}&fp=${encodeURIComponent(certificate?.fingerprint || '')}&v=1`;
    const qr = await QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    return { code: security.formatCode(code), expiresAt, link, qr };
  }

  function updateSettings(patch) {
    const clean = { ...patch };
    if ('port' in clean && !(Number.isInteger(clean.port) && clean.port >= 1024 && clean.port <= 65535)) delete clean.port;
    for (const key of ['bandwidthLimitKBps', 'maxFileSizeMB', 'minFreeSpaceMB']) {
      if (key in clean && !(Number.isFinite(clean[key]) && clean[key] >= 0)) delete clean[key];
    }
    if ('pairingTtlSeconds' in clean && !(Number.isInteger(clean.pairingTtlSeconds) && clean.pairingTtlSeconds >= 30 && clean.pairingTtlSeconds <= 600)) delete clean.pairingTtlSeconds;
    if ('destinationFolder' in clean) clean.destinationFolder = String(clean.destinationFolder).trim().slice(0, 60) || 'Wi-Fi Sync';
    const before = repo.getSettings();
    const next = repo.setSettings(clean);
    const changed = Object.keys(next).filter(key => next[key] !== before[key]);
    if (changed.length) repo.logEvent({ kind: 'config_changed', message: `Configuration changed: ${changed.join(', ')}.` });
    emit({ type: 'status' });
    return next;
  }

  async function revokeDevice(id) {
    const result = repo.revokeDevice(id);
    result.cancelled.forEach(assetId => importer.discardTemp(assetId));
    emit({ type: 'status' });
    return result;
  }

  async function retryAsset(id) { const asset = await importer.retry(id); emit({ type: 'assets' }); return asset; }

  async function renameDevice(id, name) { const clean = repo.renameDevice(String(id), name); emit({ type: 'status' }); return clean; }
  async function removeDevice(id) {
    const result = repo.removeDevice(String(id));
    result.cancelled.forEach(assetId => importer.discardTemp(assetId));
    emit({ type: 'status' });
    return result;
  }

  return {
    repo, db, importer, start, stop, status, createPairing, updateSettings, revokeDevice, renameDevice, removeDevice, retryAsset,
    startedAt: () => (running ? running.startedAt : null), isRunning: () => Boolean(running), close: () => { db.close(); }
  };
}

module.exports = { createService };
