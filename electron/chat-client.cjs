'use strict';

// Main-process chat client: keeps a live SSE connection to the account server for the signed-in
// user, relays events to the renderer and to paired phones, raises OS notifications, and proxies chat requests.
function register({ ipcMain, auth, BrowserWindow, Notification, appName = () => 'MiLeo Photo Library' }) {
  let abort = null;
  let generation = 0;
  let unread = { messages: 0, notifications: 0 };
  const listeners = new Set();
  const publish = event => { for (const listener of listeners) { try { listener(event); } catch { /* a bad listener must not stop delivery */ } } };

  const broadcast = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };
  const focused = () => BrowserWindow.getAllWindows().some(win => !win.isDestroyed() && win.isFocused());

  function handle(event) {
    if (event.type === 'ready' || event.type === 'unread') {
      unread = event.unread || unread;
      broadcast('chat:event', { type: 'unread', unread });
      publish({ type: 'unread', unread });
      return;
    }
    broadcast('chat:event', event);
    publish(event);
    const incoming = (event.type === 'message' && event.sender === 'admin') || event.type === 'notification';
    if (incoming && Notification.isSupported() && !focused()) {
      new Notification({
        title: event.type === 'notification' ? (event.title || appName()) : 'Message from admin',
        body: String(event.preview || event.body || '').slice(0, 200)
      }).show();
    }
  }

  async function connect(token, gen) {
    let delay = 1000;
    while (gen === generation) {
      abort = new AbortController();
      try {
        const response = await fetch(auth.apiUrl() + '/chat/stream', {
          headers: { Authorization: ['Bearer', token].join(' ') },
          signal: abort.signal
        });
        if (response.status === 401 || response.status === 403) return;
        if (response.ok && response.body) {
          delay = 1000;
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let index;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const line = frame.split('\n').find(part => part.startsWith('data:'));
              if (!line) continue;
              try { handle(JSON.parse(line.slice(5).trim())); } catch { /* ignore malformed frame */ }
            }
          }
        }
      } catch { /* network drop: retry below */ }
      if (gen !== generation) return;
      await new Promise(resolve => setTimeout(resolve, delay).unref());
      delay = Math.min(delay * 2, 30000);
    }
  }

  auth.onToken(token => {
    generation += 1;
    if (abort) abort.abort();
    unread = { messages: 0, notifications: 0 };
    broadcast('chat:event', { type: 'unread', unread });
    // Phones signed in to the previous account must reconnect and re-check their sign-in.
    publish({ type: 'session' });
    if (token) connect(token, generation);
  });

  const call = (method, endpoint, body) => auth.request(method, endpoint, body);
  const api = {
    signedIn: () => Boolean(auth.token()),
    status: () => ({ unread }),
    messages: after => call('GET', `/chat/messages${Number(after) > 0 ? `?after=${Number(after)}` : ''}`),
    send: (text, image) => call('POST', '/chat/messages', {
      body: String(text || '').slice(0, 2000),
      image: image ? { type: String(image.type || ''), data: String(image.data || '') } : undefined
    }),
    markRead: () => call('POST', '/chat/read', {}),
    image: id => call('GET', `/chat/images/${encodeURIComponent(Number(id) || 0)}`),
    notifications: () => call('GET', '/chat/notifications'),
    readNotifications: ids => call('POST', '/chat/notifications/read', { ids: Array.isArray(ids) ? ids.slice(0, 200).map(Number) : undefined }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    close: () => { generation += 1; if (abort) abort.abort(); }
  };

  ipcMain.handle('chat:status', () => api.status());
  ipcMain.handle('chat:messages', (_e, after) => api.messages(after));
  ipcMain.handle('chat:send', (_e, payload) => api.send(payload?.text, payload?.image));
  ipcMain.handle('chat:read', () => api.markRead());
  ipcMain.handle('chat:image', async (_e, id) => {
    const image = await api.image(id);
    return `data:${image.type};base64,${image.data}`;
  });
  ipcMain.handle('chat:notifications', () => api.notifications());
  ipcMain.handle('chat:notifications-read', (_e, ids) => api.readNotifications(ids));
  return api;
}

module.exports = { register };
