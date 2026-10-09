import { db, must } from '../lib/db.js'
import { send, fail, findAdmin } from '../lib/auth.js'
import { englishKey, hasDevanagari, transliterate, readLabelLanguage } from '../lib/hindi.js'
import { withTiming } from '../lib/timing.js'

// Admin only — /admin → Hindi names, and the label language.
//   GET  /api/admin/hindi                          → { language, rows, missing, ready }
//        rows: every stored spelling (needs review first); missing: party names and
//        cities on recent orders with no Hindi yet
//   POST { op: 'language', language: 'en' | 'en_hi' }   label language (default en_hi)
//   POST { op: 'save', key, hindi }                a corrected spelling (checked from then on)
//   POST { op: 'accept', key }                     "Looks right": the generated spelling is checked
//   POST { op: 'generate' }                        make the missing ones now (up to 40 at a time)
// Before supabase/phase10-label-hindi.sql is run: { ready: false } and nothing to edit.
const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {})
const RECENT_DAYS = 120
const GENERATE_AT_ONCE = 40

async function readRows(dbc) {
  const { data, error } = await dbc.from('party_hindi').select('english_key, kind, english, hindi, source, needs_review, updated_at')
  if (error) return null // no table yet
  return data.map(r => ({ key: r.english_key, kind: r.kind, english: r.english, hindi: r.hindi, source: r.source, needsReview: r.needs_review, updatedAt: r.updated_at }))
    .sort((a, b) => (b.needsReview ? 1 : 0) - (a.needsReview ? 1 : 0) || a.kind.localeCompare(b.kind) || a.english.localeCompare(b.english))
}

// Party names and cities on open orders and on orders of the last 120 days, with no Hindi yet.
async function readMissing(dbc, rows) {
  const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10)
  const [open, recent] = await Promise.all([
    must(dbc.from('orders').select('party_name, party_city').is('closed_at', null), 'reading open orders'),
    must(dbc.from('orders').select('party_name, party_city').gte('so_date', since), 'reading recent orders'),
  ])
  const have = new Set(rows.map(r => r.key))
  const out = new Map()
  for (const o of [...open, ...recent]) {
    for (const [kind, v] of [['name', o.party_name], ['city', o.party_city]]) {
      const k = englishKey(v)
      if (k && !have.has(k) && !out.has(k)) out.set(k, { key: k, kind, english: String(v).trim() })
    }
  }
  return [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.english.localeCompare(b.english))
}

async function handler(req, res) {
  try {
    const dbc = db()
    const admin = await findAdmin(dbc, req)
    if (!admin) return send(res, 401, { error: 'Please sign in again.' })
    const [language, rows] = await Promise.all([readLabelLanguage(dbc), readRows(dbc)])

    if (req.method === 'GET') {
      if (!rows) return send(res, 200, { language, ready: false, rows: [], missing: [] })
      return send(res, 200, { language, ready: true, rows, missing: await readMissing(dbc, rows) })
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
    const b = body(req)

    if (b.op === 'language') {
      if (b.language !== 'en' && b.language !== 'en_hi') return send(res, 400, { error: 'Choose English, or English + Hindi.' })
      await must(dbc.from('orders_config').upsert({ key: 'label_language', value: { language: b.language }, note: 'Carton label: en = English only, en_hi = English + Hindi', updated_at: new Date().toISOString() }, { onConflict: 'key' }), 'saving label language')
      return send(res, 200, { language: b.language })
    }
    if (!rows) return send(res, 503, { error: 'Hindi names are not set up yet: run supabase/phase10-label-hindi.sql in Supabase first.' })

    if (b.op === 'save') {
      const key = englishKey(b.key)
      const hindi = String(b.hindi || '').replace(/\s+/g, ' ').trim()
      if (!key) return send(res, 400, { error: 'Which name?' })
      if (!hindi || !hasDevanagari(hindi)) return send(res, 400, { error: 'Type the name in Hindi (Devanagari letters).' })
      if (hindi.length > 200) return send(res, 400, { error: 'That is too long for a label.' })
      const known = rows.find(r => r.key === key)
      const kind = known ? known.kind : b.kind === 'city' ? 'city' : 'name'
      const english = known ? known.english : String(b.english || b.key).trim()
      await must(dbc.from('party_hindi').upsert({ english_key: key, kind, english, hindi, source: 'manual', needs_review: false, updated_by: admin.id }, { onConflict: 'english_key' }), 'saving Hindi name')
      return send(res, 200, { key, hindi, needsReview: false })
    }
    if (b.op === 'accept') {
      const key = englishKey(b.key)
      const done = await must(dbc.from('party_hindi').update({ needs_review: false, updated_by: admin.id }).eq('english_key', key).select('english_key'), 'saving')
      if (!done.length) return send(res, 404, { error: 'That name was not found.' })
      return send(res, 200, { key, needsReview: false })
    }
    if (b.op === 'generate') {
      const missing = (await readMissing(dbc, rows)).slice(0, GENERATE_AT_ONCE)
      let made = 0, failed = 0
      for (let i = 0; i < missing.length; i += 5) { // five at a time: kind to the transliteration service
        await Promise.all(missing.slice(i, i + 5).map(async m => {
          const hindi = await transliterate(m.english)
          if (!hindi) { failed++; return }
          const { error } = await dbc.from('party_hindi').upsert({ english_key: m.key, kind: m.kind, english: m.english, hindi, source: 'google', needs_review: true }, { onConflict: 'english_key', ignoreDuplicates: true })
          if (error) failed++; else made++
        }))
      }
      const after = await readRows(dbc)
      return send(res, 200, { made, failed, rows: after, missing: await readMissing(dbc, after) })
    }
    send(res, 400, { error: 'Unknown request.' })
  } catch (err) {
    fail(res, err)
  }
}

export default withTiming('hindi', handler)
