# JCM Tools App — Wiring Handover (for Claude Code)

**Owner:** Shishir (J.C. Mittal & Sons / JCM Retails, Ratlam)
**Date:** 2 Oct 2026
**Goal:** Make the 3-tab mobile app (Inventory · Quotation · Task Board) work with real data, matching the approved design.

> **How to work with Shishir:** he is not a developer. Work in the phases below, **one phase at a time**. At the end of each phase, stop and report in plain language: what you changed, which files you touched, and what he needs to do (for example, run something on JCM-Server or in the Supabase SQL Editor). Always say **where** a command or query has to be run. Wait for his OK before starting the next phase.

---

## 0. Background (read first)

- **The app:** "JCM Tools" Android app, app ID `com.jcmretails.tools`. It is built with Capacitor around the existing CRM (`jcm-crm.vercel.app`) and has a bottom-navigation shell with only 3 tabs. The APK is built by a cloud GitHub Actions workflow, so nobody needs Android Studio.
- **Stack:** Vite + Supabase + Vercel serverless functions (`/api/*`).
- **Supabase projects (two of them; check which one each table is in):**
  - **CRM project** `cmtnzmfuasniicsdxyle`: `projects`, `notes`, `profiles`, `quotations`, `meetings`, and the task-board table (`team_jobs`, or whatever the Task Board tab uses now).
  - **JCM-Busysql project**: Busy-synced data (items, stock, invoices, dues). The item/stock data for Inventory should already be here from the nightly `sync.js`.
- **Busy sync:** Node.js scripts on **JCM-Server** (reached over RDP) in `D:\JCM-Supabase\files`, run by Windows Task Scheduler. SQL Server is reached as `localhost,1433`. Items are `Master1` with `MasterType=6`. Stock movement is in `DailySum` (`Cr2` = qty in, `Dr2` = qty out). Godown is filtered to `MasterCode2=201` (Freeganj).
- **Security rules already in place (keep them):**
  - The browser/app never holds the Supabase service key. Server-side access goes through Vercel `/api/*` functions.
  - Login uses the existing CRM auth. `profiles.role` says who someone is; `profiles.is_admin` says what they can do. Tab access comes from `profiles.allowed_tabs`.
  - The service key format is `sb_secret_...`, and the URL has no `/rest/v1/` suffix.
- **Git:** commit from the cmd terminal (not PowerShell). Never commit `dist/`.

### Design reference
The approved screens are on Shishir's Claude Design canvas **"JCM Tools — App Screens"**: Inventory, Quotation – Builder, Quotation – Review & Share, Task Board, and Task Board – File a task. Match their layout, colours and labels:

| Token | Value |
|---|---|
| Navy (header, primary buttons) | `#12213B` |
| Gold (accent, active tab bar, highlight buttons) | `#D9AE55` |
| App background | `#F3F4F6` |
| Card | `#FFFFFF`, border `#E3E5EA`, radius 16px |
| Muted text | `#5B6270` |
| Urgent / red | bg `#FDE2E0`, text `#9B1C1C`, dot `#C8312B` |
| Due soon / yellow | bg `#FEF3C7`, text `#7A4B00`, dot `#D99A00` |
| Routine / green | bg `#DCF2E3`, text `#155C33`, dot `#1F8A4C` |
| Fonts | Playfair Display (screen titles only), Inter (everything else), tabular numbers |
| Touch targets | 44px or more; inputs 16px font (stops iOS/Android zoom) |

Bottom nav: **Inventory · Quotation · Task Board**. The active tab has a 3px gold top border and navy bold text.

---

## Phase 1 — Look before changing anything

1. Find the existing code for:
   - the app shell / bottom navigation
   - the CRM **Quotations** tab (all its fields, brand item lists, PDF/letterhead output, handwritten-list OCR via `/api/parse-handwritten-list.js`, WhatsApp share, logging to a project)
   - the CRM **Task Board** tab (table name, columns, how tasks are filed, the history log, Realtime subscription, the Payments restriction)
2. In the **JCM-Busysql** Supabase project, find the table or view that has the item master and current stock. It should have the item name, item code, MRP, sale rate, stock qty, unit, group/brand, and reorder level if there is one.
3. Check how the Capacitor app loads the CRM: does it load the remote Vercel URL, or a bundled build? This decides whether `/api/...` calls can stay relative or need an absolute base URL.
4. **Report back** with a short table: feature → existing file/endpoint/table → reuse or new. Do not write code yet.

