// Meta WhatsApp Cloud API sender (direct, no provider in between).
// Used by api/whatsapp.js. The token only ever lives in Vercel env vars and is never
// logged or returned to the browser.
//
// Env (Vercel): WHATSAPP_TOKEN (permanent system-user token), WHATSAPP_PHONE_NUMBER_ID,
// WHATSAPP_WABA_ID (the last one is only needed for template management, not sending).

const GRAPH = 'https://graph.facebook.com/v21.0'

export function waConfigured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
}

// Any Indian mobile written the usual ways → 91XXXXXXXXXX (digits only), or null.
export function toWaNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  return /^[6-9]\d{9}$/.test(d) ? `91${d}` : null
}

// Send an approved template. bodyParams = the {{1}}, {{2}} … values, in order.
// Returns Meta's response ({ messages: [{ id }] }). Throws Error with a plain message.
export async function sendTemplate(toPhone, templateName, languageCode, bodyParams = [], opts = {}) {
  const token = process.env.WHATSAPP_TOKEN
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneId) throw new Error('WhatsApp (Meta) is not set up: WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing in Vercel.')
  const to = toWaNumber(toPhone)
  if (!to) throw new Error('That does not look like a valid Indian mobile number.')

  const template = { name: templateName, language: { code: languageCode } }
  const components = []
  if (opts.headerImageUrl) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: opts.headerImageUrl } }] })
  // Document header (template made with a PDF header): a public link + the file name the reader sees.
  if (opts.headerDocumentUrl) components.push({ type: 'header', parameters: [{ type: 'document', document: { link: opts.headerDocumentUrl, filename: opts.headerDocumentName || 'document.pdf' } }] })
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) })
  // Quick-reply buttons: each carries a payload that comes back to us when the customer taps it
  // (we put the customer's Busy code in it, so replies never have to guess who it is).
  // An entry may be { index, payload } when the quick reply is not the first button (e.g. after a Call button).
  ;(opts.buttonPayloads || []).forEach((entry, i) => {
    const index = entry && typeof entry === 'object' ? entry.index : i
    const payload = entry && typeof entry === 'object' ? entry.payload : entry
    components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: String(payload) }] })
  })
  // URL buttons with a dynamic ending (template made with https://wa.me/{{1}} etc): { index: suffix }.
  for (const [index, suffix] of Object.entries(opts.buttonUrlParams || {})) {
    components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: String(suffix) }] })
  }
  if (components.length) template.components = components

  let res, data
  try {
    res = await fetch(`${GRAPH}/${encodeURIComponent(phoneId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template }),
    })
    data = await res.json().catch(() => null)
  } catch {
    throw new Error('Could not reach Meta. Try again in a minute.')
  }
  if (!res.ok || data?.error) {
    const e = data?.error || {}
    const detail = e.error_data?.details ? ` (${e.error_data.details})` : ''
    throw new Error(`Meta said: ${e.message || `HTTP ${res.status}`}${detail}${e.code ? ` [code ${e.code}]` : ''}`)
  }
  return data
}

async function graphPost(path, init) {
  const token = process.env.WHATSAPP_TOKEN
  let res, data
  try {
    res = await fetch(`${GRAPH}/${path}`, { method: 'POST', ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } })
    data = await res.json().catch(() => null)
  } catch {
    throw new Error('Could not reach Meta. Try again in a minute.')
  }
  if (!res.ok || data?.error) {
    const e = data?.error || {}
    throw new Error(`Meta said: ${e.message || `HTTP ${res.status}`}${e.code ? ` [code ${e.code}]` : ''}`)
  }
  return data
}

// Free-text message. Only works inside 24 h of the customer's last message (e.g. right after
// they tap a button on a reminder).
export async function sendText(toPhone, text) {
  const to = toWaNumber(toPhone)
  if (!to) throw new Error('Not a valid Indian mobile number.')
  return graphPost(`${encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }),
  })
}

// Upload a PNG/PDF held in memory, then send it as an image or document (inside the 24 h window).
export async function sendMedia(toPhone, buffer, { kind = 'image', mime = 'image/png', filename = 'file.png', caption = '' } = {}) {
  const to = toWaNumber(toPhone)
  if (!to) throw new Error('Not a valid Indian mobile number.')
  const phoneId = encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID)
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', mime)
  form.append('file', new Blob([buffer], { type: mime }), filename)
  const up = await graphPost(`${phoneId}/media`, { body: form })
  const media = { id: up.id }
  if (caption) media.caption = caption
  if (kind === 'document') media.filename = filename
  const res = await graphPost(`${phoneId}/messages`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: kind, [kind]: media }),
  })
  // mediaId lets the Inbox fetch our own sent file again later (Meta keeps uploads ~30 days).
  return { ...res, mediaId: up.id }
}

