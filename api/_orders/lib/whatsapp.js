import { must } from './db.js'
import { photoLink } from './lrphoto.js'
import { selectTolerant } from './columns.js'
import { openQty } from './material.js'

// The dispatch WhatsApp. ALL sending code lives in this file: the tablet and
// the rest of the server only call sendDispatchWhatsApp() and read back a status.
// To move from AiSensy to the Meta Cloud API later, add a provider next to
// `aisensy` below with the same send() shape and pick it in provider().
//
// Two approved Meta templates (docs/whatsapp-dispatch-template.md):
//   order_dispatched_photo_v1  image header = the LR photo   → AISENSY_DISPATCH_PHOTO_CAMPAIGN
//   order_dispatched_v1        no header (dispatch without photo, e.g. self-pickup)
//                                                            → AISENSY_DISPATCH_CAMPAIGN
// Both take the same eight body values.
//
// Sends ONLY when AISENSY_API_KEY, AISENSY_DISPATCH_CAMPAIGN and
// ORDERS_WHATSAPP_LIVE=true are all set in Vercel. Otherwise nothing is sent:
// the message that would have gone out is recorded on the order (event
// whatsapp_sent, status not_sent) so it can be checked.
// A WhatsApp problem never stops a dispatch.
export const INVOICE_PORTAL = 'https://invoice.jcmretails.com'
const MAX_PENDING_TEXT = 400
const PHOTO_LINK_SECONDS = 7 * 24 * 3600 // AiSensy / Meta fetch the image from this link

const rupees = n => '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))
const qty = q => (Number.isInteger(Number(q)) ? String(Number(q)) : String(Math.round(Number(q) * 1000) / 1000))

// Busy's mobile field can hold more than one number ("9893780880,9827580880").
// The first valid Indian mobile is used, as 91XXXXXXXXXX.
export function whatsappNumber(raw) {
  // Spaces can sit inside one number ("+91 98110 42276"), so only , / ; |
  // separate numbers; two run together ("98110 42276 98100 11111") are split by length.
  const clean = d => {
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
    // A leading 0 is usually an STD landline (07412 490490); only 09…/08… are taken as mobiles.
    if (d.length === 11 && d.startsWith('0')) d = /^0[89]/.test(d) ? d.slice(1) : ''
    return /^[6-9]\d{9}$/.test(d) ? `91${d}` : null
  }
  for (const piece of String(raw || '').split(/[,/;|]+/)) {
    const d = piece.replace(/\D/g, '')
    const one = clean(d)
    if (one) return one
    for (let i = 0; i + 10 <= d.length; i += 10) { const part = clean(d.slice(i, i + 10)); if (part) return part }
  }
  return null
}
export const showNumber = n => (n ? `+91 ${n.slice(2, 7)} ${n.slice(7)}` : '')

// The eight template values, in order. Meta does not allow an empty value, so
// "none" and ₹0 stand in when nothing is pending.
export function dispatchParams(order, lines) {
  const sent = lines.filter(l => Number(l.invoiced_qty) > 0)
  const pieces = sent.reduce((s, l) => s + Number(l.invoiced_qty), 0)
  const pending = lines.filter(l => Number(l.pending_qty) > 0)
  let pendingText = pending.map(l => `${l.item_name || 'Item'} × ${qty(l.pending_qty)}`).join(', ')
  if (pendingText.length > MAX_PENDING_TEXT) {
    const kept = []
    for (const l of pending) {
      const next = [...kept, `${l.item_name || 'Item'} × ${qty(l.pending_qty)}`].join(', ')
      if (next.length > MAX_PENDING_TEXT - 20) break
      kept.push(`${l.item_name || 'Item'} × ${qty(l.pending_qty)}`)
    }
    pendingText = `${kept.join(', ')} and ${pending.length - kept.length} more`
  }
  const pendingValue = pending.reduce((s, l) => {
    const ordered = Number(l.ordered_qty)
    return s + (ordered > 0 && l.line_value ? (Number(l.line_value) / ordered) * Number(l.pending_qty) : 0)
  }, 0)
  return [
    order.party_name || 'Customer',
    String(order.boxes || 0),
    `${sent.length} ${sent.length === 1 ? 'item' : 'items'} (${qty(pieces)} pcs)`,
    pending.length ? pendingText : 'none',
    rupees(pendingValue),
    rupees(order.invoice_value),
    order.invoice_vch_no || '—',
    INVOICE_PORTAL,
  ]
}

