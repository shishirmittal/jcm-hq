// WhatsApp inbox (2026-10-12): everything that goes through our number, in one table.
//   wa_messages  one row per message — direction 'in' (customer / staff wrote or tapped) or 'out'
//                (HQ's automatic reply, or an admin typing on the Inbox page). Template sends stay in
//                wa_log; the thread view merges both by time.
//   Meta's status events (sent → delivered → read, or failed) update wa_log and wa_messages by meta_id.
// The Inbox never decides who a number belongs to for sending QR / ledger (Shishir's rule — the button
// payload does that). It only shows a name next to a number: the ledger name of the last template we
// sent there, else a customer whose mobile matches (shown as "maybe").
import { sendText, sendMedia, toWaNumber } from './_wa-cloud.js'

const WINDOW_H = 24

export async function recordIncoming(busy, value) {
  const rows = []
  const names = new Map((value?.contacts || []).map(c => [c.wa_id, c.profile?.name || null]))
  for (const m of value?.messages || []) {
    const t = m.type
    let text = null, payload = null, mediaId = null
    if (t === 'text') text = m.text?.body || ''
    else if (t === 'button') { text = m.button?.text || ''; payload = m.button?.payload || null }
    else if (t === 'interactive') { text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || ''; payload = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || null }
    else if (['image', 'document', 'audio', 'video', 'sticker'].includes(t)) { text = m[t]?.caption || m[t]?.filename || `[${t}]`; mediaId = m[t]?.id || null }
    else if (t === 'location') text = `[location] ${m.location?.latitude}, ${m.location?.longitude}`
    else if (t === 'reaction') text = `[reaction] ${m.reaction?.emoji || ''}`
    else text = `[${t}]`
    rows.push({
      number: m.from, direction: 'in', kind: t, text: String(text).slice(0, 4000), payload, media_id: mediaId, meta_id: m.id,
      profile_name: names.get(m.from) || null, status: 'received',
      created_at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
    })
  }
  if (!rows.length) return
  const r = await busy.from('wa_messages').upsert(rows, { onConflict: 'meta_id', ignoreDuplicates: true })
  if (r.error) console.error('wa_messages insert failed:', r.error.message)
}

export async function recordStatuses(busy, value) {
  for (const s of value?.statuses || []) {
    const patch = { status: s.status }
    const at = s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : new Date().toISOString()
    if (s.status === 'delivered') patch.delivered_at = at
    if (s.status === 'read') { patch.read_at = at; patch.delivered_at = patch.delivered_at || at }
    if (s.status === 'failed') patch.error = (s.errors || []).map(e => `${e.title || ''}${e.error_data?.details ? ` — ${e.error_data.details}` : ''}${e.code ? ` [${e.code}]` : ''}`).join('; ').slice(0, 400) || 'failed'
    // Never let a late "delivered" overwrite "read".
    const l = await busy.from('wa_log').update(patch).eq('meta_id', s.id).neq('status', 'read').select('id')
    if (l.error) console.error('wa_log status update failed:', l.error.message)
    const m = await busy.from('wa_messages').update(patch).eq('meta_id', s.id).neq('status', 'read').select('id')
    if (m.error) console.error('wa_messages status update failed:', m.error.message)
  }
}

// Our own replies (automatic from handleIncoming, or typed on the Inbox page).
export async function recordOutgoing(busy, { number, kind = 'text', text, metaId = null, by = 'HQ auto', filename = null, mediaId = null }) {
  const r = await busy.from('wa_messages').insert({ number: toWaNumber(number) || String(number), direction: 'out', kind, text: String(text || filename || '').slice(0, 4000), meta_id: metaId, media_id: mediaId, sent_by: by, status: metaId ? 'sent' : 'failed', created_at: new Date().toISOString() })
  if (r.error) console.error('wa_messages out insert failed:', r.error.message)
}

// Wrapped senders used by the reply code so the inbox shows what HQ answered.
export async function replyText(busy, to, text, by = 'HQ auto') {
  let id = null, err = null
  try { id = (await sendText(to, text))?.messages?.[0]?.id || null } catch (e) { err = e }
  await recordOutgoing(busy, { number: to, kind: 'text', text: err ? `${text}\n[not sent: ${err.message}]` : text, metaId: id, by })
  if (err) throw err
  return id
}
export async function replyMedia(busy, to, buffer, opts, by = 'HQ auto') {
  let id = null, mediaId = null, err = null
  try { const r = await sendMedia(to, buffer, opts); id = r?.messages?.[0]?.id || null; mediaId = r?.mediaId || null } catch (e) { err = e }
  // text starts with the file name so the Inbox download keeps it (e.g. JCM-Ledger-….pdf).
  await recordOutgoing(busy, { number: to, kind: opts.kind || 'document', text: `${opts.filename || (opts.kind === 'image' ? 'image.png' : 'file.pdf')}${opts.caption ? ` — ${opts.caption.replace(/\*/g, '').split('\n')[0]}` : ''}${err ? `\n[not sent: ${err.message}]` : ''}`, metaId: id, mediaId, by })
  if (err) throw err
  return id
}

