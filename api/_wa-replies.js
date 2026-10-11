import { createClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { FRAME_PNG, NAME_FONT } from './_qr-assets.js'
import { loadStatement, buildLedgerPdf } from './_ledger-pdf.js'
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

const NAME_COLS = ['party_name', 'name', 'customer_name', 'account_name']

// Ledger name of the customer a reminder was sent about (by Busy code). Never looked up from a phone number.
export async function ledgerNameByCode(busy, code) {
  const n = Number(code)
  if (!Number.isFinite(n)) return ''
  const { data } = await busy.from('customers').select('*').eq('party_code', n).limit(1)
  const row = (data || [])[0]
  if (!row) return ''
  for (const c of NAME_COLS) if (row[c] && String(row[c]).trim()) return String(row[c]).trim()
  return ''
}

export { busyClient }

const PORTAL = 'https://invoice.jcmretails.com'
const pick = (cols, names) => names.find(n => cols.includes(n)) || null
const rupees = n => '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))
const niceDate = v => {
  const d = new Date(v)
  return Number.isNaN(+d) ? String(v || '').slice(0, 10) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

// The customer's latest bills (invoices table, by Busy code) as a WhatsApp message.
export async function lastInvoicesText(busy, code, name) {
  const probe = await busy.from('invoices').select('*').limit(1)
  const cols = Object.keys(probe.data?.[0] || {})
  const dateCol = pick(cols, ['vch_date', 'invoice_date', 'date']) || 'vch_date'
  const noCol = pick(cols, ['vch_no', 'voucher_no', 'invoice_no', 'bill_no', 'vch_number'])
  const amtCol = pick(cols, ['total_amount', 'amount', 'net_amount', 'invoice_value'])
  const r = await busy.from('invoices').select('*').eq('party_code', Number(code)).order(dateCol, { ascending: false }).limit(3)
  if (r.error) throw new Error(r.error.message)
  const rows = r.data || []
  const link = `${PORTAL}`
  if (!rows.length) {
    return `*${name}*\nWe could not find recent bills on your account here. Our team will share them with you shortly.\n\nInvoice portal: ${link}`
  }
  const lines = rows.map((x, i) => `${i + 1}. ${niceDate(x[dateCol])}  •  ${noCol ? x[noCol] : x.vch_code}${amtCol ? `  •  *${rupees(x[amtCol])}*` : ''}`)
  return `*Your last ${rows.length === 1 ? 'invoice' : rows.length + ' invoices'}*\n${name}\n\n${lines.join('\n')}\n\nView and download all your invoices:\n${link}\n\n*आपके पिछले बिल ऊपर दिए गए हैं। सभी बिल देखने और डाउनलोड करने के लिए ऊपर का लिंक खोलें।*`
}

const WHICH = [
  [/qr/i, 'qr'],
  [/ledger/i, 'ledger'],
  [/invoice|bill/i, 'invoices'],
]

// Button payloads we put on the reminder: "qr:<code>", "ledger:<code>", "inv:<code>".
function parsePayload(payload) {
  const m = /^(qr|ledger|inv):(\d{1,9})$/.exec(String(payload || ''))
  return m ? { kind: m[1] === 'inv' ? 'invoices' : m[1], code: m[2] } : null
}

export async function handleIncoming(value) {
  try {
    const busy = busyClient()
    for (const m of value?.messages || []) {
      const payload = m.button?.payload || m.interactive?.button_reply?.id || ''
      const label = m.button?.text || m.interactive?.button_reply?.title || ''
      const parsed = parsePayload(payload)
      const kindByLabel = (WHICH.find(([re]) => re.test(label)) || [])[1]
      if (!parsed && !kindByLabel) continue
      const from = m.from
      console.log(`wa reply: button="${label}" payload=${payload ? 'yes' : 'none'}`)
      const name = parsed && busy ? await ledgerNameByCode(busy, parsed.code) : ''
      if (!parsed || !name) {
        // Old message without a customer code, or the code is unknown: never guess from the phone number.
        await sendText(from, 'Thank you. Our team will send this to you here shortly.')
        continue
      }
      if (parsed.kind === 'qr') {
        const png = await qrPng(name)
        await sendMedia(from, png, {
          kind: 'image', mime: 'image/png', filename: 'JCM-payment-QR.png',
          caption: '*Please share payment details with us after payment.*\n*भुगतान के बाद कृपया भुगतान की जानकारी हमें भेजें।*',
        })
      } else if (parsed.kind === 'ledger') {
        const stmt = await loadStatement(busy, parsed.code)
        if (!stmt) {
          await sendText(from, 'Thank you. Our team will send your ledger to you here shortly.')
        } else {
          const pdf = await buildLedgerPdf({ partyName: name, stmt })
          const safe = name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'Account'
          await sendMedia(from, pdf, {
            kind: 'document', mime: 'application/pdf', filename: `JCM-Ledger-${safe}.pdf`,
            caption: '*Your ledger statement is attached.*\n*आपका लेजर विवरण संलग्न है।*',
          })
        }
      } else if (parsed.kind === 'invoices') {
        await sendText(from, await lastInvoicesText(busy, parsed.code, name))
      } else {
        await sendText(from, 'Thank you. Our team will send this to you here shortly.')
      }
    }
  } catch (err) {
    console.error('wa reply error:', err.message)
    for (const m of value?.messages || []) {
      try { await sendText(m.from, 'Thank you. Our team will send this to you here shortly.') } catch (e2) { console.error('wa fallback error:', e2.message) }
    }
  }
}
