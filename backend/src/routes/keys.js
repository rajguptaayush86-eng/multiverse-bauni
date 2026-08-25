const db = require('../db');

module.exports = async function (fastify, opts) {
  fastify.post('/register-device', async (req, reply) => {
    try {
      const token = (req.headers.authorization || '').split(' ')[1];
      const payload = fastify.jwt.verify(token);
      const userId = payload.userId;
      const { deviceId, identityKey, signedPrekey, signedPrekeySig, registrationId, oneTimePrekeys } = req.body;
      if (!deviceId || !identityKey || !signedPrekey || !signedPrekeySig) return reply.status(400).send({ error: 'missing fields' });
      const upsert = await db.query(`
        INSERT INTO devices (user_id, device_id, identity_key, signed_prekey, signed_prekey_sig, registration_id)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (user_id, device_id) DO UPDATE
          SET identity_key = EXCLUDED.identity_key,
              signed_prekey = EXCLUDED.signed_prekey,
              signed_prekey_sig = EXCLUDED.signed_prekey_sig,
              registration_id = EXCLUDED.registration_id,
              last_seen = now()
        RETURNING id
      `, [userId, deviceId, identityKey, signedPrekey, signedPrekeySig, registrationId || 0]);
      const devId = upsert.rows[0].id;
      if (Array.isArray(oneTimePrekeys)) {
        for (const pk of oneTimePrekeys) {
          await db.query('INSERT INTO one_time_prekeys (device_id, prekey_id, public_key) VALUES ($1,$2,$3)', [devId, pk.id, pk.publicKey]);
        }
      }
      return { ok: true, deviceId: devId };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(401).send({ error: 'unauthorized' });
    }
  });

  fastify.get('/bundle/:userId/:deviceId', async (req, reply) => {
    const { userId, deviceId } = req.params;
    const q = await db.query('SELECT id, identity_key, signed_prekey, signed_prekey_sig, registration_id FROM devices WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
    if (!q.rows.length) return reply.status(404).send({ error: 'not found' });
    const dev = q.rows[0];
    const otpQ = await db.query('SELECT id, prekey_id, public_key FROM one_time_prekeys WHERE device_id = $1 AND consumed = false LIMIT 1', [dev.id]);
    let otp = null;
    if (otpQ.rows.length) {
      otp = otpQ.rows[0];
      await db.query('UPDATE one_time_prekeys SET consumed = true WHERE id = $1', [otp.id]);
    }
    return {
      identityKey: dev.identity_key,
      signedPrekey: dev.signed_prekey,
      signedPrekeySig: dev.signed_prekey_sig,
      registrationId: dev.registration_id,
      oneTimePrekey: otp ? { id: otp.prekey_id, publicKey: otp.public_key } : null
    };
  });

  fastify.get('/devices/:userId', async (req, reply) => {
    const { userId } = req.params;
    const res = await db.query('SELECT device_id, identity_key, created_at FROM devices WHERE user_id = $1', [userId]);
    return res.rows;
  });
};
