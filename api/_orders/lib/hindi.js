import { must } from './db.js'

// Party names and cities in Devanagari for the carton label (transliteration,
// not translation: "ANNAPURNA TRADING COMPANY (BAMNIYA)" → "अन्नपूर्णा ट्रेडिंग कंपनी (बामनिया)").
//
// Each spelling is made once and kept in party_hindi (supabase/phase10-label-hindi.sql),
// then reused on every label. New ones come from Google's transliteration
// (inputtools.google.com, Hindi, the same engine as Google's Hindi keyboard) and
// are marked needs_review until someone checks them on /admin → Hindi names.
//   Initials are spelt as letter names (J.V. → जे.वी.); PVT / LTD / CO → प्रा. / लि. / कं.
const GOOGLE = 'https://inputtools.google.com/request'
const TIMEOUT_MS = 4000

const LETTER = {
  a: 'ए', b: 'बी', c: 'सी', d: 'डी', e: 'ई', f: 'एफ', g: 'जी', h: 'एच', i: 'आई', j: 'जे', k: 'के', l: 'एल', m: 'एम',
  n: 'एन', o: 'ओ', p: 'पी', q: 'क्यू', r: 'आर', s: 'एस', t: 'टी', u: 'यू', v: 'वी', w: 'डब्ल्यू', x: 'एक्स', y: 'वाई', z: 'ज़ेड',
}
const ABBR = { pvt: 'प्रा.', ltd: 'लि.', co: 'कं.', llp: 'एलएलपी', mr: 'श्री', mrs: 'श्रीमती', ms: 'सुश्री', dr: 'डॉ.' }

export const englishKey = s => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase()
export const hasDevanagari = s => /[ऀ-ॿ]/.test(String(s || ''))
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')

// One call to Google for a list of words → their Devanagari, in the same order.
async function googleWords(words, fetchImpl = globalThis.fetch) {
  const ask = async text => {
    const url = `${GOOGLE}?${new URLSearchParams({ text, itc: 'hi-t-i0-und', num: '1', cp: '0', cs: '1', ie: 'utf-8', oe: 'utf-8' })}`
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok) throw new Error(`transliteration service answered ${r.status}`)
    const j = await r.json()
    if (!Array.isArray(j) || j[0] !== 'SUCCESS') throw new Error('transliteration service did not succeed')
    return decode(String(j[1]?.[0]?.[1]?.[0] || ''))
  }
  const joined = (await ask(words.join(' '))).split(/\s+/).filter(Boolean)
  if (joined.length === words.length) return joined
  return Promise.all(words.map(ask)) // word counts did not line up: one word at a time
}

// English → Devanagari. Returns null if the service cannot be reached (the label
// then prints in English only, and the next label tries again).
export async function transliterate(text, { fetchImpl } = {}) {
  const src = String(text || '').trim()
  if (!src) return ''
  if (hasDevanagari(src)) return src
  const custom = globalThis.__jcmTransliterate // tests stand in for Google here
  const parts = src.split(/([A-Za-z]+)/)
  const want = []
  parts.forEach((p, i) => {
    if (i % 2 === 0) return // separators: spaces, dots, brackets, &, digits
    const low = p.toLowerCase()
    if (low.length === 1) parts[i] = LETTER[low] || p
    else if (ABBR[low]) parts[i] = ABBR[low]
    else want.push(i)
  })
  if (want.length) {
    const words = want.map(i => parts[i].toLowerCase())
    let out
    try {
      out = custom ? await custom(words) : await googleWords(words, fetchImpl)
    } catch (err) {
      console.warn(`Hindi transliteration failed: ${err.message}`)
      return null
    }
    want.forEach((idx, k) => { parts[idx] = out[k] || parts[idx] })
  }
  return parts.join('').replace(/\s+/g, ' ').trim()
}

// The Hindi for a label: stored spellings, making (and storing) any that are missing.
// Returns { nameHi, cityHi } — either may be null (not stored and could not be made).
// Before the Phase 10 SQL is run (no party_hindi table) it returns nulls.
export async function hindiFor(dbc, { name, city }) {
  const want = [['name', name], ['city', city]].filter(([, v]) => englishKey(v))
  if (!want.length) return { nameHi: null, cityHi: null }
  const keys = want.map(([, v]) => englishKey(v))
  const { data: rows, error } = await dbc.from('party_hindi').select('english_key, hindi').in('english_key', keys)
  if (error) { console.warn(`Hindi names not available: ${error.message}`); return { nameHi: null, cityHi: null } }
  const have = new Map(rows.map(r => [r.english_key, r.hindi]))
  await Promise.all(want.filter(([, v]) => !have.has(englishKey(v))).map(async ([kind, v]) => {
    const hindi = await transliterate(v)
    if (!hindi) return
    have.set(englishKey(v), hindi)
    const { error: e } = await dbc.from('party_hindi').upsert({ english_key: englishKey(v), kind, english: String(v).trim(), hindi, source: 'google', needs_review: true }, { onConflict: 'english_key', ignoreDuplicates: true })
    if (e) console.warn(`Could not store the Hindi for "${v}": ${e.message}`)
  }))
  return { nameHi: name ? have.get(englishKey(name)) || null : null, cityHi: city ? have.get(englishKey(city)) || null : null }
}

// Label language (/admin): 'en_hi' (English + Hindi, the default) or 'en'.
export async function readLabelLanguage(dbc) {
  const row = await must(dbc.from('orders_config').select('value').eq('key', 'label_language').maybeSingle(), 'reading label language')
  return row && row.value && row.value.language === 'en' ? 'en' : 'en_hi'
}
