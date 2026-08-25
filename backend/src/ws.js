const db = require('./db');
const { Buffer } = require('buffer');

const connections = new Map(); // userId -> Set of ws

function init(fastify) {
  fastify.get('/ws', { websocket: true }, (conn, req) => {
    let token = null;
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) token = authHeader.split(' ')[1];
    const urlToken = (req.query && req.query.t) || null;
    if (!token && urlToken) token = urlToken;
    try {
      const payload = fastify.jwt.verify(token);
      const userId = payload.userId;
      if (!connections.has(userId)) connections.set(userId, new Set());
      const set = connections.get(userId);
      set.add(conn.socket);
      conn.socket.userId = userId;
      conn.socket.isAlive = true;

      conn.socket.on('pong', () => conn.socket.isAlive = true);

      conn.socket.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (err) { return sendErr(conn.socket, 'invalid_json'); }
        await handleClientMessage(fastify, conn.socket, msg);
      });

      conn.socket.on('close', () => {
        set.delete(conn.socket);
        if (set.size === 0) connections.delete(userId);
      });

      // deliver pending messages
      deliverPendingMessagesToUser(fastify, userId).catch(err => fastify.log.error('deliver pending failed', err));
    } catch (err) {
      try { conn.socket.send(JSON.stringify({ type: 'error', error: 'unauthorized' })); } catch (_) {}
      conn.socket.close();
    }
  });

  setInterval(() => {
    for (const [userId, sockets] of connections.entries()) {
      for (const s of sockets) {
        if (!s.isAlive) { s.terminate(); sockets.delete(s); } else { s.isAlive = false; try { s.ping(); } catch (_) {} }
      }
      if (sockets.size === 0) connections.delete(userId);
    }
  }, 30000);
}

