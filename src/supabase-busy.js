import { createClient } from '@supabase/supabase-js'

// Order Planning reads from a completely separate Supabase project (JCM-Busysql)
// from the rest of the app — a nightly sync script outside this codebase pulls
// data from Busy's SQL Server into it. Kept as its own client/project specifically
// to avoid table-name collisions with the CRM's own Supabase project (e.g. both
// worlds might reasonably want an `items` or `settings` table one day).
export const supabaseBusy = createClient(
  'https://jlkjjqnmhsgefpluemyz.supabase.co',
  'sb_publishable_P3DXRf1RnrD2BqmE3iphoQ_rsdZJtlb'
)

// Same rationale as supabase.js's fetchAllRows — items alone is already pushing
// 4,400+ rows, past the 1000-row server-side cap a plain .limit() can't get around.
export async function fetchAllBusyRows(table, columns = '*') {
  const pageSize = 1000
  let all = []
  let from = 0
  while (true) {
    const { data, error } = await supabaseBusy.from(table).select(columns).range(from, from + pageSize - 1)
    if (error) { console.error(`Failed to load ${table}:`, error); break }
    all = all.concat(data || [])
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return all
}
