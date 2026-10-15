// Signify Cash Discount — what Signify owes JCM under its Cash Discount scheme
// (trade circular CD-CIRC-001, effective 1 Aug 2026): pay an invoice digitally within
// 0–5 days of the invoice date → 1.5% back, within 6–10 days → 1.0%, later → nothing.
// Signify applies payments FIFO (oldest invoice first) and gives the discount only on
// invoices that are fully cleared; the discount is on the GST-inclusive invoice value.
//
// Served from api/purchases.js (actions starting with "cd-") so no extra Vercel function is
// needed. Tables cd_ledger / cd_accounts / cd_settings in the Busy project, filled every
// 30 min by busy-sync/sync-cd-ledger.js on JCM-Server. All closed to the browser.
//
// Access: admins only (the page is grantable: false).
// Actions (POST JSON, via /api/purchases):
//   cd-summary  from, to, codes[]        invoices dated from–to on the chosen accounts, each with the
//                                        payment that cleared it (FIFO), days, slab and CD amount; totals
//   cd-settings-save  scheme_from, slab_a_days, slab_a_pct, slab_b_days, slab_b_pct, count_notes, name_match, name_exclude
//   cd-account-save   party_code, included, opening_balance, opening_note
//
// The dates here are Busy voucher dates. Signify decides the slab by the day the money
// reached ITS bank — a NEFT typed on the 5th and credited on the 6th is Slab B for them.

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
const r2 = n => Math.round(Number(n || 0) * 100) / 100
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
function fyStart(d = new Date(Date.now() + 5.5 * 3600e3)) {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1
  return `${y}-04-01`
}

function check({ data, error }, what) {
  if (error) { const e = new Error(`${what}: ${error.message}`); e.db = true; throw e }
  return data
}
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e }

