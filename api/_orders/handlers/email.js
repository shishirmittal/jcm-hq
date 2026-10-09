import crypto from 'node:crypto'
import { db, must } from '../lib/db.js'
import { send, fail, findAdmin } from '../lib/auth.js'
import { materialOverview } from '../lib/material.js'
import { runDailyEmail, buildEmail, emailSettings } from '../lib/email.js'

// The 17:30 IST email. Vercel's scheduler calls GET /api/cron/daily-email
// (vercel.json "crons": 12:00 UTC = 17:30 IST) with "Authorization: Bearer
// <CRON_SECRET>". Without CRON_SECRET set in Vercel, scheduled runs are refused.
//
// Admins can also use it from /owner:
//   GET  ?preview=1   → the email as it would look now (nothing sent)
//   POST              → send it now
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export default async function handler(req, res) {
  try {
    const dbc = db()
    const auth = String(req.headers.authorization || '')
    const secret = process.env.CRON_SECRET
    const isCron = req.method === 'GET' && !!secret && sameSecret(auth, `Bearer ${secret}`)
    const preview = new URL(req.url || '/', 'http://x').searchParams.get('preview') === '1'

    if (isCron && !preview) {
      const r = await runDailyEmail(dbc)
      return send(res, 200, { status: r.status, detail: r.detail })
    }

    const admin = await findAdmin(dbc, req)
    if (!admin) return send(res, 401, { error: 'Not allowed.' })
    if (req.method === 'GET') {
      const s = emailSettings()
      const lastRuns = await must(dbc.from('orders_email_log').select('sent_at, recipient, status, detail').order('sent_at', { ascending: false }).range(0, 4), 'reading email log')
      return send(res, 200, { ...buildEmail(await materialOverview(dbc)), ready: s.ready, reason: s.reason, to: s.to, lastRuns })
    }
    if (req.method === 'POST') {
      const r = await runDailyEmail(dbc)
      return send(res, 200, { status: r.status, detail: r.detail })
    }
    send(res, 405, { error: 'Method not allowed' })
  } catch (err) {
    fail(res, err)
  }
}
