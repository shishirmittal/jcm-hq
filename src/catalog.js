import { fetchAllRows } from './supabase.js'

let catalogCache = null
let presetsCache = null
let genericItemsCache = null
let genericItemMapCache = null

export async function loadCatalog() {
  if (catalogCache) return catalogCache
  catalogCache = await fetchAllRows('catalog_items')
  return catalogCache
}

// Dropped after the Price Update screen writes to catalog_items, so the
// quotation form picks the new prices up on its next read instead of quoting
// from a copy of the table taken before the change. Only the catalog is
// dropped — the other three caches here are different tables that a price
// edit cannot have touched.
//
// Note this clears the cache in THIS tab only. A colleague with the CRM
// already open elsewhere keeps their copy until they reload, which is the
// same behaviour the catalog has always had and not something a price edit
// makes newly true.
export function clearCatalogCache() {
  catalogCache = null
}

export async function loadDiscountPresets() {
  if (presetsCache) return presetsCache
  presetsCache = await fetchAllRows('model_discount_presets')
  return presetsCache
}

// Paginated the same way as loadCatalog — these are small today (only Schneider
// Zeta is mapped in) but will grow past the 1000-row server cap once LK/Legrand
// mappings are added, so this has to stay safe from day one.
export async function loadGenericItems() {
  if (genericItemsCache) return genericItemsCache
  genericItemsCache = await fetchAllRows('generic_items')
  return genericItemsCache
}

export async function loadGenericItemMap() {
  if (genericItemMapCache) return genericItemMapCache
  genericItemMapCache = await fetchAllRows('generic_item_map')
  return genericItemMapCache
}

export function getPresetDiscount(presets, brand, model) {
  const preset = presets.find(p => p.brand === brand && p.model === model)
  return preset ? Number(preset.default_discount_pct) || 0 : 0
}

// Every brand/model this generic item is available in.
export function getMapEntriesFor(genericItemId, mapRows) {
  return mapRows.filter(r => r.generic_item_id === genericItemId)
}

// Splits a search phrase into tokens and requires each to appear somewhere in the
// text (any order, partial words) — so "so 3 2m" matches "Socket 6A/16A 3 Pin
// Combi with ISI 2M" the same way accounting-software item search does.
export function tokenMatch(text, term) {
  const tokens = term.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return false
  const t = (text || '').toLowerCase()
  return tokens.every(tok => t.includes(tok))
}