async function fetchAll(client, table, build) {
  const out = []
  for (let from = 0; from < 200000; from += 1000) {
    const q = build(client.from(table).select('*')).range(from, from + 999)
    const rows = check(await q, table)
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

// ---------------------------------------------------------------------------
// The calculation for ONE account. Pure: ledger rows in, invoice rows out.
//   rows     : cd_ledger rows of this account (any order)
//   opening  : payable at the start of the year (positive = we owe them), or null/0
//   s        : cd_settings row
//   from, to : the invoice dates wanted in the answer (the FIFO always runs over the whole year)
// ---------------------------------------------------------------------------
export function calcAccount(rows, opening, s, from, to) {
  const countNotes = s.count_notes === true
  const start = fyStart()
  const sorted = [...rows].sort((a, b) => String(a.vch_date).localeCompare(String(b.vch_date)) || a.vch_code - b.vch_code || a.sr_no - b.sr_no)

  // Bills = anything that increases what we owe. Only purchase bills (VchType 2) can earn CD.
  const bills = []
  // Payments = what reduces it. Payment vouchers always; debit notes / returns / journals only if asked.
  const pays = []
  const ignored = [] // debits left out of the FIFO (shown so the figures can be tied to Busy)
  const op = r2(opening || 0)
  if (op > 0) bills.push({ kind: 'opening', date: start, no: 'Opening balance (1 Apr)', amount: op, remaining: op, cdOk: false, type: 0 })
  if (op < 0) pays.push({ kind: 'opening', date: start, no: 'Opening advance (1 Apr)', amount: -op, remaining: -op, type: 0 })

  for (const r of sorted) {
    const cr = r2(r.credit), dr = r2(r.debit)
    if (cr > 0) bills.push({ kind: r.vch_type === 2 ? 'purchase' : 'other', date: r.vch_date, no: r.vch_no || '', amount: cr, remaining: cr, cdOk: r.vch_type === 2, type: r.vch_type, typeName: r.vch_type_name, vch_code: r.vch_code })
    if (dr > 0) {
      const p = { kind: r.vch_type === 19 ? 'payment' : 'note', date: r.vch_date, no: r.vch_no || '', amount: dr, remaining: dr, type: r.vch_type, typeName: r.vch_type_name, vch_code: r.vch_code }
      if (p.kind === 'payment' || countNotes) pays.push(p); else ignored.push(p)
    }
  }
  bills.sort((a, b) => a.date.localeCompare(b.date) || (a.vch_code || 0) - (b.vch_code || 0))
  pays.sort((a, b) => a.date.localeCompare(b.date) || (a.vch_code || 0) - (b.vch_code || 0))

  // FIFO: each payment goes to the oldest bill still open.
  let bi = 0
  for (const p of pays) {
    while (p.remaining > 0.004 && bi < bills.length) {
      const b = bills[bi]
      if (b.remaining <= 0.004) { bi++; continue }
      const take = r2(Math.min(p.remaining, b.remaining))
      b.remaining = r2(b.remaining - take)
      p.remaining = r2(p.remaining - take)
      ;(b.parts ||= []).push({ date: p.date, no: p.no, amount: p.amount, applied: take, kind: p.kind, typeName: p.typeName })
      if (b.remaining <= 0.004) { b.settledBy = p; bi++ }
    }
  }

  const schemeFrom = String(s.scheme_from || '2026-08-01')
  const aDays = Number(s.slab_a_days ?? 5), bDays = Number(s.slab_b_days ?? 10)
  const aPct = Number(s.slab_a_pct ?? 1.5), bPct = Number(s.slab_b_pct ?? 1.0)

  const out = []
  for (const b of bills) {
    if (b.kind === 'opening') continue
    if (b.date < from || b.date > to) continue
    const row = {
      date: b.date, vch_no: b.no, amount: b.amount, kind: b.kind, type_name: b.typeName,
      settled: !!b.settledBy, remaining: b.remaining,
      pay_date: b.settledBy ? b.settledBy.date : null,
      pay_no: b.settledBy ? b.settledBy.no : null,
      pay_amount: b.settledBy ? b.settledBy.amount : null,
      pay_kind: b.settledBy ? b.settledBy.kind : null,
      parts: (b.parts || []).length,
      days: b.settledBy ? dayDiff(b.date, b.settledBy.date) : null,
      pct: 0, cd: 0, slab: null, status: '',
    }
    if (b.kind !== 'purchase') row.status = `${b.typeName || 'Not a purchase bill'} — no CD`
    else if (b.date < schemeFrom) row.status = 'Before the scheme'
    else if (!b.settledBy) row.status = b.parts ? `Part paid — ${b.remaining.toFixed(2)} still open` : 'Not paid yet'
    else if (row.days <= aDays) { row.slab = 'A'; row.pct = aPct; row.status = `Slab A (${aPct}%)` }
    else if (row.days <= bDays) { row.slab = 'B'; row.pct = bPct; row.status = `Slab B (${bPct}%)` }
    else row.status = `Paid after day ${bDays} — no CD`
    if (row.days != null && row.days < 0) { row.pct = 0; row.slab = null; row.status = 'Paid before the bill date (advance) — check' }
    row.cd = r2(b.amount * row.pct / 100)
    out.push(row)
  }

  const totalCr = r2(sorted.reduce((s, r) => s + Number(r.credit || 0), 0))
  const totalDr = r2(sorted.reduce((s, r) => s + Number(r.debit || 0), 0))
  const openBills = bills.filter(b => b.remaining > 0.004 && b.kind !== 'opening')
  return {
    rows: out,
    opening: op,
    totals: { credits: totalCr, debits: totalDr, closing: r2(op + totalCr - totalDr) },
    open_bills: openBills.length, open_amount: r2(openBills.reduce((s, b) => s + b.remaining, 0)),
    unapplied: r2(pays.reduce((s, p) => s + p.remaining, 0)),      // payments with nothing left to clear (advance)
    ignored: ignored.map(p => ({ date: p.date, no: p.no, amount: p.amount, type_name: p.typeName })),
    entries: sorted.length,
  }
}

// ---------------------------------------------------------------------------
async function summary(busy, body) {
  const from = isDate(body.from) ? body.from : null
  const to = isDate(body.to) ? body.to : null
  if (!from || !to || from > to) fail(400, 'Pick a from and to date.')
  const s = check(await busy.from('cd_settings').select('*').eq('id', 1).maybeSingle(), 'cd_settings') || {}
  const accounts = check(await busy.from('cd_accounts').select('*').order('party_name'), 'cd_accounts')
  const wanted = Array.isArray(body.codes) && body.codes.length
    ? accounts.filter(a => body.codes.map(String).includes(String(a.party_code)))
    : accounts.filter(a => a.included !== false)
  const codes = wanted.map(a => a.party_code)

  const anchors = codes.length ? check(await busy.from('party_anchor_balance').select('party_code, anchor_balance, anchor_date').in('party_code', codes.map(Number).filter(n => !Number.isNaN(n))), 'party_anchor_balance') : []
  const anchorOf = new Map(anchors.map(a => [String(a.party_code), a]))
  const ledger = codes.length ? await fetchAll(busy, 'cd_ledger', q => q.in('party_code', codes)) : []
  const byCode = new Map()
  for (const r of ledger) { if (!byCode.has(r.party_code)) byCode.set(r.party_code, []); byCode.get(r.party_code).push(r) }

  const result = []
  for (const a of wanted) {
    const anchor = anchorOf.get(String(a.party_code))
    // party_anchor_balance is receivable-positive; for a supplier a negative figure = we owe them.
    let opening = 0, openingSource = 'none'
    if (a.opening_balance != null) { opening = Number(a.opening_balance); openingSource = 'typed' }
    else if (anchor) { opening = -Number(anchor.anchor_balance || 0); openingSource = 'busy' }
    const calc = calcAccount(byCode.get(a.party_code) || [], opening, s, from, to)
    result.push({ party_code: a.party_code, party_name: a.party_name, included: a.included !== false, opening_note: a.opening_note || '', opening_source: openingSource, ...calc })
  }
  const all = result.flatMap(a => a.rows)
  const totals = {
    invoices: all.filter(r => r.kind === 'purchase').length,
    amount: r2(all.filter(r => r.kind === 'purchase').reduce((s, r) => s + r.amount, 0)),
    cd: r2(all.reduce((s, r) => s + r.cd, 0)),
    slab_a: all.filter(r => r.slab === 'A').length, slab_a_cd: r2(all.filter(r => r.slab === 'A').reduce((s, r) => s + r.cd, 0)),
    slab_b: all.filter(r => r.slab === 'B').length, slab_b_cd: r2(all.filter(r => r.slab === 'B').reduce((s, r) => s + r.cd, 0)),
    none: all.filter(r => r.kind === 'purchase' && r.settled && !r.slab).length,
    unpaid: all.filter(r => r.kind === 'purchase' && !r.settled).length,
  }
  return { from, to, settings: s, accounts, result, totals, lastSyncAt: s.last_sync_at || null, lastSyncNote: s.last_sync_note || null, fyStart: fyStart() }
}

async function settingsSave(busy, body) {
  const patch = {}
  if (isDate(body.scheme_from)) patch.scheme_from = body.scheme_from
  for (const k of ['slab_a_days', 'slab_b_days']) if (body[k] != null && Number.isInteger(Number(body[k]))) patch[k] = Number(body[k])
  for (const k of ['slab_a_pct', 'slab_b_pct']) if (body[k] != null && !Number.isNaN(Number(body[k]))) patch[k] = Number(body[k])
  if (typeof body.count_notes === 'boolean') patch.count_notes = body.count_notes
  for (const k of ['name_match', 'name_exclude']) if (typeof body[k] === 'string') patch[k] = body[k].trim().slice(0, 200)
  if (typeof body.email_signature === 'string' && body.email_signature.trim()) patch.email_signature = body.email_signature.trim().slice(0, 300)
  if (!Object.keys(patch).length) fail(400, 'Nothing to save.')
  check(await busy.from('cd_settings').update(patch).eq('id', 1), 'cd_settings')
  return { ok: true }
}

async function accountSave(busy, body) {
  const code = String(body.party_code || '')
  if (!code) fail(400, 'Which account?')
  const patch = {}
  if (typeof body.included === 'boolean') patch.included = body.included
  if ('opening_balance' in body) patch.opening_balance = body.opening_balance === null || body.opening_balance === '' ? null : Number(body.opening_balance)
  if (typeof body.opening_note === 'string') patch.opening_note = body.opening_note.trim().slice(0, 300)
  if (!Object.keys(patch).length) fail(400, 'Nothing to save.')
  check(await busy.from('cd_accounts').update(patch).eq('party_code', code), 'cd_accounts')
  return { ok: true }
}

// ---------------------------------------------------------------------------
// "Send to Signify": the same calculation as an Excel attachment + a short summary in the
// mail body, through Resend (RESEND_API_KEY, from CD_EMAIL_FROM or ORDERS_EMAIL_FROM — the
// same values the 17:30 orders email uses). To = cd_settings.email_to (edited on the page),
// CC = cd_settings.email_cc (jc.mittal@hotmail.com, always). Every attempt is logged.
// ---------------------------------------------------------------------------
const RESEND_URL = 'https://api.resend.com/emails'
const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim())
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const niceDate = s => s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''
const inr = n => '₹' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const monthOf = (from, to) => {
  const f = new Date(`${from}T00:00:00Z`), t = new Date(`${to}T00:00:00Z`)
  const lastDay = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0)).getUTCDate()
  const whole = f.getUTCDate() === 1 && t.getUTCMonth() === f.getUTCMonth() && t.getUTCFullYear() === f.getUTCFullYear() && t.getUTCDate() === lastDay
  return whole ? f.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : `${niceDate(from)} to ${niceDate(to)}`
}

