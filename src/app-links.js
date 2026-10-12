// Links that open the JCM HQ app (2026-10-13, Purchase Summary chat).
//
// A tap on https://hq.jcmretails.com/#purchases (the "Open Purchase Summary" button on a staff
// WhatsApp, or any HQ link to the site's root) should open the phone app on that page, not a
// browser where the person is not signed in.
//   - android/app/src/main/AndroidManifest.xml has an intent filter for https://hq.jcmretails.com/
//     (root only, so /api/… and /wa/… files still open as files).
//   - The APK is debug-signed with a different key on every CI run, so Android cannot verify the
//     link by itself (no assetlinks.json yet). Each phone approves it once instead:
//     Settings → Apps → JCM HQ → Open by default → Add link → tick hq.jcmretails.com.
//     A fixed signing key kept as a GitHub Actions secret + public/.well-known/assetlinks.json
//     would make this automatic — not done; never commit a keystore to the repo.
// This file moves the app to the page in the link: the link that started the app
// (getLaunchUrl) and links tapped while it is already open (appUrlOpen).
// Does nothing on the website.
import { IS_NATIVE } from './native.js'

const HOST = 'hq.jcmretails.com'

function goTo(raw) {
  try {
    const u = new URL(raw)
    if (u.host !== HOST) return
    const hash = u.hash && u.hash !== '#' ? u.hash : ''
    if (hash && window.location.hash !== hash) window.location.hash = hash
  } catch { /* not a URL we know */ }
}

let mounted = false
export async function mountAppLinks() {
  if (!IS_NATIVE || mounted) return
  mounted = true
  let App
  try { ({ App } = await import('@capacitor/app')) } catch (err) { console.warn('app links: @capacitor/app not available', err); return }
  try {
    const launch = await App.getLaunchUrl()
    if (launch?.url) goTo(launch.url)
  } catch { /* opened from the home screen */ }
  App.addListener('appUrlOpen', e => goTo(e?.url))
}
