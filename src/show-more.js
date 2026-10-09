// Long lists show 25 rows first and a "Show 25 more" button under them, so a
// phone never draws hundreds of cards at once. Call it right after a list is
// drawn (again after every redraw — filters, search); it only hides rows that
// are already there, so clicks and filters work exactly as before.
//   showMore(listEl, '.project-card')           cards
//   showMore(tableWrap, 'tbody tr')             table rows
export function showMore(root, selector, size = 25) {
  if (!root) return
  root.querySelector(':scope > .hq-more')?.remove()
  const rows = [...root.querySelectorAll(selector)]
  let shown = Math.min(size, rows.length)
  rows.forEach((r, i) => { r.hidden = i >= shown })
  if (rows.length <= shown) return
  const bar = document.createElement('div')
  bar.className = 'hq-more'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn-ghost hq-more-btn'
  const paint = () => {
    const left = rows.length - shown
    btn.textContent = `Show ${Math.min(size, left)} more · ${left} left`
  }
  btn.addEventListener('click', e => {
    e.stopPropagation()
    shown = Math.min(shown + size, rows.length)
    rows.forEach((r, i) => { r.hidden = i >= shown })
    if (shown >= rows.length) bar.remove(); else paint()
  })
  const all = document.createElement('span')
  all.className = 'hq-more-count'
  all.textContent = `${rows.length} in all`
  paint()
  bar.append(btn, all)
  root.appendChild(bar)
}