export function emailReady(env = process.env) {
  return { ready: !!env.RESEND_API_KEY, from: env.CD_EMAIL_FROM || env.ORDERS_EMAIL_FROM || 'JCM HQ <onboarding@resend.dev>' }
}

async function buildExcelBase64(d) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  const lines = []
  for (const a of d.result) {
    for (const r of a.rows) lines.push({ Account: a.party_name, 'Invoice date': niceDate(r.date), 'Invoice no.': r.vch_no || '', 'Invoice amount (incl. GST)': r.amount, 'Payment date': r.pay_date ? niceDate(r.pay_date) : '', 'Payment no.': r.pay_no || '', 'Payment amount': r.pay_amount ?? '', Days: r.days ?? '', 'CD %': r.pct, 'CD amount': r.cd, Status: r.status })
    const purchases = a.rows.filter(r => r.kind === 'purchase')
    lines.push({ Account: `Total — ${a.party_name}`, 'Invoice no.': `${purchases.length} invoices`, 'Invoice amount (incl. GST)': r2(purchases.reduce((s, r) => s + r.amount, 0)), 'CD amount': r2(a.rows.reduce((s, r) => s + r.cd, 0)) })
    lines.push({})
  }
  const t = d.totals
  lines.push({ Account: 'GRAND TOTAL', 'Invoice no.': `${t.invoices} invoices`, 'Invoice amount (incl. GST)': t.amount, 'CD amount': t.cd, Status: `Slab A ${t.slab_a} · Slab B ${t.slab_b} · late ${t.none} · unpaid ${t.unpaid}` })
  const ws = XLSX.utils.json_to_sheet([])
  XLSX.utils.sheet_add_aoa(ws, [[`Signify Cash Discount claim — ${monthOf(d.from, d.to)}`], ['J.C. Mittal & Sons, Ratlam — as per circular CD-CIRC-001 (Slab A 0–5 days 1.5%, Slab B 6–10 days 1.0%, FIFO, GST-inclusive)'], [`Figures from Busy as of ${d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}`], []], { origin: 'A1' })
  XLSX.utils.sheet_add_json(ws, lines, { origin: 'A5' })
  ws['!cols'] = [{ wch: 44 }, { wch: 13 }, { wch: 20 }, { wch: 22 }, { wch: 13 }, { wch: 20 }, { wch: 16 }, { wch: 6 }, { wch: 6 }, { wch: 14 }, { wch: 34 }]
  XLSX.utils.book_append_sheet(wb, ws, 'CD claim')
  const sum = d.result.map(a => ({ Account: a.party_name, 'Busy code': a.party_code, Invoices: a.rows.filter(r => r.kind === 'purchase').length, 'Invoice total': r2(a.rows.filter(r => r.kind === 'purchase').reduce((s, r) => s + r.amount, 0)), 'CD amount': r2(a.rows.reduce((s, r) => s + r.cd, 0)) }))
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sum), 'Summary')
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' })
}

