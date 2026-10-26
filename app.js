(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const supported = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'dng']);
  const pageSize = 72;
  const preferenceKey = 'still-photo-library-ui-v1';
  const indexStore = window.PhotoIndexStore;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const state = { photos: [], filtered: [], folders: new Map(), discoveredIds: new Set(), root: '', scanCompleted: false, view: 'photos', folder: '', collection: '', page: 0, busy: false, generation: 0, metadataPass: 0, viewerIndex: 0, viewerList: [], viewerToken: 0, viewerUrls: new Map(), gridUrls: new Set(), zoom: 1, panX: 0, panY: 0, index: indexStore.create(), indexById: new Map(), indexDirty: false, inaccessiblePaths: [], storageAvailable: true, desktopLibraryId: '', desktopLibraries: [] };
  let observer;
  let photoSwipe;
  let photoSwipePromise;
  let desktopSaveTimer;
  let desktopSaveQueue = Promise.resolve();
  let returnFocus;
  const nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  const formatNumber = value => value.toLocaleString();
  const make = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const announce = message => { byId('status').textContent = message; };
  function icon(name, fallback = '') {
    if (!window.lucide?.icons[name]) return make('span', '', fallback);
    const element = window.lucide.createElement(window.lucide.icons[name]); element.setAttribute('class', 'lucide'); element.setAttribute('width', '20'); element.setAttribute('height', '20'); element.setAttribute('aria-hidden', 'true'); return element;
  }
  function favoriteIcon(button, selected) { button.replaceChildren(icon('Heart', selected ? '♥' : '♡')); button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); }

  function filenameDate(name) {
    const match = name.match(/^(?:(?:IMG|VID|PXL)(?:_|-))?((?:19|20)\d{2})(\d{2})(\d{2})(?=[_T\d.]|-|$)/i);
    if (!match) return null;
    const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() : null;
  }

  function addFolder(path) {
    if (state.folders.has(path)) return state.folders.get(path);
    const node = { path, name: path.split('/').pop() || state.root, count: 0, children: [] };
    state.folders.set(path, node);
    if (path) { const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; addFolder(parent).children.push(node); }
    return node;
  }

  function addPhoto(path, source, fileDetails = null) {
    const name = path.split('/').pop();
    if (path.split('/').some(part => part === '__MACOSX') || name.startsWith('._')) return false;
    try { path = indexStore.normalizePath(path); } catch { return false; }
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    addFolder(folder);
    const type = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (!supported.has(type)) return false;
    const id = indexStore.normalizePath(path);
    if (state.discoveredIds.has(id)) return false;
    state.discoveredIds.add(id);
    const details = fileDetails || (source instanceof File ? source : {});
    state.photos.push({ id, path, name, folder, type, source, date: filenameDate(name), dateTaken: null, modified: details.lastModified ?? null, size: details.size ?? null, added: Date.now(), baseSearch: normalize(path), dimensions: null });
    let current = folder;
    while (true) { addFolder(current).count++; if (!current) break; current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : ''; }
    return true;
  }

  function meta(photo) { return state.indexById.get(photo.id)?.metadata || { tags: [], favorite: false, albumIds: [] }; }
  function markIndexChanged() { state.index.updatedAt = new Date().toISOString(); state.indexDirty = true; updateIndexSummary(); if (window.desktopLibrary) scheduleDesktopSave(); }
  function scheduleDesktopSave() {
    clearTimeout(desktopSaveTimer);
    const libraryId = state.desktopLibraryId;
    const snapshot = JSON.parse(JSON.stringify(state.index));
    desktopSaveTimer = setTimeout(() => {
      if (!libraryId || !state.index.root) return;
      desktopSaveQueue = desktopSaveQueue.catch(() => {}).then(() => window.desktopLibrary.saveIndex(libraryId, snapshot)).then(() => {
        if (state.desktopLibraryId === libraryId && state.index.updatedAt === snapshot.updatedAt) { state.indexDirty = false; updateIndexSummary(); }
      }).catch(error => announce(`Automatic index save failed: ${error.message}. Export a JSON backup before closing.`));
    }, 450);
  }
  async function persistDesktopIndexNow() {
    clearTimeout(desktopSaveTimer);
    if (!state.desktopLibraryId) throw new Error('No saved photo folder is active.');
    const libraryId = state.desktopLibraryId;
    const snapshot = JSON.parse(JSON.stringify(state.index));
    desktopSaveQueue = desktopSaveQueue.catch(() => {}).then(() => window.desktopLibrary.saveIndex(libraryId, snapshot));
    const result = await desktopSaveQueue;
    if (state.desktopLibraryId === libraryId && state.index.updatedAt === snapshot.updatedAt) { state.indexDirty = false; updateIndexSummary(); }
    return result;
  }
  function updateIndexSummary() {
    const missingCount = reviewableMissingEntries().length;
    const count = state.index.entries.length;
    const hasIndex = !!state.index.root || count > 0;
    byId('index-summary').textContent = hasIndex ? `Index v${state.index.version} · ${formatNumber(count)} entries${state.indexDirty ? ' · unsaved changes' : ''}` : 'No index loaded';
    byId('review-missing').hidden = !missingCount;
    byId('review-missing').textContent = `Review missing (${formatNumber(missingCount)})`;
    byId('export-index').disabled = !hasIndex;
    byId('save-index').disabled = !hasIndex;
  }
  function syncIndexMap() {
    state.indexById = new Map(state.index.entries.map(entry => [entry.id, entry]));
    for (const photo of state.photos) {
      const record = state.indexById.get(photo.id);
      if (record) { photo.dateTaken = record.dateTaken; photo.added = Date.parse(record.firstIndexedAt) || photo.added; }
    }
    updateIndexSummary();
  }
  function reviewableMissingEntries() {
    return state.index.entries.filter(entry => entry.missing && !state.inaccessiblePaths.some(path => path === '' || entry.path === path || entry.path.startsWith(`${path}/`)));
  }
  function savePreferences() {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ sort: byId('sort').value, showNames: byId('show-names').checked })); }
    catch { state.storageAvailable = false; }
  }
  function loadPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
      if (['name', 'name-desc', 'date-desc', 'date-asc', 'modified', 'added'].includes(saved.sort)) byId('sort').value = saved.sort;
      byId('show-names').checked = saved.showNames === true;
      byId('gallery').classList.toggle('show-names', byId('show-names').checked);
    } catch { state.storageAvailable = false; }
  }

  function releaseGrid() { observer?.disconnect(); for (const url of state.gridUrls) URL.revokeObjectURL(url); state.gridUrls.clear(); state.generation++; }
  function resetLibrary(root) {
    if (!window.desktopLibrary && state.index.root && state.index.root !== root && state.index.entries.length) {
      const proceed = window.confirm(`The current index is for "${state.index.root}". Export it before switching roots. Continue with a new index for "${root}"?`);
      if (!proceed) { announce('Folder switch canceled. Export the current index before switching roots.'); return false; }
      state.index = indexStore.create(root); state.indexDirty = true;
    }
    if (!state.index.root) { state.index.root = root; state.indexDirty = true; }
    releaseGrid(); state.metadataPass++; state.photos = []; state.filtered = []; state.folders = new Map(); state.discoveredIds = new Set(); state.root = root; state.scanCompleted = false; state.folder = ''; state.collection = ''; state.page = 0; state.storageAvailable = true; addFolder('');
    state.busy = true; byId('choose-folder').disabled = true; byId('input-folder').disabled = true; byId('empty-open').disabled = true; byId('index-progress').hidden = false; byId('gallery').replaceChildren(); byId('pagination').hidden = true; byId('folder-tree').replaceChildren(); byId('collections').hidden = true;
    byId('index-progress').removeAttribute('value');
    return true;
  }

  async function indexFiles(files) {
    if (state.busy || !files.length) return;
    const firstPath = files[0].webkitRelativePath || files[0].name;
    if (!resetLibrary(firstPath.includes('/') ? firstPath.split('/')[0] : 'Selected files')) return;
    let visited = 0;
    for (const file of files) {
      const path = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
      addPhoto(path, file); visited++;
      if (visited % 250 === 0) { announce(`Indexing ${formatNumber(visited)} files · ${formatNumber(state.photos.length)} photos found`); await nextFrame(); }
    }
    await finishIndex(visited, []);
  }

  async function walkDirectory(root) {
    if (!resetLibrary(root.name)) return;
    const errors = []; let visited = 0;
    const stack = [{ handle: root, path: '' }];
    while (stack.length) {
      const { handle, path } = stack.pop();
      try {
        for await (const entry of handle.values()) {
          if (entry.name === '__MACOSX' || entry.name.startsWith('._')) continue;
          const relative = path ? `${path}/${entry.name}` : entry.name;
          if (entry.kind === 'directory') { addFolder(relative); stack.push({ handle: entry, path: relative }); }
          else {
            visited++;
            const extension = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
            if (supported.has(extension)) {
              try { const file = await entry.getFile(); addPhoto(relative, entry, { size: file.size, lastModified: file.lastModified }); }
              catch { errors.push(relative); }
            }
          }
          if (visited % 250 === 0) { announce(`Indexing ${formatNumber(visited)} files · ${formatNumber(state.photos.length)} photos found`); await nextFrame(); }
        }
      } catch { errors.push(path); }
    }
    await finishIndex(visited, errors);
  }

  async function finishIndex(visited, errors) {
    state.scanCompleted = true;
    state.busy = false; byId('choose-folder').disabled = false; byId('input-folder').disabled = false; byId('empty-open').disabled = false; byId('index-progress').hidden = true;
    let migrated = false;
    const legacyKey = `still-library-v1:${state.root}`;
    try {
      const legacy = JSON.parse(localStorage.getItem(legacyKey) || 'null');
      if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        if (window.desktopLibrary) await window.desktopLibrary.backupLegacyMetadata(state.desktopLibraryId, legacy);
        indexStore.mergeLegacy(state.index, legacy); migrated = Object.keys(legacy).length > 0;
      }
      if (legacy) localStorage.removeItem(legacyKey);
    } catch { state.storageAvailable = false; }
    state.index.root = state.root;
    state.inaccessiblePaths = errors;
    const result = indexStore.reconcile(state.index, state.photos.map(photo => ({ path: photo.path, size: photo.size, lastModified: photo.modified })), errors);
    state.index = result.index;
    const summary = result.summary;
    state.indexDirty = state.indexDirty || migrated || summary.added > 0 || summary.updated > 0 || summary.missing > 0;
    syncIndexMap();
    if (window.desktopLibrary && state.indexDirty) scheduleDesktopSave();
    renderFolderTree(); populateFilters(); applyFilters();
    if (byId('sort').value === 'modified') hydrateModifiedDates();
    byId('library-summary').textContent = `${state.root} · ${formatNumber(state.photos.length)} photos`;
    const indexedMessage = `${formatNumber(state.photos.length)} photos · ${formatNumber(summary.added)} added · ${formatNumber(summary.updated)} updated · ${formatNumber(summary.unchanged)} unchanged · ${formatNumber(summary.missing)} missing`;
    const errorPaths = errors.slice(0, 5).map(path => path || state.root).join(', ');
    const errorSuffix = errors.length > 5 ? `, and ${formatNumber(errors.length - 5)} more` : '';
    const accessMessage = errors.length ? ` · ${formatNumber(errors.length)} file/folder access errors (${errorPaths}${errorSuffix}); affected entries retained` : '';
    announce(`${indexedMessage}${accessMessage}. ${migrated ? 'Legacy browser annotations migrated; export an index backup.' : ''}${state.storageAvailable ? '' : ' UI preferences could not be saved.'}`);
  }

  async function chooseFolder() {
    if (state.busy) return;
    if (window.desktopLibrary) {
      try {
        const libraries = await window.desktopLibrary.chooseFolders();
        if (!libraries.length) return;
        state.desktopLibraries = await window.desktopLibrary.listLibraries();
        renderDesktopLibraries();
        await activateDesktopLibrary(libraries[0].id);
      } catch (error) { announce(`Could not add photo folder: ${error.message}`); }
      return;
    }
    if (!window.showDirectoryPicker || !window.isSecureContext) { byId('folder-input').click(); return; }
    try { const root = await window.showDirectoryPicker({ mode: 'read' }); await walkDirectory(root); }
    catch (error) { if (error.name !== 'AbortError') { announce(`Folder access failed (${error.name}). Try the folder-input button next to Open folder.`); if (state.busy) finishIndex(0, [state.root]); } }
  }

  function renderDesktopLibraries() {
    const selector = byId('desktop-library');
    selector.replaceChildren(new Option('＋ Add photo folders…', '__add__'));
    for (const library of state.desktopLibraries) {
      const option = new Option(`${library.name}${library.available ? '' : ' · unavailable'}`, library.id);
      option.title = library.path;
      selector.add(option);
    }
    selector.value = state.desktopLibraryId || '__add__';
  }

  async function activateDesktopLibrary(libraryId) {
    if (state.busy) { renderDesktopLibraries(); return; }
    const library = state.desktopLibraries.find(item => item.id === libraryId);
    if (!library) return;
    if (state.desktopLibraryId && state.indexDirty) await persistDesktopIndexNow();
    const index = await window.desktopLibrary.loadIndex(library.id);
    state.desktopLibraryId = library.id;
    state.index = index;
    renderDesktopLibraries();
    if (!resetLibrary(library.name)) return;
    if (!library.available) {
      state.busy = false;
      byId('choose-folder').disabled = false; byId('input-folder').disabled = true; byId('empty-open').disabled = false; byId('index-progress').hidden = true;
      syncIndexMap(); renderFolderTree(); populateFilters(); applyFilters();
      byId('library-summary').textContent = `${library.name} · folder unavailable`;
      announce(`${library.warning} Its saved index remains available; no entries were marked missing.`);
      return;
    }
    announce(`Scanning ${library.name}…`);
    try {
      const result = await window.desktopLibrary.scanLibrary(library.id, progress => {
        announce(`Scanning ${library.name} · ${formatNumber(progress.processed)} files checked · ${formatNumber(progress.imageCount)} photos found`);
      });
      for (const folder of result.folders) addFolder(folder);
      for (const file of result.files) addPhoto(file.path, null, { size: file.size, lastModified: file.lastModified });
      await finishIndex(result.processed, result.inaccessiblePaths);
    } catch (error) {
      state.busy = false; byId('choose-folder').disabled = false; byId('input-folder').disabled = true; byId('empty-open').disabled = false; byId('index-progress').hidden = true;
      syncIndexMap(); renderFolderTree(); populateFilters(); applyFilters();
      announce(`Photo folder scan failed: ${error.message}. The saved index was retained.`);
    }
  }

  async function initializeDesktop() {
    document.body.classList.add('desktop-app');
    byId('desktop-library').hidden = false;
    byId('input-folder').hidden = true;
    byId('folder-input').hidden = true;
    try {
      state.desktopLibraries = await window.desktopLibrary.listLibraries();
      renderDesktopLibraries();
      if (state.desktopLibraries.length) {
        const preferred = state.desktopLibraries.find(library => library.available) || state.desktopLibraries[0];
        await activateDesktopLibrary(preferred.id);
      } else {
        announce('Add one or more photo folders. They will be remembered on this computer.');
      }
    } catch (error) { announce(`Could not load saved photo folders: ${error.message}`); }
  }

  function renderFolderTree() {
    const container = byId('folder-tree'); container.replaceChildren();
    function branch(node) {
      const wrapper = make('div', 'tree-node'); const row = make('div', 'tree-row'); const toggle = make('button', 'tree-expander', node.children.length ? '▸' : '');
      toggle.disabled = !node.children.length; toggle.setAttribute('aria-label', `Expand ${node.name}`); toggle.setAttribute('aria-expanded', 'false');
      const button = make('button', 'tree-button'); button.title = node.path || state.root;
      button.append(make('span', '', node.path ? node.name : state.root), make('span', '', formatNumber(node.count)));
      button.addEventListener('click', () => { state.folder = node.path; byId('folder-filter').value = node.path; state.collection = ''; setView('folders'); document.querySelectorAll('.tree-button.selected').forEach(item => item.classList.remove('selected')); button.classList.add('selected'); closeSidebar(); });
      row.append(toggle, button); wrapper.append(row);
      if (node.children.length) {
        const children = make('div', 'tree-children'); children.hidden = true; let built = false;
        toggle.addEventListener('click', () => { if (!built) { node.children.sort((first, second) => collator.compare(first.name, second.name)).forEach(child => children.append(branch(child))); built = true; } children.hidden = !children.hidden; toggle.textContent = children.hidden ? '▸' : '▾'; toggle.setAttribute('aria-expanded', String(!children.hidden)); });
        wrapper.append(children);
        if (!node.path) toggle.click();
      }
      return wrapper;
    }
    container.append(branch(state.folders.get('')));
  }

  function populateFilters() {
    const folderSelect = byId('folder-filter'); folderSelect.replaceChildren(new Option('All folders', ''));
    [...state.folders.keys()].filter(Boolean).sort(collator.compare).forEach(path => folderSelect.add(new Option(path, path)));
    const typeSelect = byId('type-filter'); typeSelect.replaceChildren(new Option('All formats', ''));
    [...new Set(state.photos.map(photo => photo.type))].sort().forEach(type => typeSelect.add(new Option(type.toUpperCase(), type)));
  }

  function setView(view) {
    if (state.busy) return;
    state.view = view; state.collection = ''; state.page = 0;
    if (view !== 'folders') { state.folder = ''; byId('folder-filter').value = ''; }
    document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'); });
    if (view === 'recent') byId('sort').value = 'added';
    if (view === 'timeline') byId('sort').value = 'date-desc';
    byId('grid-mode').classList.toggle('active', view !== 'timeline'); byId('timeline-mode').classList.toggle('active', view === 'timeline');
    renderCollections(); applyFilters(); closeSidebar();
  }

  function renderCollections() {
    const area = byId('collections'); area.replaceChildren(); area.hidden = !['tags', 'albums'].includes(state.view);
    if (area.hidden) return;
    const counts = new Map();
    const albumNames = new Map(state.index.albums.map(album => [album.id, album.name]));
    for (const photo of state.photos) {
      const values = state.view === 'albums' ? meta(photo).albumIds : meta(photo).tags;
      for (const value of values || []) counts.set(value, (counts.get(value) || 0) + 1);
    }
    if (!counts.size) area.append(make('p', 'muted', state.view === 'albums' ? 'No albums yet' : 'No tags yet'));
    for (const [value, count] of [...counts].sort((first, second) => collator.compare(state.view === 'albums' ? albumNames.get(first[0]) || first[0] : first[0], state.view === 'albums' ? albumNames.get(second[0]) || second[0] : second[0]))) {
      const name = state.view === 'albums' ? albumNames.get(value) || value : value;
      const button = make('button', 'collection', name); button.append(make('small', '', formatNumber(count)));
      button.addEventListener('click', () => { state.collection = state.collection === value ? '' : value; area.querySelectorAll('button').forEach(item => item.classList.remove('active')); button.classList.toggle('active', state.collection === value); applyFilters(); }); area.append(button);
    }
  }

  function ensureAlbumId(name) {
    const existing = state.index.albums.find(album => album.name === name);
    if (existing) return existing.id;
    const randomId = window.crypto?.randomUUID ? window.crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    const id = 'album-' + randomId;
    state.index.albums.push({ id, name });
    return id;
  }

  function applyFilters() {
    if (state.busy) return;
    const terms = normalize(byId('search').value.trim()).split(/\s+/).filter(Boolean); const type = byId('type-filter').value;
    state.folder = byId('folder-filter').value;
    state.filtered = state.photos.filter(photo => {
      const saved = meta(photo);
      if (state.folder && photo.folder !== state.folder && !photo.folder.startsWith(`${state.folder}/`)) return false;
      if (type && photo.type !== type) return false;
      if (state.view === 'favorites' && !saved.favorite) return false;
      if (state.view === 'tags' && (!saved.tags.length || (state.collection && !saved.tags.includes(state.collection)))) return false;
      if (state.view === 'albums' && (!saved.albumIds.length || (state.collection && !saved.albumIds.includes(state.collection)))) return false;
      const text = terms.length ? `${photo.baseSearch} ${normalize((saved.tags || []).join(' '))}` : '';
      return terms.every(term => text.includes(term));
    });
    const sort = byId('sort').value;
    state.filtered.sort((first, second) => {
      if (sort === 'name' || sort === 'name-desc') return (sort === 'name-desc' ? -1 : 1) * collator.compare(first.name, second.name) || collator.compare(first.path, second.path);
      const key = sort === 'modified' ? 'modified' : sort === 'added' ? 'added' : 'date';
      if (first[key] == null && second[key] != null) return 1;
      if (second[key] == null && first[key] != null) return -1;
      return ((first[key] || 0) - (second[key] || 0)) * (sort === 'date-asc' ? 1 : -1) || collator.compare(first.path, second.path);
    });
    state.page = 0; renderGrid();
  }

  function renderGrid() {
    releaseGrid(); const generation = state.generation; const gallery = byId('gallery'); gallery.replaceChildren();
    const titles = { photos: 'Photos', timeline: 'Timeline', folders: 'Folders', albums: 'Albums', tags: 'Tags', favorites: 'Favorites', recent: 'Recently Added' };
    const selectedAlbum = state.view === 'albums' ? state.index.albums.find(album => album.id === state.collection)?.name : '';
    byId('view-title').textContent = selectedAlbum || (state.view === 'tags' ? state.collection : '') || state.folder.split('/').pop() || titles[state.view];
    byId('breadcrumb').textContent = state.root ? [state.root, state.folder].filter(Boolean).join(' / ') : 'LIBRARY';
    byId('result-count').textContent = formatNumber(state.filtered.length) + ' photos' + (state.photos.length ? ' / ' + formatNumber(state.photos.length) + ' in library' : '');
    byId('empty-state').hidden = !!state.filtered.length; byId('empty-message').textContent = state.photos.length ? 'No photos match this view' : state.index.entries.length && !state.scanCompleted ? 'Index imported; open the matching folder to access and reconcile photos' : state.index.entries.length ? 'No accessible photos in this scan; existing index entries are retained' : state.root ? 'No supported image files found' : 'No folder connected'; byId('empty-open').hidden = !!state.photos.length;
    byId('pagination').hidden = !state.filtered.length;
    byId('page-label').textContent = `Page ${state.page + 1} of ${Math.max(1, Math.ceil(state.filtered.length / pageSize))}`;
    byId('previous-page').disabled = state.page === 0; byId('next-page').disabled = (state.page + 1) * pageSize >= state.filtered.length;
    observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); enqueueThumbnail(entry.target, generation); } }, { rootMargin: '180px' });
    const pagePhotos = state.filtered.slice(state.page * pageSize, (state.page + 1) * pageSize);
    const groups = new Map();
    for (const photo of pagePhotos) {
      const key = state.view === 'timeline' ? (photo.date !== null ? new Date(photo.date).toISOString().slice(0, 7) : 'Unknown date') : '';
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(photo);
    }
    for (const [key, photos] of groups) {
      if (key) { const heading = make('h2', 'group-heading', key === 'Unknown date' ? key : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00Z`))); heading.append(make('small', '', key === 'Unknown date' ? 'No validated filename date' : 'From filename · not verified capture date')); gallery.append(heading); }
      const grid = make('div', 'photo-grid');
      for (const photo of photos) {
        const card = make('article', 'photo-card'); const button = make('button', 'photo-open'); button.setAttribute('aria-label', `Open ${photo.path}`); button.title = photo.path; button.photo = photo;
        button.append(make('span', 'photo-placeholder', 'Loading preview…')); button.addEventListener('click', () => openViewer(photo, button));
        const favorite = make('button', 'card-favorite'); favoriteIcon(favorite, !!meta(photo).favorite); favorite.setAttribute('aria-label', `Favorite ${photo.name}`); favorite.title = 'Toggle favorite'; favorite.addEventListener('click', () => { toggleFavorite(photo); if (state.view === 'favorites') applyFilters(); else favoriteIcon(favorite, !!meta(photo).favorite); });
        card.append(button, make('span', 'photo-caption', photo.name), favorite);
        if (['heic', 'heif', 'dng', 'tif', 'tiff'].includes(photo.type)) card.append(make('span', 'format-badge', photo.type.toUpperCase()));
        grid.append(card); observer.observe(button);
      }
      gallery.append(grid);
    }
  }

  const thumbnailQueue = []; let thumbnailWorkers = 0;
  function enqueueThumbnail(button, generation) { thumbnailQueue.push({ button, generation }); pumpThumbnails(); }
  function pumpThumbnails() {
    while (thumbnailWorkers < 3 && thumbnailQueue.length) {
      const task = thumbnailQueue.shift(); if (task.generation !== state.generation) continue;
      thumbnailWorkers++; loadThumbnail(task.button, task.generation).finally(() => { thumbnailWorkers--; pumpThumbnails(); });
    }
  }
  async function getFile(photo) {
    if (window.desktopLibrary) {
      const bytes = await window.desktopLibrary.readPhoto(state.desktopLibraryId, photo.path);
      const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', dng: 'image/x-adobe-dng' }[photo.type] || 'application/octet-stream';
      return new File([bytes], photo.name, { type: mime, lastModified: photo.modified || Date.now() });
    }
    const file = photo.source instanceof File ? photo.source : await photo.source.getFile(); photo.modified = file.lastModified || null; photo.size = file.size; return file;
  }
  async function hydrateModifiedDates() {
    const pass = ++state.metadataPass; const pending = state.photos.filter(photo => photo.modified === null); let completed = 0;
    for (let offset = 0; offset < pending.length; offset += 8) {
      if (pass !== state.metadataPass || byId('sort').value !== 'modified') return;
      await Promise.all(pending.slice(offset, offset + 8).map(async photo => { try { await getFile(photo); } catch { photo.unreadable = true; } completed++; }));
      announce(`Reading modification dates ${formatNumber(completed)} / ${formatNumber(pending.length)} (not capture dates)`); await nextFrame();
    }
    if (pass === state.metadataPass && byId('sort').value === 'modified') { applyFilters(); announce('Sorted by filesystem modification date, not capture date. Unreadable dates appear last.'); }
  }
  async function decodeImage(url) {
    const image = new Image(); image.decoding = 'async'; image.src = url;
    await Promise.race([image.decode(), new Promise((resolve, reject) => setTimeout(() => reject(new Error('Preview timed out')), 20000))]);
    return image;
  }
  async function loadThumbnail(button, generation) {
    let original; let thumbnail;
    try {
      const photo = button.photo; const file = await getFile(photo); if (generation !== state.generation) return;
      original = URL.createObjectURL(file); const image = await decodeImage(original); if (generation !== state.generation) return;
      photo.dimensions = { width: image.naturalWidth, height: image.naturalHeight };
      const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale)); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8)); if (!blob || generation !== state.generation) return;
      thumbnail = URL.createObjectURL(blob); state.gridUrls.add(thumbnail);
      const preview = make('img'); preview.alt = photo.name; preview.loading = 'lazy'; preview.decoding = 'async'; preview.src = thumbnail; button.replaceChildren(preview);
    } catch { if (generation === state.generation) button.replaceChildren(make('span', 'photo-placeholder', `${button.photo.type.toUpperCase()} · Preview unavailable`)); }
    finally { if (original) URL.revokeObjectURL(original); }
  }

  function toggleFavorite(photo) { const entry = state.indexById.get(photo.id); if (!entry) return; entry.metadata.favorite = !entry.metadata.favorite; markIndexChanged(); }
  function indexJson() { return JSON.stringify(state.index, null, 2); }
  function finishIndexExport() { state.indexDirty = false; updateIndexSummary(); }
  async function exportIndex() {
    if (!state.index.root && !state.index.entries.length) return;
    if (window.desktopLibrary) {
      try {
        const saved = await window.desktopLibrary.exportIndex(state.desktopLibraryId, state.index);
        if (saved) announce('Index JSON exported. It contains file metadata and annotations, not image data.');
      } catch (error) { announce(`Could not export the index: ${error.message}`); }
      return;
    }
    const blob = new Blob([indexJson()], { type: 'application/json' }); const url = URL.createObjectURL(blob);
    const rootSlug = (state.index.root || 'library').replace(/[^a-z0-9_]+/gi, '_');
    const link = make('a'); link.href = url; link.download = `still-index-${rootSlug}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); finishIndexExport(); announce('Index JSON downloaded. It contains file metadata and annotations, not image data.');
  }
  async function saveIndex() {
    if (!state.index.root && !state.index.entries.length) return;
    if (window.desktopLibrary) {
      try { await persistDesktopIndexNow(); announce('Index saved in this computer’s application data. Use Export JSON to create a portable backup.'); }
      catch (error) { announce(`Could not save the index: ${error.message}`); }
      return;
    }
    if (!window.showSaveFilePicker || !window.isSecureContext) { exportIndex(); return; }
    try {
      const rootSlug = (state.index.root || 'library').replace(/[^a-z0-9_]+/gi, '_');
      const handle = await window.showSaveFilePicker({ suggestedName: `still-index-${rootSlug}.json`, types: [{ description: 'JSON index', accept: { 'application/json': ['.json'] } }] });
      const writable = await handle.createWritable(); await writable.write(indexJson()); await writable.close(); finishIndexExport(); announce('Index JSON saved to the chosen location. Original photos were not changed.');
    } catch (error) { if (error.name !== 'AbortError') announce(`Could not save the index (${error.name}). Use Export JSON to download a copy.`); }
  }
  async function importIndex(file) {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { announce('Index file is larger than the 100 MB import limit.'); return; }
    try {
      const result = indexStore.validate(JSON.parse(await file.text()));
      if (!result.ok) { announce(`Index not imported: ${result.error}`); return; }
      if (state.photos.length && result.index.root !== state.root) { announce(`Index root "${result.index.root}" does not match the active folder "${state.root}". Open the matching folder before importing.`); return; }
      state.index = result.index;
      if (state.photos.length) {
        const reconciled = indexStore.reconcile(state.index, state.photos.map(photo => ({ path: photo.path, size: photo.size, lastModified: photo.modified })), state.inaccessiblePaths);
        state.index = reconciled.index;
        state.indexDirty = reconciled.summary.added > 0 || reconciled.summary.updated > 0 || reconciled.summary.missing > 0;
      } else {
        state.root = state.index.root;
        state.indexDirty = false;
      }
      syncIndexMap(); renderCollections(); applyFilters();
      byId('library-summary').textContent = state.photos.length ? `${state.root} · ${formatNumber(state.photos.length)} photos` : `${state.root} · imported index`;
      announce(state.photos.length ? 'Index restored and matched to the active folder. Review missing entries before removing any.' : `Index for "${state.root}" imported. Open that folder to restore photos and reconcile file changes.`);
    } catch (error) { announce(`Index not imported: ${error instanceof SyntaxError ? 'the file is not valid JSON.' : error.message}`); }
  }
  async function importDesktopIndex() {
    try {
      const imported = await window.desktopLibrary.importIndex(state.desktopLibraryId);
      if (!imported) return;
      const result = indexStore.validate(imported);
      if (!result.ok) { announce(`Index not imported: ${result.error}`); return; }
      if (result.index.root !== state.root) { announce(`Index root “${result.index.root}” does not match the active folder “${state.root}”. Select the matching folder first.`); return; }
      if (state.indexDirty && !window.confirm('Replace the current index with this imported index? The current userData index will be backed up first.')) return;
      await window.desktopLibrary.backupIndex(state.desktopLibraryId);
      state.index = result.index;
      if (state.scanCompleted) {
        const reconciled = indexStore.reconcile(state.index, state.photos.map(photo => ({ path: photo.path, size: photo.size, lastModified: photo.modified })), state.inaccessiblePaths);
        state.index = reconciled.index;
      }
      state.indexDirty = true; syncIndexMap(); renderCollections(); applyFilters();
      await persistDesktopIndexNow();
      announce('Index imported and saved. The previous userData index was backed up.');
    } catch (error) { announce(`Index not imported: ${error.message}`); }
  }
  function openMissingReview() {
    const missing = reviewableMissingEntries();
    byId('missing-explanation').textContent = `${formatNumber(missing.length)} entries were not found during accessible parts of the last scan. Entries under inaccessible folders were retained and are not listed here. Removing entries affects only this JSON index, never original files.`;
    const list = byId('missing-list'); list.replaceChildren();
    missing.slice(0, 200).forEach(entry => list.append(make('li', '', entry.path)));
    if (missing.length > 200) list.append(make('li', 'muted', `…and ${formatNumber(missing.length - 200)} more`));
    byId('missing-dialog').showModal();
  }
  function removeMissingEntries() {
    const removable = new Set(reviewableMissingEntries().map(entry => entry.id));
    const count = removable.size;
    state.index.entries = state.index.entries.filter(entry => !removable.has(entry.id));
    syncIndexMap(); markIndexChanged(); renderCollections(); applyFilters(); byId('missing-dialog').close();
    announce(`${formatNumber(count)} missing entries removed from the in-memory index. Export JSON to keep this change.`);
  }
  async function openViewer(photo, trigger) {
    returnFocus = trigger; state.viewerList = [...state.filtered]; state.viewerIndex = state.viewerList.indexOf(photo); byId('viewer').showModal(); showViewerPhoto();
  }
  async function showViewerPhoto() {
    const token = ++state.viewerToken; const photo = state.viewerList[state.viewerIndex]; if (!photo) return;
    state.zoom = 1; state.panX = 0; state.panY = 0; updateTransform();
    for (const url of state.viewerUrls.values()) URL.revokeObjectURL(url); state.viewerUrls.clear();
    const image = byId('large-image'); image.removeAttribute('src'); image.hidden = true;
    byId('viewer-state').textContent = 'Loading image…'; byId('viewer-position').textContent = `${state.viewerIndex + 1} / ${state.viewerList.length}`;
    byId('viewer-prev').disabled = state.viewerIndex === 0; byId('viewer-next').disabled = state.viewerIndex === state.viewerList.length - 1;
    byId('viewer-engine').replaceChildren(); updateDetails(photo);
    let file;
    try {
      file = await getFile(photo);
    } catch {
      if (token === state.viewerToken) { byId('viewer-state').textContent = 'This file is no longer readable. Reconnect the folder and grant access again; the index entry is preserved.'; updateDetails(photo); }
      return;
    }
    if (token !== state.viewerToken) return;
    const url = URL.createObjectURL(file); state.viewerUrls.set(photo.id, url);
    try {
      const decoded = await decodeImage(url); if (token !== state.viewerToken) return;
      photo.dimensions = { width: decoded.naturalWidth, height: decoded.naturalHeight }; image.src = url; image.alt = photo.name; image.hidden = false; byId('viewer-state').textContent = ''; updateDetails(photo);
      launchPhotoSwipe();
    } catch {
      if (token === state.viewerToken) {
        byId('viewer-state').textContent = ['heic', 'heif'].includes(photo.type)
          ? 'HEIC/HEIF preview is unavailable in this browser. The photo is indexed, but its pixels cannot be decoded here. Try a HEIC-capable viewer or add a separate JPEG copy; the original stays unchanged.'
          : 'This image could not be decoded. It may be corrupt or unsupported; other photos remain available.';
        updateDetails(photo);
      }
    }
  }

  function updateDetails(photo) {
    byId('detail-name').textContent = photo.name; const details = byId('detail-metadata'); details.replaceChildren();
    const sizeLabel = photo.size === null ? 'Read on demand' : (photo.size / 1048576).toFixed(2) + ' MB';
    const rows = [['Relative path', `${state.root}/${photo.path}`], ['Dimensions', photo.dimensions ? `${photo.dimensions.width} × ${photo.dimensions.height}` : 'Unavailable until decoded'], ['Format / size', photo.type.toUpperCase() + ' / ' + sizeLabel], ['Filename date (unverified)', photo.date !== null ? new Date(photo.date).toISOString().slice(0, 10) : 'Unknown'], ['Filesystem modified (not capture date)', photo.modified ? new Date(photo.modified).toLocaleString() : 'Read on demand'], ['EXIF capture date', photo.dateTaken || 'Unavailable'], ['Added to this index', new Date(photo.added).toLocaleString()]];
    for (const [label, value] of rows) details.append(make('dt', '', label), make('dd', '', value));
    favoriteIcon(byId('favorite'), !!meta(photo).favorite);
    const albumNames = new Map(state.index.albums.map(album => [album.id, album.name]));
    byId('photo-tags').value = meta(photo).tags.join(', '); byId('photo-albums').value = meta(photo).albumIds.map(id => albumNames.get(id)).filter(Boolean).join(', '); byId('detail-status').textContent = '';
    const suggestions = byId('suggestions'); suggestions.replaceChildren();
    for (const name of [...new Set(photo.folder.split('/').filter(Boolean))]) { const button = make('button', 'suggestion', `+ ${name}`); button.title = 'Add folder name as tag'; button.addEventListener('click', () => { const values = splitValues(byId('photo-tags').value); if (!values.includes(name)) values.push(name); byId('photo-tags').value = values.join(', '); }); suggestions.append(button); }
  }
  const splitValues = text => [...new Set(text.split(',').map(value => value.trim()).filter(Boolean))].slice(0, 50);
  function updateTransform() { byId('large-image').style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`; }
  function navigateViewer(offset) { const index = state.viewerIndex + offset; if (index >= 0 && index < state.viewerList.length) { if (photoSwipe) photoSwipe.goTo(index); else { state.viewerIndex = index; showViewerPhoto(); } } }
  function closeViewer() { byId('viewer').close(); if (photoSwipe) photoSwipe.close(); state.viewerToken++; byId('large-image').removeAttribute('src'); for (const url of state.viewerUrls.values()) URL.revokeObjectURL(url); state.viewerUrls.clear(); const page = state.page; applyFilters(); state.page = Math.min(page, Math.max(0, Math.ceil(state.filtered.length / pageSize) - 1)); renderGrid(); byId('view-title').setAttribute('tabindex', '-1'); returnFocus?.isConnected ? returnFocus.focus() : byId('view-title').focus(); }

  async function loadPhotoSwipe() {
    if (!photoSwipePromise) photoSwipePromise = new Promise((resolve, reject) => {
      const css = make('link'); css.rel = 'stylesheet'; css.href = './node_modules/photoswipe/dist/photoswipe.css';
      const script = make('script'); script.src = './node_modules/photoswipe/dist/umd/photoswipe.umd.min.js';
      let cssReady = false; let scriptReady = false;
      const ready = () => { if (cssReady && scriptReady) window.PhotoSwipe ? resolve(window.PhotoSwipe) : reject(new Error('Viewer unavailable')); };
      css.onload = () => { cssReady = true; ready(); }; css.onerror = reject;
      script.onload = () => { scriptReady = true; ready(); }; script.onerror = reject;
      document.head.append(css, script);
    });
    return photoSwipePromise;
  }

  async function launchPhotoSwipe() {
    const token = state.viewerToken; byId('viewer-engine').textContent = 'Loading PhotoSwipe…';
    try {
      const PhotoSwipe = await Promise.race([loadPhotoSwipe(), new Promise((resolve, reject) => setTimeout(() => reject(new Error('Viewer offline')), 8000))]);
      if (token !== state.viewerToken || !byId('viewer').open) return;
      photoSwipe = new PhotoSwipe({ appendToEl: byId('image-stage'), getViewportSizeFn: () => ({ x: byId('image-stage').clientWidth, y: byId('image-stage').clientHeight }), dataSource: state.viewerList, index: state.viewerIndex, loop: false, preload: [0, 0], showHideAnimationType: 'none', bgOpacity: 1, trapFocus: false, returnFocus: false, escKey: false });
      photoSwipe.addFilter('itemData', (data, index) => {
        const photo = state.viewerList[index]; const dimensions = photo.dimensions || { width: 1600, height: 1200 };
        return { src: state.viewerUrls.get(photo.id) || '', width: dimensions.width, height: dimensions.height, alt: photo.name, photo, index };
      });
      photoSwipe.on('contentLoad', event => {
        event.preventDefault(); const content = event.content; const photo = content.data.photo;
        const element = make('img'); element.alt = photo.name; element.style.cssText = 'width:100%;height:100%;object-fit:contain'; content.element = element; content.state = 'loading';
        (async () => {
          try {
            let url = state.viewerUrls.get(photo.id);
            if (!url) { const file = await getFile(photo); if (!photoSwipe) return; url = URL.createObjectURL(file); state.viewerUrls.set(photo.id, url); }
            const decoded = await decodeImage(url); if (!photoSwipe) return;
            photo.dimensions = { width: decoded.naturalWidth, height: decoded.naturalHeight }; content.data.width = decoded.naturalWidth; content.data.height = decoded.naturalHeight; content.width = decoded.naturalWidth; content.height = decoded.naturalHeight; element.src = url; content.onLoaded();
            if (photoSwipe.currIndex === content.data.index) { updateDetails(photo); photoSwipe.currSlide?.updateContentSize(true); photoSwipe.currSlide?.zoomAndPanToInitial(); }
          } catch { content.onError(); }
        })();
      });
      photoSwipe.on('change', () => {
        state.viewerIndex = photoSwipe.currIndex; state.viewerToken++; updateDetails(state.viewerList[state.viewerIndex]); byId('viewer-position').textContent = `${state.viewerIndex + 1} / ${state.viewerList.length}`;
      });
      photoSwipe.on('contentDestroy', event => { const id = event.content.data.photo?.id; const url = state.viewerUrls.get(id); if (url && id !== state.viewerList[state.viewerIndex]?.id) { URL.revokeObjectURL(url); state.viewerUrls.delete(id); } });
      photoSwipe.on('destroy', () => { photoSwipe = null; if (byId('viewer').open) closeViewer(); });
      photoSwipe.init(); byId('viewer-engine').textContent = 'PhotoSwipe 5.4.4';
    } catch { byId('viewer-engine').textContent = 'Offline viewer'; }
  }

  function closeSidebar() { byId('sidebar').classList.remove('open'); byId('menu-toggle').setAttribute('aria-expanded', 'false'); }
  byId('choose-folder').addEventListener('click', chooseFolder); byId('empty-open').addEventListener('click', chooseFolder); byId('input-folder').addEventListener('click', () => byId('folder-input').click());
  byId('folder-input').addEventListener('change', async event => { const files = [...event.target.files]; event.target.value = ''; try { await indexFiles(files); } catch (error) { finishIndex(files.length, [error.message]); } });
  byId('navigation').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) setView(button.dataset.view); });
  byId('grid-mode').addEventListener('click', () => setView('photos')); byId('timeline-mode').addEventListener('click', () => setView('timeline'));
  let searchTimer; byId('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, 180); });
  for (const id of ['folder-filter', 'type-filter']) byId(id).addEventListener('change', applyFilters);
  byId('sort').addEventListener('change', () => { state.metadataPass++; applyFilters(); savePreferences(); if (byId('sort').value === 'modified') hydrateModifiedDates(); });
  byId('reset').addEventListener('click', () => { byId('search').value = ''; byId('folder-filter').value = ''; byId('type-filter').value = ''; byId('sort').value = 'name'; state.collection = ''; renderCollections(); applyFilters(); });
  byId('show-names').addEventListener('change', event => { byId('gallery').classList.toggle('show-names', event.target.checked); savePreferences(); });
  byId('previous-page').addEventListener('click', () => { state.page--; renderGrid(); }); byId('next-page').addEventListener('click', () => { state.page++; renderGrid(); });
  byId('viewer-close').addEventListener('click', closeViewer); byId('viewer').addEventListener('cancel', event => { event.preventDefault(); closeViewer(); });
  byId('viewer').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeViewer(); } }, true);
  byId('viewer-prev').addEventListener('click', () => navigateViewer(-1)); byId('viewer-next').addEventListener('click', () => navigateViewer(1));
  byId('favorite').addEventListener('click', () => { const photo = state.viewerList[state.viewerIndex]; toggleFavorite(photo); updateDetails(photo); });
  byId('save-details').addEventListener('click', () => {
    const photo = state.viewerList[state.viewerIndex]; const entry = state.indexById.get(photo.id); if (!entry) return;
    entry.metadata.tags = splitValues(byId('photo-tags').value);
    entry.metadata.albumIds = splitValues(byId('photo-albums').value).map(ensureAlbumId);
    markIndexChanged(); byId('detail-status').textContent = 'Updated in this index. Export JSON to keep a backup.'; renderCollections();
  });
  byId('export-index').addEventListener('click', exportIndex);
  byId('save-index').addEventListener('click', saveIndex);
  byId('import-index').addEventListener('click', () => window.desktopLibrary ? importDesktopIndex() : byId('index-input').click());
  byId('index-input').addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; importIndex(file); });
  byId('review-missing').addEventListener('click', openMissingReview);
  byId('keep-missing').addEventListener('click', () => byId('missing-dialog').close());
  byId('remove-missing').addEventListener('click', removeMissingEntries);
  byId('zoom-in').addEventListener('click', () => { if (photoSwipe) photoSwipe.currSlide?.zoomTo(Math.min(8, (photoSwipe.currSlide.currZoomLevel || 1) * 1.5)); else { state.zoom = Math.min(8, state.zoom * 1.5); updateTransform(); } });
  byId('zoom-out').addEventListener('click', () => { if (photoSwipe) photoSwipe.currSlide?.zoomTo(Math.max(0.1, (photoSwipe.currSlide.currZoomLevel || 1) / 1.5)); else { state.zoom = Math.max(1, state.zoom / 1.5); if (state.zoom === 1) { state.panX = 0; state.panY = 0; } updateTransform(); } });
  byId('viewer').addEventListener('keydown', event => { if (photoSwipe || (/INPUT|TEXTAREA/).test(event.target.tagName)) return; if (event.key === 'ArrowLeft') { event.preventDefault(); navigateViewer(-1); } if (event.key === 'ArrowRight') { event.preventDefault(); navigateViewer(1); } });
  let drag; const panArea = byId('pan-area');
  panArea.addEventListener('pointerdown', event => { drag = { x: event.clientX, y: event.clientY, startX: state.panX, startY: state.panY }; panArea.setPointerCapture(event.pointerId); });
  panArea.addEventListener('pointermove', event => { if (drag && state.zoom > 1) { state.panX = drag.startX + event.clientX - drag.x; state.panY = drag.startY + event.clientY - drag.y; updateTransform(); } });
  panArea.addEventListener('pointerup', event => { if (drag && state.zoom === 1 && Math.abs(event.clientX - drag.x) > 65) navigateViewer(event.clientX < drag.x ? 1 : -1); drag = null; }); panArea.addEventListener('pointercancel', () => { drag = null; });
  panArea.addEventListener('dblclick', () => { state.zoom = state.zoom === 1 ? 2 : 1; state.panX = 0; state.panY = 0; updateTransform(); });
  byId('menu-toggle').addEventListener('click', () => { const open = byId('sidebar').classList.toggle('open'); byId('menu-toggle').setAttribute('aria-expanded', String(open)); });
  byId('desktop-library').addEventListener('change', async event => {
    if (event.target.value === '__add__') { await chooseFolder(); return; }
    try { await activateDesktopLibrary(event.target.value); } catch (error) { announce(`Could not open saved photo folder: ${error.message}`); }
  });
  byId('toggle-fullscreen').addEventListener('click', async () => {
    if (!window.desktopLibrary) return;
    try { await window.desktopLibrary.toggleFullscreen(); } catch (error) { announce(`Could not toggle fullscreen: ${error.message}`); }
  });
  const navigationIcons = { photos: 'Images', timeline: 'CalendarDays', folders: 'Folder', albums: 'BookImage', tags: 'Tags', favorites: 'Heart', recent: 'Clock3' };
  document.querySelectorAll('[data-view]').forEach(button => button.querySelector('span').replaceChildren(icon(navigationIcons[button.dataset.view])));
  const controlIcons = { 'menu-toggle': 'Menu', 'input-folder': 'FolderOpen', 'grid-mode': 'Grid2X2', 'timeline-mode': 'CalendarDays', 'previous-page': 'ArrowLeft', 'next-page': 'ArrowRight', 'zoom-out': 'ZoomOut', 'zoom-in': 'ZoomIn', 'toggle-fullscreen': 'Maximize', 'viewer-close': 'X', 'viewer-prev': 'ChevronLeft', 'viewer-next': 'ChevronRight', 'export-index': 'Download', 'import-index': 'Upload', 'save-index': 'Save' };
  for (const [id, name] of Object.entries(controlIcons)) byId(id).replaceChildren(icon(name));
  document.querySelector('.search span').replaceChildren(icon('Search'));
  byId('choose-folder').replaceChildren(icon('FolderOpen'), make('span', '', 'Open folder')); byId('empty-open').replaceChildren(icon('FolderOpen'), make('span', '', 'Open photo folder'));
  loadPreferences(); updateIndexSummary();
  if (window.desktopLibrary) initializeDesktop();
  window.addEventListener('pagehide', () => { releaseGrid(); for (const url of state.viewerUrls.values()) URL.revokeObjectURL(url); });
  if (!('webkitdirectory' in byId('folder-input')) && !window.showDirectoryPicker) announce('This browser cannot select folders. Open this page in a current Chrome, Edge, Firefox, or Safari desktop browser.');
})();