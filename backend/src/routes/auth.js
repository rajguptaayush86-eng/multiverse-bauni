const bcrypt = require('bcrypt');
const db = require('../db');

module.exports = async function (fastify, opts) {
  fastify.post('/register', async (req, reply) => {
    const { email, password, displayName } = req.body || {};
    if (!email || !password) return reply.status(400).send({ error: 'email+password required' });
    const hash = await bcrypt.hash(password, 10);
    const res = await db.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id,email,display_name', [email, hash, displayName || null]);
    const user = res.rows[0];
    const token = fastify.jwt.sign({ userId: user.id, email: user.email });
    return { token, user: { id: user.id, email: user.email, displayName: user.display_name } };
  });

  fastify.post('/login', async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password) return reply.status(400).send({ error: 'email+password required' });
    const res = await db.query('SELECT id, email, password_hash, display_name FROM users WHERE email = $1', [email]);
    if (!res.rows.length) return reply.status(401).send({ error: 'invalid' });
    const u = res.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return reply.status(401).send({ error: 'invalid' });
    const token = fastify.jwt.sign({ userId: u.id, email: u.email });
    return { token, user: { id: u.id, email: u.email, displayName: u.display_name } };
  });
};
