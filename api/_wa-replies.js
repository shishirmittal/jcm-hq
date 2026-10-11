import { createClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { FRAME_PNG, NAME_FONT } from './_qr-assets.js'
import { sendText, sendMedia } from './_wa-cloud.js'

// Answers the quick-reply buttons on the payment-reminder templates (QR Code / Ledger / Last 3 Invoices).
// Called from the WhatsApp webhook in api/whatsapp.js. Never throws to the caller.

const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co'

// Same merchant details Busy prints in the QR on every invoice. Change here only.
const UPI = {
  pa: '7415277521-1@okbizaxis',
  pn: 'J C MITTAL AND SONS',
  mc: '5732',
  aid: 'uGICAgIC_9KuFXw',
  tr: 'BCR2DN6TQ7PITK3E',
}

// Busy's own format: upi://pay?pa=…&pn=…&mc=…&aid=…&tr=…&tn=<party name, 20 chars>
export function noteName(partyName) {
  return String(partyName || '').replace(/[\u0000-\u001f\u007f<>&=#%]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 20).trim()
}

export function upiString(partyName) {
  const tn = noteName(partyName)
  return `upi://pay?pa=${UPI.pa}&pn=${UPI.pn}&mc=${UPI.mc}&aid=${UPI.aid}&tr=${UPI.tr}&tn=${tn}`
}

// Plain QR (black on white). Used inside the decorated card below.
export async function qrPlain(partyName, width = 700) {
  return QRCode.toBuffer(upiString(partyName), { type: 'png', width, margin: 0, errorCorrectionLevel: 'M' })
}

// The decorated payment card: navy + gold frame, logo, QR, payment note (billed party name).
let fontReady = false
export async function qrPng(partyName) {
  if (!fontReady) { GlobalFonts.register(Buffer.from(NAME_FONT, 'base64'), 'JCMName'); fontReady = true }
  const frame = await loadImage(Buffer.from(FRAME_PNG, 'base64'))
  const canvas = createCanvas(frame.width, frame.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(frame, 0, 0)
  ctx.drawImage(await loadImage(await qrPlain(partyName, 700)), 190, 570, 700, 700)
  const note = noteName(partyName)
  let size = 40
  ctx.fillStyle = '#12213B'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  do { ctx.font = `${size}px JCMName`; size -= 2 } while (ctx.measureText(note).width > 820 && size > 20)
  ctx.fillText(note, canvas.width / 2, 1362)
  return canvas.toBuffer('image/png')
}

function busyClient() {
  const key = process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
  if (!key) return null
  return createClient(SUPABASE_BUSY_URL, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

// Names Busy may keep for "billed party" (the name printed on invoices), best first.
const BILLED_COLS = ['billed_party_name', 'billed_party', 'billing_name', 'bill_name', 'print_name', 'printing_name', 'mailing_name', 'party_print_name']
const NAME_COLS = ['party_name', 'name', 'customer_name', 'account_name']
const MOBILE_COLS = ['mobile', 'mobile_no', 'phone', 'phone_no', 'whatsapp_no', 'whatsapp']

// WhatsApp number (91XXXXXXXXXX) → customers row (full), or null. Tries mobile and whatsapp columns.
export async function findCustomerRow(busy, waNumber) {
  const last10 = String(waNumber).slice(-10)
  const r = await busy.from('customers').select('*').limit(1)
  const cols = Object.keys(r.data?.[0] || {})
  const mobileCols = MOBILE_COLS.filter(c => cols.includes(c))
  if (!mobileCols.length) return null
  const { data } = await busy.from('customers').select('*').or(mobileCols.map(c => `${c}.ilike.%${last10}%`).join(',')).limit(5)
  return (data || [])[0] || null
}

// Who the QR is for: the billed party name if Busy has one (what Busy prints in its own QR note), else the ledger name.
export function billedName(row) {
  for (const c of BILLED_COLS) if (row?.[c] && String(row[c]).trim()) return String(row[c]).trim()
  for (const c of NAME_COLS) if (row?.[c] && String(row[c]).trim()) return String(row[c]).trim()
  return ''
}

async function findCustomer(busy, waNumber) {
  const row = await findCustomerRow(busy, waNumber)
  return row ? { code: row.party_code, name: billedName(row) } : null
}

export { busyClient }

const WHICH = [
  [/qr/i, 'qr'],
  [/ledger/i, 'ledger'],
  [/invoice|bill/i, 'invoices'],
]

export async function handleIncoming(value) {
  try {
    const busy = busyClient()
    for (const m of value?.messages || []) {
      const label = m.button?.text || m.button?.payload || m.interactive?.button_reply?.title || ''
      const kind = (WHICH.find(([re]) => re.test(label)) || [])[1]
      if (!kind) continue
      const from = m.from
      console.log(`wa reply: button="${label}" kind=${kind}`)
      const cust = busy ? await findCustomer(busy, from) : null
      if (!cust) {
        await sendText(from, 'Thank you. We could not match this number to an account. Please call us on this number and our team will help you.')
        continue
      }
      if (kind === 'qr') {
        const png = await qrPng(cust.name)
        await sendMedia(from, png, {
          kind: 'image', mime: 'image/png', filename: 'JCM-payment-QR.png',
          caption: '*Please share payment details with us after payment.*\n*भुगतान के बाद कृपया भुगतान की जानकारी हमें भेजें।*',
        })
      } else {
        await sendText(from, 'Thank you. Our team will send this to you here shortly.')
      }
    }
  } catch (err) {
    console.error('wa reply error:', err.message)
    // Tell the customer something rather than staying silent (they just messaged us, so free text is allowed).
    for (const m of value?.messages || []) {
      try { await sendText(m.from, 'Thank you. Our team will send this to you here shortly.') } catch (e2) { console.error('wa fallback error:', e2.message) }
    }
  }
}
