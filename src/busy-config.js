// Same "JCM-Busysql" Supabase project as supabase-busy.js (nightly-synced from
// Busy's SQL Server), exposed as plain REST config instead of a supabase-js
// client — Control Centre only reads from read-only views via fetch, so a
// second client instance isn't worth the extra weight.
export const BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co'
export const BUSY_ANON_KEY = 'sb_publishable_P3DXRf1RnrD2BqmE3iphoQ_rsdZJtlb'

export async function busyFetch(path) {
  const res = await fetch(`${BUSY_URL}/rest/v1/${path}`, {
    headers: {
      apikey: BUSY_ANON_KEY,
      Authorization: `Bearer ${BUSY_ANON_KEY}`
    }
  })
  if (!res.ok) throw new Error(`Busy REST fetch failed (${res.status}): ${path}`)
  return res.json()
}
