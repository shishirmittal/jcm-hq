import { supabase } from '../../supabase.js'

// Every call to our own /api functions. The browser only ever talks to these,
// never to Supabase directly for orders data.
//
// JCM HQ: the pages still ask for the old jcm-orders paths (/api/admin/owner,
// /api/cron/daily-email …); they are mapped here onto the one HQ function
// /api/orders?h=…, so the page code stays exactly as it was. And instead of an
// orders admin session, every call carries the person's HQ sign-in (Supabase
// access token, read fresh each time so an hourly token refresh never breaks
// a page that has been open all day).
function mapPath(path) {
  const [base, query = ''] = String(path).split('?')
  let h = null
  const m = base.match(/^\/api\/admin\/([a-z-]+)$/)
  if (m) h = m[1]
  else if (base === '/api/cron/daily-email') h = 'email'
  else if (base === '/api/tablet') h = 'floor'
  if (!h) return path
  return `/api/orders?h=${h}${query ? `&${query}` : ''}`
}

export async function api(path, { method = 'GET', body, admin, device } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (admin) {
    const { data } = await supabase.auth.getSession()
    const token = data?.session?.access_token
    if (token) headers.Authorization = `Bearer ${token}`
  }
  if (device) headers['X-Device-Token'] = device
  const res = await fetch(mapPath(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
  let data = {}
  try { data = await res.json() } catch { /* empty or not JSON */ }
  return { ok: res.ok, status: res.status, data }
}