// ---- Inbox page ------------------------------------------------------------
// Conversations: one per number, newest first, with unread (incoming, not yet seen) count.
export async function listConversations(busy, { limit = 200 } = {}) {
  const r = await busy.from('wa_messages').select('number, direction, kind, text, status, created_at, seen_at, profile_name, sent_by')
    .order('created_at', { ascending: false }).limit(3000)
  if (r.error) throw new Error(/relation|does not exist|schema cache/i.test(r.error.message) ? 'SETUP' : r.error.message)
  const conv = new Map()
  for (const m of r.data || []) {
    const c = conv.get(m.number) || { number: m.number, last: m, unread: 0, lastIn: null, profile: null, count: 0 }
    c.count++
    if (m.direction === 'in') {
      if (!m.seen_at) c.unread++
      if (!c.lastIn || m.created_at > c.lastIn) c.lastIn = m.created_at
      if (!c.profile && m.profile_name) c.profile = m.profile_name
    }
    conv.set(m.number, c)
  }
  const list = [...conv.values()].slice(0, limit)
  // Names: last template we sent to that number (ref_name = ledger name) — the honest label.
  const numbers = list.map(c => c.number)
  const names = new Map()
  if (numbers.length) {
    const l = await busy.from('wa_log').select('to_number, ref_name, kind, created_at').in('to_number', numbers).not('ref_name', 'is', null).order('created_at', { ascending: false }).limit(2000)
    for (const x of l.data || []) if (!names.has(x.to_number)) names.set(x.to_number, { name: x.ref_name, how: x.kind })
    // Fallback: a customer whose mobile matches (display only, marked "maybe").
    const missing = numbers.filter(n => !names.has(n))
    if (missing.length) {
      const tens = missing.map(n => n.slice(-10))
      const cu = await busy.from('customers').select('party_code, name, party_name, mobile, whatsapp_no').or(tens.map(t => `mobile.ilike.%${t}%,whatsapp_no.ilike.%${t}%`).join(','))
      for (const c of cu.data || []) {
        const digits = `${c.mobile || ''} ${c.whatsapp_no || ''}`.replace(/\D/g, '')
        for (const n of missing) if (digits.includes(n.slice(-10)) && !names.has(n)) names.set(n, { name: c.party_name || c.name, how: 'maybe', code: String(c.party_code) })
      }
    }
  }
  const now = Date.now()
  return list.map(c => ({
    number: c.number, display: `+91 ${c.number.slice(-10, -5)} ${c.number.slice(-5)}`,
    name: names.get(c.number)?.name || c.profile || null, nameHow: names.get(c.number)?.how || (c.profile ? 'whatsapp profile' : null), code: names.get(c.number)?.code || null,
    unread: c.unread, count: c.count, last: { text: c.last.text, direction: c.last.direction, kind: c.last.kind, at: c.last.created_at, status: c.last.status, by: c.last.sent_by },
    windowOpen: !!c.lastIn && now - Date.parse(c.lastIn) < WINDOW_H * 3600e3,
    lastIn: c.lastIn,
  }))
}

// One thread: wa_messages (in + out) merged with wa_log template sends to that number.
export async function loadThread(busy, number, { markSeen = true } = {}) {
  const n = toWaNumber(number) || String(number)
  const [m, l] = await Promise.all([
    busy.from('wa_messages').select('*').eq('number', n).order('created_at', { ascending: true }).limit(500),
    busy.from('wa_log').select('id, created_at, kind, template, status, error, params, ref, ref_name, sent_by, delivered_at, read_at').eq('to_number', n).order('created_at', { ascending: true }).limit(300),
  ])
  if (m.error) throw new Error(/relation|does not exist|schema cache/i.test(m.error.message) ? 'SETUP' : m.error.message)
  const items = []
  for (const x of m.data || []) items.push({ id: `m${x.id}`, mid: x.id, direction: x.direction, kind: x.kind, text: x.text, payload: x.payload, media: !!x.media_id, at: x.created_at, status: x.status, error: x.error, by: x.sent_by, read_at: x.read_at, delivered_at: x.delivered_at })
  for (const x of l.data || []) items.push({ id: `l${x.id}`, direction: 'out', kind: 'template', template: x.template, text: `[${x.template}] ${(x.params || []).join(' · ')}`, at: x.created_at, status: x.status, error: x.error, by: x.sent_by, ref: x.ref, ref_name: x.ref_name, read_at: x.read_at, delivered_at: x.delivered_at })
  items.sort((a, b) => a.at.localeCompare(b.at))
  const lastIn = [...(m.data || [])].reverse().find(x => x.direction === 'in')?.created_at || null
  if (markSeen) {
    const u = await busy.from('wa_messages').update({ seen_at: new Date().toISOString() }).eq('number', n).eq('direction', 'in').is('seen_at', null)
    if (u.error) console.error('wa seen update failed:', u.error.message)
  }
  return { number: n, items, lastIn, windowOpen: !!lastIn && Date.now() - Date.parse(lastIn) < WINDOW_H * 3600e3 }
}

export async function unreadCount(busy) {
  const r = await busy.from('wa_messages').select('id', { count: 'exact', head: true }).eq('direction', 'in').is('seen_at', null)
  return r.error ? 0 : r.count || 0
}
