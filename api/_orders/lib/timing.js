import { AsyncLocalStorage } from 'node:async_hooks'

// Server time per request, for finding slow taps: every answer carries a
// Server-Timing header ("app" = whole request, "db" = Supabase calls), and on
// Vercel one log line per request:
//   [time] tablet op=orders 200 · 142 ms · 3 db calls (118 ms)
// db.js counts the Supabase calls of the request through this store.
export const requestStore = new AsyncLocalStorage()

export function withTiming(name, handler) {
  return async function timed(req, res) {
    const t0 = performance.now()
    const store = { calls: 0, dbMs: 0 }
    const json = res.json.bind(res)
    res.json = body => {
      const ms = Math.round(performance.now() - t0)
      const db = Math.round(store.dbMs)
      try { res.setHeader('Server-Timing', `app;dur=${ms}, db;dur=${db};desc="${store.calls} calls"`) } catch { /* headers already sent */ }
      if (process.env.VERCEL) {
        const q = new URL(req.url || '/', 'http://x').searchParams
        const op = q.get('op') || (req.body && typeof req.body === 'object' && req.body.op) || q.get('order') && 'order' || ''
        console.log(`[time] ${name}${op ? ` op=${op}` : ''} ${req.method} ${res.statusCode || 200} · ${ms} ms · ${store.calls} db calls (${db} ms)`)
      }
      return json(body)
    }
    return requestStore.run(store, () => handler(req, res))
  }
}

// fetch for the Supabase client: counts and times each call of the current request.
export async function timedFetch(...args) {
  const store = requestStore.getStore()
  const t = performance.now()
  try {
    return await fetch(...args)
  } finally {
    if (store) { store.calls++; store.dbMs += performance.now() - t }
  }
}
