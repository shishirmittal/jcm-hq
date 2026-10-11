import { createClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'
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
export function upiString(partyName) {
  const tn = String(partyName || '').replace(/[\u0000-\u001f\u007f<>&=#%]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 20)
  return `upi://pay?pa=${UPI.pa}&pn=${UPI.pn}&mc=${UPI.mc}&aid=${UPI.aid}&tr=${UPI.tr}&tn=${tn}`
}

export async function qrPng(partyName) {
  return QRCode.toBuffer(upiString(partyName), { type: 'png', width: 640, margin: 4, errorCorrectionLevel: 'M' })
}

function busyClient() {
  const key = process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
  if (!key) return null
  return createClient(SUPABASE_BUSY_URL, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

// WhatsApp number (91XXXXXXXXXX) → customer row, or null. Tries mobile and whatsapp columns.
async function findCustomer(busy, waNumber) {
  const last10 = String(waNumber).slice(-10)
  const r = await busy.from('customers').select('*').limit(1)
  const cols = Object.keys(r.data?.[0] || {})
  const mobileCols = ['mobile', 'mobile_no', 'phone', 'phone_no', 'whatsapp_no', 'whatsapp'].filter(c => cols.includes(c))
  const nameCol = ['party_name', 'name', 'customer_name', 'print_name', 'account_name'].find(c => cols.includes(c)) || 'party_name'
  if (!mobileCols.length) return null
  const { data } = await busy.from('customers').select('*').or(mobileCols.map(c => `${c}.ilike.%${last10}%`).join(',')).limit(5)
  const row = (data || [])[0]
  return row ? { code: row.party_code, name: row[nameCol], matches: (data || []).length } : null
}

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
      const cust = busy ? await findCustomer(busy, from) : null
      if (!cust) {
        await sendText(from, 'Thank you. We could not match this number to an account. Please call us on this number and our team will help you.')
        continue
      }
      if (kind === 'qr') {
        const png = await qrPng(cust.name)
        await sendMedia(from, png, {
          kind: 'image', mime: 'image/png', filename: 'JCM-payment-QR.png',
          caption: `Scan with any UPI app to pay J.C. Mittal and Sons.\nPayment note: ${String(cust.name).toUpperCase().slice(0, 20)}\nEnter the amount you are paying and keep the note as it is.`,
        })
      } else {
        await sendText(from, 'Thank you. Our team will send this to you here shortly.')
      }
    }
  } catch (err) {
    console.error('wa reply error:', err.message)
  }
}
