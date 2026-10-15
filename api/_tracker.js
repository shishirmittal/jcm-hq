// Requests Tracker (2026-10-15, HQ Requests) — Admin → Requests Tracker (#tracker, src/tracker.js).
// One list of every bug, addition, removal, UI change and set-up step for HQ and the tools around it.
// Table hq_requests in the CRM project (RLS on, no policies; service key only). Served from
// api/sync-status.js (actions tracker-*) — no extra Vercel function. Page id 'tracker' (admins, or granted).
//
// Status: todo · doing · release (built, waiting for "release") · you (waiting on Shishir) · live · parked · dropped
// Chats that build something should add / update a row (Supabase → hq_requests) so the list stays true.
//
// Actions (POST JSON):  tracker-list · tracker-save {id?, title, detail, area, kind, status, owner, source}
//                       tracker-remove {id} · tracker-released (every 'release' row → 'live', after a release)

export const STATUSES = ['todo', 'doing', 'release', 'you', 'live', 'parked', 'dropped']
export const KINDS = ['Bug fix', 'New', 'Change', 'Removed', 'Setup', 'Decision', 'Check']
const DONE = new Set(['live', 'dropped'])

// The list as of 15 Oct 2026 (this chat + the earlier tracker sheet), put in the first time the page opens.
const SEED = [
  ['Requests Tracker page in HQ', 'Admin → Requests Tracker: every bug, addition, removal and change in one list, with search and filters.', 'HQ general', 'New', 'release', 'Claude', 'HQ Requests', '2026-10-15T18:10:00Z'],
  ['Staff alerts: brand invoices from email on WhatsApp', 'Email Purchase Summary → Brands & mails → WhatsApp to: staff, admins and outside numbers get each brand invoice PDF.', 'Purchase Summary', 'New', 'release', 'Claude', 'HQ Requests', '2026-10-15T09:42:00Z'],
  ['Staff alerts: sales invoice PDF by item group', 'WhatsApp → Invoice alerts: invoices with an item of a chosen group (e.g. Faber chimneys) go to chosen staff + outside numbers for installation / warranty. Template staff_invoice_copy approved 15 Oct.', 'WhatsApp', 'New', 'release', 'Claude', 'HQ Requests', '2026-10-14T08:00:00Z'],
  ['New sidebar layout', 'Daily pages on top, then Sales · Accounts · Warehouse · Purchase · Reports · Admin; one group open at a time.', 'Look & layout', 'Change', 'release', 'Claude', 'HQ UI chat', '2026-10-15T12:00:00Z'],
  ['Test the 17:30 material email with the new Resend key', 'Material → email panel → Send now; check it reaches all three inboxes.', 'Orders / Warehouse', 'Check', 'you', 'Shishir', 'HQ Requests', '2026-10-15T05:00:00Z'],
  ['Payment Follow-up: give every account group an owner', 'Assign groups screen; also set a default owner.', 'Payment Follow-up', 'Setup', 'you', 'Shishir', 'Payment Follow-up chat', '2026-10-13T12:00:00Z'],
  ['Decide when to switch on automatic payment reminders', 'Automatic WhatsApp reminders to customers are switched off.', 'Payment Follow-up', 'Decision', 'you', 'Shishir', 'Payment Follow-up chat', '2026-10-13T12:00:00Z'],
  ['Create the two GST WhatsApp templates', 'gstr1_filing_reminder and gst_mismatch_summary in WhatsApp Manager.', 'GST', 'Setup', 'you', 'Shishir', 'GSTR 2A chat', '2026-10-12T18:00:00Z'],
  ['Quotation header GSTIN — keep or remove?', '', 'Quotations', 'Decision', 'you', 'Shishir', 'HQ UI chat', '2026-10-12T12:00:00Z'],
  ['Ask AI needs an Anthropic API key in Vercel', '', 'HQ general', 'Setup', 'you', 'Shishir', 'HQ code notes', '2026-10-10T12:00:00Z'],
  ['GST: Registered Expense bills not matched', 'GST bills booked as journal / expense in Busy (e.g. Aadeshwar Sales) are not read — needs discovery queries in SSMS.', 'GST', 'Bug fix', 'parked', 'Shishir', 'GSTR 2A chat', '2026-10-12T18:00:00Z'],
  ['Invoice portal: challan numbers not showing on invoice PDFs', '', 'Invoice Portal', 'Bug fix', 'todo', 'Claude', 'Invoice portal chat', '2026-10-11T12:00:00Z'],
  ['Order Plan screens rework', 'Cards and a Needs-attention page; the screens felt hard to use.', 'Order Plan', 'Change', 'todo', 'Claude', 'Order plan chat', '2026-10-05T12:00:00Z'],
  ['TV board at board.jcmretails.com', 'Plan phase D.', 'Orders / Warehouse', 'New', 'parked', 'Claude', 'HQ code notes', '2026-10-10T12:00:00Z'],
  ['Switch staff from the old CRM + Orders apps to HQ', 'After the side-by-side check.', 'HQ general', 'Decision', 'parked', 'Shishir', 'HQ code notes', '2026-10-10T12:00:00Z'],
  ['Email invoices: evening summary, Hotmail, Excel attachments', '', 'Purchase Summary', 'New', 'parked', 'Claude', 'Email Purchase chat', '2026-10-15T06:00:00Z'],
  ['SO/2627/834 not sent on WhatsApp', 'The order has no mobile in Billing Details — fixed in Busy, nothing to build.', 'WhatsApp', 'Bug fix', 'dropped', 'Shishir', 'HQ Requests', '2026-10-14T10:00:00Z', '2026-10-15T18:07:00Z'],
  ['Quotation note (narration) from Busy', 'Busy quotations have no note field — skipped.', 'Quotations', 'Change', 'dropped', 'Claude', 'HQ Requests', '2026-10-15T07:00:00Z', '2026-10-15T18:07:00Z'],
  ['Ledger statement: credit balances shown as 0', 'Opening from the 31 March balance; credit shown as CREDIT IN YOUR FAVOUR; Customer Card ledger uses the same numbers.', 'Customer Card', 'Bug fix', 'live', 'Claude', 'HQ Requests', '2026-10-15T08:56:00Z', '2026-10-15T09:36:00Z'],
  ['Busy quotations: PDF + Send buttons; HQ section showing under From Busy', '', 'Quotations', 'Bug fix', 'live', 'Claude', 'HQ Requests', '2026-10-15T08:30:00Z', '2026-10-15T09:36:00Z'],
  ['Phone: alerts bell beside Stock refresh; clock icon → refresh', '', 'Phone app', 'Bug fix', 'live', 'Claude', 'HQ Requests', '2026-10-15T08:30:00Z', '2026-10-15T09:36:00Z'],
  ['Email Purchase Summary page (Gmail)', 'Brand invoices that arrive by email, read every 15 min.', 'Purchase Summary', 'New', 'live', 'Claude', 'Email Purchase chat', '2026-10-14T12:00:00Z', '2026-10-15T09:36:00Z'],
  ['Quotations from Busy', 'From Busy tab: list, detail, PDF, WhatsApp. Totals checked against Busy on 15 Oct.', 'Quotations', 'New', 'live', 'Claude', 'HQ Requests', '2026-10-15T03:00:00Z', '2026-10-15T06:30:00Z'],
  ['Last 3 Invoices reply skips cancelled bills', '', 'WhatsApp', 'Bug fix', 'live', 'Claude', 'HQ Requests', '2026-10-15T05:30:00Z', '2026-10-15T06:30:00Z'],
  ['17:30 material email sent by HQ (new design)', 'Timer moved from jcm-orders to HQ; sender setting added.', 'Orders / Warehouse', 'Change', 'live', 'Claude', 'HQ Requests', '2026-10-15T03:00:00Z', '2026-10-15T04:00:00Z'],
  ['Send invoice button on Customer Card bills', '', 'Customer Card', 'New', 'live', 'Claude', 'HQ Requests', '2026-10-15T03:00:00Z', '2026-10-15T04:00:00Z'],
  ['Ledger button on Payment Follow-up cards', '', 'Payment Follow-up', 'New', 'live', 'Claude', 'HQ Requests', '2026-10-15T03:00:00Z', '2026-10-15T04:00:00Z'],
  ['Orders page fresh start', 'All orders closed on 14 Oct; SO 770 / 772 / 773 / 821 / 825 reopened.', 'Orders / Warehouse', 'Change', 'live', 'Claude', 'HQ Requests', '2026-10-14T15:00:00Z', '2026-10-14T16:00:00Z'],
  ['WhatsApp: two mobiles in one field; receipts without button', 'First valid mobile is used; a template without the expected button is sent without it.', 'WhatsApp', 'Bug fix', 'live', 'Claude', 'HQ Requests', '2026-10-14T11:00:00Z', '2026-10-14T14:00:00Z'],
  ['Due List PDF reply to the staff morning message', '', 'Payment Follow-up', 'Bug fix', 'live', 'Claude', 'HQ Requests', '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z'],
  ['Tick boxes + "Send WhatsApp to N" on Follow-up calls tab', '', 'Payment Follow-up', 'New', 'live', 'Claude', 'HQ Requests', '2026-10-14T06:00:00Z', '2026-10-14T07:00:00Z'],
  ['Invoice portal: PDFs could be opened without login', 'Security fix — invoice PDFs needed only a mobile + invoice number.', 'Invoice Portal', 'Bug fix', 'live', 'Claude', 'HQ Requests', '2026-10-14T04:00:00Z', '2026-10-14T05:30:00Z'],
]

