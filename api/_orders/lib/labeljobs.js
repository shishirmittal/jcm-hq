import { must } from './db.js'
import { hindiFor, readLabelLanguage } from './hindi.js'

// Carton labels go to the TVS network label printer through a queue:
// the tablet adds a row to label_print_jobs; print-agent.js on JCM-Server
// (busy-sync/print-agent.js) picks it up within 5 seconds, prints one label
// per box and marks the row printed or failed (with the reason).
// The agent also records the label_printed history entry.
//
// With the label language set to English + Hindi (/admin, the default) the row
// also carries the party name and city in Devanagari (party_hindi, made once and
// reused — _lib/hindi.js). If the Hindi cannot be had, the label prints in English.
export const AGENT_SLOW_SECONDS = 30 // queued longer than this: the agent is probably not running

// boxNumbers: REPRINT only these boxes (each still printed "n of N"); none = every box.
export async function queueLabels(dbc, orderId, me, device, { reprint = false, boxNumbers = null } = {}) {
  const o = await must(dbc.from('orders').select('id, so_vch_no, invoice_vch_no, party_name, party_address, party_city, party_mobile, party_gstin, boxes').eq('id', orderId).maybeSingle(), 'reading order')
  if (!o) return { status: 404, error: 'That order is no longer open.' }
  if (!o.boxes) return { status: 400, error: 'Enter the number of boxes first.' }
  let only = null
  if (Array.isArray(boxNumbers) && boxNumbers.length) {
    only = [...new Set(boxNumbers.map(Number))].sort((a, b) => a - b)
    if (!only.every(n => Number.isInteger(n) && n >= 1 && n <= o.boxes)) return { status: 400, error: `Choose boxes between 1 and ${o.boxes}.` }
    if (only.length === o.boxes) only = null // all of them
  }
  const row = {
    order_id: o.id, so_vch_no: o.so_vch_no, invoice_vch_no: o.invoice_vch_no, party_name: o.party_name, party_address: o.party_address,
    party_city: o.party_city, party_mobile: o.party_mobile, party_gstin: o.party_gstin, boxes: o.boxes, reprint,
    requested_by: me.id, device_id: device ? device.id : null,
    ...(only ? { box_numbers: only } : {}),
  }
  let hindi = {}
  try {
    const language = await readLabelLanguage(dbc)
    hindi = { language }
    if (language === 'en_hi') {
      const h = await hindiFor(dbc, { name: o.party_name, city: o.party_city })
      hindi.party_name_hi = h.nameHi
      hindi.party_city_hi = h.cityHi
    }
  } catch (err) {
    console.warn(`Label Hindi skipped: ${err.message}`) // never stops the labels
  }
  let { data, error } = await dbc.from('label_print_jobs').insert({ ...row, ...hindi }).select('id').maybeSingle()
  // Before the Phase 10 SQL is run the Hindi columns do not exist: queue in English.
  if (error && /party_name_hi|party_city_hi|language/.test(error.message)) {
    ({ data, error } = await dbc.from('label_print_jobs').insert(row).select('id').maybeSingle())
  }
  if (error && /box_numbers/.test(error.message)) {
    return { status: 503, error: 'Reprinting chosen boxes needs the database script phase 10. Choose All for now.' }
  }
  if (error) {
    console.error('Could not queue labels:', error.message)
    return { status: 503, error: /label_print_jobs/.test(error.message) ? 'Label printing is not set up yet (database script phase 8 has not been run).' : 'The labels could not be sent to the printer queue. Try REPRINT.' }
  }
  return { status: 200, jobId: data.id, boxes: o.boxes, boxNumbers: only }
}

export async function jobStatus(dbc, id) {
  const COLS = 'id, order_id, boxes, status, error, created_at, finished_at'
  let { data: j, error } = await dbc.from('label_print_jobs').select(`${COLS}, box_numbers`).eq('id', Number(id) || 0).maybeSingle()
  // Before the Phase 10 SQL there is no box_numbers column: read without it.
  if (error && /box_numbers/.test(error.message)) j = await must(dbc.from('label_print_jobs').select(COLS).eq('id', Number(id) || 0).maybeSingle(), 'reading print job')
  else if (error) throw new Error(`reading print job: ${error.message}`)
  if (!j) return { status: 404, error: 'That print job was not found.' }
  const waited = Math.round((Date.now() - Date.parse(j.created_at)) / 1000)
  return { status: 200, job: { id: j.id, orderId: j.order_id, boxes: j.boxes, boxNumbers: j.box_numbers || null, state: j.status, error: j.error || '', slow: j.status === 'queued' && waited > AGENT_SLOW_SECONDS } }
}
