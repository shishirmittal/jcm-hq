// The Android app is a web page served from the device, not from this origin,
// so every call it makes to /api/* is cross-origin and needs both a CORS
// header and an answer to the preflight. Without this the app cannot even log
// in: the PIN POST sends Content-Type: application/json, which is enough to
// make the browser send an OPTIONS first, and each handler here answers a
// non-POST with 405.
//
// An explicit allowlist, not '*'. These three endpoints mint sessions, manage
// users and run SQL; the set of origins that may reach them is small and
// known, and should stay that way.
const ALLOWED = new Set([
  'https://localhost',      // Capacitor Android (androidScheme: https)
  'http://localhost',       // Capacitor Android if the scheme is ever changed
  'capacitor://localhost',  // Capacitor iOS, should the app ever ship there
])

// Returns true when the request has been fully handled (a preflight) and the
// caller should stop. Same-origin browser requests send no Origin header on
// POST from the same site, so they fall straight through unchanged.
export function applyCors(req, res) {
  const origin = req.headers.origin
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    // The allowed origin depends on the request's own Origin, so caches must
    // not serve one app's response to another.
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', '86400')
  }
  if (req.method === 'OPTIONS') {
    // 204 whether or not the origin was allowed. An unlisted origin simply
    // gets no Allow-Origin header back and the browser blocks the real call,
    // which is the same outcome as a rejection without the extra surface.
    res.status(204).end()
    return true
  }
  return false
}