export function whatsappSettings(env = process.env) {
  const apiKey = env.AISENSY_API_KEY || ''
  const campaign = env.AISENSY_DISPATCH_CAMPAIGN || ''
  const photoCampaign = env.AISENSY_DISPATCH_PHOTO_CAMPAIGN || ''
  const live = env.ORDERS_WHATSAPP_LIVE === 'true' && !!apiKey && !!campaign
  const reason = live ? '' : !apiKey || !campaign ? 'AiSensy is not set up yet' : 'WhatsApp sending is switched off (ORDERS_WHATSAPP_LIVE)'
  return { live, apiKey, campaign, photoCampaign, reason, photo: live && !!photoCampaign }
}

// ------------------------------------------------------------------ providers
// send({ to, name, params, image: { url, filename } | null }) → { status: 'sent'|'failed', http?, reply?, photo }
const aisensy = {
  url: 'https://backend.aisensy.com/campaign/t1/api/v2',
  async send(s, { to, name, params, image }, fetchImpl) {
    // The image template needs a picture; without one the plain template is used.
    const withPhoto = !!(image && s.photoCampaign)
    const body = { apiKey: s.apiKey, campaignName: withPhoto ? s.photoCampaign : s.campaign, destination: to, userName: name, templateParams: params, source: 'jcm-orders' }
    if (withPhoto) body.media = { url: image.url, filename: image.filename }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetchImpl(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
      const reply = (await res.text()).slice(0, 300)
      return { status: res.ok ? 'sent' : 'failed', http: res.status, reply, photo: withPhoto }
    } finally {
      clearTimeout(timer)
    }
  },
}
const provider = () => aisensy

// Called after a dispatch. Never throws: every outcome is recorded instead.
//   photoPath: the LR photo in storage (lrphoto.js), or null for a dispatch without photo.
export async function sendDispatchWhatsApp(dbc, orderId, me, device, { photoPath = null, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const record = async payload => {
    await must(dbc.from('order_events').insert({ order_id: orderId, event: 'whatsapp_sent', profile_id: me.id, device_id: device.id, payload }), 'recording WhatsApp')
    return payload
  }
  try {
    const order = await must(dbc.from('orders').select('so_vch_no, party_name, party_mobile, boxes, invoice_vch_no, invoice_value').eq('id', orderId).maybeSingle(), 'reading order')
    const COLS = 'item_name, ordered_qty, invoiced_qty, pending_qty, line_value'
    const raw = await must(selectTolerant(cols => dbc.from('order_lines').select(cols).eq('order_id', orderId), `${COLS}, cleared_at, cleared_qty`, COLS), 'reading lines')
    // Lines cleared in the portal are not "still to come".
    const lines = raw.map(l => ({ ...l, pending_qty: openQty(l) }))
    const params = dispatchParams(order, lines)
    const to = whatsappNumber(order.party_mobile)
    const s = whatsappSettings(env)
    const lr = !!photoPath
    if (!to) return record({ status: 'not_sent', reason: 'No valid mobile number on the order', params, lr_photo: lr })
    if (!s.live) return record({ status: 'not_sent', reason: s.reason, to, params, lr_photo: lr })

    let image = null
    if (photoPath && s.photoCampaign) {
      const url = await photoLink(dbc, photoPath, PHOTO_LINK_SECONDS)
      if (url) image = { url, filename: `LR-${String(order.so_vch_no || '').split('/').pop() || 'photo'}.jpg` }
    }
    const out = await provider().send(s, { to, name: params[0], params, image }, fetchImpl)
    const note = photoPath && !out.photo ? (s.photoCampaign ? 'LR photo link could not be made; sent without it' : 'No photo campaign set (AISENSY_DISPATCH_PHOTO_CAMPAIGN); sent without the LR photo') : undefined
    return record({ status: out.status, to, params, http: out.http, reply: out.reply, lr_photo: lr, photo_attached: out.photo, ...(note ? { note } : {}) })
  } catch (err) {
    try { return await record({ status: 'failed', reason: String(err.message || err).slice(0, 300) }) } catch { return { status: 'failed' } }
  }
}
