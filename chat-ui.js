(() => {
  'use strict';
  const api = window.desktopChat;
  if (!api) return;

  const MAX_IMAGE = 1.5 * 1024 * 1024;
  const state = { open: false, tab: 'messages', signedIn: false, status: 'open', messages: [], notifications: [], unread: { messages: 0, notifications: 0 }, image: null };

  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...[].concat(children));
    return node;
  };
  const when = value => { const d = new Date(String(value).replace(' ', 'T') + 'Z'); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };

  const badge = el('span', { className: 'chat-badge', hidden: true });
  const button = el('button', { type: 'button', id: 'chat-button', className: 'icon-button', title: 'Messages & notifications', hidden: true }, ['💬', badge]);
  button.setAttribute('aria-label', 'Messages and notifications');
  button.setAttribute('aria-haspopup', 'dialog');

  const tabMessages = el('button', { type: 'button', className: 'chat-tab' }, ['Chat with admin']);
  const tabNotes = el('button', { type: 'button', className: 'chat-tab' }, ['Notifications']);
  const noteDot = el('span', { className: 'chat-badge inline', hidden: true });
  tabNotes.append(noteDot);
  const closeButton = el('button', { type: 'button', className: 'icon-button', title: 'Close' }, ['✕']);
  closeButton.setAttribute('aria-label', 'Close messages');
  const list = el('div', { className: 'chat-list', tabIndex: 0 });
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');
  const notice = el('p', { className: 'chat-notice', hidden: true });
  const input = el('textarea', { rows: 2, maxLength: 2000, placeholder: 'Write a message…' });
  input.setAttribute('aria-label', 'Message');
  const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
  const attach = el('button', { type: 'button', className: 'icon-button', title: 'Attach a small image (up to 1.5 MB)' }, ['📎']);
  attach.setAttribute('aria-label', 'Attach image');
  const chip = el('div', { className: 'chat-chip', hidden: true });
  const sendButton = el('button', { type: 'submit', className: 'primary' }, ['Send']);
  const form = el('form', { className: 'chat-form' }, [chip, el('div', { className: 'chat-compose' }, [attach, input, sendButton]), fileInput]);
  const panel = el('section', { id: 'chat-panel', hidden: true }, [
    el('header', {}, [el('div', { className: 'chat-tabs' }, [tabMessages, tabNotes]), closeButton]), notice, list, form
  ]);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Messages and notifications');

  function renderBadge() {
    const total = state.unread.messages + state.unread.notifications;
    badge.hidden = total === 0;
    badge.textContent = total > 99 ? '99+' : String(total);
    noteDot.hidden = state.unread.notifications === 0;
    noteDot.textContent = String(state.unread.notifications);
  }

  async function showImage(message, target) {
    try { target.src = await api.image(message.id); } catch { target.replaceWith(el('em', {}, ['Image unavailable'])); }
  }

  function renderMessages() {
    list.replaceChildren();
    if (!state.messages.length) list.append(el('p', { className: 'muted chat-empty' }, ['No messages yet. Say hello to the admin.']));
    let lastMine = null;
    for (const message of state.messages) if (message.sender === 'user') lastMine = message;
    for (const message of state.messages) {
      const mine = message.sender === 'user';
      const bubble = el('div', { className: `chat-bubble ${mine ? 'mine' : 'theirs'}` });
      if (message.hasImage) {
        const img = el('img', { alt: 'Attached image', className: 'chat-image' });
        bubble.append(img);
        showImage(message, img);
      }
      if (message.body) bubble.append(el('p', {}, [message.body]));
      const meta = [when(message.createdAt)];
      if (mine && message === lastMine && message.readAt) meta.push('Seen');
      bubble.append(el('small', {}, [meta.filter(Boolean).join(' · ')]));
      list.append(bubble);
    }
    list.scrollTop = list.scrollHeight;
    const closed = state.status === 'closed';
    notice.hidden = !closed;
    notice.textContent = closed ? 'This conversation was closed by the admin. Send a message to reopen it.' : '';
  }

  function renderNotifications() {
    list.replaceChildren();
    if (!state.notifications.length) list.append(el('p', { className: 'muted chat-empty' }, ['No notifications.']));
    for (const note of state.notifications) {
      list.append(el('article', { className: `chat-note${note.readAt ? '' : ' unread'}` }, [
        el('strong', {}, [note.title]), note.body ? el('p', {}, [note.body]) : '', el('small', {}, [when(note.createdAt)])
      ]));
    }
    notice.hidden = true;
  }

  function render() {
    tabMessages.classList.toggle('active', state.tab === 'messages');
    tabNotes.classList.toggle('active', state.tab === 'notifications');
    form.hidden = state.tab !== 'messages';
    if (state.tab === 'messages') renderMessages(); else renderNotifications();
    renderBadge();
  }

  async function loadMessages() {
    const result = await api.messages();
    if (!result || result.error) return;
    state.messages = result.messages || [];
    state.status = result.conversation?.status || 'open';
    if (result.unread) state.unread = result.unread;
  }
  async function loadNotifications() {
    const result = await api.notifications();
    if (!result || result.error) return;
    state.notifications = result.notifications || [];
    if (result.unread) state.unread = result.unread;
  }

  async function refresh() {
    try {
      if (state.tab === 'messages') {
        await loadMessages();
        if (state.open && state.unread.messages) { await api.markRead(); state.unread.messages = 0; }
      } else {
        await loadNotifications();
        const unseen = state.notifications.filter(note => !note.readAt).map(note => note.id);
        if (state.open && unseen.length) { await api.readNotifications(unseen); state.unread.notifications = 0; setTimeout(() => state.notifications.forEach(note => { note.readAt = note.readAt || 'now'; }), 4000); }
      }
    } catch { /* offline: keep what is shown */ }
    render();
  }

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) refresh(); else button.focus();
  }

  function setAttachment(file) {
    state.image = null;
    chip.hidden = !file;
    chip.replaceChildren();
    if (!file) return;
    chip.append(el('span', {}, [`📎 ${file.name} (${Math.ceil(file.size / 1024)} KB)`]));
    const remove = el('button', { type: 'button', className: 'icon-button', title: 'Remove image' }, ['✕']);
    remove.addEventListener('click', () => { fileInput.value = ''; setAttachment(null); });
    chip.append(remove);
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return setAttachment(null);
    if (file.size > MAX_IMAGE) { notice.hidden = false; notice.textContent = 'That image is larger than 1.5 MB.'; fileInput.value = ''; return setAttachment(null); }
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    state.image = { type: file.type, data: btoa(binary) };
    setAttachment(file);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text && !state.image) return;
    sendButton.disabled = true;
    try {
      const result = await api.send(text, state.image || undefined);
      if (result?.error) throw new Error(result.error);
      input.value = '';
      fileInput.value = '';
      setAttachment(null);
      state.status = 'open';
      await loadMessages();
      render();
    } catch (error) {
      notice.hidden = false;
      notice.textContent = error.message || 'Could not send the message.';
    } finally { sendButton.disabled = false; input.focus(); }
  });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
  attach.addEventListener('click', () => fileInput.click());
  button.addEventListener('click', () => setOpen(!state.open));
  closeButton.addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') setOpen(false); });
  tabMessages.addEventListener('click', () => { state.tab = 'messages'; render(); refresh(); });
  tabNotes.addEventListener('click', () => { state.tab = 'notifications'; render(); refresh(); });

  api.onEvent(event => {
    if (event.type === 'unread') { state.unread = event.unread || state.unread; renderBadge(); if (state.open) refresh(); return; }
    if (event.type === 'status') { state.status = event.status; }
    // Badge counts arrive as separate 'unread' events from the server, so nothing is counted here.
    if (state.open) refresh();
  });

  function placeButton() {
    const anchor = document.getElementById('account-menu-button');
    if (!anchor || !anchor.parentElement) return;
    if (button.parentElement !== anchor.parentElement) anchor.parentElement.insertBefore(button, anchor);
    if (!panel.isConnected) document.body.append(panel);
    button.hidden = !state.signedIn;
    if (!state.signedIn) { setOpen(false); state.messages = []; state.notifications = []; state.unread = { messages: 0, notifications: 0 }; renderBadge(); }
  }

  async function sync() {
    try { state.signedIn = !!(await window.desktopAuth.status()).signedIn; } catch { state.signedIn = false; }
    placeButton();
    if (state.signedIn) { try { state.unread = (await api.status()).unread; renderBadge(); } catch { /* ignore */ } }
  }
  window.addEventListener('still:permissions', sync);
  document.addEventListener('DOMContentLoaded', sync);
  if (document.readyState !== 'loading') sync();
  render();
})();
