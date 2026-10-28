(() => {
  'use strict';
  if (!window.adminApi || !window.AdminUI) return;
  const { h, icon, fmt, statusBadge, statCard, card, note, kv, button, pageHeader, loadingState, emptyState, errorState, banner, region, dataTable, pager, filterBar, toast, toasts, confirmDialog, createPanelHost, barChart, lineChart } = window.AdminUI;
  const api = window.adminApi;

  async function call(promise) {
    const result = await promise;
    if (result && result.locked) { lock(); throw new Error('Admin session ended. Please sign in again.'); }
    if (!result || !result.ok) throw new Error((result && result.error) || 'Request failed.');
    return result.data;
  }
  const sqlTime = value => (value ? Date.parse(`${String(value).replace(' ', 'T')}Z`) : null);

  const PAGES = [
    ['overview', 'Overview', 'overview'], ['users', 'User management', 'users'], ['messages', 'Messages', 'chat'], ['wifi', 'Wi-Fi connections', 'wifi'], ['devices', 'Connected devices', 'phone'],
    ['sessions', 'Sync history', 'history'], ['activity', 'Activity logs', 'list'], ['system', 'Storage & system', 'drive'], ['settings', 'Settings', 'sliders']
  ];
  const filters = { devices: {}, sessions: {}, activity: {} };
  const sorts = { devices: { key: 'lastSeen', dir: 'desc' }, sessions: { key: 'start', dir: 'desc' }, activity: { key: 'time', dir: 'desc' } };
  const pageNo = { devices: 1, sessions: 1, activity: 1 };

  let root; let main; let nav; let panels; let signOut; let current = null; let currentPage = null; let wantedPage = 'overview'; let unsubscribe = null; let refreshTimer = 0; let pairingTimer = 0;
  let auth = { known: false, unlocked: false, mustChange: false, username: 'admin' };

  function build() {
    root = h('div', { id: 'admin-root', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Admin dashboard' });
    nav = h('div', { className: 'admin-nav', role: 'navigation', 'aria-label': 'Admin sections' }, PAGES.map(([id, label, glyph]) => h('button', { type: 'button', 'data-page': id, onclick: () => { location.hash = `#admin/${id}`; } }, icon(glyph), h('span', { className: 'label', text: label }))));
    main = h('div', { className: 'admin-content', role: 'main', tabIndex: -1 });
    signOut = h('button', { type: 'button', className: 'admin-back', hidden: true, onclick: async () => { await api.logout(); lock(); } }, icon('close'), 'Sign out');
    root.append(
      h('aside', { className: 'admin-side' }, h('div', { className: 'admin-brand', text: 'Admin dashboard' }), nav, signOut, h('button', { type: 'button', className: 'admin-back', onclick: () => { location.hash = ''; } }, icon('back'), 'Back to library')),
      h('div', { className: 'admin-main' }, main), toasts);
    document.body.append(root);
    panels = createPanelHost(root);
    root.addEventListener('keydown', event => { if (event.key === 'Escape' && !panels.isOpen() && !root.querySelector('.ad-dialog-backdrop')) location.hash = ''; });
  }

  function addSidebarButton() {
    const footer = document.querySelector('.sidebar-footer');
    if (!footer || document.getElementById('admin-open')) return;
    const open = h('button', { type: 'button', id: 'admin-open', className: 'admin-open', onclick: () => { location.hash = '#admin/overview'; } }, icon('shield'), 'Admin dashboard');
    footer.parentNode.insertBefore(open, footer);
  }

  // ---- routing ----
  function route() {
    const match = /^#admin(?:\/([a-z]+))?/.exec(location.hash);
    if (!match) { closeDashboard(); return; }
    const id = PAGES.some(page => page[0] === match[1]) ? match[1] : 'overview';
    if (root.hidden) openDashboard();
    show(id);
  }
  function openDashboard() {
    root.hidden = false;
    auth.known = false;
    unsubscribe = window.wifiSync?.onEvent?.(() => scheduleRefresh()) || null;
  }
  function closeDashboard() {
    if (!root || root.hidden) return;
    root.hidden = true;
    panels.close();
    unsubscribe?.(); unsubscribe = null;
    clearInterval(pairingTimer); clearTimeout(refreshTimer);
    currentPage = null; main.replaceChildren(); signOut.hidden = true;
    api.logout();
    document.getElementById('admin-open')?.focus();
  }
  function show(id) {
    wantedPage = id;
    if (!auth.known) {
      api.authStatus().then(result => { auth = { ...(result.data || {}), known: true }; show(wantedPage); }).catch(() => { auth.known = true; show(wantedPage); });
      main.replaceChildren(loadingState());
      return;
    }
    if (!auth.unlocked) { renderLogin(); return; }
    signOut.hidden = false;
    if (currentPage === id) return;
    currentPage = id; panels.close(); clearInterval(pairingTimer);
    nav.querySelectorAll('button').forEach(link => (link.dataset.page === id ? link.setAttribute('aria-current', 'page') : link.removeAttribute('aria-current')));
    current = PAGE_RENDERERS[id]();
    const warning = auth.mustChange ? h('div', { className: 'ad-banner bad', role: 'alert' }, h('p', { text: 'This admin account still uses the default password. Change it now to keep the dashboard secure.' }), button('Change password', { small: true, onclick: () => { location.hash = '#admin/settings'; } })) : null;
    main.replaceChildren(...[warning, current.node].filter(Boolean));
    main.focus();
  }

  // Returns to the sign-in form, e.g. after sign-out or when the idle session expires.
  function lock() {
    auth.unlocked = false;
    currentPage = null; current = null;
    panels.close(); clearInterval(pairingTimer);
    signOut.hidden = true;
    renderLogin();
  }

  function renderLogin() {
    signOut.hidden = true;
    nav.querySelectorAll('button').forEach(link => link.removeAttribute('aria-current'));
    const message = h('p', { className: 'ad-note', role: 'alert' });
    const user = h('input', { name: 'username', type: 'text', autocomplete: 'username', required: true, value: auth.username || '' });
    const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const submit = button('Sign in', { kind: 'primary', onclick: () => form.requestSubmit() });
    const form = h('form', { className: 'ad-form', onsubmit: async event => {
      event.preventDefault();
      submit.disabled = true; message.textContent = '';
      try {
        const result = await api.login(user.value, pass.value);
        if (!result.ok) throw new Error(result.error);
        auth = { ...result.data, known: true };
        pass.value = '';
        currentPage = null;
        show(wantedPage);
      } catch (error) { message.textContent = error.message; pass.value = ''; pass.focus(); } finally { submit.disabled = false; }
    } },
    h('label', { className: 'ad-field' }, 'Username', user), h('label', { className: 'ad-field' }, 'Password', pass), message, h('div', { className: 'ad-actions' }, submit),
    auth.mustChange ? note('First sign-in: use the default account (admin / 123456), then change the password in Settings.') : null);
    main.replaceChildren(h('div', { style: 'max-width:380px;margin:8vh auto 0' }, card('Administrator sign-in', note('Sign in to manage users, devices and sync.'), form)));
    user.focus();
    if (user.value) pass.focus();
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (!current || root.hidden) return;
      const active = document.activeElement;
      if (active && main.contains(active) && /INPUT|SELECT|TEXTAREA/.test(active.tagName)) return;
      current.refresh?.();
      panels.reload();
    }, 800);
  }

  // Page frame: header with refresh and a body region loaded via `loader`.
  function framePage({ title, subtitle, actions = [], loader, render }) {
    const body = region();
    const refresh = silent => body.load(loader, render, { silent });
    const node = h('div', {}, pageHeader(title, subtitle, ...actions, button('Refresh', { icon: 'refresh', onclick: () => refresh(false) })), body.node);
    refresh(false);
    return { node, refresh: () => refresh(true), reload: () => refresh(false) };
  }

  const dateMs = (value, endOfDay) => (value ? new Date(`${value}T00:00:00`).getTime() + (endOfDay ? 86400000 : 0) : undefined);
  function listQuery(kind) {
    const f = filters[kind]; const query = { ...f, page: pageNo[kind], sort: sorts[kind].key, dir: sorts[kind].dir };
    if (f.from !== undefined || f.to !== undefined) { query.from = dateMs(f.from); query.to = dateMs(f.to, true); }
    for (const key of Object.keys(query)) if (query[key] === '' || query[key] === undefined) delete query[key];
    return query;
  }

  // Generic filterable/sortable/paginated list page.
  function listPage({ kind, title, subtitle, fields, columns, fetcher, onRow, actions = [], emptyText }) {
    const table = region();
    const load = silent => table.load(() => call(fetcher(listQuery(kind))), data => h('div', {},
      dataTable({
        columns, rows: data.rows, caption: title, sort: sorts[kind], onRowClick: onRow,
        onSort: key => { const s = sorts[kind]; sorts[kind] = { key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }; pageNo[kind] = 1; load(false); },
        empty: emptyState('Nothing to show', emptyText || 'No records match the current filters.')
      }), pager(data, page => { pageNo[kind] = page; load(false); })), { silent });
    const bar = filterBar(fields, filters[kind], () => { pageNo[kind] = 1; load(false); });
    const node = h('div', {}, pageHeader(title, subtitle, ...actions, button('Refresh', { icon: 'refresh', onclick: () => load(false) })), bar, table.node);
    load(false);
    return { node, refresh: () => load(true) };
  }

  // ---- shared pieces ----
  const deviceCell = row => h('div', {}, h('strong', { text: row.name || row.deviceName || 'Unnamed device' }), h('div', { className: 'ad-note', text: `${fmt.platform(row.platform)}${row.model ? ` · ${row.model}` : ''}` }));
  function progressBar(done, total) {
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return h('div', { className: 'ad-bar', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${percent}%` }));
  }
  const warningList = warnings => banner((warnings || []).map(item => (typeof item === 'string' ? item : item.message)), '');

  // ---- Overview ----
  function overviewPage() {
    return framePage({
      title: 'Overview', subtitle: 'Live status of this library server and its synced devices.',
      loader: () => call(api.overview()),
      render(d) {
        const c = d.cards;
        const grid = h('div', { className: 'ad-cards' },
          statCard('Users', c.users === null ? '—' : fmt.number(c.users), c.users === null ? 'Account directory unavailable' : 'Registered accounts'),
          statCard('Paired devices', fmt.number(c.pairedDevices)), statCard('Connected now', fmt.number(c.connectedDevices)), statCard('Active sync sessions', fmt.number(c.activeSessions)),
          statCard('Synced photos', fmt.number(c.syncedPhotos)), statCard('Synced videos', fmt.number(c.syncedVideos)), statCard('Failed jobs', fmt.number(c.failedJobs)), statCard('Pending jobs', fmt.number(c.pendingJobs)),
          statCard('Library size', fmt.bytes(c.libraryBytes), d.disk ? `${fmt.bytes(d.disk.freeBytes)} free` : 'Free space unknown'));
        const server = card('Wi-Fi sync server', kv([
          ['Status', statusBadge(d.server.running ? 'ok' : 'stopped', d.server.running ? 'Running' : 'Stopped')],
          ['Address', d.server.running ? d.server.url : null], ['Speed', d.server.running ? `${fmt.bytes(d.server.speedBytesPerSecond)}/s` : null]]),
        button('Open Wi-Fi connections', { small: true, onclick: () => { location.hash = '#admin/wifi'; } }));
        const charts = h('div', { className: 'ad-grid' },
          card('Files synced per day (14 days)', barChart(d.charts.syncedPerDay.map(p => ({ label: p.day, value: p.count })), 'Files synced per day')),
          card('Synced data over time (30 days)', lineChart(d.charts.cumulativeBytes.map(p => ({ label: p.day, value: p.bytes })), 'Cumulative synced data', fmt.bytes)),
          card('Sync results', resultBars(d.charts.results)),
          card('Synced files by device', deviceBars(d.charts.byDevice)));
        const recent = h('div', { className: 'ad-grid' },
          card('Recent sync sessions', d.recentSessions.length ? dataTable({
            columns: [{ key: 'device', label: 'Device', render: r => r.deviceName || r.device }, { key: 'status', label: 'Status', render: r => statusBadge(r.status) }, { key: 'files', label: 'Files', numeric: true, render: r => fmt.number(r.total) }, { key: 'start', label: 'Started', render: r => fmt.ago(r.startedAt) }],
            rows: d.recentSessions, onRowClick: r => openSession(r.id)
          }) : emptyState('No sync sessions yet')),
          card('Recently connected devices', d.recentDevices.length ? dataTable({
            columns: [{ key: 'name', label: 'Device', render: deviceCell }, { key: 'status', label: 'Status', render: r => statusBadge(r.status) }, { key: 'lastSeen', label: 'Last seen', render: r => fmt.ago(r.lastSeenAt) }],
            rows: d.recentDevices, onRowClick: r => openDevice(r.id)
          }) : emptyState('No devices paired yet')),
          card('Failed jobs', d.failedJobs.length ? dataTable({
            columns: [{ key: 'name', label: 'File' }, { key: 'device', label: 'Device' }, { key: 'error', label: 'Error', wrap: true }, { key: 'retryCount', label: 'Retries', numeric: true }],
            rows: d.failedJobs
          }) : emptyState('No failed jobs')),
          card('Recent security events', d.events.length ? dataTable({
            columns: [{ key: 'at', label: 'When', render: r => fmt.ago(r.at) }, { key: 'kind', label: 'Event' }, { key: 'message', label: 'Details', wrap: true }], rows: d.events
          }) : emptyState('No security events')));
        return h('div', {}, grid, h('div', { className: 'ad-grid' }, server), charts, recent);
      }
    });
  }
  function resultBars(r) {
    const total = r.succeeded + r.failed + r.cancelled;
    if (!total) return emptyState('No results yet');
    const row = (label, value, tone) => h('div', { className: 'item' }, h('div', { className: 'top' }, h('span', { text: label }), h('strong', { text: fmt.number(value) })), h('div', { className: `ad-bar ${tone}` }, h('i', { style: `width:${(value / total) * 100}%` })));
    return h('div', { className: 'ad-hbars' }, row('Succeeded', r.succeeded, ''), row('Failed', r.failed, 'bad'), row('Cancelled', r.cancelled, 'warn'));
  }
  function deviceBars(list) {
    if (!list.length) return emptyState('No data yet');
    const max = Math.max(...list.map(d => d.files), 1);
    return h('div', { className: 'ad-hbars' }, list.map(d => h('div', { className: 'item' }, h('div', { className: 'top' }, h('span', { text: d.name }), h('strong', { text: `${fmt.number(d.files)} · ${fmt.bytes(d.bytes)}` })), h('div', { className: 'ad-bar' }, h('i', { style: `width:${(d.files / max) * 100}%` })))));
  }

  // ---- Users ----
  function userAction(user) {
    const run = async (fn, message) => {
      try { const r = await fn(); if (r && r.locked) { lock(); return; } if (!r || !r.ok) throw new Error((r && r.error) || 'Action failed.'); toast(message); current?.refresh?.(); } catch (error) { toast(error.message, 'bad'); }
    };
    if (user.disabledAt) return button('Restore', { small: true, onclick: () => run(() => api.restoreUser(user.id), 'Account restored.') });
    return button('Revoke', { small: true, kind: 'danger', onclick: async () => {
      if (await confirmDialog({ title: 'Revoke this account?', message: `${user.email || 'This user'} will be signed out and unable to sign in. Their data and photos are kept, and you can restore access later.`, confirmLabel: 'Revoke account', danger: true })) run(() => api.revokeUser(user.id), 'Account revoked.');
    } });
  }
  function roleSelect(user) {
    const select = h('select', { 'aria-label': `Role for ${user.email || user.id}`, onchange: async () => {
      const previous = user.role;
      try {
        const r = await api.setUserRole(user.id, select.value);
        if (r && r.locked) { lock(); return; }
        if (!r || !r.ok) throw new Error((r && r.error) || 'Could not change the role.');
        user.role = select.value;
        toast(`Role set to ${select.value}.`);
      } catch (error) { select.value = previous; toast(error.message, 'bad'); }
    } }, [['viewer', 'Viewer (read-only)'], ['editor', 'Editor (edit & sync)'], ['admin', 'Admin']].map(([value, label]) => h('option', { value, text: label })));
    select.value = ['viewer', 'editor', 'admin'].includes(user.role) ? user.role : 'viewer';
    return select;
  }

  function openCreateUser() {
    panels.open({
      title: 'Add user', subtitle: 'Create an account on the embedded account server.', load: async () => ({}),
      render(_data, panel) {
        const field = (label, name, type, extra = {}) => h('label', { className: 'ad-field' }, label, h('input', { name, type, required: extra.required !== false, autocomplete: extra.autocomplete || 'off', maxLength: extra.max, minLength: extra.min }), extra.hint ? h('small', { text: extra.hint }) : null);
        const roles = h('select', { name: 'role' }, [['viewer', 'Viewer (read-only)'], ['editor', 'Editor (edit & sync)'], ['admin', 'Admin']].map(([value, label]) => h('option', { value, text: label })));
        const submit = button('Create user', { kind: 'primary', onclick: () => form.requestSubmit() });
        const form = h('form', { className: 'ad-form', onsubmit: async event => {
          event.preventDefault();
          const data = new FormData(form);
          submit.disabled = true;
          try {
            const r = await api.createUser({ email: data.get('email'), displayName: data.get('displayName'), password: data.get('password'), role: data.get('role') });
            if (r && r.locked) { lock(); return; }
            if (!r || !r.ok) throw new Error((r && r.error) || 'Could not create the user.');
            toast(`Created ${r.data.email}.`);
            panel.close();
            current?.refresh?.();
          } catch (error) { toast(error.message, 'bad'); } finally { submit.disabled = false; }
        } },
        field('Email', 'email', 'email', { max: 320 }),
        field('Display name', 'displayName', 'text', { required: false, max: 100, hint: 'Defaults to the part of the email before @.' }),
        field('Temporary password', 'password', 'password', { min: 8, max: 200, autocomplete: 'new-password', hint: '8–200 characters. Share it securely; the user can change it later.' }),
        h('label', { className: 'ad-field' }, 'Role', roles),
        h('div', { className: 'ad-actions' }, submit, button('Cancel', { onclick: () => panel.close() })));
        return [form];
      }
    });
  }

  function usersPage() {
    return framePage({
      title: 'User management', subtitle: 'Accounts registered on the embedded account server.',
      actions: [button('Add user', { kind: 'primary', onclick: openCreateUser })],
      loader: () => call(api.users()),
      render(d) {
        const dir = d.directory;
        const rows = dir.users;
        return h('div', {},
          dir.available === false ? banner([dir.reason || 'The account directory is not available from this app.']) : null,
          card('Accounts', rows.length ? dataTable({
            columns: [{ key: 'email', label: 'Email' }, { key: 'displayName', label: 'Name', render: r => r.displayName || '—' }, { key: 'role', label: 'Role', render: r => roleSelect(r) }, { key: 'status', label: 'Status', render: r => (r.disabledAt ? statusBadge('revoked', 'Revoked') : statusBadge('authorized', 'Active')) }, { key: 'createdAt', label: 'Created', render: r => fmt.date(sqlTime(r.createdAt)) }, { key: 'lastLoginAt', label: 'Last login', render: r => fmt.ago(sqlTime(r.lastLoginAt)) }, { key: 'actions', label: 'Actions', render: r => userAction(r) }],
            rows, caption: 'Accounts'
          }) : emptyState('No accounts to show', dir.available === false ? undefined : 'No users have registered yet.')),
          note('Create accounts with Add user and set roles inline. Revoking an account signs the user out and blocks sign-in; their data is kept and access can be restored. Paired devices are not linked to user accounts, so revoke devices separately.'));
      }
    });
  }

  // ---- Wi-Fi ----
  function wifiPage() {
    let pairing = null;
    let page;
    const act = async (fn, okMessage) => {
      try { const result = await fn(); if (result && result.ok === false) throw new Error(result.error || 'Action failed.'); toast(okMessage); } catch (error) { toast(error.message, 'bad'); }
      page.reload();
    };
    page = framePage({
      title: 'Wi-Fi connections', subtitle: 'Local network server used by the mobile app.',
      loader: () => call(api.wifi()),
      render(w) {
        const toggle = w.running
          ? button('Stop server', { kind: 'danger', onclick: async () => { if (await confirmDialog({ title: 'Stop the Wi-Fi sync server?', message: 'Connected devices will be disconnected and active uploads will pause until it is started again.', confirmLabel: 'Stop server', danger: true })) act(() => window.wifiSync.stop(), 'Server stopped.'); } })
          : button('Start server', { kind: 'primary', onclick: () => act(() => window.wifiSync.start(), 'Server started.') });
        const pairBox = h('div', { className: 'ad-qr-wrap' });
        const renderPairing = () => {
          clearInterval(pairingTimer);
          pairBox.replaceChildren();
          if (!pairing) { pairBox.append(note(w.running ? 'Generate a one-time pairing code to connect a new phone.' : 'Start the server to pair devices.')); return; }
          const left = h('span', {});
          const tick = () => {
            const remaining = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
            left.textContent = remaining ? `Expires in ${remaining}s` : 'Expired — generate a new code';
            if (!remaining) clearInterval(pairingTimer);
          };
          pairBox.append(h('div', { className: 'ad-qr' }, pairing.qr ? h('img', { src: pairing.qr, alt: 'Pairing QR code', width: 180, height: 180 }) : null, h('div', { className: 'code', text: pairing.code })), left);
          tick(); pairingTimer = setInterval(tick, 1000);
        };
        renderPairing();
        const generate = button('Generate pairing code', { kind: 'primary', small: true, disabled: !w.running, onclick: async () => {
          try { const result = await window.wifiSync.pair(); if (!result.ok) throw new Error(result.error || 'Could not create a pairing code.'); pairing = result.pairing; renderPairing(); } catch (error) { toast(error.message, 'bad'); }
        } });
        return h('div', {},
          warningList(w.warnings), w.lastError ? banner([`Last server error (${fmt.date(w.lastError.at)}): ${w.lastError.message}`], 'bad') : null,
          h('div', { className: 'ad-cards' }, statCard('Server', w.running ? 'Running' : 'Stopped'), statCard('Paired devices', fmt.number(w.pairedDevices)), statCard('Connected clients', fmt.number(w.connectedClients)), statCard('Active uploads', fmt.number(w.activeUploads)), statCard('Transfer speed', `${fmt.bytes(w.speedBytesPerSecond)}/s`)),
          h('div', { className: 'ad-grid' },
            card('Server', kv([['Address', w.running ? w.url : null], ['Host', w.host], ['Port', w.port], ['Interface', w.interface], ['Started', w.startedAt ? fmt.date(w.startedAt) : null],
              ['Reachability', w.reachability ? statusBadge(w.reachability.reachable ? 'ok' : 'error', w.reachability.reachable ? `Reachable (${w.reachability.latencyMs ?? '?'} ms)` : `Unreachable${w.reachability.error ? `: ${w.reachability.error}` : ''}`) : 'Not checked']]), h('div', { className: 'ad-actions' }, toggle)),
            card('Security', kv([['Transport', w.security.tls ? 'HTTPS (TLS)' : 'HTTP, local network only'], ['Certificate fingerprint', w.security.fingerprint], ['LAN only', w.security.privateOnly ? 'Yes — private addresses only' : 'No'], ['Pairing code lifetime', `${w.security.pairingTtlSeconds}s`]]),
              note('Remote (internet) administration is not available. Connections from public addresses are rejected.')),
            card('Pair a new device', pairBox, generate),
            card('How to connect a phone', h('ol', { className: 'ad-steps' }, ['Connect the phone to the same Wi-Fi network as this computer.', 'Start the server and generate a pairing code.', 'In the mobile app choose “Pair with computer” and scan the QR code or enter the code.', 'The device appears under Connected devices once paired.'].map(t => h('li', { text: t })))),
            card('Limits', kv([['Bandwidth limit', w.settings.bandwidthLimitKBps ? `${fmt.number(w.settings.bandwidthLimitKBps)} KB/s` : 'Unlimited'], ['Max file size', w.settings.maxFileSizeMB ? `${fmt.number(w.settings.maxFileSizeMB)} MB` : 'Unlimited'], ['Max concurrent uploads', 'Not configurable']]), note('Change these under Settings.'))));
      }
    });
    return page;
  }

  // ---- Devices ----
  const DEVICE_COLUMNS = [
    { key: 'name', label: 'Device', sortable: true, render: deviceCell },
    { key: 'platform', label: 'Platform', sortable: true, render: r => fmt.platform(r.platform) },
    { key: 'status', label: 'Status', sortable: true, render: r => statusBadge(r.status) },
    { key: 'lastSeen', label: 'Last seen', sortable: true, render: r => fmt.ago(r.lastSeenAt) },
    { key: 'lastSync', label: 'Last sync', sortable: true, render: r => fmt.ago(r.lastSyncAt) },
    { key: 'synced', label: 'Synced', sortable: true, numeric: true, render: r => fmt.number(r.synced) },
    { key: 'pending', label: 'Pending', sortable: true, numeric: true, render: r => fmt.number(r.pending) }
  ];
  function devicesPage() {
    return listPage({
      kind: 'devices', title: 'Connected devices', subtitle: 'Phones paired with this library. Select a row for details.',
      fields: [{ key: 'search', label: 'Search', type: 'search', grow: true, placeholder: 'Name or model' }, { key: 'status', label: 'Status', type: 'select', options: [['', 'All'], ['connected', 'Connected'], ['syncing', 'Syncing'], ['disconnected', 'Disconnected'], ['error', 'Error'], ['revoked', 'Revoked']] }],
      columns: DEVICE_COLUMNS, fetcher: api.devices, onRow: row => openDevice(row.id), emptyText: 'No devices are paired yet. Use Wi-Fi connections to pair a phone.'
    });
  }
  function openDevice(id) {
    panels.open({
      title: 'Device', subtitle: '', load: () => call(api.device(id)),
      render(d, panel) {
        const dev = d.device;
        panel.setTitle(dev.name || 'Unnamed device', `${fmt.platform(dev.platform)}${dev.model ? ` · ${dev.model}` : ''}`);
        const rename = h('input', { type: 'text', value: dev.name || '', maxLength: 60, 'aria-label': 'Device name' });
        const act = async (fn, message) => { try { const r = await fn(); if (r && r.ok === false) throw new Error(r.error); toast(message); current?.refresh?.(); panel.reload(true); } catch (error) { toast(error.message, 'bad'); } };
        const revoked = dev.authorization === 'revoked' || dev.status === 'revoked';
        return [
          h('div', {}, statusBadge(dev.status), ' ', statusBadge(revoked ? 'revoked' : 'authorized')),
          card('Details', kv([['Device ID', fmt.shortId(dev.id)], ['Paired', fmt.date(dev.createdAt)], ['Last seen', fmt.ago(dev.lastSeenAt)], ['Account', 'Not tracked'], ['Synced files', fmt.number(dev.synced)], ['Pending', fmt.number(dev.pending)], ['Failed', fmt.number(dev.failed)], ['Photos / videos', `${fmt.number(d.totals.images)} / ${fmt.number(d.totals.videos)}`], ['Duplicates skipped', fmt.number(d.totals.duplicates)], ['Data received', fmt.bytes(d.totals.bytes)]])),
          card('Rename', h('div', { className: 'ad-inline' }, rename, button('Save', { small: true, kind: 'primary', onclick: () => act(() => api.renameDevice(id, rename.value), 'Device renamed.') }))),
          card('Recent sync sessions', d.sessions.length ? dataTable({ columns: [{ key: 'status', label: 'Status', render: r => statusBadge(r.status) }, { key: 'files', label: 'Files', numeric: true, render: r => fmt.number(r.total) }, { key: 'start', label: 'Started', render: r => fmt.date(r.startedAt) }], rows: d.sessions, onRowClick: r => openSession(r.id) }) : emptyState('No sessions'),
            button('View full sync history', { small: true, onclick: () => { filters.sessions = { deviceId: id }; pageNo.sessions = 1; panels.close(); if (currentPage === 'sessions') { currentPage = null; show('sessions'); } else location.hash = '#admin/sessions'; } })),
          card('Recent errors', d.errors.length ? dataTable({ columns: [{ key: 'name', label: 'File' }, { key: 'message', label: 'Error', wrap: true }, { key: 'at', label: 'When', render: r => fmt.ago(r.at) }], rows: d.errors }) : emptyState('No errors')),
          card('Recent activity', d.activity.length ? dataTable({ columns: [{ key: 'ts', label: 'When', render: r => fmt.ago(r.ts) }, { key: 'message', label: 'Event', wrap: true }], rows: d.activity }) : emptyState('No activity')),
          card('Actions',
            h('div', { className: 'ad-actions' },
              revoked ? null : button('Revoke access', { kind: 'danger', onclick: async () => { if (await confirmDialog({ title: 'Revoke this device?', message: `“${dev.name}” will immediately lose access and its unfinished uploads are cancelled. Photos already synced are kept.`, confirmLabel: 'Revoke', danger: true })) act(() => api.revokeDevice(id), 'Device revoked.'); } }),
              button('Remove device', { kind: 'danger', onclick: async () => { if (await confirmDialog({ title: 'Remove this device?', message: `“${dev.name}” will be revoked and removed from the list. Photos already synced are kept in your library.`, confirmLabel: 'Remove', danger: true })) { try { const r = await api.removeDevice(id); if (!r.ok) throw new Error(r.error); toast('Device removed.'); panel.close(); current?.refresh?.(); } catch (error) { toast(error.message, 'bad'); } } } })),
            note('Triggering, pausing or resuming a sync from the desktop is not supported — syncs are started from the phone.'))
        ];
      }
    });
  }

  // ---- Sync sessions ----
  function sessionsPage() {
    const exportCsv = button('Export CSV', { icon: 'download', onclick: async () => {
      try {
        const csv = await call(api.sessionsCsv(listQuery('sessions')));
        const link = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `sync-history-${new Date().toISOString().slice(0, 10)}.csv` });
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      } catch (error) { toast(error.message, 'bad'); }
    } });
    return listPage({
      kind: 'sessions', title: 'Sync history', subtitle: 'Every sync session received from your devices.', actions: [exportCsv],
      fields: [
        { key: 'search', label: 'Search', type: 'search', grow: true, placeholder: 'Device or file name' },
        { key: 'status', label: 'Status', type: 'select', options: [['', 'All'], ['queued', 'Queued'], ['running', 'Running'], ['completed', 'Completed'], ['completed_with_errors', 'Completed with errors'], ['failed', 'Failed'], ['cancelled', 'Cancelled']] },
        { key: 'media', label: 'Media', type: 'select', options: [['', 'All'], ['image', 'Photos'], ['video', 'Videos']] },
        { key: 'errorCategory', label: 'Error type', type: 'select', options: [['', 'All'], ['storage', 'Storage'], ['size', 'File size'], ['indexing', 'Indexing'], ['file_type', 'File type'], ['integrity', 'Integrity'], ['other', 'Other']] },
        { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }],
      columns: [
        { key: 'device', label: 'Device', sortable: true, render: r => r.deviceName || r.device },
        { key: 'start', label: 'Started', sortable: true, render: r => fmt.date(r.startedAt) },
        { key: 'duration', label: 'Duration', sortable: true, render: r => fmt.duration(r.durationMs) },
        { key: 'status', label: 'Status', sortable: true, render: r => statusBadge(r.status) },
        { key: 'files', label: 'Files', sortable: true, numeric: true, render: r => fmt.number(r.total) },
        { key: 'failed', label: 'Failed', sortable: true, numeric: true, render: r => fmt.number(r.failed) },
        { key: 'bytes', label: 'Size', sortable: true, numeric: true, render: r => fmt.bytes(r.bytes) }],
      fetcher: api.sessions, onRow: row => openSession(row.id), emptyText: 'No sync sessions match. Sessions appear after a phone syncs.'
    });
  }
  function openSession(id) {
    panels.open({
      title: 'Sync session', subtitle: '', load: () => call(api.session(id)),
      render(d, panel) {
        const s = d.session;
        panel.setTitle(`Sync from ${s.deviceName || s.device || 'device'}`, fmt.date(s.startedAt));
        const active = s.status === 'running' || s.status === 'queued';
        const retryable = d.files.some(f => f.state === 'failed_retryable' || f.state === 'failed_permanent');
        return [
          h('div', {}, statusBadge(s.status)),
          active ? card('Progress', progressBar(s.total - s.pending, s.total), note(`${fmt.number(s.total - s.pending)} of ${fmt.number(s.total)} files processed`)) : null,
          card('Summary', kv([['Started', fmt.date(s.startedAt)], ['Finished', s.endedAt ? fmt.date(s.endedAt) : null], ['Duration', fmt.duration(s.durationMs)], ['Files', fmt.number(s.total)], ['Synchronized', fmt.number(s.succeeded)], ['Failed', fmt.number(s.failed)], ['Data received', fmt.bytes(s.bytes)]])),
          card('Files', d.files.length ? dataTable({
            columns: [{ key: 'name', label: 'File', wrap: true }, { key: 'kind', label: 'Type' }, { key: 'size', label: 'Size', numeric: true, render: r => fmt.bytes(r.size) }, { key: 'state', label: 'State', render: r => statusBadge(r.state) }, { key: 'retryCount', label: 'Retries', numeric: true }, { key: 'error', label: 'Error', wrap: true, render: r => (r.error ? `${r.error}` : '') }],
            rows: d.files, caption: 'Files in this session'
          }) : emptyState('No files recorded'), d.truncated ? note('Only the first files are shown.') : null,
          retryable ? button('Retry failed files', { kind: 'primary', onclick: async () => { try { const r = await call(api.retrySession(id)); toast(`Retry queued for ${r.retried ?? r.count ?? 0} file(s).`); panel.reload(true); } catch (error) { toast(error.message, 'bad'); } } }) : null),
          card('Session activity', d.activity.length ? dataTable({ columns: [{ key: 'ts', label: 'When', render: r => fmt.date(r.ts) }, { key: 'message', label: 'Event', wrap: true }], rows: d.activity }) : emptyState('No activity'))
        ];
      }
    });
  }

  // ---- Activity ----
  function activityPage() {
    return listPage({
      kind: 'activity', title: 'Activity logs', subtitle: 'Operational and security events. Secrets are never recorded.',
      fields: [
        { key: 'search', label: 'Search', type: 'search', grow: true, placeholder: 'Message text' },
        { key: 'category', label: 'Category', type: 'select', options: [['', 'All'], ['operational', 'Operational'], ['security', 'Security']] },
        { key: 'severity', label: 'Severity', type: 'select', options: [['', 'All'], ['info', 'Info'], ['warning', 'Warning'], ['error', 'Error']] },
        { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }],
      columns: [
        { key: 'time', label: 'When', sortable: true, render: r => fmt.date(r.at) },
        { key: 'severity', label: 'Severity', sortable: true, render: r => statusBadge(r.severity) },
        { key: 'category', label: 'Category', sortable: true },
        { key: 'kind', label: 'Event', sortable: true },
        { key: 'message', label: 'Details', wrap: true }],
      fetcher: api.activity, emptyText: 'No events recorded yet.'
    });
  }

  // ---- System ----
  function systemPage() {
    return framePage({
      title: 'Storage & system', subtitle: 'Library storage, indexing and database health.',
      loader: () => call(api.system()),
      render(s) {
        const diskUsed = s.disk ? 1 - s.disk.freeBytes / s.disk.totalBytes : 0;
        return h('div', {},
          warningList(s.warnings),
          h('div', { className: 'ad-cards' }, statCard('Photos', fmt.number(s.totals.photos)), statCard('Videos', fmt.number(s.totals.videos)), statCard('Documents', fmt.number(s.totals.documents)), statCard('Library size', fmt.bytes(s.totals.bytes)), statCard('Pending sync', fmt.number(s.pendingSync)), statCard('Pending indexing', fmt.number(s.pendingIndexing)), statCard('Stuck jobs', fmt.number(s.stuck))),
          h('div', { className: 'ad-grid' },
            card('Disk', s.disk ? h('div', {}, h('div', { className: `ad-bar ${diskUsed > 0.9 ? 'bad' : diskUsed > 0.75 ? 'warn' : ''}` }, h('i', { style: `width:${Math.round(diskUsed * 100)}%` })), note(`${fmt.bytes(s.disk.freeBytes)} free of ${fmt.bytes(s.disk.totalBytes)}`)) : emptyState('Disk information unavailable')),
            card('Database', kv([['Status', statusBadge(s.database.status === 'ok' ? 'ok' : 'error', s.database.status === 'ok' ? 'Healthy' : 'Problem')], ['Detail', s.database.detail], ['Size', fmt.bytes(s.database.bytes)], ['Schema version', s.database.schemaVersion]])),
            card('Services', kv([['Wi-Fi server', statusBadge(s.server.running ? 'ok' : 'stopped', s.server.running ? (s.server.reachable ? 'Running, reachable' : 'Running') : 'Stopped')], ['Indexing', s.indexing === 'working' ? 'Working' : 'Idle'], ['Thumbnails', `${fmt.number(s.thumbnails.files)} files · ${fmt.bytes(s.thumbnails.bytes)}`]]), note(`Thumbnail mode: ${s.thumbnails.mode}`)),
            card('Data directory', kv([['Location', s.dataDirectory]]))),
          card('Libraries', s.libraries.length ? dataTable({
            columns: [{ key: 'name', label: 'Library' }, { key: 'photos', label: 'Photos', numeric: true, render: r => fmt.number(r.photos) }, { key: 'videos', label: 'Videos', numeric: true, render: r => fmt.number(r.videos) }, { key: 'documents', label: 'Documents', numeric: true, render: r => fmt.number(r.documents) }, { key: 'bytes', label: 'Size', numeric: true, render: r => fmt.bytes(r.bytes) }, { key: 'error', label: 'Status', render: r => (r.error ? statusBadge('error', r.error) : statusBadge('ok')) }],
            rows: s.libraries
          }) : emptyState('No libraries', 'Add a library folder in the main window.')));
      }
    });
  }

  // ---- Settings ----
  function credentialsCard() {
    const field = (label, name, type, autocomplete, value = '') => h('label', { className: 'ad-field' }, label, h('input', { name, type, autocomplete, value, required: name !== 'username' }));
    const form = h('form', { className: 'ad-form', onsubmit: async event => {
      event.preventDefault();
      const data = new FormData(form);
      if (data.get('newPassword') !== data.get('confirm')) { toast('The new passwords do not match.', 'bad'); return; }
      try {
        const result = await api.changePassword({ currentPassword: data.get('currentPassword'), username: data.get('username'), newPassword: data.get('newPassword') });
        if (result.locked) { lock(); return; }
        if (!result.ok) throw new Error(result.error);
        auth = { ...result.data, known: true };
        form.reset();
        toast('Admin credentials updated.');
        currentPage = null; show('settings');
      } catch (error) { toast(error.message, 'bad'); }
    } },
    field('Admin username', 'username', 'username', 'username', auth.username),
    field('Current password', 'currentPassword', 'password', 'current-password'),
    field('New password (8+ characters)', 'newPassword', 'password', 'new-password'),
    field('Confirm new password', 'confirm', 'password', 'new-password'),
    h('div', { className: 'ad-actions' }, button('Update credentials', { kind: 'primary', onclick: () => form.requestSubmit() })));
    return card('Administrator account', form, note('You are signed out automatically after 30 minutes of inactivity or when you leave the dashboard.'));
  }
  function settingsPage() {
    return framePage({
      title: 'Settings', subtitle: 'Wi-Fi sync configuration. Changes apply immediately.',
      loader: () => call(api.wifi()),
      render(w) {
        const s = w.settings;
        const field = (label, name, value, extra = {}) => h('label', { className: 'ad-field' }, label, h('input', { name, type: 'number', value: value ?? '', min: extra.min ?? 0, max: extra.max, step: 1 }), extra.hint ? h('small', { text: extra.hint }) : null);
        const folder = h('label', { className: 'ad-field' }, 'Destination folder', h('input', { name: 'destinationFolder', type: 'text', value: s.destinationFolder || '', maxLength: 60 }), h('small', { text: 'Folder inside the library where synced files are stored.' }));
        const form = h('form', { className: 'ad-form', onsubmit: async event => {
          event.preventDefault();
          const data = new FormData(form);
          const num = key => (data.get(key) === '' ? 0 : Number(data.get(key)));
          const patch = { port: num('port'), bandwidthLimitKBps: num('bandwidthLimitKBps'), maxFileSizeMB: num('maxFileSizeMB'), minFreeSpaceMB: num('minFreeSpaceMB'), pairingTtlSeconds: num('pairingTtlSeconds'), destinationFolder: data.get('destinationFolder') };
          const invalid = [];
          if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535) invalid.push('Port must be between 1024 and 65535.');
          if (!Number.isInteger(patch.pairingTtlSeconds) || patch.pairingTtlSeconds < 30 || patch.pairingTtlSeconds > 600) invalid.push('Pairing code lifetime must be 30–600 seconds.');
          for (const key of ['bandwidthLimitKBps', 'maxFileSizeMB', 'minFreeSpaceMB']) if (!(patch[key] >= 0)) invalid.push('Limits must be zero or greater.');
          if (invalid.length) { toast(invalid[0], 'bad'); return; }
          try { const r = await window.wifiSync.updateSettings(patch); if (r && r.ok === false) throw new Error(r.error); toast('Settings saved.'); } catch (error) { toast(error.message, 'bad'); }
        } },
        folder, field('Port', 'port', s.port, { min: 1024, max: 65535, hint: 'Takes effect the next time the server starts.' }),
        field('Pairing code lifetime (seconds)', 'pairingTtlSeconds', s.pairingTtlSeconds, { min: 30, max: 600 }),
        field('Bandwidth limit (KB/s)', 'bandwidthLimitKBps', s.bandwidthLimitKBps, { hint: '0 means unlimited.' }),
        field('Max file size (MB)', 'maxFileSizeMB', s.maxFileSizeMB, { hint: '0 means unlimited.' }),
        field('Minimum free disk space (MB)', 'minFreeSpaceMB', s.minFreeSpaceMB, { hint: 'Uploads are refused below this amount.' }),
        h('div', { className: 'ad-actions' }, button('Save settings', { kind: 'primary', onclick: () => form.requestSubmit() })));
        return h('div', {}, credentialsCard(), card('Wi-Fi sync', form), card('Notes', h('ul', { className: 'ad-list' },
          ['The activity log keeps the most recent 5,000 events.', 'The server accepts connections from the local network only; remote administration is not available.', 'Maximum concurrent uploads and Wi-Fi-only enforcement are not configurable.'].map(t => h('li', { text: t })))));
      }
    });
  }

  // ---- Messages & notifications ----
  const NAV_BADGE = h('span', { className: 'ad-nav-badge', hidden: true });
  function setNavBadge(count) { NAV_BADGE.textContent = count > 99 ? '99+' : String(count); NAV_BADGE.hidden = !count; }
  async function refreshNavBadge() {
    try { setNavBadge((await call(api.chatUnread())).unread); } catch { /* chat unavailable */ }
  }

  function messagesPage() {
    const view = { status: 'open', selected: null, conversations: [], thread: null, image: null };
    const list = h('div', { className: 'ad-chat-list', role: 'list' });
    const header = h('div', { className: 'ad-chat-head' });
    const log = h('div', { className: 'ad-chat-log', role: 'log', 'aria-live': 'polite' });
    const input = h('textarea', { rows: 2, maxLength: 2000, placeholder: 'Reply…', 'aria-label': 'Reply' });
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
    const chip = h('div', { className: 'ad-chat-chip', hidden: true });
    const send = button('Send', { kind: 'primary' });
    const pane = h('div', { className: 'ad-chat-pane' }, header, log, chip, h('div', { className: 'ad-chat-compose' }, button('Attach', { small: true, onclick: () => fileInput.click() }), input, send), fileInput);
    const filter = h('select', { 'aria-label': 'Conversation filter', onchange: () => { view.status = filter.value; view.selected = null; view.thread = null; load(); } },
      h('option', { value: 'open', text: 'Open' }), h('option', { value: 'closed', text: 'Closed' }), h('option', { value: '', text: 'All' }));
    const node = h('div', {}, pageHeader('Messages', 'Chat with users and send notifications.', button('Send notification', { kind: 'primary', icon: 'chat', onclick: openNotifyPanel }), button('Sent notifications', { onclick: openSentPanel })),
      h('div', { className: 'ad-chat' }, h('div', { className: 'ad-chat-side' }, filter, list), pane));

    const when = value => fmt.ago(sqlTime(value));
    async function loadImage(message, target) {
      try { target.src = await call(api.chatImage(message.id, view.selected)); } catch { target.replaceWith(h('em', { text: 'Image unavailable' })); }
    }
    function renderList() {
      list.replaceChildren(...(view.conversations.length ? view.conversations.map(c => h('button', { type: 'button', role: 'listitem', className: `ad-chat-item${c.userId === view.selected ? ' active' : ''}`, onclick: () => open(c.userId) },
        h('strong', { text: c.displayName || c.email }), c.unread ? h('span', { className: 'ad-nav-badge', text: String(c.unread) }) : null,
        h('small', { text: `${c.lastSender === 'admin' ? 'You: ' : ''}${c.preview}` }), h('small', { className: 'muted', text: when(c.lastAt) + (c.status === 'closed' ? ' · closed' : '') }))) : [emptyState('No conversations', 'Users appear here after they message you.')]));
    }
    function renderThread() {
      const convo = view.conversations.find(c => c.userId === view.selected);
      header.replaceChildren(convo ? h('div', {}, h('strong', { text: convo.displayName || convo.email }), h('small', { text: ` ${convo.email}${convo.disabled ? ' · revoked' : ''}` })) : h('span', { className: 'muted', text: 'Select a conversation' }),
        convo ? button(convo.status === 'closed' ? 'Reopen' : 'Close conversation', { small: true, onclick: async () => { try { await call(api.chatSetStatus(convo.userId, convo.status === 'closed' ? 'open' : 'closed')); await load(); } catch (e) { toast(e.message, 'bad'); } } }) : null);
      log.replaceChildren();
      if (!view.thread) return;
      const lastAdmin = [...view.thread.messages].reverse().find(m => m.sender === 'admin');
      for (const m of view.thread.messages) {
        const mine = m.sender === 'admin';
        const img = m.hasImage ? h('img', { alt: 'Attached image', className: 'ad-chat-image' }) : null;
        log.append(h('div', { className: `ad-chat-bubble ${mine ? 'mine' : 'theirs'}` }, img, m.body ? h('p', { text: m.body }) : null, h('small', { text: `${when(m.createdAt)}${mine && m === lastAdmin && m.readAt ? ' · Seen' : ''}` })));
        if (img) loadImage(m, img);
      }
      log.scrollTop = log.scrollHeight;
    }
    async function load() {
      try {
        const data = await call(api.chatConversations(view.status));
        view.conversations = data.conversations;
        setNavBadge(data.unread);
        if (view.selected) view.thread = await call(api.chatThread(view.selected));
        renderList(); renderThread();
        const unreadNow = (await call(api.chatConversations(view.status))); view.conversations = unreadNow.conversations; renderList(); setNavBadge(unreadNow.unread);
      } catch (error) { list.replaceChildren(errorState(error.message, load)); }
    }
    async function open(userId) { view.selected = userId; view.thread = null; await load(); input.focus(); }
    let attachment = null;
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0]; attachment = null; chip.hidden = !file; chip.replaceChildren();
      if (!file) return;
      if (file.size > 1.5 * 1024 * 1024) { toast('Image is larger than 1.5 MB.', 'bad'); fileInput.value = ''; chip.hidden = true; return; }
      const bytes = new Uint8Array(await file.arrayBuffer()); let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      attachment = { type: file.type, data: btoa(bin) };
      chip.append(h('span', { text: `${file.name} ` }), button('Remove', { small: true, onclick: () => { attachment = null; fileInput.value = ''; chip.hidden = true; } }));
    });
    async function submit() {
      if (!view.selected || (!input.value.trim() && !attachment)) return;
      send.disabled = true;
      try { await call(api.chatSend(view.selected, { text: input.value.trim(), image: attachment || undefined })); input.value = ''; attachment = null; fileInput.value = ''; chip.hidden = true; await load(); } catch (e) { toast(e.message, 'bad'); } finally { send.disabled = false; input.focus(); }
    }
    send.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

    function openNotifyPanel() {
      const title = h('input', { type: 'text', maxLength: 120, required: true });
      const body = h('textarea', { rows: 4, maxLength: 2000 });
      const everyone = h('input', { type: 'radio', name: 'aud', checked: true });
      const some = h('input', { type: 'radio', name: 'aud' });
      const picks = h('div', { className: 'ad-picks' });
      call(api.users()).then(d => picks.replaceChildren(...d.directory.users.filter(u => !u.disabledAt).map(u => h('label', {}, h('input', { type: 'checkbox', value: String(u.id) }), ` ${u.displayName || u.email}`)))).catch(() => {});
      const message = h('p', { className: 'ad-note', role: 'alert' });
      const form = h('form', { className: 'ad-form', onsubmit: async e => {
        e.preventDefault();
        const ids = some.checked ? [...picks.querySelectorAll('input:checked')].map(i => Number(i.value)) : undefined;
        if (some.checked && !ids.length) { message.textContent = 'Select at least one user.'; return; }
        try { const r = await call(api.notify({ title: title.value, body: body.value, userIds: ids })); toast(`Sent to ${r.recipients} user(s).`); panels.close(); } catch (err) { message.textContent = err.message; }
      } }, h('label', { className: 'ad-field' }, 'Title', title), h('label', { className: 'ad-field' }, 'Message', body),
      h('label', {}, everyone, ' All active users'), h('label', {}, some, ' Selected users'), picks, message, h('div', { className: 'ad-actions' }, button('Send', { kind: 'primary', onclick: () => form.requestSubmit() })));
      panels.open({ title: 'Send notification', subtitle: 'Appears in each user\'s notifications and as a desktop alert.', load: async () => ({}), render: () => [form] });
    }
    function openSentPanel() {
      const table = rows => (rows.length ? dataTable({ columns: [{ key: 'title', label: 'Title' }, { key: 'audience', label: 'Audience' }, { key: 'readCount', label: 'Read', render: r => `/` }, { key: 'createdAt', label: 'Sent', render: r => when(r.createdAt) }], rows, caption: 'Sent notifications' }) : emptyState('Nothing sent yet'));
      panels.open({ title: 'Sent notifications', load: () => call(api.sentNotifications()), render: rows => [table(rows)] });
    }
    load();
    return { node, refresh: load, chatEvent: () => load() };
  }
  const PAGE_RENDERERS = { overview: overviewPage, users: usersPage, messages: messagesPage, wifi: wifiPage, devices: devicesPage, sessions: sessionsPage, activity: activityPage, system: systemPage, settings: settingsPage };

  function init() {
    build();
    addSidebarButton();
    nav.querySelector('[data-page="messages"]').append(NAV_BADGE);
    api.onChatEvent?.(event => { if (auth.unlocked) { if (typeof event.unread === 'number') setNavBadge(event.unread); current?.chatEvent?.(event); } });
    window.addEventListener('hashchange', route);
    route();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
