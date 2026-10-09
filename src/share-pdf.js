import { IS_NATIVE } from './native.js'

// Getting a generated PDF off the phone.
//
// jsPDF's doc.save() triggers a browser download. In a Capacitor WebView there
// is no download manager and no Downloads shelf behind that — the file is
// written somewhere inside the app's sandbox, no notification appears, and
// nothing the user can open ever shows up. That is why "Download PDF" did
// nothing at all on a phone while working perfectly in a desktop browser.
//
// The native path writes the file into the app's cache directory and hands its
// URI to the system share sheet, which is how a phone is supposed to do this:
// the sheet offers WhatsApp, Gmail, Drive, Files and so on, and the file goes
// across as a real attachment.

// Cache, not Documents: these are throwaway copies of something already stored
// in Supabase, and Android is free to reclaim the space whenever it needs it.
// The share sheet only needs the file to exist long enough to be handed over.
const DIRECTORY = 'CACHE'

// jsPDF gives us a data URI; the plugin wants bare base64.
function toBase64(doc) {
  const uri = doc.output('datauristring')
  return uri.slice(uri.indexOf(',') + 1)
}

// Android will not accept a filename with a slash in it, and quote numbers
// have them ("JCM/Q/2026/0412").
export function pdfFilename(quoteNo) {
  const base = String(quoteNo || 'quotation').replace(/[\/:*?"<>|]/g, '-').trim()
  return `${base || 'quotation'}.pdf`
}

// Returns 'shared' when the system sheet handled it, 'downloaded' on the web,
// or 'cancelled' when the user dismissed the sheet — the caller uses this to
// decide what to say afterwards, since "PDF downloaded" is a lie on a phone.
export async function sharePdf(doc, filename, { title, text } = {}) {
  if (!IS_NATIVE) {
    doc.save(filename)
    return 'downloaded'
  }

  // Imported here rather than at the top so the browser bundle never pulls in
  // two native plugins it cannot use.
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ])

  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: toBase64(doc),
    // Cache, not Documents: these are throwaway copies of something already
    // stored in Supabase, and Android may reclaim the space whenever it likes.
    // The file only has to outlive the handover to the share sheet.
    directory: Directory.Cache,
  })

  try {
    // files[] is what makes this an attachment rather than a link. text is
    // carried alongside it, so WhatsApp opens with both the message and the
    // PDF ready to send.
    await Share.share({ title, text, files: [uri] })
    return 'shared'
  } catch (err) {
    // The plugin rejects when the user backs out of the sheet. That is not a
    // failure worth showing an error for.
    if (/cancel/i.test(err?.message || '')) return 'cancelled'
    throw err
  }
}
