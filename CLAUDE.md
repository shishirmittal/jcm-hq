# JCM HQ — project notes

JCM HQ is the one tool replacing the JCM CRM (crm.jcmretails.com, repo shishirmittal/jcm-crm) and JCM Orders (orders.jcmretails.com, repo shishirmittal/jcm-orders).
Live at **hq.jcmretails.com** (Vercel project `jcm-hq`, auto-deploys from `main`). The TV board will live at board.jcmretails.com.

## Owner
- Shishir (J.C. Mittal & Sons, Ratlam) is not a developer. Plain language, one step at a time, say exactly where to click or what to run (Supabase SQL Editor vs SSMS on JCM-Server).
- He tests HQ side by side with the old tools and reports missing pieces → add each to the checklists in `docs/`.

## Ground rules
- Started 2026-10-10 as an exact copy of jcm-crm @ d6ef6bf. The old CRM and Orders apps stay live and untouched until Shishir switches over.
- **Same Supabase projects as the old tools** — HQ may ADD tables/columns, never rename, drop or change the meaning of anything the old apps or JCM-Server scripts use.
  - `cmtnzmfuasniicsdxyle` = CRM project (profiles, user_pins, projects, quotations, tasks …) and all JCM Orders tables. Tokyo region.
  - `jlkjjqnmhsgefpluemyz` = Busy-data project (items, invoices, customers, sync_log …), written by JCM-Server sync scripts.
- Never enter or ask for PINs/passwords in chat; secrets only in Vercel env vars. Never commit `.env*` or `dist/`.
- Carry features forward from the old code, don't reinvent: `docs/FEATURES-crm.md` and `docs/FEATURES-orders.md` are the audits (every page, button, hover, animation). Tick items as HQ matches them.
- Vercel Hobby plan = max 12 serverless functions. CRM has 3 (`api/pin-login`, `api/admin-users`, `api/db-chat`), Orders has 10 → merging needs consolidation (e.g. one router function per area).
- Stack: Vite. CRM pages are vanilla JS (`src/*.js`, hash routes, `src/nav-config.js`), Control Centre is React; Orders pages are React (`src/pages/*.jsx` in jcm-orders) and can be mounted as React islands.
- JCM-Server scripts (Busy sync, print agent) run on Shishir's office PC and are updated by him with `update-server.bat` — keep their contracts unchanged.

## Several chats work on this repo (Shishir's choice, 2026-10-10)
Each module may be built in its own Claude chat that pushes straight to `main` (which deploys live at once). To keep them from tripping over each other:
- Before starting, and again right before every push: `git pull --rebase origin main`. Commit small, push often. Never force-push `main`.
- Shared files every module touches: `src/nav-config.js` (sidebar), `src/main.js` (routes), `src/sidebar.js` (badges), `src/style.css`, this file. Change only your own lines there; if a pull brings conflicts, keep both sides.
- Put module code in its own files (e.g. `src/red-alerts.js` + `api/red-alerts.js`), and its CSS under its own class prefix.
- Vercel Hobby: max 12 functions in `api/` (files not starting with `_`). Now 6: pin-login, admin-users, db-chat, orders, red-alerts, collections. One function per module at most; put many actions behind one function.
- Run `npx vite build` before pushing; a broken build stops every deploy. Local install: the `xlsx` package comes from cdn.sheetjs.com, which some sandboxes block — temporarily install `xlsx@0.18.5` from npm to build, and never commit that change to package.json / package-lock.json.
- New pages: add the sidebar row in nav-config (id = permission id for Manage Users), check access on the server too (admin, or the id in profiles.allowed_tabs), and add a line to the Plan below.
- Module owners right now: Red Alerts → its own chat. Payment Follow-up → its own chat. Everything else (TV board, phone app, gaps found in side-by-side testing) → the main HQ chat.

## Vercel env vars (set by Shishir)
- `SUPABASE_SERVICE_ROLE_KEY` (CRM project), `SUPABASE_BUSY_SERVICE_ROLE_KEY` (Busy project). `ANTHROPIC_API_KEY` not set yet (only Ask AI needs it).

## Plan (phases, each tested before the next)
- A: JCM HQ name, photo + PIN login cards, grouped sidebar (MAIN / CRM / SALES / COLLECTIONS / WAREHOUSE / PURCHASE & STOCK / INSIGHTS / ADMIN), per-user page access.
- B (built 2026-10-10): Orders admin pages from jcm-orders as React islands — #material (/owner), #order-log (/logs), #warehouse (/admin). Code in src/orders/ (pages copied, api.js maps /api/admin/X → /api/orders?h=X and sends the HQ Supabase token) and api/_orders/ (handlers + lib copied; auth.js findAdmin also accepts an HQ JWT: admin, or allowed_tabs has the page id set by api/orders.js). One function api/orders.js. Registering new screens stays on orders.jcmretails.com/admin until the board moves; the 17:30 cron stays on jcm-orders (no cron here, or the email would go twice). vercel.json regions hnd1.
- C: New modules — Payment Follow-up (manual calls by account group + WhatsApp reminders via Whatshub360), Customer 360, Red Alerts.
  - Red Alerts (built 2026-10-10; v2 same night): page src/red-alerts.js at #red-alerts (Insights, adminOnly but grantable, red badge = New + Answered) with filters deleted / bill edited / ₹0 rate / ₹0 qty / below cost / backdated, date range, person, select-all + select-all-matching, Seen / Clear / Ask for explanation. Staff answer on #explain (src/explain.js, open to all, badge = questions waiting). One function api/red-alerts.js (Busy service key; RLS-closed tables red_alerts / red_alert_skip_items / busy_user_names in the Busy project); Ask files a team_tasks 'other' task + optional Whatshub360 WhatsApp (WHATSHUB_SEND_URL / WHATSHUB_VID). Feed busy-sync/sync-red-alerts.js on JCM-Server every 15 min — Busy table notes in busy-sync/README-red-alerts.md.
  - Payment Follow-up, part A (built 2026-10-10): page src/payment-followup.js (+ .css, classes pf-*) at #payment-followup (Collections, adminOnly but grantable, amber badge = follow-ups due today/overdue). Pick a Busy account group → parties with dues (dues_segmented due_type Receivable, balance > 0), ageing 0-30/31-60/61-90/90+/older (newest bills taken as unpaid first, from invoices), Call (tel:) / WhatsApp (wa.me, staff's own phone) → save outcome, remarks, promised amount/date, next follow-up; full history per party. One function api/collections.js (Busy service key). Setup supabase/collections-setup.sql in the Busy project: table collection_followups, view collection_latest, function collections_ageing, index on invoices — all closed to the browser. DND group = "JCM Due DND".
- D: TV board at board.jcmretails.com with screen token.
- E: Phone layout + Android app (JCM HQ).
- Prototype (Claude Design): https://claude.ai/artifact/LdWwPmWCaYsLDZteK8uMNh
