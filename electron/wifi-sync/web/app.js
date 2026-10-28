(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const KEY = 'still-wifi-sync';
  const API = '/api/v1';
  const PAGE = 60;
  const state = { creds: null, libraries: [], libraryId: '', kind: '', q: '', favorites: false, selecting: false, folder: '', sel: { items: new Map(), folders: new Map() }, view: localStorage.getItem('still-view') === 'timeline' ? 'timeline' : 'grid', items: [], total: 0, counts: null, loading: false, done: false, token: 0, viewer: -1 };

  try { state.creds = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { state.creds = null; }

  async function call(method, route, body) {
    const response = await fetch(API + route, {
      method,
      credentials: 'same-origin',
      headers: { ...(state.creds ? { Authorization: `Bearer ${state.creds.token}` } : {}), 'X-Still-App': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (response.status === 401 && state.creds) { forget(); throw new Error('This phone was unpaired. Pair it again.'); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 403 && data.error?.code === 'login_required') { showLogin(); throw new Error('Sign in to continue.'); }
    if (!response.ok) throw new Error(data.error?.message || 'Request failed.');
    return data;
  }

  // Back gesture / button: every overlay (viewer, selection, menu, folder level) owns one history entry,
  // so "back" closes the top one instead of leaving the app.
  const layers = [];
  window.addEventListener('popstate', event => { const depth = event.state?.still || 0; while (layers.length > depth) layers.pop().close(); });
  function pushLayer(close, tag = '') { layers.push({ close, tag }); history.pushState({ still: layers.length }, ''); return close; }
  function dismissLayer(close) {
    const index = layers.findIndex(layer => layer.close === close);
    if (index < 0) { close(); return; }
    layers[index].close = () => {}; close();
    if (index === layers.length - 1) history.back();
  }
  function unwindLayers(tag) {
    let count = 0;
    while (count < layers.length && layers[layers.length - 1 - count].tag === tag) count += 1;
    if (!count) return;
    for (let i = 0; i < count; i += 1) layers[layers.length - 1 - i].close = () => {};
    history.go(-count);
  }
  const menuClose = () => { $('menu-panel').hidden = true; };
  function setMenu(on) {
    if (on === !$('menu-panel').hidden) return;
    if (on) { $('menu-panel').hidden = false; pushLayer(menuClose); } else dismissLayer(menuClose);
  }

  // Lets companion scripts (chat.js) follow sign-in state and share the back-gesture stack.
  const announce = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  window.StillApp = Object.freeze({ pushLayer: close => pushLayer(close, 'chat'), dismissLayer });

  function showLogin(message = '') {
    announce('still:signed-out');
    $('library-screen').hidden = true; $('pair-screen').hidden = true; $('login-screen').hidden = false; $('login-message').textContent = message;
    closeViewer();
  }

  async function login(event) {
    event.preventDefault();
    $('login-message').textContent = '';
    try {
      await call('POST', '/login', { email: $('login-email').value, password: $('login-password').value });
      $('login-password').value = '';
      await start();
    } catch (error) { $('login-message').textContent = error.message; }
  }

  function forget() { localStorage.removeItem(KEY); state.creds = null; showPair(); }
  const url = (action, item, extra = '') => `${API}/libraries/${state.libraryId}/${action}?path=${encodeURIComponent(item.path)}${extra}`;

  function showPair(message = '') {
    announce('still:signed-out');
    $('library-screen').hidden = true; $('login-screen').hidden = true; $('pair-screen').hidden = false; $('pair-message').textContent = message;
    $('device-name').value ||= /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Browser';
  }

  async function pair() {
    $('pair-message').textContent = '';
    try {
      const response = await fetch(`${API}/pairing/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value, deviceName: $('device-name').value || 'Browser', platform: 'web' }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || 'Pairing failed.');
      state.creds = { token: data.token, name: $('device-name').value || 'Browser' };
      localStorage.setItem(KEY, JSON.stringify(state.creds));
      await start();
    } catch (error) { $('pair-message').textContent = error.message; }
  }

  async function start() {
    $('pair-screen').hidden = true; $('login-screen').hidden = true;
    try {
      await call('POST', '/session');
      const me = await call('GET', '/me');
      if (me.loginRequired && !me.loggedIn) { showLogin(); return; }
      $('library-screen').hidden = false;
      $('logout').hidden = !me.loginRequired;
      announce('still:ready', { chat: Boolean(me.chat), creds: state.creds });
      const libs = await call('GET', '/libraries');
      $('account-line').textContent = me.account ? `Signed in as ${me.account.name || me.account.email} · ${me.device.name}` : `Local library · ${me.device.name}`;
      state.libraries = libs.libraries;
      const saved = localStorage.getItem('still-library');
      state.libraryId = state.libraries.find(l => l.id === saved)?.id || state.libraries[0]?.id || '';
      $('library-select').replaceChildren(...state.libraries.map(l => Object.assign(document.createElement('option'), { value: l.id, textContent: `${l.name} (${l.count})`, selected: l.id === state.libraryId })));
      if (!state.libraryId) { $('status').textContent = 'No library on the computer yet. Add a folder in the desktop app.'; return; }
      const go = sessionStorage.getItem('still-go'); sessionStorage.removeItem('still-go');
      if (go) { state.favorites = go === 'favorites'; state.folder = ''; state.view = go === 'timeline' ? 'timeline' : go === 'folders' ? 'folders' : 'grid'; }
      reload();
    } catch (error) { if (state.creds) $('status').textContent = error.message; }
  }

  function reload() {
    state.token++; state.items = []; state.total = 0; state.done = false; state.loading = false;
    $('grid').replaceChildren(); $('roadmap').replaceChildren(); $('folders').replaceChildren(); $('status').textContent = '';
    const timeline = state.view === 'timeline'; const folders = state.view === 'folders';
    $('grid').hidden = timeline; $('roadmap').hidden = !timeline; $('folders').hidden = !folders;
    for (const button of document.querySelectorAll('[data-nav]')) button.classList.toggle('active', button.dataset.nav === (state.favorites ? 'favorites' : state.view === 'grid' ? 'library' : state.view));
    if (timeline) { state.done = true; loadTimeline(); } else { if (folders) loadFolders(); loadMore(); }
  }

  async function loadFolders() {
    const token = state.token;
    try {
      const data = await call('GET', `/libraries/${state.libraryId}/folders?parent=${encodeURIComponent(state.folder)}`);
      if (token !== state.token) return;
      const crumbs = document.createElement('nav'); crumbs.className = 'crumbs'; crumbs.setAttribute('aria-label', 'Folder path');
      const parts = state.folder ? state.folder.split('/') : [];
      const addCrumb = (label, target, last) => {
        if (crumbs.childNodes.length) crumbs.append('›');
        if (last) { crumbs.append(Object.assign(document.createElement('span'), { className: 'here', textContent: label })); return; }
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
        button.addEventListener('click', () => goToFolder(target));
        crumbs.append(button);
      };
      addCrumb('Library', '', !parts.length);
      parts.forEach((part, i) => addCrumb(part, parts.slice(0, i + 1).join('/'), i === parts.length - 1));
      const list = document.createElement('div'); list.className = 'folder-list';
      for (const folder of data.folders) list.append(folderCard(folder));
      $('folders').replaceChildren(crumbs, list);
      if (!data.folders.length && !data.direct) $('status').textContent = 'This folder is empty.';
    } catch (error) { if (token === state.token) $('status').textContent = error.message; }
  }

  function folderCard(folder) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'folder-card'; card._folder = folder;
    card.append(Object.assign(document.createElement('b'), { textContent: `📁 ${folder.name}` }), Object.assign(document.createElement('small'), { textContent: `${folder.count} item${folder.count === 1 ? '' : 's'}` }));
    if (state.sel.folders.has(folder.path)) card.classList.add('selected');
    card.addEventListener('click', () => { if (state.selecting) toggleFolder(folder, card); else enterFolder(folder.path); });
    return card;
  }
  function enterFolder(target) {
    const previous = state.folder; state.folder = target; reload();
    pushLayer(() => { state.folder = previous; reload(); }, 'folder');
  }
  // Jumping to an ancestor from the breadcrumbs pops every level in between.
  function goToFolder(target) {
    const depth = path => (path ? path.split('/').length : 0);
    const levels = depth(state.folder) - depth(target);
    if (levels > 0 && layers.slice(-levels).every(layer => layer.tag === 'folder')) {
      for (const layer of layers.slice(-levels)) layer.close = () => {};
      state.folder = target; reload(); history.go(-levels);
    } else { state.folder = target; reload(); }
  }

  // Selection and deletion (files go to the computer's Recycle Bin)
  function updateSelectBar() {
    const files = state.sel.items.size; const folders = state.sel.folders.size;
    $('select-count').textContent = `${files + folders} selected`;
    $('select-delete').disabled = files + folders === 0;
  }
  const selectClose = () => applySelecting(false);
  function setSelecting(on) {
    if (on === state.selecting) return;
    if (on) { applySelecting(true); pushLayer(selectClose); } else dismissLayer(selectClose);
  }
  function applySelecting(on) {
    state.selecting = on; document.body.classList.toggle('selecting', on); $('select-bar').hidden = !on;
    if (!on) { state.sel.items.clear(); state.sel.folders.clear(); for (const el of document.querySelectorAll('.selected')) el.classList.remove('selected'); }
    updateSelectBar();
  }
  function toggleItem(item, el) {
    if (state.sel.items.has(item.path)) { state.sel.items.delete(item.path); el.classList.remove('selected'); }
    else { state.sel.items.set(item.path, item); el.classList.add('selected'); }
    updateSelectBar();
  }
  function toggleFolder(folder, el) {
    if (state.sel.folders.has(folder.path)) { state.sel.folders.delete(folder.path); el.classList.remove('selected'); }
    else { state.sel.folders.set(folder.path, folder); el.classList.add('selected'); }
    updateSelectBar();
  }
  function selectAll() {
    for (const el of document.querySelectorAll('.folder-card')) if (!state.sel.folders.has(el._folder.path)) toggleFolder(el._folder, el);
    for (const el of document.querySelectorAll('.tile')) if (el._item && !state.sel.items.has(el._item.path)) toggleItem(el._item, el);
  }
  async function deleteSelected() {
    const paths = [...state.sel.items.keys()]; const folders = [...state.sel.folders.keys()];
    if (!paths.length && !folders.length) return;
    const folderFiles = [...state.sel.folders.values()].reduce((sum, folder) => sum + folder.count, 0);
    const text = [paths.length && `${paths.length} file${paths.length === 1 ? '' : 's'}`, folders.length && `${folders.length} folder${folders.length === 1 ? '' : 's'} (${folderFiles} files inside)`].filter(Boolean).join(' and ');
    if (!confirm(`Delete ${text} from the computer?\n\nThey are moved to the computer's Recycle Bin, so they can be restored there.`)) return;
    $('select-delete').disabled = true; $('status').textContent = 'Deleting…';
    try {
      let deleted = 0; let failed = 0;
      for (let i = 0; i < Math.max(1, paths.length); i += 500) {
        const result = await call('POST', `/libraries/${state.libraryId}/delete`, { paths: paths.slice(i, i + 500), folders: i === 0 ? folders : [] });
        deleted += result.deleted; failed += result.failed;
      }
      setSelecting(false); reload();
      if (failed) $('status').textContent = `Deleted ${deleted}; ${failed} could not be deleted.`;
    } catch (error) { $('status').textContent = error.message; updateSelectBar(); }
  }

  let pressTimer = 0; let suppressClick = false;
  document.addEventListener('pointerdown', event => {
    const target = event.target.closest?.('.tile, .folder-card'); if (!target || $('viewer').hidden === false) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      suppressClick = true;
      if (!state.selecting) setSelecting(true);
      if (target._item) toggleItem(target._item, target); else if (target._folder) toggleFolder(target._folder, target);
      navigator.vibrate?.(15);
    }, 450);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointermove', 'scroll']) document.addEventListener(type, () => clearTimeout(pressTimer), { passive: true });
  document.addEventListener('contextmenu', event => { if (event.target.closest?.('.tile, .folder-card')) event.preventDefault(); });
  document.addEventListener('click', event => { if (suppressClick) { suppressClick = false; event.stopImmediatePropagation(); event.preventDefault(); } }, true);
  $('select-toggle').addEventListener('click', () => setSelecting(true));
  $('select-cancel').addEventListener('click', () => setSelecting(false));
  $('select-all').addEventListener('click', selectAll);
  $('select-delete').addEventListener('click', deleteSelected);

  function filterParams() {
    const params = new URLSearchParams();
    if (state.kind) params.set('kind', state.kind);
    if (state.q) params.set('q', state.q);
    if (state.favorites) params.set('favorite', '1');
    return params;
  }

  const monthLabel = key => (key === 'undated' ? 'No date' : new Date(`${key}-01T00:00:00Z`).toLocaleString(undefined, { month: 'long', timeZone: 'UTC' }));

  async function loadTimeline() {
    if (!state.libraryId) return;
    const token = state.token;
    $('status').textContent = 'Loading…';
    document.documentElement.style.setProperty('--top-h', `${document.querySelector('.top').offsetHeight}px`);
    try {
      const data = await call('GET', `/libraries/${state.libraryId}/timeline?${filterParams()}`);
      if (token !== state.token) return;
      state.counts = data.counts; renderTabs();
      $('status').textContent = data.total ? '' : 'Nothing here yet.';
      const years = new Map();
      for (const bucket of data.buckets) {
        const year = bucket.key === 'undated' ? 'undated' : bucket.key.slice(0, 4);
        if (!years.has(year)) years.set(year, []);
        years.get(year).push(bucket);
      }
      for (const [year, buckets] of years) {
        const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
        const pill = document.createElement('h2'); pill.className = 'year'; pill.append(year === 'undated' ? 'No date' : year, Object.assign(document.createElement('small'), { textContent: String(total) }));
        $('roadmap').append(pill);
        for (const bucket of buckets) $('roadmap').append(monthCard(bucket));
      }
    } catch (error) { if (token === state.token) $('status').textContent = error.message; }
  }

  function monthCard(bucket) {
    const card = document.createElement('article'); card.className = 'month';
    const head = document.createElement('button'); head.className = 'month-head'; head.append(monthLabel(bucket.key), Object.assign(document.createElement('small'), { textContent: `${bucket.count} item${bucket.count === 1 ? '' : 's'}` }));
    const strip = document.createElement('div'); strip.className = 'strip';
    const body = document.createElement('div'); body.className = 'month-body'; body.hidden = true;
    const state2 = { items: null };
    async function expand() {
      if (state2.items) { body.hidden = !body.hidden; return state2.items; }
      const items = [];
      head.disabled = true;
      try {
        while (items.length < bucket.count) {
          const params = filterParams(); params.set('month', bucket.key); params.set('offset', String(items.length)); params.set('limit', '200');
          const data = await call('GET', `/libraries/${state.libraryId}/items?${params}`);
          if (!data.items.length) break;
          items.push(...data.items);
        }
      } finally { head.disabled = false; }
      state2.items = items;
      const grid = document.createElement('div'); grid.className = 'grid'; grid.setAttribute('role', 'list');
      items.forEach(item => grid.append(tile(item, 0, open)));
      body.append(grid); body.hidden = false;
      return items;
    }
    function open(item) {
      const items = state2.items; if (!items) return;
      state.items = items; state.total = items.length; state.done = true;
      openViewer(Math.max(0, items.indexOf(item)));
    }
    bucket.sample.forEach(item => strip.append(tile(item, 0, async picked => { try { await expand(); } catch (error) { $('status').textContent = error.message; return; } open(state2.items.find(entry => entry.path === picked.path) || picked); })));
    head.addEventListener('click', () => { expand().then(() => { strip.hidden = !body.hidden; }).catch(error => { $('status').textContent = error.message; }); });
    card.append(head, strip, body);
    return card;
  }

  async function loadMore() {
    if (state.loading || state.done || !state.libraryId) return;
    state.loading = true; const token = state.token;
    $('status').textContent = 'Loading…';
    try {
      const params = new URLSearchParams({ offset: String(state.items.length), limit: String(PAGE) });
      if (state.view === 'folders') params.set('folder', state.folder);
      if (state.kind) params.set('kind', state.kind);
      if (state.q) params.set('q', state.q);
      if (state.favorites) params.set('favorite', '1');
      const data = await call('GET', `/libraries/${state.libraryId}/items?${params}`);
      if (token !== state.token) return;
      state.counts = data.counts; state.total = data.total; renderTabs();
      const start = state.items.length; state.items.push(...data.items);
      data.items.forEach((item, i) => $('grid').append(tile(item, start + i)));
      state.done = state.items.length >= state.total;
      $('status').textContent = state.total || state.view === 'folders' ? '' : 'Nothing here yet.';
    } catch (error) { if (token === state.token) $('status').textContent = error.message; }
    finally { if (token === state.token) state.loading = false; }
  }

  // Video previews: the browser decodes the first frame from the file itself; only tiles near the screen load it.
  const videoObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const button = entry.target; videoObserver.unobserve(button);
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'metadata'; video.setAttribute('aria-hidden', 'true');
      video.src = button.dataset.src; button.prepend(video);
    }
  }, { rootMargin: '300px' });

  function tile(item, index, onOpen) {
    const button = document.createElement('button'); button.className = 'tile'; button.setAttribute('role', 'listitem'); button.setAttribute('aria-label', item.name); button._item = item;
    if (item.kind === 'document') { button.classList.add('doc'); button.append('PDF', Object.assign(document.createElement('span'), { textContent: item.name })); }
    else {
      const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.decoding = 'async';
      img.src = item.kind === 'photo' ? url('thumb', item, '&w=320') : '';
      if (item.kind === 'video') { img.removeAttribute('src'); button.classList.add('video'); button.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: '▶ ' + item.type.toUpperCase() })); button.dataset.src = url('file', item) + '#t=0.5'; videoObserver.observe(button); }
      else { img.onerror = () => { img.remove(); button.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: item.type.toUpperCase() })); }; button.prepend(img); }
    }
    if (item.favorite) button.append(Object.assign(document.createElement('span'), { className: 'heart', textContent: '♥' }));
    button.dataset.index = String(index);
    if (state.sel.items.has(item.path)) button.classList.add('selected');
    button.addEventListener('click', () => { if (state.selecting) toggleItem(item, button); else if (onOpen) onOpen(item); else openViewer(index); });
    return button;
  }

  function renderTabs() {
    const c = state.counts || { all: 0, photo: 0, video: 0, document: 0 };
    const tabs = [['', 'All', c.all], ['photo', 'Photos', c.photo], ['video', 'Videos', c.video], ['document', 'PDFs', c.document]];
    $('tabs').replaceChildren(...tabs.map(([kind, label, count]) => {
      const button = document.createElement('button'); button.className = kind === state.kind ? 'active' : ''; button.append(label, Object.assign(document.createElement('small'), { textContent: String(count) }));
      button.addEventListener('click', () => { state.kind = kind; reload(); }); return button;
    }));
  }

  // Viewer
  function openViewer(index) {
    const item = state.items[index]; if (!item) return;
    if (state.viewer < 0) pushLayer(closeViewerNow);
    state.viewer = index; $('viewer').hidden = false; document.body.style.overflow = 'hidden';
    $('viewer-title').textContent = item.name;
    setFavoriteButton(item.favorite);
    const stage = $('viewer-stage'); stage.replaceChildren();
    if (item.kind === 'photo') {
      const img = document.createElement('img'); img.alt = item.name;
      img.onerror = () => {
        if (state.viewer !== index) return;
        const dir = state.dir || 1;
        if (index + dir >= 0 && index + dir < state.items.length) step(dir);
        else if (index - dir >= 0 && index - dir < state.items.length) { state.dir = -dir; step(-dir); }
        else stage.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'This image cannot be displayed.' }));
      };
      img.src = url('file', item); stage.append(img);
    }
    else if (item.kind === 'video') { const video = document.createElement('video'); video.controls = true; video.autoplay = true; video.playsInline = true; video.src = url('file', item); video.onerror = () => { stage.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'This phone cannot play this video format (for example HEVC/MKV).' })); }; stage.append(video); }
    else stage.append(Object.assign(document.createElement('a'), { className: 'doc-open', href: url('file', item), target: '_blank', rel: 'noopener', textContent: 'Open PDF' }));
    $('viewer-prev').hidden = index === 0; $('viewer-next').hidden = index >= state.total - 1;
    if (index >= state.items.length - 5) loadMore();
  }
  function closeViewerNow() { $('viewer').hidden = true; $('viewer-stage').replaceChildren(); document.body.style.overflow = ''; state.viewer = -1; }
  function closeViewer() { dismissLayer(closeViewerNow); }
  function step(offset) { state.dir = offset < 0 ? -1 : 1; const next = state.viewer + offset; if (next >= 0 && next < state.items.length) openViewer(next); }
  function setFavoriteButton(on) { $('viewer-fav').textContent = on ? '♥' : '♡'; $('viewer-fav').setAttribute('aria-pressed', String(on)); }

  async function toggleFavorite() {
    const item = state.items[state.viewer]; if (!item) return;
    const next = !item.favorite; setFavoriteButton(next);
    try {
      await call('POST', `/libraries/${state.libraryId}/favorite`, { path: item.path, favorite: next });
      item.favorite = next;
      for (const tileEl of document.querySelectorAll('.tile')) {
        if (tileEl._item?.path !== item.path) continue;
        tileEl.querySelector('.heart')?.remove();
        if (next) tileEl.append(Object.assign(document.createElement('span'), { className: 'heart', textContent: '♥' }));
      }
    } catch (error) { setFavoriteButton(item.favorite); $('status').textContent = error.message; }
  }

  // Shares the actual file through the phone's share sheet; falls back to a download where file sharing is unsupported.
  async function shareCurrent() {
    const item = state.items[state.viewer]; if (!item) return;
    const button = $('viewer-share'); button.disabled = true; const label = $('viewer-title').textContent; $('viewer-title').textContent = 'Preparing…';
    try {
      const response = await fetch(url('file', item), { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Could not load the file.');
      const blob = await response.blob();
      const file = new File([blob], item.name, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: item.name });
      else {
        const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: item.name });
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      }
    } catch (error) { if (error.name !== 'AbortError') $('status').textContent = error.message; }
    finally { button.disabled = false; if (state.viewer >= 0) $('viewer-title').textContent = label; }
  }

  $('viewer-share').addEventListener('click', shareCurrent);
  $('pair').addEventListener('click', pair);
  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer-prev').addEventListener('click', () => step(-1));
  $('viewer-next').addEventListener('click', () => step(1));
  $('viewer-fav').addEventListener('click', toggleFavorite);
  document.addEventListener('keydown', event => {
    if ($('viewer').hidden) return;
    if (event.key === 'Escape') closeViewer(); else if (event.key === 'ArrowLeft') step(-1); else if (event.key === 'ArrowRight') step(1);
  });
  let touch = null;
  const stage = $('viewer-stage');
  stage.addEventListener('touchstart', event => {
    // Leave the bottom strip of a video to its native seek bar.
    const rect = stage.getBoundingClientRect();
    const onControls = event.target.tagName === 'VIDEO' && event.touches[0].clientY > rect.bottom - 90;
    touch = event.touches.length === 1 && !onControls ? { x: event.touches[0].clientX, y: event.touches[0].clientY, dx: 0, active: false } : null;
  }, { passive: true });
  stage.addEventListener('touchmove', event => {
    if (!touch) return;
    if (event.touches.length !== 1) { touch = null; return; }
    const dx = event.touches[0].clientX - touch.x; const dy = event.touches[0].clientY - touch.y;
    if (!touch.active && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) { touch.active = true; stage.classList.add('dragging'); }
    if (!touch.active) return;
    touch.dx = dx;
    const child = stage.firstElementChild; if (child) child.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  stage.addEventListener('touchend', () => {
    if (!touch) return;
    const { dx, active } = touch; touch = null; stage.classList.remove('dragging');
    const child = stage.firstElementChild;
    if (active && Math.abs(dx) > 70 && ((dx < 0 && state.viewer < state.total - 1) || (dx > 0 && state.viewer > 0))) step(dx < 0 ? 1 : -1);
    else if (child) child.style.transform = '';
  });
  stage.addEventListener('touchcancel', () => { touch = null; stage.classList.remove('dragging'); const child = stage.firstElementChild; if (child) child.style.transform = ''; });
  $('login-form').addEventListener('submit', login);
  $('logout').addEventListener('click', async () => { try { await call('POST', '/logout'); } catch { /* ignore */ } showLogin(); });
  $('bottom-nav').addEventListener('click', event => {
    const target = event.target.closest('[data-nav]'); if (!target) return;
    const page = target.dataset.nav;
    if (page === 'more') { window.scrollTo({ top: 0 }); setMenu($('menu-panel').hidden); return; }
    setMenu(false); unwindLayers('folder');
    state.favorites = page === 'favorites';
    if (page !== 'favorites') state.view = page === 'timeline' ? 'timeline' : page === 'folders' ? 'folders' : 'grid';
    else if (state.view === 'folders') state.view = 'grid';
    if (page === 'folders') state.folder = '';
    if (state.view !== 'folders') localStorage.setItem('still-view', state.view);
    window.scrollTo({ top: 0 });
    reload();
  });
  $('menu').addEventListener('click', () => setMenu($('menu-panel').hidden));
  $('library-select').addEventListener('change', () => { unwindLayers('folder'); state.libraryId = $('library-select').value; state.folder = ''; localStorage.setItem('still-library', state.libraryId); reload(); });
  let searchTimer = 0;
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = $('search').value.trim(); reload(); }, 300); });
  $('unpair').addEventListener('click', async () => { try { await call('DELETE', '/device'); await call('DELETE', '/session').catch(() => {}); } catch { /* already unpaired */ } forget(); });
  new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore(); }, { rootMargin: '600px' }).observe($('sentinel'));

  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('code')) $('code').value = hash.get('code');
  history.replaceState(null, '', location.pathname);
  if (state.creds) start();
  else { showPair(); if ($('code').value) pair(); }
})();