---

## Phase 2 — Inventory tab (new)

### 2a. Faster stock sync (on JCM-Server)
The current Busy sync only runs nightly. Inventory needs stock refreshed **about every 10 minutes**.

- Create a light script `sync-stock-live.js` beside the existing sync scripts. It should:
  - read only the items and their current stock: `Master1` with `MasterType=6`, and stock for godown `MasterCode2=201`. Reuse the existing `LatestStock` logic from `sync.js`; don't rewrite it.
  - include unpriced items too (the earlier `sale_rate > 0` filter bug was fixed, so don't bring it back).
  - upsert into the same items/stock table in Supabase, and set an `updated_at`.
  - write a row to `sync_log` (job name, start time, end time, rows written, error text) so failures leave a trace.
- Give Shishir the exact Windows Task Scheduler steps to run it **every 10 minutes**, one step at a time.
- Keep the nightly full sync as it is.

### 2b. Endpoint `GET /api/inventory/search?q=<text>&group=<group>&limit=30`
- Runs on the server with the service key and checks the CRM login token.
- Search: split `q` into words; **every** word must appear in the item name or item code (case-insensitive). Use `ilike`, or a `pg_trgm` index if it's slow. With 9,000+ items, add an index.
- Leave out discontinued items and stray item-group rows.
- Response:

```json
{
  "synced_at": "2026-10-02T13:54:00+05:30",
  "count": 30,
  "items": [
    {
      "code": "ATB-REN-1200-MB",
      "name": "Atomberg Renesa 1200mm BLDC Ceiling Fan — Matt Black",
      "group": "Fans",
      "mrp": 4990,
      "sale_price": 3650,
      "stock_qty": 18,
      "unit": "Pcs",
      "reorder_level": 5
    }
  ]
}
```

- `synced_at` = the latest successful `sync-stock-live` run from `sync_log`.

### 2c. Endpoint `GET /api/inventory/groups`
- Returns the chip list (the top-level item groups or brand divisions). Ask Shishir which level of the Busy item-group tree to show as chips.

### 2d. Screen behaviour (from the design)
- The search box sits in the navy header. Search as he types, with a 250ms debounce, and cancel the previous request when a new one starts.
- Below the search: a "Synced X min ago · refreshes every 10 min" line with a green dot. If the last sync is more than 30 min old, show the dot amber and say "Stock may be out of date".
- Each card shows: name, item code (monospace), **MRP**, **Sales price** (bold), and a **highlighted stock box** on the right:
  - stock > reorder level → navy box, gold number, label "In stock"
  - 0 < stock ≤ reorder level → orange box, label "Low"
  - stock ≤ 0 → red box, label "Nil"
  - no reorder level → use 0
- The refresh button in the header re-runs the search. It does **not** trigger a Busy sync.
- Empty state: "No items match “…”". Show a loading skeleton while waiting.

---

## Phase 3 — Quotation tab (mobile version of the CRM Quotations tab)

**Rule: reuse the CRM's existing quotation logic, APIs and item data.** This is a new mobile layout, not a new quotation system. Every feature in the CRM tab must still work.

Builder screen:
- Customer section: Name, Mobile, City, plus **"Link to a CRM project (optional)"**, which opens a searchable list from `projects`.
- Brand chips come from the existing brand databases (Schneider Zeta, L&K enCurve, L&K Tripper, L&K Tripbox NXT, L&K DY MCCB, Legrand RX3, Generic, and any others). Item search covers the selected brand and uses the existing endpoint or query.
- Gold camera button = **scan handwritten list**. Use Capacitor Camera (or a file input with `capture`) → existing `/api/parse-handwritten-list.js` → add the matched lines. Let him confirm any line that didn't match.
- Item lines: name, code, rate, **− qty +** stepper, line amount, delete.
- Discount quick-pick (0 / 5 / 10 / 15 %). Keep any custom-discount or per-line discount the CRM already supports.
- Totals use the CRM's existing rules (GST inclusive or exclusive, rounding). Don't invent new maths.
- Fixed bottom bar: item count, total pcs, grand total, **Review** button.
- Autosave the draft on the device so an app restart doesn't lose it.

Review & Share screen:
- A live preview of the real letterhead output: navy/gold, QR code, compact bank details (SBI · IFSC SBIN0009452 · UPI 7415277521-1@okbizaxis).
- Options: show item codes on PDF, validity (7 / 15 / 30 days), log to CRM project.
- Buttons:
  - **Share on WhatsApp:** generate the PDF, then use the Capacitor Share plugin (`@capacitor/share` + `@capacitor/filesystem`) so the PDF file goes into WhatsApp. A `wa.me` link can only send text.
  - **Download PDF**
  - **Save only**
- Saving writes to `quotations` exactly as the CRM does now, including the quote number, and links the project if one was picked.
- A "Saved" button in the header opens the list of past quotations: search, open, duplicate.

Endpoints: list the ones you reuse. Add new ones only if the CRM tab currently talks to Supabase straight from the browser in a way that won't work inside the app.

---

## Phase 4 — Task Board tab (mobile version of the CRM Task Board)

**Same table, same rules, same Realtime as the CRM tab.** A task filed on the phone must appear on office computers instantly, and the other way round.

Board screen:
- The header has the count of open tasks and a **Mine / Team** switch.
- Three count tiles: Urgent (red), Due soon (yellow), Routine (green).
- Filter chips: All · Payments · Material orders · Client requests · Service urgencies, each with a count. Add a chip automatically if new card types appear later (meetings, reminders, client appointments).
- Tasks are grouped by type and sorted red → yellow → green, then by due time.
- **Payments is visible only to Shishir and Ruchir.** Enforce this on the **server/query**, not only by hiding it in the app.
- Tap a task to expand it:
  - linked project/quotation chip
  - **Mark done / Reassign / To Shishir**
  - history log (who filed, passed or closed it, and when)
  - every action writes a history entry, using the same mechanism the CRM uses
- Bottom bar "@ File a task…" + gold **+** opens the File-a-task sheet.

File-a-task sheet:
- Task type tiles (4).
- Assign to: avatars from `profiles`. Exclude accounts flagged `hide_from_roster`. When the type is Payment, show only Shishir and Ruchir.
- Details text, plus an optional link to a project or quotation.
- Deadline:
  - quick presets (In 1 hour, Today 6 PM, Tomorrow 10 AM, In 3 days)
  - **15-day date strip**
  - time chips
  - a live preview: "Due … · Shows as Urgent/Due soon/Routine"
- The submit button reads "File task to @Name".
- **Colour is worked out from the deadline, never stored.** Use the **same thresholds the CRM uses**. The design assumed red ≤ 4 h, yellow ≤ 48 h, green otherwise. Confirm the real values from the CRM code and use them in **one shared function** that both the CRM and the app import. Re-check colours every minute so a task turns red without a refresh.

Also check:
- Realtime keeps working when the app goes to the background and comes back (resubscribe on resume).
- Optional, ask Shishir first: push notifications when a task is assigned to you.

---

## Phase 5 — Shell, login and build

- Bottom nav with exactly 3 tabs. Remember the last tab used.
- Respect `profiles.allowed_tabs`. If a user isn't allowed a tab, hide it from the bar.
- Handle the Android back button (close the sheet, then go back a screen, then exit), safe areas, and the keyboard pushing up the bottom bars.
- Show a clear "No internet" banner. Inventory can show the last results it loaded, marked as offline.
- Bump the version and build through the existing GitHub Actions workflow. Tell Shishir where to download the APK.

---

## Done when (test checklist for Shishir)

- [ ] Inventory: typing "renesa black" finds the Atomberg Renesa Matt Black item. Stock matches Busy within about 10 minutes of a sale.
- [ ] Inventory: an out-of-stock item shows the red "Nil" box; a low-stock item shows orange.
- [ ] Quotation: build a quote on the phone, scan a handwritten list, share the PDF to WhatsApp. It appears in the CRM's quotations list and under the linked project.
- [ ] Task Board: file a task on the phone and it appears on the office CRM board without refreshing. Mark it done on the computer and it disappears on the phone.
- [ ] Staff accounts cannot see Payments tasks, even through the API.
- [ ] Task colours on the phone and the CRM always match.

## Open questions to ask Shishir (when you reach them)
1. Which item-group level should the Inventory chips show?
2. Should staff see **MRP and Sales price** in Inventory, or only stock?
3. The exact deadline-to-colour thresholds, if the CRM code is unclear.
4. Do you want push notifications for new tasks?
