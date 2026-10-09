import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  'https://cmtnzmfuasniicsdxyle.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtdG56bWZ1YXNuaWljc2R4eWxlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NTIyODAsImV4cCI6MjEwMjEyODI4MH0.dhQOQf0kOXtq6vGuYczBVTZqYVky50CxiNLI66vhYa0'
)

// Loads the signed-in user's row from `profiles` (role + active flag).
// Returns null if the profiles table/trigger from supabase/setup.sql hasn't been run yet.
export async function getCurrentProfile() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  return data
}

// Supabase projects cap any single request at a server-side "max rows" setting
// (1000 by default) regardless of a client-side .limit() — so tables that can
// exceed that (catalog_items has 2,619 rows) need pagination via .range(), not
// just a bigger .limit().
export async function fetchAllRows(table, columns = '*') {
  const pageSize = 1000
  let all = []
  let from = 0
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + pageSize - 1)
    if (error) { console.error(`Failed to load ${table}:`, error); break }
    all = all.concat(data || [])
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return all
}