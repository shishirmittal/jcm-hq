import { must } from './db.js'

// Stage time limits for the TV board, in minutes. These are the handover's
// defaults; the live values sit in orders_config and are changed on /admin.
export const DEFAULT_THRESHOLDS = { new: 60, picking: 90, invoiced: 30, checked: 30, in_bay: 1440 }
export const THRESHOLD_KEYS = Object.keys(DEFAULT_THRESHOLDS)
export const MAX_THRESHOLD_MINUTES = 7 * 24 * 60

export async function readThresholds(dbc) {
  const row = await must(dbc.from('orders_config').select('value').eq('key', 'threshold_minutes').maybeSingle(), 'reading time limits')
  const saved = row && row.value && typeof row.value === 'object' ? row.value : {}
  const out = {}
  for (const k of THRESHOLD_KEYS) {
    const v = Number(saved[k])
    out[k] = Number.isInteger(v) && v > 0 ? v : DEFAULT_THRESHOLDS[k]
  }
  return out
}