// Is our Meta app subscribed to this WhatsApp account's events (messages, button taps)?
// op: 'get' lists subscribed apps, 'subscribe' subscribes the app that owns the token.
export async function wabaSubscription(op) {
  const token = process.env.WHATSAPP_TOKEN
  const waba = process.env.WHATSAPP_WABA_ID
  if (!token || !waba) throw new Error('WHATSAPP_TOKEN / WHATSAPP_WABA_ID missing in Vercel.')
  let res, data
  try {
    res = await fetch(`${GRAPH}/${encodeURIComponent(waba)}/subscribed_apps`, {
      method: op === 'subscribe' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    data = await res.json().catch(() => null)
  } catch {
    throw new Error('Could not reach Meta. Try again in a minute.')
  }
  if (!res.ok || data?.error) throw new Error(`Meta said: ${data?.error?.message || `HTTP ${res.status}`}`)
  return data
}

// ---------------------------------------------------------------------------
// Shared bits for every module that sends (2026-10-12): one log, one set of switches.
//   wa_log       every template send: kind, to, template, status, error, Meta message id, ref
//   wa_settings  { key, value } — 'off:<kind>' = 'true' switches that kind off (HQ → WhatsApp page)
// Both live in the Busy project; pass the Busy service-key client as `busy`.
// Kinds: invoice, receipt, credit_note, debit_note, payment, purchase, order, quotation,
//        dispatch, gst_supplier, reminder, staff_followup, staff_evening, staff_red_alert,
//        staff_purchase, staff_purchase_summary, staff_gst, staff_orders, test
// ---------------------------------------------------------------------------
export const HQ_URL = 'https://hq.jcmretails.com'
export const BANNER = name => `${HQ_URL}/wa/${name}.png`
export const inr = n => Math.round(Number(n) || 0).toLocaleString('en-IN')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const niceDate = iso => {
  const s = String(iso || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '—'
  const [y, m, d] = s.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}
// Meta refuses a body value with a line break, a tab or 4+ spaces in a row; and never an empty one.
export const flat = (v, max = 900) => {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' · ').replace(/ {2,}/g, ' ').trim()
  return (s || '—').slice(0, max)
}

export async function waSwitches(busy) {
  const r = await busy.from('wa_settings').select('key, value')
  if (r.error) return { ready: false, off: new Set(), get: () => null }
  const map = new Map((r.data || []).map(x => [x.key, x.value]))
  const off = new Set([...map.keys()].filter(k => k.startsWith('off:') && map.get(k) === 'true').map(k => k.slice(4)))
  // Customer transaction messages start OFF until someone ticks them on the WhatsApp page (a real
  // customer must never get a message just because the code went live).
  for (const k of ['invoice', 'receipt', 'credit_note', 'debit_note', 'payment', 'purchase', 'order']) if (!map.has(`off:${k}`)) off.add(k)
  return { ready: true, off, get: k => map.get(k) ?? null, map }
}

// Send a template and write one wa_log row whatever happens.
// Returns { status: 'sent' | 'failed' | 'no_number' | 'off', id?, error? } — never throws.
export async function sendLogged(busy, { kind, to, template, lang = 'en', params = [], opts = {}, ref = null, refName = null, by = null, switches = null }) {
  const sw = switches || await waSwitches(busy)
  const number = toWaNumber(to)
  const row = { kind, template, to_number: number, ref, ref_name: refName, sent_by: by, params: params.map(p => String(p)) }
  let out
  if (sw.off.has(kind)) out = { status: 'off', error: 'switched off on the WhatsApp page' }
  else if (!number) out = { status: 'no_number', error: `no valid mobile (${String(to || '').slice(0, 30)})` }
  else {
    try {
      const d = await sendTemplate(number, template, lang, params.map(p => flat(p)), opts)
      out = { status: 'sent', id: d?.messages?.[0]?.id || null }
    } catch (err) {
      out = { status: 'failed', error: String(err.message || err).slice(0, 400) }
    }
  }
  const ins = await busy.from('wa_log').insert({ ...row, status: out.status, error: out.error || null, meta_id: out.id || null })
  if (ins.error) console.error('wa_log insert failed:', ins.error.message)
  return out
}

// ---- Templates on the WhatsApp account (WhatsApp Manager) ----------------------------------
export async function listTemplates() {
  const token = process.env.WHATSAPP_TOKEN
  const waba = process.env.WHATSAPP_WABA_ID
  if (!token || !waba) throw new Error('WHATSAPP_TOKEN / WHATSAPP_WABA_ID missing in Vercel.')
  const out = []
  let url = `${GRAPH}/${encodeURIComponent(waba)}/message_templates?fields=name,status,category,language,components,rejected_reason,quality_score&limit=100`
  for (let i = 0; i < 10 && url; i++) {
    let res, data
    try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); data = await res.json().catch(() => null) }
    catch { throw new Error('Could not reach Meta. Try again in a minute.') }
    if (!res.ok || data?.error) throw new Error(`Meta said: ${data?.error?.message || `HTTP ${res.status}`}`)
    out.push(...(data.data || []))
    url = data.paging?.next || null
  }
  return out
}

// Fetch a media file a customer sent (webhook gives only the media id). Returns { buffer, mime, size }.
export async function fetchMedia(mediaId) {
  const token = process.env.WHATSAPP_TOKEN
  const meta = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: { Authorization: `Bearer ${token}` } })
  const info = await meta.json().catch(() => null)
  if (!meta.ok || !info?.url) throw new Error(`Meta said: ${info?.error?.message || `HTTP ${meta.status}`}`)
  const file = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } })
  if (!file.ok) throw new Error(`Could not download the file (HTTP ${file.status}).`)
  const buffer = Buffer.from(await file.arrayBuffer())
  return { buffer, mime: info.mime_type || file.headers.get('content-type') || 'application/octet-stream', size: buffer.length }
}
