// Periodic job to clear expired messages (run via cron or systemd timer)
require('dotenv').config();
const db = require('../db');

async function expire() {
  try {
    const res = await db.query('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING id');
    console.log('Expired messages removed:', res.rowCount);
    process.exit(0);
  } catch (err) {
    console.error('Expire job error', err);
    process.exit(1);
  }
}

expire();
