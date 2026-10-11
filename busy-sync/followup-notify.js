// followup-notify.js — Payment Follow-up daily messages (JCM HQ → Collections).
//
// Run by JCM Sync every 15 minutes. It only knocks on HQ's door; HQ decides
// what is due (api/collections.js, action 'daily-run'):
//   after 10:00 India time — one Task Board task + one WhatsApp per person with
//                            their follow-ups for the day (once a day)
//   after 19:00            — the evening summary WhatsApp to admins (once a day)
// The times live in collection_settings (morning_at / evening_at) in the
// JCM-Busysql project. HQ checks the key sent is that project's service key.
//
// Lives in D:\JCM-Supabase\files beside the other scripts; uses the same .env
// (SUPABASE_SERVICE_KEY). Optional: FOLLOWUP_HQ_URL (default https://hq.jcmretails.com).
//   node followup-notify.js      normal run (what JCM Sync does)
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const HQ_URL = (process.env.FOLLOWUP_HQ_URL || 'https://hq.jcmretails.com').replace(/\/+$/, '');
const LOG_FILE = path.join(__dirname, 'followup-notify.log');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* never stop for the log */ }
}

(async () => {
  if (!process.env.SUPABASE_SERVICE_KEY) { log('SUPABASE_SERVICE_KEY missing in .env'); process.exit(1); }
  if (typeof fetch !== 'function') { log('Needs Node.js 18 or newer'); process.exit(1); }
  try {
    const res = await fetch(`${HQ_URL}/api/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
      body: JSON.stringify({ action: 'daily-run' }),
      signal: AbortSignal.timeout(240000),
    });
    const text = (await res.text()).slice(0, 1500);
    log(`HQ ${res.status}: ${text}`);
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    log(`HQ call failed (will try again next run): ${err.message || err}`);
    process.exit(1);
  }
})();
