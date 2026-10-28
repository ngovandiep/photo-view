'use strict';
const { EventEmitter } = require('node:events');

const MAX_TEXT = 2000;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_TITLE = 120;
const IMAGE_TYPES = {
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8,
  'image/png': bytes => bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': bytes => bytes.subarray(0, 3).toString('latin1') === 'GIF',
  'image/webp': bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
};

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (value, max) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '');

// Chat and notifications for the account server. The hub carries small "something changed" events to live listeners.
function createChat(db) {
  const hub = new EventEmitter();
  hub.setMaxListeners(0);

  function parseImage(image) {
    if (image == null) return null;
    if (typeof image !== 'object' || typeof image.type !== 'string' || typeof image.data !== 'string') throw fail('Invalid image.');
    const check = IMAGE_TYPES[image.type];
    if (!check) throw fail('Images must be JPEG, PNG, GIF or WebP.');
    if (image.data.length > MAX_IMAGE_BYTES * 1.4) throw fail('Image is too large (limit 1.5 MB).', 413);
    const bytes = Buffer.from(image.data, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw fail('Image is too large (limit 1.5 MB).', 413);
    if (!check(bytes)) throw fail('The file is not a valid image.');
    return { type: image.type, bytes };
  }

  const shape = row => ({
    id: row.id, conversationId: row.conversation_id, sender: row.sender, body: row.body,
    hasImage: !!row.image_type, imageType: row.image_type || null, createdAt: row.created_at, readAt: row.read_at || null
  });
  const MESSAGE_COLUMNS = 'id, conversation_id, sender, body, image_type, created_at, read_at';

  function conversationFor(userId, create = true) {
    let row = db.prepare('SELECT * FROM conversations WHERE user_id = ?').get(userId);
    if (!row && create) {
      const id = Number(db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(userId).lastInsertRowid);
      row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    }
    return row || null;
  }

  function post(userId, sender, { body, image } = {}) {
    const text = clean(body, MAX_TEXT);
    const picture = parseImage(image);
    if (!text && !picture) throw fail('Write a message or attach an image.');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw fail('User not found.', 404);
    const conversation = conversationFor(userId);
    const id = Number(db.prepare('INSERT INTO messages (conversation_id, sender, body, image_type, image_data) VALUES (?, ?, ?, ?, ?)')
      .run(conversation.id, sender, text, picture ? picture.type : null, picture ? picture.bytes : null).lastInsertRowid);
    // A new message from either side reopens an archived conversation.
    db.prepare("UPDATE conversations SET status = 'open', last_message_at = datetime('now') WHERE id = ?").run(conversation.id);
    const message = shape(db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(id));
    const preview = text ? text.slice(0, 120) : 'Sent an image';
    // Every device of the user hears about the message (their own sends too) so all screens stay in sync.
    hub.emit('user', userId, { type: 'message', id, sender, preview });
    if (sender === 'admin') syncUnread(userId);
    else hub.emit('admin', { type: 'message', userId, id, preview });
    return message;
  }

  function thread(userId, { after = 0, limit = 200 } = {}) {
    const conversation = conversationFor(userId, false);
    if (!conversation) return { conversation: null, messages: [] };
    const rows = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .all(conversation.id, Math.max(0, Number(after) || 0), Math.min(500, Math.max(1, Number(limit) || 200)));
    return { conversation: { id: conversation.id, status: conversation.status }, messages: rows.map(shape) };
  }

  // Marks the other side's messages as read; the sender sees "Seen".
  function markRead(userId, reader) {
    const conversation = conversationFor(userId, false);
    if (!conversation) return { marked: 0 };
    const from = reader === 'admin' ? 'user' : 'admin';
    const result = db.prepare("UPDATE messages SET read_at = datetime('now') WHERE conversation_id = ? AND sender = ? AND read_at IS NULL").run(conversation.id, from);
    if (result.changes) {
      if (reader === 'admin') hub.emit('user', userId, { type: 'read' });
      else { hub.emit('admin', { type: 'read', userId }); syncUnread(userId); }
    }
    return { marked: Number(result.changes) };
  }

  function image(messageId, userId) {
    const row = db.prepare('SELECT m.image_type, m.image_data, c.user_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND m.image_data IS NOT NULL').get(Number(messageId));
    if (!row || (userId != null && row.user_id !== userId)) throw fail('Image not found.', 404);
    return { type: row.image_type, data: Buffer.from(row.image_data).toString('base64') };
  }

  const unreadForUser = userId => {
    const messages = Number(db.prepare("SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? AND m.sender = 'admin' AND m.read_at IS NULL").get(userId).n);
    const notifications = Number(db.prepare('SELECT COUNT(*) AS n FROM notification_recipients WHERE user_id = ? AND read_at IS NULL').get(userId).n);
    return { messages, notifications };
  };

  // Authoritative counts: reading on one device clears the badge on the others.
  const syncUnread = userId => hub.emit('user', userId, { type: 'unread', unread: unreadForUser(userId) });

  function conversations({ status } = {}) {
    const rows = db.prepare(`
      SELECT c.id, c.user_id, c.status, c.last_message_at, u.email, u.display_name, u.disabled_at,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender = 'user' AND m.read_at IS NULL) AS unread,
        (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body,
        (SELECT image_type FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_image,
        (SELECT sender FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_sender
      FROM conversations c JOIN users u ON u.id = c.user_id
      WHERE (? IS NULL OR c.status = ?) AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
      ORDER BY c.last_message_at DESC, c.id DESC LIMIT 500`).all(status || null, status || null);
    return rows.map(row => ({
      id: row.id, userId: row.user_id, status: row.status, email: row.email, displayName: row.display_name, disabled: !!row.disabled_at,
      unread: Number(row.unread), lastAt: row.last_message_at, lastSender: row.last_sender,
      preview: row.last_body ? row.last_body.slice(0, 120) : row.last_image ? 'Image' : ''
    }));
  }
  const unreadForAdmin = () => Number(db.prepare("SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.sender = 'user' AND m.read_at IS NULL AND c.status = 'open'").get().n);

  function setStatus(userId, status) {
    if (!['open', 'closed'].includes(status)) throw fail('Status must be open or closed.');
    const conversation = conversationFor(userId, false);
    if (!conversation) throw fail('Conversation not found.', 404);
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, conversation.id);
    hub.emit('user', userId, { type: 'status', status });
    return { userId, status };
  }

  // Sends a notice to everyone with an active account, or to the chosen users only.
  function notify({ title, body, userIds }) {
    const heading = clean(title, MAX_TITLE);
    const text = clean(body, MAX_TEXT);
    if (!heading) throw fail('A title is required.');
    const audience = Array.isArray(userIds) ? 'selected' : 'all';
    let targets;
    if (audience === 'selected') {
      const wanted = [...new Set(userIds.map(Number).filter(Number.isInteger))].slice(0, 5000);
      if (!wanted.length) throw fail('Choose at least one user.');
      targets = wanted.filter(id => db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
    } else {
      targets = db.prepare('SELECT id FROM users WHERE disabled_at IS NULL').all().map(row => Number(row.id));
    }
    if (!targets.length) throw fail('There is nobody to notify.');
    const id = Number(db.prepare('INSERT INTO notifications (title, body, audience, recipient_count) VALUES (?, ?, ?, ?)').run(heading, text, audience, targets.length).lastInsertRowid);
    const add = db.prepare('INSERT INTO notification_recipients (notification_id, user_id) VALUES (?, ?)');
    db.exec('BEGIN');
    try { for (const userId of targets) add.run(id, userId); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    for (const userId of targets) { hub.emit('user', userId, { type: 'notification', id, title: heading, preview: text.slice(0, 120) }); syncUnread(userId); }
    return { id, audience, recipients: targets.length };
  }

  function notificationsFor(userId, limit = 50) {
    return db.prepare(`SELECT n.id, n.title, n.body, n.created_at, r.read_at FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
      WHERE r.user_id = ? ORDER BY n.id DESC LIMIT ?`).all(userId, Math.min(100, Math.max(1, Number(limit) || 50)))
      .map(row => ({ id: row.id, title: row.title, body: row.body, createdAt: row.created_at, readAt: row.read_at || null }));
  }
  function readNotifications(userId, ids) {
    const result = Array.isArray(ids)
      ? db.prepare(`UPDATE notification_recipients SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL AND notification_id IN (${ids.slice(0, 200).map(() => '?').join(',') || 'NULL'})`).run(userId, ...ids.slice(0, 200).map(Number))
      : db.prepare("UPDATE notification_recipients SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(userId);
    if (result.changes) syncUnread(userId);
    return { marked: Number(result.changes) };
  }
  function sentNotifications(limit = 50) {
    return db.prepare(`SELECT n.id, n.title, n.body, n.audience, n.recipient_count, n.created_at,
      (SELECT COUNT(*) FROM notification_recipients r WHERE r.notification_id = n.id AND r.read_at IS NOT NULL) AS read_count
      FROM notifications n ORDER BY n.id DESC LIMIT ?`).all(Math.min(200, Math.max(1, Number(limit) || 50)))
      .map(row => ({ id: row.id, title: row.title, body: row.body, audience: row.audience, recipients: row.recipient_count, readCount: Number(row.read_count), createdAt: row.created_at }));
  }

  // History is auto-deleted after the retention window; empty conversations are removed with it.
  function purge(days = 90) {
    const cutoff = `-${Math.max(1, Math.floor(days))} days`;
    const messages = Number(db.prepare("DELETE FROM messages WHERE created_at < datetime('now', ?)").run(cutoff).changes);
    db.prepare('DELETE FROM conversations WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)').run();
    const notifications = Number(db.prepare("DELETE FROM notifications WHERE created_at < datetime('now', ?)").run(cutoff).changes);
    return { messages, notifications };
  }

  return { hub, post, thread, markRead, image, unreadForUser, conversations, unreadForAdmin, setStatus, notify, notificationsFor, readNotifications, sentNotifications, purge, MAX_IMAGE_BYTES };
}

module.exports = { createChat, MAX_TEXT, MAX_IMAGE_BYTES };
