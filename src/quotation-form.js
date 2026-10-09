import { supabase, fetchAllRows } from './supabase.js'
import { esc, digitsOnly, formatMoney as money } from './utils.js'
import { renderQuotationView } from './quotation-view.js'
import {
  loadCatalog, loadDiscountPresets, loadGenericItems, loadGenericItemMap,
  getMapEntriesFor, getPresetDiscount, tokenMatch
} from './catalog.js'

function matchKey(phone) {
  const d = digitsOnly(phone)
  return d.length >= 10 ? d.slice(-10) : null
}

// Element.scrollIntoView({block:'nearest'}) walks the FULL ancestor chain,
// not just the dropdown's own scroll container. Both suggestion dropdowns
// (.item-suggestions) live inside a .qf-card, which has overflow:hidden
// purely so its rounded corners clip child backgrounds/borders -- but that
// also makes it a valid (if scrollbar-less) scroll container, and since the
// absolutely-positioned dropdown can be taller than the remaining card
// height, the browser decided the CARD itself also needed to scroll to
// reveal a highlighted row far down the list. overflow:hidden elements
// still accept a programmatic scrollTop, so that silently dragged the
// input/header out of the card's own clipped viewport while the dropdown
// stayed roughly put -- looking exactly like the input had vanished, worse
// the further you arrowed down. Scoping the scroll manually to just the
// dropdown's own scrollTop sidesteps the ancestor chain entirely.
function scrollHighlightedIntoView(container, el) {
  if (!el) return
  const top = el.offsetTop
  const bottom = top + el.offsetHeight
  if (top < container.scrollTop) container.scrollTop = top
  else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight
}

function dedupeByColour(variants) {
  const map = new Map()
  for (const v of variants) {
    const key = v.colour || '—'
    if (!map.has(key)) map.set(key, v)
  }
  return [...map.values()]
}

