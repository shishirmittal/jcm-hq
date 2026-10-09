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

## Vercel env vars (set by Shishir)
- `SUPABASE_SERVICE_ROLE_KEY` (CRM project), `SUPABASE_BUSY_SERVICE_ROLE_KEY` (Busy project). `ANTHROPIC_API_KEY` not set yet (only Ask AI needs it).

## Plan (phases, each tested before the next)
- A: JCM HQ name, photo + PIN login cards, grouped sidebar (MAIN / CRM / SALES / COLLECTIONS / WAREHOUSE / PURCHASE & STOCK / INSIGHTS / ADMIN), per-user page access.
- B: Orders pages from jcm-orders (/admin, /owner, /logs → Orders, Pending Material, Warehouse & Devices).
- C: New modules — Payment Follow-up (manual calls by account group + WhatsApp reminders via Whatshub360), Customer 360, Red Alerts.
- D: TV board at board.jcmretails.com with screen token.
- E: Phone layout + Android app (JCM HQ).
- Prototype (Claude Design): https://claude.ai/artifact/LdWwPmWCaYsLDZteK8uMNh
