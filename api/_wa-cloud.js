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
export async function sendTemplate(toPhone, templateName, languageCode, bodyParams = []) {
  const token = process.env.WHATSAPP_TOKEN
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneId) throw new Error('WhatsApp (Meta) is not set up: WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing in Vercel.')
  const to = toWaNumber(toPhone)
  if (!to) throw new Error('That does not look like a valid Indian mobile number.')

  const template = { name: templateName, language: { code: languageCode } }
  if (bodyParams.length) {
    template.components = [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) }]
  }

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
