'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function setup(desktopLibraryId = 'library') {
  const make = (tag, className = '', textContent = '') => ({
    tag, className, textContent, dataset: {}, attributes: {}, children: [], listeners: {},
    classList: { toggle() {}, add() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return []; },
    addEventListener(name, callback) { this.listeners[name] = callback; }
  });
  const nodes = { 'folder-tree': make('div'), 'folder-filter': { value: '' } };
  const first = { path: 'Alpha', name: 'Alpha', count: 1, children: [] };
  const second = { path: 'Beta', name: 'Beta', count: 1, children: [] };
  const root = { path: '', name: 'Photos', count: 2, children: [first, second] };
  const state = {
    desktopLibraryId, root: 'Photos', folder: 'Alpha', collection: 'old',
    folders: new Map([['', root], ['Alpha', first], ['Beta', second]]),
    pinnedFoldersByLibrary: { library: [] }
  };
  const context = vm.createContext({
    state, make, byId: id => nodes[id], icon: () => make('span'),
    formatNumber: String, folderPins: () => state.pinnedFoldersByLibrary.library,
    collator: new Intl.Collator(), renderPinnedFolders() {},
    setView(view) { state.view = view; }, closeSidebar() {},
    showFolderContextMenu() {}, openFolderDialog() {}
  });
  vm.runInContext(source.slice(source.indexOf('  function renderFolderTree()'), source.indexOf('  function renderPinnedFolders()')), context);
  const rows = () => nodes['folder-tree'].children[0].children[1].children;
  context.renderFolderTree();
  return { context, state, nodes, rows };
}

for (const desktopLibraryId of ['library', '']) {
  test(`clicking folder names opens without pinning or reordering (${desktopLibraryId || 'browser'})`, () => {
    const { state, nodes, rows } = setup(desktopLibraryId);
    const before = rows().map(row => row.dataset.folderPath);
    rows()[1].children[0].children[1].listeners.click();
    assert.equal(state.folder, 'Beta');
    assert.equal(state.view, 'folders');
    assert.equal(state.collection, '');
    assert.equal(nodes['folder-filter'].value, 'Beta');
    assert.deepEqual(state.pinnedFoldersByLibrary.library, []);
    assert.deepEqual(rows().map(row => row.dataset.folderPath), before);
    assert.equal(rows()[1].children[0].children[1].attributes['aria-current'], 'true');
  });
}

test('open buttons and pinned shortcuts preserve existing pins on navigation', () => {
  const { context, state, rows } = setup();
  state.pinnedFoldersByLibrary.library.push('Beta');
  context.renderFolderTree();
  const before = rows().map(row => row.dataset.folderPath);
  rows().find(row => row.dataset.folderPath === 'Beta').children[0].children[2].listeners.click();
  context.openFolder('Alpha');
  assert.deepEqual(state.pinnedFoldersByLibrary.library, ['Beta']);
  assert.deepEqual(rows().map(row => row.dataset.folderPath), before);
});

test('folder filter changes update selection without auto-pinning', () => {
  const { context, state, nodes } = setup();
  const handler = source.match(/byId\('folder-filter'\)\.addEventListener\('change', (.*)\);/)[1];
  context.applyFilters = () => { state.folder = nodes['folder-filter'].value; };
  nodes['folder-filter'].value = 'Beta';
  vm.runInContext(`(${handler})()`, context);
  assert.equal(state.folder, 'Beta');
  assert.deepEqual(state.pinnedFoldersByLibrary.library, []);
});
