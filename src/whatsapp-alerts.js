// WhatsApp → Invoice alerts (#whatsapp/alerts, 2026-10-15): per Busy item group, who gets the SALES
// invoice PDF on WhatsApp when a bill holds one of its items (installation / warranty registration).
// Server: api/whatsapp.js alerts-get / alert-save / alert-remove → api/_staff-alerts.js.
import { esc } from './utils.js'
import { callWhatsapp as call } from './whatsapp.js'
import { pickRecipients, recipientsText } from './alert-recipients.js'

const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''
const STATUS = { pending: ['Waiting', 'amb'], sending: ['Sending', 'amb'], sent: ['Sent', 'grn'], partly: ['Partly sent', 'amb'], failed: ['Failed', 'red'], expired: ['Not sent (24 h)', 'grey'], no_one: ['Nobody to send to', 'grey'] }

export function renderInvoiceAlerts(el) {
  let data = null
  el.innerHTML = '<div class="loading-state">Loading…</div>'

  async function load() {
    try { data = await call({ action: 'alerts-get' }); draw() }
    catch (err) { el.innerHTML = `<div class="empty-state">${esc(err.message)}</div>` }
  }

  function draw() {
    const { rules, people, log, template } = data
    el.innerHTML = `
      <div class="wa-card">
        <div class="wa-row" style="justify-content:space-between">
          <div><strong>Invoice alerts by item group</strong>
            <div class="wa-muted">When a sales invoice has an item from one of these groups (or a group under it), the people below get the invoice PDF on WhatsApp — for installation or warranty registration. Starts with bills made after the rule is saved; each bill goes once.</div></div>
          <button type="button" class="btn-primary btn-small" id="walAdd">+ Add item group</button>
        </div>
        <div class="wa-muted" style="margin-top:6px">Message: template <code>${esc(template)}</code> (WhatsApp → Templates shows if it is approved). Until it is approved, alerts wait up to 24 h.</div>
      </div>
      <div class="wa-card">
        ${rules.length ? `<div class="wal-rules">${rules.map(r => `
          <div class="wal-rule ${r.enabled ? '' : 'is-off'}">
            <div class="wal-main">
              <b>${esc(r.group_path.split(' > ').pop())}</b>
              <div class="wa-muted">${esc(r.group_path)}</div>
              <div>${esc(recipientsText(r.profile_ids, r.extra_numbers, people))}</div>
              ${(r.extra_numbers || []).length ? `<div class="wa-muted">${r.extra_numbers.map(n => esc(`${n.name || 'Number'} ${String(n.number).slice(-10)}`)).join(' · ')}</div>` : ''}
              ${r.note ? `<div class="wa-muted">“${esc(r.note)}”</div>` : ''}
            </div>
            <div class="wal-side">
              <label class="wal-switch"><input type="checkbox" data-on="${r.id}" ${r.enabled ? 'checked' : ''}> On</label>
              <button type="button" class="btn-ghost btn-small" data-edit="${r.id}">Edit</button>
            </div>
          </div>`).join('')}</div>` : '<div class="empty-state">No item groups yet. Tap “Add item group”.</div>'}
      </div>
      <div class="wa-card">
        <strong>Recent alerts</strong>
        <div class="wa-table">${log.length ? `<table><thead><tr><th>When</th><th>Invoice</th><th>Customer</th><th>Group · items</th><th>Status</th></tr></thead><tbody>
          ${log.map(a => { const [t, tone] = STATUS[a.status] || [a.status, 'grey']; return `<tr><td>${esc(when(a.created_at))}</td><td>${esc(a.vch_no)}</td><td>${esc(a.party_name || '')}<div class="wa-muted">${esc(a.mobile || '')}</div></td><td>${esc(String(a.group_path || '').split(' > ').pop())}<div class="wa-muted">${esc(a.lines || '')}</div></td><td><span class="pf-pill pf-tone-${tone}">${esc(t)}</span>${a.recipients ? `<div class="wa-muted">${a.sent} of ${a.recipients}</div>` : ''}${a.error ? `<div class="wa-err">${esc(a.error)}</div>` : ''}</td></tr>` }).join('')}
        </tbody></table>` : '<div class="empty-state">No alerts sent yet.</div>'}</div>
      </div>`
    el.querySelector('#walAdd').addEventListener('click', () => edit(null))
    el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => edit(data.rules.find(r => r.id === Number(b.dataset.edit)))))
    el.querySelectorAll('[data-on]').forEach(box => box.addEventListener('change', async () => {
      const r = data.rules.find(x => x.id === Number(box.dataset.on))
      try { await call({ action: 'alert-save', id: r.id, group_path: r.group_path, profile_ids: r.profile_ids, extra_numbers: r.extra_numbers, note: r.note, enabled: box.checked }); r.enabled = box.checked; box.closest('.wal-rule').classList.toggle('is-off', !box.checked) }
      catch (err) { box.checked = !box.checked; alert(err.message) }
    }))
  }

  async function edit(rule) {
    const used = new Set(data.rules.filter(r => r !== rule).map(r => r.group_path))
    const opts = data.groups.filter(g => !used.has(g.full_path))
    const top = `
      <div class="ar-top">
        <h4 class="ar-h">Item group</h4>
        <input type="search" data-g-q placeholder="Search item groups (e.g. chimney, Faber, Daikin)" ${rule ? 'hidden' : ''}>
        <select data-g size="${rule ? 1 : 6}" ${rule ? 'disabled' : ''}>${(rule ? [{ full_path: rule.group_path }] : opts).map(g => `<option value="${esc(g.full_path)}" ${rule && g.full_path === rule.group_path ? 'selected' : ''}>${esc(g.full_path)}</option>`).join('')}</select>
        <div class="ar-sub">Items in groups under the one you pick count too.</div>
        <input data-g-note placeholder="Note (optional) — e.g. installation booking with Faber" value="${esc(rule?.note || '')}" maxlength="200">
      </div>`
    await pickRecipients({
      title: rule ? 'Edit invoice alert' : 'New invoice alert', subtitle: 'Who gets the sales invoice PDF on WhatsApp',
      people: data.people, profileIds: rule?.profile_ids || [], numbers: rule?.extra_numbers || [], extraTop: top,
      onReady: ov => {
        const q = ov.querySelector('[data-g-q]'), sel = ov.querySelector('[data-g]')
        q?.addEventListener('input', () => {
          const t = q.value.trim().toLowerCase()
          sel.innerHTML = opts.filter(g => !t || g.full_path.toLowerCase().includes(t)).map(g => `<option value="${esc(g.full_path)}">${esc(g.full_path)}</option>`).join('')
        })
      },
      onSave: async ({ profile_ids, extra_numbers, root }) => {
        const group_path = root.querySelector('[data-g]').value
        if (!group_path) throw new Error('Pick an item group first.')
        await call({ action: 'alert-save', id: rule?.id, group_path, profile_ids, extra_numbers, note: root.querySelector('[data-g-note]').value, enabled: rule ? rule.enabled : true })
      },
      onRemove: rule ? async () => { await call({ action: 'alert-remove', id: rule.id }) } : null,
    }).then(v => { if (v) load() })
  }

  load()
  return { refresh: load }
}
