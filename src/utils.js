export const PRODUCT_STAGES = [
  'Conduit',
  'Wiring',
  'Lights',
  'Switches',
  'Fans',
  'Decoratives',
  'Appliances'
]

export const PROJECT_STATUSES = [
  'New Lead',
  'Store Visited',
  'Quotation Given',
  'Project Final',
  'Partial Won',
  'Project Lost'
]

export function esc(s) {
  const d = document.createElement('div')
  d.textContent = s == null ? '' : String(s)
  return d.innerHTML
}

export function slug(s) {
  return (s || 'new-lead').toLowerCase().replace(/ /g, '-')
}

export function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// Dates from Postgres `date` columns (YYYY-MM-DD) are calendar dates with no
// timezone. Parsing them as local y/m/d — instead of `new Date(str)`, which
// treats them as UTC midnight — avoids them shifting a day in either
// direction depending on the viewer's timezone offset.
export function parseLocalDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(dateStr, days) {
  const dt = parseLocalDate(dateStr)
  dt.setDate(dt.getDate() + (Number(days) || 0))
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`
}

export function formatDate(dateStr) {
  return parseLocalDate(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '')
}

function normalizeIndianPhone(phone) {
  let d = digitsOnly(phone)
  if (d.length === 10) d = '91' + d
  return d
}

// Last 10 digits, so a stored "+91 98xxxxxxx" and a freshly typed "098xxxxxxx"
// are recognized as the same number regardless of country code/leading zero.
export function phoneMatchKey(phone) {
  return digitsOnly(phone).slice(-10)
}

export function formatMoney(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

// Short form for the figures on the stat cards, where the full number is both
// too wide for the card and more precision than anyone reads at a glance:
// ₹23.18 L rather than ₹23,18,450. Lakhs and crores because that is how these
// amounts get said out loud here, not M and B.
//
// Below a lakh there is nothing to gain — ₹0.64 L is harder to read than
// ₹64,000 — so those stay exactly as they were. Callers pair this with the
// full formatMoney() in a title attribute, so the exact figure is always one
// hover away and nothing is actually lost by shortening it.
export function formatMoneyCompact(n) {
  const value = Number(n || 0)
  const abs = Math.abs(value)
  if (abs < 100000) return formatMoney(value)
  const [divisor, suffix] = abs >= 10000000 ? [10000000, 'Cr'] : [100000, 'L']
  const scaled = value / divisor
  // Two decimals up to 100 of a unit, one beyond it: "₹5.67 Cr" reads well,
  // "₹123.45 L" is just a long number wearing a short number's clothes.
  const digits = Math.abs(scaled) >= 100 ? 1 : 2
  return '₹' + scaled.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }) + ' ' + suffix
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigitWords(n) {
  if (n < 20) return ONES[n]
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '')
}

function threeDigitWords(n) {
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  let s = hundreds ? ONES[hundreds] + ' Hundred' : ''
  if (rest) s += (s ? ' ' : '') + twoDigitWords(rest)
  return s
}

// Indian numbering (Crore/Lakh/Thousand) — "Rupees Forty-Two Thousand Three Hundred
// Seventy-Four Only" style, for the letterhead's amount-in-words line.
export function numberToWordsIndian(amount) {
  let n = Math.round(Number(amount) || 0)
  if (n === 0) return 'Zero'
  const crore = Math.floor(n / 10000000); n %= 10000000
  const lakh = Math.floor(n / 100000); n %= 100000
  const thousand = Math.floor(n / 1000); n %= 1000
  const hundred = n
  const parts = []
  if (crore) parts.push(threeDigitWords(crore) + ' Crore')
  if (lakh) parts.push(threeDigitWords(lakh) + ' Lakh')
  if (thousand) parts.push(threeDigitWords(thousand) + ' Thousand')
  if (hundred) parts.push(threeDigitWords(hundred))
  return parts.join(' ')
}

export function telHref(phone) {
  return `tel:+${normalizeIndianPhone(phone)}`
}

export function waHref(phone, message) {
  const digits = normalizeIndianPhone(phone)
  const text = message ? `?text=${encodeURIComponent(message)}` : ''
  return `https://wa.me/${digits}${text}`
}

// A placeholder shaped like the content that is coming, instead of a line of
// text or an empty panel. Used on the three app tabs, where a blank screen
// during a fetch is what makes the app feel like a web page being waited on.
// The count is only ever a guess at how much is about to arrive — three is
// enough to fill the top of a phone screen without pretending to know more.
export function skeletonList(count = 3) {
  return `<div class="skeleton-list" aria-hidden="true">${
    '<div class="skeleton-card"></div>'.repeat(count)
  }</div>`
}
