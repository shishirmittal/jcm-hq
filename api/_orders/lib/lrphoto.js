// LR / transport-receipt photos, taken by the dispatch person at DISPATCHED.
// Kept in a PRIVATE Supabase Storage bucket (supabase/storage-lr-photos.sql):
//   lr-photos/<SO number>/<YYYY-MM-DD>_<HHMMSS>.jpg      e.g. SO-754/2026-10-06_143012.jpg
// Nobody can open a photo without a time-limited link made here (logs page,
// WhatsApp image header).
export const LR_BUCKET = 'lr-photos'
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024

// "12Main/2627/754" → "SO-754"; anything odd is made safe for a file path.
export function photoPath(soNo, now = new Date()) {
  const last = String(soNo || '').split('/').filter(Boolean).pop() || 'unknown'
  const so = `SO-${last.replace(/[^A-Za-z0-9-]/g, '-')}`
  const ist = new Date(now.getTime() + 330 * 60000).toISOString() // YYYY-MM-DDTHH:MM:SS
  return `${so}/${ist.slice(0, 10)}_${ist.slice(11, 19).replace(/:/g, '')}.jpg`
}

// The phone sends the photo as a data URL ("data:image/jpeg;base64,…"), already
// shrunk to about 1600 px. Returns the bytes, or { error } in plain words.
export function decodePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
  if (!m) return { error: 'The photo did not arrive properly. Take it again.' }
  const bytes = Buffer.from(m[2], 'base64')
  if (bytes.length < 1000) return { error: 'The photo is empty. Take it again.' }
  if (bytes.length > MAX_PHOTO_BYTES) return { error: 'The photo is too large. Take it again.' }
  const type = m[1] === 'jpg' ? 'jpeg' : m[1]
  return { bytes, contentType: `image/${type}` }
}

// Saves the photo. Creates the bucket (private) the first time if the SQL
// script has not been run yet. Returns null, or an error message.
export async function savePhoto(dbc, path, { bytes, contentType }) {
  const put = () => dbc.storage.from(LR_BUCKET).upload(path, bytes, { contentType, upsert: false })
  let { error } = await put()
  if (error && /not.?found/i.test(error.message || '')) {
    await dbc.storage.createBucket(LR_BUCKET, { public: false })
    ;({ error } = await put())
  }
  return error ? String(error.message || error) : null
}

export async function removePhoto(dbc, path) {
  try { await dbc.storage.from(LR_BUCKET).remove([path]) } catch { /* only tidying up */ }
}

// A link that works for `seconds`, or null.
export async function photoLink(dbc, path, seconds) {
  if (!path) return null
  const { data, error } = await dbc.storage.from(LR_BUCKET).createSignedUrl(path, seconds)
  return error || !data ? null : data.signedUrl
}
