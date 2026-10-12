// In-app PDF viewer (2026-10-13). The phone app's WebView cannot show a PDF by itself and has no
// download manager, so "open" used to mean "share". This draws the pages with pdf.js on screen;
// "Save / share" still hands the file to the phone's share sheet (or downloads it on a computer).
// Back button / Escape / ✕ close it (class modal-overlay, so src/back-button.js finds it).
import { shareBase64 } from './share-pdf.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// A page loaded before a new deploy asks for chunk files that no longer exist → reload once.
function staleChunk(err) {
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(err?.message || '')
}

let pdfjsPromise = null
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => { lib.GlobalWorkerOptions.workerSrc = worker.default; return lib })
      .catch(err => { pdfjsPromise = null; throw err })
  }
  return pdfjsPromise
}

export async function openPdfViewer({ base64, filename, mime = 'application/pdf' }) {
  const ov = document.createElement('div')
  ov.className = 'modal-overlay pv-overlay'
  ov.innerHTML = `
    <div class="pv-bar">
      <button type="button" class="pv-btn" aria-label="Close" id="pvClose">✕</button>
      <div class="pv-name" title="${esc(filename)}">${esc(filename)}</div>
      <button type="button" class="pv-btn" id="pvOut" aria-label="Zoom out">−</button>
      <button type="button" class="pv-btn" id="pvIn" aria-label="Zoom in">+</button>
      <button type="button" class="pv-btn pv-save" id="pvSave">Save / share</button>
    </div>
    <div class="pv-pages" id="pvPages"><div class="pv-msg">Opening…</div></div>`
  document.body.appendChild(ov)
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = e => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  ov.querySelector('#pvClose').addEventListener('click', close)
  ov.querySelector('#pvSave').addEventListener('click', () => shareBase64(base64, filename, mime).catch(err => alert(err.message)))

  const box = ov.querySelector('#pvPages')
  // Zoom: pages are drawn sharp enough for 3×; the buttons only change their on-screen width.
  let zoom = 1
  const setZoom = z => {
    zoom = Math.max(1, Math.min(3, z))
    box.classList.toggle('pv-zoomed', zoom > 1)
    for (const c of box.querySelectorAll('.pv-page')) { const w = Number(c.dataset.w || 0); if (w) { c.style.width = `${w * zoom}px`; c.style.height = `${Number(c.dataset.h) * zoom}px` } }
  }
  ov.querySelector('#pvIn').addEventListener('click', () => setZoom(zoom + 0.5))
  ov.querySelector('#pvOut').addEventListener('click', () => setZoom(zoom - 0.5))
  if (String(mime).startsWith('image/')) {
    box.innerHTML = `<img class="pv-page pv-img" src="data:${esc(mime)};base64,${base64}" alt="">`
    return
  }
  try {
    const pdfjs = await loadPdfjs()
    const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0))
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise
    box.innerHTML = ''
    const width = Math.min(box.clientWidth - 16, 900)
    const ratio = Math.min((window.devicePixelRatio || 1) * 2, 4)
    for (let n = 1; n <= doc.numPages; n++) {
      if (!ov.isConnected) return
      const page = await doc.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const vp = page.getViewport({ scale: (width / base.width) * ratio })
      const canvas = document.createElement('canvas')
      canvas.width = vp.width; canvas.height = vp.height
      canvas.dataset.w = width; canvas.dataset.h = vp.height / ratio
      canvas.style.width = `${width * zoom}px`; canvas.style.height = `${(vp.height / ratio) * zoom}px`
      canvas.className = 'pv-page'
      box.appendChild(canvas)
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
    }
    if (doc.numPages > 1) box.insertAdjacentHTML('beforeend', `<div class="pv-msg">${doc.numPages} pages</div>`)
  } catch (err) {
    if (staleChunk(err)) { box.innerHTML = '<div class="pv-msg">HQ was just updated — reloading…</div>'; setTimeout(() => location.reload(), 600); return }
    box.innerHTML = `<div class="pv-msg">Could not show this PDF here (${esc(err.message)}).<br>Use “Save / share” to open it in another app.</div>`
  }
}

export { staleChunk }
