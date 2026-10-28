(() => {
  'use strict';
  const API = '/api/v1';
  const MAX_SEND = 1.4 * 1024 * 1024;
  const MAX_SIDE = 1600;
  const state = { enabled: false, token: '', open: false, tab: 'chat', status: 'open', messages: [], notifications: [], unread: { messages: 0, notifications: 0 }, image: null, source: null, retry: 0, retryTimer: 0, layer: null };

  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...[].concat(children).filter(child => child !== null && child !== undefined && child !== ''));
    return node;
  };
  const when = value => { const d = new Date(String(value).replace(' ', 'T') + 'Z'); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };

  async function call(method, route, body) {
    const response = await fetch(API + route, {
      method,
      credentials: 'same-origin',
      headers: { ...(state.token ? { Authorization: ['Bearer', state.token].join(' ') } : {}), 'X-Still-App': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Request failed.'), { code: data.error?.code, status: response.status });
    return data;
  }

  // ---- header button + alert banner ----
  const badge = el('span', { className: 'chat-badge', hidden: true });
  const button = el('button', { type: 'button', id: 'chat-open', className: 'icon chat-btn', hidden: true }, ['💬', badge]);
  button.setAttribute('aria-label', 'Messages and notifications');
  const banner = el('button', { type: 'button', id: 'chat-banner', hidden: true });
  let bannerTimer = 0;

  // ---- sheet ----
  const back = el('button', { type: 'button', className: 'icon' }, ['‹']);
  back.setAttribute('aria-label', 'Close messages');
  const tabChat = el('button', { type: 'button', className: 'chat-tab' }, ['Chat with admin']);
  const tabNotes = el('button', { type: 'button', className: 'chat-tab' }, ['Notifications']);
  const notesBadge = el('span', { className: 'chat-badge inline', hidden: true });
  tabNotes.append(notesBadge);
  const notice = el('p', { className: 'chat-notice', hidden: true });
  const list = el('div', { className: 'chat-list' });
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');
  const input = el('textarea', { rows: 1, maxLength: 2000, placeholder: 'Message' });
  input.setAttribute('aria-label', 'Message');
  const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const attach = el('button', { type: 'button', className: 'icon' }, ['📎']);
  attach.setAttribute('aria-label', 'Attach a photo');
  const sendButton = el('button', { type: 'submit', className: 'chat-send' }, ['Send']);
  const chip = el('div', { className: 'chat-chip', hidden: true });
  const form = el('form', { className: 'chat-form' }, [chip, el('div', { className: 'chat-compose' }, [attach, input, sendButton]), fileInput]);
  const alerts = el('button', { type: 'button', className: 'chat-alerts', hidden: true }, ['Turn on alerts for this phone']);
  const sheet = el('section', { id: 'chat-sheet', hidden: true }, [
    el('header', { className: 'chat-head' }, [back, el('div', { className: 'chat-tabs' }, [tabChat, tabNotes])]),
    notice, alerts, list, form
  ]);
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Messages and notifications');

  function renderBadge() {
    const total = state.unread.messages + state.unread.notifications;
    badge.hidden = !total;
    badge.textContent = total > 99 ? '99+' : String(total);
    notesBadge.hidden = !state.unread.notifications;
    notesBadge.textContent = String(state.unread.notifications);
    document.title = total ? `(${total}) Still` : 'Still';
    try { if (total) navigator.setAppBadge?.(total); else navigator.clearAppBadge?.(); } catch { /* not supported */ }
  }

  function renderChat() {
    list.replaceChildren();
    if (!state.messages.length) list.append(el('p', { className: 'chat-empty' }, ['No messages yet. Say hello to the admin.']));
    const lastMine = [...state.messages].reverse().find(m => m.sender === 'user');
    for (const m of state.messages) {
      const mine = m.sender === 'user';
      const bubble = el('div', { className: `chat-bubble ${mine ? 'mine' : 'theirs'}` });
      if (m.hasImage) {
        const img = el('img', { className: 'chat-image', alt: 'Attached photo', loading: 'lazy', src: `${API}/chat/images/${m.id}` });
        img.addEventListener('error', () => img.replaceWith(el('em', {}, ['Photo unavailable'])), { once: true });
        bubble.append(img);
      }
      if (m.body) bubble.append(el('p', { textContent: m.body }));
      bubble.append(el('small', { textContent: [when(m.createdAt), mine && m === lastMine && m.readAt ? 'Seen' : ''].filter(Boolean).join(' · ') }));
      list.append(bubble);
    }
    const closed = state.status === 'closed';
    notice.hidden = !closed;
    notice.textContent = closed ? 'The admin closed this conversation. Send a message to reopen it.' : '';
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  function renderNotes() {
    list.replaceChildren();
    if (!state.notifications.length) list.append(el('p', { className: 'chat-empty' }, ['No notifications.']));
    for (const n of state.notifications) {
      list.append(el('article', { className: `chat-note${n.readAt ? '' : ' unread'}` }, [
        el('strong', { textContent: n.title }), n.body ? el('p', { textContent: n.body }) : null, el('small', { textContent: when(n.createdAt) })
      ]));
    }
    notice.hidden = true;
  }

  function render() {
    tabChat.classList.toggle('active', state.tab === 'chat');
    tabNotes.classList.toggle('active', state.tab === 'notes');
    form.hidden = state.tab !== 'chat';
    alerts.hidden = !(state.tab === 'notes' && canAskForAlerts());
    if (state.tab === 'chat') renderChat(); else renderNotes();
    renderBadge();
  }

  async function refresh() {
    if (!state.enabled) return;
    try {
      if (state.tab === 'chat') {
        const data = await call('GET', '/chat/messages');
        state.messages = data.messages || [];
        state.status = data.conversation?.status || 'open';
        if (data.unread) state.unread = data.unread;
        if (state.open && !document.hidden && state.unread.messages) await call('POST', '/chat/read');
      } else {
        const data = await call('GET', '/chat/notifications');
        state.notifications = data.notifications || [];
        if (data.unread) state.unread = data.unread;
        if (state.open && !document.hidden && state.unread.notifications) await call('POST', '/chat/notifications/read', {});
      }
    } catch (error) {
      notice.hidden = false;
      notice.textContent = error.message;
      return;
    }
    render();
  }

  function closeNow() { state.open = false; sheet.hidden = true; document.body.classList.remove('chat-open'); state.layer = null; }
  function setOpen(open) {
    if (open === state.open) return;
    if (open) {
      state.open = true; sheet.hidden = false; document.body.classList.add('chat-open');
      state.layer = window.StillApp ? window.StillApp.pushLayer(closeNow) : closeNow;
      render(); refresh();
    } else if (window.StillApp && state.layer) window.StillApp.dismissLayer(state.layer);
    else closeNow();
  }

  // ---- alerts: in-app banner + vibration always; a system notification only where the browser allows it ----
  const canAskForAlerts = () => 'Notification' in window && window.isSecureContext && Notification.permission === 'default';
  function alertUser(title, text) {
    try { navigator.vibrate?.([90, 50, 90]); } catch { /* not supported */ }
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body: text, tag: 'still-chat' }); return; } catch { /* Android needs a service worker; fall back to the banner */ }
    }
    banner.replaceChildren(el('strong', { textContent: title }), el('span', { textContent: text }));
    banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { banner.hidden = true; }, 6000);
  }

  // ---- live updates ----
  function handle(event) {
    if (event.type === 'unread') { state.unread = event.unread || state.unread; renderBadge(); return; }
    if (event.type === 'message' && event.sender === 'admin') {
      if (!(state.open && state.tab === 'chat' && !document.hidden)) alertUser('Message from admin', event.preview || 'New message');
    } else if (event.type === 'notification') {
      if (!(state.open && state.tab === 'notes' && !document.hidden)) alertUser(event.title || 'Notification', event.preview || '');
    } else if (event.type === 'status') state.status = event.status;
    if (state.open) refresh();
  }

  function disconnect() {
    clearTimeout(state.retryTimer);
    if (state.source) { state.source.close(); state.source = null; }
  }
  function connect() {
    disconnect();
    if (!state.enabled) return;
    const source = new EventSource(`${API}/chat/stream`);
    state.source = source;
    source.onopen = () => { state.retry = 0; };
    source.onmessage = message => { try { handle(JSON.parse(message.data)); } catch { /* ignore malformed */ } };
    source.onerror = () => {
      // The browser retries dropped connections itself; a refused one (signed out, unpaired) closes for good.
      if (source.readyState !== EventSource.CLOSED) return;
      state.source = null;
      const delay = Math.min(30000, 1000 * 2 ** state.retry++);
      state.retryTimer = setTimeout(recheck, delay);
    };
  }
  async function recheck() {
    try {
      const me = await call('GET', '/me');
      enable(Boolean(me.chat && me.loggedIn));
    } catch { state.retryTimer = setTimeout(recheck, 30000); }
  }

  function enable(on) {
    state.enabled = on;
    button.hidden = !on;
    if (on) { if (!state.source) connect(); return; }
    disconnect();
    setOpen(false);
    state.messages = []; state.notifications = []; state.unread = { messages: 0, notifications: 0 };
    renderBadge();
  }

  // ---- composer ----
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  // Phone photos are large: shrink to at most 1600px and re-encode as JPEG so they fit the 1.5 MB limit.
  async function prepareImage(file) {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (allowed.includes(file.type) && file.size <= MAX_SEND && (file.type === 'image/gif' || file.size <= 400 * 1024)) return { type: file.type, blob: file };
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('That file is not a photo this phone can read.')); image.src = url; });
      let side = Math.min(MAX_SIDE, Math.max(img.naturalWidth, img.naturalHeight));
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const scale = side / Math.max(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82 - attempt * 0.1));
        if (blob && blob.size <= MAX_SEND) return { type: 'image/jpeg', blob };
        side = Math.round(side * 0.75);
      }
      throw new Error('That photo is too large to send.');
    } finally { URL.revokeObjectURL(url); }
  }
  function setChip(text) {
    chip.hidden = !text;
    chip.replaceChildren();
    if (!text) return;
    const remove = el('button', { type: 'button', className: 'icon' }, ['✕']);
    remove.setAttribute('aria-label', 'Remove photo');
    remove.addEventListener('click', () => { state.image = null; fileInput.value = ''; setChip(''); });
    chip.append(el('span', { textContent: text }), remove);
  }
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    state.image = null;
    if (!file) { setChip(''); return; }
    setChip('Preparing photo…');
    try {
      const ready = await prepareImage(file);
      state.image = { type: ready.type, data: await blobToBase64(ready.blob) };
      setChip(`📎 ${file.name || 'Photo'} · ${Math.ceil(ready.blob.size / 1024)} KB`);
    } catch (error) { fileInput.value = ''; setChip(''); notice.hidden = false; notice.textContent = error.message; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text && !state.image) return;
    sendButton.disabled = true;
    try {
      await call('POST', '/chat/messages', { text, image: state.image || undefined });
      input.value = ''; input.style.height = '';
      state.image = null; fileInput.value = ''; setChip('');
      state.status = 'open';
      await refresh();
    } catch (error) { notice.hidden = false; notice.textContent = error.message || 'Could not send.'; }
    finally { sendButton.disabled = false; }
  });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${Math.min(120, input.scrollHeight)}px`; });

  attach.addEventListener('click', () => fileInput.click());
  button.addEventListener('click', () => setOpen(true));
  banner.addEventListener('click', () => { banner.hidden = true; setOpen(true); });
  back.addEventListener('click', () => setOpen(false));
  tabChat.addEventListener('click', () => { state.tab = 'chat'; render(); refresh(); });
  tabNotes.addEventListener('click', () => { state.tab = 'notes'; render(); refresh(); });
  alerts.addEventListener('click', async () => { try { await Notification.requestPermission(); } catch { /* blocked */ } render(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.enabled) return;
    if (!state.source) connect();
    if (state.open) refresh();
  });

  window.addEventListener('still:ready', event => {
    state.token = event.detail?.creds?.token || '';
    enable(Boolean(event.detail?.chat));
  });
  window.addEventListener('still:signed-out', () => enable(false));

  function mount() {
    const menu = document.getElementById('menu');
    if (menu && !button.isConnected) menu.parentElement.insertBefore(button, menu);
    if (!sheet.isConnected) document.body.append(banner, sheet);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
