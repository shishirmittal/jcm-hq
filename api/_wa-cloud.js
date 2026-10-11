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
  ;(opts.buttonPayloads || []).forEach((payload, index) => {
    components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: String(payload) }] })
  })
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
  return graphPost(`${phoneId}/messages`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: kind, [kind]: media }),
  })
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
