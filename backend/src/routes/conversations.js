const db = require('../db');

module.exports = async function (fastify, opts) {
  // Create or return existing 1:1 conversation
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const myId = (req.user && req.user.userId) || (req.user && req.user.user && req.user.user.id);
    const peerId = (req.body && req.body.peerUserId) ? String(req.body.peerUserId).trim() : null;
    if (!myId) return reply.status(401).send({ error: 'unauthorized' });
    if (!peerId) return reply.status(400).send({ error: 'peerUserId required' });
    if (peerId === myId) return reply.status(400).send({ error: 'cannot create conversation with self' });

    try {
      // Optional: check blocks table to avoid creating conversations if peer blocked caller
      const blocked = await db.query('SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2 LIMIT 1', [peerId, myId]);
      if (blocked.rowCount) return reply.status(403).send({ error: 'peer blocked you' });

      // Check for existing 1:1 conversation
      const existing = await db.query(
        `SELECT c.id
         FROM conversations c
         JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $1
         JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $2
         WHERE c.is_group = false
         LIMIT 1`, [myId, peerId]
      );
      if (existing.rows.length) return { conversationId: existing.rows[0].id };

      // Create new conversation + members inside a transaction
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        const r = await client.query('INSERT INTO conversations (is_group, created_by) VALUES ($1,$2) RETURNING id', [false, myId]);
        const convId = r.rows[0].id;
        await client.query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)', [convId, myId]);
        await client.query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)', [convId, peerId]);
        await client.query('COMMIT');
        return { conversationId: convId };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      fastify.log.error('conversations.create error', err);
      return reply.status(500).send({ error: 'server_error' });
    }
  });
};
