(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const KEY = 'still-wifi-sync';
  const API = '/api/v1';
  const CHUNK = 8 * 1024 * 1024;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const say = text => { $('message').textContent = text; };
  let creds = null;
  try { creds = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { creds = null; }

  for (const link of document.querySelectorAll('[data-go]')) link.addEventListener('click', () => sessionStorage.setItem('still-go', link.dataset.go));
  const hashParams = new URLSearchParams(location.hash.slice(1));
  if (hashParams.get('code')) $('code').value = hashParams.get('code');
  $('device-name').value = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Browser';
  history.replaceState(null, '', location.pathname);

  function show() {
    $('pair-section').hidden = Boolean(creds);
    $('upload-section').hidden = !creds;
    if (creds) $('paired-as').textContent = `Paired as ${creds.name}.`;
  }

  async function call(method, route, { body, headers = {}, raw } = {}) {
    const response = await fetch(API + route, {
      method,
      headers: { ...(creds ? { Authorization: `Bearer ${creds.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined)
    });
    return response;
  }

  $('pair').addEventListener('click', async () => {
    say('');
    const response = await call('POST', '/pairing/claim', { body: { code: $('code').value, deviceName: $('device-name').value || 'Browser', platform: 'web' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { say(data.error?.message || 'Pairing failed.'); return; }
    creds = { token: data.token, name: $('device-name').value || 'Browser' };
    localStorage.setItem(KEY, JSON.stringify(creds));
    show();
  });

  $('forget').addEventListener('click', async () => {
    await call('DELETE', '/device');
    localStorage.removeItem(KEY);
    creds = null;
    show();
  });

  // A stable id per file lets an interrupted upload be recognised and resumed.
  const sourceId = (file, folder = '') => `web:${folder}:${file.name}:${file.size}:${file.lastModified}`;

  async function uploadOne(file, asset, row) {
    let offset = asset.bytesReceived || 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const head = await call('HEAD', `/assets/${asset.id}/content`);
      if (head.ok) offset = Number(head.headers.get('Upload-Offset')) || 0;
      try {
        while (offset < file.size) {
          const end = Math.min(offset + CHUNK, file.size);
          const response = await call('PUT', `/assets/${asset.id}/content`, { raw: file.slice(offset, end), headers: { 'Upload-Offset': String(offset) } });
          if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error?.message || `HTTP ${response.status}`);
          offset = end;
          row.textContent = `${Math.round((offset / file.size) * 100)}%`;
        }
        const final = await (await call('GET', `/assets/${asset.id}`)).json();
        row.textContent = final.duplicateOf ? 'duplicate' : final.state;
        return;
      } catch (error) {
        row.textContent = `retrying (${error.message})`;
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
    row.textContent = 'failed';
  }

  const updatePicked = () => {
    const folderCount = [...$('folder').files].filter(file => /^(image|video)\//.test(file.type)).length;
    const fileCount = $('files').files.length;
    $('picked').textContent = fileCount + folderCount ? `${fileCount + folderCount} file${fileCount + folderCount === 1 ? '' : 's'} ready to upload` : '';
  };
  const zone = $('dropzone');
  const folderMode = () => document.querySelector('input[name=mode]:checked').value === 'folder';
  const openPicker = () => (folderMode() ? $('folder') : $('files')).click();
  for (const radio of document.querySelectorAll('input[name=mode]')) radio.addEventListener('change', () => {
    const folder = folderMode();
    $(folder ? 'files' : 'folder').value = '';
    $('dz-title').innerHTML = folder ? 'Tap to choose a folder' : 'Tap to choose photos &amp; videos';
    $('dz-hint').textContent = folder ? 'everything inside it is sent, keeping its folder name' : 'or drop files here';
    zone.setAttribute('aria-label', folder ? 'Choose a folder' : 'Choose photos and videos');
    updatePicked();
  });
  zone.addEventListener('click', openPicker);
  zone.addEventListener('keydown', event => { if (event.target === zone && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openPicker(); } });
  $('files').addEventListener('change', updatePicked);
  $('folder').addEventListener('change', updatePicked);
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add('over'); });
  for (const type of ['dragleave', 'drop']) zone.addEventListener(type, event => { event.preventDefault(); zone.classList.remove('over'); });
  zone.addEventListener('drop', event => {
    if (folderMode()) { say('Folder mode: tap the box to choose a folder, or switch to Photos & videos to drop files.'); return; }
    const dropped = [...event.dataTransfer.files].filter(file => /^(image|video)\//.test(file.type));
    if (!dropped.length) { say('Drop photos or videos only.'); return; }
    const transfer = new DataTransfer(); for (const file of [...$('files').files, ...dropped]) transfer.items.add(file);
    $('files').files = transfer.files; say(''); updatePicked();
  });

  $('send').addEventListener('click', async () => {
    const picked = [...$('folder').files].filter(file => /^(image|video)\//.test(file.type)).map(file => ({
      file, folder: file.webkitRelativePath.split('/').slice(0, -1).join('/')
    }));
    const entries = [...linked, ...picked, ...[...$('files').files].map(file => ({ file, folder: '' }))];
    if (!entries.length) { say('Choose photos or a folder first.'); return; }
    say('');
    $('send').disabled = true;
    try {
      const sessionResponse = await call('POST', '/sessions', { headers: { 'Idempotency-Key': uuid() } });
      if (!sessionResponse.ok) throw new Error('Could not start a session. Pair again?');
      const session = await sessionResponse.json();
      const rows = new Map();
      $('list').replaceChildren();
      for (const { file, folder } of entries) {
        const item = document.createElement('li');
        const name = document.createElement('span');
        const state = document.createElement('span');
        name.textContent = folder ? `${folder}/${file.name}` : file.name;
        item.append(name, state);
        $('list').append(item);
        rows.set(sourceId(file, folder), state);
      }
      for (let start = 0; start < entries.length; start += 100) {
        const batch = entries.slice(start, start + 100);
        const registered = await (await call('POST', `/sessions/${session.id}/assets`, {
          body: { assets: batch.map(({ file, folder }) => ({ sourceAssetId: sourceId(file, folder), filename: file.name, folderPath: folder, mediaType: file.type || 'application/octet-stream', size: file.size, capturedAt: file.lastModified })) }
        })).json();
        for (const [position, result] of registered.assets.entries()) {
          const entry = batch[position];
          const row = rows.get(sourceId(entry.file, entry.folder));
          if (result.error) { row.textContent = result.error.message; continue; }
          entry.assetId = result.asset.id;
          if (['indexed', 'stored'].includes(result.asset.state)) { row.textContent = 'already synced'; continue; }
          await uploadOne(entry.file, result.asset, row);
        }
      }
      await call('POST', `/sessions/${session.id}/complete`);
      if ($('delete-after').checked) await offerDelete(entries, rows);
    } catch (error) {
      say(error.message);
    } finally {
      $('send').disabled = false;
    }
  });

  const FILE_MAX_HASH = 200 * 1024 * 1024;
  const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

  // Deletes only files whose SHA-256 (computed here) matches the verified copy on the PC, after the user agrees.
  async function offerDelete(list, rows) {
    const removable = list.filter(entry => entry.assetId && entry.parent && entry.file.size <= FILE_MAX_HASH);
    if (!removable.length) { say('Nothing eligible for deletion (needs a linked folder; files over 200 MB are skipped).'); return; }
    const checks = [];
    for (const entry of removable) entry.hash = hex(await crypto.subtle.digest('SHA-256', await entry.file.arrayBuffer()));
    const verified = await (await call('POST', '/assets/verify-delete', { body: { assets: removable.map(entry => ({ assetId: entry.assetId, sha256: entry.hash })) } })).json();
    const safe = removable.filter(entry => verified.assets.find(item => item.assetId === entry.assetId)?.safeToDelete);
    checks.push(safe.length);
    if (!safe.length) { say('No file is verified on the PC yet, so nothing was deleted.'); return; }
    if (!confirm(`Delete ${safe.length} verified photo(s) from this phone? Copies are safe on your PC.`)) return;
    let removed = 0;
    for (const entry of safe) {
      try {
        await entry.parent.removeEntry(entry.file.name);
        await call('POST', `/assets/${entry.assetId}/deleted`, { body: { sha256: entry.hash } });
        rows.get(sourceId(entry.file, entry.folder)).textContent = 'moved to PC';
        removed += 1;
      } catch { rows.get(sourceId(entry.file, entry.folder)).textContent = 'could not delete'; }
    }
    say(`Deleted ${removed} of ${safe.length} verified photo(s) from this phone.`);
  }

  async function walk(dir, folder, out) {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') await walk(handle, `${folder}/${name}`, out);
      else {
        const file = await handle.getFile();
        if (/^(image|video)\//.test(file.type)) out.push({ file, folder, parent: dir });
      }
    }
  }

  let linked = [];
  if (window.showDirectoryPicker) {
    $('pick-folder').hidden = false;
    $('delete-row').hidden = false;
    $('pick-folder').addEventListener('click', async () => {
      try {
        const root = await window.showDirectoryPicker({ mode: 'readwrite' });
        linked = [];
        await walk(root, root.name, linked);
        say(`Linked "${root.name}": ${linked.length} photos/videos found. Press Upload.`);
      } catch { /* picker cancelled */ }
    });
  }

  show();
})();
