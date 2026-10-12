// HQ's own pop-ups, replacing the browser's grey confirm() / alert() / prompt() boxes
// (which on the phone app look like a plain Android dialog). Same look everywhere,
// day and night. Styles: .hq-dlg-* in hq-theme.css.
//
//   if (!(await hqConfirm('Delete this photo?', { okText: 'Delete', danger: true }))) return
//   hqAlert('PDF downloaded.')                       // no need to await
//   const note = await hqPrompt('Any note?', '')     // null when cancelled
//
// Built on .modal-overlay so the phone's back button (src/back-button.js) closes it
// like any other modal — that counts as Cancel. Escape = Cancel, Enter = OK.
import { esc } from './utils.js'

let open = null // one at a time; a second call waits for the first to close

function show({ title, message, okText = 'OK', cancelText = 'Cancel', danger = false, kind = 'confirm', value = '' }) {
  const run = () => new Promise(resolve => {
    const ov = document.createElement('div')
    ov.className = 'modal-overlay hq-dlg-overlay'
    ov.innerHTML = `
      <div class="hq-dlg" role="${kind === 'alert' ? 'alertdialog' : 'dialog'}" aria-modal="true">
        ${title ? `<div class="hq-dlg-title">${esc(title)}</div>` : ''}
        <div class="hq-dlg-msg">${esc(message || '')}</div>
        ${kind === 'prompt' ? `<textarea class="hq-dlg-input" rows="2">${esc(value)}</textarea>` : ''}
        <div class="hq-dlg-actions">
          ${kind === 'alert' ? '' : `<button type="button" class="hq-dlg-btn hq-dlg-cancel" id="hqDlgCancel">${esc(cancelText)}</button>`}
          <button type="button" class="hq-dlg-btn hq-dlg-ok${danger ? ' is-danger' : ''}" id="hqDlgOk">${esc(okText)}</button>
        </div>
      </div>`
    const input = ov.querySelector('.hq-dlg-input')
    const done = answer => {
      document.removeEventListener('keydown', onKey, true)
      ov.classList.add('is-leaving')
      setTimeout(() => ov.remove(), 120)
      resolve(answer)
    }
    const ok = () => done(kind === 'prompt' ? input.value : kind === 'confirm' ? true : undefined)
    const cancel = () => done(kind === 'prompt' ? null : kind === 'confirm' ? false : undefined)
    const onKey = e => {
      if (!document.body.contains(ov)) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() }
      else if (e.key === 'Enter' && !(input && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); ok() }
    }
    ov.querySelector('#hqDlgOk').addEventListener('click', ok)
    ov.querySelector('#hqDlgCancel')?.addEventListener('click', cancel)
    ov.addEventListener('click', e => { if (e.target === ov) cancel() })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(ov)
    ;(input || ov.querySelector('#hqDlgOk')).focus()
  })
  const p = (open || Promise.resolve()).then(run)
  open = p.then(() => null, () => null)
  return p
}

export const hqConfirm = (message, opts = {}) => show({ ...opts, message, kind: 'confirm' })
export const hqAlert = (message, opts = {}) => show({ ...opts, message, kind: 'alert' })
export const hqPrompt = (message, value = '', opts = {}) => show({ ...opts, message, value, kind: 'prompt' })
