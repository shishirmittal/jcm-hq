// On a phone, wide tables read better as one small card per row, each value
// labelled with its column name. This copies every column heading onto its cells
// (data-label) whenever such a table is drawn; the CSS in hq-theme.css
// (.hq-stack) does the rest below 600 px. Opt in by selector below.
// 2026-10-17 phone sweep: GST, Signify CD, email bills, Busy quotation lines, Reorder
// Planning / Payments (op-table) join the WhatsApp tables.
const SELECTOR = '.wa-table table, table.hq-stack, table.gst-table, table.cd-table, table.ep-table, table.qb-table, table.op-table'

function label(table) {
  const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim())
  if (!heads.length) return
  table.classList.add('hq-stacked')
  for (const tr of table.querySelectorAll('tbody tr, tfoot tr')) {
    [...tr.children].forEach((td, i) => { if (!td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i] || '') })
  }
}

export function startPhoneTables() {
  const scan = root => {
    if (!(root instanceof Element)) return
    if (root.matches?.(SELECTOR)) label(root)
    root.querySelectorAll?.(SELECTOR).forEach(label)
  }
  scan(document.body)
  new MutationObserver(list => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n instanceof Element) { scan(n); const t = n.closest?.(SELECTOR); if (t) label(t) }
    }
  }).observe(document.body, { childList: true, subtree: true })
}
