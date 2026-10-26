(() => {
  'use strict';
  const api = window.wifiSync;
  if (!api) return;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const formatBytes = value => {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
  };
  const formatTime = stamp => (stamp ? new Date(stamp).toLocaleString() : 'Never');

  let status = null;
  let pairing = null;
  let panel;
  let backdrop;
  let timer = 0;
  let message = '';

  function build() {
    backdrop = el('div');
    backdrop.id = 'wifi-backdrop';
    backdrop.hidden = true;
    backdrop.addEventListener('click', close);
    panel = el('section');
    panel.id = 'wifi-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Wi-Fi Photo Sync');
    document.body.append(backdrop, panel);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(); });

    const button = el('button', 'wifi-open', 'Wi-Fi Sync');
    button.id = 'wifi-open';
    button.type = 'button';
    button.prepend(el('span', '', '⇄'));
    button.firstChild.setAttribute('aria-hidden', 'true');
    button.addEventListener('click', open);
    const footer = document.querySelector('.sidebar-footer');
    footer?.parentElement.insertBefore(button, footer);
  }

  async function call(action, ...args) {
    const result = await action(...args);
    if (!result.ok) { message = result.error; } else { message = ''; if (result.status) status = result.status; }
    render();
    return result;
  }

  async function open() {
    backdrop.hidden = false;
    panel.hidden = false;
    const result = await api.status();
    if (result.ok) status = result.status;
    render();
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    panel.querySelector('button')?.focus();
  }

  function close() {
    backdrop.hidden = true;
    panel.hidden = true;
    clearInterval(timer);
    document.getElementById('wifi-open')?.focus();
  }

  function tick() {
    const countdown = panel.querySelector('#wifi-countdown');
    if (pairing && countdown) {
      const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
      countdown.textContent = left ? `Expires in ${left}s` : 'Code expired';
      if (!left) { pairing = null; render(); }
    }
  }

  const refresh = async () => { const result = await api.status(); if (result.ok) { status = result.status; if (!panel.hidden) render(); } };
  let refreshTimer = 0;
  api.onEvent(event => {
    if (event.type === 'library-changed') window.dispatchEvent(new CustomEvent('still:library-changed', { detail: { libraryId: event.libraryId } }));
    if (event.type === 'device-paired') pairing = null;
    if (panel && !panel.hidden) { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 400); }
  });

  function section(title) {
    const wrap = el('div', 'wifi-section');
    wrap.append(el('h3', '', title));
    return wrap;
  }

  function field(label, input) {
    const wrap = el('label', 'wifi-field');
    wrap.append(el('span', '', label), input);
    return wrap;
  }

  function render() {
    if (!panel || !status) return;
    panel.replaceChildren();
    const head = el('div', 'wifi-head');
    head.append(el('h2', '', 'Wi-Fi Photo Sync'));
    const closeButton = el('button', 'wifi-close', '✕');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.addEventListener('click', close);
    head.append(closeButton);
    panel.append(head);
    if (message) { const note = el('p', 'wifi-error', message); note.setAttribute('role', 'alert'); panel.append(note); }

    const server = section('Server');
    const state = el('p', status.running ? 'wifi-on' : 'wifi-off', status.running ? `Running at ${status.url}` : 'Stopped');
    const toggle = el('button', 'wifi-primary', status.running ? 'Stop sync server' : 'Start sync server');
    toggle.type = 'button';
    toggle.addEventListener('click', () => { pairing = null; call(status.running ? api.stop : api.start); });
    server.append(state, toggle);
    if (status.running) {
      server.append(el('p', 'wifi-hint', 'Phones must be on the same Wi-Fi network. Your phone will show a certificate warning because the certificate is self-signed; compare the fingerprint below before continuing.'));
      server.append(el('code', 'wifi-fingerprint', status.fingerprint || 'No TLS'));
    }
    panel.append(server);

    if (status.running) {
      const pair = section('Pair a phone');
      const make = el('button', 'wifi-primary', pairing ? 'Generate new code' : 'Show pairing code');
      make.type = 'button';
      make.addEventListener('click', async () => { const result = await call(api.pair); if (result.ok) { pairing = result.pairing; render(); } });
      pair.append(make);
      if (pairing) {
        const image = el('img', 'wifi-qr');
        image.src = pairing.qr;
        image.alt = 'Pairing QR code';
        pair.append(image, el('p', 'wifi-code', pairing.code), el('p', 'wifi-hint'));
        pair.lastChild.id = 'wifi-countdown';
        pair.append(el('p', 'wifi-hint', 'Scan with the phone camera or type the code on the page. Each code works once.'));
      }
      panel.append(pair);
    }

    const stats = section('Transfers');
    const counts = status.stats.counts;
    const summary = el('div', 'wifi-stats');
    for (const [label, key] of [['Queued', 'queued'], ['Uploading', 'uploading'], ['Stored', 'stored'], ['Indexed', 'indexed'], ['Retrying', 'failed_retryable'], ['Failed', 'failed_permanent']]) {
      const cell = el('div');
      cell.append(el('strong', '', String(counts[key] || 0)), el('span', '', label));
      summary.append(cell);
    }
    stats.append(summary, el('p', 'wifi-hint', `Speed: ${formatBytes(status.speedBytesPerSecond)}/s · Last sync: ${formatTime(status.stats.lastSyncAt)}`));
    if (status.stats.failed.length) {
      const list = el('ul', 'wifi-list');
      for (const item of status.stats.failed) {
        const row = el('li');
        const info = el('div');
        info.append(el('strong', '', item.filename), el('span', 'wifi-hint', `${item.device} · ${item.state === 'failed_permanent' ? 'failed' : 'will retry'} · ${item.last_error || ''}`));
        const retry = el('button', '', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', () => call(api.retry, item.id));
        row.append(info, retry);
        list.append(row);
      }
      stats.append(list);
    }
    panel.append(stats);

    const devices = section('Paired devices');
    const active = status.devices.filter(device => !device.revoked_at);
    if (!active.length) devices.append(el('p', 'wifi-hint', 'No devices paired yet.'));
    else {
      const list = el('ul', 'wifi-list');
      for (const device of active) {
        const row = el('li');
        const info = el('div');
        info.append(el('strong', '', device.name), el('span', 'wifi-hint', `${device.platform} · last seen ${formatTime(device.last_seen_at)} · last sync ${formatTime(device.last_sync_at)}`));
        const revoke = el('button', 'wifi-danger', 'Revoke');
        revoke.type = 'button';
        revoke.addEventListener('click', () => { if (confirm(`Revoke "${device.name}"? It will need to pair again.`)) call(api.revoke, device.id); });
        row.append(info, revoke);
        list.append(row);
      }
      devices.append(list);
    }
    panel.append(devices);

    const settings = section('Settings');
    const library = el('select');
    for (const item of status.libraries) library.add(new Option(item.name, item.id));
    library.value = status.settings.destinationLibraryId || status.libraries[0]?.id || '';
    library.addEventListener('change', () => call(api.updateSettings, { destinationLibraryId: library.value }));
    const folder = el('input');
    folder.value = status.settings.destinationFolder;
    folder.maxLength = 60;
    folder.addEventListener('change', () => call(api.updateSettings, { destinationFolder: folder.value }));
    const number = (value, key, min) => {
      const input = el('input');
      input.type = 'number'; input.min = String(min); input.value = String(value);
      input.addEventListener('change', () => call(api.updateSettings, { [key]: Number(input.value) }));
      return input;
    };
    settings.append(
      field('Destination library', library),
      field('Destination folder', folder),
      field('Bandwidth limit (KB/s, 0 = unlimited)', number(status.settings.bandwidthLimitKBps, 'bandwidthLimitKBps', 0)),
      field('Max file size (MB)', number(status.settings.maxFileSizeMB, 'maxFileSizeMB', 1)),
      field('Port (applied on next start)', number(status.settings.port, 'port', 1024))
    );
    if (!status.libraries.length) settings.append(el('p', 'wifi-error', 'Add a photo folder first; uploads need a destination library.'));
    panel.append(settings);
  }

  build();
  refresh();
})();
