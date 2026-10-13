// Payment card image (2026-10-13) — sent for every "QR Code" / "QR Code + Bank Details" button tap.
// Same look as every JCM document (api/_jcm-doc.js, the invoice-portal style): white page, black logo,
// Instrument Sans + IBM Plex Mono, hairline rules, grey labels. No navy / gold (Shishir: those stay on
// the website only). The QR is the customer's own UPI QR in Busy's format (upiString in _wa-replies.js),
// so the payment note carries their ledger name.
import QRCode from 'qrcode'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { SANS_REG, SANS_MED, SANS_BOLD, MONO_REG, MONO_MED } from './_jcm-fonts.js'
import { LOGO_PNG } from './_ledger-assets.js'
import { COMPANY, INK, GREY, LINE, PILL_BG, PILL_FG } from './_jcm-doc.js'

// Bank details printed on the card. Change here only.
export const BANK = [
  ['Account name', 'J.C. Mittal And Sons'],
  ['Bank', 'State Bank of India'],
  ['Branch', 'SME Branch, Ratlam'],
  ['Account type', 'Current account'],
  ['Account no.', '38596845721', 'mono'],
  ['IFSC', 'SBIN0009452', 'mono'],
]

let fontsReady = false
function fonts() {
  if (fontsReady) return
  GlobalFonts.register(Buffer.from(SANS_REG, 'base64'), 'JSans')
  GlobalFonts.register(Buffer.from(SANS_MED, 'base64'), 'JSansMed')
  GlobalFonts.register(Buffer.from(SANS_BOLD, 'base64'), 'JSansBold')
  GlobalFonts.register(Buffer.from(MONO_REG, 'base64'), 'JMono')
  GlobalFonts.register(Buffer.from(MONO_MED, 'base64'), 'JMonoMed')
  fontsReady = true
}

// upi: the full upi://pay… string; note: the payment note shown under the QR; upiId: shown in the bank list.
export async function qrCardPng({ upi, note, upiId }) {
  fonts()
  const W = 1080, H = 1790, L = 72, R = W - 72, FULL = R - L
  const c = createCanvas(W, H)
  const x = c.getContext('2d')
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H)
  const font = (f, s) => { x.font = `${s}px ${f}` }
  const text = (t, px, py, { f = 'JSans', s = 24, color = INK, align = 'left', spacing = 0 } = {}) => {
    font(f, s); x.fillStyle = color; x.textAlign = align; x.textBaseline = 'alphabetic'
    if (spacing) x.letterSpacing = `${spacing}px`
    x.fillText(String(t), px, py)
    x.letterSpacing = '0px'
  }
  const rule = (py, x1 = L, x2 = R) => { x.strokeStyle = LINE; x.lineWidth = 2; x.beginPath(); x.moveTo(x1, py); x.lineTo(x2, py); x.stroke() }
  const label = (t, px, py, align = 'left') => text(String(t).toUpperCase(), px, py, { f: 'JSansMed', s: 19, color: GREY, align, spacing: 2 })
  const fit = (t, f, s, maxW) => { font(f, s); while (x.measureText(t).width > maxW && s > 14) { s -= 1; font(f, s) } return s }

  // ---- header: logo + name + GSTIN left, address right (as on the invoice)
  const logo = await loadImage(Buffer.from(LOGO_PNG, 'base64'))
  x.drawImage(logo, L, 64, 92, 92)
  text(COMPANY.name, L + 112, 108, { f: 'JSansBold', s: 38 })
  text(`GSTIN ${COMPANY.gstin}`, L + 112, 142, { f: 'JMono', s: 19, color: GREY })
  text('87-88 Freeganj Road', R, 96, { s: 19, color: GREY, align: 'right' })
  text('Ratlam, MP 457001', R, 122, { s: 19, color: GREY, align: 'right' })
  text('www.jcmretails.com', R, 148, { s: 19, color: GREY, align: 'right' })
  rule(196)

  // ---- title + pill
  text('Payment details', L, 290, { s: 66 })
  font('JSans', 66); const tw = x.measureText('Payment details').width
  const pill = 'UPI · BANK'
  font('JSansMed', 18); x.letterSpacing = '1.5px'; const pw = x.measureText(pill).width + 32; x.letterSpacing = '0px'
  x.fillStyle = PILL_BG; x.beginPath(); x.roundRect(L + tw + 22, 244, pw, 36, 18); x.fill()
  text(pill, L + tw + 22 + pw / 2, 268, { f: 'JSansMed', s: 18, color: PILL_FG, align: 'center', spacing: 1.5 })
  text('Scan with any UPI app — Google Pay, PhonePe, Paytm, BHIM', L, 336, { s: 25, color: GREY })

  // ---- QR in a hairline box
  const box = 600, bx = (W - box) / 2, by = 384
  x.strokeStyle = LINE; x.lineWidth = 2; x.beginPath(); x.roundRect(bx, by, box, box, 24); x.stroke()
  const qr = await loadImage(await QRCode.toBuffer(upi, { type: 'png', width: 520, margin: 0, errorCorrectionLevel: 'Q', color: { dark: '#111111', light: '#ffffff' } }))
  x.drawImage(qr, bx + 40, by + 40, 520, 520)
  // logo in the middle of the QR (error correction Q copes with a small centre mark)
  const lm = 84, lx = W / 2 - lm / 2, ly = by + box / 2 - lm / 2
  x.fillStyle = '#ffffff'; x.beginPath(); x.arc(W / 2, by + box / 2, lm / 2 + 10, 0, Math.PI * 2); x.fill()
  x.drawImage(logo, lx, ly, lm, lm)

  label('Payment note', W / 2, by + box + 54, 'center')
  const ns = fit(note || '—', 'JMonoMed', 34, FULL)
  text(note || '—', W / 2, by + box + 100, { f: 'JMonoMed', s: ns, align: 'center' })

  // ---- bank transfer
  let y = by + box + 160
  rule(y); y += 52
  label('Or pay by bank transfer', L, y)
  y += 22
  const rows = [...BANK, ['UPI ID', upiId, 'mono']]
  for (const [k, v, kind] of rows) {
    y += 56
    text(k, L, y, { s: 26, color: GREY })
    const vs = fit(v, kind === 'mono' ? 'JMonoMed' : 'JSansMed', 28, FULL - 260)
    text(v, R, y, { f: kind === 'mono' ? 'JMonoMed' : 'JSansMed', s: vs, align: 'right' })
    rule(y + 22)
  }

  // ---- footer band (light grey, like the document footer)
  const fy = H - 120
  x.fillStyle = '#f6f7fb'; x.fillRect(0, fy, W, 120)
  text('After paying, please reply in this chat with the payment screenshot.', W / 2, fy + 54, { f: 'JSansMed', s: 25, align: 'center' })
  text('Thank you for your business · J.C. Mittal And Sons, Ratlam', W / 2, fy + 90, { s: 20, color: GREY, align: 'center' })
  return c.toBuffer('image/png')
}