const clean = (v, n) => String(v ?? '').trim().slice(0, n) || null

export async function handleTracker(action, body, { hq, me }) {
  if (action === 'tracker-list') {
    let r = await hq.from('hq_requests').select('*').order('updated_at', { ascending: false }).limit(2000)
    if (r.error) throw r.error
    if (!r.data.length && !body.noSeed) {
      const rows = SEED.map(([title, detail, area, kind, status, owner, source, at, done]) => ({
        title, detail: detail || null, area, kind, status, owner, source, created_by: 'Shishir', created_at: at,
        updated_by: 'Claude', updated_at: done || at, done_at: done || null,
      }))
      const ins = await hq.from('hq_requests').insert(rows)
      if (ins.error) throw ins.error
      r = await hq.from('hq_requests').select('*').order('updated_at', { ascending: false }).limit(2000)
      if (r.error) throw r.error
    }
    return { rows: r.data, statuses: STATUSES, kinds: KINDS }
  }
  if (action === 'tracker-save') {
    const title = clean(body.title, 200)
    if (!title) throw Object.assign(new Error('Write what the request is first.'), { status: 400 })
    const status = STATUSES.includes(body.status) ? body.status : 'todo'
    const now = new Date().toISOString()
    const row = {
      title, detail: clean(body.detail, 4000), area: clean(body.area, 60), kind: KINDS.includes(body.kind) ? body.kind : 'Change',
      status, owner: clean(body.owner, 60), source: clean(body.source, 80), updated_by: me.name, updated_at: now,
    }
    const id = Number(body.id) || null
    if (id) {
      const cur = await hq.from('hq_requests').select('status, done_at').eq('id', id).maybeSingle()
      if (cur.error) throw cur.error
      if (!cur.data) throw Object.assign(new Error('That request is gone.'), { status: 404 })
      row.done_at = DONE.has(status) ? (DONE.has(cur.data.status) ? cur.data.done_at : now) : null
      const u = await hq.from('hq_requests').update(row).eq('id', id).select('*').single()
      if (u.error) throw u.error
      return { ok: true, row: u.data }
    }
    const i = await hq.from('hq_requests').insert({ ...row, created_by: me.name, done_at: DONE.has(status) ? now : null }).select('*').single()
    if (i.error) throw i.error
    return { ok: true, row: i.data }
  }
  if (action === 'tracker-remove') {
    const d = await hq.from('hq_requests').delete().eq('id', Number(body.id))
    if (d.error) throw d.error
    return { ok: true }
  }
  if (action === 'tracker-released') {
    const now = new Date().toISOString()
    const u = await hq.from('hq_requests').update({ status: 'live', done_at: now, updated_at: now, updated_by: me.name }).eq('status', 'release').select('id')
    if (u.error) throw u.error
    return { ok: true, count: (u.data || []).length }
  }
  throw Object.assign(new Error('Unknown request.'), { status: 400 })
}