function buildMail(d, message, signature) {
  const t = d.totals
  const period = monthOf(d.from, d.to)
  const th = 'style="text-align:left;padding:6px 10px;background:#F6F7FB;font-size:12px;color:#6B7280"'
  const td = 'style="padding:6px 10px;border-top:1px solid #E5E7EB;font-size:14px"'
  const tdr = td.replace('font-size', 'text-align:right;font-size')
  const rows = d.result.map(a => {
    const p = a.rows.filter(r => r.kind === 'purchase')
    return `<tr><td ${td}>${escHtml(a.party_name)}</td><td ${tdr}>${p.length}</td><td ${tdr}>${inr(p.reduce((s, r) => s + r.amount, 0))}</td><td ${tdr}>${inr(a.rows.reduce((s, r) => s + r.cd, 0))}</td></tr>`
  }).join('')
  const sig = String(signature || '').split('\n').map(l => escHtml(l)).join('<br>')
  const html = `<div style="font-family:Arial,sans-serif;color:#111;max-width:720px;font-size:14px;line-height:1.5">
    <p>Dear Sir,</p>
    <p>Please find attached our Cash Discount calculation for <b>${escHtml(period)}</b> under the Cash Discount Scheme (Ref. CD-CIRC-001), worked out invoice-wise on FIFO basis from our books.</p>
    ${message ? `<p>${escHtml(message).replace(/\n/g, '<br>')}</p>` : ''}
    <table style="border-collapse:collapse;width:100%;border:1px solid #E5E7EB"><tr><th ${th}>ACCOUNT</th><th ${th} align="right">INVOICES</th><th ${th} align="right">INVOICE VALUE</th><th ${th} align="right">CASH DISCOUNT</th></tr>${rows}
    <tr><td ${td}><b>Total</b></td><td ${tdr}><b>${t.invoices}</b></td><td ${tdr}><b>${inr(t.amount)}</b></td><td ${tdr}><b>${inr(t.cd)}</b></td></tr></table>
    <p style="font-size:13px;color:#5A606C">Slab A (0–5 days, 1.5%): ${t.slab_a} invoices, ${inr(t.slab_a_cd)} · Slab B (6–10 days, 1.0%): ${t.slab_b} invoices, ${inr(t.slab_b_cd)}. Invoice-wise details, payment dates and days are in the attached Excel.</p>
    <p>Kindly verify and pass the credit entries accordingly. Do let us know of any difference so it can be reconciled.</p>
    <p>Thanks &amp; regards,<br>${sig}<br>J.C. Mittal &amp; Sons, Ratlam</p>
  </div>`
  return { subject: `Cash Discount claim — ${period} — J.C. Mittal & Sons, Ratlam (${inr(t.cd)})`, html, period }
}

