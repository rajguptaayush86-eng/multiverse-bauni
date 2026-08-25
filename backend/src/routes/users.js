const db = require('../db');

module.exports = async function (fastify, opts) {
  // Search users by id, email, or display name.
  // Query: /users/search?q=... (requires Authorization header)
  fastify.get('/search', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const q = (req.query.q || '').trim();
    if (!q) return reply.status(400).send({ error: 'query required' });

    // If looks like a UUID, try exact id match first
    const maybeId = q.match(/^[0-9a-fA-F-]{3,}$/) ? q : null;
    try {
      if (maybeId) {
        const r = await db.query('SELECT id, display_name, email FROM users WHERE id = $1 LIMIT 1', [maybeId]);
        if (r.rows.length) return r.rows[0];
      }

      // General search: ILIKE on email and display_name
      const pattern = '%' + q.replace(/%/g, '') + '%';
      const res = await db.query(
        `SELECT id, display_name, email FROM users
         WHERE email ILIKE $1 OR display_name ILIKE $1
         ORDER BY display_name NULLS LAST LIMIT 20`,
        [pattern]
      );
      return res.rows;
    } catch (err) {
      fastify.log.error('users.search error', err);
      return reply.status(500).send({ error: 'server_error' });
    }
  });
};
