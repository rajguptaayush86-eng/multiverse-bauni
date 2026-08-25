require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const path = require('path');
const jwt = require('@fastify/jwt');
const fastifyStatic = require('fastify-static');
const db = require('./db');
const authRoutes = require('./routes/auth');
const keysRoutes = require('./routes/keys');
const ws = require('./ws');

fastify.register(jwt, { secret: process.env.JWT_SECRET || 'dev-secret' });
fastify.decorate('authenticate', async function (req, reply) {
  try { await req.jwtVerify(); } catch (err) { reply.send(err); }
});

fastify.register(fastifyStatic, { root: path.join(__dirname, 'public'), prefix: '/public/' });

fastify.register(authRoutes, { prefix: '/auth' });
fastify.register(keysRoutes, { prefix: '/keys' });

fastify.get('/health', async (req, reply) => {
  try { await db.query('SELECT 1'); return { ok: true }; } catch (err) { fastify.log.error(err); return reply.status(500).send({ ok: false }); }
});

const start = async () => {
  try {
    const addr = await fastify.listen({ port: Number(process.env.PORT || 4000), host: process.env.HOST || '0.0.0.0' });
    fastify.log.info('listening on ' + addr);
    ws.init(fastify);
  } catch (err) { fastify.log.error(err); process.exit(1); }
};

start();
