# JCM-Tools: Order Planning Module — Handover Spec

## 0. Project rename
Rename the existing CRM/quotation generator project (currently in VS Code) from
its current name to **JCM-Tools**. This is becoming a multi-tool suite
(CRM + Quotation Generator + Order Planning, more to come), not a single app.
Update package.json's "name" field, the repo/folder name if convenient, and
any header/title text in the app shell that shows the old name.

## 1. What already exists (do not rebuild)

- **Stack**: Vite + vanilla JS + Supabase + Vercel.
- **Existing modules**: CRM (site tracker) and Quotation Generator, already
  live in this project with their own Supabase tables.
- **New, already-working piece** (built outside this codebase, just needs
  wiring in): a Node.js sync script (`busy-sync/sync.js`) running nightly via
  Windows Task Scheduler on the office server PC. It pulls data directly from
  Busy's SQL Server database and pushes it into Supabase. **This script is
  NOT part of the Vite app and doesn't need to be touched** — it just needs
  to keep running as-is. The app only ever reads from Supabase.

## 2. Data already flowing into Supabase (from the nightly sync)

### `items` table
Active, currently-priced items only (~4,409 rows). Columns:
`code` (int, PK), `name`, `alias`, `hsn_code`, `purchase_rate`, `sale_rate`,
`mrp`, `category_path` (text, e.g. `"Larsen & Toubro Limited > Retail Mitra >
WA Accessories > enGem > enGem Stone Grey"`), `stock_qty`, `stock_value`,
`avg_rate`, `stock_source` (`'daily_sum'` = live/reliable current-year
stock, `'needs_manual_check'` = item hasn't transacted this year, stock
figure may be stale opening balance), `last_synced_at`.

### `item_sales_history` table
Daily movement per item, last 180 days, refreshed nightly.
`item_code`, `txn_date`, `qty_in`, `qty_out`.

### `reorder_settings` table
Per-item overrides, empty by default (app should apply sensible fallbacks
when a row doesn't exist — see views below).
`item_code` (PK), `target_weeks_cover` (default 3), `min_order_qty`
(default 1), `preferred_vendor`.

### `sync_log` table
One row per nightly sync run: `run_at`, `items_synced`, `sales_rows_synced`,
`status` (`'success'`/`'error'`), `error_message`. Useful for a small
"last synced: X hours ago" indicator somewhere in the UI.

### Two SQL views (already created in Supabase, just query them)

**`item_velocity`** — one row per item with:
`code, name, alias, category_path, brand` (top-level of category_path,
useful for grouping by supplier/brand), `stock_qty, stock_source,
sale_rate, purchase_rate, avg_weekly_qty, weeks_with_sales, weeks_tracked,
review_cadence` (`'weekly'` / `'biweekly'` / `'monthly'` / `'dormant'`,
based on how many of the last 8 weeks had any sales).

**`reorder_suggestions`** — everything in `item_velocity` plus:
`target_weeks_cover, min_order_qty, preferred_vendor, suggested_order_qty`
(computed: `(avg_weekly_qty × target_weeks_cover) − stock_qty`, floored at
0, rounded up to `min_order_qty` multiples).

## 3. What to build: Order Planning module

Add as a new section/route in the existing app shell, matching the nav
pattern already used for CRM / Quotation Generator.

### Screen A — Reorder Dashboard (main screen)
Three tabs or filter toggles: **Weekly / Biweekly / Monthly**, each querying
`reorder_suggestions` filtered by `review_cadence` and `suggested_order_qty > 0`.

Table columns: item name, alias, brand, current stock, avg weekly sales,
suggested order qty, purchase rate, estimated order value
(`suggested_order_qty × purchase_rate`).

- Group/sortable by `brand` (since POs are placed per vendor).
- Show a small badge on rows where `stock_source = 'needs_manual_check'`,
  since that item's stock number may be stale — a tooltip explaining
  "This item hasn't sold recently in Busy; stock shown may be outdated,
  verify before ordering" is enough, no need to block ordering.
- Running total of estimated order value per brand group (helps at a
  glance when deciding whether a PO clears a vendor's minimum order value).
- A "last synced" timestamp pulled from the latest `sync_log` row, shown
  somewhere visible (e.g. top-right corner) — if it's more than ~36 hours
  old, show a subtle warning that the nightly sync may have missed a run.

### Screen B — Item Settings (adjust reorder targets)
Simple searchable/filterable table of items where you can edit
`target_weeks_cover`, `min_order_qty`, and `preferred_vendor` per item —
writes to `reorder_settings` (upsert). Doesn't need to be fancy; a basic
editable table is fine. Most items will never need a custom row here — only
show the override editor when the user searches for a specific item, don't
try to list all 4,409 by default.

### Screen C — Declutter / Dead Stock List
Read-only reference list, sourced from a third SQL view, `declutter_candidates`
(query `items` joined to `item_velocity` filtered to `review_cadence =
'dormant'` — see reorder-logic.sql, already updated with this view). This is
LIVE and self-maintaining: it recalculates every night after the sync runs,
no manual re-export ever needed, unlike the one-time analysis we did during
setup.

Note: `items` only ever contains priced items (unpriced items are excluded
at the sync-query level entirely, never reach Supabase). So this view
surfaces "priced but hasn't sold in ~26 weeks" items — the genuinely
actionable delete candidates — not the already-excluded unpriced/never-synced
items, which don't need a screen since the app never shows them anywhere
regardless.

Purpose: lets the user review and cross-check against Busy before manually
deleting items there (the app should never delete anything itself — Busy
item deletion must happen in Busy's own UI). Simple table + CSV
download/"copy to clipboard" button is enough, no need for anything fancier.

## 4. Important constraints / things to preserve

- **Never write to Busy directly** — this app only reads from Supabase.
  All Busy-side changes (item deletion, price changes, etc.) happen in
  Busy's own UI, outside this app entirely.
- The Supabase client in this Vite app should keep using the **anon/publishable
  key** (not the secret/service_role key used by the sync script) — normal
  RLS-protected client access, consistent with however the existing
  CRM/Quotation modules are already set up.
- Match the existing app's visual style/component patterns rather than
  introducing a new design language for this module.

## 5. Suggested build order
1. Item Settings screen (simplest, validates read/write to `reorder_settings`)
2. Reorder Dashboard — Weekly tab first, then Biweekly/Monthly (same query,
   different filter)
3. Brand grouping + running totals
4. "Last synced" indicator
5. Declutter screen (lowest priority, confirm approach with user first)
