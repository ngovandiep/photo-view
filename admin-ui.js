(() => {
  'use strict';

  // Small DOM helper: h('div', { className, text, onclick, aria-label }, child, ...)
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key in node && !key.includes('-') && key !== 'list') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    append(node, children);
    return node;
  }
  function append(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
  }

  const ICONS = {
    overview: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
    wifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01M2 9a15 15 0 0 1 20 0',
    phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
    history: 'M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M3 21v-5h5',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    drive: 'M22 12H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6zM6 16h.01M10 16h.01',
    sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    brand: 'M3 5h18v14H3zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 19',
    back: 'M19 12H5M12 19l-7-7 7-7',
    close: 'M18 6L6 18M6 6l12 12',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    refresh: 'M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M3 21v-5h5',
    shield: 'M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    up: 'M6 15l6-6 6 6',
    queue: 'M12 3v12M7 10l5 5 5-5M4 21h16',
    down: 'M6 9l6 6 6-6'
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ad-icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name] || '');
    svg.append(path);
    return svg;
  }

  const fmt = {
    number: value => (Number.isFinite(value) ? value.toLocaleString() : '—'),
    bytes(value) {
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
      return `${(value / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
    },
    date: stamp => (stamp ? new Date(stamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
    ago(stamp) {
      if (!stamp) return 'Never';
      const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
      if (seconds < 60) return 'Just now';
      if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
      return fmt.date(stamp);
    },
    duration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—';
      const seconds = Math.round(ms / 1000);
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    },
    shortId: value => String(value || '').slice(0, 8),
    platform: value => ({ android: 'Android', ios: 'iOS' }[String(value).toLowerCase()] || String(value || 'Unknown'))
  };

  const STATUS = {
    connected: ['Connected', 'ok'], disconnected: ['Disconnected', ''], syncing: ['Syncing', 'info'], error: ['Error', 'bad'], revoked: ['Revoked', 'dark'],
    authorized: ['Authorized', 'ok'],
    queued: ['Queued', ''], running: ['Running', 'info'], completed: ['Completed', 'ok'], completed_with_errors: ['Completed with errors', 'warn'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', ''],
    info: ['Info', ''], warning: ['Warning', 'warn'],
    stopped: ['Stopped', ''],
    indexed: ['Indexed', 'ok'], stored: ['Stored', 'ok'], uploading: ['Uploading', 'info'], discovered: ['Discovered', ''], failed_retryable: ['Will retry', 'warn'], failed_permanent: ['Failed', 'bad'],
    ok: ['OK', 'ok'], working: ['Working', 'info'], idle: ['Idle', ''], success: ['Success', 'ok'], denied: ['Denied', 'warn'], partial: ['Partial', 'warn'], will_retry: ['Will retry', 'warn'],
    pending: ['Pending', ''], verifying: ['Verifying', 'info'], imported: ['Imported', 'ok'], duplicate: ['Duplicate', 'info'],
    verified: ['SHA-256 verified', 'ok'], mismatch: ['Checksum mismatch', 'bad'], not_verified: ['Not verified yet', ''], paused: ['Paused', 'warn']
  };
  const statusBadge = (key, label) => {
    const [text, tone] = STATUS[key] || [label || String(key), ''];
    return h('span', { className: `ad-badge ${tone}`, text: label || text });
  };

  const statCard = (label, value, note) => h('div', { className: 'ad-stat' }, h('span', { text: label }), h('strong', { text: value }), note ? h('small', { text: note }) : null);
  const card = (title, ...children) => h('section', { className: 'ad-card' }, title ? h('h2', { text: title }) : null, ...children);
  const note = text => h('p', { className: 'ad-note', text });
  const kv = rows => h('dl', { className: 'ad-kv' }, rows.filter(Boolean).flatMap(([key, value]) => [h('dt', { text: key }), h('dd', {}, value === null || value === undefined || value === '' ? '—' : value)]));
  const button = (label, options = {}) => h('button', { type: 'button', className: `ad-btn ${options.kind || ''} ${options.small ? 'small' : ''}`.trim(), onclick: options.onclick, disabled: options.disabled, title: options.title }, options.icon ? icon(options.icon) : null, label);

  function pageHeader(title, subtitle, ...actions) {
    return h('div', { className: 'ad-head' }, h('div', {}, h('h1', { text: title }), subtitle ? h('p', { text: subtitle }) : null), h('div', { className: 'ad-actions' }, ...actions));
  }

  const loadingState = () => h('div', { className: 'ad-state', role: 'status' }, h('div', { className: 'ad-spinner' }), h('p', { text: 'Loading…' }));
  const emptyState = (title, text) => h('div', { className: 'ad-state' }, h('h3', { text: title }), text ? h('p', { text }) : null);
  const errorState = (message, retry) => h('div', { className: 'ad-state error', role: 'alert' }, h('h3', { text: 'Something went wrong' }), h('p', { text: message }), retry ? button('Try again', { onclick: retry, icon: 'refresh' }) : null);
  const banner = (items, kind = '') => (items.length ? h('div', { className: `ad-banner ${kind}`, role: 'alert' }, h('ul', {}, items.map(text => h('li', { text })))) : null);

  // A region shows loading and error states and ignores results from superseded requests.
  function region() {
    const node = h('div', { 'aria-live': 'polite' });
    let sequence = 0;
    async function load(loader, renderer, { silent = false } = {}) {
      const mine = ++sequence;
      if (!silent) node.replaceChildren(loadingState());
      try {
        const data = await loader();
        if (mine === sequence) node.replaceChildren(renderer(data));
      } catch (error) {
        if (mine === sequence && !silent) node.replaceChildren(errorState(error.message, () => load(loader, renderer)));
      }
    }
    return { node, load };
  }

  function dataTable({ columns, rows, sort, onSort, onRowClick, caption, empty }) {
    if (!rows.length) return empty || emptyState('Nothing to show', 'No records match the current filters.');
    const head = h('tr', {}, columns.map(column => {
      const active = sort && sort.key === column.key;
      const cell = h('th', { scope: 'col', className: column.numeric ? 'num' : '', 'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null });
      if (column.sortable && onSort) cell.append(h('button', { type: 'button', onclick: () => onSort(column.key) }, column.label, active ? icon(sort.dir === 'asc' ? 'up' : 'down') : null));
      else cell.textContent = column.label;
      return cell;
    }));
    const body = h('tbody', {}, rows.map(row => {
      const tr = h('tr', onRowClick ? { tabIndex: 0, onclick: () => onRowClick(row), onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRowClick(row); } } } : {});
      for (const column of columns) tr.append(h('td', { className: `${column.numeric ? 'num' : ''} ${column.wrap ? 'wrap' : ''}`.trim() }, column.render ? column.render(row) : String(row[column.key] ?? '—')));
      return tr;
    }));
    return h('div', { className: 'ad-tablewrap' }, h('table', { className: 'ad-table' }, caption ? h('caption', { className: 'sr-only', text: caption, style: 'position:absolute;left:-9999px' }) : null, h('thead', {}, head), body));
  }

  function pager({ page, pages, total, pageSize }, onPage) {
    if (!total) return null;
    const first = (page - 1) * pageSize + 1;
    const last = Math.min(total, page * pageSize);
    return h('div', { className: 'ad-pager' },
      h('span', { text: `${first}–${last} of ${fmt.number(total)}` }),
      h('div', {}, button('Previous', { small: true, disabled: page <= 1, onclick: () => onPage(page - 1) }), h('span', { text: `Page ${page} of ${pages}` }), button('Next', { small: true, disabled: page >= pages, onclick: () => onPage(page + 1) })));
  }

  // fields: [{ key, label, type: 'search'|'select'|'date', options: [[value, label]], grow }]
  function filterBar(fields, values, onChange) {
    let timer = 0;
    const controls = new Map();
    const emit = () => onChange({ ...values });
    const bar = h('form', { className: 'ad-filter', role: 'search', onsubmit: event => event.preventDefault() });
    for (const field of fields) {
      let input;
      if (field.type === 'select') {
        input = h('select', {}, field.options.map(([value, label]) => h('option', { value, text: label })));
        input.value = values[field.key] || '';
        input.addEventListener('change', () => { values[field.key] = input.value; emit(); });
      } else {
        input = h('input', { type: field.type === 'search' ? 'search' : 'date', value: values[field.key] || '', placeholder: field.placeholder || '' });
        input.addEventListener('input', () => {
          values[field.key] = input.value;
          clearTimeout(timer);
          timer = setTimeout(emit, field.type === 'search' ? 250 : 0);
        });
      }
      controls.set(field.key, input);
      bar.append(h('label', { className: field.grow ? 'grow' : '' }, field.label, input));
    }
    bar.append(button('Reset', { small: true, onclick: () => {
      for (const field of fields) { values[field.key] = ''; controls.get(field.key).value = ''; }
      emit();
    } }));
    return bar;
  }

  const toasts = h('div', { className: 'ad-toasts', role: 'status', 'aria-live': 'polite' });
  function toast(message, kind = '') {
    const item = h('div', { className: `ad-toast ${kind}`, text: message });
    toasts.append(item);
    setTimeout(() => item.remove(), kind === 'bad' ? 6000 : 3000);
  }

  // Resolves true only when the user explicitly confirms.
  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise(resolve => {
      const previous = document.activeElement;
      const done = value => { backdrop.remove(); previous?.focus?.(); resolve(value); };
      const cancel = button('Cancel', { onclick: () => done(false) });
      const confirm = button(confirmLabel, { kind: danger ? 'danger solid' : 'primary', onclick: () => done(true) });
      const dialog = h('div', { className: 'ad-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'ad-dialog-title', 'aria-describedby': 'ad-dialog-text' },
        h('h2', { id: 'ad-dialog-title', text: title }), h('p', { id: 'ad-dialog-text', text: message }), h('div', { className: 'buttons' }, cancel, confirm));
      const backdrop = h('div', { className: 'ad-dialog-backdrop', onclick: event => { if (event.target === backdrop) done(false); } }, dialog);
      backdrop.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); done(false); }
        if (event.key === 'Tab') {
          const items = [cancel, confirm];
          const index = items.indexOf(document.activeElement);
          event.preventDefault();
          items[(index + (event.shiftKey ? items.length - 1 : 1)) % items.length].focus();
        }
      });
      document.getElementById('admin-root').append(backdrop);
      cancel.focus();
    });
  }

  // One side panel at a time; load() fetches data, render(data, controller) builds the body.
  function createPanelHost(root) {
    let current = null;
    function close() {
      if (!current) return;
      current.backdrop.remove();
      current.panel.remove();
      current.opener?.focus?.();
      current = null;
    }
    function open({ title, subtitle, load, render }) {
      const opener = current ? current.opener : document.activeElement;
      if (current) { current.backdrop.remove(); current.panel.remove(); }
      const body = h('div', { className: 'body' });
      const titleNode = h('h2', { text: title });
      const subtitleNode = h('p', { text: subtitle || '' });
      const panel = h('aside', { className: 'ad-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1 },
        h('header', {}, h('div', {}, titleNode, subtitleNode), h('button', { type: 'button', className: 'ad-icon-btn', 'aria-label': 'Close panel', onclick: close }, icon('close'))), body);
      const backdrop = h('div', { className: 'ad-backdrop', onclick: close });
      panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
      root.append(backdrop, panel);
      const controller = {
        close,
        setTitle(text, sub) { titleNode.textContent = text; subtitleNode.textContent = sub || ''; panel.setAttribute('aria-label', text); },
        async reload(silent) {
          if (current !== state) return;
          try {
            const data = await load();
            if (current === state) body.replaceChildren(...[].concat(render(data, controller)).filter(Boolean));
          } catch (error) {
            if (current === state && !silent) body.replaceChildren(errorState(error.message, () => controller.reload(false)));
          }
        }
      };
      const state = { panel, backdrop, opener, controller };
      current = state;
      body.append(loadingState());
      panel.focus();
      controller.reload(false);
      return controller;
    }
    return { open, close, isOpen: () => Boolean(current), reload: () => current?.controller.reload(true), hasInput: () => Boolean(current && current.panel.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) };
  }

  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };

  function barChart(points, label, format = fmt.number) {
    if (!points.some(point => point.value > 0)) return emptyState('No data yet', 'Nothing has been recorded for this period.');
    const width = 420; const height = 150; const base = 128;
    const max = Math.max(...points.map(point => point.value));
    const step = width / points.length;
    const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'ad-chart', role: 'img', 'aria-label': label, preserveAspectRatio: 'none' });
    points.forEach((point, index) => {
      const barHeight = Math.max(point.value ? 2 : 0, (point.value / max) * (base - 14));
      const bar = svg('rect', { class: 'bar', x: index * step + 3, y: base - barHeight, width: Math.max(2, step - 6), height: barHeight, rx: 2 });
      bar.append(Object.assign(svg('title'), { textContent: `${point.label}: ${format(point.value)}` }));
      chart.append(bar);
      if (index % Math.ceil(points.length / 7) === 0 || index === points.length - 1) chart.append(Object.assign(svg('text', { x: index * step, y: height - 6 }), { textContent: point.label.slice(5) }));
    });
    chart.append(Object.assign(svg('text', { x: 0, y: 10 }), { textContent: `max ${format(max)}` }));
    return chart;
  }

  function lineChart(points, label, format = fmt.number) {
    if (!points.some(point => point.value > 0)) return emptyState('No data yet', 'Nothing has been recorded for this period.');
    const width = 420; const height = 150; const base = 128;
    const max = Math.max(...points.map(point => point.value));
    const x = index => (index / (points.length - 1)) * width;
    const y = value => base - (value / max) * (base - 16);
    const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
    const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'ad-chart', role: 'img', 'aria-label': label, preserveAspectRatio: 'none' });
    chart.append(svg('path', { class: 'area', d: `${line} L${width} ${base} L0 ${base} Z` }), svg('path', { class: 'line', d: line }));
    chart.append(Object.assign(svg('text', { x: 0, y: 10 }), { textContent: `max ${format(max)}` }), Object.assign(svg('text', { x: 0, y: height - 6 }), { textContent: points[0].label.slice(5) }), Object.assign(svg('text', { x: width - 28, y: height - 6 }), { textContent: points.at(-1).label.slice(5) }));
    return chart;
  }

  window.AdminUI = { h, icon, fmt, statusBadge, statCard, card, note, kv, button, pageHeader, loadingState, emptyState, errorState, banner, region, dataTable, pager, filterBar, toast, toasts, confirmDialog, createPanelHost, barChart, lineChart };
})();
