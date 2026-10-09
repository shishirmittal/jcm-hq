import { Capacitor } from '@capacitor/core'

// One answer to "are we inside the Android app?", asked by the shell, the
// router and the API base. Capacitor's own check is the authority: it reports
// 'web' in a browser, so the same bundle serves jcm-crm.vercel.app unchanged.
//
// Read once. isNativePlatform() cannot change for the life of a page, and a
// constant keeps every caller agreeing even if the import were ever stubbed.
export const IS_NATIVE = Capacitor.isNativePlatform()

// Where /api/* lives.
//
// This was load-bearing when the APK carried its own copy of the site: the
// page was served from the device at https://localhost, so a relative fetch
// looked for a serverless function on the handset and 404'd. The app now
// loads from https://jcm-crm.vercel.app itself (server.url in
// capacitor.config.json), so the page origin and the API origin are the same
// and a relative path would resolve correctly on its own.
//
// Kept anyway, and deliberately. It is the same origin either way, so it
// costs nothing and changes no request — while removing it would make every
// /api/* call silently depend on the app never being pointed anywhere else.
// If the WebView is ever moved back onto bundled assets, or at a preview
// deployment, this one line is still the only thing that has to be right.
//
// Hard-coded rather than read from the environment because the APK is built
// by CI with no .env to read, and pointing the app at the wrong backend is a
// worse failure than editing one line here if the domain ever moves.
export const API_ORIGIN = IS_NATIVE ? 'https://jcm-crm.vercel.app' : ''

// apiUrl('/api/pin-login') -> '/api/pin-login' on the web,
//                             'https://jcm-crm.vercel.app/api/pin-login' in the app.
export function apiUrl(path) {
  return API_ORIGIN + path
}