async function handleClientMessage(fastify, socket, msg) {
  const t = msg.type;
  if (t === 'send') {
    const { messageId, conversationId, ciphertext, envelope, expiresAt, senderDeviceId } = msg;
    if (!messageId || !conversationId || !ciphertext || !senderDeviceId) { return sendErr(socket, 'missing_fields'); }
    try {
      const memberQ = await db.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, socket.userId]);
      if (memberQ.rowCount === 0) return sendErr(socket, 'not_a_member');

      const exists = await db.query('SELECT id FROM messages WHERE message_id = $1 AND sender_user = $2 LIMIT 1', [messageId, socket.userId]);
      if (exists.rowCount) {
        sendJSON(socket, { type: 'ack', messageId, status: 'sent', note: 'already_exists' });
        return;
      }

      const cipherBuf = Buffer.from(ciphertext, 'base64');
      const res = await db.query(
        `INSERT INTO messages (conversation_id, sender_user, sender_device, message_id, ciphertext, envelope, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
         [conversationId, socket.userId, senderDeviceId, messageId, cipherBuf, envelope || {}, expiresAt || null]
      );

      sendJSON(socket, { type: 'ack', messageId, status: 'sent', serverId: res.rows[0].id });

      const members = await db.query('SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2', [conversationId, socket.userId]);
      for (const m of members.rows) {
        const uid = m.user_id;
        if (connections.has(uid)) {
          for (const s of connections.get(uid)) {
            sendJSON(s, {
              type: 'message',
              serverId: res.rows[0].id,
              conversationId,
              messageId,
              from: socket.userId,
              fromDevice: senderDeviceId,
              ciphertext,
              envelope,
              createdAt: res.rows[0].created_at,
              expiresAt: expiresAt || null
            });
          }
        }
      }
      await db.query('INSERT INTO notifications (channel, payload) VALUES ($1,$2)', ['message', { conversationId, messageId, serverMessageId: res.rows[0].id }]);
    } catch (err) {
      fastify.log.error('send err', err);
      sendErr(socket, 'server_error');
    }
  } else if (t === 'ack') {
    const { messageId, status } = msg;
    if (!messageId || !status) return sendErr(socket, 'missing_fields');
    try {
      const msgRow = await db.query('SELECT id, conversation_id FROM messages WHERE message_id = $1 LIMIT 1', [messageId]);
      if (!msgRow.rows.length) return sendErr(socket, 'unknown_message');
      const m = msgRow.rows[0];
      const memberQ = await db.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [m.conversation_id, socket.userId]);
      if (memberQ.rowCount === 0) return sendErr(socket, 'not_a_member');

      if (status === 'delivered') await db.query('UPDATE messages SET delivered = true WHERE id = $1', [m.id]);
      else if (status === 'seen') await db.query('UPDATE messages SET seen = true WHERE id = $1', [m.id]);

      const senderRows = await db.query('SELECT sender_user FROM messages WHERE id = $1', [m.id]);
      if (senderRows.rows.length) {
        const senderUser = senderRows.rows[0].sender_user;
        if (connections.has(senderUser)) {
          for (const s of connections.get(senderUser)) {
            sendJSON(s, { type: 'ack', messageId, status, by: socket.userId, at: new Date().toISOString() });
          }
        }
      }
    } catch (err) {
      fastify.log.error('ack err', err);
      sendErr(socket, 'server_error');
    }
  } else if (t === 'sync') {
    const { since, conversationId } = msg;
    try {
      if (conversationId) {
        const memberQ = await db.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, socket.userId]);
        if (memberQ.rowCount === 0) return sendErr(socket, 'not_a_member');
        const q = await db.query('SELECT message_id, ciphertext, envelope, created_at FROM messages WHERE conversation_id = $1 AND created_at > $2 ORDER BY created_at ASC', [conversationId, since || '1970-01-01T00:00:00Z']);
        for (const r of q.rows) {
          sendJSON(socket, { type: 'message', messageId: r.message_id, ciphertext: r.ciphertext.toString('base64'), envelope: r.envelope, createdAt: r.created_at });
        }
      } else {
        const convs = await db.query('SELECT conversation_id FROM conversation_members WHERE user_id = $1', [socket.userId]);
        for (const row of convs.rows) {
          const q = await db.query('SELECT message_id, ciphertext, envelope, created_at, conversation_id FROM messages WHERE conversation_id = $1 AND created_at > $2 ORDER BY created_at ASC', [row.conversation_id, since || '1970-01-01T00:00:00Z']);
          for (const r of q.rows) {
            sendJSON(socket, { type: 'message', messageId: r.message_id, ciphertext: r.ciphertext.toString('base64'), envelope: r.envelope, conversationId: r.conversation_id, createdAt: r.created_at });
          }
        }
      }
    } catch (err) {
      fastify.log.error('sync err', err);
      sendErr(socket, 'server_error');
    }
  } else if (t === 'typing') {
    try {
      const { conversationId, active } = msg;
      if (!conversationId) return;
      const memberQ = await db.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, socket.userId]);
      if (memberQ.rowCount === 0) return;
      const members = await db.query('SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2', [conversationId, socket.userId]);
      for (const m of members.rows) {
        if (connections.has(m.user_id)) {
          for (const s of connections.get(m.user_id)) {
            sendJSON(s, { type: 'typing', conversationId, from: socket.userId, active: !!active, at: new Date().toISOString() });
          }
        }
      }
    } catch (err) {}
  } else {
    sendErr(socket, 'unknown_type');
  }
}

function sendJSON(socket, obj) { try { socket.send(JSON.stringify(obj)); } catch (_) {} }
function sendErr(socket, code) { try { socket.send(JSON.stringify({ type: 'error', error: code })); } catch (_) {} }

async function deliverPendingMessagesToUser(fastify, userId) {
  const convs = await db.query('SELECT conversation_id FROM conversation_members WHERE user_id = $1', [userId]);
  for (const row of convs.rows) {
    const q = await db.query('SELECT id, message_id, ciphertext, envelope, conversation_id, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [row.conversation_id]);
    for (const r of q.rows) {
      if (connections.has(userId)) {
        for (const s of connections.get(userId)) {
          sendJSON(s, { type: 'message', serverId: r.id, conversationId: r.conversation_id, messageId: r.message_id, ciphertext: r.ciphertext.toString('base64'), envelope: r.envelope, createdAt: r.created_at });
        }
      }
    }
  }
}

module.exports = { init, connections };
