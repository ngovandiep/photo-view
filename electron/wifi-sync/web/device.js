(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const say = text => { $('message').textContent = text; };
  const PHOTO = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;
  const VIDEO = /\.(mp4|mov|m4v|webm|3gp|mkv|avi)$/i;
  const state = { roots: [], items: [], kind: '', app: '', sort: 'new', selecting: false, sel: new Set() };

  for (const link of document.querySelectorAll('[data-go]')) link.addEventListener('click', () => sessionStorage.setItem('still-go', link.dataset.go));

  // Folder handles are remembered so the next visit needs one tap, not new pickers.
  const db = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('still-device', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  async function remember() { try { const d = await db(); d.transaction('handles', 'readwrite').objectStore('handles').put(state.roots.map(root => root.handle), 'roots'); } catch { /* optional */ } }
  async function recall() { try { const d = await db(); return await new Promise(resolve => { const r = d.transaction('handles').objectStore('handles').get('roots'); r.onsuccess = () => resolve(r.result || []); r.onerror = () => resolve([]); }); } catch { return []; } }

  // The back gesture closes the preview or leaves selection mode instead of leaving the page.
  const layers = [];
  window.addEventListener('popstate', event => { const depth = event.state?.still || 0; while (layers.length > depth) layers.pop().close(); });
  function pushLayer(close) { layers.push({ close }); history.pushState({ still: layers.length }, ''); }
  function dismissLayer(close) {
    const index = layers.findIndex(layer => layer.close === close);
    if (index < 0) { close(); return; }
    layers[index].close = () => {}; close();
    if (index === layers.length - 1) history.back();
  }

  const kindOf = name => (PHOTO.test(name) ? 'photo' : VIDEO.test(name) ? 'video' : '');

  // The app is guessed from the folder names on the phone; the first matching rule wins.
  const APPS = [
    ['Screenshots', /screenshot|screen ?record/], ['WhatsApp', /whatsapp/], ['Zalo', /zalo/], ['Messenger', /messenger/],
    ['Telegram', /telegram/], ['Facebook', /facebook|fb_img/], ['Instagram', /instagram/], ['TikTok', /tiktok|musically/],
    ['Snapchat', /snapchat/], ['Viber', /viber/], ['Line', /(^|\/)line(\/|$)/], ['Downloads', /download/],
    ['Camera', /camera|dcim|\d{3}apple|\d{3}andro|(^|\/)(img|vid|pxl|mvimg)[_-]/]
  ];
  const appOf = label => { const lower = label.toLowerCase(); return (APPS.find(([, rule]) => rule.test(lower)) || ['Other'])[0]; };

  async function scan(dir, prefix, out, root) {
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (handle.kind === 'directory') await scan(handle, `${prefix}${name}/`, out, root);
      else { const kind = kindOf(name); if (kind) out.push({ name, kind, handle, dir, key: `${root.id}:${prefix}${name}`, label: `${root.handle.name}/${prefix}${name}`, app: appOf(`${root.handle.name}/${prefix}${name}`) }); }
    }
  }

  async function addRoot(handle) {
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') { say('Permission was not granted, so files cannot be managed.'); return false; }
    for (const existing of state.roots) if (await existing.handle.isSameEntry(handle).catch(() => false)) { say(`"${handle.name}" is already added.`); return false; }
    const root = { id: state.roots.length ? Math.max(...state.roots.map(r => r.id)) + 1 : 0, handle };
    say(`Reading "${handle.name}"�`);
    const items = [];
    try { await scan(handle, '', items, root); } catch (error) { say(`Could not read the folder: ${error.message}`); return false; }
    await Promise.all(items.map(async item => { const file = await item.handle.getFile(); item.size = file.size; item.modified = file.lastModified; }));
    state.roots.push(root); state.items.push(...items); remember(); say('');
    return true;
  }
  function show() {
    $('start').hidden = true; $('manager').hidden = false;
    $('folder-name').textContent = state.roots.map(root => root.handle.name).join(', ');
    render();
  }
  const byKind = () => state.items.filter(item => !state.kind || item.kind === state.kind);
  const visible = () => byKind().filter(item => !state.app || item.app === state.app).sort((a, b) => (state.sort === 'big' ? b.size - a.size : b.modified - a.modified));
  const size = bytes => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${(bytes / 1048576).toFixed(1)} MB`);

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const tile = entry.target; const item = tile._item;
      if (entry.isIntersecting && !tile._media) load(tile, item);
      else if (!entry.isIntersecting && tile._media) unload(tile);
    }
  }, { rootMargin: '300px' });

  async function load(tile, item) {
    tile._media = true;
    try {
      const file = await item.handle.getFile(); if (!tile._media) return;
      const url = URL.createObjectURL(file); tile._url = url;
      const el = document.createElement(item.kind === 'video' ? 'video' : 'img');
      if (item.kind === 'video') { el.muted = true; el.preload = 'metadata'; el.playsInline = true; el.src = `${url}#t=0.5`; } else { el.decoding = 'async'; el.alt = item.name; el.src = url; el.onerror = () => { el.remove(); tile.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'cannot preview' })); }; }
      tile.prepend(el);
    } catch { tile._media = false; }
  }
  function unload(tile) { tile._media = false; if (tile._url) URL.revokeObjectURL(tile._url); tile._url = null; tile.querySelector('img,video')?.remove(); }

  function renderApps() {
    const groups = new Map();
    for (const item of byKind()) { const g = groups.get(item.app) || { count: 0, bytes: 0 }; g.count += 1; g.bytes += item.size; groups.set(item.app, g); }
    if (state.app && !groups.has(state.app)) state.app = '';
    const chips = [['', `All apps (${byKind().length})`], ...[...groups].sort((a, b) => b[1].bytes - a[1].bytes).map(([app, g]) => [app, `${app} · ${g.count} · ${size(g.bytes)}`])];
    $('apps').replaceChildren(...chips.map(([app, text]) => Object.assign(document.createElement('button'), { type: 'button', className: `chip${app === state.app ? ' active' : ''}`, textContent: text, onclick: () => { state.app = app; setSelecting(false); render(); } })));
  }

  function render() {
    observer.disconnect(); renderApps();
    const list = visible();
    const grid = $('grid'); grid.replaceChildren();
    const total = list.reduce((sum, item) => sum + item.size, 0);
    $('summary').textContent = `${list.length} item${list.length === 1 ? '' : 's'} · ${size(total)}`;
    const fragment = document.createDocumentFragment();
    for (const item of list) {
      const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'tile'; tile._item = item;
      tile.setAttribute('aria-label', item.name);
      if (state.sel.has(item.key)) tile.classList.add('selected');
      tile.append(Object.assign(document.createElement('span'), { className: 'check' }));
      if (item.kind === 'video') tile.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: '▶ video' }));
      if (!state.app) tile.append(Object.assign(document.createElement('span'), { className: 'app-tag', textContent: item.app }));
      tile.addEventListener('click', () => (state.selecting ? toggle(item, tile) : preview(item)));
      fragment.append(tile);
    }
    grid.append(fragment);
    for (const tile of grid.children) observer.observe(tile);
    updateBar();
  }

  function updateBar() {
    $('sel-count').textContent = `${state.sel.size} selected`;
    $('sel-delete').disabled = !state.sel.size;
    document.body.classList.toggle('selecting', state.selecting);
    $('select-bar').hidden = !state.selecting;
  }
  const selectClose = () => applySelecting(false);
  function setSelecting(on) { if (on === state.selecting) return; if (on) { applySelecting(true); pushLayer(selectClose); } else dismissLayer(selectClose); }
  function applySelecting(on) { state.selecting = on; if (!on) { state.sel.clear(); for (const tile of $('grid').children) tile.classList.remove('selected'); } updateBar(); }
  function toggle(item, tile) {
    if (state.sel.has(item.key)) state.sel.delete(item.key); else state.sel.add(item.key);
    tile.classList.toggle('selected', state.sel.has(item.key)); updateBar();
  }

  // Long-press starts selecting, like the library page.
  let timer = 0; let suppress = false;
  $('grid').addEventListener('pointerdown', event => {
    const tile = event.target.closest('.tile'); if (!tile) return;
    clearTimeout(timer);
    timer = setTimeout(() => { suppress = true; if (!state.selecting) setSelecting(true); if (!state.sel.has(tile._item.key)) toggle(tile._item, tile); navigator.vibrate?.(15); }, 450);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointermove', 'scroll']) document.addEventListener(type, () => clearTimeout(timer), { passive: true });
  $('grid').addEventListener('click', event => { if (suppress) { suppress = false; event.stopImmediatePropagation(); event.preventDefault(); } }, true);
  $('grid').addEventListener('contextmenu', event => event.preventDefault());

  async function preview(item) {
    const file = await item.handle.getFile(); const url = URL.createObjectURL(file);
    const el = document.createElement(item.kind === 'video' ? 'video' : 'img');
    if (item.kind === 'video') { el.controls = true; el.autoplay = true; el.playsInline = true; }
    el.src = url; el.onerror = () => { $('preview-stage').replaceChildren(Object.assign(document.createElement('p'), { textContent: 'This phone cannot display this file.', style: 'color:#fff' })); };
    $('preview-stage').replaceChildren(el); $('preview-name').textContent = `${item.label} · ${size(item.size)}`; $('preview').hidden = false; $('preview')._url = url; pushLayer(previewClose);
  }
  const previewClose = () => { $('preview').hidden = true; $('preview-stage').replaceChildren(); URL.revokeObjectURL($('preview')._url); };
  $('preview-close').addEventListener('click', () => dismissLayer(previewClose));

  async function deleteSelected() {
    const targets = state.items.filter(item => state.sel.has(item.key));
    if (!targets.length) return;
    const bytes = targets.reduce((sum, item) => sum + item.size, 0);
    if (!confirm(`Permanently delete ${targets.length} file${targets.length === 1 ? '' : 's'} (${size(bytes)}) from this phone?\n\nThis cannot be undone. Files already sent to your PC stay there.`)) return;
    $('sel-delete').disabled = true; let removed = 0; const failed = [];
    for (const item of targets) {
      try { await item.dir.removeEntry(item.name); removed += 1; state.items = state.items.filter(other => other !== item); state.sel.delete(item.key); }
      catch { failed.push(item.name); }
    }
    say(failed.length ? `Deleted ${removed}. Could not delete ${failed.length} (e.g. ${failed[0]}).` : `Deleted ${removed} file${removed === 1 ? '' : 's'} from this phone.`);
    setSelecting(false); render();
  }

  $('pick').addEventListener('click', async () => { try { if (await addRoot(await window.showDirectoryPicker({ mode: 'readwrite' }))) show(); } catch { /* cancelled */ } });
  $('add-folder').addEventListener('click', async () => { try { if (await addRoot(await window.showDirectoryPicker({ mode: 'readwrite' }))) show(); } catch { /* cancelled */ } });
  $('clear').addEventListener('click', async () => { setSelecting(false); state.roots = []; state.items = []; state.app = ''; await remember(); $('manager').hidden = true; $('start').hidden = false; $('reopen').hidden = true; say('Folders forgotten. Nothing was deleted.'); });
  $('reopen').addEventListener('click', async () => {
    try { let added = 0; for (const handle of await recall()) if (await addRoot(handle)) added += 1; if (added) show(); } catch (error) { say(error.message); }
  });
  $('sort').addEventListener('change', () => { state.sort = $('sort').value; render(); });
  $('select-toggle').addEventListener('click', () => setSelecting(true));
  $('sel-cancel').addEventListener('click', () => setSelecting(false));
  $('sel-all').addEventListener('click', () => {
    const list = visible(); const all = list.every(item => state.sel.has(item.key));
    for (const item of list) { if (all) state.sel.delete(item.key); else state.sel.add(item.key); }
    for (const tile of $('grid').children) tile.classList.toggle('selected', state.sel.has(tile._item.key)); updateBar();
  });
  $('sel-delete').addEventListener('click', deleteSelected);
  for (const tab of document.querySelectorAll('.tab[data-kind]')) tab.addEventListener('click', () => {
    state.kind = tab.dataset.kind;
    for (const other of document.querySelectorAll('.tab[data-kind]')) other.classList.toggle('active', other === tab);
    render();
  });

  if (!window.showDirectoryPicker) { $('pick').hidden = true; $('unsupported').hidden = false; }
  else recall().then(handles => { if (handles.length) { $('reopen').textContent = `Reopen ${handles.map(h => h.name).join(', ')}`; $('reopen').hidden = false; } });
})();
