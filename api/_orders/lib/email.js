import { must } from './db.js'
import { materialOverview } from './material.js'

// The 17:30 email: items still to order (by supplier), items ordered but late,
// and parties waiting for material — the same picture as /owner.
// Sent through Resend only when RESEND_API_KEY and ORDERS_REPORT_EMAIL are set
// in Vercel; otherwise each run is recorded as not sent.
const RESEND_URL = 'https://api.resend.com/emails'
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const fmtDay = day => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(`${day}T12:00:00Z`))

export function emailSettings(env = process.env) {
  const to = String(env.ORDERS_REPORT_EMAIL || '').split(/[,;\s]+/).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))
  const from = env.ORDERS_EMAIL_FROM || 'JCM Orders <onboarding@resend.dev>'
  const ready = !!env.RESEND_API_KEY && to.length > 0
  const reason = ready ? '' : !env.RESEND_API_KEY ? 'RESEND_API_KEY is not set in Vercel' : 'ORDERS_REPORT_EMAIL is not set in Vercel'
  return { ready, to, from, apiKey: env.RESEND_API_KEY || '', reason }
}

export function buildEmail(overview) {
  const { today, items } = overview
  // Orders waiting for material (the amber band — short items, still in NEW / PICKING — is left out here).
  const parties = overview.parties.filter(p => !p.floor)
  const all = items.flatMap(g => g.items.map(i => ({ ...i, supplier: g.supplier })))
  const toOrder = all.filter(i => !i.orderedAt)
  const late = all.filter(i => i.orderedAt && i.late)
  const red = parties.filter(p => p.status === 'red')
  const th = 'style="text-align:left;padding:6px 10px;background:#F1ECE0;font-size:12px;letter-spacing:.04em;color:#3E4553"'
  const td = 'style="padding:6px 10px;border-top:1px solid #ECE6D8;font-size:14px;vertical-align:top"'
  const h2 = t => `<h2 style="font-size:18px;color:#12213B;margin:24px 0 8px">${t}</h2>`
  const who = i => (i.orders.length ? i.orders.map(o => o.name) : i.forParties).join(', ')
  const parts = [`<div style="font-family:Arial,sans-serif;color:#0C111B;max-width:720px">
    <div style="background:#12213B;color:#FFFFFF;padding:14px 18px;border-bottom:3px solid #D9AE55;font-size:20px;font-weight:bold">JCM Orders — ${esc(fmtDay(today))}</div>`]

  parts.push(h2('Items to order'))
  if (!toOrder.length) parts.push('<p style="font-size:14px">Nothing left to order.</p>')
  const bySupplier = new Map()
  for (const i of toOrder) bySupplier.set(i.supplier, [...(bySupplier.get(i.supplier) || []), i])
  for (const [supplier, list] of bySupplier) {
    parts.push(`<p style="font-size:15px;font-weight:bold;margin:14px 0 4px">${esc(supplier)}</p>
      <table style="border-collapse:collapse;width:100%;border:1px solid #E2DCCD"><tr><th ${th}>ITEM</th><th ${th}>SHORT</th><th ${th}>FOR</th></tr>
      ${list.map(i => `<tr><td ${td}>${esc(i.item)}</td><td ${td}>${esc(i.short)}</td><td ${td}>${esc(who(i))}</td></tr>`).join('')}
      </table>`)
  }

  parts.push(h2('Ordered but late'))
  parts.push(late.length
    ? `<table style="border-collapse:collapse;width:100%;border:1px solid #E2DCCD"><tr><th ${th}>ITEM</th><th ${th}>SUPPLIER</th><th ${th}>EXPECTED</th><th ${th}>FOR</th></tr>
      ${late.map(i => `<tr><td ${td}>${esc(i.item)}</td><td ${td}>${esc(i.supplier)}</td><td ${td}>${esc(fmtDay(i.expectedDate))}</td><td ${td}>${esc(who(i))}</td></tr>`).join('')}</table>`
    : '<p style="font-size:14px">None.</p>')

  parts.push(h2('Parties waiting for material'))
  parts.push(parties.length
    ? `<ul style="font-size:14px;padding-left:18px">${parties.map(p => `<li><b>${esc(p.name)}</b> (${esc(p.soNo)}) — ${p.status === 'red' ? '<span style="color:#C2452D">not all ordered</span>' : `expected ${esc(fmtDay(p.expectedDate || today))}`}: ${esc(p.pending.map(l => `${l.item} short ${l.short} of ${l.ordered}`).join(', '))}</li>`).join('')}</ul>
       <p style="font-size:14px">Mark items ordered on <a href="https://orders.jcmretails.com/owner">orders.jcmretails.com/owner</a>.</p>`
    : '<p style="font-size:14px">None.</p>')
  parts.push('<p style="font-size:12px;color:#5A606C;margin-top:24px">Sent by JCM Orders at 17:30.</p></div>')

  return {
    subject: `JCM Orders ${fmtDay(today)} — ${toOrder.length} item${toOrder.length === 1 ? '' : 's'} to order, ${late.length} late, ${red.length} ${red.length === 1 ? 'party' : 'parties'} not covered`,
    html: parts.join('\n'),
  }
}

export async function runDailyEmail(dbc, { env = process.env, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const email = buildEmail(await materialOverview(dbc, now))
  const s = emailSettings(env)
  const log = async (status, detail) => {
    await must(dbc.from('orders_email_log').insert({ recipient: s.to.join(', ') || null, status, detail: String(detail || '').slice(0, 500) }), 'recording email')
    return { status, detail, ...email }
  }
  if (!s.ready) return log('not_sent', s.reason)
  try {
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: s.from, to: s.to, subject: email.subject, html: email.html }),
    })
    const text = (await res.text()).slice(0, 300)
    return log(res.ok ? 'sent' : 'failed', res.ok ? `to ${s.to.join(', ')}` : `Resend said ${res.status}: ${text}`)
  } catch (err) {
    return log('failed', err.message)
  }
}
