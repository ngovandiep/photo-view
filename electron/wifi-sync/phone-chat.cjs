'use strict';

const HEARTBEAT_MS = 25000;
const MAX_STREAMS_PER_DEVICE = 3;
const SEND_LIMIT = 3 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Relays the desktop's account chat to paired phones signed in to the same account.
// The desktop holds the account session; phones never see the account token.
function createPhoneChat({ chat, heartbeatMs = HEARTBEAT_MS }) {
  const streams = new Map();

  // Only the fields a phone needs; message bodies are fetched through the authenticated thread route.
  const forPhone = event => ({
    type: event.type,
    ...(event.id != null ? { id: event.id } : {}),
    ...(event.sender ? { sender: event.sender } : {}),
    ...(event.preview != null ? { preview: String(event.preview).slice(0, 200) } : {}),
    ...(event.title ? { title: String(event.title).slice(0, 120) } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.unread ? { unread: event.unread } : {})
  });

  function upstream(error, HttpError) {
    if (error instanceof HttpError) return error;
    if (error && error.network) return new HttpError(503, 'chat_offline', 'The account server is not reachable from the computer.');
    const status = Number(error && error.status);
    if (status === 401 || status === 403) return new HttpError(409, 'chat_unavailable', 'Sign in on the computer to use chat.');
    if (status === 400 || status === 404 || status === 413) return new HttpError(status, 'chat_rejected', error.message || 'Request rejected.');
    return new HttpError(502, 'chat_failed', (error && error.message) || 'Chat request failed.');
  }

  function openStream({ req, res, device, isActive, stillSignedIn }) {
    const own = streams.get(device.id) || new Set();
    streams.set(device.id, own);
    while (own.size >= MAX_STREAMS_PER_DEVICE) { const oldest = own.values().next().value; oldest.end(); }

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
    let closed = false;
    const write = payload => { if (!closed) res.write(`data: ${JSON.stringify(payload)}\n\n`); };
    const entry = {
      end() {
        if (closed) return;
        closed = true;
        clearInterval(timer); off(); own.delete(entry);
        if (!own.size) streams.delete(device.id);
        res.end();
      }
    };
    own.add(entry);
    const off = chat.onEvent(event => {
      // The computer switched or signed out of its account: drop the stream so the phone re-checks its sign-in.
      if (event.type === 'session') { entry.end(); return; }
      write(forPhone(event));
    });
    const timer = setInterval(async () => {
      let ok = false;
      try { ok = isActive() && await stillSignedIn(); } catch { ok = false; }
      if (!ok) entry.end(); else if (!closed) res.write(': ping\n\n');
    }, heartbeatMs);
    if (timer.unref) timer.unref();
    req.on('close', () => entry.end());
    write({ type: 'unread', unread: chat.status().unread });
  }

  async function handle({ req, res, route, url, device, send, readJson, HttpError, isActive = () => true, stillSignedIn = async () => true }) {
    const method = req.method;
    try {
      if (route === '/chat/stream' && method === 'GET') { openStream({ req, res, device, isActive, stillSignedIn }); return true; }
      if (route === '/chat/status' && method === 'GET') { send(res, 200, chat.status()); return true; }
      if (route === '/chat/messages' && method === 'GET') { send(res, 200, await chat.messages(Number(url.searchParams.get('after')) || 0)); return true; }
      if (route === '/chat/messages' && method === 'POST') {
        const body = await readJson(req, SEND_LIMIT);
        const image = body.image && typeof body.image === 'object' ? { type: String(body.image.type || ''), data: String(body.image.data || '') } : undefined;
        if (image && !IMAGE_TYPES.has(image.type)) throw new HttpError(400, 'invalid_image', 'Only PNG, JPEG, GIF or WebP images can be sent.');
        send(res, 201, await chat.send(String(body.text || '').slice(0, 2000), image));
        return true;
      }
      if (route === '/chat/read' && method === 'POST') { send(res, 200, await chat.markRead()); return true; }
      if (route === '/chat/notifications' && method === 'GET') { send(res, 200, await chat.notifications()); return true; }
      if (route === '/chat/notifications/read' && method === 'POST') {
        const body = await readJson(req);
        send(res, 200, await chat.readNotifications(Array.isArray(body.ids) ? body.ids : undefined));
        return true;
      }
      const match = route.match(/^\/chat\/images\/(\d{1,12})$/);
      if (match && method === 'GET') {
        const image = await chat.image(Number(match[1]));
        if (!IMAGE_TYPES.has(image.type)) throw new HttpError(404, 'not_found', 'Image not found.');
        send(res, 200, Buffer.from(image.data, 'base64'), { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': 'inline' });
        return true;
      }
    } catch (error) {
      throw upstream(error, HttpError);
    }
    throw new HttpError(404, 'not_found', 'Unknown chat endpoint.');
  }

  const closeDevice = deviceId => { for (const entry of [...(streams.get(deviceId) || [])]) entry.end(); };
  const closeAll = () => { for (const own of [...streams.values()]) for (const entry of [...own]) entry.end(); };
  return { handle, closeAll, closeDevice, streamCount: () => [...streams.values()].reduce((sum, own) => sum + own.size, 0) };
}

module.exports = { createPhoneChat };
