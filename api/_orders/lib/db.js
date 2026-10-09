import { createClient } from '@supabase/supabase-js'
import { timedFetch } from './timing.js'

// Server-only Supabase client for the CRM project (cmtnzmfuasniicsdxyle),
// using the service key from Vercel's environment variables. The browser never
// sees this key and never talks to Supabase directly.
let client = null

export function db() {
  // The local test server swaps in a throwaway database here.
  if (globalThis.__jcmOrdersDb) return globalThis.__jcmOrdersDb
  if (!client) {
    // JCM HQ: the orders tables live in the CRM project, whose service key HQ
    // already has as SUPABASE_SERVICE_ROLE_KEY — no second copy needed.
    const url = process.env.ORDERS_SUPABASE_URL || 'https://cmtnzmfuasniicsdxyle.supabase.co'
    const key = process.env.ORDERS_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      const err = new Error('ORDERS_SUPABASE_URL and ORDERS_SUPABASE_SERVICE_KEY are not set in Vercel')
      err.status = 503
      throw err
    }
    // timedFetch: counts each request's database calls for the Server-Timing header.
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch } })
  }
  return client
}

// Supabase returns { data, error }; this turns an error into a thrown one so
// handlers can stay short.
export async function must(promise, what) {
  const { data, error } = await promise
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}
