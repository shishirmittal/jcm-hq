// Browser storage can be missing or blocked (private windows, kiosk resets),
// so every read and write is guarded and failure is reported, not thrown.
const store = kind => { try { return window[kind] } catch { return null } }

export function read(kind, key) {
  try { return store(kind)?.getItem(key) ?? null } catch { return null }
}

export function write(kind, key, value) {
  try {
    const s = store(kind)
    if (!s) return false
    if (value === null) s.removeItem(key)
    else s.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export const DEVICE_KEY = 'jcmOrders.deviceToken'
export const ADMIN_KEY = 'jcmOrders.adminSession'

export const getDeviceToken = () => read('localStorage', DEVICE_KEY)
export const setDeviceToken = token => write('localStorage', DEVICE_KEY, token)