async function sendMail(busy, body, me) {
  const d = await summary(busy, body)
  const s = d.settings
  const to = (Array.isArray(s.email_to) ? s.email_to : []).filter(isEmail)
  const cc = String(s.email_cc || '').split(/[,;\s]+/).filter(isEmail)
  if (!to.length) fail(400, 'Add at least one email address to send to.')
  if (!d.totals.invoices) fail(400, 'There are no Signify invoices in this date range — nothing to send.')
  const { ready, from } = emailReady()
  const mail = buildMail(d, String(body.message || '').trim().slice(0, 2000), s.email_signature)
  const logRow = { sent_by: me?.name || null, from_date: d.from, to_date: d.to, to_emails: to, cc_emails: cc, subject: mail.subject, total_cd: d.totals.cd, invoices: d.totals.invoices }
  if (!ready) {
    check(await busy.from('cd_email_log').insert({ ...logRow, status: 'not_sent', detail: 'RESEND_API_KEY is not set in Vercel' }), 'cd_email_log')
    fail(500, 'Email is not set up in Vercel yet (RESEND_API_KEY). Nothing was sent.')
  }
  const file = await buildExcelBase64(d)
  let status = 'failed', detail = ''
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, cc, subject: mail.subject, html: mail.html, attachments: [{ filename: `Signify_CD_${d.from}_to_${d.to}.xlsx`, content: file }] }),
    })
    const text = (await res.text()).slice(0, 300)
    status = res.ok ? 'sent' : 'failed'
    detail = res.ok ? `to ${to.join(', ')}${cc.length ? ` cc ${cc.join(', ')}` : ''}` : `Resend said ${res.status}: ${text}`
  } catch (err) { detail = err.message }
  check(await busy.from('cd_email_log').insert({ ...logRow, status, detail }), 'cd_email_log')
  if (status !== 'sent') fail(500, `The email could not be sent — ${detail}`)
  return { ok: true, to, cc, subject: mail.subject }
}

async function emailLog(busy) {
  const rows = check(await busy.from('cd_email_log').select('*').order('sent_at', { ascending: false }).limit(20), 'cd_email_log')
  return { rows, email: emailReady() }
}

async function emailsSave(busy, body) {
  const list = (Array.isArray(body.email_to) ? body.email_to : []).map(x => String(x).trim().toLowerCase()).filter(isEmail)
  check(await busy.from('cd_settings').update({ email_to: [...new Set(list)] }).eq('id', 1), 'cd_settings')
  return { ok: true, email_to: [...new Set(list)] }
}

export async function handleCdAction(action, body, { busy, send, res, me }) {
  if (action === 'cd-summary') { const d = await summary(busy, body); return send(res, 200, { ...d, email: emailReady() }) }
  if (action === 'cd-settings-save') return send(res, 200, await settingsSave(busy, body))
  if (action === 'cd-account-save') return send(res, 200, await accountSave(busy, body))
  if (action === 'cd-emails-save') return send(res, 200, await emailsSave(busy, body))
  if (action === 'cd-send') return send(res, 200, await sendMail(busy, body, me))
  if (action === 'cd-email-log') return send(res, 200, await emailLog(busy))
  return send(res, 400, { error: 'Unknown request.' })
}
