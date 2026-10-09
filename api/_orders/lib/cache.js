// A small in-memory cache, per server instance, so a tap does not wait on the
// database for things that were just read: staff and admin sessions (30 s),
// people's names (5 min). Each Vercel instance has its own copy, so anything
// cached here may lag the database by at most its time-to-live.
const store = new Map()
const MAX = 2000

export function cached(key) {
  const e = store.get(key)
  if (!e) return undefined
  if (e.until <= Date.now()) { store.delete(key); return undefined }
  return e.value
}

export function remember(key, value, ms) {
  if (store.size >= MAX) for (const [k, e] of store) if (e.until <= Date.now() || store.size >= MAX) store.delete(k)
  store.set(key, { value, until: Date.now() + ms })
  return value
}

export function forget(prefix) {
  for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k)
}

// Tests change the database behind the app's back (expire a session, take
// someone off the list); they start from an empty cache afterwards.
export const forgetAll = () => store.clear()