// Collapses generic_item_map rows into one entry per unique (brand, model) pair --
// a generic item can have several mapping rows sharing the same brand+model when
// multiple product families were merged into one universal item (e.g. entice's
// Vivid/Vibrant/Wooden/Marble/Glass category variants of the same plate size, each
// its own catalog_items item_key). Each grouped entry carries every item_key mapped
// to it, not just the first, so Model/Colour resolution can merge catalog_items
// across all of them instead of only ever seeing one product family.
function groupEntriesByModel(entries) {
  const groups = []
  const byKey = new Map()
  for (const e of entries) {
    const key = `${e.brand}${e.model}`
    let g = byKey.get(key)
    if (!g) {
      g = { brand: e.brand, model: e.model, itemKeys: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    g.itemKeys.push(e.item_key)
  }
  return groups
}

// Auto-derived from the actual items on the quotation — feeds quotations.brand/model,
// which are unrelated to the free-text quotations.label caption. Replaces the old
// manually-typed Brand/Model fields entirely: a quotation dominated by one brand is
// tagged with just that brand (plus every distinct model of theirs used); a genuine
// mix of exactly two brands is tagged "BrandA + BrandB"; three or more collapses to
// "Mixed" rather than listing everything. This is what the Quotations list's
// LK/Legrand/Schneider analytics, its summary line, and a project's quotation history
// line all read.
function deriveBrandModel(rows) {
  const brandCounts = new Map()
  const modelsByBrand = new Map()
  rows.forEach(({ variant }) => {
    if (!variant?.brand) return
    brandCounts.set(variant.brand, (brandCounts.get(variant.brand) || 0) + 1)
    if (!modelsByBrand.has(variant.brand)) modelsByBrand.set(variant.brand, new Set())
    if (variant.model) modelsByBrand.get(variant.brand).add(variant.model)
  })
  const brands = [...brandCounts.entries()].sort((a, b) => b[1] - a[1]).map(([b]) => b)
  if (brands.length === 0) return { brand: null, model: null }
  if (brands.length === 1) {
    return { brand: brands[0], model: [...(modelsByBrand.get(brands[0]) || [])].join(', ') || null }
  }
  if (brands.length === 2) return { brand: brands.join(' + '), model: null }
  return { brand: 'Mixed', model: null }
}

// prefill: { client_name, phone, city, address, project_id, items: [{description, qty}] }
export async function renderQuotationForm(container, prefill, onBack) {
  container.innerHTML = '<div class="loading-state">Loading catalog...</div>'
  const historyProfileIds = [...new Set([prefill?.created_by, prefill?.updated_by].filter(Boolean))]
  const [catalogItems, presets, genericItems, genericItemMap, clientRows, historyProfileRows] = await Promise.all([
    loadCatalog(),
    loadDiscountPresets(),
    loadGenericItems(),
    loadGenericItemMap(),
    fetchAllRows('projects', 'id, client_name, whatsapp, phone, location, city, address'),
    historyProfileIds.length
      ? supabase.from('profiles').select('id, name, email').in('id', historyProfileIds)
      : Promise.resolve({ data: [] })
  ])
  const clients = clientRows.filter(c => c.client_name)
  const historyProfiles = historyProfileRows.data || []
  showForm(container, { catalogItems, presets, genericItems, genericItemMap, clients, historyProfiles, prefill, onBack })
}

function showForm(container, ctx) {
  const { catalogItems, presets, genericItems, genericItemMap, clients, historyProfiles, prefill, onBack } = ctx
  let selectedProjectId = prefill?.project_id || null

  // Shared settings for this session only, reset whenever a new quotation form opens.
  // Colour and Discount are always independent per bucket (generic_items.bucket).
  // Model is independent too, EXCEPT a change to Model in one of the two modular
  // buckets also pushes that Model (Model only) into the other one, since plates and
  // their accessories are usually the same physical range.
  //
  // Unlike a one-time "pick up whatever was last used" default, changing any of these
  // on ANY row — a brand-new one or an existing one being edited — immediately re-syncs
  // every other row already in that bucket to match, live.
  //
  // Buckets are created on demand from whatever generic_items.bucket actually says
  // rather than being a hardcoded pair. Two reasons: a product family that isn't
  // modular plates/accessories at all (MCBs and the rest of a Tripper-style DB range,
  // wires, consumables) can be given its own bucket in the data and will then sync
  // strictly within itself, with no code change here; and a row whose generic item has
  // no bucket set can no longer reach into `bucketSettings[undefined]` — which used to
  // throw halfway through adding the item, leaving the form in a half-updated state.
  const UNBUCKETED = 'unbucketed'
  // The ONLY pair that shares a Model. Anything else — including any bucket added in
  // the data later — is fully self-contained.
  const MODEL_LINKED_PAIR = { plates: 'accessories', accessories: 'plates' }

  const bucketSettings = {}
  function normalizeBucket(b) { return b || UNBUCKETED }
  function settingsFor(bucket) {
    const key = normalizeBucket(bucket)
    if (!bucketSettings[key]) bucketSettings[key] = { model: null, colour: null, discount: null }
    return bucketSettings[key]
  }
  function otherBucket(b) { return MODEL_LINKED_PAIR[b] || null }

  // Points an item's Model/variants at a specific (brand, model), if that item actually
  // offers it. Returns true if applied.
  function setItemModel(item, modelPair) {
    if (!modelPair) return false
    const idx = item.entries.findIndex(e => e.brand === modelPair.brand && e.model === modelPair.model)
    if (idx === -1) return false
    item.entryIndex = idx
    const entry = item.entries[idx]
    item.variants = catalogItems.filter(c => entry.itemKeys.includes(c.item_key))
    return true
  }

  // Points a row at a specific colour. Merged multi-brand generic items can carry a
  // different colour set per Model (Cover Plate 8M Linear, Cover Plate 8M Square,
  // Switch 6A/10A and friends all hit this), so the bucket's shared colour genuinely
  // may not exist on the model this particular row is on. That used to fall through to
  // index 0 in silence, which is what left a row showing a stale/wrong colour while the
  // Discount on the same row synced perfectly — nothing anywhere said it hadn't taken.
  // Now the fallback is explicit: first available colour for this model, and the row
  // records which colour it *couldn't* give you so render() can flag it.
  // Returns true when the requested colour was actually applied.
  function setItemColour(item, colour) {
    if (item.entryIndex === null) return false
    if (colour == null) return false
    const colours = dedupeByColour(item.variants)
    const idx = colours.findIndex(v => v.colour === colour)
    if (idx >= 0) {
      item.colourIndex = idx
      item.colourMismatch = null
      return true
    }
    item.colourIndex = 0
    item.colourMismatch = colour
    return false
  }

  // The catalog's list price for whatever variant a row is currently pointed at —
  // used to pre-fill/refresh the editable List Price field whenever the underlying
  // model/colour selection actually changes.
  function catalogMrpFor(item) {
    if (item.entryIndex === null) return 0
    const colours = dedupeByColour(item.variants)
    const variant = colours[item.colourIndex] || colours[0]
    return variant ? Number(variant.mrp || 0) : 0
  }

  // Reapplies ONE of a bucket's shared settings — the field the user actually just
  // changed — to every other row already in that bucket. Locked rows are exceptions to
  // the bucket: skip them entirely so an intentionally different price/model on one row
  // survives every other row's changes.
  //
  // Propagating strictly the changed field is deliberate. This used to reapply Model,
  // Colour AND Discount on every call, so typing a Discount anywhere in a bucket could
  // also snap a sibling row's Model/Colour (and therefore its List Price) back to the
  // bucket's shared values — a change the rep never asked for, on a product they
  // weren't even editing. A discount change now moves exactly one number.
  //
  // List Price is never synced across rows. It's recomputed for a row only when that
  // row's own model/colour selection actually moved, i.e. only on the 'model'/'colour'
  // branches below.
  function resyncBucket(bucket, field) {
    const s = settingsFor(bucket)
    items.forEach(item => {
      if (item.bucket !== bucket) return
      if (item.locked) return

      // Discount and Colour each move exactly themselves. A Model change is the one
      // structural change that legitimately re-establishes the whole bucket: the new
      // model has its own colour list (so the old colour index means nothing in it)
      // and its own preset discount, which is why all three are reapplied there.
      if (field === 'discount') {
        if (s.discount != null) item.discount_pct = s.discount
        return
      }
      if (field === 'colour') {
        const prevColourIndex = item.colourIndex
        if (s.colour != null) setItemColour(item, s.colour)
        if (item.colourIndex !== prevColourIndex) item.mrp = catalogMrpFor(item)
        return
      }

      const prevEntryIndex = item.entryIndex
      const prevColourIndex = item.colourIndex
      if (s.model) setItemModel(item, s.model)
      if (s.colour != null) setItemColour(item, s.colour)
      if (s.discount != null) item.discount_pct = s.discount
      if (item.entryIndex !== prevEntryIndex || item.colourIndex !== prevColourIndex) {
        item.mrp = catalogMrpFor(item)
      }
    })
  }

  // Cross-bucket propagation for a Model change only — Discount stays untouched, and
  // Colour is only re-resolved against the receiving bucket's OWN shared colour (never
  // the sending bucket's), since the new model's colour list invalidates the old index.
  function resyncBucketModelOnly(bucket, modelPair) {
    const s = settingsFor(bucket)
    items.forEach(item => {
      if (item.bucket !== bucket) return
      if (item.locked) return
      if (setItemModel(item, modelPair)) {
        // setItemColour already falls back to 0 (and flags) when the bucket's colour
        // isn't offered; with no shared colour at all, 0 just keeps the index in range.
        if (s.colour == null) item.colourIndex = 0
        else setItemColour(item, s.colour)
        item.mrp = catalogMrpFor(item)
      }
    })
  }

  // Non-destructive: fills in whichever of this bucket's settings aren't set yet, from
  // a newly-added item's own resolved state. Never overwrites an already-established
  // setting, so it can't retroactively change other rows — use syncFromItem for that.
  function seedBucketSettings(i) {
    const item = items[i]
    if (item.entryIndex === null) return
    // A locked row is detached from its bucket in both directions — it must not seed
    // the shared settings every other row will sync on either. Matters most for
    // default-locked items, whose whole point is a discount that stays off the bucket.
    if (item.locked) return
    const entry = item.entries[item.entryIndex]
    if (!entry) return
    const colours = dedupeByColour(item.variants)
    const variant = colours[item.colourIndex] || colours[0]
    const s = settingsFor(item.bucket)
    if (!s.model) s.model = { brand: entry.brand, model: entry.model }
    if (s.colour == null) s.colour = variant?.colour ?? null
    if (s.discount == null) s.discount = item.discount_pct
  }

  // Call after the user explicitly changes Model, Colour or Discount on row i. Pushes
  // that field into the bucket's shared settings, then re-syncs every row in the bucket
  // to match — including rows added before this change, not just ones added after.
  function syncFromItem(i, changedField) {
    const item = items[i]
    // A locked row is fully detached from its bucket: its own edits stay local and
    // never get pushed into the shared settings other rows sync on.
    if (item.locked) return
    if (item.entryIndex === null) return
    const entry = item.entries[item.entryIndex]
    if (!entry) return
    const colours = dedupeByColour(item.variants)
    const variant = colours[item.colourIndex] || colours[0]
    const bucket = item.bucket
    const s = settingsFor(bucket)

    if (changedField === 'model') s.model = { brand: entry.brand, model: entry.model }
    if (changedField === 'colour') s.colour = variant?.colour ?? null
    if (changedField === 'discount') s.discount = item.discount_pct

    resyncBucket(bucket, changedField)

    if (changedField === 'model') {
      // Only the plates/accessories pair shares a Model; every other bucket is an
      // island, so otherBucket() returns null and nothing crosses over.
      const ob = otherBucket(bucket)
      if (ob) {
        settingsFor(ob).model = s.model
        resyncBucketModelOnly(ob, s.model)
      }
    }
  }

  // Works out what a brand-new item's Model/Colour/Discount should start as: the
  // bucket's current shared Model wins if this item actually offers it; otherwise a
  // single available entry gets force-selected same as before; Colour/Discount adopt
  // the bucket's shared values once a Model resolves, or fresh defaults if this is the
  // bucket's very first item.
  // Second half of state resolution, split out from resolveNewItemState so the
  // paired-frame auto-add below can reuse it with an entryIndex it already knows
  // (the exact matched item_key) instead of letting bucket-model-matching pick one.
  function resolveItemStateForEntry(entries, entryIndex, bucket) {
    const s = settingsFor(bucket)
    let variants = [], colourIndex = 0, discount_pct = 0
    let mrp = 0
    let colourMismatch = null
    if (entryIndex !== null) {
      const entry = entries[entryIndex]
      variants = catalogItems.filter(c => entry.itemKeys.includes(c.item_key))
      if (s.colour != null) {
        const colours = dedupeByColour(variants)
        const idx = colours.findIndex(v => v.colour === s.colour)
        colourIndex = idx >= 0 ? idx : 0
        // Same silent-wrong-colour trap as setItemColour, just on the add path:
        // this model simply doesn't stock the bucket's colour, so the row gets the
        // first one available and carries a flag saying so.
        if (idx < 0) colourMismatch = s.colour
      }
      discount_pct = s.discount != null ? s.discount : getPresetDiscount(presets, entry.brand, entry.model)
      const colours = dedupeByColour(variants)
      const variant = colours[colourIndex] || colours[0]
      mrp = variant ? Number(variant.mrp || 0) : 0
    }
    return { entryIndex, variants, colourIndex, discount_pct, mrp, colourMismatch }
  }

  function resolveNewItemState(entries, bucket) {
    const s = settingsFor(bucket)
    let entryIndex = null

    if (s.model) {
      const idx = entries.findIndex(e => e.brand === s.model.brand && e.model === s.model.model)
      if (idx >= 0) entryIndex = idx
    }
    if (entryIndex === null && entries.length === 1) entryIndex = 0

    return resolveItemStateForEntry(entries, entryIndex, bucket)
  }

  // True when this row's colourIndex reflects a deliberate resolution -- either the
  // only colour available, or one actually matched from the bucket's shared colour
  // setting -- rather than an arbitrary index-0 default that fired just because
  // nothing else had decided a colour yet (e.g. the first item added to an empty
  // bucket, where colourIndex falls back to 0 purely because dedupeByColour happened
  // to put some colour first). Used to gate the paired-frame check after a Model
  // change; an explicit colour pick from the dropdown always counts and skips this.
  function colourIsResolved(item) {
    const colours = dedupeByColour(item.variants)
    if (colours.length <= 1) return true
    const s = settingsFor(item.bucket)
    if (s.colour == null) return false
    return colours[item.colourIndex]?.colour === s.colour
  }

  // Resolves paired_frame_item_key off the exact catalog_items row the row's current
  // Model+Colour selection points at (never just "some" row for the model -- within a
  // merged multi-item_key entry, only some colours carry a frame, e.g. entice's
  // Vivid/Vibrant/Wooden colours do, White/Marble/Glass don't, since White's frame is
  // already built in) and, if set and not already added for that exact key, auto-adds
  // the matching Grid Frame through the normal add-item pipeline at the plate's qty.
  // Runs on every Model/Colour change on this row (not just once), since which colour
  // is picked is what decides whether a frame is even needed. `explicit` is true only
  // when the user just picked a colour directly -- that's always a deliberate choice,
  // unlike the colourIndex=0 default a Model change alone leaves behind.
  function checkPairedFrame(item, { explicit = false } = {}) {
    if (item.pairingSuppressed) return
    if (item.entryIndex === null) return
    if (!explicit && !colourIsResolved(item)) return
    const colours = dedupeByColour(item.variants)
    const variant = colours[item.colourIndex] || colours[0]
    const pairedKey = variant?.paired_frame_item_key || null
    if (!pairedKey) return
    if (item.pairedFrameKeyAdded === pairedKey) return
    if (addPairedFrameForKey(item, pairedKey)) item.pairedFrameKeyAdded = pairedKey
  }

  // generic_items.default_locked / default_discount — for items that are always sold at
  // one fixed discount no matter what the rest of the bucket is on (house-rate
  // consumables, wires, and anything else priced independently of the range). Such a
  // row is added already locked and carries its own discount from the start, so the
  // first bucket sync can't drag it onto the bucket's number before the rep has even
  // looked at it. It behaves exactly like any other locked row afterwards: unlocking it
  // by hand rejoins it to the bucket. This only decides the STARTING state.
  //
  // Both columns are read defensively: an installation whose generic_items doesn't have
  // them yet simply sees undefined and gets today's behaviour unchanged.
  function defaultLockState(genericItem, resolvedDiscount) {
    const locked = !!genericItem?.default_locked
    if (!locked) return { locked: false, discount_pct: resolvedDiscount }
    return {
      locked: true,
      discount_pct: genericItem.default_discount != null ? Number(genericItem.default_discount) || 0 : 0
    }
  }

  // Driven purely by paired_frame_item_key, not hardcoded to any specific range, so
  // this automatically extends to any future range with the same frame-separate
  // structure without new code. Returns the frame's generic item name, or null.
  function addPairedFrameForKey(item, pairedKey) {
    const mapEntry = genericItemMap.find(m => m.item_key === pairedKey)
    if (!mapEntry) return null
    const frameGenericItem = genericItems.find(g => g.id === mapEntry.generic_item_id)
    if (!frameGenericItem) return null

    const frameEntries = groupEntriesByModel(getMapEntriesFor(frameGenericItem.id, genericItemMap))
    const frameEntryIndex = frameEntries.findIndex(e => e.itemKeys.includes(pairedKey))
    if (frameEntryIndex === -1) return null

    const bucket = normalizeBucket(frameGenericItem.bucket)
    const resolved = resolveItemStateForEntry(frameEntries, frameEntryIndex, bucket)
    const lock = defaultLockState(frameGenericItem, resolved.discount_pct)
    items.push({
      description: frameGenericItem.name,
      genericItemId: frameGenericItem.id,
      bucket,
      qty: item.qty,
      entries: frameEntries,
      entryIndex: resolved.entryIndex,
      variants: resolved.variants,
      colourIndex: resolved.colourIndex,
      colourMismatch: resolved.colourMismatch,
      discount_pct: lock.discount_pct,
      mrp: resolved.mrp,
      locked: lock.locked,
      autoAdded: true,
      pairingSuppressed: true
    })
    seedBucketSettings(items.length - 1)
    return frameGenericItem.name
  }

  const isEditing = !!prefill?.editingQuotationId

  // Whole-quotation pricing mode — affects every row's Rate/Amount and the totals
  // block's shape, not just a display toggle. See rowAmount() and updateTotals().
  let pricingMode = prefill?.pricing_mode === 'discount_plus_tax' ? 'discount_plus_tax' : 'tax_paid'
  let gstRate = prefill?.gst_rate != null ? Number(prefill.gst_rate) : 18

  const todayFull = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  // Two most-recent facts only (created + last edited) — not a full revision history.
  function profileLabel(id) {
    const p = historyProfiles.find(pr => pr.id === id)
    return p ? (p.name || p.email || 'Unknown') : 'Unknown'
  }
  function formatDateTime(iso) {
    return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
  }
  const historyLine = isEditing && prefill.created_at
    ? `Created by ${profileLabel(prefill.created_by)} · ${formatDateTime(prefill.created_at)}`
      + (prefill.updated_at ? ` · Last edited by ${profileLabel(prefill.updated_by)} · ${formatDateTime(prefill.updated_at)}` : '')
    : ''

  // Rebuild a prior item list against the current generic_items catalog. Items whose
  // name no longer matches a generic item (e.g. an older quotation from before this
  // brand was mapped in) can't be carried over.
  //
  // Two callers feed this: "duplicate as new quotation" only passes {description, qty}
  // and wants fresh smart-defaults (a new quote, possibly a different model); "edit"
  // additionally passes {model, colour, discount_pct} — the exact values that were
  // saved — and those should be reconstructed exactly, not re-guessed.
  let items = []
  for (const it of (prefill?.items || [])) {
    const genericItem = genericItems.find(g => g.name.toLowerCase() === (it.description || '').toLowerCase())
    if (!genericItem) continue
    const entries = groupEntriesByModel(getMapEntriesFor(genericItem.id, genericItemMap))
    const bucket = normalizeBucket(genericItem.bucket)

    let entryIndex = it.model ? entries.findIndex(e => e.model === it.model) : -1
    let variants, colourIndex, discount_pct, mrp
    let colourMismatch = null
    // Restoring exact saved values (the "edit" path) keeps them as they were; a
    // default-locked item still starts locked so the bucket can't pull that saved
    // discount onto its own number the moment another row changes.
    let locked = !!genericItem.default_locked

    if (entryIndex >= 0) {
      const entry = entries[entryIndex]
      variants = catalogItems.filter(c => entry.itemKeys.includes(c.item_key))
      const colours = dedupeByColour(variants)
      const foundColourIdx = colours.findIndex(v => v.colour === it.colour)
      colourIndex = foundColourIdx >= 0 ? foundColourIdx : 0
      discount_pct = Number(it.discount_pct) || 0
      // Preserve a saved List Price override exactly (same reasoning as discount_pct
      // above) — fall back to the current catalog price only if none was saved.
      const variant = colours[colourIndex] || colours[0]
      mrp = it.mrp != null ? Number(it.mrp) : (variant ? Number(variant.mrp || 0) : 0)
    } else {
      const resolved = resolveNewItemState(entries, bucket)
      // No saved model to restore (the "duplicate as new quotation" path), so this is
      // a genuinely fresh row — default_discount applies the same as on a manual add.
      const lock = defaultLockState(genericItem, resolved.discount_pct)
      entryIndex = resolved.entryIndex
      variants = resolved.variants
      colourIndex = resolved.colourIndex
      colourMismatch = resolved.colourMismatch
      discount_pct = lock.discount_pct
      mrp = resolved.mrp
      locked = lock.locked
    }

    items.push({
      description: genericItem.name,
      genericItemId: genericItem.id,
      bucket,
      qty: it.qty || 1,
      entries,
      entryIndex,
      variants,
      colourIndex,
      colourMismatch,
      discount_pct,
      mrp,
      locked,
      // true: these rows are being reconstructed from an already-saved quotation
      // (duplicate or edit), not freshly added, so a later model/colour change here
      // shouldn't retroactively spawn a paired-frame row that was never asked for.
      pairingSuppressed: true
    })
    seedBucketSettings(items.length - 1)
  }

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-ghost" id="backBtn">← Back</button>
        <span class="logo-small">${isEditing ? 'Edit quotation' : 'New quotation'}</span>
        <span style="width:70px"></span>
      </header>
      <main class="app-main">
        <div class="qf-page">

          <!-- Card 1: Client -->
          <div class="qf-card qf-client-card">
            <div class="qf-card-head">
              <div class="qf-card-badge qf-badge-blue">👤</div>
              <h2>Client</h2>
            </div>
            <div class="qf-card-body">
              <div class="qf-field">
                <label>Client Name *</label>
                <div class="item-search-wrap">
                  <span class="qf-search-icon">🔍</span>
                  <input type="text" id="qf_name" value="${esc(prefill?.client_name || '')}" placeholder="Type to search existing clients, or add new..." autocomplete="off" />
                  <div class="item-suggestions" id="qf_nameSuggestions" hidden></div>
                </div>
              </div>
              <div class="qf-row2">
                <div class="qf-field">
                  <label>Phone</label>
                  <input type="text" id="qf_phone" value="${esc(prefill?.phone || '')}" placeholder="Phone number" />
                </div>
                <div class="qf-field">
                  <label>City</label>
                  <input type="text" id="qf_city" value="${esc(prefill?.city || '')}" placeholder="City" />
                </div>
              </div>
              <div class="qf-field qf-field-last">
                <label>Address</label>
                <input type="text" id="qf_address" value="${esc(prefill?.address || '')}" placeholder="Full address" />
              </div>
            </div>
          </div>

          <!-- Card 2: Meta strip -->
          <div class="qf-card qf-meta-strip">
            <div class="qf-card-body">
              <div class="qf-meta-row">
                <div class="qf-meta-seg">
                  <div class="qf-meta-label">Quotation</div>
                  <div class="qf-meta-val">${isEditing ? esc(prefill.quote_no || '—') : 'New Quotation'}</div>
                </div>
                <div class="qf-meta-seg">
                  <div class="qf-meta-label">Today</div>
                  <div class="qf-meta-val">${esc(todayFull)}</div>
                </div>
                <div class="qf-meta-seg">
                  <div class="qf-meta-label">Pricing mode</div>
                  <div class="qf-toggle-pair">
                    <button type="button" class="${pricingMode === 'tax_paid' ? 'active' : ''}" id="qf_modeTaxPaid">Tax Paid</button>
                    <button type="button" class="${pricingMode === 'discount_plus_tax' ? 'active' : ''}" id="qf_modeDiscountTax">Discount + Tax</button>
                  </div>
                  <div class="qf-gst-inline" id="qf_gstWrap" style="${pricingMode === 'discount_plus_tax' ? '' : 'display:none'}">
                    <label>GST %</label>
                    <input type="number" id="qf_gstRate" min="0" max="100" step="0.01" value="${gstRate}" />
                  </div>
                </div>
                <div class="qf-meta-seg qf-meta-seg-grow">
                  <div class="qf-meta-label">Quotation label (optional)</div>
                  <input type="text" id="qf_label" placeholder="e.g. Mixed order — switches + MCB" value="${esc(prefill?.label || '')}" />
                </div>
              </div>
            </div>
          </div>

          <!-- Card 3: Add item -->
          <div class="qf-card">
            <div class="qf-card-head">
              <div class="qf-card-badge qf-badge-green">🔍</div>
              <h2>Add item</h2>
            </div>
            <div class="qf-card-sub">Search by name, no need to know the brand or model first.</div>
            <div class="qf-card-body">
              <div class="qf-entry-row">
                <div class="item-search-wrap">
                  <input type="text" id="qf_itemSearch" placeholder="Type item name..." autocomplete="off" />
                  <div class="item-suggestions" id="qf_suggestions" hidden></div>
                </div>
                <input type="number" id="qf_qty" min="1" value="1" placeholder="Qty" class="qf-qty-input" />
                <button class="qf-btn-add" id="qf_addItemBtn">+ Add</button>
              </div>
              <div class="qf-hint">Type name → <kbd>↓</kbd><kbd>↑</kbd> to browse → <kbd>Enter</kbd> to select → qty → <kbd>Enter</kbd> adds the line.</div>
            </div>
          </div>

          <!-- Card 4: Pricing and items -->
          <div class="qf-card">
            <div class="qf-card-head">
              <div class="qf-card-badge qf-badge-purple">💰</div>
              <h2>Pricing and items</h2>
            </div>
            <div class="qf-card-body">
              <p class="empty-notes" id="qf_itemsEmpty">No items added yet.</p>

              <!-- Sits above the table/cards on purpose: these act on the whole list,
                   so they belong where the rep is looking before they start reading
                   rows, not tucked underneath them. -->
              <div class="qf-items-toolbar" id="qf_itemsToolbar" hidden>
                <div class="qf-toolbar-group">
                  <span class="qf-toolbar-label">Sort by</span>
                  <div class="qf-sort-buttons" id="qf_sortButtons">
                    <button type="button" data-sort="name">Item name</button>
                    <button type="button" data-sort="model">Model</button>
                    <button type="button" data-sort="colour">Colour</button>
                    <button type="button" data-sort="discount">Discount %</button>
                  </div>
                </div>
                <div class="qf-toolbar-group">
                  <button type="button" class="qf-toolbar-btn" id="qf_lockAllBtn" title="Lock every row at its current Model, Colour and Discount. Values don't change — they just stop following the bucket.">🔒 Lock all</button>
                  <button type="button" class="qf-toolbar-btn" id="qf_unlockAllBtn" title="Unlock every locked row. Each one rejoins its bucket and resets to the bucket's current Model, Colour and Discount.">🔓 Unlock all</button>
                </div>
              </div>

              <div class="items-table-wrap" id="qf_itemsTableWrap">
                <table class="items-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Model</th>
                      <th>Colour</th>
                      <th class="num">Qty</th>
                      <th class="num">List</th>
                      <th class="num">Disc</th>
                      <th class="num">Amount</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody id="qf_itemsBody"></tbody>
                </table>
              </div>
              <div class="item-cards" id="qf_itemCards"></div>

              <div class="totals-block" id="qf_totals"></div>

              ${historyLine ? `<div class="qf-status-bar" style="margin-top:14px"><span class="qf-status-left">${esc(historyLine)}</span></div>` : ''}

              <p id="qf_err" class="error-msg"></p>
              <div class="qf-actions">
                <button class="btn-ghost" id="qf_cancelBtn">Cancel</button>
                <button class="btn-primary" id="qf_saveBtn">${isEditing ? 'Save changes' : 'Save & Generate'}</button>
              </div>
            </div>
          </div>

        </div>
      </main>
    </div>
  `

  document.getElementById('backBtn').addEventListener('click', onBack)
  document.getElementById('qf_cancelBtn').addEventListener('click', onBack)

  // ---- Enter-as-Tab ----
  // Only ever attached to fields that have no Enter behaviour of their own. The item
  // search box and its Qty input keep the deliberate flow they already have
  // (type → arrow-select → Enter → qty → Enter adds the line) and are never passed here.
  const FOCUSABLE = 'input:not([type=hidden]), select, textarea, button'

  // Document order, minus anything currently not rendered — which is what keeps this
  // correct across the two item trees: on a narrow screen the desktop table is
  // display:none and on a wide one the mobile cards are, and a display:none element
  // has a null offsetParent, so only the visible tree's fields are ever walked into.
  function focusNextField(el) {
    const fields = [...container.querySelectorAll(FOCUSABLE)]
      .filter(f => !f.disabled && f.offsetParent !== null)
    const idx = fields.indexOf(el)
    if (idx === -1 || idx === fields.length - 1) return
    const next = fields[idx + 1]
    next.focus()
    if (next.tagName === 'INPUT' && typeof next.select === 'function') next.select()
  }

  function enterAsTab(el) {
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      focusNextField(el)
    })
  }

  // ---- Client search ----
  const nameInput = document.getElementById('qf_name')
  const nameSuggestBox = document.getElementById('qf_nameSuggestions')
  let nameSuggestions = []
  let nameHighlighted = -1

  function closeNameSuggestions() {
    nameSuggestBox.hidden = true
    nameSuggestBox.innerHTML = ''
    nameSuggestions = []
    nameHighlighted = -1
  }

  function renderNameSuggestions() {
    if (!nameSuggestions.length) { closeNameSuggestions(); return }
    nameSuggestBox.hidden = false
    nameSuggestBox.innerHTML = nameSuggestions.map((c, i) =>
      `<div class="suggestion-item ${i === nameHighlighted ? 'highlighted' : ''}" data-i="${i}">
        ${esc(c.client_name)}<div class="sheet-item-sub">${esc(c.whatsapp || c.phone || '—')} · ${esc(c.city || c.location || '—')}</div>
      </div>`
    ).join('')
    nameSuggestBox.querySelectorAll('.suggestion-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault()
        pickClient(Number(el.dataset.i))
      })
    })
  }

  // Toggling a class + scrolling the target into view (instead of re-rendering the
  // whole list) keeps arrow-key navigation from resetting scrollTop to 0 on every
  // press, which is what made the dropdown look "stuck" no matter how far you scrolled.
  function updateNameHighlight() {
    nameSuggestBox.querySelectorAll('.suggestion-item').forEach((el, i) => {
      el.classList.toggle('highlighted', i === nameHighlighted)
    })
    if (nameHighlighted >= 0) scrollHighlightedIntoView(nameSuggestBox, nameSuggestBox.children[nameHighlighted])
  }

  function pickClient(i) {
    const c = nameSuggestions[i]
    nameInput.value = c.client_name
    document.getElementById('qf_phone').value = c.whatsapp || c.phone || ''
    document.getElementById('qf_city').value = c.city || c.location || ''
    document.getElementById('qf_address').value = c.address || ''
    selectedProjectId = c.id
    closeNameSuggestions()
  }

  nameInput.addEventListener('input', () => {
    selectedProjectId = null
    nameSuggestions = clients.filter(c => tokenMatch(c.client_name, nameInput.value)).slice(0, 8)
    nameHighlighted = -1
    renderNameSuggestions()
  })
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); nameHighlighted = Math.min(nameHighlighted + 1, nameSuggestions.length - 1); updateNameHighlight() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nameHighlighted = Math.max(nameHighlighted - 1, 0); updateNameHighlight() }
    else if (e.key === 'Enter') {
      e.preventDefault()
      // Picking a client fills Phone/City/Address for you, so Enter stays put there
      // and lets the rep see what landed. With nothing highlighted there's no Enter
      // meaning to preserve, so it falls through to plain Enter-as-Tab.
      if (nameHighlighted >= 0 && nameSuggestions[nameHighlighted]) pickClient(nameHighlighted)
      else { closeNameSuggestions(); focusNextField(nameInput) }
    } else if (e.key === 'Escape') closeNameSuggestions()
  })
  nameInput.addEventListener('blur', () => setTimeout(closeNameSuggestions, 150))

  ;['qf_phone', 'qf_city', 'qf_address', 'qf_label'].forEach(id => enterAsTab(document.getElementById(id)))

  // ---- Item search — against the curated generic_items list, not raw catalog descriptions ----
  const searchInput = document.getElementById('qf_itemSearch')
  const qtyInput = document.getElementById('qf_qty')
  const suggestBox = document.getElementById('qf_suggestions')
  let suggestions = []
  let highlighted = -1
  let pickedGenericItem = null

  function closeSuggestions() {
    suggestBox.hidden = true
    suggestBox.innerHTML = ''
    suggestions = []
    highlighted = -1
  }

  function renderSuggestions() {
    if (!suggestions.length) { closeSuggestions(); return }
    suggestBox.hidden = false
    suggestBox.innerHTML = suggestions.map((g, i) => {
      const models = [...new Set(getMapEntriesFor(g.id, genericItemMap).map(e => e.model).filter(Boolean))]
      return `<div class="suggestion-item ${i === highlighted ? 'highlighted' : ''}" data-i="${i}">
        <div class="qf-suggest-name">${esc(g.name)}</div>
        ${models.length ? `<div class="qf-suggest-meta">Available in ${esc(models.join(', '))}</div>` : ''}
      </div>`
    }).join('')
    suggestBox.querySelectorAll('.suggestion-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault()
        pickSuggestion(Number(el.dataset.i))
      })
    })
  }

  // Same rationale as updateNameHighlight — swap classes and scroll, don't rebuild.
  function updateHighlight() {
    suggestBox.querySelectorAll('.suggestion-item').forEach((el, i) => {
      el.classList.toggle('highlighted', i === highlighted)
    })
    if (highlighted >= 0) scrollHighlightedIntoView(suggestBox, suggestBox.children[highlighted])
  }

  function pickSuggestion(i) {
    pickedGenericItem = suggestions[i]
    searchInput.value = pickedGenericItem.name
    closeSuggestions()
    qtyInput.focus()
    qtyInput.select()
  }

  searchInput.addEventListener('input', () => {
    pickedGenericItem = null
    const term = searchInput.value
    suggestions = term.trim() ? genericItems.filter(g => tokenMatch(g.name, term)) : []
    highlighted = -1
    renderSuggestions()
  })
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlighted = Math.min(highlighted + 1, suggestions.length - 1); updateHighlight() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlighted = Math.max(highlighted - 1, 0); updateHighlight() }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted >= 0 && suggestions[highlighted]) pickSuggestion(highlighted)
    } else if (e.key === 'Escape') closeSuggestions()
  })
  searchInput.addEventListener('blur', () => setTimeout(closeSuggestions, 150))

  function addItem() {
    if (!pickedGenericItem) { searchInput.focus(); return }
    const genericItem = pickedGenericItem
    const qty = Number(qtyInput.value) || 1
    const entries = groupEntriesByModel(getMapEntriesFor(genericItem.id, genericItemMap))
    const bucket = normalizeBucket(genericItem.bucket)
    const resolved = resolveNewItemState(entries, bucket)
    const lock = defaultLockState(genericItem, resolved.discount_pct)
    items.push({
      description: genericItem.name,
      genericItemId: genericItem.id,
      bucket,
      qty,
      entries,
      entryIndex: resolved.entryIndex,
      variants: resolved.variants,
      colourIndex: resolved.colourIndex,
      colourMismatch: resolved.colourMismatch,
      discount_pct: lock.discount_pct,
      mrp: resolved.mrp,
      locked: lock.locked,
      pairedFrameKeyAdded: null
    })
    const newItem = items[items.length - 1]
    // A new line lands at the bottom, in entry order — sorting is never automatic —
    // so whichever sort was last applied no longer describes the list, and the
    // toolbar stops claiming it does.
    activeSort = null
    seedBucketSettings(items.length - 1)
    checkPairedFrame(newItem)
    searchInput.value = ''
    pickedGenericItem = null
    qtyInput.value = '1'
    closeSuggestions()
    render()
    searchInput.focus()
  }
  document.getElementById('qf_addItemBtn').addEventListener('click', addItem)
  qtyInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addItem() } })

  // ---- Items table ----
  // Tax Paid Discount: rate = list price * (1 - discount%). Discount + Tax: same, then
  // GST added back on top — these are genuinely different final prices, not a display
  // toggle. List price reads from item.mrp — the editable, possibly rep-overridden
  // value for this line — never straight from the catalog variant.
  function rowAmount(item) {
    if (item.entryIndex === null) return { variant: null, rate: null, amount: null }
    const colours = dedupeByColour(item.variants)
    const variant = colours[item.colourIndex] || colours[0]
    if (!variant) return { variant: null, rate: null, amount: null }
    if (variant.on_request) return { variant, rate: null, amount: null }
    let rate = Number(item.mrp || 0) * (1 - (Number(item.discount_pct) || 0) / 100)
    if (pricingMode === 'discount_plus_tax') rate *= 1 + (Number(gstRate) || 0) / 100
    return { variant, rate, amount: rate * item.qty }
  }

  function updateTotals() {
    let grand = 0
    let totalMrp = 0
    let totalQty = 0
    let onRequestCount = 0
    let unresolvedCount = 0
    items.forEach(item => {
      totalQty += Number(item.qty) || 0
      const { variant, amount } = rowAmount(item)
      if (!variant) { unresolvedCount++; return }
      if (variant.on_request) { onRequestCount++; return }
      grand += amount
      totalMrp += Number(item.mrp || 0) * item.qty
    })
    const totalQtyRow = `<div class="totals-row"><span>Total Qty</span><span>${totalQty}</span></div>`

    let rowsHtml
    if (pricingMode === 'discount_plus_tax') {
      const gst = Number(gstRate) || 0
      const taxableValue = grand / (1 + gst / 100)
      const gstAmount = grand - taxableValue
      const totalDiscount = totalMrp - taxableValue
      rowsHtml = `
        ${totalQtyRow}
        <div class="totals-row"><span>Total List Price</span><span>${money(totalMrp)}</span></div>
        <div class="totals-row"><span>Total Discount</span><span>${money(totalDiscount)}</span></div>
        <div class="totals-row"><span>Taxable Value</span><span>${money(taxableValue)}</span></div>
        <div class="totals-row"><span>GST Amount (${gst}%)</span><span>${money(gstAmount)}</span></div>
        <div class="totals-row grand"><span>Grand Total</span><span>${money(grand)}</span></div>
      `
    } else {
      const totalDiscount = totalMrp - grand
      rowsHtml = `
        ${totalQtyRow}
        <div class="totals-row"><span>Total List Price</span><span>${money(totalMrp)}</span></div>
        <div class="totals-row"><span>Total Discount</span><span>${money(totalDiscount)}</span></div>
        <div class="totals-row grand"><span>Tax Paid Total</span><span>${money(grand)}</span></div>
      `
    }

    document.getElementById('qf_totals').innerHTML = `
      ${rowsHtml}
      ${onRequestCount ? `<p class="client-meta" style="text-align:right">+ ${onRequestCount} item(s) priced on request</p>` : ''}
      ${unresolvedCount ? `<p class="error-msg" style="text-align:right">${unresolvedCount} item(s) still need a model/colour</p>` : ''}
    `
  }

  // Every per-row interactive/display element carries a shared class + data-i instead
  // of a unique id, because each row now renders TWICE — once in the desktop table,
  // once in the mobile item card — and both instances always have to reflect the same
  // underlying item state, regardless of which breakpoint is actually visible.
  function fieldEls(cls, i) {
    return document.querySelectorAll(`.${cls}[data-i="${i}"]`)
  }

  // Just updates the Amount/List-price text for one row — no re-render, so it's safe
  // to call while the user is still typing in a discount input without stealing focus.
  function patchRowDisplay(i) {
    const item = items[i]
    const { variant, amount } = rowAmount(item)
    const amtText = variant?.on_request ? 'On request' : (amount == null ? '—' : money(amount))
    fieldEls('row-amount-display', i).forEach(el => { el.textContent = amtText })
  }

  // Qty and List Price are always per-row only (never synced). Discount syncs across
  // the whole bucket. All three patch the table AND card instance of the field
  // together (never just the one the user is typing in) directly in the DOM rather
  // than going through a full render(), so the input actively being typed in never
  // loses focus/cursor position mid-keystroke.
  function patchRow(i, field, sourceEl) {
    const item = items[i]
    if (field === 'qty') {
      const val = Number(sourceEl.value) || 1
      item.qty = val
      fieldEls('row-qty-input', i).forEach(el => { if (el !== sourceEl) el.value = val })
      patchRowDisplay(i)
      updateTotals()
      return
    }
    if (field === 'mrp') {
      item.mrp = sourceEl.value === '' ? 0 : Number(sourceEl.value)
      const colours = dedupeByColour(item.variants)
      const variant = colours[item.colourIndex] || colours[0]
      const isOverride = !!variant && !variant.on_request && Number(item.mrp) !== Number(variant.mrp || 0)
      fieldEls('row-mrp-input', i).forEach(el => {
        if (el !== sourceEl) el.value = item.mrp
        el.classList.toggle('mrp-override', isOverride)
      })
      patchRowDisplay(i)
      updateTotals()
      return
    }
    item.discount_pct = Number(sourceEl.value) || 0
    syncFromItem(i, 'discount')
    // Only rows in the SAME bucket can have been touched by that sync (resyncBucket
    // bails on every other bucket, and its discount branch touches nothing but the
    // discount), so only their inputs need repainting. The row being typed in is always
    // repainted too — it may itself be locked, in which case syncFromItem left the
    // bucket alone and this row's own number is the only thing that moved.
    patchRowDisplay(i)
    fieldEls('row-disc-input', i).forEach(el => { if (el !== sourceEl) el.value = item.discount_pct })
    items.forEach((it, idx) => {
      if (idx === i || it.bucket !== item.bucket) return
      fieldEls('row-disc-input', idx).forEach(el => { el.value = it.discount_pct })
      patchRowDisplay(idx)
    })
    updateTotals()
  }

  // Locking just stops future bucket syncs from touching this row — its current
  // values are left exactly as they are. Unlocking snaps it straight back to whatever
  // the rest of the bucket is set to right now, then it rejoins sync normally.
  function setLock(i, locked) {
    const item = items[i]
    if (item.locked === locked) return
    item.locked = locked
    if (!locked) {
      const s = settingsFor(item.bucket)
      const prevEntryIndex = item.entryIndex
      const prevColourIndex = item.colourIndex
      if (s.model) setItemModel(item, s.model)
      if (s.colour != null) setItemColour(item, s.colour)
      if (s.discount != null) item.discount_pct = s.discount
      // Only when rejoining actually moved the row onto a different variant — a row
      // that lands back exactly where it was keeps whatever List Price it was carrying,
      // override and all.
      if (item.entryIndex !== prevEntryIndex || item.colourIndex !== prevColourIndex) {
        item.mrp = catalogMrpFor(item)
      }
    }
  }

  function toggleLock(i) {
    setLock(i, !items[i].locked)
    render()
  }

  // Locks every row in one go, each at exactly the Model/Colour/Discount it is showing
  // right now — nothing is recalculated, the values are just pinned where they are.
  function lockAll() {
    items.forEach((item, i) => { if (!item.locked) setLock(i, true) })
    render()
  }

  // The mirror image, and it carries the same consequence a single row's unlock does:
  // rejoining the bucket snaps each row back onto the bucket's shared
  // Model/Colour/Discount. Confirmed first, because on a finished quotation that can
  // overwrite a lot of deliberately-set numbers at once.
  function unlockAll() {
    const lockedCount = items.filter(it => it.locked).length
    if (!lockedCount) return
    const msg = `Unlock ${lockedCount} row(s)? Each one rejoins its bucket, which resets it to the bucket's current Model, Colour and Discount.`
    if (!confirm(msg)) return
    items.forEach((item, i) => { if (item.locked) setLock(i, false) })
    render()
  }

  // ---- Sort ----
  // Manual and on demand only: nothing here ever runs on add or edit, so the list
  // stays in the rep's own entry order until they deliberately ask for a view of it.
  // Purely a reordering of `items` — no Model/Colour/Qty/Discount/List Price value is
  // read-modified-written by any of this. The array's order IS the sort_order that
  // gets written on save (see the itemPayload map), so print/PDF order follows.

  // "Generic" is a real brand value in generic_item_map, used for the unbranded
  // consumables (Electric Tape Roll, Round Plate, Fan Plate, Lapp wires and so on).
  // Those get pinned below everything else under every sort, so a priced review always
  // opens on the actual product lines.
  function isGenericBrand(item) {
    const entry = item.entryIndex !== null ? item.entries[item.entryIndex] : null
    if (entry) return entry.brand === 'Generic'
    return item.entries.length > 0 && item.entries.every(e => e.brand === 'Generic')
  }

  function modelLabelOf(item) {
    const entry = item.entryIndex !== null ? item.entries[item.entryIndex] : null
    return entry ? `${entry.brand} — ${entry.model}` : ''
  }
  function colourLabelOf(item) {
    if (item.entryIndex === null) return ''
    const colours = dedupeByColour(item.variants)
    return colours[item.colourIndex]?.colour || colours[0]?.colour || ''
  }

  // Keeps every row sharing a key adjacent, with the groups themselves in order of
  // first appearance and insertion order preserved inside each group. First-appearance
  // ordering (rather than alphabetical-by-key) means re-running the same sort is a
  // no-op and the list only ever moves as much as the grouping actually requires.
  function groupInOrder(rows, keyOf) {
    const groups = new Map()
    rows.forEach(r => {
      const k = keyOf(r.item)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(r)
    })
    return [...groups.values()].flat()
  }

  // Keys match the data-sort attributes on the toolbar's buttons.
  const SORTS = {
    name: rows => [...rows].sort((a, b) =>
      a.item.description.localeCompare(b.item.description, 'en', { sensitivity: 'base' }) || a.i - b.i),
    model: rows => groupInOrder(rows, modelLabelOf),
    colour: rows => groupInOrder(rows, colourLabelOf),
    // Highest discount first, so the outliers a final pricing review is looking for
    // sit at the top of their section instead of being buried mid-list.
    discount: rows => [...rows].sort((a, b) =>
      (Number(b.item.discount_pct) || 0) - (Number(a.item.discount_pct) || 0) || a.i - b.i)
  }

  let activeSort = null

  function applySort(key) {
    const sort = SORTS[key]
    if (!sort) return
    // Index carried alongside each row purely as the stable tiebreaker, so equal keys
    // never shuffle relative to how they were entered.
    const rows = items.map((item, i) => ({ item, i }))
    const generic = rows.filter(r => isGenericBrand(r.item))
    const main = rows.filter(r => !isGenericBrand(r.item))
    items = [...sort(main), ...sort(generic)].map(r => r.item)
    activeSort = key
    render()
  }

  function modelOptionsHtml(item) {
    return item.entries.map((e, ei) =>
      `<option value="${ei}" ${ei === item.entryIndex ? 'selected' : ''}>${esc(e.brand)} — ${esc(e.model)}</option>`
    ).join('')
  }
  function colourOptionsHtml(colours, item) {
    return colours.map((v, vi) =>
      `<option value="${vi}" ${vi === item.colourIndex ? 'selected' : ''}>${esc(v.colour || '—')}</option>`
    ).join('')
  }

  // The visible half of the bucket-sync colour fallback. A row that couldn't take the
  // bucket's colour says so in plain words instead of quietly showing a different one —
  // otherwise the only clue is a colour that looks stale next to a Discount that synced
  // perfectly, which is exactly how these rows went out wrong.
  function colourWarnHtml(item, colours) {
    if (!item.colourMismatch) return ''
    const shown = colours[item.colourIndex]?.colour || '—'
    return `<div class="colour-warn">Not in this model: ${esc(item.colourMismatch)} · using ${esc(shown)}</div>`
  }

  // The desktop table and the mobile item cards render from the exact same per-item
  // data every time — a full render() rebuilds both DOM trees together, so whichever
  // one the current viewport shows (CSS decides that, see the max-width:700px rule)
  // is always in sync with the other, even across a mid-edit window resize.
  function render() {
    const body = document.getElementById('qf_itemsBody')
    const cardsWrap = document.getElementById('qf_itemCards')
    const empty = document.getElementById('qf_itemsEmpty')
    empty.hidden = items.length > 0
    // Only the table needs hiding explicitly when empty — the mobile card wrap has
    // no header markup of its own, so an empty items array already leaves it with
    // nothing rendered inside it.
    document.getElementById('qf_itemsTableWrap').hidden = items.length === 0
    document.getElementById('qf_itemsToolbar').hidden = items.length === 0
    document.querySelectorAll('#qf_sortButtons button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === activeSort)
    })
    document.getElementById('qf_unlockAllBtn').disabled = !items.some(it => it.locked)
    document.getElementById('qf_lockAllBtn').disabled = !items.some(it => !it.locked)

    const rows = items.map((item, i) => {
      const hasEntry = item.entryIndex !== null
      const { variant, amount } = rowAmount(item)
      const modelLabel = hasEntry && item.entries[item.entryIndex] ? item.entries[item.entryIndex].model : ''
      const colours = hasEntry ? dedupeByColour(item.variants) : []
      const amtText = variant?.on_request ? 'On request' : (amount == null ? '—' : money(amount))
      return { item, i, hasEntry, variant, modelLabel, colours, amtText }
    })

    // Shared by both the desktop table cell and the mobile card field, so List Price
    // is editable (and shows the same override styling) in both trees.
    function mrpInputHtml(item, i, hasEntry, variant, style = '') {
      if (variant?.on_request) return 'On request'
      const isOverride = !!variant && Number(item.mrp) !== Number(variant.mrp || 0)
      return `<input type="number" min="0" step="0.01" class="mini-input row-mrp-input${isOverride ? ' mrp-override' : ''}" data-i="${i}" value="${item.mrp ?? 0}"${style ? ` style="${style}"` : ''} />`
    }

    body.innerHTML = rows.map(({ item, i, hasEntry, variant, modelLabel, colours, amtText }) => {
      const modelCell = item.entries.length === 0
        ? '<span class="error-msg">No brand/model mapped yet</span>'
        : `<select class="mini-select row-model-select" data-i="${i}">
            <option value="">Select model...</option>
            ${modelOptionsHtml(item)}
          </select>`

      const colourCell = hasEntry
        ? `<select class="mini-select row-colour-select${item.colourMismatch ? ' colour-mismatch' : ''}" data-i="${i}">${colourOptionsHtml(colours, item)}</select>${colourWarnHtml(item, colours)}`
        : '<span class="client-meta">Pick a model</span>'
      const mrpCell = mrpInputHtml(item, i, hasEntry, variant)

      return `
        <tr class="${item.locked ? 'row-locked' : ''}${item.colourMismatch ? ' row-colour-mismatch' : ''}">
          <td><div class="item-name">${esc(item.description)}</div>${modelLabel ? `<div class="item-sub">${esc(modelLabel)}</div>` : ''}${item.autoAdded ? '<div class="item-auto-note">Added automatically</div>' : ''}</td>
          <td>${modelCell}</td>
          <td>${colourCell}</td>
          <td class="num"><input type="number" min="1" class="mini-input row-qty-input" data-i="${i}" value="${item.qty}" /></td>
          <td class="num">${mrpCell}</td>
          <td class="num"><input type="number" min="0" max="100" class="mini-input row-disc-input" data-i="${i}" value="${item.discount_pct}" ${hasEntry && variant ? '' : 'disabled'} /></td>
          <td class="num row-amount-display" data-i="${i}">${amtText}</td>
          <td>
            <button type="button" class="lock-btn row-lock-toggle ${item.locked ? 'locked' : ''}" data-i="${i}" title="${item.locked ? 'Locked — detached from bucket sync. Click to unlock.' : 'Unlocked — synced with the rest of this bucket. Click to lock.'}">${item.locked ? '🔒' : '🔓'}</button>
            <button type="button" class="row-x row-remove" data-i="${i}">×</button>
          </td>
        </tr>
      `
    }).join('')

    cardsWrap.innerHTML = rows.map(({ item, i, hasEntry, variant, modelLabel, colours, amtText }) => {
      const modelSelect = item.entries.length === 0
        ? '<span class="error-msg">No brand/model mapped yet</span>'
        : `<select class="mini-select row-model-select" data-i="${i}" style="width:100%;">
            <option value="">Select model...</option>
            ${modelOptionsHtml(item)}
          </select>`
      const colourSelect = hasEntry
        ? `<select class="mini-select row-colour-select${item.colourMismatch ? ' colour-mismatch' : ''}" data-i="${i}" style="width:100%;">${colourOptionsHtml(colours, item)}</select>${colourWarnHtml(item, colours)}`
        : '<span class="client-meta">—</span>'
      const mrpCell = mrpInputHtml(item, i, hasEntry, variant, 'width:100%;')

      return `
        <div class="item-card ${item.locked ? 'row-locked' : ''}${item.colourMismatch ? ' row-colour-mismatch' : ''}">
          <div class="item-card-top">
            <div><div class="item-name">${esc(item.description)}</div>${modelLabel ? `<div class="item-sub">${esc(modelLabel)}</div>` : ''}${item.autoAdded ? '<div class="item-auto-note">Added automatically</div>' : ''}</div>
            <div>
              <button type="button" class="lock-btn row-lock-toggle ${item.locked ? 'locked' : ''}" data-i="${i}">${item.locked ? '🔒' : '🔓'}</button>
              <button type="button" class="row-x row-remove" data-i="${i}">×</button>
            </div>
          </div>
          <div class="item-card-grid">
            <div><label>Model</label>${modelSelect}</div>
            <div><label>Colour</label>${colourSelect}</div>
            <div><label>Qty</label><input type="number" min="1" class="mini-input row-qty-input" data-i="${i}" value="${item.qty}" style="width:100%;" /></div>
            <div><label>Disc %</label><input type="number" min="0" max="100" class="mini-input row-disc-input" data-i="${i}" value="${item.discount_pct}" style="width:100%;" ${hasEntry && variant ? '' : 'disabled'} /></div>
            <div style="grid-column: 1 / -1;"><label>List Price</label>${mrpCell}</div>
          </div>
          <div class="item-card-amount">
            <span class="amt row-amount-display" data-i="${i}">${amtText}</span>
          </div>
        </div>
      `
    }).join('')

    // Model/Colour selects and the remove/lock buttons already trigger a full
    // render() on change, so both DOM trees just need the same listener logic bound
    // once per tree — no cross-instance patching required for these.
    ;[body, cardsWrap].forEach(container => {
      container.querySelectorAll('.row-model-select').forEach(el => el.addEventListener('change', () => {
        const i = Number(el.dataset.i)
        const item = items[i]
        const entryIndex = el.value === '' ? null : Number(el.value)
        item.entryIndex = entryIndex
        // A new model means a new colour list, so any previous "couldn't give you
        // that colour" verdict is stale. The resync below re-flags it if the bucket's
        // colour is missing from this model too.
        item.colourMismatch = null
        if (entryIndex !== null) {
          const entry = item.entries[entryIndex]
          item.variants = catalogItems.filter(c => entry.itemKeys.includes(c.item_key))
          item.colourIndex = 0
          item.discount_pct = getPresetDiscount(presets, entry.brand, entry.model)
          item.mrp = catalogMrpFor(item)
          syncFromItem(i, 'model')
          checkPairedFrame(item)
        } else {
          item.variants = []
          item.colourIndex = 0
          item.discount_pct = 0
          item.mrp = 0
        }
        render()
      }))
      container.querySelectorAll('.row-colour-select').forEach(el => el.addEventListener('change', () => {
        const i = Number(el.dataset.i)
        items[i].colourIndex = Number(el.value)
        // Picking a colour by hand is the answer to the "couldn't give you that
        // colour" flag, so the flag comes off this row whatever they picked.
        items[i].colourMismatch = null
        items[i].mrp = catalogMrpFor(items[i])
        syncFromItem(i, 'colour')
        checkPairedFrame(items[i], { explicit: true })
        render()
      }))
      container.querySelectorAll('.row-remove').forEach(el => el.addEventListener('click', () => {
        items.splice(Number(el.dataset.i), 1)
        render()
      }))
      container.querySelectorAll('.row-lock-toggle').forEach(el => el.addEventListener('click', () => toggleLock(Number(el.dataset.i))))
      container.querySelectorAll('.row-qty-input').forEach(el => el.addEventListener('input', () => patchRow(Number(el.dataset.i), 'qty', el)))
      container.querySelectorAll('.row-mrp-input').forEach(el => el.addEventListener('input', () => patchRow(Number(el.dataset.i), 'mrp', el)))
      container.querySelectorAll('.row-disc-input').forEach(el => el.addEventListener('input', () => patchRow(Number(el.dataset.i), 'discount', el)))
      // None of the per-row inputs has an Enter meaning of its own (unlike the Add
      // item box and its Qty field, which are left exactly as they are), so Enter
      // just walks to the next field the way Tab does.
      container.querySelectorAll('.row-qty-input, .row-mrp-input, .row-disc-input').forEach(enterAsTab)
    })

    updateTotals()
  }

  // ---- Items toolbar (sort + bulk lock) ----
  document.getElementById('qf_lockAllBtn').addEventListener('click', lockAll)
  document.getElementById('qf_unlockAllBtn').addEventListener('click', unlockAll)
  document.querySelectorAll('#qf_sortButtons button').forEach(btn => {
    btn.addEventListener('click', () => applySort(btn.dataset.sort))
  })

  render()

  // ---- Pricing mode toggle ----
  function updatePricingModeUI() {
    document.getElementById('qf_modeTaxPaid').classList.toggle('active', pricingMode === 'tax_paid')
    document.getElementById('qf_modeDiscountTax').classList.toggle('active', pricingMode === 'discount_plus_tax')
    document.getElementById('qf_gstWrap').style.display = pricingMode === 'discount_plus_tax' ? '' : 'none'
  }
  document.getElementById('qf_modeTaxPaid').addEventListener('click', () => {
    pricingMode = 'tax_paid'
    updatePricingModeUI()
    render()
  })
  document.getElementById('qf_modeDiscountTax').addEventListener('click', () => {
    pricingMode = 'discount_plus_tax'
    updatePricingModeUI()
    render()
  })
  document.getElementById('qf_gstRate').addEventListener('input', () => {
    gstRate = Number(document.getElementById('qf_gstRate').value) || 0
    render()
  })

  // ---- Save & Generate ----
  document.getElementById('qf_saveBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('qf_err')
    errEl.textContent = ''
    const name = document.getElementById('qf_name').value.trim()
    const phone = document.getElementById('qf_phone').value.trim()
    const city = document.getElementById('qf_city').value.trim()
    const address = document.getElementById('qf_address').value.trim()
    const label = document.getElementById('qf_label').value.trim()

    if (!name) { errEl.textContent = 'Client name is required'; return }
    if (!items.length) { errEl.textContent = 'Add at least one item'; return }

    const rows = items.map(item => {
      const entry = item.entryIndex !== null ? item.entries[item.entryIndex] : null
      const colours = entry ? dedupeByColour(item.variants) : []
      const variant = entry ? (colours[item.colourIndex] || colours[0]) : null
      return { item, variant }
    })
    if (rows.some(r => !r.variant)) { errEl.textContent = 'Every item needs a model and colour before saving'; return }

    const btn = document.getElementById('qf_saveBtn')
    const savingLabel = isEditing ? 'Save changes' : 'Save & Generate'
    btn.disabled = true; btn.textContent = 'Saving...'

    const { data: { user } } = await supabase.auth.getUser()

    let grandTotal = 0
    const itemPayload = rows.map(({ item, variant }, index) => {
      const onRequest = !!variant.on_request
      let rate = onRequest ? null : Number(item.mrp || 0) * (1 - (Number(item.discount_pct) || 0) / 100)
      if (!onRequest && pricingMode === 'discount_plus_tax') rate *= 1 + (Number(gstRate) || 0) / 100
      const amount = onRequest ? null : rate * item.qty
      if (!onRequest) grandTotal += amount
      return {
        description: item.description,
        category: variant.category,
        sub_category: variant.sub_category,
        model: variant.model,
        colour: variant.colour,
        cat_no: variant.cat_no,
        qty: item.qty,
        mrp: onRequest ? variant.mrp : item.mrp,
        discount_pct: item.discount_pct,
        rate,
        amount,
        on_request: onRequest,
        // The on-screen order IS the print/PDF order — applySort() reorders `items`
        // and nothing else, so whatever arrangement the rep is looking at when they
        // save is what quotation-view.js reads back out of sort_order.
        sort_order: index
      }
    })

    // Link to the explicitly picked client, or fall back to matching by phone, or create a new lead.
    let projectId = selectedProjectId
    if (!projectId) {
      const key = matchKey(phone)
      if (key) {
        const candidates = await fetchAllRows('projects', 'id, whatsapp, phone')
        const found = candidates.find(p => matchKey(p.whatsapp) === key || matchKey(p.phone) === key)
        if (found) projectId = found.id
      }
    }

    const { brand: derivedBrand, model: derivedModel } = deriveBrandModel(rows)
    const productCategory = [derivedBrand, derivedModel].filter(Boolean).join(' – ')
      || [...new Set(itemPayload.map(p => p.model).filter(Boolean))].join(', ')

    if (projectId) {
      await supabase.from('projects').update({
        status: 'Quotation Given',
        value: grandTotal,
        product_category: productCategory
      }).eq('id', projectId)
    } else {
      const { data: newProject, error: projErr } = await supabase.from('projects').insert([{
        client_name: name,
        whatsapp: phone,
        location: city,
        address,
        status: 'Quotation Given',
        value: grandTotal,
        product_category: productCategory,
        created_by: user.id
      }]).select().single()
      if (projErr) {
        errEl.textContent = projErr.message
        btn.disabled = false; btn.textContent = savingLabel
        return
      }
      projectId = newProject.id
    }

    const quotationFields = {
      client_name: name,
      phone,
      address,
      city,
      brand: derivedBrand,
      model: derivedModel,
      label: label || null,
      project_id: projectId,
      pricing_mode: pricingMode,
      gst_rate: Number(gstRate) || 18
    }

    let quotationId
    if (isEditing) {
      quotationId = prefill.editingQuotationId
      const { error: qErr } = await supabase.from('quotations').update(quotationFields).eq('id', quotationId)
      if (qErr) {
        errEl.textContent = qErr.message
        btn.disabled = false; btn.textContent = savingLabel
        return
      }
      // Replace the item set wholesale rather than diffing — simpler and safe since
      // quotation_items has no other table referencing it.
      const { error: delErr } = await supabase.from('quotation_items').delete().eq('quotation_id', quotationId)
      if (delErr) {
        errEl.textContent = delErr.message
        btn.disabled = false; btn.textContent = savingLabel
        return
      }
    } else {
      const { data: quotation, error: qErr } = await supabase.from('quotations').insert([{ ...quotationFields, created_by: user.id }]).select().single()
      if (qErr) {
        errEl.textContent = qErr.message
        btn.disabled = false; btn.textContent = savingLabel
        return
      }
      quotationId = quotation.id
    }

    const { error: itemsErr } = await supabase.from('quotation_items').insert(
      itemPayload.map(p => ({ ...p, quotation_id: quotationId }))
    )
    if (itemsErr) {
      errEl.textContent = itemsErr.message
      btn.disabled = false; btn.textContent = savingLabel
      return
    }

    renderQuotationView(container, quotationId, onBack)
  })
}
